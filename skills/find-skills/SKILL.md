---
name: find-skills
description: >-
  Helps users discover agent skills for a task by searching the local skills/
  folder of this repository (deterministic offline search via
  scripts/find_skill.py) and, on explicit opt-in (--remote), suggesting relevant
  skills from skills.sh for user approval before any install. Use when the user
  or an agent needs a skill for any domain or asks "is there a skill for X".
  This skill itself is a locator, not a domain skill.
---

# Find Skills — busca local primeiro, remota por opt-in

Ajuda a descobrir a skill certa para uma operação: **primeiro na pasta `skills/` deste repositório** (offline); com `--remote`, também **sugere** skills da skills.sh — instalação só com aprovação explícita do usuário.

## Regra de ouro — LOCAL primeiro, REMOTA opt-in

- **Padrão é offline:** busque só nos `skills/*/SKILL.md` locais. Sem `--remote`, proibido tocar em rede/npx.
- **`--remote` = sugestão, nunca install:** resultados da skills.sh são candidatos a mostrar ao usuário. **Proibido instalar** (`npx skills add`) sem o usuário aprovar a skill específica.
- **Instalação com aprovação:** após o usuário escolher, (1) rode auditoria pública `find_skill.py --audit <id>` e apresente o resultado; (2) se aprovado sem achado de segurança, rode `npx skills add <source>`; (3) confirme com busca local (`find_skill.py "<termo>"`) que o `SKILL.md` chegou na pasta de skills.
- Não encontrou skill local (nem remota aprovada)? Execute a operação com o critério do próprio agente.

## Como buscar (determinístico)

### 1. Script de busca (preferido)

```bash
python3 skills/find-skills/scripts/find_skill.py "<termos>"            # local (offline)
python3 skills/find-skills/scripts/find_skill.py "<termos>" --remote   # local + sugestões skills.sh
python3 skills/find-skills/scripts/find_skill.py "<termos>" --remote --json   # saída máquina para macros
python3 skills/find-skills/scripts/find_skill.py --audit "owner/repo/slug"    # auditoria de segurança
# projeto instalado (mirror):
python3 .opencode/skills/find-skills/scripts/find_skill.py "<termos>"
```

- Local: `<caminho do SKILL.md>  <nome> — <descrição>`, ordenado por relevância.
- Remoto: `[REMOTE] <url>  <nome> — <fonte> · N installs · instalar: npx skills add <fonte>`, por installs.
- `--all` lista todas as skills locais. Exit 0 = encontrou; 1 = nada.
- Endpoint remoto: público `skills.sh/api/search` (o mesmo do CLI oficial `npx skills`); falha em aberto — erro vira warning e a resposta segue local-only.

### 2. Fallback com ferramentas nativas (sem bash)

```text
glob  "skills/*/SKILL.md"
grep  "<termo>"   path="skills"  include="*/SKILL.md"   (caseSensitive: false)
```

### 3. Ler e seguir

Abra o `SKILL.md` da skill escolhida e **siga-a** — ela manda no fluxo da operação (ex.: github-cli manda em auth (`gh auth status`), caminhos do CLI e tratamento de erros).

## Fluxo do planner com sugestão remota

Na etapa de planejamento, para cada domínio sem skill local adequada:

1. Rode `find_skill.py "<domínio>" --remote --limit 8`.
2. Inclua os candidatos na seção **Skills sugeridas** do plano em HTML (skill de revisão do plano — `plan-review`): nome, fonte, installs, link da skills.sh e comando de install.
3. **Instale só as aprovadas pelo usuário** (com `--audit` antes) e registre aprovadas/rejeitadas no `PLAN.md` (em memória).

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
| `acp agent opencode codex` | `acp-client` |
| `plan review html lavish` | `plan-review` |

## Sem skill local

1. Diga explicitamente: "nenhuma skill local encontrada para <termos>".
2. Com `--remote`, apresente as candidatas ao usuário e aguarde a escolha (não instale por conta própria).
3. Sem candidato aprovado, execute a operação com o critério do agente/arquivo que a pediu.
4. Se a operação é recorrente, sugira criar a skill **dentro de `skills/`** (não fora).
