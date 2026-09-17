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
├── CI_REPORT.md      # CI watch hook — DISCO
├── SUPERVISOR_REPORT.md # supervisor hook — DISCO
└── (nenhum outro arquivo deve existir em disco — especialmente SUMMARY/REVIEW/VALIDATION são PROIBIDOS)

Memória (via task() → harness injeta como context:, nunca em disco):
├── PRD.md            # planner → memória
├── PLAN.md           # planner → memória
├── resumo            # builder → memória (NUNCA SUMMARY.md)
├── parecer           # reviewer → memória (NUNCA REVIEW.md, só arquitetura, sem lint)
└── arch/epic-XX/     # planner → memória
    ├── frontend-arch.md
    ├── backend-arch.md
    ├── sequence-flows.md
    └── deployment.md
```

> **Restrição obrigatória — Anti-loop:** Apenas `STATE.md`/`HANDOFF.md` (+ `CI_REPORT.md`/`SUPERVISOR_REPORT.md`) persistem. `PRD.md`, `PLAN.md` e `arch/*` são **em memória** (retornados via `task()` ao `harness`); builder retorna **resumo** e reviewer retorna **parecer** em memória (nunca `SUMMARY.md`/`REVIEW.md`). `permission: .planning/** deny` para `planner|builder|reviewer`; `shipper`/hook só `allow` para `STATE.md`/`HANDOFF.md`. `VALIDATION.md`/`SUMMARY.md`/`REVIEW.md` são **PROIBIDOS** e bloqueados com `HIGH` (checker → hook guard_rails). Proibido criar esses arquivos em disco.

## Protocolo

### Ao iniciar (todo agente — memória única, anti-loop)
1. Load this skill
2. Use `context: {STATE.md, HANDOFF.md}` **injetado pelo `harness`** (leitura única em disco feita pelo `harness`); **NÃO** releia `.planning/STATE.md`/`HANDOFF.md` em disco se já injetado — reaproveite `context:` para evitar loop de verificação.
3. Só leia `.planning/STATE.md`/`HANDOFF.md` em disco se `context:` ausente (primeiro acesso ou fallback).
4. **NÃO** leia `.planning/PRD.md`, `.planning/PLAN.md` etc. em disco — esses artefatos vêm **em memória** via `context: {PRD.md, PLAN.md, ...}` injetado pelo `harness`. **NUNCA leia** `.planning/SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` — não existem (proibidos). Leitura em disco desses caminhos é proibida (`permission: deny`) e indica violação `HIGH`.

### Ao finalizar (Harness V2 — 4 macros + hooks)

| Macro/Hook | Persistência em disco | Retorno em memória |
|-------|----------------------|--------------------|
| `planner` | **NENHUM** (`permission: .planning/** deny`) | `return {PRD.md, PLAN.md, arch/*}` |
| `builder` | Código-fonte apenas (`**/*.ts` etc.) — **NUNCA** `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` | `return {resumo}` (em memória, não arquivo) |
| `reviewer` | **NENHUM** — só arquitetura, sem auto-fix de lint (`deny`) | `return {parecer}` (em memória, nunca REVIEW.md) |
| `shipper` (hook) | **APENAS** `.planning/HANDOFF.md` + `.planning/STATE.md` (`allow` só nesses dois, `deny` demais) via `hooks/shipper.py` | Consolida memória em `HANDOFF`/`STATE`; fallback minimal só STATE/HANDOFF |

- `planner|builder|reviewer` **NUNCA** escrevem `.planning/**` — retornam em memória ao `harness`. Guard rails em hooks, não em agents.
- `shipper` (hook determinístico + fallback minimal) sobrescreve `.planning/HANDOFF.md` com o que foi feito, arquivos alterados, decisões, pendências + resumo dos artefatos em memória recebidos; atualiza `.planning/STATE.md` com `flow`, `gate`, `artifacts status` (ex.: `PRD:done (memória)`), `next step` (template abaixo).

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
- `PRD.md` -- pendente (memória, nunca em disco)
- `PLAN.md` -- pendente (memória)
- resumo -- pendente (memória, nunca SUMMARY.md)
- parecer -- pendente (memória, nunca REVIEW.md)
# PROIBIDO: .planning/SUMMARY.md, .planning/REVIEW.md, .planning/VALIDATION.md

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
4. **Persistência proibida fora de `STATE`/`HANDOFF`:** `PRD.md`, `PLAN.md` e `arch/*` **NUNCA** vão para `.planning/` em disco — são em memória (`permission: .planning/** deny` para `planner|builder|reviewer`); resumo/parecer também são **em memória** (nunca `SUMMARY.md`/`REVIEW.md`). `VALIDATION.md`/`SUMMARY.md`/`REVIEW.md` são **PROIBIDOS** e bloqueados com `HIGH`.
5. **Injeção única e reaproveitamento:** `harness` lê `STATE`/`HANDOFF` **uma vez** e injeta via `context:`; macros **NÃO** releem `.planning/*.md` em disco se já injetado — usam `context:`. Isso evita loop de verificação (revalidação infinita) e garante reaproveitamento.
6. **Violação = HIGH:** CI/review (hook guard_rails) deve apontar `HIGH` se detectar `.planning/PRD.md` etc. ou `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` criado em disco; `permission: deny` + guard rails bloqueia `write`/`edit`/`bash` nesses caminhos com `HIGH`.
