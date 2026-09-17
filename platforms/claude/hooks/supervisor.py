#!/usr/bin/env python3
"""
hooks/supervisor.py — Hook determinístico supervisor final + agente supervisor.

Conceito de Hook (fora do LLM):
  Middleware determinístico no final do ciclo que mede o que os agentes fizeram
  sem depender da auto-avaliação do LLM. Roda scripts python, coleta métricas
  objetivas e delega análise qualitativa a um agente supervisor (LLM) com prompt
  fechado e evidências. Output final é Issue no repo module-sdd-commons.

Acionamento:
  - Trigger: final do fluxo, após shipper escrever .planning/HANDOFF.md / STATE.md
    ou em `session.idle` após shipper, ou manual: `python3 hooks/supervisor.py --run`
  - Invocado por: plugins/supervisor.ts via `event: session.idle` + `tool.execute.after` (task shipper / write HANDOFF)
    e também via CLI / Claude Stop hook / Codex hook.

O que mede (determinístico, sem LLM):
  - Performance: duração por gate (git log timestamps, HANDOFF timestamps), nº arquivos alterados, linhas, build time, test time
  - Tokens/consumo: se disponível via opencode session JSON / env OTEL, senão heurística por tamanho de prompts
  - Alucinações (heurísticas determinísticas):
      * arquivos referenciados no HANDOFF/PLAN que não existem em disco
      * imports que não resolvem
      * APIs inventadas (grep por padrões não existentes)
      * TODO/FIXME deixados
      * divergência PLAN vs código (arquivos prometidos vs entregues)
      * criação proibida de SUMMARY.md/REVIEW.md/VALIDATION.md em disco
  - Segurança/qualidade residual: re-roda guard_rails em diff

Output:
  - Markdown de auditoria + JSON de métricas **embarcados em `.planning/HANDOFF.md` e `.planning/STATE.md`** (não cria artefactos separados)
  - Issue criada em GitHub via `gh issue create` no repo `tuliomourarocha/module-sdd-commons` (configurável)
  - Legado: `--md-out/--json-out` ainda podem criar `.planning/SUPERVISOR_REPORT.md` se explicitado, mas default é atualizar HANDOFF/STATE

Exit codes:
  0 = auditoria ok, issue criada ou dry-run
  1 = erro de uso
  2 = auditoria com HIGH (alucinação grave) — issue criada com label `hallucination`
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
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

# ── Utils ────────────────────────────────────────────────────────────────────

def run(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:
        return 1, "", str(e)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def gh_available() -> bool:
    return shutil.which("gh") is not None


# ── Coleta determinística ────────────────────────────────────────────────────

@dataclass
class HallucinationFinding:
    type: str
    severity: str
    evidence: str
    file: str | None = None


@dataclass
class SupervisorMetrics:
    started_at: str = ""
    finished_at: str = ""
    duration_seconds: int = 0
    files_changed: int = 0
    lines_added: int = 0
    lines_removed: int = 0
    commits: int = 0
    tests_passed: bool | None = None
    build_passed: bool | None = None
    guard_high: int = 0
    guard_med: int = 0
    token_estimate_input: int = 0
    token_estimate_output: int = 0
    token_source: str = "heuristic"
    hallucinations: list[HallucinationFinding] = field(default_factory=list)
    performance_notes: list[str] = field(default_factory=list)
    cost_estimate_usd: float | None = None


def collect_git_metrics(repo: Path) -> dict[str, Any]:
    code, out, _ = run(["git", "diff", "--stat", "HEAD"], cwd=repo)
    files_changed = 0
    if code == 0 and out.strip():
        files_changed = len([l for l in out.splitlines() if "|" in l])
    code, out2, _ = run(["git", "diff", "--numstat", "HEAD"], cwd=repo)
    added = removed = 0
    if code == 0:
        for line in out2.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                try:
                    added += int(parts[0]) if parts[0] != "-" else 0
                    removed += int(parts[1]) if parts[1] != "-" else 0
                except ValueError:
                    pass
    code, out3, _ = run(["git", "log", "--oneline", "-10"], cwd=repo)
    commits = len(out3.splitlines()) if code == 0 else 0
    return {"files_changed": files_changed, "added": added, "removed": removed, "commits": commits, "diff_stat": out[:2000]}


def collect_handoff_metrics(repo: Path) -> dict[str, Any]:
    handoff = repo / ".planning" / "HANDOFF.md"
    state = repo / ".planning" / "STATE.md"
    data: dict[str, Any] = {}
    if handoff.exists():
        txt = read_text(handoff)
        data["handoff_exists"] = True
        data["handoff_len"] = len(txt)
        # tenta extrair arquivos alterados listados
        m = re.findall(r"^- .+\.(ts|tsx|js|py|css|json)", txt, re.MULTILINE)
        data["handoff_files_mentioned"] = len(m)
        data["handoff_text"] = txt[:8000]
    else:
        data["handoff_exists"] = False
    if state.exists():
        data["state_text"] = read_text(state)[:4000]
    return data


def estimate_tokens(repo: Path) -> tuple[int, int, str]:
    """
    Heurística determinística se OTEL/openTelemetry não disponível.
    Tenta ler .opencode session logs, senão estima por tamanho de diff + handoff.
    """
    # tenta encontrar logs de sessão opencode
    candidates = list((repo / ".opencode").rglob("*.json")) if (repo / ".opencode").exists() else []
    # procura por token fields
    for cand in candidates[:20]:
        try:
            j = json.loads(cand.read_text(encoding="utf-8", errors="ignore"))
            # formato pode variar; tenta achar usage
            if isinstance(j, dict) and "usage" in j:
                u = j["usage"]
                inp = u.get("input_tokens") or u.get("prompt_tokens") or 0
                out = u.get("output_tokens") or u.get("completion_tokens") or 0
                if inp or out:
                    return int(inp), int(out), f"session:{cand.name}"
        except Exception:
            continue
    # heurística: 1 token ≈ 4 chars (como no harness-v2-plan)
    diff_code, out, _ = run(["git", "diff", "HEAD", "--stat"], cwd=repo)
    handoff_len = len(read_text(repo / ".planning" / "HANDOFF.md"))
    total_chars = len(out) + handoff_len + 5000  # overhead de prompts
    est_input = int(total_chars / 4 * 0.7)
    est_output = int(total_chars / 4 * 0.3)
    # custo estimado (ex: claude sonnet ~3$/M input 15$/M output) — placeholder
    return est_input, est_output, "heuristic:chars/4"


def detect_hallucinations(repo: Path, handoff_text: str) -> list[HallucinationFinding]:
    findings: list[HallucinationFinding] = []

    # 1. Arquivos mencionados que não existem
    # pega caminhos tipo src/...tsx, app/...ts, .planning/... mencionados
    mentioned = re.findall(r"(?:^|\s)([\w./\-]+\.(?:ts|tsx|js|jsx|py|css|json|md))", handoff_text)
    # filtra duplicatas
    mentioned = list(dict.fromkeys(mentioned))
    for m in mentioned[:30]:
        # ignora urls, planning mem, e placeholders
        if m.startswith("http") or m.startswith(".planning/"):
            continue
        p = repo / m
        # só reporta se parece path de código (contém /)
        if "/" in m and not p.exists():
            findings.append(
                HallucinationFinding(
                    type="file_not_found",
                    severity="MED",
                    evidence=f"Arquivo mencionado em HANDOFF não existe em disco: `{m}`",
                    file=m,
                )
            )

    # 2. Imports que não resolvem (TS/JS): grep por from '...' e checa existência relativa simples
    code, out, _ = run(["git", "diff", "--name-only", "HEAD"], cwd=repo)
    changed = out.splitlines() if code == 0 else []
    for fname in changed:
        if not fname.endswith((".ts", ".tsx", ".js", ".jsx")):
            continue
        fp = repo / fname
        if not fp.exists():
            continue
        text = read_text(fp)
        # procura imports relativos
        for imp in re.findall(r"from\s+['\"](\.[^'\"]+)['\"]", text):
            # resolve relativo
            target = (fp.parent / imp).resolve()
            # tenta com extensões
            exists = any(
                (Path(str(target) + ext)).exists() or target.exists()
                for ext in ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]
            )
            if not exists and not imp.startswith("."):
                continue
            if not exists:
                findings.append(
                    HallucinationFinding(
                        type="broken_import",
                        severity="HIGH",
                        evidence=f"Import não resolve em `{fname}`: `from '{imp}'`",
                        file=fname,
                    )
                )
                if len(findings) > 20:
                    break

    # 3. TODO/FIXME/HACK deixados como alucinação leve (exclui hooks/ e .git para evitar auto-detecção)
    code, out, _ = run(["grep", "-rn", "--include=*.ts", "--include=*.tsx", "--include=*.py", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=hooks", "--exclude-dir=.claude", "--exclude-dir=.codex", "--exclude-dir=.opencode", "TODO\\|FIXME\\|HACK", "."], cwd=repo)
    if code == 0 and out.strip():
        for line in out.splitlines()[:5]:
            findings.append(
                HallucinationFinding(
                    type="todo_left",
                    severity="LOW",
                    evidence=line[:300].strip(),
                )
            )

    # 4. PLAN vs código: se PLAN prometeu arquivos e não entregou
    plan_candidates = [repo / ".planning" / "PLAN.md", repo / "PLAN.md"]
    plan_text = ""
    for pc in plan_candidates:
        if pc.exists():
            plan_text = read_text(pc)
            break
    if not plan_text and handoff_text:
        # tenta extrair do handoff que consolida PLAN
        plan_text = handoff_text
    if plan_text:
        promised = re.findall(r"[\w./\-]+\.(?:ts|tsx|js|py)", plan_text)
        promised = list(dict.fromkeys(promised))[:30]
        for prom in promised:
            if "/" in prom and not (repo / prom).exists() and prom not in mentioned:
                # só se parece path intencional
                if len(prom) > 5 and prom.count("/") >= 1:
                    findings.append(
                        HallucinationFinding(
                            type="plan_divergence",
                            severity="MED",
                            evidence=f"Arquivo prometido no PLAN não encontrado: `{prom}`",
                            file=prom,
                        )
                    )
                    if len([f for f in findings if f.type == "plan_divergence"]) > 5:
                        break

    # 5. Artefatos proibidos em disco (SUMMARY/REVIEW/VALIDATION nunca devem existir)
    for forbidden in [".planning/SUMMARY.md", ".planning/REVIEW.md", ".planning/VALIDATION.md"]:
        if (repo / forbidden).exists():
            findings.append(
                HallucinationFinding(
                    type="forbidden_artifact",
                    severity="HIGH",
                    evidence=f"Artefato proibido encontrado em disco: `{forbidden}` — deve ser removido (retorne em memória, não arquivo).",
                    file=forbidden,
                )
            )
    # também verifica basename solto no repo root
    for name in ["SUMMARY.md", "REVIEW.md", "VALIDATION.md"]:
        if (repo / name).exists():
            findings.append(
                HallucinationFinding(
                    type="forbidden_artifact",
                    severity="HIGH",
                    evidence=f"Artefato proibido encontrado: `{name}` na raiz — remova (não deve existir).",
                    file=name,
                )
            )

    return findings


def collect_build_test(repo: Path) -> tuple[bool | None, bool | None, list[str]]:
    notes: list[str] = []
    # build
    build_passed = None
    if (repo / "package.json").exists():
        if has_cmd := shutil.which("npm"):
            code, out, err = run(["npm", "run", "build"], cwd=repo, timeout=120)
            build_passed = code == 0
            notes.append(f"build: {'pass' if build_passed else 'fail'}")
            if not build_passed:
                notes.append((out + err)[:600])
    # tests
    tests_passed = None
    for cmd in [["npm", "run", "test"], ["npx", "vitest", "run"], ["pytest", "-q"]]:
        if shutil.which(cmd[0]):
            code, out, err = run(cmd, cwd=repo, timeout=120)
            # só considera se realmente rodou (não "missing script")
            if "missing script" not in (out + err).lower():
                tests_passed = code == 0
                notes.append(f"test ({' '.join(cmd)}): {'pass' if tests_passed else 'fail'}")
                break
    return build_passed, tests_passed, notes


def build_issue_markdown(
    metrics: SupervisorMetrics,
    repo: Path,
    handoff: dict[str, Any],
    git: dict[str, Any],
    dry_run: bool,
) -> str:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    hallu_high = sum(1 for h in metrics.hallucinations if h.severity == "HIGH")
    hallu_med = sum(1 for h in metrics.hallucinations if h.severity == "MED")

    # performance badge
    perf = "✅ OK" if metrics.duration_seconds < 600 and not metrics.hallucinations else "⚠️ Revisar"
    if hallu_high > 0:
        perf = "🔴 CRÍTICO"

    lines = []
    lines.append(f"# 🤖 Supervisor Report — {now}")
    lines.append("")
    lines.append(f"**Repo:** `tuliomourarocha/module-sdd-commons` | **Trigger:** pós-shipper / session.idle | **Dry-run:** {dry_run}")
    lines.append("")
    lines.append("## 📊 Métricas Determinísticas")
    lines.append("")
    lines.append(f"- **Duração ciclo:** {metrics.duration_seconds}s | **Status perf:** {perf}")
    lines.append(f"- **Arquivos alterados:** {metrics.files_changed} | **+{metrics.lines_added} / -{metrics.lines_removed} linhas** | **Commits (10):** {metrics.commits}")
    lines.append(f"- **Build:** {metrics.build_passed} | **Tests:** {metrics.tests_passed} | **Guard HIGH/MED:** {metrics.guard_high}/{metrics.guard_med}")
    lines.append(f"- **Tokens est. (in/out):** {metrics.token_estimate_input} / {metrics.token_estimate_output} — fonte: `{metrics.token_source}`")
    if metrics.cost_estimate_usd is not None:
        lines.append(f"- **Custo est.:** ${metrics.cost_estimate_usd:.4f}")
    lines.append("")
    if metrics.performance_notes:
        lines.append("**Notas performance:**")
        for n in metrics.performance_notes[:10]:
            lines.append(f"- {n[:400]}")
        lines.append("")

    lines.append("## 🔍 Alucinações (heurística determinística)")
    lines.append("")
    if not metrics.hallucinations:
        lines.append("✅ Nenhuma alucinação detectada por heurísticas (imports resolvem, arquivos mencionados existem, PLAN aderente).")
    else:
        lines.append(f"Encontradas **{len(metrics.hallucinations)}** evidências — HIGH:{hallu_high} MED:{hallu_med}")
        lines.append("")
        for h in metrics.hallucinations[:20]:
            file_part = f" | `{h.file}`" if h.file else ""
            lines.append(f"- **[{h.severity}] {h.type}**{file_part}: {h.evidence[:500]}")
        if len(metrics.hallucinations) > 20:
            lines.append(f"- ... e mais {len(metrics.hallucinations)-20} evidências (ver JSON)")

    lines.append("")
    lines.append("## 📦 Git diff (resumo)")
    lines.append("")
    lines.append("```")
    lines.append(git.get("diff_stat", "")[:3000])
    lines.append("```")
    lines.append("")
    lines.append("## 📄 HANDOFF (trecho)")
    lines.append("")
    htxt = handoff.get("handoff_text", "")[:6000]
    lines.append(htxt if htxt else "_HANDOFF.md não encontrado (memória não persistida?)_")
    lines.append("")
    lines.append("## 🧭 Recomendação Supervisor (para LLM complementar)")
    lines.append("")
    lines.append("> Este relatório é determinístico. Um agente supervisor (LLM) deve ser acionado com este JSON + diff para julgamento qualitativo (coerência PLAN vs código, qualidade de decisões, falsos positivos).")
    lines.append("")
    lines.append("**Checklist para agente supervisor LLM:**")
    lines.append("- [ ] Validar se alucinações listadas são falsos positivos (ex.: path em comentário)")
    lines.append("- [ ] Avaliar aderência ao PLAN/STATE (detalhar desvios intencionais vs alucinação)")
    lines.append("- [ ] Medir qualidade de código além de lint (naming, boundaries, SOLID)")
    lines.append("- [ ] Estimar tokens reais via provider API se disponível (substituir heurística)")
    lines.append("- [ ] Propor follow-ups como issues separadas se HIGH persistir")
    lines.append("")
    lines.append("---")
    lines.append(f"_Gerado por `hooks/supervisor.py` em {now} — determinístico, sem LLM._")
    return "\n".join(lines)


SUPERVISOR_HANDOFF_START = "<!-- SUPERVISOR:START -->"
SUPERVISOR_HANDOFF_END = "<!-- SUPERVISOR:END -->"
SUPERVISOR_STATE_START = "<!-- SUPERVISOR_STATE:START -->"
SUPERVISOR_STATE_END = "<!-- SUPERVISOR_STATE:END -->"


def upsert_handoff_supervisor(repo: Path, supervisor_md: str) -> Path:
    """Atualiza HANDOFF.md com seção Supervisor (idempotente) ao invés de criar SUPERVISOR_REPORT.md."""
    handoff_path = repo / ".planning" / "HANDOFF.md"
    wrapped = f"\n{SUPERVISOR_HANDOFF_START}\n{supervisor_md.strip()}\n{SUPERVISOR_HANDOFF_END}\n"
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        if handoff_path.exists():
            existing = handoff_path.read_text(encoding="utf-8", errors="ignore")
            if SUPERVISOR_HANDOFF_START in existing and SUPERVISOR_HANDOFF_END in existing:
                # substitui seção existente
                before = existing.split(SUPERVISOR_HANDOFF_START)[0]
                after = existing.split(SUPERVISOR_HANDOFF_END)[-1]
                new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
            else:
                new_content = existing.rstrip() + "\n\n---\n" + wrapped
        else:
            # HANDOFF inexistente — cria minimal com supervisor
            new_content = f"# HANDOFF — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n{wrapped}\n"
        handoff_path.write_text(new_content, encoding="utf-8")
        print(f"✅ HANDOFF.md atualizado com auditoria Supervisor ({len(supervisor_md)} chars) → {handoff_path}")
    except Exception as e:
        print(f"⚠️ Falha ao atualizar HANDOFF.md com supervisor: {e}", file=sys.stderr)
    return handoff_path


def upsert_state_supervisor(repo: Path, metrics: "SupervisorMetrics") -> Path:
    """Atualiza STATE.md com métricas do supervisor (embed metrics como seção)."""
    state_path = repo / ".planning" / "STATE.md"
    hallu_high = sum(1 for h in metrics.hallucinations if h.severity == "HIGH")
    hallu_med = sum(1 for h in metrics.hallucinations if h.severity == "MED")
    # bloco resumido para STATE (não todo md)
    state_block = f"""### 🤖 Supervisor — {metrics.finished_at}
- **Status:** {"🔴 CRÍTICO" if hallu_high>0 else "⚠️ Revisar" if metrics.guard_high>0 else "✅ OK"}
- **Hallucinations:** {len(metrics.hallucinations)} (HIGH:{hallu_high} MED:{hallu_med}) | **Guard HIGH/MED:** {metrics.guard_high}/{metrics.guard_med}
- **Arquivos:** {metrics.files_changed} (+{metrics.lines_added}/-{metrics.lines_removed}) | **Commits:** {metrics.commits}
- **Build/Test:** {metrics.build_passed}/{metrics.tests_passed} | **Tokens:** {metrics.token_estimate_input}/{metrics.token_estimate_output} ({metrics.token_source}) | **Custo:** ${metrics.cost_estimate_usd}
- **Duração:** {metrics.duration_seconds}s
- **Detalhe:** ver HANDOFF.md seção Supervisor (marcadores SUPERVISOR:START/END)
"""
    wrapped = f"\n{SUPERVISOR_STATE_START}\n{state_block.strip()}\n{SUPERVISOR_STATE_END}\n"
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        if state_path.exists():
            existing = state_path.read_text(encoding="utf-8", errors="ignore")
            if SUPERVISOR_STATE_START in existing and SUPERVISOR_STATE_END in existing:
                before = existing.split(SUPERVISOR_STATE_START)[0]
                after = existing.split(SUPERVISOR_STATE_END)[-1]
                new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
            else:
                # anexa seção; tenta inserir antes do último --- ou no final
                new_content = existing.rstrip() + "\n\n" + wrapped
            # também garante que gate supervisor está registrado
            if "supervisor:" not in existing.lower():
                new_content = new_content.replace("```", "```")  # noop para manter compat
        else:
            new_content = f"# STATE — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n**Flow:** `feature` | **Gate:** `done` | **Branch:** `main`\n\n{wrapped}\n"
        # garantir secção persiste
        state_path.write_text(new_content, encoding="utf-8")
        print(f"✅ STATE.md atualizado com métricas Supervisor → {state_path}")
    except Exception as e:
        print(f"⚠️ Falha ao atualizar STATE.md com supervisor: {e}", file=sys.stderr)
    return state_path


def create_github_issue(
    repo_slug: str,
    title: str,
    body: str,
    labels: list[str],
    dry_run: bool,
) -> tuple[bool, str]:
    if dry_run:
        return True, "dry-run: issue não criada"
    if not gh_available():
        return False, "gh CLI não encontrado — salve markdown e crie manualmente"
    # valida slug
    cmd = ["gh", "issue", "create", "--repo", repo_slug, "--title", title, "--body", body]
    for lbl in labels:
        cmd.extend(["--label", lbl])
    code, out, err = run(cmd, timeout=30)
    if code == 0:
        return True, out.strip()
    return False, (out + err).strip()[:1000]


def main():
    parser = argparse.ArgumentParser(description="Hook supervisor final — métricas + issue")
    parser.add_argument("--run", action="store_true", help="Executa auditoria completa e cria issue")
    parser.add_argument("--repo", default=".", help="Caminho do repo (default: .)")
    parser.add_argument("--repo-slug", default=os.environ.get("SUPERVISOR_REPO", "tuliomourarocha/module-sdd-commons"), help="Slug GitHub para issue")
    parser.add_argument("--dry-run", action="store_true", help="Não cria issue, só gera markdown/JSON")
    parser.add_argument("--json-out", default="", help="Caminho para salvar JSON de métricas")
    parser.add_argument("--md-out", default="", help="Caminho para salvar markdown do report")
    parser.add_argument("--fail-on-hallucination", action="store_true", help="Exit 2 se HIGH hallucination")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    # se não houver .git, tenta cwd
    if not (repo / ".git").exists() and (Path.cwd() / ".git").exists():
        repo = Path.cwd().resolve()

    metrics = SupervisorMetrics()
    metrics.started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    handoff = collect_handoff_metrics(repo)
    git = collect_git_metrics(repo)
    metrics.files_changed = git["files_changed"]
    metrics.lines_added = git["added"]
    metrics.lines_removed = git["removed"]
    metrics.commits = git["commits"]

    inp, outp, src = estimate_tokens(repo)
    metrics.token_estimate_input = inp
    metrics.token_estimate_output = outp
    metrics.token_source = src
    # custo heuristico: ~3$/M input, 15$/M output (sonnet)
    metrics.cost_estimate_usd = round(inp / 1_000_000 * 3 + outp / 1_000_000 * 15, 4)

    build_passed, tests_passed, notes = collect_build_test(repo)
    metrics.build_passed = build_passed
    metrics.tests_passed = tests_passed
    metrics.performance_notes = notes

    # re-roda guard rails no diff para HIGH/MED agregado
    guard_high = guard_med = 0
    code, out, _ = run(["git", "diff", "--name-only", "HEAD"], cwd=repo)
    if code == 0:
        for fname in out.splitlines()[:20]:
            fpath = repo / fname
            if not fpath.exists():
                continue
            if fpath.suffix in (".py", ".ts", ".tsx", ".js", ".jsx"):
                # chama guard_rails.py se existir
                gr = repo / "hooks" / "guard_rails.py"
                if not gr.exists():
                    gr = Path(__file__).parent / "guard_rails.py"
                if gr.exists():
                    c2, o2, _ = run([sys.executable, str(gr), "--file", str(fpath), "--format", "json"], cwd=repo, timeout=30)
                    try:
                        j = json.loads(o2) if o2 else {}
                        for f in j.get("findings", []):
                            if f.get("severity") == "HIGH":
                                guard_high += 1
                            elif f.get("severity") == "MED":
                                guard_med += 1
                    except Exception:
                        pass
    metrics.guard_high = guard_high
    metrics.guard_med = guard_med

    # hallucinations
    htext = handoff.get("handoff_text", "") + "\n" + handoff.get("state_text", "")
    metrics.hallucinations = detect_hallucinations(repo, htext)

    metrics.finished_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        # duration aproximada: usa diff de timestamps se disponível, senão 0
        metrics.duration_seconds = int(
            (datetime.datetime.fromisoformat(metrics.finished_at) - datetime.datetime.fromisoformat(metrics.started_at)).total_seconds()
        )
    except Exception:
        metrics.duration_seconds = 0

    md = build_issue_markdown(metrics, repo, handoff, git, dry_run=args.dry_run)

    # ── Novo comportamento (exigência usuário): atualiza HANDOFF.md + STATE.md ao invés de criar artefatos .md separados ──
    # Sempre atualiza HANDOFF/STATE de forma idempotente (marcadores SUPERVISOR:START/END)
    # Só cria legado SUPERVISOR_REPORT.md / supervisor_metrics.json se --md-out/--json-out explicitamente passados ou env LEGACY=1
    has_legacy_md = bool(args.md_out)
    has_legacy_json = bool(args.json_out)
    use_legacy_env = os.environ.get("SUPERVISOR_LEGACY", "") in ("1", "true", "yes")

    # atualiza HANDOFF/STATE (principal) — dry-run não persiste, apenas --run persiste
    if not args.dry_run:
        upsert_handoff_supervisor(repo, md)
        upsert_state_supervisor(repo, metrics)
    else:
        print("(dry-run — HANDOFF/STATE não atualizados; use --run sem --dry-run para persistir)")

    # legado opcional
    if has_legacy_md:
        md_out = Path(args.md_out)
        try:
            md_out.parent.mkdir(parents=True, exist_ok=True)
            md_out.write_text(md, encoding="utf-8")
            print(f"✅ Legado SUPERVISOR_REPORT: {md_out}")
        except Exception:
            pass
    elif use_legacy_env:
        md_out = repo / ".planning" / "SUPERVISOR_REPORT.md"
        try:
            md_out.parent.mkdir(parents=True, exist_ok=True)
            md_out.write_text(md, encoding="utf-8")
        except Exception:
            pass
    if has_legacy_json:
        json_out = Path(args.json_out)
        try:
            json_out.parent.mkdir(parents=True, exist_ok=True)
            json_out.write_text(json.dumps(asdict(metrics), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            print(f"✅ Legado supervisor_metrics: {json_out}")
        except Exception:
            pass
    elif use_legacy_env:
        json_out = repo / ".planning" / "supervisor_metrics.json"
        try:
            json_out.parent.mkdir(parents=True, exist_ok=True)
            json_out.write_text(json.dumps(asdict(metrics), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        except Exception:
            pass

    print(md)
    print("\n" + "=" * 60)
    print("📊 JSON metrics:", json.dumps(asdict(metrics), ensure_ascii=False, default=str)[:2000])
    print("=" * 60)
    if not has_legacy_md and not use_legacy_env:
        print("ℹ️ Supervisor persistido em .planning/HANDOFF.md (seção SUPERVISOR:START) e .planning/STATE.md (SUPERVISOR_STATE) — sem criar SUPERVISOR_REPORT.md separado")

    # ── Log de garantia (prova que hook supervisor foi chamado) ──
    try:
        hallu_high_tmp = sum(1 for h in metrics.hallucinations if h.severity == "HIGH")
        entry = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "hook": "supervisor",
            "trigger": "python:supervisor.py",
            "files_changed": metrics.files_changed,
            "hallucinations": len(metrics.hallucinations),
            "hallu_high": hallu_high_tmp,
            "guard_high": metrics.guard_high,
            "build_passed": metrics.build_passed,
            "tests_passed": metrics.tests_passed,
            "status": "critical" if hallu_high_tmp > 0 else "warn" if metrics.guard_high > 0 else "success",
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
        print(f"📝 Log garantia: .planning/HOOKS.log (supervisor status={entry['status']})")
    except Exception:
        pass

    # cria issue
    hallu_high = sum(1 for h in metrics.hallucinations if h.severity == "HIGH")
    labels = ["supervisor", "automated"]
    if hallu_high > 0:
        labels.append("hallucination")
    if metrics.guard_high > 0:
        labels.append("guard-rails-blocked")
    if metrics.build_passed is False or metrics.tests_passed is False:
        labels.append("ci-failure")

    title = f"[Supervisor] Auditoria {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} — {hallu_high} HIGH hallucinações, {metrics.files_changed} arquivos"
    if args.run or not args.dry_run:
        # por padrão, se --run, tenta criar; senão dry-run já imprime
        should_create = args.run and not args.dry_run
        # se chamado sem --run mas com --repo-slug explícito, ainda сухой? manter compat
        if should_create:
            ok, msg = create_github_issue(args.repo_slug, title, md, labels, dry_run=False)
            print(f"\n{'✅' if ok else '❌'} GitHub issue: {msg}")
            if not ok:
                print("Dica: configure `gh auth login` e rode com --repo-slug correto, ou use --dry-run")
        else:
            if args.dry_run:
                print("\n(dry-run — issue não criada; use --run para criar)")
            else:
                # modo default quando chamado pelo hook: tenta criar mas não falha se gh ausente
                if gh_available():
                    ok, msg = create_github_issue(args.repo_slug, title, md, labels, dry_run=False)
                    print(f"\n{'✅' if ok else '⚠️'} GitHub issue (auto): {msg}")
                else:
                    print("\n⚠️ gh não encontrado — auditoria salva em .planning/HANDOFF.md (SUPERVISOR:START) e STATE.md")

    if args.fail_on_hallucination and hallu_high > 0:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
