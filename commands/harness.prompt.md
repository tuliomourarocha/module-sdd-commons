# Harness — 3 Fluxos com 4 Macros + Hooks

> Detalhe via progressive disclosure para `agents/harness.agent.md`. Leia apenas quando orquestrando.

## Fluxos

### Feature (padrão)
```
planner → builder → reviewer → shipper(hook) → ci-watch(hook) → supervisor → Done
```
1. **planner** — PRD + PLAN + arch (memória)
2. **builder** — código + resumo em memória (hook guard_rails valida per-file durante escrita) — **nunca** `SUMMARY.md` em disco
3. **reviewer** — parecer de arquitetura apenas em memória (sem lint/testes — hooks fazem) — **nunca** `REVIEW.md`/`VALIDATION.md` em disco
4. **shipper(hook)** — commit + PR + CI snapshot + STATE/HANDOFF + Trello (determinístico via `hooks/shipper.py` + `plugins/shipper.ts`; fallback `shipper` minimal só para STATE/HANDOFF)
5. **ci-watch(hook, bloqueante, single-run)** — polling `gh pr checks` + `gh run list` até conclusão (`hooks/ci_watch.py` + `plugins/ci-watch.ts`); **atualiza HANDOFF.md/STATE.md (CI_REPORT:START / CI_STATE) ao invés de criar CI_REPORT.md**; se falhar → loop `builder→reviewer→shipper→ci-watch` (max 2) **sem re-invocar harness**; orquestrador opcional `hooks/ci_orchestrator.py` com LangGraph StateGraph — também em HANDOFF/STATE
6. **supervisor(hook+agente, bloqueante, single-run)** — auditoria + Issue GitHub — **atualiza HANDOFF/STATE (SUPERVISOR:START) ao invés de criar SUPERVISOR_REPORT.md**

Gates humanos: após planner e após reviewer (2 total). Guard rails e ci-watch não são gate humano — bloqueiam per-file e pós-PR via hook (ci-watch aguarda CI bloqueante, single harness run, e se fail volta para builder max 2 sem re-invocar harness). **Harness permanece vivo até ci-watch + supervisor concluírem (single-run).**

### Project
```
planner(discover) → builder(scaffold) → loop feature × N → shipper(hook+finalize)
```
- discover: PRD roadmap + visão
- scaffold: estrutura + CI/CD + arch base (builder)
- finalize: deploy preview + docs (shipper hook)

### Bugfix
```
planner(triage) → builder(fix) → reviewer → shipper(hook)
```
- triage: reproduz, causa, escopo fix (PRD leve, não completo)

## Memória e Política de Artefatos — Anti-loop e Single-run

> **Apenas `STATE.md`/`HANDOFF.md` persistem em disco (via `shipper`/hook + `ci-watch`/`supervisor`/`orquestrador` via marcadores).** Demais artefatos (`PRD.md`, `PLAN.md`, `arch/*`) são **em memória** via `task()` e injetados como `context:` pelo `harness`. **PROIBIDO criar** `.planning/SUMMARY.md`, `.planning/REVIEW.md`, `.planning/VALIDATION.md`, `.planning/CI_REPORT.md`, `.planning/SUPERVISOR_REPORT.md`, `ci_metrics.json`, `ORCHESTRATOR_STATE.json` em disco — esses hooks **atualizam HANDOFF/STATE (marcadores CI_REPORT:START etc.) ao invés de criar arquivos**. `permission: .planning/** deny` para `planner|builder|reviewer` (HIGH se tentar); `shipper`/`ci-watch`/`supervisor`/`orquestrador` só `allow` para `STATE.md`/`HANDOFF.md`. `harness` lê `STATE`/`HANDOFF` **uma vez** e injeta; macros **NÃO** releem `.planning/*.md` se já injetado. **Harness é single-run (única invocação, bloqueante até hooks finalizarem)** — não re-invoque externamente; faça polling em STATE/HANDOFF + HOOKS.log. Propósito: evitar loop de verificação e reaproveitar contexto.

> `checker` removido — guard rails em `hooks/guard_rails.py`. `VALIDATION.md`/`SUMMARY.md`/`REVIEW.md` não existem como arquivos; validação é hook determinístico per-file + supervisor pós-shipper. Builder retorna resumo em memória, reviewer retorna parecer em memória.

## Pre-condições por transição

| De → Para | Validação | Falha |
|-----------|-----------|-------|
| planner → builder | `PRD.md` + `PLAN.md` retornados **em memória** (não em disco) | Bloquear, pedir ajuste planner |
| builder → reviewer | resumo em memória (nunca `SUMMARY.md`) + `npm run build` ok + **nenhum HIGH pendente em `guard_rails`** | Bloquear até HIGH corrigido (hook já bloqueou per-file) |
| reviewer → shipper | parecer em memória (nunca `REVIEW.md`) sem HIGH arquitetural | Loop builder max 2, depois escalar |
| shipper(hook) → ci-watch | PR criado + `STATE.md`/`HANDOFF.md` (únicos em disco) | Escalar humano |
| ci-watch(hook) → Done | CI verde (exit 0) + **HANDOFF.md#CI_REPORT:START + STATE.md#CI_STATE + HOOKS.log** (sem CI_REPORT.md) — harness single-run bloqueante | Se CI fail (exit 2) → loop builder max 2 com contexto extraído de HANDOFF.md (CI_REPORT:START); se pending timeout (exit 3) → re-poll sem encerrar harness |
| ci-watch fail → builder | **HANDOFF.md (CI_REPORT:START) + STATE.md (CI_STATE) + HOOKS.log** + logs falha | Builder corrige focado, reviewer revalida, shipper re-push, ci-watch re-polla (mesma run harness) |

## Anti-patterns
1. Pular planner e ir direto para builder
2. Rodar guard rails como agent (hooks são single source)
3. Fazer Trello sync fora do shipper hook
4. Escrever STATE/HANDOFF fora do shipper/hook (shipper, ci-watch, supervisor, orquestrador são únicos com allow)
5. Criar `.planning/PRD.md`/`PLAN.md`/`SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md`/`ci_metrics.json`/`ORCHESTRATOR_STATE.json` em disco — artefatos são em memória ou seções em HANDOFF/STATE — `SUMMARY/REVIEW/VALIDATION/CI_REPORT/SUPERVISOR_REPORT` são **PROIBIDOS** como arquivos separados
6. Re-ler `.planning/*.md` em disco quando já injetado como `context:` — causa loop de verificação
7. Loop infinito — max 2 iterações builder, depois humano decide
8. Reviewer rodando lint/testes — proibido, é hook
9. Re-invocar harness externamente enquanto CI/supervisor pending — **harness é single-run bloqueante**; faça polling em STATE.md/HOOKS.log

## Artefatos

```
.planning/  — persistência em disco APENAS (single source):
├── STATE.md            # shipper + ci-watch + supervisor + orquestrador (via marcadores, único lugar) — DISCO
├── HANDOFF.md          # shipper + ci-watch + supervisor + orquestrador (via marcadores, único lugar) — DISCO
└── (nenhum outro arquivo deve existir em disco — CI_REPORT.md, ci_metrics.json, CI_RETRIES.json, SUPERVISOR_REPORT.md, ORCHESTRATOR_STATE.json são PROIBIDOS como arquivos; seus conteúdos vão para seções em STATE/HANDOFF)

# Seções dentro de HANDOFF.md / STATE.md (idempotentes, marcadores):
HANDOFF.md:
  <!-- CI_REPORT:START --> ... relatório CI ... <!-- CI_REPORT:END -->
  <!-- SUPERVISOR:START --> ... auditoria ... <!-- SUPERVISOR:END -->
  <!-- ORCHESTRATOR:START --> ... estado orquestrador ... <!-- ORCHESTRATOR:END -->
STATE.md:
  <!-- CI_STATE:START --> métricas CI <!-- CI_STATE:END -->
  <!-- SUPERVISOR_STATE:START --> métricas supervisor <!-- SUPERVISOR_STATE:END -->
  <!-- ORCHESTRATOR_STATE:START --> estado orquestrador <!-- ORCHESTRATOR_STATE:END -->

Memória (via task() → harness injeta como context:, nunca em disco):
├── PRD.md          # planner → memória → builder
├── PLAN.md         # planner → memória → builder
├── resumo          # builder → memória → reviewer (NUNCA SUMMARY.md)
├── parecer         # reviewer → memória → shipper (só arquitetura, NUNCA REVIEW.md)
└── arch/epic-XX/   # planner → memória → builder

Removido (PROIBIDO criar em disco):
├── VALIDATION.md   # checker removido — substituído por hooks/guard_rails.py
├── SUMMARY.md      # builder retorna resumo em memória, não arquivo
├── REVIEW.md       # reviewer retorna parecer em memória, não arquivo
├── CI_REPORT.md    # agora seção em HANDOFF.md (CI_REPORT:START)
├── SUPERVISOR_REPORT.md # agora seção em HANDOFF.md (SUPERVISOR:START)
├── ci_metrics.json / supervisor_metrics.json # agora embarcados em STATE.md
├── CI_RETRIES.json / ORCHESTRATOR_STATE.json # agora em STATE.md (CI_STATE / ORCHESTRATOR_STATE)
```

## Comandos

```
@harness Implementar cadastro com 2FA
@harness [feature] Busca por texto em produtos
@harness [project] E-commerce Next.js + Supabase
@harness [bugfix] Erro 500 no checkout
```

Alias legado: `@harness-orchestrator` → `@harness`.
