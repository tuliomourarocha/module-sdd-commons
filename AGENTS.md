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
| `ci-watch` | **Verifica CI (hook)** — polling `gh pr checks` + `gh run list` via `hooks/ci_watch.py` + `plugins/ci-watch.ts`; se falhar, inicia loop builder (max 2); orquestrador opcional `hooks/ci_orchestrator.py` com LangGraph | Pós-shipper (Gate 4+) |

> **Guard rails** (lint, typecheck, testes, ruff/pylance/eslint/biome, secrets, size) são **hooks determinísticos** (`hooks/guard_rails.py` + `plugins/guard-rails.ts`) — single source of truth. `checker` removido. **CI watch** é hook determinístico pós-shipper (`hooks/ci_watch.py` + `plugins/ci-watch.ts`) que aguarda conclusão do CI e dispara loop de correção; orquestração avançada opcional via `hooks/ci_orchestrator.py` (LangGraph StateGraph) sem dependência obrigatória.

Fluxos: `feature` (planner→builder→reviewer→shipper(hook)→ci-watch→supervisor), `project` (discover→scaffold→loop feature→finalize via hook+ci-watch), `bugfix` (triage→fix→review→ship(hook)→ci-watch).

## Estrutura do Projeto

- `agents/` — 5 agentes V2 (harness, planner, builder, reviewer, shipper minimal) + `supervisor` (observability via hook)
- `commands/` — `harness.prompt.md` (fluxos)
- `skills/` — 28 habilidades carregadas sob demanda pelos macros
- `packs/` — `agentic-squad` (harness V2)
- `hooks/` — `guard_rails.py` ( pós-edição), `shipper.py` (git/PR/Trello/STATE), `ci_watch.py` (polling CI + retry), `ci_orchestrator.py` (LangGraph opcional), `supervisor.py` (auditoria)
- `plugins/` — `guard-rails.ts`, `shipper.ts`, `ci-watch.ts`, `supervisor.ts` (hooks determinísticos)
- `.planning/` — apenas `STATE.md`/`HANDOFF.md` (single source; shipper, ci-watch, supervisor e orquestrador atualizam esses dois via marcadores CI_REPORT/SUPERVISOR/ORCHESTRATOR ao invés de criar .md separados). Artefatos de planejamento (`PRD.md`, `PLAN.md`, `arch/*`) e saídas de builder/reviewer (resumo/parecer) são **em memória** e nunca em disco — `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md` são **PROIBIDOS** como arquivos separados.

## Regras Gerais

1. **Progressive Disclosure** — Agentes são concisos (≤120 linhas); detalhe em `commands/harness.prompt.md`.
2. **Autossuficiência** — Cada macro incorpora regras e hooks; não busca regras externas.
3. **Skills > Subagentes** — Especialidade via skill, não via agente folha. Só `harness` usa `task()`.
4. **Estado único** — `shipper`, `ci-watch`, `supervisor` e `orquestrador` atualizam `STATE.md`/`HANDOFF.md` (via marcadores) e fazem Trello/PR/CI; macros retornam artefatos em memória.
5. **Idioma** — Português padrão para artefatos.
6. **Validação** — Execute hooks antes de finalizar cada artefato.
7. **Anti-loop e Single-run** — Apenas `STATE.md`/`HANDOFF.md` persistem em disco (hooks `shipper`, `ci-watch`, `supervisor`, `orquestrador` atualizam esses dois). Demais artefatos (`PRD.md`, `PLAN.md`, `arch/*`) e saídas de builder/reviewer (resumo/parecer) são retornados **em memória** via `task()` e injetados como `context:` pelo `harness`. Proibido criar `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md` em disco — bloqueado com `HIGH`. `harness` é **single-run (invocado uma única vez por fluxo, bloqueante até hooks finalizarem)** — não re-invoque externamente enquanto CI/supervisor não concluírem. `VALIDATION.md` removido (hook guard_rails).

## Memória e Política de Artefatos — Restrição Obrigatória

> Objetivo: impedir criação de artefatos em disco fora de `HANDOFF`/`STATE`, evitando loop de verificação e garantindo reaproveitamento de contexto via injeção única do `harness`.

- **Persistência em disco (allow):** Apenas `.planning/STATE.md` e `.planning/HANDOFF.md`, e **exclusivamente pelos hooks** `shipper` (Gate 4), `ci-watch`, `supervisor` e `orquestrador` (atualizam esses dois via marcadores). `permission` desses hooks permite apenas esses dois arquivos; `deny` para demais `.planning/**`.
- **Artefatos em memória (deny em disco):** `PRD.md`, `PLAN.md` e `arch/*` **NUNCA** são escritos como arquivos. O macro gera o conteúdo e retorna em memória ao `harness` (`return {artefato}`); `harness` injeta como `context:` no próximo macro. **PROIBIDO criar** `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md`/`ci_metrics.json`/`ORCHESTRATOR_STATE.json` — qualquer `write`/`edit`/`bash` que tente criar esses artefatos ou qualquer `.planning/**` fora de `STATE`/`HANDOFF` deve ser negado por `permission: deny` e tratado como erro `HIGH`. `VALIDATION.md` removido.
- **Hooks ci-watch/supervisor/orquestrador:** Também só podem atualizar `STATE.md`/`HANDOFF.md` (marcadores `CI_REPORT:START`, `SUPERVISOR:START`, `ORCHESTRATOR:START` etc.) — **nunca criar `CI_REPORT.md`, `SUPERVISOR_REPORT.md`, `ci_metrics.json`, `ORCHESTRATOR_STATE.json` como arquivos separados** (bloqueado com HIGH; legado só via env `CI_WATCH_LEGACY=1`/`SUPERVISOR_LEGACY=1`).
- **Harness single-run:** `harness` é invocado **uma única vez** por fluxo e permanece **bloqueante** até `ci-watch` (CI pass) + `supervisor` concluírem — não re-invoque externamente; faça polling em `STATE.md`/`HANDOFF.md` + `HOOKS.log` para aguardar.
- **Injeção única:** `harness` lê `STATE.md`/`HANDOFF.md` **uma vez** no início e repassa; macros **NÃO** releem `.planning/*.md` se já injetado — usam o `context:` recebido. Releitura só se `context:` ausente.
- **Reaproveitamento:** `STATE` guarda `flow`, `gate`, `artifacts status`, `next step`; `HANDOFF` guarda o que foi feito, arquivos alterados, decisões e pendências — próximo agente consome sem re-verificar artefatos antigos.
- **Permissions por agente:**
  - `harness`: `edit: deny`, `bash: deny` (só orquestra).
  - `planner|builder|reviewer`: `edit: deny` para `.planning/**` (inclui `PRD/PLAN/SUMMARY/REVIEW/VALIDATION/arch`), `allow` apenas para código-fonte do escopo do gate; tentativa de escrita em `.planning/**` é bloqueada (especialmente `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` → `HIGH`). Guard rails em hooks, não em agents.
  - `shipper`: `edit: allow` apenas para `.planning/HANDOFF.md` e `.planning/STATE.md` (fallback minimal); `deny` para demais `.planning/**`. Hook `shipper.py` é primário para git/PR/Trello.
- **Violação:** Se um agente tentar `write` em `.planning/PRD.md` etc., o sistema nega por `permission` e o agente deve retornar o conteúdo em memória em vez de persistir. CI/review deve apontar `HIGH` se detectar artefato fora de `STATE`/`HANDOFF` criado em disco. Criação de `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` é sempre `HIGH`.
