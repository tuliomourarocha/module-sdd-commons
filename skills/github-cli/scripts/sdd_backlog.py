#!/usr/bin/env python3
"""
sdd_backlog.py — CLI determinístico do backlog GitHub (issues, labels, milestones, Projects v2).

Mapeamento do backlog do Harness V2 no GitHub:

- Board        → GitHub Project v2 (campo `Status`: Backlog / In Progress / Done)
- Card         → Issue (épico = issue com label `epic` + tasklist no corpo)
- Lista        → Status do Project (`Backlog` / `In Progress` / `Done`)
- Prioridade   → labels separadas: `P0-critical` | `P1-high` | `P2-medium` | `P3-low`
- Tipo         → labels separadas: `epic` | `feature` | `bug` | `chore` | `docs`
- Domínio/tags → labels livres (ex.: `auth`, `checkout`, `infra`)
- Sprints      → milestones (`Sprint 1`, `Sprint 2`, …)

Donos por gate (escopo fechado):
- planner  — CRIA: `ensure-labels`, `ensure-milestone`, `create-issue`, `add-to-project`
- builder  — SÓ move/atualiza: `move-issue` (→ In Progress) + `--assign-me`
- shipper  — SÓ encerra: `close-issue` (→ Done + fechada) — nunca cria

Gate de auth: `gh auth status` é validado antes de QUALQUER comando —
falhou → exit 2 com instrução de `gh auth login`, zero operações.

Exemplos:
  python3 skills/github-cli/scripts/sdd_backlog.py ensure-labels
  python3 skills/github-cli/scripts/sdd_backlog.py ensure-milestone "Sprint 1"
  python3 skills/github-cli/scripts/sdd_backlog.py create-issue --title "feat: checkout" --labels "P1-high,feature,checkout" --milestone "Sprint 1" --project "SDD Backlog"
  python3 skills/github-cli/scripts/sdd_backlog.py move-issue 12 --project "SDD Backlog" --status "In Progress" --assign-me
  python3 skills/github-cli/scripts/sdd_backlog.py close-issue 12 --comment "🚢 PR entregue — https://github.com/org/repo/pull/34"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

# ── Labels padrão (prioridade e tipo/tags separadas) ──────────────────────────
DEFAULT_LABELS: list[dict[str, str]] = [
    # Prioridade — separada das demais (escolha UMA por issue)
    {"name": "P0-critical", "color": "b60205", "description": "Prioridade P0 — crítico (bloqueia release)"},
    {"name": "P1-high",     "color": "d93f0b", "description": "Prioridade P1 — alta"},
    {"name": "P2-medium",   "color": "fbca04", "description": "Prioridade P2 — média"},
    {"name": "P3-low",      "color": "0e8a16", "description": "Prioridade P3 — baixa"},
    # Tipo — separado da prioridade
    {"name": "epic",    "color": "5319e7", "description": "Épico — agrupa features via tasklist/sub-issues"},
    {"name": "feature", "color": "1d76db", "description": "Feature — user story funcional"},
    {"name": "bug",     "color": "ee0701", "description": "Bug — correção de defeito"},
    {"name": "chore",   "color": "ededed", "description": "Chore — manutenção/infra sem feature"},
    {"name": "docs",    "color": "0075ca", "description": "Docs — documentação"},
]

# Allowlist de status — NUNCA inventa destino fora disso
STATUS_PATTERNS: dict[str, tuple[str, ...]] = {
    "backlog": ("backlog", "todo"),
    "in-progress": ("progress", "doing", "execu", "fazendo"),
    "done": ("done", "conclu", "entregue", "shipped", "finalizado", "pronto", "deployed"),
}

_REPO_OVERRIDE = ""


def set_repo(v: str) -> None:
    global _REPO_OVERRIDE
    _REPO_OVERRIDE = (v or "").strip()


def norm(text: Any) -> str:
    t = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", t).strip().lower()


def status_group(want: str) -> tuple[str, ...] | None:
    w = norm(want)
    if any(p in w for p in ("done", "conclu", "entregue", "shipped")):
        return STATUS_PATTERNS["done"]
    if any(p in w for p in ("progress", "doing", "execu", "fazendo")):
        return STATUS_PATTERNS["in-progress"]
    if "backlog" in w or w == "todo":
        return STATUS_PATTERNS["backlog"]
    return None


def match_status_option(options: list[dict[str, Any]], want: str) -> dict[str, Any] | None:
    """Casa a opção do campo Status por padrões (backlog/in-progress/done) — nunca inventa."""
    patterns = status_group(want) or (norm(want),)
    exact = [o for o in options if norm(o.get("name", "")) == norm(want)]
    if exact:
        return exact[0]
    for o in options or []:
        name = norm(o.get("name", ""))
        if any(p in name for p in patterns):
            return o
    return None


def issue_number_from_url(url: str) -> int | None:
    m = re.search(r"/issues/(\d+)", url or "")
    return int(m.group(1)) if m else None


# ── Infra gh ───────────────────────────────────────────────────────────────────
def gh_run(args: list[str], timeout: int = 60) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", "command not found: gh"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"


def auth_gate() -> None:
    """Gate obrigatório: valida `gh auth status` antes de qualquer operação."""
    code, out, err = gh_run(["auth", "status"], timeout=20)
    if code == 0:
        return
    print(f"GITHUB_AUTH_REQUIRED: gh não autenticado — rode `gh auth login` e reexecute "
          f"(gate de auth antes de QUALQUER operação; detalhe: {(out + err).strip()[:200]})", file=sys.stderr)
    sys.exit(2)


def repo_slug() -> str:
    if _REPO_OVERRIDE:
        return _REPO_OVERRIDE
    try:
        p = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, timeout=15)
        url = p.stdout.strip()
    except Exception:
        url = ""
    m = re.search(r"[:/]([^/]+/[^/.]+?)(?:\.git)?/?$", url)
    return m.group(1) if m else ""


def json_list(data: Any, key: str) -> list[dict[str, Any]]:
    """`gh --format json` varia entre lista e objeto paginado — normaliza."""
    if isinstance(data, dict):
        data = data.get(key, [])
    return [x for x in (data or []) if isinstance(x, dict)]


def parse_json(out: str) -> Any:
    return json.loads(out)


def owner() -> str:
    slug = repo_slug()
    return slug.split("/")[0] if slug else ""


# ── Project v2 (board do backlog) ─────────────────────────────────────────────
def resolve_project(ref: str) -> tuple[bool, dict[str, Any] | str]:
    """Aceita número do Project, URL (`/projects/N`) ou título exato — resolve {number,id,title}."""
    ref = str(ref).strip()
    m = re.search(r"/projects/(\d+)", ref)
    if m:
        ref = m.group(1)
    if not owner():
        return False, "sem remote origin — não dá para resolver o dono do Project"
    if ref.isdigit():
        code, out, err = gh_run(["project", "view", ref, "--owner", owner(), "--format", "json"], timeout=30)
        if code != 0:
            return False, f"Project `{ref}` não encontrado: {(out + err).strip()[:200]}"
        try:
            return True, parse_json(out)
        except Exception as e:
            return False, f"resposta inválida de gh project view: {e}"
    code, out, err = gh_run(["project", "list", "--owner", owner(), "--format", "json"], timeout=30)
    if code != 0:
        return False, f"gh project list falhou: {(out + err).strip()[:200]}"
    try:
        projects = json_list(parse_json(out), "projects")
    except Exception as e:
        return False, f"resposta inválida de gh project list: {e}"
    match = next((p for p in projects if norm(p.get("title", "")) == norm(ref)), None)
    if not match:
        titles = ", ".join(f"'{p.get('title', '')}'" for p in projects) or "(nenhum)"
        return False, f"Project '{ref}' não encontrado (projetos: {titles}) — use número/URL/título exato"
    return True, match


def project_set_status(project_ref: str, item_url: str, want: str) -> tuple[bool, str]:
    """Define o campo Status do Project para a issue (Backlog/In Progress/Done via allowlist)."""
    num = issue_number_from_url(item_url)
    if not num:
        return False, "URL da issue inválida para localizar o item no Project"
    ok_p, proj = resolve_project(project_ref)
    if not ok_p:
        return False, str(proj)
    proj = proj if isinstance(proj, dict) else {}
    pnum, pid = str(proj.get("number", "")), str(proj.get("id", ""))
    if not (pnum and pid):
        return False, "Project sem number/id — não é possível editar o item"
    o = str((proj.get("owner") or {}).get("login", "")) if isinstance(proj.get("owner"), dict) else ""
    own = o or owner()
    code, out, err = gh_run(["project", "item-list", pnum, "--owner", own, "--limit", "500", "--format", "json"], timeout=120)
    if code != 0:
        return False, f"gh project item-list falhou: {(out + err).strip()[:200]}"
    try:
        items = json_list(parse_json(out), "items")
    except Exception as e:
        return False, f"resposta inválida de gh project item-list: {e}"
    item = next((i for i in items
                 if issue_number_from_url(str((i.get("content") or {}).get("url", ""))) == num), None)
    if not item:
        return False, f"issue `#{num}` não está no Project `{proj.get('title', pnum)}` — rode add-to-project antes"
    code, out, err = gh_run(["project", "field-list", pnum, "--owner", own, "--format", "json"], timeout=30)
    if code != 0:
        return False, f"gh project field-list falhou: {(out + err).strip()[:200]}"
    try:
        fields = json_list(parse_json(out), "fields")
    except Exception as e:
        return False, f"resposta inválida de gh project field-list: {e}"
    field = next((f for f in fields if norm(f.get("name", "")) == "status"), None)
    if not field:
        names = ", ".join(f.get("name", "") for f in fields) or "(nenhum)"
        return False, f"campo `Status` não existe no Project (campos: {names})"
    option = match_status_option(field.get("options") or [], want)
    if not option:
        opts = ", ".join(o.get("name", "") for o in field.get("options") or []) or "(nenhuma)"
        return False, f"opção '{want}' não existe no campo Status (opções: {opts}) — nunca inventa destino"
    code, out, err = gh_run(["project", "item-edit", "--id", str(item.get("id")), "--project-id", pid,
                             "--field-id", str(field.get("id")), "--single-select-option-id", str(option.get("id"))],
                            timeout=30)
    if code != 0:
        return False, f"gh project item-edit falhou: {(out + err).strip()[:200]}"
    return True, f"Project `{proj.get('title', pnum)}` → Status `{option.get('name')}`"


# ── Comandos ───────────────────────────────────────────────────────────────────
def cmd_ensure_labels(args) -> None:
    code, out, err = gh_run(["label", "list", "--limit", "200", "--json", "name"], timeout=30)
    existing: set[str] = set()
    if code == 0:
        try:
            existing = {norm(l.get("name", "")) for l in parse_json(out) if isinstance(l, dict)}
        except Exception:
            existing = set()
    created, skipped = [], []
    for lbl in DEFAULT_LABELS:
        if norm(lbl["name"]) in existing:
            skipped.append(lbl["name"])
            continue
        if args.dry_run:
            created.append(lbl["name"])
            continue
        c, o, e = gh_run(["label", "create", lbl["name"], "--color", lbl["color"],
                          "--description", lbl["description"]], timeout=30)
        if c == 0 or "already exists" in (o + e).lower():
            created.append(lbl["name"])
        else:
            print(f"⚠️ label `{lbl['name']}` falhou: {(o + e).strip()[:150]}", file=sys.stderr)
    print(json.dumps({"ok": True, "created": created, "existing": skipped, "dry_run": bool(args.dry_run)}, ensure_ascii=False))


def resolve_milestone(ref: str, create: bool = False) -> tuple[str | None, str]:
    """Resolve milestone por número ou título exato; cria se `create=True` e não existir."""
    ref = str(ref).strip()
    if ref.isdigit():
        return ref, ""
    slug = repo_slug()
    if not slug:
        return None, "sem remote origin e sem --repo — não dá para resolver milestones"
    code, out, err = gh_run(["api", f"repos/{slug}/milestones?state=open&per_page=100"], timeout=30)
    if code != 0:
        return None, f"falha ao listar milestones: {(out + err).strip()[:200]}"
    try:
        ms = [m for m in parse_json(out) if isinstance(m, dict)]
    except Exception as e:
        return None, f"resposta inválida ao listar milestones: {e}"
    match = next((m for m in ms if norm(m.get("title", "")) == norm(ref)), None)
    if match:
        return str(match.get("number")), ""
    if not create:
        titles = ", ".join(m.get("title", "") for m in ms) or "(nenhum)"
        return None, f"milestone '{ref}' não encontrada (abertas: {titles})"
    code, out, err = gh_run(["api", "-X", "POST", f"repos/{slug}/milestones", "-f", f"title={ref}"], timeout=30)
    if code != 0:
        return None, f"falha ao criar milestone '{ref}': {(out + err).strip()[:200]}"
    try:
        return str(parse_json(out).get("number")), ""
    except Exception:
        return None, "milestone criada mas resposta inválida"


def cmd_ensure_milestone(args) -> None:
    num, err = resolve_milestone(args.title, create=True)
    if not num:
        print(f"MILESTONE_FAILED: {err}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"ok": True, "milestone": args.title, "number": num}, ensure_ascii=False))


def cmd_create_issue(args) -> None:
    """planner — CRIA a issue (card) com labels separadas de prioridade/tipo/domínio + sprint + Project."""
    labels = [l.strip() for l in (args.labels or "").split(",") if l.strip()]
    body = Path(args.body_file).read_text(encoding="utf-8") if args.body_file else (args.body or "")
    cmd = ["issue", "create", "--title", args.title, "--body", body]
    for l in labels:
        cmd += ["--label", l]
    if args.milestone:
        num, err = resolve_milestone(args.milestone, create=True)
        if not num:
            print(f"ISSUE_FAILED: milestone inválida — {err}", file=sys.stderr)
            sys.exit(1)
        cmd += ["--milestone", num]
    if args.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "would": " ".join(cmd)}, ensure_ascii=False))
        return
    code, out, err = gh_run(cmd, timeout=60)
    if code != 0:
        print(f"ISSUE_FAILED: gh issue create falhou: {(out + err).strip()[:300]}", file=sys.stderr)
        sys.exit(1)
    url = out.strip().splitlines()[-1] if out.strip() else ""
    num = issue_number_from_url(url)
    if not num:
        print(f"ISSUE_FAILED: URL não reconhecida na saída: {url[:200]}", file=sys.stderr)
        sys.exit(1)
    result: dict[str, Any] = {"ok": True, "number": num, "url": url, "labels": labels}
    if args.project:
        ok_p, msg_p = project_set_status(args.project, url, args.status or "Backlog")
        result["project_ok"] = ok_p
        result["project"] = msg_p
        if not ok_p:
            print(f"⚠️ issue criada, mas Project falhou: {msg_p}", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False))


def cmd_add_to_project(args) -> None:
    ok_p, proj = resolve_project(args.project)
    if not ok_p:
        print(f"PROJECT_FAILED: {proj}", file=sys.stderr)
        sys.exit(1)
    proj = proj if isinstance(proj, dict) else {}
    code, out, err = gh_run(["issue", "view", str(args.issue), "--json", "url"], timeout=30)
    if code != 0:
        print(f"ISSUE_FAILED: issue #{args.issue} não encontrada: {(out + err).strip()[:150]}", file=sys.stderr)
        sys.exit(1)
    try:
        url = str(parse_json(out).get("url", ""))
    except Exception:
        url = ""
    own = str((proj.get("owner") or {}).get("login", "")) if isinstance(proj.get("owner"), dict) else ""
    code, out, err = gh_run(["project", "item-add", str(proj.get("number")), "--owner", own or owner(), "--url", url], timeout=30)
    if code != 0:
        print(f"PROJECT_FAILED: item-add falhou: {(out + err).strip()[:200]}", file=sys.stderr)
        sys.exit(1)
    status_note = ""
    if args.status:
        ok_s, msg_s = project_set_status(str(proj.get("number")), url, args.status)
        status_note = msg_s
        if not ok_s:
            print(f"⚠️ item adicionado, mas status falhou: {msg_s}", file=sys.stderr)
    print(json.dumps({"ok": True, "issue": args.issue, "project": proj.get("title"), "status": status_note}, ensure_ascii=False))


def cmd_move_issue(args) -> None:
    """builder — SÓ move/atualiza: Status do Project (→ In Progress) + assignee. Nunca cria."""
    notes: list[str] = []
    if args.assign_me:
        code, _, err = gh_run(["issue", "edit", str(args.issue), "--add-assignee", "@me"], timeout=30)
        notes.append("assignee `@me` ok" if code == 0 else f"assignee falhou: {err.strip()[:120]}")
    if args.status:
        if not args.project:
            print("MOVE_FAILED: --project obrigatório para mover o Status do Project (ou omita --status e use só --assign-me)", file=sys.stderr)
            sys.exit(1)
        code, out, err = gh_run(["issue", "view", str(args.issue), "--json", "url"], timeout=30)
        if code != 0:
            print(f"ISSUE_FAILED: issue #{args.issue} não encontrada: {(out + err).strip()[:150]}", file=sys.stderr)
            sys.exit(1)
        try:
            url = str(parse_json(out).get("url", ""))
        except Exception:
            url = ""
        ok, msg = project_set_status(args.project, url, args.status)
        if not ok:
            print(f"MOVE_FAILED: {msg}", file=sys.stderr)
            sys.exit(1)
        notes.append(msg)
    if not notes:
        print("MOVE_FAILED: nada a fazer — passe --status e/ou --assign-me", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"ok": True, "issue": args.issue, "detail": "; ".join(notes)}, ensure_ascii=False))


def cmd_close_issue(args) -> None:
    """shipper — SÓ encerra: fecha a issue (+ Status Done no Project). Nunca cria."""
    code, out, err = gh_run(["issue", "view", str(args.issue), "--json", "number,title,state,url"], timeout=30)
    if code != 0:
        print(f"ISSUE_FAILED: issue #{args.issue} não encontrada: {(out + err).strip()[:150]}", file=sys.stderr)
        sys.exit(1)
    try:
        issue = parse_json(out)
    except Exception as e:
        print(f"ISSUE_FAILED: resposta inválida: {e}", file=sys.stderr)
        sys.exit(1)
    result: dict[str, Any] = {"ok": True, "issue": issue.get("number"), "title": issue.get("title"), "url": issue.get("url")}
    already = issue.get("state") == "CLOSED"
    if already:
        result["closed"] = True
        result["already_closed"] = True
    else:
        if args.comment:
            gh_run(["issue", "comment", str(args.issue), "--body", args.comment], timeout=30)
        c, o, e = gh_run(["issue", "close", str(args.issue), "--reason", "completed"], timeout=30)
        if c != 0:
            print(f"CLOSE_FAILED: {(o + e).strip()[:250]}", file=sys.stderr)
            sys.exit(1)
        cv, ov, _ = gh_run(["issue", "view", str(args.issue), "--json", "state"], timeout=30)
        try:
            result["closed"] = cv == 0 and parse_json(ov).get("state") == "CLOSED"
        except Exception:
            result["closed"] = False
    if args.project:
        ok_p, msg_p = project_set_status(args.project, str(issue.get("url", "")), args.status or "Done")
        result["project_ok"] = ok_p
        result["project"] = msg_p
        if not ok_p:
            print(f"⚠️ issue fechada, mas Project falhou: {msg_p}", file=sys.stderr)
    if not result.get("closed"):
        print("CLOSE_FAILED: fechamento não verificado via gh issue view", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))


def cmd_find_issue(args) -> None:
    cmd = ["issue", "list", "--state", "open", "--limit", "20", "--json", "number,title,url,labels"]
    if args.query:
        cmd += ["--search", args.query]
    code, out, err = gh_run(cmd, timeout=30)
    if code != 0:
        print(f"FIND_FAILED: {(out + err).strip()[:250]}", file=sys.stderr)
        sys.exit(1)
    try:
        issues = [i for i in parse_json(out) if isinstance(i, dict)]
    except Exception as e:
        print(f"FIND_FAILED: resposta inválida: {e}", file=sys.stderr)
        sys.exit(1)
    out = [{"number": i.get("number"), "title": i.get("title"), "url": i.get("url"),
            "labels": [l.get("name") if isinstance(l, dict) else l for l in (i.get("labels") or [])]}
           for i in issues]
    print(json.dumps({"ok": True, "count": len(out), "issues": out}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description="CLI determinístico do backlog GitHub (issues/labels/milestones/Projects)")
    parser.add_argument("--repo", default=os.environ.get("SDD_GITHUB_REPO", ""), help="owner/repo (default: remote origin)")
    parser.add_argument("--dry-run", action="store_true", help="ensure-labels/create-issue: não aplica mutações — só reporta")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ensure-labels", help="Cria labels padrão de prioridade (P0..P3) e tipo (epic/feature/bug/chore/docs) — idempotente")
    p.set_defaults(func=cmd_ensure_labels)

    p = sub.add_parser("ensure-milestone", help="Cria/resolves milestone (sprint) por título — idempotente")
    p.add_argument("title")
    p.set_defaults(func=cmd_ensure_milestone)

    p = sub.add_parser("create-issue", help="Cria issue (card) — único comando de criação, papel do planner")
    p.add_argument("--title", required=True)
    p.add_argument("--body", default="")
    p.add_argument("--body-file", default="")
    p.add_argument("--labels", default="", help="Labels separadas por vírgula (prioridade + tipo + domínio, ex.: 'P1-high,feature,auth')")
    p.add_argument("--milestone", default="", help="Sprint (milestone) por título ou número")
    p.add_argument("--project", default="", help="GitHub Project (título/número/URL) — adiciona a issue e define o Status")
    p.add_argument("--status", default="", help="Status inicial no Project (default: Backlog)")
    p.set_defaults(func=cmd_create_issue)

    p = sub.add_parser("add-to-project", help="Adiciona issue existente a um Project")
    p.add_argument("issue", type=int)
    p.add_argument("--project", required=True)
    p.add_argument("--status", default="")
    p.set_defaults(func=cmd_add_to_project)

    p = sub.add_parser("move-issue", help="Move issue para execução (Status In Progress + assignee) — papel do builder")
    p.add_argument("issue", type=int)
    p.add_argument("--status", default="In Progress")
    p.add_argument("--project", default="", help="GitHub Project (título/número/URL)")
    p.add_argument("--assign-me", action="store_true")
    p.set_defaults(func=cmd_move_issue)

    p = sub.add_parser("close-issue", help="Encerra issue (fecha + Status Done) — papel do shipper")
    p.add_argument("issue", type=int)
    p.add_argument("--comment", default="", help="Comentário de encerramento (ex.: link do PR)")
    p.add_argument("--project", default="", help="GitHub Project para mover Status → Done")
    p.add_argument("--status", default="Done")
    p.set_defaults(func=cmd_close_issue)

    p = sub.add_parser("find-issue", help="Lista issues abertas (busca opcional por título)")
    p.add_argument("query", nargs="?", default="")
    p.set_defaults(func=cmd_find_issue)

    args = parser.parse_args()
    if args.dry_run and args.cmd not in ("ensure-labels", "create-issue"):
        parser.error("--dry-run só é suportado em ensure-labels e create-issue")
    auth_gate()
    set_repo(args.repo)
    args.func(args)


if __name__ == "__main__":
    main()
