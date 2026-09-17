---
name: sdd-harness
description: Execute o Harness V2 para fluxos feature, project ou bugfix, usando os 5 papéis + hooks versionados deste pacote (checker removido).
---

# Harness V2 para Codex

Use este skill quando o pedido envolver uma feature, projeto novo ou bugfix.
Leia `../../roles/harness.md` e siga seu pipeline. Os cartões de papel estão em
`../../roles/{planner,builder,reviewer,shipper}.md` (checker removido — guard rails em `hooks/guard_rails.py`). O roteamento de
modelos está em `../../sdd-harness.json`.

## Regras de adaptação

- O Codex é o orquestrador. Delegue os papéis quando o ambiente oferecer agentes
  filhos; caso contrário, execute as fases sequencialmente mantendo os mesmos
  gates e artefatos.
- Planner → Builder → Reviewer (só arquitetura) → Shipper(hook).
- Preserve os dois gates humanos definidos pelo harness (após planner e após reviewer). Guard rails são hooks, não gates.
- Apenas Shipper, ci-watch, supervisor e orquestrador (hooks) escrevem `.planning/STATE.md` e `.planning/HANDOFF.md` (marcadores CI_REPORT/SUPERVISOR/ORCHESTRATOR) — demais artefatos (`PRD.md`, `PLAN.md`, `arch/*`) são **em memória** e injetados como `context:` pelo `harness` (nunca em disco); builder retorna resumo e reviewer retorna parecer em memória (nunca `SUMMARY.md`/`REVIEW.md`); ci-watch/supervisor/orquestrador atualizam HANDOFF/STATE ao invés de criar `CI_REPORT.md`/`SUPERVISOR_REPORT.md`; `planner|builder|reviewer` com `deny` em `.planning/**` evita loop de verificação (guard rails bloqueia `SUMMARY/REVIEW/VALIDATION/CI_REPORT/SUPERVISOR_REPORT` com HIGH).
- Harness é **single-run (única invocação, bloqueante até hooks finalizarem)** — não re-invoque enquanto HOOKS.log não mostrar ci-watch + supervisor done; faça polling em STATE/HANDOFF.
- Ao delegar, use o modelo OpenAI indicado para cada papel em
  `sdd-harness.json`. Não peça ao usuário para escolher modelos e não substitua
  o roteamento salvo. Em ambientes sem delegação com modelo por agente, use o
  modelo de `harness` para a sessão principal e mantenha o pipeline.
- **Memória única:** Leia `.planning/STATE.md`/`HANDOFF.md` **uma vez** e injete como `context:`; macros consomem `context:` sem reler disco — reaproveita contexto e evita loop.

## Política de Artefatos — Restrição Obrigatória

- **Disco:** Apenas `.planning/STATE.md` e `.planning/HANDOFF.md` (single source; shipper, ci-watch, supervisor, orquestrador atualizam esses dois via marcadores) — **PROIBIDO criar `CI_REPORT.md`/`SUPERVISOR_REPORT.md`/`ORCHESTRATOR_STATE.json` como arquivos separados**.
- **Memória:** `PRD.md`, `PLAN.md`, `arch/*` + resumo (builder) + parecer (reviewer) retornados em memória via delegação. `VALIDATION.md`/`SUMMARY.md`/`REVIEW.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md` **PROIBIDOS** como arquivos — usar seções em HANDOFF/STATE.
- **Violação:** Criação de `.planning/PRD.md` etc. ou `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md` em disco é `HIGH` e bloqueada por `permission` + guard rails.
