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

## Console TMR

Use `sdd-acp` para abrir o console HTML local na escolha do harness.
No clone da squad, a entrada equivalente é `node bin/sdd-acp.js`.
O console aceita `--cwd <repo>`, `--agent opencode|codex`, `--model <id>`,
`--port <n>`, `--no-open` e `--no-ensure`.

Na página, escolha o harness, decida sobre a instalação de artefatos e a limpeza
de `.planning/` e indique a issue do GitHub. O console verifica `gh auth status`
antes de ler a issue. Aprove as fases planner, builder, reviewer, shipper e
supervisor e escolha um modelo por fase, salvo quando `--model` estiver definido.

A página reúne permissões ACP, mensagens ao agente, revisão do plano e da
auditoria, seleção de skills, logs e métricas. Skills remotas selecionadas
passam por auditoria antes da instalação. O feedback do plano segue para o
builder e o da auditoria pode iniciar mais um turno do supervisor. Harnesses com
steering nativo recebem mensagens durante o turno. Os demais recebem a mensagem
em um turno extra.

O modo de uma subtask, `sdd-acp client`, continua disponível para macros e
automações. As opções de Lavish abaixo são para esse modo.

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
