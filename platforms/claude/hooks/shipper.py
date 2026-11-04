#!/usr/bin/env python3
"""
hooks/shipper.py — Hook determinístico para finalização (shipper como hook).

Conceito de Hook (fora do LLM):
  Middleware determinístico que finaliza o ciclo sem depender de LLM para
  tarefas mecânicas: git commit, PR, CI check e Trello sync.
  STATE/HANDOFF ainda podem ter contribuição qualitativa do agente shipper
  minimal quando o hook não consegue gerar conteúdo rico — fallback previsto
  no harness (shipper minimal).

Acionamento:
  - Trigger primário: após reviewer aprovar (task reviewer completa)
  - Invocado por: plugins/shipper.ts via `tool.execute.after` (task reviewer/builder) + `event: session.idle`
    e também direto via CLI: `python3 hooks/shipper.py --run --repo .`
  - Em Claude: `.claude/settings.json` → hooks.PostToolUse / Stop (opcional)

O que faz (determinístico, sem LLM):
  - Git: status, diff, commit conventional, push (se origin existir)
  - PR: `gh pr create` ou atualiza se já existe; `gh pr checks` / `gh run list` para CI
  - STATE/HANDOFF: gera templates em `.planning/STATE.md` e `.planning/HANDOFF.md` a partir de git diff + contexto injetado (se --context-file fornecido)
  - Trello: sync REAL via REST API (stdlib urllib, sem `requests`) quando configurado:
    localiza card por ID estável (`card_id` — preferível) ou por nome exato no board
    (`card_name` + `board_id`/`board`), move para lista de destino configurada
    EXPLICITAMENTE (`list_id`/`dest_list_id` por ID, ou nome exato + board) e comenta o
    link do PR. Aceita `api_key` ou `apiKey` na config, e env `TRELLO_API_KEY`/`TRELLO_KEY`.
    Regras de honestidade: sem credenciais = `skipped` (pulado); com credenciais, status
    `ok` SÓ quando o card foi movido de fato (verificado na resposta da API). Qualquer
    falha (misconfiguração, 401/404/ambiguidade, rede) → `TRELLO_SYNC_FAILED` visível no
    stdout, bloco `<!-- TRELLO_REPORT -->` no HANDOFF.md, campo `trello` no HOOKS.log e
    instrução de fallback (`task shipper` minimal + skill `trello-manager`).
    Não bloqueia o pipeline por padrão; `--fail-on-trello` força exit 2.

Exit codes:
  0 = shipper ok (commit+PR+HANDOFF/STATE gerados, Trello sync ok, não configurado ou falho sem --fail-on-trello)
  1 = erro de uso
  2 = falha crítica (git falhou, gh não autenticado e sem HANDOFF, CI falhou e precisa escalar, Trello falhou com --fail-on-trello)

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
import time
import urllib.error
import urllib.parse
import urllib.request
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
    """Remove todos os blocos de marcadores de hooks (CI/TRELLO/SUPERVISOR/ORCHESTRATOR) de um texto."""
    for start, end in (
        (TRELLO_HANDOFF_START, TRELLO_HANDOFF_END),
        ("<!-- CI_REPORT:START -->", "<!-- CI_REPORT:END -->"),
        ("<!-- SUPERVISOR:START -->", "<!-- SUPERVISOR:END -->"),
        ("<!-- ORCHESTRATOR:START -->", "<!-- ORCHESTRATOR:END -->"),
    ):
        text = re.sub(re.escape(start) + r".*?" + re.escape(end), "", text, flags=re.DOTALL)
    return text

def generate_handoff(repo: Path, git_info: dict[str, Any], context: dict[str, Any], args) -> str:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    branch = git_info.get("branch", "main")
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
    # para não embutir o HANDOFF anterior recursivamente (nem TRELLO_REPORT/CI_REPORT)
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
    lines.append(f"**Branch:** `{branch}` | **Repo:** `{args.repo_slug}` | **Gerado por:** `hooks/shipper.py` (determinístico, fallback hook)")
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
    lines.append("- [ ] Trello sync: ver bloco `TRELLO_REPORT` neste arquivo (ok = card movido; failed = fallback `task shipper` + skill `trello-manager` pendente)")
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

def generate_state(repo: Path, git_info: dict[str, Any], context: dict[str, Any], args, pr_url: str | None, trello: dict[str, Any] | None = None) -> str:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    branch = git_info.get("branch", "main")
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
    lines.append(f"**Flow:** `{flow}` | **Gate:** `done` | **Branch:** `{branch}`")
    lines.append(f"**Repo:** `{args.repo_slug}` | **Gerado por:** `hooks/shipper.py`")
    if pr_url:
        lines.append(f"**PR:** {pr_url}")
    trello_status = (trello or {}).get("status", "skipped")
    trello_icon = {"ok": "✅", "failed": "❌", "skipped": "⏭️", "dry_run": "🧪"}.get(trello_status, "❔")
    lines.append(f"**Trello:** {trello_icon} `{trello_status}` — {sanitize_trello_text(str((trello or {}).get('message', '')))[:200]}")
    lines.append("")
    lines.append("## Artifacts")
    lines.append("")
    lines.append("- `PRD.md`: done (memória)")
    lines.append("- `PLAN.md`: done (memória)")
    lines.append("- resumo: done (memória, nunca SUMMARY.md)")
    lines.append("- parecer: done (memória, nunca REVIEW.md)")
    lines.append("- `HANDOFF.md`: done (disco — hook)")
    lines.append("- `STATE.md`: done (disco — hook)")
    lines.append(f"- Trello sync: `{trello_status}` (hook — se `failed`, fallback `task shipper` minimal + skill `trello-manager`; ver HANDOFF.md#TRELLO_REPORT)")
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

def do_gh_pr(repo: Path, title: str, body_file: Path, branch: str, dry_run: bool) -> tuple[bool, str, str | None]:
    if dry_run:
        return True, "dry-run: PR não criado", None
    if not gh_available():
        return False, "gh CLI não encontrado", None
    # verifica se PR já existe para branch
    code, out, _ = run(["gh", "pr", "view", "--json", "number,url", "--jq", ".url"], cwd=repo)
    # gh pr view sem PR retorna erro — tentamos create
    code2, out2, err2 = run(["gh", "pr", "create", "--title", title, "--body-file", str(body_file)], cwd=repo)
    if code2 == 0:
        url = out2.strip()
        return True, url, url
    # se falhou por already exists, tente view
    if "already exists" in (out2+err2).lower() or "already" in (out2+err2).lower():
        code3, out3, _ = run(["gh", "pr", "view", "--json", "url", "--jq", ".url"], cwd=repo)
        if code3 == 0 and out3.strip():
            return True, f"PR já existe: {out3.strip()}", out3.strip()
        return False, f"gh pr create falhou (already exists mas view falhou): {out2} {err2}", None
    # falha genérica
    if "gh auth" in (out2+err2).lower() or "not authenticated" in (out2+err2).lower():
        return False, f"gh não autenticado: {out2} {err2} — faça `gh auth login`", None
    return False, f"gh pr create falhou: {out2} {err2}", None

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

# ── Trello — sync real via REST API (stdlib, determinístico, sem LLM) ─────────
TRELLO_BASE = "https://api.trello.com/1"
TRELLO_ID_RE = re.compile(r"^[0-9a-f]{24}$", re.IGNORECASE)
TRELLO_HANDOFF_START = "<!-- TRELLO_REPORT:START -->"
TRELLO_HANDOFF_END = "<!-- TRELLO_REPORT:END -->"

def sanitize_trello_text(text: str) -> str:
    """Remove query strings de URLs (podem conter key/token) — nunca vazar credenciais em logs."""
    return re.sub(r"\?[^ \n\"']*", "?key=***", text or "")

def cfg_get(cfg: dict[str, Any], *keys: str) -> str | None:
    """Primeiro valor não vazio entre chaves — aceita `api_key` E `apiKey`, snake e camel."""
    for k in keys:
        v = cfg.get(k)
        if v not in (None, ""):
            return str(v).strip()
    return None

def load_trello_config(repo: Path, args) -> dict[str, Any]:
    """Carrega config Trello com precedência: CLI > env > arquivo (~/.trello_config.json ou repo)."""
    cfg: dict[str, Any] = {}
    candidates: list[Path] = []
    if getattr(args, "trello_config", ""):
        candidates.append(Path(args.trello_config))
    if os.environ.get("TRELLO_CONFIG", "").strip():
        candidates.append(Path(os.environ["TRELLO_CONFIG"].strip()))
    candidates += [Path.home() / ".trello_config.json", repo / ".trello_config.json"]
    for cp in candidates:
        try:
            if cp.exists():
                loaded = json.loads(cp.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    cfg = loaded
                    cfg["_config_path"] = str(cp)
                    break
        except Exception:
            continue
    # env sobrescreve arquivo — aceita TRELLO_API_KEY e TRELLO_KEY
    env_map = {
        "api_key": ("TRELLO_API_KEY", "TRELLO_KEY"),
        "token": ("TRELLO_TOKEN",),
        "card_id": ("TRELLO_CARD_ID",),
        "list_id": ("TRELLO_LIST_ID",),
        "board_id": ("TRELLO_BOARD_ID",),
    }
    for key, env_names in env_map.items():
        val = next((os.environ[n] for n in env_names if os.environ.get(n, "").strip()), None)
        if val:
            cfg[key] = val.strip()
    # CLI tem prioridade máxima
    for attr, key in (("trello_card", "card_id"), ("trello_list", "list_id"), ("trello_board", "board_id")):
        val = str(getattr(args, attr, "") or "").strip()
        if val:
            cfg[key] = val
    return cfg

def trello_api(method: str, path: str, auth: dict[str, str], query: dict[str, Any] | None = None, body: dict[str, Any] | None = None, timeout: int = 15) -> tuple[bool, Any, str]:
    """Chamada REST determinística com retry em 429/5xx. Retorna (ok, json|texto, erro_sanitizado)."""
    params = {**auth, **(query or {})}
    url = f"{TRELLO_BASE}{path}?{urllib.parse.urlencode(params)}"
    data = urllib.parse.urlencode({k: str(v) for k, v in body.items()}).encode() if body else None
    last_err = "erro desconhecido"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=data, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                try:
                    return True, json.loads(raw), ""
                except json.JSONDecodeError:
                    return True, raw, ""
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            if e.code == 401:
                return False, None, "HTTP 401 — api_key/token inválidos ou expirados (re-autorize em https://trello.com/1/authorize)"
            if e.code == 404:
                return False, None, "HTTP 404 — card/lista/board não encontrado (verifique IDs na config Trello)"
            return False, None, sanitize_trello_text(f"HTTP {e.code}: {detail or e.reason}")
        except Exception as e:
            last_err = sanitize_trello_text(f"{type(e).__name__}: {e}")
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
    return False, None, last_err

def resolve_trello_board(auth: dict[str, str], ref: str) -> tuple[bool, dict[str, Any] | None, str]:
    """Aceita ID estável (hex 24) ou nome exato (case-insensitive) de board."""
    ref = str(ref).strip()
    if TRELLO_ID_RE.match(ref):
        ok, b, err = trello_api("GET", f"/boards/{ref}", auth, query={"fields": "name"})
        if ok and isinstance(b, dict) and b.get("id"):
            return True, b, ""
        return False, None, err or f"board `{ref}` não encontrado"
    ok, boards, err = trello_api("GET", "/members/me/boards", auth, query={"fields": "name", "open": "true"})
    if not ok:
        return False, None, err
    for b in boards or []:
        if isinstance(b, dict) and str(b.get("name", "")).strip().lower() == ref.lower():
            return True, b, ""
    return False, None, f"board '{ref}' não encontrado entre os boards do membro (use board_id estável)"

def resolve_trello_dest(auth: dict[str, str], dest: str, board_ref: str | None) -> tuple[bool, dict[str, Any] | None, str]:
    """Lista de destino configurada explicitamente: ID estável (preferível) ou nome exato no board."""
    dest = str(dest).strip()
    if TRELLO_ID_RE.match(dest):
        ok, lst, err = trello_api("GET", f"/lists/{dest}", auth, query={"fields": "name,id,closed"})
        if ok and isinstance(lst, dict) and lst.get("id"):
            return True, lst, ""
        return False, None, f"list_id de destino `{dest}` inválido: {err}"
    if not board_ref:
        return False, None, f"destino '{dest}' é nome de lista — configure `board_id`/`board` na config para resolvê-lo"
    ok, board, err = resolve_trello_board(auth, board_ref)
    if not ok:
        return False, None, err
    ok, lists, err = trello_api("GET", f"/boards/{board['id']}/lists", auth, query={"fields": "name,id,closed"})
    if not ok:
        return False, None, err
    matches = [l for l in (lists or []) if isinstance(l, dict) and str(l.get("name", "")).strip().lower() == dest.lower() and not l.get("closed")]
    if not matches:
        return False, None, f"lista de destino '{dest}' não encontrada (aberta) no board '{board.get('name')}'"
    if len(matches) > 1:
        return False, None, f"{len(matches)} listas chamadas '{dest}' no board — use `list_id` estável para remover ambiguidade"
    return True, matches[0], ""

def do_trello_sync(repo: Path, pr_url: str | None, dry_run: bool, args) -> dict[str, Any]:
    """Sync Trello real. `ok` exige card MOVIDO de fato; falha é sempre visível (nunca sucesso silencioso).

    Status: ok | skipped (sem credenciais) | failed (misconfig/API/rede) | dry_run.
    Garante sanitização final — mensagem jamais contém key/token.
    """
    result = _trello_sync(repo, pr_url, dry_run, args)
    result["message"] = sanitize_trello_text(str(result.get("message", "")))
    return result

def _trello_sync(repo: Path, pr_url: str | None, dry_run: bool, args) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "skipped", "message": "", "moved": False, "commented": False,
        "card_id": None, "card_url": None, "card_name": None,
        "dest_list_id": None, "dest_list_name": None,
    }
    cfg = load_trello_config(repo, args)
    api_key = cfg_get(cfg, "api_key", "apiKey", "API_KEY", "app_key", "key")
    token = cfg_get(cfg, "token", "auth_token", "accessToken")
    if not api_key and not token:
        result["message"] = "Trello não configurado — pulado (crie ~/.trello_config.json com api_key+token ou exporte TRELLO_API_KEY/TRELLO_TOKEN)"
        return result
    if not api_key or not token:
        faltando = "api_key|apiKey" if not api_key else "token"
        result["status"] = "failed"
        result["message"] = f"TRELLO_MISCONFIGURED: credenciais parciais — falta `{faltando}` em {cfg.get('_config_path', 'env/CLI')}"
        return result

    card_id = cfg_get(cfg, "card_id", "cardId", "idCard", "id_card", "idcard")
    card_name = cfg_get(cfg, "card_name", "cardName", "card")
    dest = cfg_get(cfg, "list_id", "listId", "dest_list_id", "destListId", "target_list_id", "targetListId", "dest_list", "destList", "target_list", "targetList")
    board_ref = cfg_get(cfg, "board_id", "boardId", "board")

    problems = []
    if not card_id and not (card_name and board_ref):
        problems.append("card não configurado — use `card_id` (ID estável, preferível) ou `card_name` + `board_id`/`board`")
    if not dest:
        problems.append("lista de destino não configurada explicitamente — use `list_id`/`dest_list_id` (ID estável) ou nome exato + `board_id`")
    if problems:
        result["status"] = "failed"
        result["message"] = "TRELLO_MISCONFIGURED: " + "; ".join(problems) + f" (config: {cfg.get('_config_path', 'env/CLI')})"
        return result

    auth = {"key": api_key, "token": token}
    if dry_run:
        result["status"] = "dry_run"
        result["card_id"] = card_id
        result["message"] = f"dry-run: moveria card {card_id or f'nome={card_name}'} para destino `{dest}`"
        return result

    # 1. Localizar card — ID estável é preferível; fallback nome exato (aberto) no board
    card: dict[str, Any] = {}
    if card_id:
        ok, data, err = trello_api("GET", f"/cards/{card_id}", auth, query={"fields": "name,id,url,idList,closed"})
        if not ok or not isinstance(data, dict) or not data.get("id"):
            result["status"] = "failed"
            result["message"] = f"Falha ao localizar card estável `{card_id}`: {err or 'resposta inválida'}"
            return result
        card = data
    else:
        ok, board, err = resolve_trello_board(auth, board_ref)
        if not ok:
            result["status"] = "failed"
            result["message"] = f"Falha ao resolver board '{board_ref}': {err}"
            return result
        ok, cards, err = trello_api("GET", f"/boards/{board['id']}/cards", auth, query={"fields": "name,id,url"})
        if not ok:
            result["status"] = "failed"
            result["message"] = f"Falha ao listar cards do board '{board.get('name')}': {err}"
            return result
        matches = [c for c in (cards or []) if isinstance(c, dict) and str(c.get("name", "")).strip().lower() == str(card_name).strip().lower()]
        if not matches:
            result["status"] = "failed"
            result["message"] = f"nenhum card aberto com nome exato '{card_name}' no board '{board.get('name')}' (preferível: configurar card_id estável)"
            return result
        if len(matches) > 1:
            result["status"] = "failed"
            result["message"] = f"{len(matches)} cards abertos chamados '{card_name}' no board '{board.get('name')}' — ambiguidade: configure `card_id` (ID estável)"
            return result
        card = matches[0]
        card_id = card["id"]
    result["card_id"] = card_id
    result["card_name"] = card.get("name")
    result["card_url"] = card.get("url")

    # 2. Resolver lista de destino explícita
    ok, lst, err = resolve_trello_dest(auth, dest, board_ref)
    if not ok:
        result["status"] = "failed"
        result["message"] = f"Falha ao resolver lista de destino '{dest}': {err}"
        return result
    result["dest_list_id"] = lst["id"]
    result["dest_list_name"] = lst.get("name")

    # 3. MOVER o card (PUT idList) — sucesso só é declarado se a API confirmar o destino
    pos = cfg_get(cfg, "pos")
    move_body: dict[str, Any] = {"idList": lst["id"]}
    if pos:
        move_body["pos"] = pos
    ok, moved, err = trello_api("PUT", f"/cards/{card_id}", auth, body=move_body)
    if not ok:
        result["status"] = "failed"
        result["message"] = f"Falha ao mover card `{card_id}` para lista `{lst.get('name') or lst['id']}`: {err}"
        return result
    confirmed = isinstance(moved, dict) and moved.get("idList") == lst["id"]
    if isinstance(moved, dict) and moved.get("idList") and not confirmed:
        result["status"] = "failed"
        result["message"] = f"API confirmou idList `{moved.get('idList')}` diferente do destino `{lst['id']}` — movimento não aplicado"
        return result
    result["moved"] = True

    # 4. Opcional: arquivar após mover (config `archive: true`)
    archived = cfg.get("archive") in (True, "true", "1", "yes")
    if archived:
        ok_a, _, err_a = trello_api("PUT", f"/cards/{card_id}", auth, body={"closed": "true"})
        if not ok_a:
            result["message"] = f"(aviso: movido, mas archive falhou: {err_a})"

    # 5. Opcional: comentar link do PR (config `add_pr_comment`/`comment`, flag --no-trello-comment)
    add_comment = cfg.get("add_pr_comment", cfg.get("comment", True)) not in (False, "false", "0", "no")
    if getattr(args, "no_trello_comment", False):
        add_comment = False
    comment_note = ""
    if add_comment and pr_url:
        ok_c, _, err_c = trello_api("POST", f"/cards/{card_id}/actions", auth, body={"text": f"🚢 Shipper hook: PR entregue — {pr_url}"})
        result["commented"] = ok_c
        if not ok_c:
            comment_note = f" (movido, mas comentário do PR falhou: {err_c})"

    result["status"] = "ok"
    result["message"] = f"card `{card_id}` movido para lista `{result['dest_list_name'] or result['dest_list_id']}`{comment_note}"
    return result

def upsert_handoff_trello(handoff_path: Path, result: dict[str, Any]) -> None:
    """Registra status do sync Trello no HANDOFF.md (marcadores TRELLO_REPORT, idempotente)."""
    icon = {"ok": "✅", "failed": "❌", "skipped": "⏭️", "dry_run": "🧪"}.get(result.get("status", ""), "❔")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    card_disp = f"`{result.get('card_id')}`" if result.get("card_id") else "—"
    url_disp = f" ({result['card_url']})" if result.get("card_url") else ""
    lines = [
        TRELLO_HANDOFF_START,
        f"## Trello sync (hook shipper) — {now}",
        "",
        f"- **Status:** {icon} `{result.get('status')}` | moved: `{result.get('moved')}` | commented: `{result.get('commented')}`",
        f"- **Card:** {card_disp}{url_disp} — {result.get('card_name') or '—'}",
        f"- **Destino:** `{result.get('dest_list_name') or result.get('dest_list_id') or '—'}`",
        f"- **Detalhe:** {sanitize_trello_text(str(result.get('message', '')))}",
    ]
    if result.get("status") == "failed":
        lines.append("- **Ação (fallback):** acionar `task shipper` (minimal) com skill `trello-manager` para concluir o movimento do card para a lista de destino configurada; falha registrada em `.planning/HOOKS.log` (campo `trello`) e neste bloco — nunca encerrar o gate com sync falho silencioso")
    lines.append(TRELLO_HANDOFF_END)
    block = "\n".join(lines)
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        existing = read_text(handoff_path)
        # remove blocos TRELLO_REPORT existentes (todos) e reaproveita o resto do documento
        base = existing
        if TRELLO_HANDOFF_START in base or TRELLO_HANDOFF_END in base:
            base = strip_marker_blocks(existing)
            base = base.replace(TRELLO_HANDOFF_START, "").replace(TRELLO_HANDOFF_END, "")
        base = base.rstrip()
        new_content = (base + "\n\n" if base else "") + block + "\n"
        handoff_path.write_text(new_content, encoding="utf-8")
    except Exception as e:
        print(f"⚠️ Falha ao registrar TRELLO_REPORT em {handoff_path}: {e}", file=sys.stderr)

def main():
    parser = argparse.ArgumentParser(description="Hook shipper determinístico — git/PR/STATE/HANDOFF/Trello")
    parser.add_argument("--run", action="store_true", help="Executa fluxo completo")
    parser.add_argument("--repo", default=".", help="Caminho do repo")
    parser.add_argument("--repo-slug", default=os.environ.get("SHIPPER_REPO", "tuliomourarocha/module-sdd-commons"), help="Slug GitHub para PR")
    parser.add_argument("--dry-run", action="store_true", help="Não faz commit/push/PR, só gera STATE/HANDOFF")
    parser.add_argument("--context-file", default="", help="Arquivo JSON com PRD/PLAN + resumo/parecer em memória (opcional) — nunca SUMMARY/REVIEW/VALIDATION como arquivos")
    parser.add_argument("--commit-msg", default="", help="Mensagem de commit conventional (se vazio, gera automático)")
    parser.add_argument("--pr-title", default="", help="Título do PR (se vazio, usa commit msg)")
    parser.add_argument("--fail-on-ci", action="store_true", help="Exit 2 se CI falhar")
    parser.add_argument("--handoff-out", default="", help="Caminho para HANDOFF.md (default .planning/HANDOFF.md)")
    parser.add_argument("--state-out", default="", help="Caminho para STATE.md (default .planning/STATE.md)")
    parser.add_argument("--trello-config", default="", help="Caminho de config JSON do Trello (default ~/.trello_config.json)")
    parser.add_argument("--trello-card", default="", help="ID estável do card Trello (sobrescreve config — preferível a nome)")
    parser.add_argument("--trello-list", default="", help="ID ou nome EXATO da lista de destino do Trello (sobrescreve config)")
    parser.add_argument("--trello-board", default="", help="ID ou nome do board Trello (resolve card/lista por nome)")
    parser.add_argument("--no-trello-comment", action="store_true", help="Não comentar link do PR no card Trello")
    parser.add_argument("--fail-on-trello", action="store_true", help="Exit 2 se sync Trello falhar (por padrão falha é visível mas não bloqueante)")
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

    # 1. Git commit
    commit_ok, commit_msg_out = do_git_commit(repo, commit_msg, args.dry_run)
    print(f"{'✅' if commit_ok else '❌'} Git commit: {commit_msg_out}")

    # 2. Push
    push_ok, push_out = do_git_push(repo, git_info.get("branch", "main"), args.dry_run)
    print(f"{'✅' if push_ok else '⚠️'} Git push: {push_out}")

    # 3. Gera HANDOFF e STATE (sempre, mesmo se git falhou)
    handoff_md = generate_handoff(repo, git_info, context, args)
    state_pr_url = None  # será preenchido após PR
    # escreve HANDOFF temporário para usar como body do PR
    try:
        handoff_path.parent.mkdir(parents=True, exist_ok=True)
        handoff_path.write_text(handoff_md, encoding="utf-8")
        print(f"✅ HANDOFF.md: {handoff_path} ({len(handoff_md)} chars)")
    except Exception as e:
        print(f"❌ Falha ao escrever HANDOFF.md: {e}", file=sys.stderr)
        sys.exit(1)

    # 4. PR
    pr_title = args.pr_title.strip() or commit_msg.split("\n")[0][:80]
    pr_ok, pr_out, pr_url = do_gh_pr(repo, pr_title, handoff_path, git_info.get("branch", "main"), args.dry_run)
    print(f"{'✅' if pr_ok else '⚠️'} PR: {pr_out}")
    if pr_url:
        state_pr_url = pr_url

    # 5. Trello — sync real ANTES do STATE (status precisa aparecer em STATE/HANDOFF/HOOKS.log)
    trello = do_trello_sync(repo, pr_url, args.dry_run, args)
    trello_status = trello.get("status", "skipped")
    if trello_status == "ok":
        print(f"✅ Trello: TRELLO_SYNC_OK — {trello['message']}")
    elif trello_status == "failed":
        print(f"❌ Trello: TRELLO_SYNC_FAILED — {trello['message']}")
        print("   ↪ fallback requerido: harness deve acionar `task shipper` (minimal) com skill `trello-manager` para mover o card; falha registrada em HANDOFF.md#TRELLO_REPORT e .planning/HOOKS.log (campo trello)")
    elif trello_status == "dry_run":
        print(f"🧪 Trello: {trello['message']}")
    else:
        print(f"⏭️ Trello: {trello['message']}")
    upsert_handoff_trello(handoff_path, trello)

    # 6. STATE.md (agora com PR url e status Trello)
    state_md = generate_state(repo, git_info, context, args, state_pr_url, trello)
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
    print(f"🚢 Shipper hook — branch {git_info.get('branch')} — dry-run={args.dry_run}")
    print(f"  commit: {'ok' if commit_ok else 'fail'} | push: {'ok' if push_ok else 'fail'} | PR: {'ok' if pr_ok else 'fail'} | CI: {ci_label} | Trello: {trello_status}")
    print(f"  HANDOFF: {handoff_path}")
    print(f"  STATE: {state_path}")
    print("="*60)

    # ── Log de garantia (prova que hook shipper foi chamado) ──
    try:
        import datetime

        status = "success" if commit_ok and pr_ok else "critical" if not commit_ok else "warn"
        if args.fail_on_ci and ci_pass is False:
            status = "critical"
        if trello_status == "failed" and status == "success":
            status = "warn"  # Trello falhou — visível como warn (fallback requerido), crítico só com --fail-on-trello
        entry = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "hook": "shipper",
            "trigger": "python:shipper.py",
            "branch": git_info.get("branch"),
            "dry_run": args.dry_run,
            "commit_ok": commit_ok,
            "push_ok": push_ok,
            "pr_ok": pr_ok,
            "pr_url": pr_url,
            "ci": ci_label,
            "trello": {
                "status": trello_status,
                "moved": trello.get("moved"),
                "card_id": trello.get("card_id"),
                "dest_list_id": trello.get("dest_list_id"),
                "dest_list_name": trello.get("dest_list_name"),
                "message": sanitize_trello_text(str(trello.get("message", "")))[:400],
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
    if args.fail_on_trello and trello_status == "failed":
        sys.exit(2)
    if not pr_ok and not args.dry_run and gh_available():
        if "não autenticado" in pr_out.lower() or "not authenticated" in pr_out.lower():
            sys.exit(0)
        sys.exit(2)
    sys.exit(0)

if __name__ == "__main__":
    main()
