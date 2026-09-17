# Global Rules — module-sdd-commons

Regras globais que se aplicam a todos os agentes neste projeto.

## Harness V2 — 4 Macros + Hooks

| Agente | Papel | Quando |
|--------|-------|--------|
| `harness` | Orquestra 3 fluxos via `task()` | Sempre primeiro |
| `planner` | **Planeja** — PRD, PLAN, arquitetura | Gate 1 |
| `builder` | **Implementa** — full-stack + infra mínima | Gate 2 |
| `reviewer` | **Revisa** — só arquitetura técnica/software (sem lint/testes) | Gate 3 |
| `shipper` | **Finaliza (hook)** — git/PR/CI/Trello via `hooks/shipper.py` + `plugins/shipper.ts`; fallback minimal só STATE/HANDOFF | Gate 4 (hook) |

> **Guard rails** (lint, typecheck, testes, ruff/pylance/eslint/biome, secrets, size) são **hooks determinísticos** (`hooks/guard_rails.py` + `plugins/guard-rails.ts`) — single source of truth. `checker` removido.

Fluxos: `feature` (planner→builder→reviewer→shipper(hook)), `project` (discover→scaffold→loop feature→finalize via hook), `bugfix` (triage→fix→review→ship(hook)).

## Estrutura do Projeto

- `agents/` — 5 agentes V2 (harness, planner, builder, reviewer, shipper minimal) + `supervisor` (observability via hook)
- `commands/` — `harness.prompt.md` (fluxos)
- `skills/` — 28 habilidades carregadas sob demanda pelos macros
- `packs/` — `agentic-squad` (harness V2)
- `hooks/` — `guard_rails.py` ( pós-edição), `shipper.py` (git/PR/Trello/STATE), `supervisor.py` (auditoria)
- `plugins/` — `guard-rails.ts`, `shipper.ts`, `supervisor.ts` (hooks determinísticos)
- `.planning/` — `PRD.md` (planner), `PLAN.md` (planner), `SUMMARY.md` (builder), `REVIEW.md` (reviewer arquitetura), `STATE.md`/`HANDOFF.md` (shipper/hook único escritor)

## Regras Gerais

1. **Progressive Disclosure** — Agentes são concisos (≤120 linhas); detalhe em `commands/harness.prompt.md`.
2. **Autossuficiência** — Cada macro incorpora regras e hooks; não busca regras externas.
3. **Skills > Subagentes** — Especialidade via skill, não via agente folha. Só `harness` usa `task()`.
4. **Estado único** — Só `shipper` escreve `STATE.md`/`HANDOFF.md` e faz Trello sync; macros retornam artefatos em memória.
5. **Idioma** — Português padrão para artefatos.
6. **Validação** — Execute hooks antes de finalizar cada artefato.
7. **Anti-loop e Memória** — Apenas `STATE.md`/`HANDOFF.md` persistem em disco (via `shipper`/hook); demais artefatos (`PRD.md`, `PLAN.md`, `SUMMARY.md`, `REVIEW.md`, `arch/*`) são retornados **em memória** via `task()` e injetados como `context:` pelo `harness`. Proibido criar arquivos fora de `STATE`/`HANDOFF` — evita loop de verificação e reaproveita contexto. `VALIDATION.md` removido (hook guard_rails).

## Memória e Política de Artefatos — Restrição Obrigatória

> Objetivo: impedir criação de artefatos em disco fora de `HANDOFF`/`STATE`, evitando loop de verificação e garantindo reaproveitamento de contexto via injeção única do `harness`.

- **Persistência em disco (allow):** Apenas `.planning/STATE.md` e `.planning/HANDOFF.md`, e **exclusivamente pelo `shipper`** no Gate 4. `permission` do `shipper` permite apenas esses dois arquivos; `deny` para demais `.planning/**`.
- **Artefatos em memória (deny em disco):** `PRD.md`, `PLAN.md`, `SUMMARY.md`, `REVIEW.md` e `arch/*` **NUNCA** são escritos como arquivos. O macro gera o conteúdo e retorna em memória ao `harness` (`return {artefato}`); `harness` injeta como `context:` no próximo macro. Qualquer `write`/`edit`/`bash` que tente criar esses arquivos deve ser negado por `permission: deny` e tratado como erro. `VALIDATION.md` removido.
- **Injeção única:** `harness` lê `STATE.md`/`HANDOFF.md` **uma vez** no início e repassa; macros **NÃO** releem `.planning/*.md` se já injetado — usam o `context:` recebido. Releitura só se `context:` ausente.
- **Reaproveitamento:** `STATE` guarda `flow`, `gate`, `artifacts status`, `next step`; `HANDOFF` guarda o que foi feito, arquivos alterados, decisões e pendências — próximo agente consome sem re-verificar artefatos antigos.
- **Permissions por agente:**
  - `harness`: `edit: deny`, `bash: deny` (só orquestra).
  - `planner|builder|reviewer`: `edit: deny` para `.planning/**` (inclui `PRD/PLAN/SUMMARY/REVIEW/arch`), `allow` apenas para código-fonte do escopo do gate; tentativa de escrita em `.planning/**` é bloqueada. Guard rails em hooks, não em agents.
  - `shipper`: `edit: allow` apenas para `.planning/HANDOFF.md` e `.planning/STATE.md` (fallback minimal); `deny` para demais `.planning/**`. Hook `shipper.py` é primário para git/PR/Trello.
- **Violação:** Se um agente tentar `write` em `.planning/PRD.md` etc., o sistema nega por `permission` e o agente deve retornar o conteúdo em memória em vez de persistir. CI/review deve apontar `HIGH` se detectar artefato fora de `STATE`/`HANDOFF` criado em disco.
