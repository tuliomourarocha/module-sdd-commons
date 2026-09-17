#!/usr/bin/env python3
"""
hooks/ci_watch.py — Hook determinístico para verificação de CI do PR + loop de correção.

Conceito de Hook (fora do LLM):
  Middleware determinístico que, ao final do shipper, verifica o CI do PR aberto,
  aguarda conclusão (polling) e, em caso de falha, gera relatório acionável e
  sinaliza harness para iniciar loop de correção (builder → reviewer → shipper → ci_watch).

Acionamento:
  - Trigger primário: após shipper completar (task shipper / write HANDOFF.md / session.idle)
  - Invocado por: plugins/ci-watch.ts via `tool.execute.after` + `event: session.idle`
    e também direto via CLI: `python3 hooks/ci_watch.py --run --wait --repo .`
  - Em Claude: `.claude/settings.json` → hooks.Stop / PostToolUse (opcional)

O que faz (determinístico, sem LLM):
  - Descobre PR atual: `gh pr view --json number,url,headRefOid,headRefName,state,statusCheckRollup`
    fallback: `gh pr view --json number,url` + `gh run list --branch <branch>`
  - Polling: enquanto CI em PENDING/QUEUED/IN_PROGRESS/EXPECTED/WAITING, dorme --interval
    até --timeout (default 600s) ou até conclusão terminal
  - Classifica resultado: pass (todos SUCCESS/SKIPPED/NEUTRAL), fail (qualquer FAILURE/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE), pending/timeout, unknown (sem checks)
   - Em fail: coleta logs via `gh run view <id> --log-failed` ou `gh run view --json jobs` + `gh pr checks`, **atualiza `.planning/HANDOFF.md` (seção CI_REPORT) e `.planning/STATE.md` (seção CI_STATE)** — não cria artefactos separados
   - Tracking de retries: lê/escreve métrica em `STATE.md` (marcadores CI_STATE) + opcional `.planning/CI_RETRIES.json` legado (ou STATE.md) para limitar max_retries (default 2)
   - Log de garantia: escreve em `.planning/HOOKS.log` e `.opencode/hooks/hook-audit.jsonl`

Exit codes:
  0 = CI pass (verde) — fluxo pode ir para done/supervisor
  2 = CI fail — precisa loop correção (builder) — harness deve reiniciar builder com contexto CI_REPORT
  3 = CI pending timeout — CI ainda rodando após timeout, não conclusivo (avisar mas não loopar imediatamente)
  1 = erro de uso/infra (gh ausente, PR não encontrado, etc)

Integração com Harness:
  - Harness lê exit code 2 e agenda `task("builder", context:{PLAN, resumo, CI_REPORT})` com max 2 iterações (nunca SUMMARY.md/REVIEW.md em disco).
  - Plugin ci-watch.ts converte exit 2 em throw `🚨 CI_FAILED_NEEDS_FIX` visível ao harness.
  - Orquestrador LangGraph opcional (hooks/ci_orchestrator.py) pode usar este hook como node `wait_ci`.

 Uso:
  python3 hooks/ci_watch.py --run --wait --timeout 600 --interval 30
  python3 hooks/ci_watch.py --run --no-wait
  python3 hooks/ci_watch.py --run --pr 123 --timeout 300
  python3 hooks/ci_watch.py --run --dry-run --wait
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Literal

Status = Literal["pass", "fail", "pending", "unknown", "skipped"]

# ── Persistência em HANDOFF/STATE (exigência: não criar artefatos .md separados) ──
CI_HANDOFF_START = "<!-- CI_REPORT:START -->"
CI_HANDOFF_END = "<!-- CI_REPORT:END -->"
CI_STATE_START = "<!-- CI_STATE:START -->"
CI_STATE_END = "<!-- CI_STATE:END -->"


def upsert_handoff_ci(repo: Path, report_md: str) -> Path:
    """Atualiza HANDOFF.md com seção CI Report (idempotente) ao invés de criar CI_REPORT.md."""
    handoff_path = repo / ".planning" / "HANDOFF.md"
    wrapped = f"\n{CI_HANDOFF_START}\n{report_md.strip()}\n{CI_HANDOFF_END}\n"
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        if handoff_path.exists():
            existing = handoff_path.read_text(encoding="utf-8", errors="ignore")
            if CI_HANDOFF_START in existing and CI_HANDOFF_END in existing:
                before = existing.split(CI_HANDOFF_START)[0]
                after = existing.split(CI_HANDOFF_END)[-1]
                new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
            else:
                new_content = existing.rstrip() + "\n\n---\n" + wrapped
        else:
            new_content = f"# HANDOFF — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n{wrapped}\n"
        handoff_path.write_text(new_content, encoding="utf-8")
        print(f"✅ HANDOFF.md atualizado com CI Report ({len(report_md)} chars) → {handoff_path}")
    except Exception as e:
        print(f"⚠️ Falha ao atualizar HANDOFF.md com CI: {e}", file=sys.stderr)
    return handoff_path


def upsert_state_ci(repo: Path, metrics: dict[str, Any], status: Status, branch: str) -> Path:
    """Atualiza STATE.md com métricas CI (embed)."""
    state_path = repo / ".planning" / "STATE.md"
    status_emoji = {"pass": "✅", "fail": "🔴", "pending": "⏳", "unknown": "❓"}.get(status, "❓")
    block = f"""### 🔄 CI — {metrics.get('ts','')}
- **Status:** {status_emoji} `{status}` — {metrics.get('details','')[:500]}
- **Branch:** `{branch}` | **PR:** #{metrics.get('pr_number','?')} — {metrics.get('pr_url','')}
- **Tentativas:** {metrics.get('attempts',0)} em {metrics.get('elapsed_seconds',0)}s | **Retries:** {metrics.get('retries',0)}/{metrics.get('max_retries',0)}
"""
    wrapped = f"\n{CI_STATE_START}\n{block.strip()}\n{CI_STATE_END}\n"
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        if state_path.exists():
            existing = state_path.read_text(encoding="utf-8", errors="ignore")
            if CI_STATE_START in existing and CI_STATE_END in existing:
                before = existing.split(CI_STATE_START)[0]
                after = existing.split(CI_STATE_END)[-1]
                new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
            else:
                new_content = existing.rstrip() + "\n\n" + wrapped
        else:
            new_content = f"# STATE — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n**Flow:** `feature` | **Gate:** `done` | **Branch:** `{branch}`\n\n{wrapped}\n"
        state_path.write_text(new_content, encoding="utf-8")
        print(f"✅ STATE.md atualizado com CI metrics → {state_path}")
    except Exception as e:
        print(f"⚠️ Falha ao atualizar STATE.md com CI: {e}", file=sys.stderr)
    return state_path

# ── Utils ────────────────────────────────────────────────────────────────────

def run(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(cmd)}"
    except Exception as e:
        return 1, "", str(e)

def has_tool(name: str) -> bool:
    return shutil.which(name) is not None

def gh_available() -> bool:
    return has_tool("gh")

def git_available(repo: Path) -> bool:
    code, _, _ = run(["git", "status", "--porcelain"], cwd=repo)
    return code == 0

def get_git_branch(repo: Path) -> str:
    code, out, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo)
    return out.strip() if code == 0 else "main"

def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""

def ensure_planning_dir(repo: Path):
    (repo / ".planning").mkdir(parents=True, exist_ok=True)

# ── PR discovery ─────────────────────────────────────────────────────────────

def get_pr_info(repo: Path, pr_number: int | None = None) -> dict[str, Any]:
    """Retorna dict com number, url, headRefOid, headRefName, state via gh."""
    if not gh_available():
        return {}
    # Try explicit PR number
    if pr_number:
        code, out, _ = run(["gh", "pr", "view", str(pr_number), "--json", "number,url,headRefOid,headRefName,state,statusCheckRollup"], cwd=repo, timeout=20)
        if code == 0 and out.strip():
            try:
                return json.loads(out)
            except Exception:
                pass
    # Try current branch PR
    code, out, _ = run(["gh", "pr", "view", "--json", "number,url,headRefOid,headRefName,state,statusCheckRollup"], cwd=repo, timeout=20)
    if code == 0 and out.strip():
        try:
            return json.loads(out)
        except Exception:
            # maybe fallback without statusCheckRollup
            code2, out2, _ = run(["gh", "pr", "view", "--json", "number,url,headRefName,state"], cwd=repo, timeout=20)
            if code2 == 0:
                try:
                    j = json.loads(out2)
                    j["statusCheckRollup"] = []
                    return j
                except Exception:
                    pass
    # Fallback minimal: just number/url
    code, out, _ = run(["gh", "pr", "view", "--json", "number,url"], cwd=repo, timeout=20)
    if code == 0:
        try:
            j = json.loads(out)
            j["statusCheckRollup"] = []
            return j
        except Exception:
            pass
    return {}

def fetch_status_checks_via_pr_view(repo: Path, pr_number: int | None = None) -> list[dict[str, Any]]:
    info = get_pr_info(repo, pr_number)
    rollup = info.get("statusCheckRollup") or []
    # normalize: cada item tem state, conclusion, name, workflowName
    return rollup if isinstance(rollup, list) else []

def fetch_status_via_gh_pr_checks(repo: Path) -> tuple[list[dict[str, Any]], str]:
    """Fallback textual: gh pr checks. Returns (checks, raw)."""
    if not gh_available():
        return [], "gh não encontrado"
    code, out, err = run(["gh", "pr", "checks"], cwd=repo, timeout=30)
    raw = out + err
    if code != 0 and not raw.strip():
        return [], raw.strip()[:2000] or "gh pr checks sem output"
    checks: list[dict[str, Any]] = []
    # Parse table: lines like "check-name  pass  ...  https://..."
    # We do heuristic: each line with pass/fail/pending
    for line in raw.splitlines():
        low = line.lower()
        # skip header
        if "name" in low and "state" in low:
            continue
        if not line.strip():
            continue
        # detect status token
        state = None
        if "pass" in low or "success" in low:
            state = "SUCCESS"
        elif "fail" in low or "failure" in low or "error" in low:
            state = "FAILURE"
        elif "pending" in low or "in_progress" in low or "queued" in low or "waiting" in low or "expected" in low:
            state = "PENDING"
        elif "cancel" in low or "skip" in low or "neutral" in low:
            state = "SKIPPED"
        if state:
            # name is first column
            name = line.split()[0] if line.split() else "check"
            checks.append({"name": name, "state": state, "conclusion": state, "raw": line[:300]})
    return checks, raw[:3000]

def fetch_runs_via_gh_run_list(repo: Path, branch: str | None = None, limit: int = 5) -> list[dict[str, Any]]:
    if not gh_available():
        return []
    branch = branch or get_git_branch(repo)
    # Prefer JSON output
    code, out, _ = run(["gh", "run", "list", "--branch", branch, "--limit", str(limit), "--json", "databaseId,workflowName,name,status,conclusion,headSha,event,displayTitle,url,headBranch"], cwd=repo, timeout=30)
    if code == 0 and out.strip():
        try:
            data = json.loads(out)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    # fallback text
    code, out, _ = run(["gh", "run", "list", "--branch", branch, "--limit", str(limit)], cwd=repo, timeout=30)
    if code == 0 and out.strip():
        # heuristic parse
        runs = []
        for line in out.splitlines()[1:]:  # skip header
            if not line.strip():
                continue
            low = line.lower()
            conclusion = "unknown"
            if "success" in low or "completed" in low and "success" in low:
                conclusion = "SUCCESS"
            elif "fail" in low:
                conclusion = "FAILURE"
            elif "in_progress" in low or "queued" in low or "pending" in low:
                conclusion = "PENDING"
            runs.append({"name": line.split()[0][:80] if line.split() else "run", "conclusion": conclusion, "status": conclusion, "raw": line[:300]})
        return runs
    return []

def classify_checks(checks: list[dict[str, Any]]) -> tuple[Status, str]:
    """Classifica lista de checks/runs em pass/fail/pending/unknown."""
    if not checks:
        return "unknown", "nenhum check encontrado (sem CI configurado ou PR sem checks)"
    # normalize fields
    pending_count = 0
    fail_count = 0
    pass_count = 0
    skipped_count = 0
    for c in checks:
        state = (c.get("state") or c.get("status") or "").upper()
        conclusion = (c.get("conclusion") or c.get("state") or "").upper()
        # unify: prefer conclusion if present, else state
        val = conclusion if conclusion not in ("", "UNKNOWN") else state
        # also check raw string fallback
        raw = (c.get("raw") or "").lower()
        # Pending group
        if val in ("PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "INPROGRESS", "STARTED", "REQUESTED"):
            pending_count += 1
        elif "pending" in raw or "queued" in raw or "in_progress" in raw or "waiting" in raw or "expected" in raw:
            # fallback double count check, but we already counted val, avoid double
            if val not in ("PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING"):
                pending_count += 1
        # Fail group
        elif val in ("FAILURE", "FAILED", "ERROR", "TIMED_OUT", "TIMEDOUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED") or "fail" in raw:
            # CANCELLED and TIMED_OUT considered fail
            fail_count += 1
        elif val in ("FAILURE", "FAIL"):
            fail_count += 1
        # Pass group
        elif val in ("SUCCESS", "SUCCEEDED", "COMPLETED", "PASSED", "PASS"):
            pass_count += 1
        elif val in ("SKIPPED", "NEUTRAL", "CANCELLED"):
            # Skipped/neutral treated as pass for CI green purposes
            skipped_count += 1
        else:
            # unknown state, try infer from raw
            if "success" in raw or "pass" in raw:
                pass_count += 1
            elif "fail" in raw:
                fail_count += 1
            elif "pend" in raw:
                pending_count += 1
            else:
                # unknown -> treat as pending to wait more
                pending_count += 1
    if fail_count > 0:
        return "fail", f"fail:{fail_count} pass:{pass_count} skipped:{skipped_count} pending:{pending_count}"
    if pending_count > 0:
        return "pending", f"pending:{pending_count} pass:{pass_count} skipped:{skipped_count} fail:{fail_count}"
    if pass_count > 0 or skipped_count > 0:
        return "pass", f"pass:{pass_count} skipped:{skipped_count} pending:{pending_count} fail:{fail_count}"
    return "unknown", f"checks:{len(checks)} → pending:{pending_count} pass:{pass_count} fail:{fail_count}"

def collect_failure_logs(repo: Path, branch: str, pr_number: int | None = None, max_chars: int = 8000) -> str:
    """Tenta coletar logs de falha."""
    if not gh_available():
        return "gh não encontrado — logs não disponíveis"
    logs: list[str] = []
    # 1. Try gh run list to find failed runs
    runs = fetch_runs_via_gh_run_list(repo, branch, limit=5)
    failed = [r for r in runs if (r.get("conclusion") or "").upper() in ("FAILURE", "FAILED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE")]
    # if none flagged as failed but overall fail, take most recent
    if not failed and runs:
        # check via pr checks fallback
        pass
    for r in failed[:2]:
        rid = r.get("databaseId") or r.get("id") or r.get("databaseId")
        if rid:
            # try log-failed first (smaller)
            code, out, err = run(["gh", "run", "view", str(rid), "--log-failed"], cwd=repo, timeout=45)
            if code == 0 and out.strip():
                logs.append(f"--- gh run view {rid} --log-failed ---")
                logs.append(out[:4000])
                continue
            code, out, err = run(["gh", "run", "view", str(rid), "--json", "jobs", "--jq", ".jobs[] | select(.conclusion==\"failure\") | .name + \": \" + .conclusion"], cwd=repo, timeout=30)
            if code == 0 and out.strip():
                logs.append(f"--- failed jobs for run {rid} ---")
                logs.append(out[:3000])
            # full log limited
            code, out, err = run(["gh", "run", "view", str(rid), "--log"], cwd=repo, timeout=45)
            if code == 0 and out.strip():
                logs.append(f"--- tail log run {rid} (last 100 lines) ---")
                lines = out.splitlines()
                logs.append("\n".join(lines[-100:])[:4000])
    # 2. Try gh pr checks verbose if no runs
    if not logs:
        code, out, err = run(["gh", "pr", "checks", "--json", "name,state,link,bucket"], cwd=repo, timeout=30)
        if code == 0 and out.strip():
            try:
                data = json.loads(out)
                for c in data:
                    if c.get("state", "").lower() in ("failure", "failed", "error"):
                        logs.append(f"check fail: {c.get('name')} state={c.get('state')} link={c.get('link')}")
            except Exception:
                pass
        # textual checks
        checks, raw = fetch_status_via_gh_pr_checks(repo)
        if raw:
            logs.append("--- gh pr checks raw ---")
            logs.append(raw[:3000])
    if not logs:
        return "(sem logs específicos — verifique Actions tab ou `gh run list --branch " + branch + "`)"
    combined = "\n".join(logs)
    return combined[:max_chars]

# ── Report ───────────────────────────────────────────────────────────────────

def load_retry_count(repo: Path) -> int:
    p = repo / ".planning" / "CI_RETRIES.json"
    if p.exists():
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            return int(j.get("retries", 0))
        except Exception:
            pass
    # also try STATE.md parsing fallback
    state = read_text(repo / ".planning" / "STATE.md")
    m = re.search(r"CI retries.*?(\d+)", state, re.I)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            pass
    return 0

def save_retry_count(repo: Path, retries: int):
    # Persistência primária: embarca em STATE.md (CI_STATE); mantém CI_RETRIES.json só se legacy env
    try:
        state_path = repo / ".planning" / "STATE.md"
        if state_path.exists():
            existing = state_path.read_text(encoding="utf-8", errors="ignore")
            # atualiza marcador de retries dentro do bloco CI_STATE, se existir
            # fallback simples: não altera state aqui — o upsert_state_ci já grava retries
            pass
    except Exception:
        pass
    # Legacy arquivo só se explicitado via env, para transição
    if os.environ.get("CI_WATCH_LEGACY_JSON", "") in ("1", "true", "yes"):
        p = repo / ".planning" / "CI_RETRIES.json"
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"retries": retries, "updated": datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2), encoding="utf-8")
        except Exception:
            pass

def generate_ci_report(
    repo: Path,
    branch: str,
    pr_info: dict[str, Any],
    status: Status,
    details: str,
    attempts: int,
    elapsed: float,
    failure_logs: str,
    retries: int,
    max_retries: int,
) -> tuple[str, dict[str, Any]]:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pr_url = pr_info.get("url") or "(PR não encontrado)"
    pr_number = pr_info.get("number") or "?"
    checks_block = details
    status_emoji = {"pass": "✅", "fail": "🔴", "pending": "⏳", "unknown": "❓", "skipped": "⏭️"}.get(status, "❓")
    metrics = {
        "ts": now,
        "branch": branch,
        "pr_number": pr_number,
        "pr_url": pr_url,
        "status": status,
        "details": details,
        "attempts": attempts,
        "elapsed_seconds": round(elapsed, 1),
        "retries": retries,
        "max_retries": max_retries,
        "failure_logs_preview": failure_logs[:2000],
    }
    md = []
    md.append(f"# CI Report — {now}")
    md.append("")
    md.append(f"**Status:** {status_emoji} `{status}` — {details}")
    md.append(f"**Branch:** `{branch}` | **PR:** #{pr_number} — {pr_url}")
    md.append(f"**Tentativas polling:** {attempts} em {elapsed:.1f}s | **Retries de correção:** {retries}/{max_retries}")
    md.append("")
    if status == "pass":
        md.append("✅ **CI verde** — pronto para supervisor / merge.")
        md.append("")
        md.append(f"- Todos os checks concluíram com sucesso ({details})")
        md.append("- Próximo passo: `hooks/supervisor.py` (observability) ou merge via `gh pr merge`")
    elif status == "fail":
        md.append("🔴 **CI falhou** — requer loop de correção.")
        md.append("")
        md.append(f"- Detalhe: `{details}`")
        md.append(f"- **Ação:** harness deve chamar `task builder` com este relatório como contexto (max {max_retries} tentativas, atual {retries})")
        md.append(f"- Se retries ≥ max ({max_retries}), escalar para humano")
        md.append("")
        md.append("## Como corrigir (para builder)")
        md.append("")
        md.append("1. Leia `.planning/CI_REPORT.md` (este arquivo) + logs abaixo")
        md.append("2. Foque apenas nos checks falhados (não reescreva tudo)")
        md.append("3. Rode `gh pr checks` e `gh run view <id> --log-failed` localmente para reproduzir")
        md.append("4. Após fix, `git commit` + `git push` → shipper recria PR e ci_watch revalida")
        md.append("")
        md.append("## Logs de falha (trecho)")
        md.append("")
        md.append("```")
        md.append(failure_logs[:6000] or "(sem logs — ver Actions)")
        md.append("```")
        md.append("")
        md.append("## Próximos comandos sugeridos (determinístico)")
        md.append("")
        md.append("```bash")
        md.append(f"gh pr checks  # detalhes dos checks para PR #{pr_number}")
        md.append(f"gh run list --branch {branch} --limit 3")
        md.append(f"gh run view --log-failed  # último run falhado")
        md.append("```")
    elif status == "pending":
        md.append("⏳ **CI ainda rodando** — timeout atingido sem conclusão.")
        md.append("")
        md.append(f"- Após {elapsed:.1f}s e {attempts} polls, CI ainda pending: `{details}`")
        md.append("- **Ação:** aguardar mais (aumentar --timeout) ou re-poll manualmente: `python3 hooks/ci_watch.py --run --wait --timeout 600`")
        md.append("- Não inicia loop de correção automaticamente — pode ser só lento")
        md.append("")
        md.append("## Checks atuais")
        md.append("```")
        md.append(checks_block[:2000])
        md.append("```")
    else:  # unknown
        md.append("❓ **CI desconhecido** — nenhum check encontrado ou gh sem permissão.")
        md.append("")
        md.append("- Pode ser: repo sem Actions configuradas, PR sem checks, ou `gh` não autenticado")
        md.append(f"- Detalhe: `{details}`")
        md.append("- **Ação:** verifique `gh auth status` e se há workflow em `.github/workflows/`")
    md.append("")
    md.append("---")
    md.append(f"_Gerado por `hooks/ci_watch.py` em {now} — branch `{branch}` — polling {attempts}x — elapsed {elapsed:.1f}s_")
    return "\n".join(md), metrics

# ── Main Poll Logic ──────────────────────────────────────────────────────────

def poll_ci(
    repo: Path,
    branch: str,
    pr_number: int | None,
    wait: bool,
    timeout: int,
    interval: int,
    verbose: bool,
) -> tuple[Status, str, dict[str, Any], str, int, float]:
    start = time.time()
    attempts = 0
    last_status: Status = "unknown"
    last_details = ""
    last_pr_info: dict[str, Any] = {}
    last_raw = ""
    # if not wait, just one attempt
    max_attempts = 1 if not wait else max(1, timeout // max(interval, 1) + 1)
    while True:
        attempts += 1
        elapsed = time.time() - start
        pr_info = get_pr_info(repo, pr_number)
        last_pr_info = pr_info
        # Try primary: statusCheckRollup
        checks = fetch_status_checks_via_pr_view(repo, pr_number)
        status: Status = "unknown"
        details = ""
        raw = ""
        if checks:
            status, details = classify_checks(checks)
            raw = json.dumps(checks, indent=2, ensure_ascii=False)[:3000]
        else:
            # fallback to gh pr checks parse
            checks2, raw2 = fetch_status_via_gh_pr_checks(repo)
            raw = raw2
            if checks2:
                status, details = classify_checks(checks2)
            else:
                # fallback to run list
                runs = fetch_runs_via_gh_run_list(repo, branch, limit=5)
                if runs:
                    status, details = classify_checks(runs)
                    raw = json.dumps(runs, indent=2, ensure_ascii=False)[:3000]
                else:
                    status, details = "unknown", "nenhum check/run encontrado"
        last_status = status
        last_details = details
        last_raw = raw
        if verbose:
            print(f"[{attempts}] elapsed {elapsed:.1f}s status={status} details={details}")
            if raw:
                print(raw[:1200])
        # terminal?
        if status in ("pass", "fail"):
            elapsed = time.time() - start
            failure_logs = ""
            if status == "fail":
                failure_logs = collect_failure_logs(repo, branch, pr_number)
            else:
                failure_logs = ""
            return status, details, last_pr_info, failure_logs, attempts, elapsed
        if status == "unknown" and not wait:
            elapsed = time.time() - start
            return status, details, last_pr_info, "", attempts, elapsed
        # pending handling
        elapsed = time.time() - start
        if not wait:
            return status, details, last_pr_info, "", attempts, elapsed
        if elapsed >= timeout:
            # timeout reached while pending
            failure_logs = collect_failure_logs(repo, branch, pr_number) if status == "fail" else ""
            return "pending", f"timeout {timeout}s atingido — {details}", last_pr_info, failure_logs, attempts, elapsed
        # sleep before next poll, but not exceed timeout
        remaining = timeout - elapsed
        sleep_for = min(interval, remaining)
        if sleep_for > 0:
            if verbose:
                print(f"  ⏳ aguardando {sleep_for}s antes de próximo poll...")
            time.sleep(sleep_for)
        else:
            return "pending", f"timeout {timeout}s — {details}", last_pr_info, "", attempts, elapsed
        if attempts >= max_attempts and wait:
            # safety guard
            if time.time() - start >= timeout:
                return "pending", f"max_attempts {attempts} — {details}", last_pr_info, "", attempts, time.time() - start

def main():
    parser = argparse.ArgumentParser(description="Hook ci_watch determinístico — verifica CI do PR e aguarda conclusão")
    parser.add_argument("--run", action="store_true", help="Executa verificação completa")
    parser.add_argument("--repo", default=".", help="Caminho do repo")
    parser.add_argument("--repo-slug", default=os.environ.get("SHIPPER_REPO", os.environ.get("CI_REPO", "tuliomourarocha/module-sdd-commons")), help="Slug GitHub")
    parser.add_argument("--pr", type=int, default=None, help="Número do PR (se omitido, detecta via branch atual)")
    parser.add_argument("--branch", default="", help="Branch para gh run list (default: branch atual)")
    parser.add_argument("--timeout", type=int, default=600, help="Timeout total para wait polling em segundos (default 600)")
    parser.add_argument("--interval", type=int, default=30, help="Intervalo entre polls em segundos (default 30)")
    parser.add_argument("--wait", action="store_true", dest="wait", help="Aguarda CI concluir (polling)")
    parser.add_argument("--no-wait", action="store_false", dest="wait", help="Apenas snapshot (sem polling)")
    parser.add_argument("--max-retries", type=int, default=2, help="Max loops de correção (default 2)")
    parser.add_argument("--fail-on-ci", action="store_true", help="Exit 2 se CI fail (para CI/CD strict)")
    parser.add_argument("--dry-run", action="store_true", help="Não escreve CI_REPORT, só loga")
    parser.add_argument("--json-out", default="", help="Caminho para ci_metrics.json (default .planning/ci_metrics.json)")
    parser.add_argument("--md-out", default="", help="Caminho para CI_REPORT.md (default .planning/CI_REPORT.md)")
    parser.add_argument("--verbose", action="store_true", help="Log verboso por poll")
    parser.set_defaults(wait=None)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists() and (Path.cwd() / ".git").exists():
        repo = Path.cwd().resolve()

    if args.wait is None:
        # default: wait = True se --run sem explicit, para shipper final
        args.wait = True

    if not git_available(repo):
        print(f"⚠️ Não é repo git: {repo}", file=sys.stderr)
        sys.exit(1)

    branch = args.branch.strip() or get_git_branch(repo)
    dry_run = args.dry_run

    ensure_planning_dir(repo)
    has_legacy_md = bool(args.md_out)
    has_legacy_json = bool(args.json_out)
    use_legacy_env = os.environ.get("CI_WATCH_LEGACY", "") in ("1", "true", "yes") or os.environ.get("CI_WATCH_LEGACY_JSON", "") in ("1", "true", "yes")
    json_out = Path(args.json_out) if has_legacy_json else None
    md_out = Path(args.md_out) if has_legacy_md else None

    # dry-run early gh check
    if not gh_available() and not dry_run:
        print("⚠️ gh CLI não encontrado — CI watch não pode verificar PR", file=sys.stderr)
        # ainda gera report minimal — agora grava em HANDOFF/STATE ao invés de arquivos separados
        status = "unknown"
        md = f"# CI Report — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n❓ gh não encontrado — instale `gh` e `gh auth login`\n"
        metrics = {"status": status, "pr_number": "?", "branch": branch, "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "details": "gh não encontrado", "attempts": 0, "elapsed_seconds": 0, "retries": load_retry_count(repo), "max_retries": int(os.environ.get("CI_WATCH_MAX_RETRIES", args.max_retries)), "pr_url": ""}
        if not dry_run:
            upsert_handoff_ci(repo, md)
            upsert_state_ci(repo, metrics, status, branch)  # type: ignore
            if use_legacy_env or has_legacy_md:
                try:
                    target = md_out or repo / ".planning" / "CI_REPORT.md"
                    target.write_text(md, encoding="utf-8")
                except Exception:
                    pass
            if use_legacy_env or has_legacy_json:
                try:
                    target = json_out or repo / ".planning" / "ci_metrics.json"
                    target.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
                except Exception:
                    pass
        sys.exit(1)

    # optional override timeout via env
    timeout = int(os.environ.get("CI_WATCH_TIMEOUT", args.timeout))
    interval = int(os.environ.get("CI_WATCH_INTERVAL", args.interval))
    max_retries = int(os.environ.get("CI_WATCH_MAX_RETRIES", args.max_retries))

    retries = load_retry_count(repo)

    print(f"🔍 CI watch — branch {branch} PR {args.pr or 'auto'} wait={args.wait} timeout={timeout}s interval={interval}s retries={retries}/{max_retries}")

    status, details, pr_info, failure_logs, attempts, elapsed = poll_ci(
        repo=repo,
        branch=branch,
        pr_number=args.pr,
        wait=args.wait,
        timeout=timeout,
        interval=interval,
        verbose=args.verbose,
    )

    # generate report
    report_md, metrics = generate_ci_report(repo, branch, pr_info, status, details, attempts, elapsed, failure_logs, retries, max_retries)

    if not dry_run:
        # ── Novo: atualiza HANDOFF/STATE primariamente (ci_watch não deve criar CI_REPORT.md separado) ──
        upsert_handoff_ci(repo, report_md)
        upsert_state_ci(repo, metrics, status, branch)
        # legado opcional só se explicitado
        if has_legacy_md:
            try:
                assert md_out is not None
                md_out.parent.mkdir(parents=True, exist_ok=True)
                md_out.write_text(report_md, encoding="utf-8")
                print(f"✅ CI_REPORT.md (legado): {md_out} ({len(report_md)} chars)")
            except Exception as e:
                print(f"❌ Falha ao escrever CI_REPORT legado: {e}", file=sys.stderr)
        elif use_legacy_env:
            try:
                legacy_md = repo / ".planning" / "CI_REPORT.md"
                legacy_md.write_text(report_md, encoding="utf-8")
                print(f"✅ CI_REPORT.md (legado env): {legacy_md}")
            except Exception:
                pass
        else:
            print("ℹ️ CI report persistido em .planning/HANDOFF.md (CI_REPORT:START) e STATE.md (CI_STATE) — sem criar CI_REPORT.md separado")
        if has_legacy_json:
            try:
                assert json_out is not None
                json_out.parent.mkdir(parents=True, exist_ok=True)
                json_out.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
                print(f"✅ ci_metrics.json (legado): {json_out}")
            except Exception as e:
                print(f"⚠️ Falha ao escrever ci_metrics.json legado: {e}")
        elif use_legacy_env:
            try:
                (repo / ".planning" / "ci_metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
    else:
        print("(dry-run — HANDOFF/STATE não atualizados)")

    # update retries if fail and not dry-run: increment for next loop (harness will read)
    if status == "fail" and not dry_run:
        # increment only if we will loop; but leave increment to harness/plugin to decide?
        # Here we provide current count, next loop will increment via plugin/harness.
        # Optionally, save incremented preview?
        pass

    # ── Log de garantia ──
    try:
        exit_code_map = {"pass": 0, "fail": 2, "pending": 3, "unknown": 1, "skipped": 0}
        exit_code = exit_code_map.get(status, 1)
        if args.fail_on_ci and status == "fail":
            exit_code = 2
        entry = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "hook": "ci-watch",
            "branch": branch,
            "pr_number": pr_info.get("number"),
            "pr_url": pr_info.get("url"),
            "status": status,
            "details": details[:500],
            "attempts": attempts,
            "elapsed": round(elapsed, 1),
            "retries": retries,
            "max_retries": max_retries,
            "wait": args.wait,
            "timeout": timeout,
            "exit_code": exit_code,
            "dry_run": dry_run,
        }
        line = json.dumps(entry, ensure_ascii=False)
        seen = set()
        for log_path in [repo / ".planning/HOOKS.log", Path(".opencode/hooks/hook-audit.jsonl")]:
            try:
                resolved = log_path.resolve()
                if str(resolved) in seen:
                    continue
                seen.add(str(resolved))
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("a", encoding="utf-8") as lf:
                    lf.write(line + "\n")
            except Exception:
                pass
        print(f"📝 Log garantia: .planning/HOOKS.log (ci-watch status={status})")
    except Exception:
        pass

    print("\n" + "="*60)
    print(f"🔍 CI watch — status={status} branch={branch} PR={pr_info.get('number','?')} elapsed={elapsed:.1f}s attempts={attempts}")
    print(f"  details: {details[:300]}")
    report_loc = "HANDOFF.md:CI_REPORT:START / STATE.md:CI_STATE" if not dry_run else "(dry-run)"
    if has_legacy_md and md_out:
        report_loc += f" + {md_out} (legado)"
    print(f"  report: {report_loc}")
    print("="*60)
    print(report_md[:3000])

    # Exit codes
    if status == "pass":
        sys.exit(0)
    if status == "fail":
        # if retries já excedeu max, exit 2 mas com mensagem de escalar humano
        if retries >= max_retries:
            print(f"🛑 CI falhou e retries {retries}/{max_retries} esgotados — escalar para humano", file=sys.stderr)
        sys.exit(2)
    if status == "pending":
        sys.exit(3)
    sys.exit(1)

if __name__ == "__main__":
    main()
