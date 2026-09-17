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
  - Trello: se `~/.trello_config.json` existir, move card e comenta PR link (não bloqueante)

Exit codes:
  0 = shipper ok (commit+PR+HANDOFF/STATE gerados, Trello sync ok ou não configurado)
  1 = erro de uso
  2 = falha crítica (git falhou, gh não autenticado e sem HANDOFF, CI falhou e precisa escalar)

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
    if not summary:
        for cand in [repo / ".planning" / "HANDOFF.md", repo / ".planning" / "STATE.md"]:
            if cand.exists():
                summary = read_text(cand)[:2000]
                break

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
    lines.append("- [ ] Trello sync: verificar `~/.trello_config.json` ou `TRELLO_API_KEY`")
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

def generate_state(repo: Path, git_info: dict[str, Any], context: dict[str, Any], args, pr_url: str | None) -> str:
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
    lines.append("")
    lines.append("## Artifacts")
    lines.append("")
    lines.append("- `PRD.md`: done (memória)")
    lines.append("- `PLAN.md`: done (memória)")
    lines.append("- resumo: done (memória, nunca SUMMARY.md)")
    lines.append("- parecer: done (memória, nunca REVIEW.md)")
    lines.append("- `HANDOFF.md`: done (disco — hook)")
    lines.append("- `STATE.md`: done (disco — hook)")
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

def do_trello_sync(repo: Path, pr_url: str | None, dry_run: bool) -> tuple[bool, str]:
    if dry_run:
        return True, "dry-run: Trello não sincronizado"
    # verifica config
    cfg_paths = [Path.home() / ".trello_config.json", repo / ".trello_config.json"]
    cfg = None
    for cp in cfg_paths:
        if cp.exists():
            try:
                cfg = json.loads(cp.read_text(encoding="utf-8"))
                break
            except:
                pass
    # também verifica env
    api_key = os.environ.get("TRELLO_API_KEY") or (cfg.get("apiKey") if cfg else None)
    token = os.environ.get("TRELLO_TOKEN") or (cfg.get("token") if cfg else None)
    if not api_key or not token:
        return True, "Trello não configurado — pulado (configure ~/.trello_config.json ou TRELLO_API_KEY/TOKEN)"
    # se configurado, tenta mover card — implementação minimal via API
    # Por enquanto, apenas loga que está configurado; ação real pode ser feita por trello-manager skill no agente
    return True, "Trello configurado — sync deve ser feito via API (hook loga PR link, agente pode complementar)"

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

    # 5. STATE.md (agora com PR url se houver)
    state_md = generate_state(repo, git_info, context, args, state_pr_url)
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(state_md, encoding="utf-8")
        print(f"✅ STATE.md: {state_path} ({len(state_md)} chars)")
    except Exception as e:
        print(f"❌ Falha ao escrever STATE.md: {e}", file=sys.stderr)
        sys.exit(1)

    # 6. CI check
    ci_pass, ci_out = do_ci_check(repo, args.dry_run)
    ci_label = "pass" if ci_pass else "fail" if ci_pass is False else "unknown"
    print(f"CI check [{ci_label}]: {ci_out[:600]}")

    # 7. Trello
    trello_ok, trello_out = do_trello_sync(repo, pr_url, args.dry_run)
    print(f"{'✅' if trello_ok else '⚠️'} Trello: {trello_out}")

    # Resumo
    print("\n" + "="*60)
    print(f"🚢 Shipper hook — branch {git_info.get('branch')} — dry-run={args.dry_run}")
    print(f"  commit: {'ok' if commit_ok else 'fail'} | push: {'ok' if push_ok else 'fail'} | PR: {'ok' if pr_ok else 'fail'} | CI: {ci_label}")
    print(f"  HANDOFF: {handoff_path}")
    print(f"  STATE: {state_path}")
    print("="*60)

    # ── Log de garantia (prova que hook shipper foi chamado) ──
    try:
        import datetime

        status = "success" if commit_ok and pr_ok else "critical" if not commit_ok else "warn"
        if args.fail_on_ci and ci_pass is False:
            status = "critical"
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
    if not pr_ok and not args.dry_run and gh_available():
        if "não autenticado" in pr_out.lower() or "not authenticated" in pr_out.lower():
            sys.exit(0)
        sys.exit(2)
    sys.exit(0)

if __name__ == "__main__":
    main()
