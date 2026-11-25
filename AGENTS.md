# Global Rules — module-sdd-commons

Regras globais que se aplicam a todos os agentes neste projeto.

## Harness V2 — 4 Macros + Hooks

| Agente | Papel | Quando |
|--------|-------|--------|
| `harness` | Orquestra 3 fluxos via `task()` | Sempre primeiro |
| `planner` | **Planeja** — PRD, PLAN, arquitetura; **cria o backlog no GitHub** (issues/épics, labels de prioridade, milestones de sprints) — único que cria | Gate 1 |
| `builder` | **Implementa** — full-stack + infra mínima; **move a issue para execução** (nunca cria) | Gate 2 |
| `reviewer` | **Revisa** — só arquitetura técnica/software (sem lint/testes) | Gate 3 |
| `shipper` | **Finaliza (hook)** — git/PR/CI/**encerra a issue GitHub** (fecha + Status `Done`; nunca cria) via `hooks/shipper.py` + `plugins/shipper.ts`; fallback minimal só STATE/HANDOFF | Gate 4 (hook) |
| `ci-watch` | **Verifica CI (hook)** — polling `gh pr checks` + `gh run list` via `hooks/ci_watch.py` + `plugins/ci-watch.ts`; se falhar, inicia loop builder (max 2); orquestrador opcional `hooks/ci_orchestrator.py` com LangGraph | Pós-shipper (Gate 4+) |

> **Guard rails** (lint, typecheck, testes, ruff/pylance/eslint/biome, secrets, size) são **hooks determinísticos** (`hooks/guard_rails.py` + `plugins/guard-rails.ts`) — single source of truth. `checker` removido. **CI watch** é hook determinístico pós-shipper (`hooks/ci_watch.py` + `plugins/ci-watch.ts`) que aguarda conclusão do CI e dispara loop de correção; orquestração avançada opcional via `hooks/ci_orchestrator.py` (LangGraph StateGraph) sem dependência obrigatória.

Fluxos: `feature` (planner→builder→reviewer→shipper(hook)→ci-watch→supervisor), `project` (discover→scaffold→loop feature→finalize via hook+ci-watch), `bugfix` (triage→fix→review→ship(hook)→ci-watch).

## Estrutura do Projeto

- `agents/` — 5 agentes V2 (harness, planner, builder, reviewer, shipper minimal) + `supervisor` (observability via hook)
- `commands/` — `harness.prompt.md` (fluxos)
- `skills/` — habilidades instaladas; os arquivos dos macros não têm skills dedicadas — descobrem a skill correta por operação via `find-skills` (busca **local** nesta pasta, sem rede)
- `packs/` — `agentic-squad` (harness V2)
- `hooks/` — `guard_rails.py` ( pós-edição), `shipper.py` (git/PR/issues GitHub/STATE), `ci_watch.py` (polling CI + retry), `ci_orchestrator.py` (LangGraph opcional), `supervisor.py` (auditoria)
- `plugins/` — `guard-rails.ts`, `shipper.ts`, `ci-watch.ts`, `supervisor.ts` (hooks determinísticos)
- `.planning/` — apenas `STATE.md`/`HANDOFF.md` (single source; shipper, ci-watch, supervisor e orquestrador atualizam esses dois via marcadores CI_REPORT/SUPERVISOR/ORCHESTRATOR ao invés de criar .md separados). Artefatos de planejamento (`PRD.md`, `PLAN.md`, `arch/*`) e saídas de builder/reviewer (resumo/parecer) são **em memória** e nunca em disco — `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md` são **PROIBIDOS** como arquivos separados.

## Regras Gerais

1. **Progressive Disclosure** — Agentes são concisos (≤120 linhas); detalhe em `commands/harness.prompt.md`.
2. **Autossuficiência** — Cada macro incorpora regras e hooks; não busca regras externas.
3. **Skills > Subagentes** — Especialidade via skill descoberta por `find-skills` (busca **local** na pasta `skills/` — `python3 skills/find-skills/scripts/find_skill.py '<query>'`; sem rede, sem `npx skills`), não via agente folha. Só `harness` usa `task()`.
4. **Estado único** — `shipper`, `ci-watch`, `supervisor` e `orquestrador` atualizam `STATE.md`/`HANDOFF.md` (via marcadores) e fazem PR/CI/issue-close; macros retornam artefatos em memória (backlog GitHub: planner cria issues, builder move para execução, shipper encerra).
5. **Idioma** — Português padrão para artefatos.
6. **Validação** — Execute hooks antes de finalizar cada artefato.
7. **Anti-loop e Single-run** — Apenas `STATE.md`/`HANDOFF.md` persistem em disco (hooks `shipper`, `ci-watch`, `supervisor`, `orquestrador` atualizam esses dois). Demais artefatos (`PRD.md`, `PLAN.md`, `arch/*`) e saídas de builder/reviewer (resumo/parecer) são retornados **em memória** via `task()` e injetados como `context:` pelo `harness`. Proibido criar `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md` em disco — bloqueado com `HIGH`. `harness` **só delega e encerra** — não espera hooks, não faz polling, não executa nada. `VALIDATION.md` removido (hook guard_rails).
8. **Backlog GitHub exige skill (via `find-skills`, busca local) e tem dono por gate** — Todo agente que acessa issues (`planner`, `builder`, `shipper` no fallback; hooks apenas registram) DEVE descobrir via `find-skills` (busca local na pasta `skills/`, query `github issues`) e carregar a skill `github-cli` **antes** de qualquer operação — **gate obrigatório `gh auth status` sempre como 1º comando** (falhou → `gh auth login` e repetir; pendência registrada, ZERO operações, nem leitura), depois resolução de issue por número (`context:` `issueId`/`--issue`/`SDD_GITHUB_ISSUE`) ou título (`sdd_backlog.py find-issue "<título>"`) e operações via `gh`/CLI do helper (`skills/github-cli/scripts/sdd_backlog.py`). 401 no meio da sequência → `gh auth login` de novo e repetir a operação. Proibido improvisar chamadas cruas à API sem a skill; é isso que faz o agente se perder. **Mapeamento:** board = GitHub Project v2 (campo `Status`: `Backlog`/`In Progress`/`Done`); card = issue; prioridade = labels `P0-critical`/`P1-high`/`P2-medium`/`P3-low` (separadas); tipo = labels `epic`/`feature`/`bug`/`chore`/`docs` (separadas); domínio/tags = labels livres; sprints = milestones. **Quem faz o quê (escopo fechado):**
   - `planner` — **único que CRIA**: issues/épics (`create-issue`), labels de prioridade/tipo (`ensure-labels`), sprints (`ensure-milestone`); retorna os números em memória para os próximos gates.
   - `builder` — só **move/atualiza**: `move-issue` para Status `In Progress` (+ `--assign-me`); **proibido criar/excluir**.
   - `shipper` — só **encerra**: fecha a issue (`close-issue` no hook ou fallback) com comentário do PR e Status `Done` no Project; **proibido criar/excluir**.

## ACP Client + Skills remotas + Revisão de plano (Lavish)

9. **ACP Client — squad como client, OpenCode/Codex como agents** — a squad controla harness externos via Agent Client Protocol (stdio JSON-RPC, v1) com `skills/acp-client/scripts/acp_client.mjs` (zero deps): `--agent opencode` (`opencode acp`, nativo) ou `--agent codex` (adaptador oficial `@agentclientprotocol/codex-acp`). Entrada oficial do humano: **`sdd-acp`** (bin npm; fallback `node .opencode/skills/acp-client/scripts/acp_orchestrate.mjs`) com `doctor` (deps) e `client <args>` (subtask única). **Modo orquestrador (wizard interativo, `acp_orchestrate.mjs`, interface TMR)** — quando um humano roda o ciclo, o ACP substitui o agente `harness` interno: (1) usuário escolhe o harness; (2) decide limpar `.planning/` (STATE/HANDOFF/specs) para começar do zero; (3) informa a **issue do GitHub** com a tarefa (busca via `gh`, obrigatória antes do primeiro agente); (4) escolhe o **modelo por agente** de uma lista com custos e o recomendado por papel (`bin/lib/model-picker.js` — a escolha NÃO é mais na instalação; lá grava só o padrão da squad); (5) fases rodam com **steering nativo** (usuário interage no meio do turno) e `--ui lavish` com quadros ao vivo: **tokens reais e custo USD por agente** (`usage`/`usage_update` do ACP), skills chamadas (`⟐ skill ✓`), hooks (`⟐ hook ✓`) e comandos invocados (rtk/codegraph destacados). **Bootstrap automático a cada run** (`ensure_deps.mjs`, idempotente): baixa o que faltar — lavish-axi (`npm install -g`), codegraph (npm), rtk (brew/curl, valida com `rtk gain`) e opencode (installer oficial); `--doctor` para diagnóstico, `--no-ensure`/`ACP_SKIP_ENSURE=1` para pular. **Gate de auth** (`opencode auth login` / `codex login`) sempre antes do primeiro run — `auth_required` (exit 3) → autenticar e repetir, zero operações sem auth. Run de UMA subtask segue no `acp_client.mjs` (macros internos); `--json` para macros (eventos + `{"type":"result"}`); `--permission safe|allow-all|ask` gate-kepta os tool calls externos. Fallback em aberto: agente indisponível → macro executa com critério próprio e registra pendência.
10. **Skills remotas (skills.sh) = sugestão, nunca install automático** — `find_skill.py --remote "<termos>"` consulta o endpoint público `skills.sh/api/search` (o do CLI oficial `npx skills`; falha em aberto → segue local-only). O **planner** inclui os candidatos na seção "Skills sugeridas" do plano e **instala só os aprovados pelo usuário**: auditoria pública primeiro (`find_skill.py --audit <id>`), depois `npx skills add <source>`, confirmação com busca local. Sem `--remote`, a busca é 100% offline como antes.
11. **Plano em HTML interativo via Lavish (não terminal)** — no fim do planejamento, o `planner` gera o plano como HTML self-contained em **tmpdir** (nunca `.planning/**`), abre no Lavish Editor (`npx -y lavish-axi <file>`) e faz long-poll em foreground (`lavish-axi poll`) para receber feedback do browser (anotações, escolhas clicáveis com `window.lavish.queuePrompt()`, mensagens); responde com `poll --agent-reply` e itera até aprovação ou `ended`; encerra com `lavish-axi end`. O usuário **opta** por decisões e skills no browser; artefato é descartável e o conteúdo aprovado volta em memória no `PLAN.md`.

## RTK — economia de tokens (quando instalado)

7. **Rodar em cima do rtk** — o instalador da squad baixa o `rtk` (`github.com/rtk-ai/rtk`) e vincula ao harness (`rtk init`): um proxy reescreve comandos de shell (`git status` → `rtk git status`) e comprime a saída antes do LLM ler.
   - **Nunca** adicione prefixo `rtk` manualmente — o plugin/hook faz a reescrita transparente.
   - O rtk só intercepta **comandos de shell**: built-ins `read`/`grep`/`glob` não passam por ele. Para leituras grandes, prefira shell (`rg`, `cat`, `git diff`) para gerar economia.
   - Saída parecer cortada/estranha? `rtk bypass <cmd>` executa sem filtro (escape hatch); `RTK_DISABLED=1 <cmd>` desliga na sessão.
   - Métricas: `rtk gain` (economia acumulada), `rtk discover` (oportunidades perdidas) — o `supervisor` pode citar o ganho no parecer.
   - **Visibilidade (prova de execução):** plugins anexam marcadores curtos no transcript (visíveis ao usuário e aos agentes). `rtk-visibility.ts` anexa `⟐ rtk ✓ — saída comprimida pelo proxy RTK` em comandos shell reescritos (`RTK_VISIBILITY=0` desliga só o marcador, rtk continua ativo). `observability-visibility.ts` anexa `⟐ skill ✓ — skill "<id>" carregada` ao carregar skills e `⟐ codegraph ✓ — <tool> consultado (exploração semântica)` ao consultar codegraph. Os hooks determinísticos (`guard-rails`, `shipper`, `ci-watch`, `supervisor`) anexam `⟐ hook ✓ <hook> — <status> (...)` no output da tool que os acionou. `OBSERVABILITY_VISIBILITY=0` desliga só esses marcadores (hooks continuam rodando). Não confunda marcadores com saída do comando nem os remova.

## CodeGraph + ast-grep — inteligência semântica (quando instalado)

O instalador da squad também configura a pilha de análise de código, com a mesma filosofia de falha em aberto do rtk (sem os binários, a squad segue funcionando só com leitura de arquivos):

- `codegraph` (`github.com/colbymchenry/codegraph`, npm `@colbymchenry/codegraph`) — índice semântico do repositório, exposto como MCP: `opencode mcp add codegraph --env CODEGRAPH_TELEMETRY=0 -- codegraph serve --mcp` (Claude: `.mcp.json`; Codex: `.codex/config.toml`).
- `ast-grep` (brew ou npm `@ast-grep/cli`) — busca estrutural de sintaxe (AST) via CLI.
- Índice do projeto em `.codegraph/` (estado gerado, no `.gitignore`), criado com `codegraph init`; telemetria desligada (`CODEGRAPH_TELEMETRY=0`).

Regras para os agentes:

8. **Escopo semântico antes da leitura crua** — para explorar o repositório (símbolos, callers, call paths, impacto), prefira o MCP `codegraph` (ex.: `codegraph_explore`) antes de abrir arquivos um a um; use `ast-grep` quando o formato estrutural (AST) do que se busca já é conhecido. Evidência semântica e estrutural se reconciliam antes de reescritas amplas.
   - Setup, update ou diagnóstico da pilha (`setup`/`update`/`doctor`) **sempre via skill `codegraph-ast-grep`**, descoberta com `find-skills` (busca local) — nunca improvisar instalação/configuração por fora.
   - Índice fresco? `codegraph status`; telemetria sempre desligada em comandos skill-driven (`CODEGRAPH_TELEMETRY=0`).
   - Não instale o MCP experimental do ast-grep nem crie `sgconfig.yml`/`.codegraph/config.json` sem necessidade real (só quando o usuário pedir regras reutilizáveis).

## Memória e Política de Artefatos — Restrição Obrigatória

> Objetivo: impedir criação de artefatos em disco fora de `HANDOFF`/`STATE`, evitando loop de verificação e garantindo reaproveitamento de contexto via injeção única do `harness`.

- **Persistência em disco (allow):** Apenas `.planning/STATE.md` e `.planning/HANDOFF.md`, e **exclusivamente pelos hooks** `shipper` (Gate 4), `ci-watch`, `supervisor` e `orquestrador` (atualizam esses dois via marcadores). `permission` desses hooks permite apenas esses dois arquivos; `deny` para demais `.planning/**`.
- **Artefatos em memória (deny em disco):** `PRD.md`, `PLAN.md` e `arch/*` **NUNCA** são escritos como arquivos. O macro gera o conteúdo e retorna em memória ao `harness` (`return {artefato}`); `harness` injeta como `context:` no próximo macro. **PROIBIDO criar** `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md`/`ci_metrics.json`/`ORCHESTRATOR_STATE.json` — qualquer `write`/`edit`/`bash` que tente criar esses artefatos ou qualquer `.planning/**` fora de `STATE`/`HANDOFF` deve ser negado por `permission: deny` e tratado como erro `HIGH`. `VALIDATION.md` removido.
- **Hooks ci-watch/supervisor/orquestrador:** Também só podem atualizar `STATE.md`/`HANDOFF.md` (marcadores `CI_REPORT:START`, `SUPERVISOR:START`, `ORCHESTRATOR:START` etc.) — **nunca criar `CI_REPORT.md`, `SUPERVISOR_REPORT.md`, `ci_metrics.json`, `ORCHESTRATOR_STATE.json` como arquivos separados** (bloqueado com HIGH; legado só via env `CI_WATCH_LEGACY=1`/`SUPERVISOR_LEGACY=1`).
- **Harness delega e encerra:** `harness` roda o pipeline via `task()` (planner → builder → reviewer → shipper) e termina. Hooks `ci-watch`/`supervisor` continuam sozinhos; não há polling nem espera no harness.
- **Injeção única:** `harness` lê `STATE.md`/`HANDOFF.md` **uma vez** no início e repassa; macros **NÃO** releem `.planning/*.md` se já injetado — usam o `context:` recebido. Releitura só se `context:` ausente.
- **Reaproveitamento:** `STATE` guarda `flow`, `gate`, `artifacts status`, `next step`; `HANDOFF` guarda o que foi feito, arquivos alterados, decisões e pendências — próximo agente consome sem re-verificar artefatos antigos.
- **Permissions por agente:**
  - `harness`: `edit: deny`, `bash: deny`, `skill: deny`, `glob/grep: deny`, `read` allow apenas para `.planning/STATE.md` e `.planning/HANDOFF.md` (só delega — exploração, skills e backlog GitHub pertencem aos macros: planner cria, builder move, shipper encerra; hooks viram hooks).
  - `planner|builder|reviewer`: `edit: deny` para `.planning/**` (inclui `PRD/PLAN/SUMMARY/REVIEW/VALIDATION/arch`), `allow` apenas para código-fonte do escopo do gate; tentativa de escrita em `.planning/**` é bloqueada (especialmente `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` → `HIGH`). Backlog GitHub via bash (`gh`/CLI do helper `sdd_backlog.py`) só no escopo do papel: `planner` cria (issues/labels/milestones), `builder` só move/atualiza; `reviewer` não toca em issues. Guard rails em hooks, não em agents.
  - `shipper`: `edit: allow` apenas para `.planning/HANDOFF.md` e `.planning/STATE.md` (fallback minimal); `deny` para demais `.planning/**`. Hook `shipper.py` é primário para git/PR/issue-close (encerra a issue, nunca cria). No fallback, skill `github-cli` descoberta via `find-skills` é obrigatória antes de qualquer operação de issues — só encerrar/atualizar (proibido criar/excluir).
- **Violação:** Se um agente tentar `write` em `.planning/PRD.md` etc., o sistema nega por `permission` e o agente deve retornar o conteúdo em memória em vez de persistir. CI/review deve apontar `HIGH` se detectar artefato fora de `STATE`/`HANDOFF` criado em disco. Criação de `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` é sempre `HIGH`.
