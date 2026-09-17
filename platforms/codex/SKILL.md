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
- Apenas Shipper/hook escreve `.planning/STATE.md` e `.planning/HANDOFF.md` — demais artefatos (`PRD.md`, `PLAN.md`, `SUMMARY.md`, `REVIEW.md`, `arch/*`) são **em memória** e injetados como `context:` pelo `harness` (nunca em disco); `planner|builder|reviewer` com `deny` em `.planning/**` evita loop de verificação.
- Ao delegar, use o modelo OpenAI indicado para cada papel em
  `sdd-harness.json`. Não peça ao usuário para escolher modelos e não substitua
  o roteamento salvo. Em ambientes sem delegação com modelo por agente, use o
  modelo de `harness` para a sessão principal e mantenha o pipeline.
- **Memória única:** Leia `.planning/STATE.md`/`HANDOFF.md` **uma vez** e injete como `context:`; macros consomem `context:` sem reler disco — reaproveita contexto e evita loop.

## Política de Artefatos — Restrição Obrigatória

- **Disco:** Apenas `.planning/STATE.md` e `.planning/HANDOFF.md` (shipper/hook).
- **Memória:** `PRD.md`, `PLAN.md`, `SUMMARY.md`, `REVIEW.md`, `arch/*` retornados em memória via delegação. `VALIDATION.md` removido (hook).
- **Violação:** Criação de `.planning/PRD.md` etc. em disco é `HIGH` e bloqueada por `permission`.
