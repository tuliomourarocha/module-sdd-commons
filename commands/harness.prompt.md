# Harness — 3 Fluxos

> O harness apenas delega via `task()`. Hooks (guard_rails, ci-watch, supervisor) rodam sozinhos — o harness não os chama nem espera.

## Feature (padrão)
```
planner → builder → reviewer → shipper → fim
```
1. **planner** — PRD + PLAN + arch (memória) + **revisão do plano como HTML interativo via Lavish** (decisões e skills sugeridas — locais + `--remote` da skills.sh — com escolha clicável pelo usuário; installs remotos só com aprovação + `--audit`) + backlog no GitHub: cria issues/épics (`create-issue`), labels de prioridade/tipo/tags (`ensure-labels`), sprints/backlog (`ensure-milestone`) e retorna os números em memória
2. **builder** — **executa via client ACP** (`acp_client.mjs --agent opencode|codex`, um run por subtask, `--json` parseado, gate de auth antes; interação do usuário no meio do processo via `--ui lavish`/TTY; fallback self-implement com pendência) + código no disco + resumo (memória) + move a issue para execução (`move-issue` → Status `In Progress`; nunca cria)
3. **reviewer** — parecer de arquitetura (memória)
4. **shipper** — fetch develop, branch de `origin/develop` atualizada, PR `--base develop` (nunca main), CI, `.planning/STATE.md` + `.planning/HANDOFF.md` + encerra a issue (sync real pelo hook: valida `gh auth status`, localiza issue por `--issue`/`Closes #N` do PR/prefixo do branch, fecha com comentário do PR e Status `Done` no Project; nunca cria issue)

Fallback pós-hook (uma vez só): se o resultado da task mostrar `🚨 GITHUB_FALLBACK_REQUIRED` ou `🚨 GITHUB_AUTH_REQUIRED` (ou `HANDOFF.md` tiver `<!-- GITHUB_REPORT -->` com status `failed`), chame `task shipper` minimal com instrução **explícita de descobrir via `find-skills` (busca local na pasta `skills/`) e carregar primeiro a skill `github-cli`** (obrigatória antes de qualquer operação de issues) e: em auth, rodar o **gate `gh auth status`** (falhou → `gh auth login`) e reexecutar o hook; em sync pendente, resolver a issue por número (`issueId`/`SDD_GITHUB_ISSUE`) ou título (`sdd_backlog.py find-issue`) e concluir o encerramento via CLI (`sdd_backlog.py close-issue <n> --comment "🚢 PR entregue — <url>"`) — falha de sincronização nunca termina silenciosa.

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
2. Carregar skills via `find-skills` (inclusive a de backlog GitHub) — skills são dos macros; issues são dos macros (planner cria backlog, builder move para execução, shipper encerra).
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

# Interativo por humano (ACP — interface TMR):
sdd-acp [--ui lavish]                                             # ou: node skills/acp-client/scripts/acp_orchestrate.mjs
```
