# Global Rules — module-sdd-commons

Regras globais que se aplicam a todos os agentes neste projeto.

## Harness V2 — 5 Macros

| Agente | Papel | Quando |
|--------|-------|--------|
| `harness` | Orquestra 3 fluxos via `task()` | Sempre primeiro |
| `planner` | **Planeja** — PRD, PLAN, arquitetura | Gate 1 |
| `builder` | **Implementa** — full-stack + infra mínima | Gate 2 |
| `checker` | **Valida** — testes unit/API/e2e | Gate 3a (paralelo) |
| `reviewer` | **Revisa** — lint, typecheck, code review | Gate 3b (paralelo) |
| `shipper` | **Finaliza** — commit, PR, CI, Trello close | Gate 4 |

Fluxos: `feature` (planner→builder→checker∥reviewer→shipper), `project` (discover→scaffold→loop feature→finalize), `bugfix` (triage→fix→check/review→ship).

## Estrutura do Projeto

- `agents/` — 6 agentes V2 (harness, planner, builder, checker, reviewer, shipper)
- `commands/` — `harness.prompt.md` (fluxos)
- `skills/` — 28 habilidades carregadas sob demanda pelos macros
- `packs/` — `agentic-squad` (harness V2)
- `.planning/` — `PRD.md` (planner), `PLAN.md` (planner), `SUMMARY.md` (builder), `VALIDATION.md` (checker), `REVIEW.md` (reviewer), `STATE.md`/`HANDOFF.md` (shipper único escritor)

## Regras Gerais

1. **Progressive Disclosure** — Agentes são concisos (≤120 linhas); detalhe em `commands/harness.prompt.md`.
2. **Autossuficiência** — Cada macro incorpora regras e hooks; não busca regras externas.
3. **Skills > Subagentes** — Especialidade via skill, não via agente folha. Só `harness` usa `task()`.
4. **Estado único** — Só `shipper` escreve `STATE.md`/`HANDOFF.md` e faz Trello sync; macros retornam artefatos em memória.
5. **Idioma** — Português padrão para artefatos.
6. **Validação** — Execute hooks antes de finalizar cada artefato.