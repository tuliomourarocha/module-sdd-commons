# Harness — 3 Fluxos com 5 Macros

> Detalhe via progressive disclosure para `agents/harness.agent.md`. Leia apenas quando orquestrando.

## Fluxos

### Feature (padrão)
```
planner → builder → [checker ∥ reviewer] → shipper → Done
```
1. **planner** — PRD + PLAN + arch
2. **builder** — código + SUMMARY
3. **checker ∥ reviewer** — VALIDATION + REVIEW (paralelo)
4. **shipper** — commit + PR + CI + STATE/HANDOFF + Trello

Gates humanos: após planner e após checker/reviewer (2 total).

### Project
```
planner(discover) → builder(scaffold) → loop feature × N → shipper(finalize)
```
- discover: PRD roadmap + visão
- scaffold: estrutura + CI/CD + arch base (builder)
- finalize: deploy preview + docs (shipper)

### Bugfix
```
planner(triage) → builder(fix) → [checker ∥ reviewer] → shipper
```
- triage: reproduz, causa, escopo fix (PRD leve, não completo)

## Memória e Política de Artefatos — Anti-loop

> **Apenas `STATE.md`/`HANDOFF.md` persistem em disco (via `shipper`).** Demais artefatos são **em memória** via `task()` e injetados como `context:` pelo `harness`. Proibido criar `.planning/PRD.md`, `.planning/PLAN.md`, `.planning/SUMMARY.md`, `.planning/VALIDATION.md`, `.planning/REVIEW.md` ou `.planning/arch/**` em disco — `permission: .planning/** deny` para `planner|builder|checker|reviewer`; `shipper` só `allow` para `STATE.md`/`HANDOFF.md`. `harness` lê `STATE`/`HANDOFF` **uma vez** e injeta; macros **NÃO** releem `.planning/*.md` se já injetado. Propósito: evitar loop de verificação e reaproveitar contexto.

## Pre-condições por transição

| De → Para | Validação | Falha |
|-----------|-----------|-------|
| planner → builder | `PRD.md` + `PLAN.md` retornados **em memória** (não em disco) | Bloquear, pedir ajuste planner |
| builder → checker/reviewer | `SUMMARY.md` em memória + `npm run build` ok | Bloquear |
| checker/reviewer → shipper | `VALIDATION.md` + `REVIEW.md` em memória sem HIGH blocker | Loop builder max 2, depois escalar |
| shipper → Done | PR criado + CI verde + `STATE.md`/`HANDOFF.md` (únicos em disco) | Escalar humano |

## Anti-patterns
1. Pular planner e ir direto para builder
2. Rodar checker/reviewer sequencial (sempre paralelo)
3. Fazer Trello sync fora do shipper
4. Escrever STATE/HANDOFF fora do shipper
5. Criar `.planning/PRD.md`/`PLAN.md`/etc. em disco — artefatos são em memória (só `STATE`/`HANDOFF` em disco)
6. Re-ler `.planning/*.md` em disco quando já injetado como `context:` — causa loop de verificação
7. Loop infinito — max 2 iterações builder, depois humano decide

## Artefatos

```
.planning/  — persistência em disco APENAS:
├── STATE.md        # shipper (único escritor) — DISCO
├── HANDOFF.md      # shipper (único escritor) — DISCO
└── (nenhum outro arquivo deve existir em disco)

Memória (via task() → harness injeta como context:, nunca em disco):
├── PRD.md          # planner → memória → builder
├── PLAN.md         # planner → memória → builder
├── SUMMARY.md      # builder → memória → checker/reviewer
├── VALIDATION.md   # checker → memória → shipper
├── REVIEW.md       # reviewer → memória → shipper
└── arch/epic-XX/   # planner → memória → builder
```

## Comandos

```
@harness Implementar cadastro com 2FA
@harness [feature] Busca por texto em produtos
@harness [project] E-commerce Next.js + Supabase
@harness [bugfix] Erro 500 no checkout
```

Alias legado: `@harness-orchestrator` → `@harness`.
