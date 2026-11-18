#!/usr/bin/env python3
"""find_skill.py — descobre skills LOCAIS na pasta skills/ (sem rede).

Indexa skills/*/SKILL.md (nome + description) e rankeia pela query.
Busca 100% offline: nenhum npx, nenhum skills.sh, nenhum install externo.

Uso:
  find_skill.py "github issues"           # busca por termos
  find_skill.py --all                     # lista todas as skills locais
Saída: "<caminho do SKILL.md>  <nome> — <descrição>" por relevância.
Exit 0 = encontrou; 1 = nada encontrado.
"""
import argparse
import re
import sys
import unicodedata
from pathlib import Path

TOP_KEY_RE = re.compile(r"^[A-Za-z_-]+:")


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
        description="Busca skills LOCAIS na pasta skills/ (offline, sem npx).",
    )
    ap.add_argument("query", nargs="*", help="termos de busca")
    ap.add_argument("--all", action="store_true", help="lista todas as skills locais")
    args = ap.parse_args()

    entries = collect()
    if not entries:
        print("Nenhuma skill local encontrada (pasta skills/ vazia?).", file=sys.stderr)
        return 1

    if args.all:
        for e in entries:
            print(f"{e['path']}  {e['name']} — {short(e['desc'])}")
        return 0

    tokens = [t for part in args.query for t in norm(part).split() if t]
    if not tokens:
        ap.error("informe termos de busca ou use --all")

    scored = [(score(tokens, e["name"], e["desc"], e["path"].parent.name), e) for e in entries]
    ranked = sorted(
        (x for x in scored if x[0] > 0),
        key=lambda x: (-x[0], x[1]["path"].parent.name),
    )
    if not ranked:
        print(f"Nenhuma skill local encontrada para: {' '.join(args.query)}", file=sys.stderr)
        return 1
    for _, e in ranked:
        print(f"{e['path']}  {e['name']} — {short(e['desc'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
