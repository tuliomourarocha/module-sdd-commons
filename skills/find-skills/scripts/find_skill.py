#!/usr/bin/env python3
"""find_skill.py — descobre skills LOCAIS na pasta skills/ e, com --remote, na skills.sh.

Indexa skills/*/SKILL.md (nome + description) e rankeia pela query.
Modo padrão é 100% offline: nenhum npx, nenhum skills.sh, nenhum install externo.
`--remote` (opt-in) adiciona resultados da skills.sh (endpoint público /api/search,
o mesmo do CLI oficial `npx skills`) — SUGESTÕES que exigem aprovação do usuário
antes de qualquer install.

Uso:
  find_skill.py "github issues"                 # busca local (offline)
  find_skill.py "github issues" --remote        # local + sugestões da skills.sh
  find_skill.py "github issues" --remote --limit 10
  find_skill.py --all                           # lista todas as skills locais
  find_skill.py --audit <id>                    # auditoria de segurança de 1 skill remota
  find_skill.py "<q>" --remote --json           # saída máquina para macros
Saída: "<caminho do SKILL.md>  <nome> — <descrição>" (local) e
  "[REMOTE] <url>  <nome> — <fonte> · N installs · instalar: npx skills add <fonte>".
Exit 0 = encontrou; 1 = nada encontrado.
"""
import argparse
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

TOP_KEY_RE = re.compile(r"^[A-Za-z_-]+:")

SKILLS_SH_SEARCH = "https://skills.sh/api/search?q={q}&limit={limit}"
SKILLS_SH_AUDIT = "https://skills.sh/api/v1/skills/audit/{id}"
UA = "sdd-harness-find-skills/2.3 (local-first; remote opt-in)"


def skills_root():
    # este script vive em <...>/skills/find-skills/scripts/find_skill.py → a
    # pasta skills/ é três níveis acima (scripts → find-skills → skills);
    # funciona no fonte e em qualquer target instalado.
    return Path(__file__).resolve().parent.parent.parent


def norm(text):
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def parse_skill_md(path):
    """Extrai name e description do frontmatter YAML (parser mínimo, stdlib)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return "", ""
    end = 1
    while end < len(lines) and lines[end].strip() != "---":
        end += 1
    block = lines[1:end]

    name = ""
    for line in block:
        m = re.match(r"^name:\s*(.+)$", line)
        if m:
            name = m.group(1).strip().strip("'\"")
            break

    desc, started = [], False
    for line in block:
        if started:
            if TOP_KEY_RE.match(line):  # próxima chave YAML → fim do bloco
                break
            if line.strip():
                desc.append(line.strip())
            continue
        m = re.match(r"^description:\s*(.*)$", line)
        if m:
            started = True
            first = m.group(1).strip()
            if first and first not in (">-", ">", "|", "|-", "|+"):
                desc.append(first)
    return name, " ".join(x for x in desc if x)


def score(tokens, name, desc, dirname):
    hay = norm(f"{dirname} {name} {desc}")
    matched = sum(1 for t in tokens if t in hay)
    if matched == 0:
        return 0
    s = matched
    if all(t in norm(name or dirname) for t in tokens):
        s += 2  # bônus: query inteira bate no nome
    return s


def short(desc, limit=150):
    desc = desc.strip()
    return (desc[: limit - 1] + "…") if len(desc) > limit else desc


def collect():
    root = skills_root()
    entries = []
    for d in sorted(root.iterdir()):
        skill_md = d / "SKILL.md"
        if d.is_dir() and skill_md.exists():
            name, desc = parse_skill_md(skill_md)
            entries.append({"path": skill_md, "name": name or d.name, "desc": desc})
    return entries


def main():
    ap = argparse.ArgumentParser(
        prog="find_skill.py",
        description="Busca skills LOCAIS na pasta skills/ (offline). --remote adiciona sugestões da skills.sh.",
    )
    ap.add_argument("query", nargs="*", help="termos de busca")
    ap.add_argument("--all", action="store_true", help="lista todas as skills locais")
    ap.add_argument("--remote", action="store_true", help="consulta também a skills.sh (opt-in; exige aprovação do usuário para instalar)")
    ap.add_argument("--limit", type=int, default=8, help="máximo de resultados remotos (1-200)")
    ap.add_argument("--audit", metavar="ID", help="auditoria de segurança de 1 skill (id '{source}/{slug}')")
    ap.add_argument("--json", action="store_true", help="saída máquina: {'local': [...], 'remote': [...] }")
    args = ap.parse_args()

    if args.audit:
        return audit_skill(args.audit, as_json=args.json)

    entries = collect()
    if not entries and not args.remote:
        print("Nenhuma skill local encontrada (pasta skills/ vazia?).", file=sys.stderr)
        return 1

    if args.all:
        if args.json:
            print(json.dumps({"local": [_e(e) for e in entries]}, ensure_ascii=False))
        else:
            for e in entries:
                print(f"{e['path']}  {e['name']} — {short(e['desc'])}")
        return 0

    if not args.query and not args.remote:
        ap.error("informe termos de busca ou use --all")

    tokens = [t for part in args.query for t in norm(part).split() if t]

    local = []
    if tokens:
        scored = [(score(tokens, e["name"], e["desc"], e["path"].parent.name), e) for e in entries]
        ranked = sorted(
            (x for x in scored if x[0] > 0),
            key=lambda x: (-x[0], x[1]["path"].parent.name),
        )
        local = [e for _, e in ranked]

    remote = []
    warn = None
    if args.remote:
        q = " ".join(args.query).strip()
        if len(q) < 2:
            ap.error("--remote exige termos de busca (mínimo 2 caracteres)")
        remote, warn = search_skills_sh(q, limit=args.limit)

    if args.json:
        print(json.dumps({"local": [_e(e) for e in local], "remote": remote, "warning": warn}, ensure_ascii=False))
    else:
        for e in local:
            print(f"{e['path']}  {e['name']} — {short(e['desc'])}")
        for r in remote:
            print(f"[REMOTE] {r['url']}  {r['name']} — {r['source']} · {r['installs']} installs · instalar: npx skills add {r['source']}")
    if not local and not remote:
        print(f"Nenhuma skill encontrada para: {' '.join(args.query)}", file=sys.stderr)
        return 1
    return 0


def _e(e):
    return {"path": str(e["path"]), "name": e["name"], "description": short(e["desc"], 300)}


def search_skills_sh(q, limit=8):
    """Endpoint público /api/search (o mesmo do CLI oficial `npx skills`).
    Falha em aberto: erro só aparece em stderr como warning e a resposta segue local-only."""
    url = SKILLS_SH_SEARCH.format(q=urllib.request.quote(q), limit=int(limit))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # rede, 401, shape inesperado → degrada para local
        print(f"warning: skills.sh indisponível ({exc}); seguindo apenas com skills locais.", file=sys.stderr)
        return [], str(exc)
    out = []
    for s in data.get("skills", []):
        sid = s.get("id") or f"{s.get('source','?')}/{s.get('skillId','?')}"
        out.append({
            "id": sid,
            "name": s.get("name") or s.get("skillId") or sid,
            "source": s.get("source") or sid,
            "installs": int(s.get("installs") or 0),
            "url": f"https://www.skills.sh/{sid}",
            "install": f"npx skills add {s.get('source') or sid}",
        })
    out.sort(key=lambda x: -x["installs"])
    return out, None


def audit_skill(skill_id, as_json=False):
    """Auditoria pública de segurança da skill ({source}/{slug}) — endpoint v1 sem token."""
    url = SKILLS_SH_AUDIT.format(id=urllib.request.quote(skill_id, safe="/"))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"warning: auditoria indisponível para {skill_id} ({exc})", file=sys.stderr)
        if as_json:
            print(json.dumps({"id": skill_id, "error": str(exc)}, ensure_ascii=False))
            return 1
        print(f"sem auditoria para {skill_id} — revise o SKILL.md na fonte antes de instalar.")
        return 1
    if as_json:
        print(json.dumps({"id": skill_id, "audit": data}, ensure_ascii=False))
    else:
        print(f"[AUDIT] {skill_id}: {json.dumps(data, ensure_ascii=False)[:400]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
