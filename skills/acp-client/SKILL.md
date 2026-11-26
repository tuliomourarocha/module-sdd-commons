---
name: acp-client
description: >-
  Client ACP v1 da squad: roda OpenCode (`opencode acp`) ou Codex
  (`@agentclientprotocol/codex-acp`) como agentes externos controlados pela
  squad via JSON-RPC sobre stdio. Streaming de mensagens/tools/plano, gate de
  permissões com policy, e campo de interação do usuário no MEIO do processo
  (terminal TTY ou console HTML via Lavish). Use quando builder/planner
  delegarem execução a um harness externo ou precisarem de sessão retomável.
---

# ACP Client — OpenCode e Codex como agentes da squad

O macro é o **client**; o harness externo é o **agent**. Toda a execução (mensagens, tool calls, plano, permissões) é externalizada para o processo que chama — observável, gate-kept e interceptável no meio do turno.

## Interface TMR — wizard da squad (substitui o harness interno)

`acp_orchestrate.mjs` é a entrada quando um HUMANO quer rodar o ciclo completo, com a **identidade visual TMR** no terminal (`tmr_ui.mjs`: banner, menus em painel, spinner, headers de fase, painel de métricas — respeita `NO_COLOR` e degrada fora de TTY). O fluxo `planner → builder → reviewer` roda por um harness externo, com decisões humanas no início:

1. **Escolha do harness** — opencode (nativo) ou codex (adaptador).
2. **Artefatos da squad no projeto** — instala (via `bin/sdd-harness.js --<platform> --artifacts-only`) agents/skills/commands/hooks/plugins + registro do MCP codegraph para o harness escolhido (já instalados → pergunta se atualiza). A instalação da squad NÃO copia mais artefatos — é aqui que eles vêm, e ficam no projeto.
3. **Limpar `.planning/`** — lista STATE.md/HANDOFF.md/specs e pergunta se começa do zero (apaga só `.md`/`.json` de `.planning/`, com confirmação).
4. **Issue do GitHub** — link `github.com/owner/repo/issues/N`, `owner/repo#N` ou `#N` (repo do cwd); busca via `gh issue view` e vira o input das fases. Sem `gh` → cola o texto da tarefa.
5. **Modelo por agente** — para planner/builder/reviewer: lista com preços ($/Mtok in/out) e o **★ recomendado por papel** (reusa `bin/lib/model-picker.js` — os mesmos pesos do catálogo da squad; enter = recomendado). `--model <provider/model>` força um modelo para todos.
5. **Execução** — uma sessão ACP por papel, contexto encadeado em memória (planner → builder → reviewer), com steering do usuário em TTY e/ou `--ui lavish`.

### Interface (`--ui lavish`) — quadros ao vivo no browser

O console HTML mostra **tudo e mais um pouco**: métricas por agente com **tokens reais** (usage do `session/prompt`) e **custo USD real** (`usage_update` do agente), quadro de **skills chamadas** (`⟐ skill ✓`), quadro de **hooks determinísticos** (`⟐ hook ✓`), comandos invocados com **rtk/codegraph destacados**, e logs de cada processo agêntico. O resumo ASCII das métricas é impresso no terminal ao fim.

- Requer TTY (wizard). Run de UMA subtask continua sendo `acp_client.mjs`.
- Steering: harness com steering nativo (OpenCode anuncia `_meta.steering.supported`) entrega a mensagem do usuário NO MEIO do turno; sem suporte (Codex), enfileira e entrega ao fim do turno.
- Permissões: `read` é auto-permitido; `edit/delete/move` perguntam no TTY (s/N) durante a fase.

## Bootstrap de dependências (automático a cada run)

Antes de qualquer chamada, o client roda `ensure_deps.mjs` (idempotente, saída em stderr) e **instala o que estiver ausente** pelo método oficial de cada um:

| Dep | Verificação | Install automático |
|---|---|---|
| `lavish-axi` | `lavish-axi --version` | `npm install -g lavish-axi` (fallback: `npx -y lavish-axi`) |
| `codegraph` | `codegraph --version` | `npm install -g @colbymchenry/codegraph` |
| `rtk` | `rtk --version` **+ `rtk gain`** (descarta o Rust Type Kit homônimo) | `brew install rtk-ai/tap/rtk` (sem brew: installer oficial via curl) |
| `opencode` | `opencode --version` (required) | `curl -fsSL https://opencode.ai/install \| bash` |

- Opt-out: `--no-ensure` ou env `ACP_SKIP_ENSURE=1` (CI, rede bloqueada).
- Diagnóstico sem run: `node skills/acp-client/scripts/acp_client.mjs --doctor [--json]`.
- Falha em aberto: dep que não instala vira warning + hint e o run segue (só `opencode` é required).

## Gate de auth (antes de QUALQUER chamada)

- `--agent opencode` → rode `opencode auth login` uma vez (credenciais do provider já configuradas).
- `--agent codex` → rode `codex login` uma vez (ou `CODEX_PATH` para binário próprio).
- Se falhar com `auth_required` (exit 3), o client imprime o hint exato — autentique e repita. ZERO chamadas sem auth.

## Uso (script único, zero dependências, Node >= 18)

```bash
node skills/acp-client/scripts/acp_client.mjs \
  --agent opencode \        # opencode (nativo) | codex (adaptador) | --command <bin> --arg <a>
  --cwd "<repo-alvo>" \
  [--session <sessionId>]   # retomar sessão (session/load)
  [--model "provider/model"] \
  [--permission safe|allow-all|ask] \
  [--ui lavish] \           # campo de interação ao vivo no browser
  [--json] \                # saída máquina (1 JSON por evento) para macros
  "<prompt da subtask>"
```

- **`safe` (default):** requests de permissão com kind `read` são auto-permitidos; `edit/delete/move` pedem s/N em TTY ou são rejeitados (fail-closed) em run não-interativo.
- **Callbacks de FS** (`fs/read_text_file`/`fs/write_text_file`) só abrem caminhos dentro de `--cwd`.
- Exit: `0` ok · `2` uso · `3` auth_required · `4` transporte/agente.

## Campo de interação no meio do processo (steering)

- **Terminal (TTY):** enquanto o turno roda, qualquer linha digitada vira mensagem — enfileirada e entregue ao fim do turno (estilo Zed). `stop` envia `session/cancel` imediatamente.
- **`--ui lavish`:** abre console HTML em tmpdir via `npx -y lavish-axi` com status ao vivo do agente; o usuário fala pela **Conversation panel** do Lavish e o client consome via `lavish-axi poll` supervisionado (um poll por vez, sem detached). Feedback vira steering na mesma fila. O campo continua disponível em TTY em paralelo.
- **`--json`:** eventos `{type:"agent_text"|"thought"|"tool_call"|"tool_update"|"plan"|"permission"|"steer"|"status"}` e final `{type:"result", sessionId, stopReason}` — para o macro consumir.

## Para macros (builder/planner)

1. **Uma subtask = um run** (prompt autocontido com o trecho do `PLAN.md` + arquivos-alvo). Não reutilize sessão entre subtasks diferentes; `--session` é para continuar a MESMA subtask.
2. Rode com `--json` e parseie a linha `{"type":"result"}`; eventos de `tool_call`/`permission` ficam disponíveis para auditoria no transcript (hook do supervisor).
3. **Permissões:** em run não-interativo o default `safe` nega edit/delete/move — para o builder executar de verdade use `--permission ask` num run em TTY, `allow-all` (explícito, sob sua responsabilidade) ou deixe o AGENTE editar direto nos arquivos do repo dele e traga o diff.
4. **Interação do usuário no meio do processo:** em run interativo use `--ui lavish` (browser) ou TTY (terminal). Em run de macro não-interativo, o usuário NÃO intercepta — programe o ponto de interação como um run separado com `--ui lavish`.
5. **Fallback:** agente ausente/instável → implemente com o critério do próprio macro e registre a pendência no resumo (nunca trave o gate).
6. `--print-logs`: para debug do OpenCode rode `opencode --print-logs acp` (via `--command opencode --arg --print-logs --arg acp`) — stdout carrega só protocolo; logs vão a stderr.

## O que o client NÃO faz

- Não gerencia backlog GitHub (só harness interno via `github-cli`).
- Não implementa hooks da squad dentro do agente externo — guard rails do agente externo são o gate de permissões ACP (`session/request_permission`).
- Não abre porta de rede: ACP é stdio (JSON-RPC ndjson), sessão morre com o processo.
