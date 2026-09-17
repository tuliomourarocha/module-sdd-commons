# Hooks Determinísticos — Guard Rails, Shipper & Supervisor

Hooks são **middlewares fora do LLM** (travas determinísticas) que interceptam, validam, formatam ou bloqueiam ações da IA no ciclo de vida da tool. Equivalente Claude Code: `PostToolUse` / `PreToolUse` / `Stop`.

Este diretório contém os **3 hooks determinísticos** do harness, implementados como **scripts Python** acionados por **plugins OpenCode** (fora do modelo) e por **settings Claude/Codex**. `checker` removido — testes/lint são guard rails; `reviewer` só arquitetura.

## 1. Guard Rails — pós-edição de arquivo de código

**Trigger:** toda vez que finaliza alteração em arquivo de código (`edit`/`write`/`bash patch`).

| Aspecto | Detalhe |
|---------|---------|
| **Script** | `hooks/guard_rails.py` |
| **Plugin OpenCode** | `plugins/guard-rails.ts` → `tool.execute.after` (matcher Edit\|Write) + `event: file.edited` |
| **Claude** | `.claude/settings.json` → `hooks.PostToolUse` matcher `Edit|Write|MultiEdit` + `PreToolUse` Write |
| **Codex** | `.codex/hooks/guard_rails.py` (copiado) |
| **O que roda** | Python: `ruff check`, `ruff format --check`, `pyright/pylance`, `bandit` + `secrets-scan` (regex) + `size-check`; JS/TS: `eslint`/`biome`/`tsc --noEmit` + `ts_diagnostic.py`; genérico: secrets, file too large |
| **Determinismo** | Sem LLM. Exit `0` = pass, `2` = BLOCK (HIGH). Bloqueio retorna ao builder (max 2 iterações) |
| **Auto-fix** | Opcional `--autofix` (`ruff --fix`, `biome --write`) |

**Uso manual (Claude pre-hook / CI):**
```bash
python3 hooks/guard_rails.py --file src/app.py --format json
python3 hooks/guard_rails.py --file src/page.tsx --format text --fail-on HIGH
```

**Exemplo output JSON:**
```json
{
  "file": "src/app.py",
  "blocked": true,
  "findings": [{"rule":"secrets/hardcoded","severity":"HIGH","message":"Private key exposta"}]
}
```

## 2. Shipper — finalização determinística (git/PR/Trello/STATE/HANDOFF)

**Trigger:** após `reviewer` concluir (arquitetura aprovada) ou `session.idle` após review.

| Aspecto | Detalhe |
|---------|---------|
| **Script** | `hooks/shipper.py` |
| **Plugin OpenCode** | `plugins/shipper.ts` → `tool.execute.after` (task reviewer) + `event: session.idle` |
| **Claude** | `.claude/settings.json` → `hooks.PostToolUse` (opcional) |
| **O que faz** | `git status/diff`, `git commit` conventional, `git push`, `gh pr create`/`view`, `gh pr checks`, gera `.planning/HANDOFF.md` + `STATE.md` minimal, Trello sync (se `~/.trello_config.json`) |
| **Determinismo** | Sem LLM para git/PR/Trello; HANDOFF minimal via template + `git diff --stat`; enriquecimento qualitativo via fallback `shipper` minimal (agente só STATE/HANDOFF) |
| **Exit** | `0` = ok (HANDOFF/STATE gerados), `2` = falha crítica (git/gh) |
| **Fallback** | Se HANDOFF minimal, `agents/shipper.agent.md` (minimal) complementa com `PRD/PLAN/REVIEW` em memória |

**Uso manual:**
```bash
python3 hooks/shipper.py --run --repo . --repo-slug tuliomourarocha/module-sdd-commons
python3 hooks/shipper.py --run --dry-run --context-file /tmp/context.json
```

## 3. Supervisor — auditoria final + Issue GitHub

**Trigger:** final do fluxo, após `shipper` (hook ou minimal) escrever `.planning/HANDOFF.md` / `STATE.md` ou `session.idle`.

| Aspecto | Detalhe |
|---------|---------|
| **Script** | `hooks/supervisor.py` |
| **Plugin OpenCode** | `plugins/supervisor.ts` → `tool.execute.after` (write HANDOFF/STATE, task shipper) + `event: session.idle` + `file.edited` HANDOFF |
| **Claude** | `.claude/settings.json` → `hooks.Stop` (sempre) |
| **Agente** | `agents/supervisor.agent.md` — auditor LLM com prompt fechado que julga qualitativamente o que python mediu |
| **O que mede** | **Performance:** duração gates, arquivos/linhas, build/test pass; **Tokens/Consumo:** heurística `chars/4` ou OTEL se disponível + custo estimado; **Alucinações (heurísticas):** `file_not_found`, `broken_import`, `todo_left`, `plan_divergence` (vs imports que não resolvem, arquivos mencionados que não existem, PLAN vs entregue); **Segurança residual:** re-roda guard_rails no diff |
| **Output** | Markdown + JSON em `.planning/SUPERVISOR_REPORT.md` / `supervisor_metrics.json` + **Issue criada** em `tuliomourarocha/module-sdd-commons` via `gh issue create` |
| **Labels** | `supervisor`, `automated`, `hallucination` (se HIGH), `guard-rails-blocked`, `ci-failure` |

**Uso manual:**
```bash
python3 hooks/supervisor.py --dry-run --repo .  # só gera markdown/JSON
python3 hooks/supervisor.py --run --repo . --repo-slug tuliomourarocha/module-sdd-commons  # cria issue
SUPERVISOR_REPO=meu/repo python3 hooks/supervisor.py --run --dry-run
```

## Instalação

Via `sdd-harness` (recomendado):
```bash
npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode --target .
npx --yes github:tuliomourarocha/module-sdd-commons#main --claude --target .
npx --yes github:tuliomourarocha/module-sdd-commons#main --all --target .
```

O que cada alvo instala:
- **OpenCode:** `.opencode/plugins/guard-rails.ts`, `shipper.ts`, `supervisor.ts` (auto-load) + `.opencode/hooks/*.py` + `hooks/*.py` fallback + `agents/supervisor.md`
- **Claude:** `.claude/settings.json` (hooks PostToolUse/PreToolUse/Stop) + `.claude/hooks/*.py` + `agents/supervisor.md`
- **Codex:** `.codex/hooks/*.py` + `roles/supervisor.md`

Legado: `./install.sh` também copia `plugins/` e `hooks/`.

## Requisitos

- `python3` (obrigatório — hooks são python)
- Opcionais mas recomendados: `ruff`, `pyright`/`basedpyright`, `bandit`, `eslint`/`biome`, `tsc`, `gh` (para supervisor criar issue), `semgrep`
- Se ausentes, hooks degradam gracefully (pulam tool, mantém secrets-scan e heurísticas)

## Fluxo Harness com Hooks

```
builder escreve arquivo → [Hook Guard Rails: python determinístico] → HIGH? bloqueia → builder corrige (max 2)
builder → reviewer (só arquitetura) → [Hook Shipper: git/PR/HANDOFF/STATE determinístico] → [Hook Supervisor: python + agente supervisor] → Issue GitHub
(fallback: shipper minimal só enriquece HANDOFF/STATE se hook gerou minimal)
```

## Log de Garantia — Prova que hooks foram chamados + alerta a agentes

Todos os hooks escrevem **log de garantia** em dois lugares para redundância:

| Log | Caminho | Quem escreve | Formato |
|-----|---------|--------------|---------|
| **Principal (agentes leem)** | `.planning/HOOKS.log` | `hooks/*.py` + `plugins/*.ts` | JSONL — 1 linha por invocação |
| **Audit OpenCode** | `.opencode/hooks/hook-audit.jsonl` | plugins | JSONL — mesmo conteúdo |
| **Legado guard-rails** | `.opencode/hooks/guard-rails.log` | guard-rails | JSONL compat |

**Exemplo linha:**
```json
{"ts":"2026-09-17T21:15:02Z","hook":"guard-rails","file":"src/app.ts","duration_ms":45,"exit_code":2,"blocked":true,"high":1,"med":0,"status":"blocked"}
{"ts":"2026-09-17T21:15:04Z","hook":"shipper","trigger":"task:reviewer","duration_ms":1200,"exit_code":0,"status":"success","pr_url":"https://github.com/.../pull/12"}
{"ts":"2026-09-17T21:15:08Z","hook":"supervisor","files_changed":12,"hallu_high":0,"guard_high":0,"status":"success"}
```

**Como verificar:**
```bash
cat .planning/HOOKS.log | tail -20          # prova que hooks rodaram
cat .planning/HOOKS.log | grep '"status":"blocked"'  # HIGH bloqueados
cat .planning/HOOKS.log | grep '"status":"error"'    # falhas infra
cat .opencode/hooks/hook-audit.jsonl        # mesmo audit no OpenCode
```

**Notificação a agentes no decorrer do processo:**
- `guard-rails` HIGH → `throw GUARD_RAILS_BLOCKED` — builder recebe erro como `tool result` e corrige (max 2 iterações) — visível no TUI como `⛔`
- `guard-rails` infra (hook não encontrado, python erro, timeout) → `throw HOOK_GUARD_RAILS_INFRA_ERROR` — builder/reviewer vê `🚨` no meio da execução + log em `.planning/HOOKS.log` com `status: infra_error`
- `shipper` crítico (git falhou, exit 2) → `throw HOOK_SHIPPER_CRITICAL` — harness vê e escala para builder/humano — também logado com `status: critical`
- `supervisor` crítico (hallucination HIGH) → `throw HOOK_SUPERVISOR_CRITICAL` — não bloqueia shipper (observability), mas alerta com `🚨`

> Todos os plugins usam `client.app.log(level:error)` + `writeGuaranteeLog()` + `throw` quando necessário — erro é **sempre visível** tanto no TUI (`service: guard-rails|shipper|supervisor`) quanto no arquivo `.planning/HOOKS.log` que qualquer agente pode ler via `Read`.

## Configuração

- **Desabilitar guard rails:** remover `plugins/guard-rails.ts` ou setar `fail-on=never`
- **Mudar repo da issue:** `export SUPERVISOR_REPO=org/repo` ou `gh issue --repo`
- **Ajustar severidade:** `python3 hooks/guard_rails.py --fail-on MED` (bloqueia também em MED)
- **Ver logs garantia:** `cat .planning/HOOKS.log` ou `python3 -c "import json; [print(json.loads(l)['hook'], json.loads(l)['status']) for l in open('.planning/HOOKS.log')]"`
- **Claude:** editar `.claude/settings.json` → `hooks.*` (timeout, matcher, command)
