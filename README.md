# module-sdd-commons
Repositório central para armazenamento, versionamento e gerenciamento de artefatos de IA, como agentes, skills, prompts, instruções e configurações reutilizáveis.

## Instalação

A instalação baixa **apenas a pilha ACP** (rtk, codegraph/ast-grep, lavish-axi,
adaptador codex-acp e o próprio opencode). Os **artefatos da squad** (agents,
skills, commands, hooks, plugins) e os **MCPs** são instalados no momento da
execução, pelo wizard TMR, para o harness que você escolher lá.

```bash
npx --yes github:tuliomourarocha/module-sdd-commons#main            # ACP-only (default)
npx --yes github:tuliomourarocha/module-sdd-commons#main --with-artifacts --opencode   # também copia artefatos p/ .opencode
npx --yes github:tuliomourarocha/module-sdd-commons#main --codex --with-artifacts --target /caminho/do/projeto
```

| Modo | O que instala |
| --- | --- |
| **default (ACP-only)** | Pilha ACP: rtk + codegraph/ast-grep + lavish + adaptador codex-acp + opencode |
| `--with-artifacts` + plataforma | Tudo acima **+ artefatos da squad** no alvo (agents/skills/commands/hooks/plugins) — caminho legado; o normal é deixar o TMR instalar no run |

Quem instala os artefatos em runtime é o `sdd-acp` (passo 2 do wizard), via
`--artifacts-only` — que também registra o MCP codegraph no harness escolhido.
Os artefatos ficam no projeto ("depois pode manter"); rodar o wizard de novo
oferece atualização.

### RTK — economia de tokens durante a instalação

Por padrão, junto com a squad o instalador também baixa o [rtk](https://github.com/rtk-ai/rtk)
(proxy de comandos em Rust que reduz em 60–90% os tokens de saída de bash lidos
pelo LLM) e vincula ao harness escolhido com `rtk init`:

| Harness | Vínculo | O que o rtk instala |
| --- | --- | --- |
| OpenCode | `rtk init --global --opencode` | Plugin TS em `~/.config/opencode/plugins/rtk.ts` (requer OpenCode ≥ 1.18.29) |

## Rodar a squad via ACP — **TMR** (`sdd-acp`)

Além do `@harness` interno (orquestrado pelo agente `harness` no terminal), a squad
pode rodar como **client ACP** com a interface **TMR** no terminal: OpenCode
(`opencode acp`, nativo) ou Codex (adaptador `@agentclientprotocol/codex-acp`)
executam o ciclo `planner → builder → reviewer` com você no comando.

```bash
sdd-acp                       # wizard orquestrador (interativo)
sdd-acp --ui lavish           # + quadros ao vivo no browser (localhost:4387)
sdd-acp doctor                # diagnóstico das dependências
sdd-acp client --agent opencode --cwd <repo> --json "<subtask>"   # run de UMA subtask
```

Sem npm global, o mesmo wizard roda direto do projeto instalado:

```bash
node .opencode/skills/acp-client/scripts/acp_orchestrate.mjs --ui lavish
```

### O wizard (decisões humanas no início)

1. **Harness** — `opencode` (nativo) ou `codex` (adaptador oficial).
2. **Limpar `.planning/`** — lista `STATE.md`/`HANDOFF.md`/specs e pergunta se começa do zero.
3. **Issue do GitHub** — `https://github.com/owner/repo/issues/N`, `owner/repo#N` ou `#N`;
   a tarefa vem de `gh issue view` (sem `gh`, cole o texto manualmente). **Obrigatória
   antes do primeiro agente.**
4. **Modelo por agente** — para planner/builder/reviewer: lista com **custos
   ($/Mtok in·out)**, contexto e o **★ recomendado por papel** (catálogo da squad);
   `enter` aceita o recomendado. A escolha acontece aqui, no runtime — a instalação
   grava só o padrão da squad.
5. **Fases** — planner → builder → reviewer, contexto encadeado; durante as fases
   **digite no terminal para falar com o agente no meio do processo** (steering nativo
   no OpenCode; no Codex a mensagem entra no fim do turno).

### Interface (`--ui lavish`)

O console no browser mostra tudo: **tokens reais + custo USD por agente**
(usage do próprio ACP), quadro de **skills chamadas** (`⟐ skill ✓`), quadro de
**hooks determinísticos** (`⟐ hook ✓`), **comandos invocados** com rtk/codegraph
destacados, e logs de cada processo agêntico. Ao fim, o resumo das métricas é
impresso no terminal.

### Bootstrap automático

Todo run ACP garante as dependências e **baixa o que faltar** pelo método oficial
de cada um (`ensure_deps.mjs`): `lavish-axi`, `codegraph`, `rtk` (validado com
`rtk gain`) e `opencode`. O instalador da squad também os baixa
(`--no-rtk`/`--no-codegraph`/`--no-lavish`/`--no-acp` para pular). Auth do harness:
`opencode auth login` / `codex login` antes do primeiro run.
| Claude Code | `rtk init --global` | Hook nativo `PreToolUse` + patch no `settings.json` |
| Codex | `rtk init --global --codex` | Hook `PreToolUse` (`updatedInput`) + `RTK.md` em `~/.codex` |

Instalação do binário: `brew install rtk` (macOS/Linux com brew), `winget install rtk-ai.rtk`
(Windows) ou o `install.sh` oficial via curl. O rtk falha em aberto: sem o binário,
os hooks executam o comando original e a squad funciona normalmente.

Opções:

```bash
--no-rtk                 # não baixa nem vincula o rtk
--rtk-edition oss        # edição Apache-2.0 (padrão: full)
--rtk-scope project      # vínculo por projeto (claude/codex); opencode é sempre global
--rtk-only               # só baixa/vincula o rtk — útil para adicionar depois de uma instalação
--rtk-agents <csv|all>   # vínculo agnóstico, independente da plataforma da squad:
                         #   all = detecta e vincula todos os harnesses instalados
                         #   csv = lista explícita, ex.: --rtk-agents opencode,codex
```

Um único comando cobre todos os harnesses que você usa (sem executar nada paralelo):

```bash
# squad installada em OpenCode + rtk vinculado a todo harness presente na máquina
npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode --rtk-agents all

# so o vínculo do rtk em todos os harnesses detectados (sem reinstalar artefatos)
npx --yes github:tuliomourarocha/module-sdd-commons#main --rtk-only --rtk-agents all
```

O padrão (sem `--rtk-agents`) continua vinculado às plataformas pedidas no comando.
No Claude Code o patch do `settings.json` é aprovado via `--auto-patch` (sem prompt;
se a versão do rtk não conhecer a flag, cai para o prompt padrão).

A variável `RTK_EDITION=oss` também é respeitada. No OpenCode o vínculo é automático
(`execute.before`/`tool.execute.before`). No Claude Code, o `rtk init` pergunta uma vez
se deve inserir o hook no `settings.json` (`[y/N]` — rode `rtk init --global` num
terminal para aceitar; em scripts segue sem escrever). Depois de instalar, **reinicie o
harness** e acompanhe a economia com `rtk gain` (dados brutos de um comando duvidoso?
`rtk bypass <cmd>; RTK_DISABLED=1 <cmd>`). O `install.sh` legado faz o mesmo passo,
já que ele só instala para OpenCode.

**Prova visível de execução no transcript:** a squad instala plugins de visibilidade em
`.opencode/plugins/` que anexam marcadores curtos na saída do tool — visíveis para
usuário e agentes:

```
⟐ rtk ✓ — saída comprimida pelo proxy RTK antes do LLM ler (economia de tokens de shell)
⟐ skill ✓ — skill "github-cli" carregada
⟐ codegraph ✓ — codegraph.codegraph_explore consultado (exploração semântica)
⟐ hook ✓ guard-rails — pass (HIGH:0 MED:0, 45ms)
⟐ hook ✓ shipper — ok (1200ms, trigger task:reviewer)
```

- `rtk-visibility.ts`: marca comandos shell reescritos pelo RTK (`RTK_VISIBILITY=0` desliga só o marcador; `RTK_DISABLED=1` desliga o rtk inteiro).
- `observability-visibility.ts`: marca carregamento de skills e consultas codegraph.
- Hooks determinísticos (`guard-rails`, `shipper`, `ci-watch`, `supervisor`): marcam quando são acionados e seu status. `OBSERVABILITY_VISIBILITY=0` desliga só os marcadores de observabilidade/hooks (os hooks continuam rodando).

### CodeGraph + ast-grep — inteligência semântica durante a instalação

Junto com o rtk, o instalador configura a pilha de análise de código — mesmos
princípios: binários baixados na hora, vínculo com o harness escolhido e
falha em aberto (sem os binários, a squad funciona só com leitura de arquivos).

| Componente | Papel | Instalação |
| --- | --- | --- |
| `codegraph` | Índice semântico do repositório (símbolos, callers, call paths, impacto) exposto como MCP | npm `@colbymchenry/codegraph` (versão exata) |
| `ast-grep` | Busca estrutural de sintaxe (AST) via CLI | `brew install ast-grep` ou npm `@ast-grep/cli` |
| MCP `codegraph` | Servidor MCP (`codegraph serve --mcp`) registrado no harness | `opencode mcp add codegraph --env CODEGRAPH_TELEMETRY=0 -- codegraph serve --mcp` |
| Índice do projeto | `.codegraph/` (estado gerado, vai para o `.gitignore`) | `codegraph init <projeto>` |

Por harness, o registro do MCP segue o formato nativo de cada um:

| Harness | Config | Vínculo |
| --- | --- | --- |
| OpenCode | `opencode.json` (`mcp.servers.codegraph`) | `opencode mcp add` (CLI nativa; fallback: merge JSON) |
| Claude Code | `.mcp.json` (`mcpServers.codegraph`) | `claude mcp add-json --scope project` (fallback: merge JSON) |
| Codex | `.codex/config.toml` (`[mcp_servers.codegraph]`) | bloco TOML appended pelo instalador |

A telemetria do codegraph fica desligada (`CODEGRAPH_TELEMETRY=0`) e a versão
instalada é sempre exata (resolvida do registro npm no momento da instalação).
Setup, update ou diagnóstico da pilha depois da instalação seguem a skill
`codegraph-ast-grep` (instalada em `skills/`, descoberta via `find-skills`).

Opções:

```bash
--no-codegraph            # não instala codegraph/ast-grep nem registra o MCP
--no-model-picker         # não pergunta modelos; usa o padrão da squad
```

O seletor de modelos só abre em terminal interativo. Em CI, `--dry-run` ou
`--no-model-picker`, a instalação segue determinística com o padrão por papel.

Antes de publicar, é possível testar o binário localmente:

```bash
node ./bin/sdd-harness.js --opencode --target /tmp/meu-projeto
```

Execute o `npx` dentro do repositório de destino; sem `--target`, ele instala no
diretório atual. O sufixo `#main` garante que o script venha da branch publicada
do módulo. Troque-o por uma tag para instalações reproduzíveis, por exemplo
`#v2.1.0`.

`install.sh` permanece disponível como compatibilidade para instalações antigas
do OpenCode. O seletor interativo de modelos faz parte do CLI `sdd-harness`; o
script legado mantém o padrão da squad.

### Política e escolha de modelos

A **escolha de modelos por agente acontece no runtime, no wizard do `sdd-acp`** —
lista completa com custos ($/Mtok in·out) e o recomendado por papel, reusando o
mesmo ranking (`bin/lib/model-picker.js`). A instalação continua com um padrão por
plataforma — no OpenCode o cenário é de custo-benefício no plano **OpenCode Go**
(`opencode-go/*`) — `harness`/`shipper` em `gpt-6-luna`, `planner`/`supervisor` em
`glm-5.3-flash` e `builder`/`reviewer` em `claude-haiku-5-5`; no Claude Code,
aliases Anthropic (`haiku`/`sonnet`); no Codex, o roteamento GPT-5.6 (Luna, Terra e
Sol) gravado em `.codex/sdd-harness.json`. Esse padrão é gravado no frontmatter de
cada agente OpenCode, no `model:` do Claude Code e no `sdd-harness.json` do Codex.

Quem quiser o picker interativo **na instalação** ainda pode: `--model-picker` lista
os modelos do harness escolhido, por agente, ordenados por qualidade ×
custo-benefício para o papel (Enter aceita os recomendados; `r` revisa agente por
agente; `t` mostra a lista completa). Sem TTY (CI, pipe), a instalação usa o padrão
da squad. No OpenCode a lista vem de `opencode models` + catálogo local do harness;
no Claude Code, dos aliases resolvidos pela conta; no Codex, do catálogo OpenAI
conhecido e do modelo já configurado em `~/.codex/config.toml`. Preços são
referência — no plano assinado o que pesa é a cota. Os detalhes e o racional de
ranking estão em [`platforms/model-policy.md`](platforms/model-policy.md).

### Via APM (Agent Package Manager)

Se você usa o APM, a instalação é declarativa pelo arquivo `apm.yml` do pack desejado:

```bash
apm install agentic-squad
```

O APM baixa os artefatos no formato `.agents/`, `.claude/` ou `.github/`. Em seguida:

```bash
# Após o APM baixar, execute o install.sh para converter e copiar para .opencode/
./install.sh
```

### O que o install.sh legado faz

1. **Detecta automaticamente** a origem dos artefatos (`agents/`, `.agents/`, `.claude/`, `.github/`)
2. **Copia** agentes, commands, skills e packs para `.opencode/`
3. **Converte** o frontmatter `tools:` (formato Claude Code) para `permission:` (formato opencode) nos arquivos `.agent.md`
4. **Remove** o campo `allowed-tools:` dos `SKILL.md` (incompatível com opencode)

## Uso do Harness V2

O `harness` (V2) orquestra 3 fluxos com 4 macros + hooks (`planner`, `builder`, `reviewer` arquitetura, `shipper` hook).

### ACP Client + Plano interativo (Lavish) + Skills remotas

- **Squad como ACP client (dois modos):** o **wizard orquestrador** (`skills/acp-client/scripts/acp_orchestrate.mjs`) roda o ciclo `planner → builder → reviewer` por OpenCode/Codex com decisões humanas no início — escolha do harness, limpeza opcional de `.planning/`, **issue do GitHub como input**, e **escolha de modelo por agente** (lista com custos e recomendado por papel, no runtime — não mais na instalação); durante as fases, o usuário interage no meio do processo (steering nativo em TTY) e acompanha no `--ui lavish` quadros ao vivo de **tokens reais + custo USD por agente**, skills chamadas, hooks e comandos invocados (rtk/codegraph destacados). Já o **run de subtask única** (`acp_client.mjs`) serve aos macros internos: streaming, gate de permissões (`--permission safe|allow-all|ask`) e campo de interação do usuário (TTY/`--ui lavish`).
- **Plano em HTML interativo:** o `planner` apresenta o plano (decisões com escolha clicável, riscos, skills sugeridas) aberto no Lavish Editor (`npx -y lavish-axi`) e itera por long-poll até a aprovação do usuário — revisão pelo browser, não pelo terminal (skill `plan-review`).
- **Skills remotas (skills.sh):** `find_skill.py "<termos>" --remote` sugere candidatos do catálogo público da skills.sh; instalação `npx skills add <source>` **somente** com aprovação explícita do usuário, após auditoria (`find_skill.py --audit <id>`).
- **Bootstrap de dependências:** todo run ACP garante e instala o que faltar (`ensure_deps.mjs`) — lavish-axi, codegraph, rtk e opencode (método oficial de cada um; `--doctor` diagnostica, `--no-ensure` pula).

### Arquitetura

| Agente/Hook | Papel | Skills principais |
|--------|-------|-------------------|
| `harness` | Orquestra `feature/project/bugfix` via `task()` | — |
| `planner` | Planeja — PRD, PLAN, arquitetura + cria o backlog no GitHub (issues/épics, labels de prioridade, milestones de sprints) | `po-assistant`, `grill-me`, `mermaid-diagrams`, `clean-architecture`, `github-cli` |
| `builder` | Implementa — full-stack + infra mínima + move o card para execução (nunca cria) | `clean-architecture`, `nextjs-app-router-patterns`, `supabase-postgres-best-practices` |
| `reviewer` | Revisa — só arquitetura técnica/software | `clean-architecture`, `solid`, `clean-code` |
| `shipper` (hook) | Finaliza — baixa/atualiza a develop e cria branch a partir dela (nunca push direto na develop/main), PR `--base develop` (nunca main), git/CI/issue-close (encerra a issue, nunca cria)/STATE/HANDOFF via `hooks/shipper.py` + `plugins/shipper.ts` (fallback minimal) | `state-manager`, `git-commit`, `github-cli` **obrigatória no fallback** (carregar antes de qualquer operação de issues) |

> **Guard rails** (lint, testes, ruff/pylance/eslint/biome, tsc) são hooks determinísticos (`hooks/guard_rails.py`) — `checker` removido.

Fluxo `feature`: `planner → builder → reviewer → shipper(hook)` (2 gates humanos, hooks validam per-file).

### Backlog no GitHub (issues + Projects)

O backlog do harness vive no **GitHub** (issues + Projects v2) — sem board externo. Mapeamento:

| Conceito | GitHub |
|---|---|
| Board | **GitHub Project v2** — campo `Status`: `Backlog` / `In Progress` / `Done` |
| Card | **Issue** (épico = issue com label `epic` + tasklist no corpo) |
| Lista (execução/concluído) | **Status do Project** (`Backlog` → `In Progress` → `Done`) |
| **Prioridade (tag separada)** | labels `P0-critical` / `P1-high` / `P2-medium` / `P3-low` (escolha UMA) |
| **Tipo (tag separada)** | labels `epic` / `feature` / `bug` / `chore` / `docs` |
| Domínio/tags | labels livres (ex.: `auth`, `checkout`, `infra`) |
| Sprint | **milestone** (`Sprint 1`, `Sprint 2`, …) |

Donos por gate (escopo fechado):

- **`planner` — único que CRIA**: `ensure-labels` (labels padrão de prioridade/tipo, idempotente), `ensure-milestone "Sprint N"`, `create-issue` (com labels `P1-high,feature,<domínio>`, milestone e adição ao Project com Status `Backlog`) via `skills/github-cli/scripts/sdd_backlog.py`.
- **`builder` — só move/atualiza**: `move-issue <n> --project "<Project>" --status "In Progress" --assign-me`.
- **`shipper` (hook) — só encerra**: localiza a issue (`--issue`/`SDD_GITHUB_ISSUE`, `Closes #N` no body do PR ou prefixo numérico do branch ex. `123-slug`) e fecha (`gh issue close` + comentário do PR + Status `Done` no Project — env `SDD_GITHUB_PROJECT`).

Gate de auth: `gh auth status` é o 1º comando de qualquer operação de issues (falhou → `gh auth login`). CLI determinístico completo: `python3 skills/github-cli/scripts/sdd_backlog.py --help`.

### Pré-requisitos

1. Instale o módulo (veja "Instalação em outros repositórios" acima)
2. O agente precisa estar em `.opencode/agents/` — rode `./install.sh` para copiar

### Fluxo 1: Nova Feature (`feature`)

Para adicionar funcionalidades em projeto existente:

```
@harness Implementar cadastro de usuários com autenticação two-factor
```

O orquestrador executa:
1. **Planner** → discovery + `PRD.md` + `PLAN.md` + `arch/` (memória — nunca em disco) + cria o backlog no GitHub (issues/épics, labels de prioridade, milestones de sprints; números em memória)
2. **Builder** → implementa + resumo em memória (nunca `SUMMARY.md` em disco) + move a issue para execução (Status `In Progress`; nunca cria issue) — `hooks/guard_rails.py` valida per-file e bloqueia `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`
3. **Reviewer** → parecer de arquitetura em memória (nunca `REVIEW.md`/`VALIDATION.md` em disco, sem lint — hooks fazem)
4. **Shipper(hook)** → fetch develop + atualiza a develop local + branch de trabalho a partir da develop ATUALIZADA (nunca push direto na develop/main) + commit + PR `--base develop` (nunca main) + CI check + `.planning/STATE.md`/`HANDOFF.md` + issue close (encerra a issue → comentário do PR + Status `Done` no Project; instrução de `gh auth login` se sem auth; nunca cria issue) (via `hooks/shipper.py`)

### Fluxo 2: Novo Projeto (`project`)

Para projetos novos do zero:

```
@harness Criar um e-commerce com Next.js, Supabase e Vercel
```

O orquestrador executa:
1. **Planner (discover)** → visão, roadmap, PRD do projeto
2. **Builder (scaffold)** → estrutura + CI/CD + arch base
3. **Feature Cycle** → repete o fluxo `feature` para cada funcionalidade
4. **Shipper (finalize)** → deploy preview + docs

### Fluxo 3: Correção de Bug (`bugfix`)

Para corrigir bugs de forma rápida:

```
@harness Corrigir erro 500 ao finalizar compra no checkout
```

O orquestrador executa:
1. **Planner (triage)** → reproduz, causa, escopo do fix
2. **Builder (fix)** → corrige código
3. **Reviewer** → review arquitetura
4. **Shipper(hook)** → PR + CI + close

### Avançado

O orquestrador detecta o fluxo automaticamente pela descrição da tarefa. Para forçar um fluxo específico, inicie com:

```
@harness [feature] Adicionar busca por texto nos produtos
@harness [project] Landing page corporativa
@harness [bugfix] Botão de login não funciona no Safari
```

Compatibilidade: `@harness-orchestrator` continua como alias para `@harness`.

### Mapeamento de diretórios

| Origem → | Destino |
|---|---|
| `agents/*.agent.md` | `.opencode/agents/*.agent.md` |
| `.agents/*.agent.md` | `.opencode/agents/*.agent.md` |
| `commands/*.prompt.md` | `.opencode/commands/*.prompt.md` |
| `skills/*/` | `.opencode/skills/*/` |
| `packs/*/` | `.opencode/packs/*/` |
| `AGENTS.md` | `.opencode/AGENTS.md` |
| `.claude/CLAUDE.md` | `.opencode/AGENTS.md` |
| `.claude/skills/*/` | `.opencode/skills/*/` |
| `.claude/commands/*.md` | `.opencode/commands/*.md` |
| `.github/*` | `.opencode/.github/*` |
