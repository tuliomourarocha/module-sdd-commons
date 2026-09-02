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

## Pre-condições por transição

| De → Para | Validação | Falha |
|-----------|-----------|-------|
| planner → builder | `PRD.md` + `PLAN.md` existem | Bloquear, pedir ajuste planner |
| builder → checker/reviewer | `SUMMARY.md` + `npm run build` ok | Bloquear |
| checker/reviewer → shipper | `VALIDATION.md` + `REVIEW.md` sem HIGH blocker | Loop builder max 2, depois escalar |
| shipper → Done | PR criado + CI verde + STATE/HANDOFF | Escalar humano |

## Anti-patterns
1. Pular planner e ir direto para builder
2. Rodar checker/reviewer sequencial (sempre paralelo)
3. Fazer Trello sync fora do shipper
4. Escrever STATE/HANDOFF fora do shipper
5. Loop infinito — max 2 iterações builder, depois humano decide

## Artefatos

```
.planning/
├── PRD.md          # planner
├── PLAN.md         # planner
├── SUMMARY.md      # builder
├── VALIDATION.md   # checker
├── REVIEW.md       # reviewer
├── STATE.md        # shipper (único escritor)
├── HANDOFF.md      # shipper (único escritor)
└── arch/epic-XX/   # planner
```

## Comandos

```
@harness Implementar cadastro com 2FA
@harness [feature] Busca por texto em produtos
@harness [project] E-commerce Next.js + Supabase
@harness [bugfix] Erro 500 no checkout
```

Alias legado: `@harness-orchestrator` → `@harness`.
