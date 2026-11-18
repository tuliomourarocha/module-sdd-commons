---
name: find-skills
description: >-
  Helps users discover agent skills for a task by searching ONLY the local
  skills/ folder of this repository. Deterministic offline search via
  scripts/find_skill.py — no network, no npx, no external installs. Use when
  the user or an agent needs a skill for any domain or asks "is there a skill
  for X". This skill itself is a locator, not a domain skill.
---

# Find Skills — busca local

Ajuda a descobrir a skill certa para uma operação, buscando **apenas na pasta `skills/` deste repositório**. Nada de rede: o catálogo é o que está instalado aqui.

## Regra de ouro — SOMENTE local

- **Proibido:** `npx skills find`, `npx skills add`, skills.sh, GitHub, qualquer busca/install externo.
- **Fonte da verdade:** os `skills/*/SKILL.md` locais.
- Não encontrou skill local? Reporte "nenhuma skill local para X" e execute a operação com o critério do próprio agente. **Nunca instale de fora.**

## Como buscar (determinístico)

### 1. Script de busca (preferido)

```bash
python3 skills/find-skills/scripts/find_skill.py "<termos>"
# projeto instalado (mirror):
python3 .opencode/skills/find-skills/scripts/find_skill.py "<termos>"
```

- Saída: `<caminho do SKILL.md>  <nome> — <descrição>`, ordenado por relevância.
- `--all` lista todas as skills locais.
- Exit 0 = encontrou; 1 = nada encontrado.

### 2. Fallback com ferramentas nativas (sem bash)

```text
glob  "skills/*/SKILL.md"
grep  "<termo>"   path="skills"  include="*/SKILL.md"   (caseSensitive: false)
```

### 3. Ler e seguir

Abra o `SKILL.md` da skill escolhida e **siga-a** — ela manda no fluxo da operação (ex.: github-cli manda em auth (`gh auth status`), caminhos do CLI e tratamento de erros).

## Catálogo local (não exaustivo — o script é a fonte da verdade)

| Query típica | Skill local |
|--------------|-------------|
| `github issues` (issues/labels/milestones/Projects, backlog) | `github-cli` |
| `state manager handoff` (STATE/HANDOFF) | `state-manager` |
| `clean architecture solid` | `clean-architecture`, `solid` |
| `clean code` | `clean-code` |
| `git commit github cli` | `git-commit`, `github-cli` |
| `frontend design`, `web design guidelines` | `frontend-design`, `web-design-guidelines` |
| `react nextjs typescript` | `nextjs-react-typescript`, `react-best-practices`, `typescript-expert` |
| `deploy vercel` | `deploy-to-vercel`, `vercel-cli-with-tokens` |

## Sem skill local

1. Diga explicitamente: "nenhuma skill local encontrada para <termos>".
2. Execute a operação com o critério do agente/arquivo que a pediu.
3. Se a operação é recorrente, sugira criar a skill **dentro de `skills/`** (não fora).
