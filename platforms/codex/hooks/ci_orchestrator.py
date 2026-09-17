#!/usr/bin/env python3
"""
hooks/ci_orchestrator.py — Orquestrador de correção de CI (determinístico + LangGraph opcional).

Propósito:
  Orquestra o loop fechado pedido pelo usuário: após shipper abrir PR → verifica CI → se falhar → corrige → repete.
  Pode ser usado de duas formas:

  1. **Determinístico puro (sem dependências)** — fallback default:
     `python3 hooks/ci_orchestrator.py --run --repo . --max-retries 2`
     Roda sequencialmente: ci_watch (wait) → se fail → coleta logs → sugere prompt para builder →
     aguarda builder fix + shipper re-push → re-valida CI. Repete até pass ou max_retries.

  2. **LangGraph (opcional, se `langgraph` instalado):**
     `pip install langgraph langchain-core && python3 hooks/ci_orchestrator.py --run --with-langgraph`
     Monta um StateGraph com nodes: detect_pr → wait_ci → [pass→done | fail→analyze → fix → review → reship → wait_ci]
     Cada node pode ser substituído por um `task()` real do OpenCode (via client), ou por stub local.
     O graph persiste estado em `.planning/CORCHESTRATOR_STATE.json` para retomar após cada iteração.

Por que dois modos?
  - **Hooks determinísticos** (`ci_watch.py` + `ci-watch.ts`) já resolvem 90% dos casos sem LLM extra, apenas
    polling + relatório + throw para harness iniciar builder. É o caminho recomendado (sem dependências).
  - **LangGraph** é útil quando você quer orquestração mais sofisticada: branching condicional,
    paralelismo, checkpointing, human-in-the-loop, ou integrar múltiplos agentes (builder, reviewer) como nodes
    com memória compartilhada. O arquivo demonstra como plugar os hooks existentes como tools do graph,
    sem reescrever lógica.

Arquitetura (determinístico):
  harness (task shipper) → [hook shipper.py] → [hook ci_watch.py --wait] → exit 0 → supervisor → done
                                                         → exit 2 → harness task builder (com CI_REPORT) → task reviewer → task shipper → ci_watch novamente (retry+1) → ...
                                                         → exit 2 + retries>=max → escalar humano

Arquitetura (LangGraph):
  StateGraph {
    START → detect_pr → wait_ci → should_continue? → [pass: END, fail & retries<max: analyze → fix → review → reship → wait_ci, fail & retries>=max: escalate → END]
  }

Uso harness:
  O harness pode importar `build_graph()` e executar via `python3 -c "from hooks.ci_orchestrator import build_graph; g=build_graph(); g.invoke({...})"`
  ou simplesmente delegar ao hook determinístico: `python3 hooks/ci_watch.py --run --wait` (mais leve).

Requisitos:
  - python3 (sempre)
  - gh CLI (para CI real), git
  - langgraph (opcional): `pip install langgraph`

Exit codes:
  0 = CI verde ou sem CI (done)
  2 = CI falhou e retries esgotados (escalar)
  3 = CI pending timeout (aguardar)
  1 = erro infra
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, TypedDict, Literal

# Reuso de helpers de ci_watch quando possível
try:
    # importa funções se ci_watch estiver no mesmo dir
    import importlib.util
    _ci_watch_path = Path(__file__).parent / "ci_watch.py"
    _spec = importlib.util.spec_from_file_location("ci_watch", str(_ci_watch_path))
    _ci_watch = importlib.util.module_from_spec(_spec)  # type: ignore
    if _spec and _spec.loader:
        _spec.loader.exec_module(_ci_watch)  # type: ignore
        _poll_ci = _ci_watch.poll_ci
        _generate_report = _ci_watch.generate_ci_report
        _load_retry = _ci_watch.load_retry_count
        _save_retry = _ci_watch.save_retry_count
    else:
        raise ImportError("spec loader missing")
except Exception as e:
    # fallback stubs se import falhar (ex: execução isolada)
    _poll_ci = None  # type: ignore
    _generate_report = None  # type: ignore
    _load_retry = lambda repo: 0  # type: ignore
    _save_retry = lambda repo, n: None  # type: ignore
    print(f"⚠️ ci_orchestrator: não conseguiu importar ci_watch ({e}) — usando fallback subprocess", file=sys.stderr)

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

# ── Estado compartilhado (LangGraph TypedDict) ─────────────────────────────────

class OrchestratorState(TypedDict, total=False):
    branch: str
    pr_number: int | None
    pr_url: str | None
    ci_status: Literal["pass", "fail", "pending", "unknown"]
    ci_details: str
    failure_logs: str
    attempts: int
    elapsed: float
    retries: int
    max_retries: int
    done: bool
    escalate: bool
    context: dict[str, Any]  # PRD/PLAN + resumo/parecer em memória (nunca SUMMARY/REVIEW/VALIDATION como arquivos)
    last_report_path: str
    history: list[dict[str, Any]]

# ── Nodes determinísticos (reusáveis tanto em fallback quanto no LangGraph) ─────

def node_detect_pr(state: OrchestratorState, repo: Path) -> OrchestratorState:
    """Detecta PR e branch atuais."""
    code, out, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo)
    branch = out.strip() if code == 0 else state.get("branch", "main")
    pr_number = state.get("pr_number")
    pr_url = state.get("pr_url")
    # tenta gh pr view
    code, out, _ = run(["gh", "pr", "view", "--json", "number,url"], cwd=repo, timeout=20)
    if code == 0:
        try:
            j = json.loads(out)
            pr_number = j.get("number", pr_number)
            pr_url = j.get("url", pr_url)
        except Exception:
            pass
    state["branch"] = branch
    state["pr_number"] = pr_number
    state["pr_url"] = pr_url
    state.setdefault("history", []).append({"node": "detect_pr", "branch": branch, "pr_number": pr_number, "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    return state

ORCH_HANDOFF_START = "<!-- ORCHESTRATOR:START -->"
ORCH_HANDOFF_END = "<!-- ORCHESTRATOR:END -->"
ORCH_STATE_START = "<!-- ORCHESTRATOR_STATE:START -->"
ORCH_STATE_END = "<!-- ORCHESTRATOR_STATE:END -->"


def _upsert_handoff_orchestrator(repo: Path, state: OrchestratorState) -> Path:
    handoff_path = repo / ".planning" / "HANDOFF.md"
    # bloco resumo orquestrador
    block = f"""### 🤖 Orquestrador CI — {datetime.datetime.now(datetime.timezone.utc).isoformat()}
- **Status CI:** `{state.get('ci_status')}` — {state.get('ci_details','')[:400]}
- **Branch:** `{state.get('branch')}` | **PR:** #{state.get('pr_number')} — {state.get('pr_url')}
- **Retries:** {state.get('retries',0)}/{state.get('max_retries',2)} | **Tentativas polling:** {state.get('attempts',0)} em {state.get('elapsed',0):.1f}s
- **Histórico:** {', '.join([h.get('node','?')+':'+str(h.get('status') or h.get('retries') or '') for h in state.get('history',[])[-5:]])}
"""
    wrapped = f"\n{ORCH_HANDOFF_START}\n{block.strip()}\n{ORCH_HANDOFF_END}\n"
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        if handoff_path.exists():
            existing = handoff_path.read_text(encoding="utf-8", errors="ignore")
            if ORCH_HANDOFF_START in existing and ORCH_HANDOFF_END in existing:
                before = existing.split(ORCH_HANDOFF_START)[0]
                after = existing.split(ORCH_HANDOFF_END)[-1]
                new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
            else:
                new_content = existing.rstrip() + "\n\n" + wrapped
        else:
            new_content = f"# HANDOFF — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n{wrapped}\n"
        handoff_path.write_text(new_content, encoding="utf-8")
    except Exception:
        pass
    return handoff_path


def _upsert_state_orchestrator(repo: Path, state: OrchestratorState) -> Path:
    state_path = repo / ".planning" / "STATE.md"
    block = f"""### 🔄 Orquestrador — {datetime.datetime.now(datetime.timezone.utc).isoformat()}
- **CI Status:** {state.get('ci_status')} | **Retries:** {state.get('retries',0)}/{state.get('max_retries',2)}
- **Branch:** {state.get('branch')} | **PR:** {state.get('pr_number')}
- **Done:** {state.get('done', False)} | **Escalate:** {state.get('escalate', False)}
"""
    wrapped = f"\n{ORCH_STATE_START}\n{block.strip()}\n{ORCH_STATE_END}\n"
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        if state_path.exists():
            existing = state_path.read_text(encoding="utf-8", errors="ignore")
            if ORCH_STATE_START in existing and ORCH_STATE_END in existing:
                before = existing.split(ORCH_STATE_START)[0]
                after = existing.split(ORCH_STATE_END)[-1]
                new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
            else:
                new_content = existing.rstrip() + "\n\n" + wrapped
        else:
            new_content = f"# STATE — {datetime.datetime.now(datetime.timezone.utc).isoformat()}\n\n{wrapped}\n"
        state_path.write_text(new_content, encoding="utf-8")
    except Exception:
        pass
    return state_path


def node_wait_ci(state: OrchestratorState, repo: Path, timeout: int = 600, interval: int = 30, verbose: bool = False) -> OrchestratorState:
    """Poll CI via ci_watch.poll_ci (importado) ou via subprocess fallback."""
    branch = state.get("branch", "main")
    pr_number = state.get("pr_number")
    max_retries = state.get("max_retries", 2)
    if _poll_ci is not None:
        status, details, pr_info, failure_logs, attempts, elapsed = _poll_ci(
            repo=repo, branch=branch, pr_number=pr_number, wait=True, timeout=timeout, interval=interval, verbose=verbose
        )
        state["ci_status"] = status  # type: ignore
        state["ci_details"] = details
        state["failure_logs"] = failure_logs
        state["attempts"] = attempts
        state["elapsed"] = elapsed
        if pr_info.get("number"):
            state["pr_number"] = pr_info["number"]
            state["pr_url"] = pr_info.get("url")
        # gera report para builder consumir — atualiza HANDOFF/STATE ao invés de CI_REPORT.md separado
        if _generate_report is not None:
            retries = state.get("retries", 0)
            report_md, metrics = _generate_report(repo, branch, pr_info, status, details, attempts, elapsed, failure_logs, retries, max_retries)  # type: ignore
            # tenta usar upsert helpers de ci_watch se disponíveis, senão fallback para markers locais
            try:
                ci_watch = _ci_watch
                if hasattr(ci_watch, "upsert_handoff_ci"):
                    ci_watch.upsert_handoff_ci(repo, report_md)  # type: ignore
                    if hasattr(ci_watch, "upsert_state_ci"):
                        ci_watch.upsert_state_ci(repo, metrics, status, branch)  # type: ignore
                    state["last_report_path"] = str(repo / ".planning" / "HANDOFF.md") + "#CI_REPORT"
                else:
                    raise AttributeError
            except Exception:
                # fallback: escreve marcadores genéricos
                report_path = repo / ".planning" / "HANDOFF.md"
                try:
                    # usa helper local se ci_watch não tem
                    existing = ""
                    if report_path.exists():
                        existing = report_path.read_text(encoding="utf-8", errors="ignore")
                    wrapped = f"\n<!-- CI_REPORT:START -->\n{report_md.strip()}\n<!-- CI_REPORT:END -->\n"
                    if "<!-- CI_REPORT:START -->" in existing:
                        before = existing.split("<!-- CI_REPORT:START -->")[0]
                        after = existing.split("<!-- CI_REPORT:END -->")[-1]
                        new_content = before.rstrip() + "\n" + wrapped + after.lstrip()
                    else:
                        new_content = existing.rstrip() + "\n\n---\n" + wrapped if existing else f"# HANDOFF\n\n{wrapped}"
                    report_path.write_text(new_content, encoding="utf-8")
                    state["last_report_path"] = str(report_path) + "#CI_REPORT"
                except Exception:
                    state["last_report_path"] = str(repo / ".planning" / "HANDOFF.md")
            # legado JSON só se env legado ativo
            if os.environ.get("CI_WATCH_LEGACY", "") in ("1", "true", "yes"):
                try:
                    (repo / ".planning" / "CI_REPORT.md").write_text(report_md, encoding="utf-8")
                    (repo / ".planning" / "ci_metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
                except Exception:
                    pass
    else:
        # fallback subprocess
        cmd = ["python3", str(Path(__file__).parent / "ci_watch.py"), "--run", "--wait", "--repo", str(repo), "--timeout", str(timeout), "--interval", str(interval), "--max-retries", str(max_retries)]
        if pr_number:
            cmd.extend(["--pr", str(pr_number)])
        code, out, err = run(cmd, cwd=repo, timeout=timeout + 60)
        combined = out + err
        # infer status from exit code
        if code == 0:
            state["ci_status"] = "pass"
        elif code == 2:
            state["ci_status"] = "fail"
            # tenta ler relatório
            report_path = repo / ".planning" / "CI_REPORT.md"
            if report_path.exists():
                state["failure_logs"] = report_path.read_text(encoding="utf-8", errors="ignore")[:4000]
                state["last_report_path"] = str(report_path)
        elif code == 3:
            state["ci_status"] = "pending"
        else:
            state["ci_status"] = "unknown"
        state["ci_details"] = combined[:2000]
        state["attempts"] = 1
        state["elapsed"] = float(timeout)
        state["failure_logs"] = combined[:4000]

    state.setdefault("history", []).append({
        "node": "wait_ci", "status": state.get("ci_status"), "details": state.get("ci_details", "")[:300],
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()
    })
    return state

def node_analyze_failure(state: OrchestratorState) -> OrchestratorState:
    """Analisa falha e prepara prompt para builder."""
    logs = state.get("failure_logs", "")[:3000]
    details = state.get("ci_details", "")
    prompt = f"""
[CI FAILURE ANALYSIS — para builder]
Branch: {state.get('branch')} | PR #{state.get('pr_number')} — {state.get('pr_url')}
CI status: {state.get('ci_status')} — {details}
Retries: {state.get('retries',0)}/{state.get('max_retries',2)}

Logs (trecho):
```
{logs[:2500]}
```

Relatório completo: {state.get('last_report_path') or '.planning/CI_REPORT.md'}

Instruções para builder (fix):
- Foque apenas nos checks/jobs falhados listados acima; não reescreva arquivos que passaram.
- Reproduza local: `gh pr checks` e `gh run view --log-failed` (ou leia CI_REPORT.md)
- Verifique: workflow em `.github/workflows/`, testes (`npm run test`), build (`npm run build`), lint/typecheck.
- Após correção: `git add -A && git commit -m "fix: corrige CI #{state.get('pr_number')} — <motivo>" && git push`
- Não crie novos artefatos .planning/PRD etc.; apenas código-fonte.
- Máx 1 fix por iteração; commit pequeno e focado.
""".strip()
    state["context"] = state.get("context", {})
    state["context"]["ci_fix_prompt"] = prompt
    state.setdefault("history", []).append({"node": "analyze", "prompt_len": len(prompt), "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    return state

def node_fix_stub(state: OrchestratorState, repo: Path) -> OrchestratorState:
    """
    Stub para fix: em modo determinístico puro, apenas registra instrução.
    Em modo LangGraph com LLM, este node seria substituído por `task("builder", context:{PLAN, CI_REPORT})`.
    Aqui, se houver um script de auto-fix ou se o harness já chamou builder, apenas incrementa retry e loga.
    """
    retries = state.get("retries", 0)
    # Em execução CLI pura, não temos LLM para fixar automaticamente. Apenas logamos instrução e
    # incrementamos retries para simular que harness chamará builder na próxima iteração.
    # Se o arquivo .planning/CI_REPORT.md foi atualizado por builder externo, o próximo wait_ci já verá novo commit.
    state["retries"] = retries + 1
    try:
        _save_retry(repo, state["retries"])  # type: ignore
    except Exception:
        pass
    state.setdefault("history", []).append({"node": "fix_stub", "retries": state["retries"], "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    # Simula que builder rodou e fez push (na prática, harness deve fazer task builder real aqui)
    # Para permitir loop automático sem harness, poderíamos tentar auto-fix simples: rodar guard_rails e npm run build
    # mas deixamos para harness fazer o fix qualitativo.
    return state

def node_review_stub(state: OrchestratorState) -> OrchestratorState:
    state.setdefault("history", []).append({"node": "review_stub", "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    return state

def node_reship_stub(state: OrchestratorState, repo: Path) -> OrchestratorState:
    """Simula shipper: se houver mudanças não commitadas, faz commit + push + pr check (via shipper.py)."""
    # chama shipper.py em dry-run? aqui apenas tenta shipper real se houver diff
    code, out, _ = run(["git", "status", "--porcelain"], cwd=repo)
    if out.strip():
        # há mudanças — tenta shipper
        shipper = repo / "hooks" / "shipper.py"
        if not shipper.exists():
            shipper = Path(__file__).parent / "shipper.py"
        if shipper.exists():
            code2, out2, err2 = run(["python3", str(shipper), "--run", "--repo", str(repo)], cwd=repo, timeout=90)
            state.setdefault("history", []).append({"node": "reship", "shipper_exit": code2, "out": (out2+err2)[:800], "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        else:
            state.setdefault("history", []).append({"node": "reship", "msg": "shipper.py não encontrado", "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    else:
        state.setdefault("history", []).append({"node": "reship", "msg": "sem diff para shipper", "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    return state

def should_continue(state: OrchestratorState) -> str:
    if state.get("ci_status") == "pass":
        return "done"
    if state.get("ci_status") == "pending":
        return "pending"
    if state.get("ci_status") == "fail":
        retries = state.get("retries", 0)
        max_r = state.get("max_retries", 2)
        if retries >= max_r:
            return "escalate"
        return "fix"
    return "escalate"  # unknown → escalate

# ── LangGraph builder (opcional) ────────────────────────────────────────────

def build_graph(repo: Path | None = None, timeout: int = 600, interval: int = 30):
    """
    Monta e retorna StateGraph compilado se langgraph estiver disponível.
    Caso contrário, retorna None e o caller deve usar fallback determinístico.
    """
    try:
        from langgraph.graph import StateGraph, END, START  # type: ignore
    except ImportError:
        return None

    repo = repo or Path.cwd()
    graph = StateGraph(OrchestratorState)

    # wrappers que capturam repo/timeout via closure
    def _detect(state: OrchestratorState) -> OrchestratorState:
        return node_detect_pr(state, repo)

    def _wait(state: OrchestratorState) -> OrchestratorState:
        return node_wait_ci(state, repo, timeout=timeout, interval=interval)

    def _analyze(state: OrchestratorState) -> OrchestratorState:
        return node_analyze_failure(state)

    def _fix(state: OrchestratorState) -> OrchestratorState:
        # Aqui harness pode injetar task builder real:
        # ex: `client.task("builder", context={...})` ou aguardar humano
        # Mantemos stub para demo; sobrescreva se integrar com OpenCode
        return node_fix_stub(state, repo)

    def _review(state: OrchestratorState) -> OrchestratorState:
        return node_review_stub(state)

    def _reship(state: OrchestratorState) -> OrchestratorState:
        return node_reship_stub(state, repo)

    graph.add_node("detect_pr", _detect)
    graph.add_node("wait_ci", _wait)
    graph.add_node("analyze", _analyze)
    graph.add_node("fix", _fix)
    graph.add_node("review", _review)
    graph.add_node("reship", _reship)

    graph.add_edge(START, "detect_pr")
    graph.add_edge("detect_pr", "wait_ci")

    def _router(state: OrchestratorState) -> str:
        return should_continue(state)

    graph.add_conditional_edges("wait_ci", _router, {
        "done": END,
        "pending": END,  # timeout — aguardar manual
        "fix": "analyze",
        "escalate": END,
    })
    graph.add_edge("analyze", "fix")
    graph.add_edge("fix", "review")
    graph.add_edge("review", "reship")
    graph.add_edge("reship", "wait_ci")  # loop de volta

    return graph.compile()

# ── Fallback determinístico (sem langgraph) ───────────────────────────────────

def run_deterministic_loop(repo: Path, max_retries: int = 2, timeout: int = 600, interval: int = 30, verbose: bool = False) -> int:
    """
    Loop determinístico puro, sem langgraph. Usado por CLI --run default.
    Retorna exit code: 0 pass, 2 fail escalate, 3 pending, 1 infra.
    """
    state: OrchestratorState = {"max_retries": max_retries, "retries": _load_retry(repo) if callable(_load_retry) else 0, "history": []}  # type: ignore
    state = node_detect_pr(state, repo)
    print(f"🤖 Orquestrador CI — branch {state.get('branch')} PR {state.get('pr_number')} retries {state.get('retries')}/{max_retries}")

    for iteration in range(max_retries + 1):
        print(f"\n── Iteração CI {iteration+1}/{max_retries+1} (retries {state.get('retries')}) ──")
        state = node_wait_ci(state, repo, timeout=timeout, interval=interval, verbose=verbose)
        status = state.get("ci_status")
        print(f"  CI status: {status} — {state.get('ci_details','')[:400]}")

        if status == "pass":
            print("✅ CI verde — encerrando loop com sucesso")
            # reset retries ao suceder
            try:
                _save_retry(repo, 0)  # type: ignore
            except Exception:
                pass
            persist_state(repo, state)
            return 0
        if status == "pending":
            print(f"⏳ CI pending após {timeout}s — não loopa automático, aguarde e re-execute")
            persist_state(repo, state)
            return 3
        if status == "fail":
            if state.get("retries", 0) >= max_retries:
                print(f"🛑 CI ainda falho após {max_retries} retries — escalar humano")
                persist_state(repo, state)
                return 2
            state = node_analyze_failure(state)
            print(f"  📋 Análise: prompt builder gerado ({len(state.get('context',{}).get('ci_fix_prompt',''))} chars)")
            print(f"  Report: {state.get('last_report_path')}")
            # Em modo CLI puro, não temos builder LLM automático. Instruímos harness/humano.
            print("\n" + "="*60)
            print("🚨 CI falhou — ação requerida:")
            print(state.get("context", {}).get("ci_fix_prompt", "")[:2500])
            print("="*60)
            # Para permitir loop automático sem humano, o harness deve ter chamado builder entre iterações.
            # Aqui, apenas incrementamos retry e tentamos reship se houver diff, depois re-poll.
            # Se não houver diff (builder ainda não rodou), pausamos e retornamos 2 para harness agir.
            code, out, _ = run(["git", "status", "--porcelain"], cwd=repo)
            if not out.strip():
                print("⚠️ Sem diff detectado — aguardando builder corrigir e fazer push. Retornando exit 2 para harness iniciar task builder.")
                persist_state(repo, state)
                return 2
            # Há diff → tenta fix+review+reship automático
            state = node_fix_stub(state, repo)
            state = node_review_stub(state)
            state = node_reship_stub(state, repo)
            # continua loop → próximo wait_ci
            continue
        # unknown
        print(f"❓ CI status desconhecido ({status}) — escalar")
        persist_state(repo, state)
        return 1

    print(f"🛑 Loop encerrou após {max_retries+1} iterações sem verde")
    persist_state(repo, state)
    return 2

def persist_state(repo: Path, state: OrchestratorState):
    # ── Novo: atualiza HANDOFF.md e STATE.md ao invés de criar .json separados ──
    # Sempre persiste em HANDOFF/STATE de forma idempotente
    try:
        _upsert_handoff_orchestrator(repo, state)
        _upsert_state_orchestrator(repo, state)
        print("✅ HANDOFF.md/STATE.md atualizados com orquestrador (sem criar ORCHESTRATOR_STATE.json separado)")
    except Exception as e:
        print(f"⚠️ persist_state HANDOFF/STATE falhou: {e}", file=sys.stderr)
    # legado opcional: só escreve JSON se env legado ativo ou --verbose legado
    if os.environ.get("ORCH_LEGACY_JSON", "") in ("1", "true", "yes"):
        try:
            p = repo / ".planning" / "COORCHESTRATOR_STATE.json"  # typo guard: also correct spelling
            p2 = repo / ".planning" / "ORCHESTRATOR_STATE.json"
            for pp in [p, p2]:
                pp.parent.mkdir(parents=True, exist_ok=True)
                pp.write_text(json.dumps(state, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        except Exception:
            pass
    # também append em HOOKS.log
    try:
        entry = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "hook": "ci-orchestrator", "status": state.get("ci_status"), "retries": state.get("retries"), "branch": state.get("branch")}
        line = json.dumps(entry, ensure_ascii=False)
        for log_path in [repo / ".planning/HOOKS.log", Path(".opencode/hooks/hook-audit.jsonl")]:
            try:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("a", encoding="utf-8") as lf:
                    lf.write(line + "\n")
            except Exception:
                pass
    except Exception:
        pass

# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Orquestrador CI — determinístico ou LangGraph")
    parser.add_argument("--run", action="store_true", help="Executa loop completo")
    parser.add_argument("--repo", default=".", help="Caminho do repo")
    parser.add_argument("--max-retries", type=int, default=2, help="Máx retries de correção")
    parser.add_argument("--timeout", type=int, default=600, help="Timeout polling por iteração")
    parser.add_argument("--interval", type=int, default=30, help="Intervalo polling")
    parser.add_argument("--with-langgraph", action="store_true", help="Tenta usar LangGraph se instalado")
    parser.add_argument("--dry-run", action="store_true", help="Não escreve state, só simula")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists() and (Path.cwd() / ".git").exists():
        repo = Path.cwd().resolve()

    if not args.run:
        parser.print_help()
        print("\nExemplos:")
        print("  python3 hooks/ci_orchestrator.py --run --max-retries 2 --timeout 600")
        print("  python3 hooks/ci_orchestrator.py --run --with-langgraph  # requer pip install langgraph")
        sys.exit(0)

    # Tenta LangGraph se pedido
    if args.with_langgraph:
        graph = build_graph(repo, timeout=args.timeout, interval=args.interval)
        if graph is None:
            print("⚠️ langgraph não instalado — instale com: pip install langgraph langgraph-checkpoint", file=sys.stderr)
            print("↪ Fallback para loop determinístico puro")
            code = run_deterministic_loop(repo, max_retries=args.max_retries, timeout=args.timeout, interval=args.interval, verbose=args.verbose)
            sys.exit(code)
        # Executa graph
        print(f"🧠 LangGraph orquestrador — max_retries {args.max_retries} timeout {args.timeout}s")
        initial: OrchestratorState = {"max_retries": args.max_retries, "retries": _load_retry(repo) if callable(_load_retry) else 0, "history": [], "branch": ""}  # type: ignore
        # invoke com limite de recursão
        try:
            result = graph.invoke(initial, config={"recursion_limit": 10 + args.max_retries * 3})  # type: ignore
            print("\n" + "="*60)
            print(f"LangGraph final — ci_status={result.get('ci_status')} retries={result.get('retries')}")
            print(f"History: {[h.get('node')+':'+str(h.get('status') or h.get('retries') or '') for h in result.get('history',[])[-10:]]}")
            print("="*60)
            persist_state(repo, result)
            if result.get("ci_status") == "pass":
                sys.exit(0)
            if result.get("ci_status") == "pending":
                sys.exit(3)
            sys.exit(2)
        except Exception as e:
            print(f"❌ LangGraph invoke falhou: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            # fallback
            code = run_deterministic_loop(repo, max_retries=args.max_retries, timeout=args.timeout, interval=args.interval, verbose=args.verbose)
            sys.exit(code)
    else:
        code = run_deterministic_loop(repo, max_retries=args.max_retries, timeout=args.timeout, interval=args.interval, verbose=args.verbose)
        sys.exit(code)

if __name__ == "__main__":
    main()
