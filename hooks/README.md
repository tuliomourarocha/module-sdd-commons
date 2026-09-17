# Hooks Determinísticos — Guard Rails, Shipper, CI Watch & Supervisor

Hooks são **middlewares fora do LLM** (travas determinísticas) que interceptam, validam, formatam ou bloqueiam ações da IA no ciclo de vida da tool. Equivalente Claude Code: `PostToolUse` / `PreToolUse` / `Stop`.

Este diretório contém os **4 (+1 orquestrador) hooks determinísticos** do harness, implementados como **scripts Python** acionados por **plugins OpenCode** (fora do modelo) e por **settings Claude/Codex**. `checker` removido — testes/lint são guard rails; `reviewer` só arquitetura; `ci-watch` verifica CI pós-PR com loop de correção.

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
| **Fallback** | Se HANDOFF minimal, `agents/shipper.agent.md` (minimal) complementa com `PRD/PLAN + resumo/parecer` em memória (nunca SUMMARY/REVIEW como arquivos) |

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
| **Output** | Markdown + JSON **embarcados em `.planning/HANDOFF.md` (`<!-- SUPERVISOR:START -->`) e `.planning/STATE.md` (`<!-- SUPERVISOR_STATE:START -->`)** + **Issue criada** em `tuliomourarocha/module-sdd-commons` via `gh issue create` — **não cria `SUPERVISOR_REPORT.md`/`supervisor_metrics.json` separados** |
| **Labels** | `supervisor`, `automated`, `hallucination` (se HIGH), `guard-rails-blocked`, `ci-failure` |
| **Persistência** | **Single source: apenas HANDOFF/STATE** — hook atualiza esses dois via marcadores; não criar arquivos separados (bloqueado com HIGH; legado só via `SUPERVISOR_LEGACY=1`) |
| **Harness single-run** | Supervisor roda **bloqueante** na mesma sessão harness; harness permanece vivo até audit done — não re-invocar |

**Uso manual:**
```bash
python3 hooks/supervisor.py --dry-run --repo .  # só loga, não persiste
python3 hooks/supervisor.py --run --repo . --repo-slug tuliomourarocha/module-sdd-commons  # atualiza HANDOFF/STATE + cria issue
SUPERVISOR_REPO=meu/repo python3 hooks/supervisor.py --run
# legado (opcional): SUPERVISOR_LEGACY=1 python3 hooks/supervisor.py --run --md-out .planning/SUPERVISOR_REPORT.md
```

## 4. CI Watch — verificação de CI pós-PR + loop de correção

**Trigger:** após `shipper` abrir/atualizar PR (`task shipper` completa ou `write HANDOFF.md`/`STATE.md` ou `session.idle`).

| Aspecto | Detalhe |
|---------|---------|
| **Script** | `hooks/ci_watch.py` |
| **Plugin OpenCode** | `plugins/ci-watch.ts` → `tool.execute.after` (task shipper, write HANDOFF/STATE) + `event: session.idle` + `file.edited` HANDOFF |
| **Claude** | `.claude/settings.json` → `hooks.Stop` / `hooks.PostToolUse` (opcional, após shipper) |
| **O que faz** | Descobre PR via `gh pr view --json statusCheckRollup` (fallback `gh pr checks` + `gh run list --branch`), polling bloqueante até conclusão (`--wait --timeout 600 --interval 30`), classifica `pass`/`fail`/`pending`/`unknown`, em `fail` coleta logs `gh run view --log-failed` + **atualiza `.planning/HANDOFF.md` (`<!-- CI_REPORT:START -->`) e `.planning/STATE.md` (`<!-- CI_STATE:START -->`)** — não cria arquivos separados, tracking retries em `STATE.md` (max 2) |
| **Determinismo** | Sem LLM; exit `0` = CI verde, `2` = fail (precisa loop correção), `3` = pending timeout, `1` = infra/unknown — **harness single-run bloqueante** |
| **Loop correção** | Plugin lança `🚨 CI_FAILED_NEEDS_FIX` → harness **mesma run** escala `task builder` com contexto extraído de `HANDOFF.md#CI_REPORT:START` + `PLAN` → `reviewer` → `shipper` → `ci-watch` re-polla (sem re-invocar harness); após `max_retries` → `🚨 CI_RETRIES_EXHAUSTED` → humano |
| **Orquestrador LangGraph** | `hooks/ci_orchestrator.py` — StateGraph opcional `detect_pr → wait_ci → analyze → fix → review → reship → wait_ci` — também persiste em `HANDOFF/STATE` (`<!-- ORCHESTRATOR:START -->`), fallback determinístico puro se ausente |
| **Persistência** | **Single source: apenas HANDOFF/STATE** — hook atualiza esses dois via marcadores; não criar `CI_REPORT.md`/`ci_metrics.json`/`CI_RETRIES.json` separados (bloqueado com HIGH; legado só via `CI_WATCH_LEGACY=1`) |

**Uso manual:**
```bash
python3 hooks/ci_watch.py --run --wait --timeout 600 --interval 30 --max-retries 2 --verbose  # atualiza HANDOFF/STATE (bloqueante)
python3 hooks/ci_watch.py --run --no-wait --pr 123
python3 hooks/ci_watch.py --run --wait --dry-run  # só loga, não persiste
python3 hooks/ci_orchestrator.py --run --max-retries 2 --timeout 600  # também HANDOFF/STATE (single-run)
python3 hooks/ci_orchestrator.py --run --with-langgraph  # requer pip install langgraph
# legado (opcional): CI_WATCH_LEGACY=1 python3 hooks/ci_watch.py --run --wait --md-out .planning/CI_REPORT.md
```

**Exemplo seção em HANDOFF.md (fail) — marcador CI_REPORT:START:**
```md
<!-- CI_REPORT:START -->
# CI Report — 2026-09-17T21:00:00Z
**Status:** 🔴 `fail` — fail:1 pass:3
**Branch:** `feat/auth` | **PR:** #42 — https://github.com/.../pull/42
**Ação:** harness deve chamar `task builder` com este relatório (max 2) — extrair de HANDOFF.md#CI_REPORT:START
## Logs de falha
gh run view 999 --log-failed ...
<!-- CI_REPORT:END -->
```

## Instalação

Via `sdd-harness` (recomendado):
```bash
npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode --target .
npx --yes github:tuliomourarocha/module-sdd-commons#main --claude --target .
npx --yes github:tuliomourarocha/module-sdd-commons#main --all --target .
```

O que cada alvo instala:
- **OpenCode:** `.opencode/plugins/guard-rails.ts`, `shipper.ts`, `ci-watch.ts`, `supervisor.ts` (auto-load) + `.opencode/hooks/*.py` (5 scripts) + `hooks/*.py` fallback + `agents/supervisor.md`
- **Claude:** `.claude/settings.json` (hooks PostToolUse/PreToolUse/Stop + ci-watch) + `.claude/hooks/*.py` (5 scripts) + `agents/supervisor.md`
- **Codex:** `.codex/hooks/*.py` (5 scripts) + `roles/supervisor.md`

Legado: `./install.sh` também copia `plugins/` e `hooks/`.

## Requisitos

- `python3` (obrigatório — hooks são python)
- Opcionais mas recomendados: `ruff`, `pyright`/`basedpyright`, `bandit`, `eslint`/`biome`, `tsc`, `gh` (para supervisor criar issue), `semgrep`
- Se ausentes, hooks degradam gracefully (pulam tool, mantém secrets-scan e heurísticas)

## Fluxo Harness com Hooks (single-run, bloqueante)

```
builder escreve arquivo → [Hook Guard Rails: python determinístico] → HIGH? bloqueia → builder corrige (max 2)
builder → reviewer (só arquitetura) → [Hook Shipper: git/PR/HANDOFF/STATE determinístico] → [Hook CI Watch: polling CI bloqueante até conclusão, atualiza HANDOFF/STATE (CI_REPORT:START) — sem criar arquivos] → fail? → builder (com HANDOFF#CI_REPORT) → reviewer → shipper → ci-watch (max 2, mesma harness run) → [Hook Supervisor: python + agente supervisor, atualiza HANDOFF/STATE (SUPERVISOR:START) — sem criar SUPERVISOR_REPORT.md] → Issue GitHub
(fallback: shipper minimal só enriquece HANDOFF/STATE se hook gerou minimal; orquestrador LangGraph opcional em hooks/ci_orchestrator.py — também HANDOFF/STATE)
> Harness é single-run: permanece bloqueante até ci-watch (pass) + supervisor (done), sem re-invocar. Hooks atualizam HANDOFF/STATE via marcadores ao invés de criar .md separados.
```

### Decisão: Hook determinístico vs LangGraph — quando usar cada

| Critério | Hook determinístico (`ci_watch.py` + `ci-watch.ts` + harness loop, single-run) | LangGraph (`ci_orchestrator.py` com StateGraph, single-run) |
|----------|-------------------------------------------------------------------|--------------------------------------------------|
| **Dependências** | Apenas `python3` + `gh` (zero deps extras) | `pip install langgraph langgraph-checkpoint` |
| **Orquestração** | Harness (single invocation, bloqueante) faz `task builder` quando plugin lança `CI_FAILED_NEEDS_FIX`; polling puro + update HANDOFF/STATE | StateGraph `detect_pr → wait_ci → analyze → fix → review → reship → wait_ci` com checkpointing em HANDOFF/STATE |
| **Checkpoint/Resume** | Via `STATE.md` (CI_STATE) + `HANDOFF.md` (marcadores) — sem arquivos separados | Nativo via `MemorySaver` / `SqliteSaver` + HANDOFF/STATE markers |
| **Branching complexo** | Simples `pass/fail/pending` | Suporta branching paralelo, human-in-the-loop, múltiplos agentes concorrentes |
| **Recomendado para** | 90% dos projetos; CI linear pós-PR, loop max 2 (single harness run) | Projetos com múltiplos checks paralelos, necessidade de resume após falha de rede, ou orquestrar >3 agentes simultâneos |

> **Recomendação:** use o hook determinístico como primário (já instalado e sem dependências). Ative LangGraph apenas se precisar de orquestração avançada — ambos coexistem e compartilham `ci_watch.py` como `wait_ci` node.

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
{"ts":"2026-09-17T21:15:06Z","hook":"ci-watch","branch":"feat/auth","pr_number":42,"status":"fail","exit_code":2,"retries":1,"message":"CI falhou"}
{"ts":"2026-09-17T21:15:06Z","hook":"ci-orchestrator","status":"fail","retries":1,"branch":"feat/auth"}
{"ts":"2026-09-17T21:15:08Z","hook":"supervisor","files_changed":12,"hallu_high":0,"guard_high":0,"status":"success"}
```

**Como verificar:**
```bash
cat .planning/HOOKS.log | tail -20          # prova que hooks rodaram
cat .planning/HOOKS.log | grep '"status":"blocked"'  # HIGH bloqueados
cat .planning/HOOKS.log | grep '"status":"error"'    # falhas infra
cat .opencode/hooks/hook-audit.jsonl        # mesmo audit no OpenCode
```

**Notificação a agentes no decorrer do processo (single harness run):**
- `guard-rails` HIGH → `throw GUARD_RAILS_BLOCKED` — builder recebe erro como `tool result` e corrige (max 2 iterações) — visível no TUI como `⛔`
- `guard-rails` infra (hook não encontrado, python erro, timeout) → `throw HOOK_GUARD_RAILS_INFRA_ERROR` — builder/reviewer vê `🚨` no meio da execução + log em `.planning/HOOKS.log` com `status: infra_error`
- `shipper` crítico (git falhou, exit 2) → `throw HOOK_SHIPPER_CRITICAL` — harness (mesma run) vê e escala para builder/humano — também logado com `status: critical`
- `ci-watch` falha (CI fail, exit 2) → `throw 🚨 CI_FAILED_NEEDS_FIX` — harness **single-run** reinicia `task builder` com contexto extraído de `HANDOFF.md#CI_REPORT:START` + `STATE.md#CI_STATE` (max 2) → `reviewer` → `shipper` → `ci-watch` re-polla; se retries esgotados → `throw 🚨 CI_RETRIES_EXHAUSTED` → escalar humano (sem re-invocar harness)
- `ci-watch` pending timeout (exit 3) → warn (harness permanece bloqueante, re-poll via `session.idle` sem encerrar)
- `supervisor` crítico (hallucination HIGH) → `throw HOOK_SUPERVISOR_CRITICAL` — não bloqueia shipper (observability), mas alerta com `🚨`; harness só finaliza após `HOOKS.log` registrar `supervisor status=success|critical`

> Todos os plugins usam `client.app.log(level:error)` + `writeGuaranteeLog()` + `throw` quando necessário — erro é **sempre visível** tanto no TUI (`service: guard-rails|shipper|supervisor`) quanto no arquivo `.planning/HOOKS.log` que qualquer agente pode ler via `Read`.

## Configuração

- **Desabilitar guard rails:** remover `plugins/guard-rails.ts` ou setar `fail-on=never`
- **Mudar repo da issue:** `export SUPERVISOR_REPO=org/repo` ou `gh issue --repo`
- **Ajustar severidade:** `python3 hooks/guard_rails.py --fail-on MED` (bloqueia também em MED)
- **Ver logs garantia:** `cat .planning/HOOKS.log` ou `python3 -c "import json; [print(json.loads(l)['hook'], json.loads(l)['status']) for l in open('.planning/HOOKS.log')]"`
- **Claude:** editar `.claude/settings.json` → `hooks.*` (timeout, matcher, command)
