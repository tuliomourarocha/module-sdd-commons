#!/usr/bin/env python3
"""
hooks/shipper.py — Hook determinístico para finalização (shipper como hook).

Conceito de Hook (fora do LLM):
  Middleware determinístico que finaliza o ciclo sem depender de LLM para
  tarefas mecânicas: git commit, PR, CI check e sync de issue GitHub.
  STATE/HANDOFF ainda podem ter contribuição qualitativa do agente shipper
  minimal quando o hook não consegue gerar conteúdo rico — fallback previsto
  no harness (shipper minimal).

Acionamento:
  - Trigger primário: após reviewer aprovar (task reviewer completa)
  - Invocado por: plugins/shipper.ts via `tool.execute.after` (task reviewer/builder) + `event: session.idle`
    e também direto via CLI: `python3 hooks/shipper.py --run --repo .`
  - Em Claude: `.claude/settings.json` → hooks.PostToolUse / Stop (opcional)

O que faz (determinístico, sem LLM):
  - Git: fetch origin (base atualizada), branch de trabalho criada a partir de
    `origin/<pr_base>` (default `develop`, via `--pr-base`/`SDD_PR_BASE`), commit
    conventional, push
  - PR: `gh pr create --base <pr_base> --head <branch>` (develop, nunca main por
    default) ou atualiza se já existe (corrige a base se divergente); `gh pr checks`
    para CI
  - STATE/HANDOFF: gera templates em `.planning/STATE.md` e `.planning/HANDOFF.md` a partir de git diff + contexto injetado (se --context-file fornecido)
  - Issue GitHub: sync REAL via `gh` CLI quando o card do ciclo é uma issue (board =
    GitHub Project; card = issue): valida autenticação de fato (`gh auth status`) antes
    de agir — sem auth, marca `GITHUB_AUTH_REQUIRED` (instrução de `gh auth login`).
    Localiza a issue por número/URL EXPLICITAMENTE (`--issue`/`SDD_GITHUB_ISSUE`/contexto
    `issueId`) ou AUTO (hints do branch/PR: `Closes #N` no body do PR, prefixo numérico
    do branch ex. `123-slug`); encerra com comentário do PR (`gh issue close --reason
    completed`) e, se `--project`/`SDD_GITHUB_PROJECT` configurado, move o Status do
    GitHub Project para `Done` (best-effort). NUNCA inventa issue — auto exige match
    validado por `gh issue view`.
    Regras de honestidade: sem `gh` = `skipped` (pulado); com `gh`, status `ok` SÓ quando
    a issue foi fechada de fato (verificado via `gh issue view --json state`). Qualquer
    falha (sem auth, issue não localizada/ambígua, API/rede) → `GITHUB_SYNC_FAILED` visível
    no stdout, bloco `<!-- GITHUB_REPORT -->` no HANDOFF.md, campo `github` no HOOKS.log e
    instrução de fallback (`task shipper` minimal com a skill `github-cli` — CLI
    `skills/github-cli/scripts/sdd_backlog.py` — carregada antes de qualquer operação).
    Não bloqueia o pipeline por padrão; `--fail-on-issue` força exit 2.

Exit codes:
  0 = shipper ok (commit+PR+HANDOFF/STATE gerados, issue sync ok, skipped ou falho sem --fail-on-issue)
  1 = erro de uso
  2 = falha crítica (git falhou, gh não autenticado e sem HANDOFF, CI falhou e precisa escalar, issue falhou com --fail-on-issue)

Fallback:
  Se executado via hook e não houver contexto rico (PRD/PLAN + resumo/parecer),
  gera HANDOFF minimal com git diff e deixa agente shipper minimal complementar
  via LLM se necessário. Harness detecta e ainda pode chamar task shipper minimal.
  **NUNCA cria** `.planning/SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` — esses artefatos são proibidos.
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
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

def run(cmd: list[str], cwd: Path | None = None, timeout: int = 60) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except Exception as e:
        return 1, "", str(e)

def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""

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

def get_git_status(repo: Path) -> dict[str, Any]:
    code, out, _ = run(["git", "status", "--porcelain"], cwd=repo)
    code2, diff_stat, _ = run(["git", "diff", "--stat", "HEAD"], cwd=repo)
    code3, diff_names, _ = run(["git", "diff", "--name-only", "HEAD"], cwd=repo)
    code4, log, _ = run(["git", "log", "--oneline", "-5"], cwd=repo)
    return {
        "porcelain": out.strip(),
        "diff_stat": diff_stat.strip(),
        "diff_names": [l.strip() for l in diff_names.splitlines() if l.strip()],
        "log": log.strip(),
        "branch": get_git_branch(repo),
        "has_changes": bool(out.strip() or diff_stat.strip()),
    }

def ensure_planning_dir(repo: Path):
    (repo / ".planning").mkdir(parents=True, exist_ok=True)

# ── Branch base — work branch nasce de origin/<base> ATUALIZADA (default develop) ──
def git_remote_default_branch(repo: Path) -> str:
    code, out, _ = run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], cwd=repo)
    if code == 0 and out.strip():
        return out.strip().rsplit("/", 1)[-1]
    return "main"

def determine_pr_base(repo: Path, requested: str) -> tuple[str, str]:
    """Base de PR/branch: `develop` via ls-remote (fonte de verdade da origin). Sem inventar."""
    base = (requested or "").strip() or "develop"
    code, out, _ = run(["git", "ls-remote", "--heads", "origin", base], cwd=repo, timeout=30)
    if code == 0 and out.strip():
        return base, ""
    fallback = git_remote_default_branch(repo)
    note = f"origin não tem '{base}' — usando '{fallback}' (default detectado)"
    return fallback, note

def git_fetch_base(repo: Path, base: str) -> str:
    code, out, err = run(["git", "fetch", "origin", base], cwd=repo, timeout=90)
    return "" if code == 0 else f"git fetch origin {base} falhou ({(out+err).strip()[:200]}) — branch pode estar desatualizada"

def branch_slug(msg: str) -> str:
    txt = (msg or "").strip().splitlines()[0] if (msg or "").strip() else "shipper"
    txt = re.sub(r"^[a-z]+(\([^)]*\))?[!:]?:\s*", "", txt, flags=re.IGNORECASE)
    slug = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", txt.lower())).strip("-")
    return slug[:32] or "shipper"

def prepare_feature_branch(repo: Path, base: str, commit_msg: str, dry_run: bool) -> dict[str, Any]:
    """Branch de trabalho a partir de `origin/<base>` APÓS fetch (atualizada).

    - Em `<base>`/`main`/`master` com alterações: cria `<feat|fix|chore>/<slug>-<ts>` de origin/<base> (muda de branch carregando alterações uncommitted).
    - Em feature branch: NÃO rebasa automaticamente — apenas reporta quantos commits atrás de origin/<base> (honestidade).
    """
    res: dict[str, Any] = {"base": base, "branch": get_git_branch(repo), "created": False, "notes": []}
    cur = res["branch"]
    if dry_run:
        if cur in (base, "main", "master"):
            res["notes"].append(f"dry-run: branch de trabalho de origin/{base} não criada")
        return res
    fetch_note = git_fetch_base(repo, base)
    if fetch_note:
        res["notes"].append(fetch_note)
    if cur in (base, "main", "master"):
        if not get_git_status(repo)["has_changes"]:
            res["notes"].append(f"sem alterações — branch de trabalho não criada (em `{cur}`)")
            return res
        prefix = "fix" if commit_msg.strip().lower().startswith("fix") else "chore" if commit_msg.strip().lower().startswith("chore") else "feat"
        name = f"{prefix}/{branch_slug(commit_msg)}-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        code, out, err = run(["git", "switch", "-c", name, f"refs/remotes/origin/{base}"], cwd=repo)
        if code == 0:
            res["branch"] = name; res["created"] = True
            res["notes"].append(f"branch `{name}` criada a partir de `origin/{base}` (atualizada via fetch)")
        else:
            res["notes"].append(f"falha ao criar branch `{name}` de origin/{base}: {(out+err).strip()[:200]} — permanecendo em `{cur}`")
            res["branch"] = get_git_branch(repo)
        return res
    code, out, _ = run(["git", "rev-list", "--count", f"{cur}..refs/remotes/origin/{base}"], cwd=repo)
    if code == 0 and out.strip().isdigit() and int(out.strip()) > 0:
        res["notes"].append(f"branch `{cur}` está {int(out.strip())} commit(s) atrás de `origin/{base}` — rebase/merge manual recomendado (hook não rebasa)")
    return res

def load_context(context_file: str | None) -> dict[str, Any]:
    if not context_file:
        return {}
    p = Path(context_file)
    if not p.exists():
        return {}
    try:
        txt = p.read_text(encoding="utf-8")
        # tenta JSON, senão trata como texto
        try:
            return json.loads(txt)
        except:
            return {"raw": txt}
    except:
        return {}

def strip_marker_blocks(text: str) -> str:
    """Remove todos os blocos de marcadores de hooks (CI/GITHUB/SUPERVISOR/ORCHESTRATOR) de um texto."""
    for start, end in (
        (GITHUB_HANDOFF_START, GITHUB_HANDOFF_END),
        ("<!-- CI_REPORT:START -->", "<!-- CI_REPORT:END -->"),
        ("<!-- SUPERVISOR:START -->", "<!-- SUPERVISOR:END -->"),
        ("<!-- ORCHESTRATOR:START -->", "<!-- ORCHESTRATOR:END -->"),
    ):
        text = re.sub(re.escape(start) + r".*?" + re.escape(end), "", text, flags=re.DOTALL)
    return text

def generate_handoff(repo: Path, git_info: dict[str, Any], context: dict[str, Any], args, branch_prep: dict[str, Any] | None = None) -> str:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    branch = git_info.get("branch", "main")
    bp = branch_prep or {}
    base = bp.get("base") or getattr(args, "pr_base", "develop")
    branch_disp = f"`{branch}`" + (f" (criada de `origin/{base}` atualizada)" if bp.get("created") else f" ← `origin/{base}`")
    diff_stat = git_info.get("diff_stat", "")[:4000]
    diff_names = git_info.get("diff_names", [])
    # contexto injetado (PRD/PLAN + resumo/parecer) se houver — nunca arquivos SUMMARY/REVIEW/VALIDATION
    prd = context.get("PRD.md") or context.get("prd") or ""
    plan = context.get("PLAN.md") or context.get("plan") or ""
    # resumo/parecer são em memória; aceita chaves legadas SUMMARY/REVIEW apenas para compat, mas preferir resumo/parecer
    summary = context.get("summary") or context.get("resumo") or context.get("SUMMARY.md") or ""
    review = context.get("review") or context.get("parecer") or context.get("REVIEW.md") or ""
    # tenta ler arquivos existentes em .planning como fallback (quando shipper hook roda isolado)
    # ATT: extrai só a seção qualitativa e remove cabeçalhos/marcadores do próprio hook
    # para não embutir o HANDOFF anterior recursivamente (nem GITHUB_REPORT/CI_REPORT)
    if not summary:
        handoff_cand = repo / ".planning" / "HANDOFF.md"
        state_cand = repo / ".planning" / "STATE.md"
        base_txt = ""
        if handoff_cand.exists():
            txt = strip_marker_blocks(read_text(handoff_cand))
            if "## O que foi feito" in txt:
                base_txt = txt.split("## O que foi feito", 1)[1].split("\n## ", 1)[0]
            else:
                base_txt = txt
        elif state_cand.exists():
            base_txt = strip_marker_blocks(read_text(state_cand))
        summary = "\n".join(
            l for l in base_txt.splitlines()
            if not l.startswith("# HANDOFF — ") and not l.startswith("# STATE — ") and not l.startswith("_Gerado por `hooks/shipper.py`")
        ).strip()[:2000]

    files_list = "\n".join([f"- `{f}`" for f in diff_names[:50]]) if diff_names else "- _nenhum arquivo alterado detectado (ver git status)_"

    lines = []
    lines.append(f"# HANDOFF — {now}")
    lines.append("")
    lines.append(f"**Branch:** {branch_disp} | **PR base:** `{base}` (develop, nunca main) | **Repo:** `{args.repo_slug}` | **Gerado por:** `hooks/shipper.py` (determinístico, fallback hook)")
    lines.append("")
    branch_notes = [n for n in (bp.get("notes") or []) if n]
    if branch_notes:
        lines.append("## Branch (origem)")
        lines.append("")
        for n in branch_notes:
            lines.append(f"- {n}")
        lines.append("")
    lines.append("## O que foi feito")
    lines.append("")
    if summary:
        # resume summary se for markdown longo, pega primeiros 1500 chars
        lines.append(summary[:3000].strip())
        lines.append("")
    else:
        lines.append(f"- Ciclo finalizado via hook shipper em {now}.")
        lines.append(f"- Alterações detectadas via `git diff --stat HEAD`:")
        lines.append("```")
        lines.append(diff_stat or "(sem diff)")
        lines.append("```")
        lines.append("")
        if prd:
            lines.append("### PRD (trecho)")
            lines.append(prd[:1500])
            lines.append("")
        if plan:
            lines.append("### PLAN (trecho)")
            lines.append(plan[:1500])
            lines.append("")
    lines.append("## Arquivos alterados")
    lines.append("")
    lines.append(files_list)
    if len(diff_names) > 50:
        lines.append(f"- ... e mais {len(diff_names)-50} arquivos")
    lines.append("")
    lines.append("```")
    lines.append(diff_stat[:3000] if diff_stat else "(sem diff)")
    lines.append("```")
    lines.append("")
    lines.append("## Decisões")
    lines.append("")
    if review:
        lines.append(review[:2000])
        lines.append("")
    else:
        lines.append("- Decisões conforme PLAN e resumo/parecer (ver git diff e commits).")
        lines.append("- Guard rails via `hooks/guard_rails.py` (determinístico) — HIGH deve estar zerado. Nenhum SUMMARY/REVIEW/VALIDATION em disco.")
        lines.append("")
    lines.append("## Pendências / Próximos passos")
    lines.append("")
    lines.append("- [ ] CI deve estar verde (ver `gh pr checks` / `gh run list`)")
    lines.append("- [ ] Se hook gerou HANDOFF minimal, agente shipper minimal pode complementar com contexto qualitativo (PRD/PLAN + resumo/parecer em memória)")
    lines.append("- [ ] GitHub issue sync: ver bloco `GITHUB_REPORT` neste arquivo (ok = issue fechada; failed = fallback `task shipper` com skill `github-cli` carregada primeiro, pendente)")
    lines.append("")
    lines.append("## Artefatos em memória (não em disco)")
    lines.append("")
    lines.append("- `PRD.md` — memória (planner)")
    lines.append("- `PLAN.md` — memória (planner)")
    lines.append("- resumo — memória (builder, nunca SUMMARY.md)")
    lines.append("- parecer — memória (reviewer arquitetura apenas, nunca REVIEW.md)")
    lines.append("")
    lines.append("---")
    lines.append(f"_Gerado por `hooks/shipper.py` em {now} — hook determinístico. Se conteúdo estiver minimal, fallback para `task shipper` minimal para enriquecer STATE/HANDOFF._")
    return "\n".join(lines)

def generate_state(repo: Path, git_info: dict[str, Any], context: dict[str, Any], args, pr_url: str | None, github: dict[str, Any] | None = None, branch_prep: dict[str, Any] | None = None) -> str:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    branch = git_info.get("branch", "main")
    bp = branch_prep or {}
    base = bp.get("base") or getattr(args, "pr_base", "develop")
    flow = context.get("flow") or "feature"
    # tenta inferir flow do HANDOFF/STATE existente
    existing_state = read_text(repo / ".planning" / "STATE.md")
    if not flow and "project" in existing_state.lower():
        flow = "project"
    elif not flow and "bugfix" in existing_state.lower():
        flow = "bugfix"

    lines = []
    lines.append(f"# STATE — {now}")
    lines.append("")
    branch_disp = f"`{branch}`" + (f" (criada de `origin/{base}` atualizada)" if bp.get("created") else "")
    lines.append(f"**Flow:** `{flow}` | **Gate:** `done` | **Branch:** {branch_disp}")
    lines.append(f"**PR base:** `{base}` (develop, nunca main) | **Repo:** `{args.repo_slug}` | **Gerado por:** `hooks/shipper.py`")
    if pr_url:
        lines.append(f"**PR:** {pr_url}")
    gh_status = (github or {}).get("status", "skipped")
    gh_icon = {"ok": "✅", "failed": "❌", "skipped": "⏭️", "dry_run": "🧪"}.get(gh_status, "❔")
    issue_disp = f"#{(github or {}).get('issue')}" if (github or {}).get("issue") else "—"
    lines.append(f"**GitHub issue:** {gh_icon} `{gh_status}` ({issue_disp}) — {sanitize_url_text(str((github or {}).get('message', '')))[:200]}")
    lines.append("")
    lines.append("## Artifacts")
    lines.append("")
    lines.append("- `PRD.md`: done (memória)")
    lines.append("- `PLAN.md`: done (memória)")
    lines.append("- resumo: done (memória, nunca SUMMARY.md)")
    lines.append("- parecer: done (memória, nunca REVIEW.md)")
    lines.append("- `HANDOFF.md`: done (disco — hook)")
    lines.append("- `STATE.md`: done (disco — hook)")
    lines.append(f"- Issue GitHub: `{gh_status}` (hook — se `failed`, fallback `task shipper` minimal com skill `github-cli` carregada primeiro; ver HANDOFF.md#GITHUB_REPORT)")
    lines.append("- `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`: proibidos em disco")
    lines.append("")
    lines.append("## Gates")
    lines.append("")
    lines.append("- Gate 1 (planner→builder): `approved`")
    lines.append("- Gate 2 (reviewer→shipper): `approved` (review arquitetura)")
    lines.append("- Guard rails (hooks): `pass` (nenhum HIGH pendente)")
    lines.append("")
    lines.append("## Next")
    lines.append("")
    lines.append("- Done — aguardar supervisor hook (`hooks/supervisor.py`) para auditoria final")
    lines.append("")
    lines.append("---")
    lines.append(f"_Atualizado por `hooks/shipper.py` em {now}_")
    return "\n".join(lines)

def do_git_commit(repo: Path, message: str, dry_run: bool) -> tuple[bool, str]:
    info = get_git_status(repo)
    if not info["has_changes"]:
        code, out, _ = run(["git", "status", "--porcelain"], cwd=repo)
        if not out.strip():
            return True, "sem alterações para commit"
    if dry_run:
        return True, f"dry-run: commit não executado ({message})"
    # add
    code, out, err = run(["git", "add", "-A"], cwd=repo)
    if code != 0:
        return False, f"git add falhou: {err or out}"
    # commit — se já tem staged?
    code, out, err = run(["git", "diff", "--cached", "--name-only"], cwd=repo)
    if not out.strip():
        return True, "nada staged após add"
    code, out, err = run(["git", "commit", "-m", message], cwd=repo)
    if code != 0:
        # pode ser "nothing to commit"
        if "nothing to commit" in (out+err).lower():
            return True, "nothing to commit"
        return False, f"git commit falhou: {out} {err}"
    return True, out.strip()[:500]

def do_git_push(repo: Path, branch: str, dry_run: bool) -> tuple[bool, str]:
    if dry_run:
        return True, "dry-run: push não executado"
    # verifica remote
    code, out, _ = run(["git", "remote", "get-url", "origin"], cwd=repo)
    if code != 0:
        return True, "sem remote origin — push pulado"
    code, out, err = run(["git", "push", "-u", "origin", branch], cwd=repo)
    if code != 0:
        return False, f"git push falhou: {out} {err}"
    return True, out.strip()[:500]

def do_gh_pr(repo: Path, title: str, body_file: Path, branch: str, base: str, dry_run: bool) -> tuple[bool, str, str | None]:
    """PR de `<branch>` para `<base>` (develop) — explícito em --base/--head, nunca depende do default."""
    if dry_run:
        return True, f"dry-run: PR não criado (base `{base}` ← `{branch}`)", None
    if not gh_available():
        return False, "gh CLI não encontrado", None
    # PR já existe para a branch? Se a base divergir (ex.: PR aberto p/ main), corrige para <base>
    code, out, _ = run(["gh", "pr", "view", branch, "--json", "number,url,baseRefName"], cwd=repo)
    if code == 0 and out.strip().startswith("{"):
        try:
            existing = json.loads(out)
        except Exception:
            existing = {}
        if existing.get("url"):
            if existing.get("baseRefName") and existing["baseRefName"] != base:
                code_e, out_e, err_e = run(["gh", "pr", "edit", str(existing["number"]), "--base", base], cwd=repo)
                note = f"PR existente {existing['url']} — base ajustada `{existing['baseRefName']}` → `{base}`" if code_e == 0 \
                    else f"PR existente {existing['url']} — base continua `{existing['baseRefName']}` ({(err_e or '').strip()[:120]})"
                return True, note, existing["url"]
            return True, f"PR já existe: {existing['url']}", existing["url"]
    code2, out2, err2 = run(["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", str(body_file)], cwd=repo)
    if code2 == 0:
        url = out2.strip()
        return True, url, url
    # se falhou por already exists, tente view
    if "already exists" in (out2+err2).lower() or "already" in (out2+err2).lower():
        code3, out3, _ = run(["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"], cwd=repo)
        if code3 == 0 and out3.strip():
            return True, f"PR já existe: {out3.strip()}", out3.strip()
        return False, f"gh pr create falhou (already exists mas view falhou): {out2} {err2}", None
    # falha genérica
    if "gh auth" in (out2+err2).lower() or "not authenticated" in (out2+err2).lower():
        return False, f"gh não autenticado: {out2} {err2} — faça `gh auth login`", None
    return False, f"gh pr create falhou (base `{base}` ← `{branch}`): {out2} {err2}", None

def do_ci_check(repo: Path, dry_run: bool) -> tuple[bool | None, str]:
    if dry_run:
        return None, "dry-run: CI check pulado"
    if not gh_available():
        return None, "gh não encontrado — CI check pulado"
    code, out, _ = run(["gh", "pr", "checks"], cwd=repo, timeout=30)
    if code == 0:
        if "pass" in out.lower() or "success" in out.lower():
            return True, out[:1000]
        if "fail" in out.lower() or "failure" in out.lower():
            return False, out[:1000]
        return None, out[:1000]
    # fallback gh run list
    code2, out2, _ = run(["gh", "run", "list", "--limit", "3"], cwd=repo, timeout=30)
    if code2 == 0:
        return None, out2[:1000]
    return None, f"CI check não disponível: {out[:500]}"

# ── GitHub Issues — sync real via gh CLI (determinístico, sem LLM) ────────────
GITHUB_HANDOFF_START = "<!-- GITHUB_REPORT:START -->"
GITHUB_HANDOFF_END = "<!-- GITHUB_REPORT:END -->"
ISSUE_URL_RE = re.compile(r"github\.com/[^/\s\"]+/[^/\s\"]+/issues/(\d+)")
ISSUE_NUM_RE = re.compile(r"^#?(\d{1,6})$")
CLOSES_RE = re.compile(r"(?i)\b(?:closes?|fix(?:e[sd])?|resolves?)\s+#(\d+)")
BRANCH_ISSUE_RE = re.compile(r"(?i)(?:^|[/\-_.])(?:issue-?)?(\d{1,6})(?:[-_.]|$)")
# Allowlist de status do Project — NUNCA inventa destino fora disso
GITHUB_DONE_PATTERNS = ("done", "conclu", "entregue", "shipped", "finalizado", "pronto", "deployed")
GITHUB_DOING_PATTERNS = ("progress", "doing", "execu", "fazendo")

def sanitize_url_text(text: str) -> str:
    """Remove query strings de URLs (podem conter credenciais) — nunca vazar em logs."""
    return re.sub(r"\?[^ \n\"']*", "?***", text or "")

def gh_run(repo: Path, args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    return run(["gh", *args], cwd=repo, timeout=timeout)

def gh_json(repo: Path, args: list[str], timeout: int = 30) -> tuple[bool, Any, str]:
    code, out, err = gh_run(repo, args, timeout=timeout)
    if code != 0:
        return False, None, (out + err).strip()[:300]
    try:
        return True, json.loads(out), ""
    except Exception as e:
        return False, None, f"resposta inválida: {e}"

def gh_auth_ok(repo: Path) -> tuple[bool, str]:
    """Valida autenticação de fato (gh auth status) — falha vira instrução determinística."""
    code, out, err = gh_run(repo, ["auth", "status"], timeout=20)
    if code == 0:
        m = re.search(r"Logged in to \S+ as ([^\s(]+)", out + err)
        return True, f"autenticado como `{m.group(1)}`" if m else "autenticado"
    return False, "gh não autenticado — rode `gh auth login` e reexecute o shipper"

def repo_slug(repo: Path) -> str:
    code, out, _ = run(["git", "remote", "get-url", "origin"], cwd=repo)
    if code != 0:
        return ""
    m = re.search(r"[:/]([^/]+/[^/.]+?)(?:\.git)?/?$", out.strip())
    return m.group(1) if m else ""

def issue_number_from_ref(ref: str) -> int | None:
    """Número da issue a partir de número puro, `#N` ou URL de issue."""
    s = str(ref or "").strip()
    m = ISSUE_URL_RE.search(s)
    if m:
        return int(m.group(1))
    m = ISSUE_NUM_RE.match(s.lstrip("#"))
    return int(m.group(1)) if m else None

def explicit_issue_numbers(args, context: dict[str, Any] | None) -> list[int]:
    """Issue explícita: CLI `--issue` > env `SDD_GITHUB_ISSUE` > contexto (issueId/issue_url/...)."""
    ctx = context or {}
    refs = [str(getattr(args, "issue", "") or ""), os.environ.get("SDD_GITHUB_ISSUE", "")]
    refs += [str(ctx.get(k, "") or "") for k in ("issue", "issueId", "issue_url", "issueUrl", "github_issue", "githubIssue")]
    gh_ctx = ctx.get("github")
    if isinstance(gh_ctx, dict):
        refs += [str(gh_ctx.get(k, "") or "") for k in ("issue", "issueId", "issue_url")]
    nums = [n for n in (issue_number_from_ref(r) for r in refs) if n]
    return list(dict.fromkeys(nums))

def collect_issue_hints(branch: str, log: str, context: dict[str, Any] | None) -> list[int]:
    """Hints determinísticos de issue a partir do branch/commits: prefixo `123-slug`, `issue-123`, `#N` em commit."""
    nums: list[int] = []
    for m in BRANCH_ISSUE_RE.finditer(branch or ""):
        nums.append(int(m.group(1)))
    for m in ISSUE_URL_RE.finditer(f"{branch}\n{log}"):
        nums.append(int(m.group(1)))
    commit_text = str((context or {}).get("commit", "")) + "\n" + str((context or {}).get("message", ""))
    for m in re.finditer(r"#(\d{1,6})", commit_text):
        nums.append(int(m.group(1)))
    return list(dict.fromkeys(nums))

def pr_closes_issues(repo: Path) -> list[int]:
    """Issues referenciadas no body do PR atual (`Closes/Fixes/Resolves #N`) — o GitHub fecha ao mergear."""
    ok, pr, _err = gh_json(repo, ["pr", "view", "--json", "number,body"])
    if not ok or not isinstance(pr, dict):
        return []
    return list(dict.fromkeys(int(m.group(1)) for m in CLOSES_RE.finditer(str(pr.get("body", "")))))

def locate_github_issue(repo: Path, explicit: list[int], pr_close: list[int], auto: list[int]) -> tuple[bool, dict[str, Any] | str]:
    """Localiza a issue do ciclo: explícita (aceita já fechada — idempotente) > closes do PR (só abertas) > hints (só abertas).

    Candidato inválido = tenta o próximo; nada casou = falha honesta (nunca chuta).
    """
    for nums, strict_open in ((explicit, False), (pr_close, True), (auto, True)):
        for n in nums:
            ok, data, _err = gh_json(repo, ["issue", "view", str(n), "--json", "number,title,state,url"])
            if not ok or not isinstance(data, dict):
                continue
            if strict_open and data.get("state") != "OPEN":
                continue
            return True, data
    if explicit:
        return False, f"issue explícita não localizada: {', '.join(f'#{n}' for n in explicit)}"
    return False, ("issue não identificada automaticamente (hints usados: `Closes #N` no body do PR, prefixo numérico do branch ex. `123-slug`; "
                   "configure `--issue <n>`/`SDD_GITHUB_ISSUE` ou inclua `issueId` no context)")

def _item_issue_num(item: dict[str, Any]) -> int | None:
    m = re.search(r"/issues/(\d+)", str(((item or {}).get("content") or {}).get("url", "")))
    return int(m.group(1)) if m else None

def gh_project_set_status(repo: Path, project_ref: str, issue_url: str, want: str) -> tuple[bool, str]:
    """Move o Status do GitHub Project (board) via gh project — best-effort; nunca bloqueia o encerramento."""
    own = repo_slug(repo).split("/")[0]
    if not own:
        return False, "sem remote origin — não dá para resolver o Project"
    ref = str(project_ref).strip()
    m = re.search(r"/projects/(\d+)", ref)
    if m:
        ref = m.group(1)
    if ref.isdigit():
        ok_v, proj, err = gh_json(repo, ["project", "view", ref, "--owner", own, "--format", "json"], timeout=30)
        if not ok_v or not isinstance(proj, dict):
            return False, f"Project `{ref}` não encontrado: {err or 'resposta inválida'}"
    else:
        ok_l, projects, err = gh_json(repo, ["project", "list", "--owner", own, "--format", "json"], timeout=30)
        if not ok_l or not isinstance(projects, list):
            return False, f"gh project list falhou: {err or 'resposta inválida'}"
        proj = next((p for p in projects if isinstance(p, dict) and str(p.get("title", "")).strip().lower() == ref.lower()), None)
        if not proj:
            titles = ", ".join(f"'{p.get('title', '')}'" for p in projects if isinstance(p, dict)) or "(nenhum)"
            return False, f"Project '{ref}' não encontrado (projetos: {titles})"
    pnum, pid = str(proj.get("number", "")), str(proj.get("id", ""))
    if not (pnum and pid):
        return False, "Project sem number/id — não é possível editar o item"
    num_m = re.search(r"/issues/(\d+)", issue_url)
    if not num_m:
        return False, "URL da issue inválida para localizar o item no Project"
    num = num_m.group(1)
    ok_i, items, err = gh_json(repo, ["project", "item-list", pnum, "--owner", own, "--limit", "500", "--format", "json"], timeout=120)
    if not ok_i or not isinstance(items, (list, dict)):
        return False, f"gh project item-list falhou: {err or 'resposta inválida'}"
    if isinstance(items, dict):
        items = items.get("items", [])
    item = next((i for i in items if isinstance(i, dict) and _item_issue_num(i) == int(num)), None)
    if not item:
        return False, f"issue `#{num}` não está no Project `{proj.get('title', pnum)}` (planner deve adicionar ao Project)"
    ok_f, fields, err = gh_json(repo, ["project", "field-list", pnum, "--owner", own, "--format", "json"], timeout=30)
    if not ok_f or not isinstance(fields, (list, dict)):
        return False, f"gh project field-list falhou: {err or 'resposta inválida'}"
    if isinstance(fields, dict):
        fields = fields.get("fields", [])
    field = next((f for f in fields if isinstance(f, dict) and str(f.get("name", "")).strip().lower() == "status"), None)
    if not field:
        names = ", ".join(f.get("name", "") for f in fields if isinstance(f, dict)) or "(nenhum)"
        return False, f"campo `Status` não existe no Project (campos: {names})"
    options = field.get("options") or []
    w = str(want or "").strip().lower()
    patterns = GITHUB_DONE_PATTERNS if any(p in w for p in ("done", "conclu", "entregue", "shipped")) else \
               GITHUB_DOING_PATTERNS if any(p in w for p in ("progress", "doing", "execu", "fazendo")) else \
               ("backlog", "todo")
    option = next((o for o in options if isinstance(o, dict) and str(o.get("name", "")).strip().lower() == w), None) \
             or next((o for o in options if isinstance(o, dict) and any(p in str(o.get("name", "")).lower() for p in patterns)), None)
    if not option:
        opts = ", ".join(o.get("name", "") for o in options if isinstance(o, dict)) or "(nenhuma)"
        return False, f"opção '{want}' não existe no campo Status (opções: {opts}) — nunca inventa destino"
    code, out, err = gh_run(repo, ["project", "item-edit", "--id", str(item.get("id")), "--project-id", pid,
                                   "--field-id", str(field.get("id")), "--single-select-option-id", str(option.get("id"))], timeout=30)
    if code != 0:
        return False, f"gh project item-edit falhou: {(out + err).strip()[:200]}"
    return True, f"Project `{proj.get('title', pnum)}` → Status `{option.get('name')}`"

def do_github_sync(repo: Path, pr_url: str | None, dry_run: bool, args, context: dict[str, Any] | None = None, git_info: dict[str, Any] | None = None) -> dict[str, Any]:
    """Sync de issue GitHub real. `ok` exige issue FECHADA de fato; falha é sempre visível (nunca sucesso silencioso).

    Status: ok | skipped (gh ausente) | failed (sem auth/issue não localizada/API/rede) | dry_run.
    Garante sanitização final — mensagem jamais contém credenciais.
    """
    result = _github_sync(repo, pr_url, dry_run, args, context, git_info)
    result["message"] = sanitize_url_text(str(result.get("message", "")))
    return result

def _github_sync(repo: Path, pr_url: str | None, dry_run: bool, args, context: dict[str, Any] | None = None, git_info: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "skipped", "message": "", "closed": False, "commented": False,
        "issue": None, "issue_url": None, "issue_title": None,
        "project": None, "project_status": None, "auth_required": False,
    }
    if not gh_available():
        result["message"] = ("GitHub issue sync não configurado — pulado (gh CLI não instalado; "
                             "instale gh e rode `gh auth login` para ativar)")
        return result
    ok_a, msg_a = gh_auth_ok(repo)
    if not ok_a:
        result["status"] = "failed"
        result["auth_required"] = True
        result["message"] = f"GITHUB_AUTH_REQUIRED: falha de autenticação ({msg_a})"
        return result

    explicit = explicit_issue_numbers(args, context)
    auto = collect_issue_hints(
        branch=(git_info or {}).get("branch", ""),
        log=(git_info or {}).get("log", ""),
        context=context,
    )
    pr_close = pr_closes_issues(repo) if pr_url else []
    if dry_run:
        ok_c, issue = locate_github_issue(repo, explicit, pr_close, auto)
        if not ok_c:
            result["status"] = "failed"
            result["message"] = "dry-run — " + str(issue)
            return result
        result["issue"] = issue.get("number"); result["issue_url"] = issue.get("url"); result["issue_title"] = issue.get("title")
        alvo = f"; status `{issue.get('state')}`"
        project_ref = str(getattr(args, "project", "") or os.environ.get("SDD_GITHUB_PROJECT", "") or "")
        if project_ref and issue.get("url"):
            ok_p, msg_p = gh_project_set_status(repo, project_ref, str(issue.get("url")), "Done")
            result["project"] = project_ref
            result["project_status"] = "Done" if ok_p else None
            alvo += f"; projeto: {msg_p}"
        result["status"] = "dry_run"
        result["message"] = f"dry-run: comentaria o PR e fecharia issue `#{issue.get('number')}`{alvo}"
        return result

    ok_c, issue = locate_github_issue(repo, explicit, pr_close, auto)
    if not ok_c:
        result["status"] = "failed"
        result["message"] = f"GITHUB_MISCONFIGURED: {issue}"
        return result
    result["issue"] = issue.get("number")
    result["issue_url"] = issue.get("url")
    result["issue_title"] = issue.get("title")
    number = str(issue.get("number"))

    # 1. Projeto (Status → Done) — best-effort; não bloqueia o encerramento
    project_note = ""
    project_ref = str(getattr(args, "project", "") or os.environ.get("SDD_GITHUB_PROJECT", "") or "")
    if project_ref and issue.get("url"):
        ok_p, msg_p = gh_project_set_status(repo, project_ref, str(issue.get("url")), "Done")
        result["project"] = project_ref
        result["project_status"] = "Done" if ok_p else None
        project_note = f" | projeto: {msg_p}"

    # 2. Opcional: comentar link do PR (flag --no-issue-comment)
    comment_note = ""
    if pr_url and not getattr(args, "no_issue_comment", False):
        ok_c2, _, err_c2 = gh_run(repo, ["issue", "comment", number, "--body", f"🚢 PR entregue — {pr_url}"], timeout=30)
        result["commented"] = ok_c2 == 0
        if ok_c2 != 0:
            comment_note = f" (comentário do PR falhou: {(err_c2 or '').strip()[:150]})"

    # 3. FECHAR a issue — sucesso só é declarado se o estado CLOSED for confirmado
    if issue.get("state") == "CLOSED":
        result["closed"] = True
        result["status"] = "ok"
        result["message"] = f"issue `#{number}` já estava fechada (idempotente){comment_note}{project_note}"
        return result
    code, out, err = gh_run(repo, ["issue", "close", number, "--reason", "completed"], timeout=30)
    if code != 0:
        result["status"] = "failed"
        result["message"] = f"falha ao fechar issue `#{number}`: {(out + err).strip()[:300]}"
        return result
    ok_v, data_v, _err = gh_json(repo, ["issue", "view", number, "--json", "state"], timeout=30)
    confirmed = ok_v and isinstance(data_v, dict) and data_v.get("state") == "CLOSED"
    if not confirmed:
        result["status"] = "failed"
        result["message"] = f"API não confirmou o fechamento da issue `#{number}` — encerramento não aplicado"
        return result
    result["closed"] = True
    result["status"] = "ok"
    result["message"] = f"issue `#{number}` fechada — `{issue.get('title', '')}`{comment_note}{project_note}"
    return result

def upsert_handoff_github(handoff_path: Path, result: dict[str, Any]) -> None:
    """Registra status do sync de issue GitHub no HANDOFF.md (marcadores GITHUB_REPORT, idempotente)."""
    icon = {"ok": "✅", "failed": "❌", "skipped": "⏭️", "dry_run": "🧪"}.get(result.get("status", ""), "❔")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    issue_disp = f"`#{result.get('issue')}`" if result.get("issue") else "—"
    url_disp = f" ({result['issue_url']})" if result.get("issue_url") else ""
    project_disp = (f"`{result.get('project')}` → Status `{result.get('project_status')}`" if result.get("project_status")
                    else (f"`{result.get('project')}` (status não movido)" if result.get("project") else "—"))
    lines = [
        GITHUB_HANDOFF_START,
        f"## GitHub issue sync (hook shipper) — {now}",
        "",
        f"- **Status:** {icon} `{result.get('status')}` | closed: `{result.get('closed')}` | commented: `{result.get('commented')}`",
        f"- **Issue:** {issue_disp}{url_disp} — {result.get('issue_title') or '—'}",
        f"- **Project:** {project_disp}",
        f"- **Detalhe:** {sanitize_url_text(str(result.get('message', '')))}",
    ]
    if result.get("status") == "failed":
        if result.get("auth_required"):
            lines.append("- **Ação (auth):** rode `gh auth login` e reexecute `python3 hooks/shipper.py --run --repo .`")
        else:
            lines.append("- **Ação (fallback):** acionar `task shipper` (minimal) com a skill `github-cli` OBRIGATORIAMENTE carregada antes de operar (via `find-skills`, query `github issues`) para localizar a issue (ex.: `python3 skills/github-cli/scripts/sdd_backlog.py find-issue \"<título>\"`) e encerrá-la (`close-issue <n> --comment \"🚢 PR entregue — <url>\"`); falha registrada em `.planning/HOOKS.log` (campo `github`) e neste bloco — nunca encerrar o gate com sync falho silencioso")
    lines.append(GITHUB_HANDOFF_END)
    block = "\n".join(lines)
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        existing = read_text(handoff_path)
        # remove blocos GITHUB_REPORT existentes (todos) e reaproveita o resto do documento
        base = existing
        if GITHUB_HANDOFF_START in base or GITHUB_HANDOFF_END in base:
            base = strip_marker_blocks(existing)
            base = base.replace(GITHUB_HANDOFF_START, "").replace(GITHUB_HANDOFF_END, "")
        base = base.rstrip()
        new_content = (base + "\n\n" if base else "") + block + "\n"
        handoff_path.write_text(new_content, encoding="utf-8")
    except Exception as e:
        print(f"⚠️ Falha ao registrar GITHUB_REPORT em {handoff_path}: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Hook shipper determinístico — git/PR/STATE/HANDOFF/Issues GitHub")
    parser.add_argument("--run", action="store_true", help="Executa fluxo completo")
    parser.add_argument("--repo", default=".", help="Caminho do repo")
    parser.add_argument("--repo-slug", default=os.environ.get("SHIPPER_REPO", "tuliomourarocha/module-sdd-commons"), help="Slug GitHub para PR")
    parser.add_argument("--dry-run", action="store_true", help="Não faz commit/push/PR, só gera STATE/HANDOFF")
    parser.add_argument("--context-file", default="", help="Arquivo JSON com PRD/PLAN + resumo/parecer em memória (opcional) — nunca SUMMARY/REVIEW/VALIDATION como arquivos")
    parser.add_argument("--commit-msg", default="", help="Mensagem de commit conventional (se vazio, gera automático)")
    parser.add_argument("--pr-title", default="", help="Título do PR (se vazio, usa commit msg)")
    parser.add_argument("--pr-base", default=os.environ.get("SDD_PR_BASE", "develop"), help="Branch de base do PR (default `develop` — nunca main; sobrescreve via SDD_PR_BASE)")
    parser.add_argument("--fail-on-ci", action="store_true", help="Exit 2 se CI falhar")
    parser.add_argument("--handoff-out", default="", help="Caminho para HANDOFF.md (default .planning/HANDOFF.md)")
    parser.add_argument("--state-out", default="", help="Caminho para STATE.md (default .planning/STATE.md)")
    parser.add_argument("--issue", default="", help="Número ou URL da issue GitHub a encerrar (sobrescreve env/contexto; vazio = auto: `Closes #N` do PR ou prefixo numérico do branch)")
    parser.add_argument("--project", default="", help="GitHub Project (título/número/URL) para mover Status → Done (default env SDD_GITHUB_PROJECT)")
    parser.add_argument("--no-issue-comment", action="store_true", help="Não comentar link do PR na issue")
    parser.add_argument("--fail-on-issue", action="store_true", help="Exit 2 se sync de issue falhar (por padrão falha é visível mas não bloqueante)")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists() and (Path.cwd() / ".git").exists():
        repo = Path.cwd().resolve()

    if not git_available(repo):
        print(f"⚠️ Não é repo git: {repo}", file=sys.stderr)
        sys.exit(1)

    git_info = get_git_status(repo)
    context = load_context(args.context_file) if args.context_file else {}

    # commit message
    commit_msg = args.commit_msg.strip()
    if not commit_msg:
        # tenta inferir de context ou diff
        if context.get("commit") or context.get("message"):
            commit_msg = (context.get("commit") or context.get("message")).strip()
        else:
            # heurística: feat se feature, fix se bugfix no state, chore fallback
            branch = git_info.get("branch", "main")
            prefix = "feat"
            if "fix" in branch.lower() or "bugfix" in str(context).lower():
                prefix = "fix"
            files = ", ".join(git_info.get("diff_names", [])[:3])
            commit_msg = f"{prefix}: entrega via shipper hook ({branch}) — {files[:120]}" if files else f"{prefix}: entrega via shipper hook ({branch})"

    ensure_planning_dir(repo)
    handoff_path = Path(args.handoff_out) if args.handoff_out else repo / ".planning" / "HANDOFF.md"
    state_path = Path(args.state_out) if args.state_out else repo / ".planning" / "STATE.md"

    # 0. Base do PR (develop) + branch de trabalho criada a partir de origin/<base> ATUALIZADA
    pr_base, pr_base_note = determine_pr_base(repo, args.pr_base)
    if pr_base_note:
        print(f"⚠️ PR base: {pr_base_note}")
    branch_prep = prepare_feature_branch(repo, pr_base, commit_msg, args.dry_run)
    for note in branch_prep["notes"]:
        print(f"ℹ️ Branch: {note}")
    if branch_prep["created"]:
        print(f"✅ Branch: `{branch_prep['branch']}` criada de `origin/{pr_base}` (atualizada)")
    if branch_prep["branch"] != git_info.get("branch"):
        git_info = get_git_status(repo)  # branch mudou — recarregar status/diff

    # 1. Git commit
    commit_ok, commit_msg_out = do_git_commit(repo, commit_msg, args.dry_run)
    print(f"{'✅' if commit_ok else '❌'} Git commit: {commit_msg_out}")

    # 2. Push
    push_ok, push_out = do_git_push(repo, git_info.get("branch", pr_base), args.dry_run)
    print(f"{'✅' if push_ok else '⚠️'} Git push: {push_out}")

    # 3. Gera HANDOFF e STATE (sempre, mesmo se git falhou)
    handoff_md = generate_handoff(repo, git_info, context, args, branch_prep)
    state_pr_url = None  # será preenchido após PR
    # escreve HANDOFF temporário para usar como body do PR
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        handoff_path.write_text(handoff_md, encoding="utf-8")
        print(f"✅ HANDOFF.md: {handoff_path} ({len(handoff_md)} chars)")
    except Exception as e:
        print(f"❌ Falha ao escrever HANDOFF.md: {e}", file=sys.stderr)
        sys.exit(1)

    # 4. PR — explícito para a base develop (`--base develop --head <branch>`), nunca para main
    pr_title = args.pr_title.strip() or commit_msg.split("\n")[0][:80]
    pr_ok, pr_out, pr_url = do_gh_pr(repo, pr_title, handoff_path, git_info.get("branch", pr_base), pr_base, args.dry_run)
    print(f"{'✅' if pr_ok else '⚠️'} PR ({pr_base} ← {git_info.get('branch', pr_base)}): {pr_out}")
    if pr_url:
        state_pr_url = pr_url

    # 5. Issue GitHub — sync real ANTES do STATE (status precisa aparecer em STATE/HANDOFF/HOOKS.log)
    github = do_github_sync(repo, pr_url, args.dry_run, args, context=context, git_info=git_info)
    gh_status = github.get("status", "skipped")
    if gh_status == "ok":
        print(f"✅ Issue GitHub: GITHUB_SYNC_OK — {github['message']}")
    elif gh_status == "failed":
        print(f"❌ Issue GitHub: GITHUB_SYNC_FAILED — {github['message']}")
        if github.get("auth_required"):
            print("   ↪ AUTH requerido: rode `gh auth login`, depois reexecute o shipper")
        else:
            print("   ↪ fallback requerido: harness deve acionar `task shipper` (minimal) com a skill `github-cli` carregada primeiro (via find-skills) para localizar a issue e fechá-la (CLI `skills/github-cli/scripts/sdd_backlog.py close-issue`); falha registrada em HANDOFF.md#GITHUB_REPORT e .planning/HOOKS.log (campo github)")
    elif gh_status == "dry_run":
        print(f"🧪 Issue GitHub: {github['message']}")
    else:
        print(f"⏭️ Issue GitHub: {github['message']}")
    upsert_handoff_github(handoff_path, github)

    # 6. STATE.md (agora com PR url e status GitHub)
    state_md = generate_state(repo, git_info, context, args, state_pr_url, github, branch_prep)
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(state_md, encoding="utf-8")
        print(f"✅ STATE.md: {state_path} ({len(state_md)} chars)")
    except Exception as e:
        print(f"❌ Falha ao escrever STATE.md: {e}", file=sys.stderr)
        sys.exit(1)

    # 7. CI check
    ci_pass, ci_out = do_ci_check(repo, args.dry_run)
    ci_label = "pass" if ci_pass else "fail" if ci_pass is False else "unknown"
    print(f"CI check [{ci_label}]: {ci_out[:600]}")

    # Resumo
    print("\n" + "="*60)
    print(f"🚢 Shipper hook — branch {git_info.get('branch')} (base {pr_base}) — dry-run={args.dry_run}")
    print(f"  commit: {'ok' if commit_ok else 'fail'} | push: {'ok' if push_ok else 'fail'} | PR ({pr_base}): {'ok' if pr_ok else 'fail'} | CI: {ci_label} | Issue: {gh_status}")
    print(f"  HANDOFF: {handoff_path}")
    print(f"  STATE: {state_path}")
    print("="*60)

    # ── Log de garantia (prova que hook shipper foi chamado) ──
    try:
        import datetime

        status = "success" if commit_ok and pr_ok else "critical" if not commit_ok else "warn"
        if args.fail_on_ci and ci_pass is False:
            status = "critical"
        if gh_status == "failed" and status == "success":
            status = "warn"  # Issue falhou — visível como warn (fallback requerido), crítico só com --fail-on-issue
        entry = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "hook": "shipper",
            "trigger": "python:shipper.py",
            "branch": git_info.get("branch"),
            "pr_base": pr_base,
            "branch_created": branch_prep.get("created"),
            "dry_run": args.dry_run,
            "commit_ok": commit_ok,
            "push_ok": push_ok,
            "pr_ok": pr_ok,
            "pr_url": pr_url,
            "ci": ci_label,
            "github": {
                "status": gh_status,
                "closed": github.get("closed"),
                "commented": github.get("commented"),
                "issue": github.get("issue"),
                "issue_url": github.get("issue_url"),
                "project": github.get("project"),
                "project_status": github.get("project_status"),
                "auth_required": github.get("auth_required"),
                "message": sanitize_url_text(str(github.get("message", "")))[:400],
            },
            "status": status,
            "handoff": str(handoff_path),
            "state": str(state_path),
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
        print(f"📝 Log garantia: .planning/HOOKS.log (status={status})")
    except Exception:
        pass

    # Exit codes
    if not commit_ok:
        sys.exit(2)
    if args.fail_on_ci and ci_pass is False:
        sys.exit(2)
    if args.fail_on_issue and gh_status == "failed":
        sys.exit(2)
    if not pr_ok and not args.dry_run and gh_available():
        if "não autenticado" in pr_out.lower() or "not authenticated" in pr_out.lower():
            sys.exit(0)
        sys.exit(2)
    sys.exit(0)

if __name__ == "__main__":
    main()
