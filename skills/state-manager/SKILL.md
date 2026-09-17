---
name: state-manager
description: >
  Protocolo padronizado de estado e handoff entre agentes.
  Define como ler/escrever .planning/STATE.md e .planning/HANDOFF.md
  para garantir continuidade entre sessoes e handoff entre agentes.
  Todo agente DEVE carregar esta skill no inicio.
---

# State Manager

Protocolo padronizado de estado e handoff entre agentes.

## Estrutura

```
.planning/  — persistência em disco APENAS:
├── STATE.md          # Estado atual da execução (escrito APENAS pelo shipper) — DISCO
├── HANDOFF.md        # Último handoff (sobrescrito APENAS pelo shipper) — DISCO
└── (nenhum outro arquivo deve existir em disco)

Memória (via task() → harness injeta como context:, nunca em disco):
├── PRD.md            # planner → memória
├── PLAN.md           # planner → memória
├── SUMMARY.md        # builder → memória
├── VALIDATION.md     # checker → memória
├── REVIEW.md         # reviewer → memória
└── arch/epic-XX/     # planner → memória
    ├── frontend-arch.md
    ├── backend-arch.md
    ├── sequence-flows.md
    └── deployment.md
```

> **Restrição obrigatória — Anti-loop:** Apenas `STATE.md`/`HANDOFF.md` persistem. `PRD.md`, `PLAN.md`, `SUMMARY.md`, `VALIDATION.md`, `REVIEW.md` e `arch/*` são **em memória** (retornados via `task()` ao `harness`). `permission: .planning/** deny` para `planner|builder|checker|reviewer`; `shipper` só `allow` para `STATE.md`/`HANDOFF.md`. Proibido criar esses arquivos em disco.

## Protocolo

### Ao iniciar (todo agente — memória única, anti-loop)
1. Load this skill
2. Use `context: {STATE.md, HANDOFF.md}` **injetado pelo `harness`** (leitura única em disco feita pelo `harness`); **NÃO** releia `.planning/STATE.md`/`HANDOFF.md` em disco se já injetado — reaproveite `context:` para evitar loop de verificação.
3. Só leia `.planning/STATE.md`/`HANDOFF.md` em disco se `context:` ausente (primeiro acesso ou fallback).
4. **NÃO** leia `.planning/PRD.md`, `.planning/PLAN.md`, `.planning/SUMMARY.md` etc. em disco — esses artefatos vêm **em memória** via `context: {PRD.md, PLAN.md, ...}` injetado pelo `harness`. Leitura em disco desses caminhos é proibida (`permission: deny`) e indica violação.

### Ao finalizar (Harness V2 — 5 macros)

| Macro | Persistência em disco | Retorno em memória |
|-------|----------------------|--------------------|
| `planner` | **NENHUM** (`permission: .planning/** deny`) | `return {PRD.md, PLAN.md, arch/*}` |
| `builder` | Código-fonte apenas (`**/*.ts` etc.) — **NÃO** `.planning/SUMMARY.md` | `return {SUMMARY.md}` |
| `checker` | Testes apenas — **NÃO** `.planning/VALIDATION.md` | `return {VALIDATION.md}` |
| `reviewer` | Auto-fix apenas — **NÃO** `.planning/REVIEW.md` | `return {REVIEW.md}` |
| `shipper` | **APENAS** `.planning/HANDOFF.md` + `.planning/STATE.md` (`allow` só nesses dois, `deny` demais) | Consolida memória em `HANDOFF`/`STATE` |

- `planner|builder|checker|reviewer` **NUNCA** escrevem `.planning/**` — retornam em memória ao `harness`.
- `shipper` sobrescreve `.planning/HANDOFF.md` com o que foi feito, arquivos alterados, decisões, pendências + resumo dos artefatos em memória recebidos; atualiza `.planning/STATE.md` com `flow`, `gate`, `artifacts status` (ex.: `PRD:done (memória)`), `next step` (template abaixo).

### Nas transições de gate (harness)
1. `harness` lê `STATE.md`/`HANDOFF.md` **uma vez** no início e injeta como `context:` em cada `task()`.
2. Macros retornam artefatos **em memória**; `harness` consolida e injeta no próximo macro — **sem** escrita intermediária em disco.
3. Só `shipper` escreve `STATE.md`/`HANDOFF.md` final; `harness` nunca escreve direto (`edit: deny`) — delega ao `shipper`.
4. Se `permission: deny` bloquear `write` em `.planning/PRD.md` etc., o macro deve retornar em memória em vez de tentar `bash` alternativo.

## Template: STATE.md

```markdown
# State

## Flow
- **Type:** feature | project | bugfix
- **Gate:** discuss | plan | execute | validate | done
- **Step:** descricao do passo atual

## Context
- **Card/Epic:** link ou identificador
- **Description:** descricao do que esta sendo feito

## Artifacts
- `.planning/PRD.md` -- aprovado
- `.planning/PLAN.md` -- pendente
- `.planning/SUMMARY.md` -- pendente
- `.planning/VALIDATION.md` -- pendente

## Decisions
- Decisao 1
- Decisao 2

## Next Step
- O que o proximo agente deve fazer
```

## Template: HANDOFF.md

```markdown
# Handoff

## From
- **Agent:** nome-do-agente
- **Gate:** gate-atual
- **Status:** completed | partial | failed

## What Was Done
- Resumo do que foi feito

## Files Changed
- `caminho/arquivo1`
- `caminho/arquivo2`

## Decisions
- Decisao 1
- Decisao 2

## Pending / Blockers
- Nenhum

## Context for Next Agent
- Dicas, padroes usados, gotchas
```

## Rules — Memória e Anti-loop

1. **HANDOFF.md é sempre sobrescrito** (overwrite) — apenas o último handoff importa; escrito **apenas** pelo `shipper`.
2. **STATE.md é atualizado apenas pelo `shipper`** no Gate 4 com `flow`, `gate`, `artifacts status` (em memória vs disco), `next step`.
3. Se `STATE.md` não existir, o agente assume primeiro acesso e continua normalmente (harness injeta `context:` vazio).
4. **Persistência proibida fora de `STATE`/`HANDOFF`:** `PRD.md`, `PLAN.md`, `SUMMARY.md`, `VALIDATION.md`, `REVIEW.md` e `arch/*` **NUNCA** vão para `.planning/` em disco — são em memória (`permission: .planning/** deny` para `planner|builder|checker|reviewer`).
5. **Injeção única e reaproveitamento:** `harness` lê `STATE`/`HANDOFF` **uma vez** e injeta via `context:`; macros **NÃO** releem `.planning/*.md` em disco se já injetado — usam `context:`. Isso evita loop de verificação (revalidação infinita) e garante reaproveitamento.
6. **Violação = HIGH:** CI/review deve apontar `HIGH` se detectar `.planning/PRD.md` etc. criado em disco; `permission: deny` deve bloquear `write`/`edit`/`bash` nesses caminhos.
