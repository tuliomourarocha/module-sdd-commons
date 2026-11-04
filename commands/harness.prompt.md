# Harness — 3 Fluxos

> O harness apenas delega via `task()`. Hooks (guard_rails, ci-watch, supervisor) rodam sozinhos — o harness não os chama nem espera.

## Feature (padrão)
```
planner → builder → reviewer → shipper → fim
```
1. **planner** — PRD + PLAN + arch (memória)
2. **builder** — código no disco + resumo (memória)
3. **reviewer** — parecer de arquitetura (memória)
4. **shipper** — fetch develop, branch de `origin/develop` atualizada, PR `--base develop` (nunca main), CI, `.planning/STATE.md` + `.planning/HANDOFF.md` (Trello sync real pelo hook: valida credenciais, reauth aberta no browser em 401, move card para destino explícito ou a última lista "concluído")

Fallback pós-hook (uma vez só): se o resultado da task mostrar `🚨 TRELLO_FALLBACK_REQUIRED` ou `🚨 TRELLO_REAUTH_REQUIRED` (ou `HANDOFF.md` tiver `<!-- TRELLO_REPORT -->` com status `failed`), chame `task shipper` minimal com instrução de: em reauth, rodar `trello-manager` (`trello_api.py auth`) e reexecutar o hook; em sync pendente, concluir o movimento do card via skill `trello-manager` — falha de sincronização nunca termina silenciosa.

Gates humanos: após planner e após reviewer.

## Project
```
planner(discover) → builder(scaffold) → planner → builder → reviewer → shipper
```

## Bugfix
```
planner(triage) → builder(fix) → reviewer → shipper
```

## Artefatos
- **Em disco:** apenas `.planning/STATE.md` e `.planning/HANDOFF.md` (escritos por `shipper`/hooks).
- **Em memória:** PRD, PLAN, arch, resumo do builder, parecer do reviewer — passados adiante via `context:`.
- Nunca criar `SUMMARY.md`, `REVIEW.md`, `VALIDATION.md`, `CI_REPORT.md` ou `SUPERVISOR_REPORT.md`.

## Anti-patterns
1. Executar algo em vez de delegar (editar, rodar bash, ler/glob/grep código). Única leitura válida: `.planning/STATE.md` e `.planning/HANDOFF.md`, uma vez.
2. Carregar skills (inclusive `trello-manager`) — skills são dos macros; Trello é do `shipper`.
3. Esperar hooks ou CI (quem espera é o hook, não o harness).
4. Pular planner ou os gates.
5. Re-ler `.planning/*.md` que já vieram em `context:`.
6. Mais de 2 voltas builder→reviewer.

## Comandos
```
@harness Implementar cadastro com 2FA
@harness [feature] Busca por texto em produtos
@harness [project] E-commerce Next.js + Supabase
@harness [bugfix] Erro 500 no checkout
```
