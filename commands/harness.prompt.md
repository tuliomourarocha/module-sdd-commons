# Harness — 3 Fluxos com 4 Macros + Hooks

> Detalhe via progressive disclosure para `agents/harness.agent.md`. Leia apenas quando orquestrando.

## Fluxos

### Feature (padrão)
```
planner → builder → reviewer → shipper(hook) → Done
```
1. **planner** — PRD + PLAN + arch (memória)
2. **builder** — código + SUMMARY (hook guard_rails valida per-file durante escrita)
3. **reviewer** — REVIEW arquitetura apenas (sem lint/testes — hooks fazem)
4. **shipper(hook)** — commit + PR + CI + STATE/HANDOFF + Trello (determinístico via `hooks/shipper.py` + `plugins/shipper.ts`; fallback `shipper` minimal só para STATE/HANDOFF)

Gates humanos: após planner e após reviewer (2 total). Guard rails não são gate humano — bloqueiam per-file no builder via hook.

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

## Memória e Política de Artefatos — Anti-loop

> **Apenas `STATE.md`/`HANDOFF.md` persistem em disco (via `shipper`/hook).** Demais artefatos são **em memória** via `task()` e injetados como `context:` pelo `harness`. Proibido criar `.planning/PRD.md`, `.planning/PLAN.md`, `.planning/SUMMARY.md`, `.planning/REVIEW.md` ou `.planning/arch/**` em disco — `permission: .planning/** deny` para `planner|builder|reviewer`; `shipper`/hook só `allow` para `STATE.md`/`HANDOFF.md`. `harness` lê `STATE`/`HANDOFF` **uma vez** e injeta; macros **NÃO** releem `.planning/*.md` se já injetado. Propósito: evitar loop de verificação e reaproveitar contexto.

> `checker` removido — guard rails em `hooks/guard_rails.py`. `VALIDATION.md` não existe mais; validação é hook determinístico per-file + supervisor pós-shipper.

## Pre-condições por transição

| De → Para | Validação | Falha |
|-----------|-----------|-------|
| planner → builder | `PRD.md` + `PLAN.md` retornados **em memória** (não em disco) | Bloquear, pedir ajuste planner |
| builder → reviewer | `SUMMARY.md` em memória + `npm run build` ok + **nenhum HIGH pendente em `guard_rails`** | Bloquear até HIGH corrigido (hook já bloqueou per-file) |
| reviewer → shipper | `REVIEW.md` em memória sem HIGH arquitetural | Loop builder max 2, depois escalar |
| shipper(hook) → Done | PR criado + CI verde + `STATE.md`/`HANDOFF.md` (únicos em disco) | Escalar humano |

## Anti-patterns
1. Pular planner e ir direto para builder
2. Rodar guard rails como agent (hooks são single source)
3. Fazer Trello sync fora do shipper hook
4. Escrever STATE/HANDOFF fora do shipper/hook
5. Criar `.planning/PRD.md`/`PLAN.md`/etc. em disco — artefatos são em memória (só `STATE`/`HANDOFF` em disco)
6. Re-ler `.planning/*.md` em disco quando já injetado como `context:` — causa loop de verificação
7. Loop infinito — max 2 iterações builder, depois humano decide
8. Reviewer rodando lint/testes — proibido, é hook

## Artefatos

```
.planning/  — persistência em disco APENAS:
├── STATE.md        # shipper/hook (único escritor) — DISCO
├── HANDOFF.md      # shipper/hook (único escritor) — DISCO
└── (nenhum outro arquivo deve existir em disco)

Memória (via task() → harness injeta como context:, nunca em disco):
├── PRD.md          # planner → memória → builder
├── PLAN.md         # planner → memória → builder
├── SUMMARY.md      # builder → memória → reviewer
├── REVIEW.md       # reviewer → memória → shipper (só arquitetura)
└── arch/epic-XX/   # planner → memória → builder

Removido:
├── VALIDATION.md   # checker removido — substituído por hooks/guard_rails.py
```

## Comandos

```
@harness Implementar cadastro com 2FA
@harness [feature] Busca por texto em produtos
@harness [project] E-commerce Next.js + Supabase
@harness [bugfix] Erro 500 no checkout
```

Alias legado: `@harness-orchestrator` → `@harness`.
