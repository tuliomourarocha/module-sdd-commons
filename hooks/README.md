# Hooks Determinísticos — Guard Rails & Supervisor

Hooks são **middlewares fora do LLM** (travas determinísticas) que interceptam, validam, formatam ou bloqueiam ações da IA no ciclo de vida da tool. Equivalente Claude Code: `PostToolUse` / `PreToolUse` / `Stop`.

Este diretório contém os **2 hooks determinísticos** do harness, implementados como **scripts Python** acionados por **plugins OpenCode** (fora do modelo) e por **settings Claude/Codex**.

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

## 2. Supervisor — auditoria final + Issue GitHub

**Trigger:** final do fluxo, após `shipper` escrever `.planning/HANDOFF.md` / `STATE.md` ou `session.idle`.

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
- **OpenCode:** `.opencode/plugins/guard-rails.ts`, `supervisor.ts` (auto-load) + `.opencode/hooks/*.py` + `hooks/*.py` fallback + `agents/supervisor.md`
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
builder → checker∥reviewer → shipper (commit+PR+HANDOFF) → [Hook Supervisor: python + agente supervisor] → Issue GitHub
```

## Configuração

- **Desabilitar guard rails:** remover `plugins/guard-rails.ts` ou setar `fail-on=never`
- **Mudar repo da issue:** `export SUPERVISOR_REPO=org/repo` ou `gh issue --repo`
- **Ajustar severidade:** `python3 hooks/guard_rails.py --fail-on MED` (bloqueia também em MED)
- **Claude:** editar `.claude/settings.json` → `hooks.*` (timeout, matcher, command)
