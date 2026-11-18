# module-sdd-commons
Repositório central para armazenamento, versionamento e gerenciamento de artefatos de IA, como agentes, skills, prompts, instruções e configurações reutilizáveis.

## Instalação multi-harness

O mesmo Harness V2 pode ser instalado em OpenCode, Claude Code ou Codex sem
publicar um pacote no npm. O comando baixa e executa o `package.json` deste
repositório:

```bash
npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode
npx --yes github:tuliomourarocha/module-sdd-commons#main --claude --target /caminho/do/projeto
npx --yes github:tuliomourarocha/module-sdd-commons#main --codex
npx --yes github:tuliomourarocha/module-sdd-commons#main --all
```

O CLI escreve somente diretórios gerenciados pelo harness:

| Alvo | Artefatos instalados | Como iniciar |
| --- | --- | --- |
| OpenCode | `.opencode/agents`, `commands`, `skills` | `@harness <pedido>` |
| Claude Code | `.claude/agents`, `commands`, `skills`, `CLAUDE.md` | `/sdd-harness <pedido>` |
| Codex | `.codex/skills/sdd-harness`, `roles`, `skills` | `$sdd-harness <pedido>` |

### RTK — economia de tokens durante a instalação

Por padrão, junto com a squad o instalador também baixa o [rtk](https://github.com/rtk-ai/rtk)
(proxy de comandos em Rust que reduz em 60–90% os tokens de saída de bash lidos
pelo LLM) e vincula ao harness escolhido com `rtk init`:

| Harness | Vínculo | O que o rtk instala |
| --- | --- | --- |
| OpenCode | `rtk init --global --opencode` | Plugin TS em `~/.config/opencode/plugins/rtk.ts` (requer OpenCode ≥ 1.18.29) |
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

**Prova visível de que o rtk está rodando:** a reescrita do rtk é silenciosa por
natureza, então a squad instala também o plugin `rtk-visibility.ts` em
`.opencode/plugins/`: todo comando reescrito recebe um rodapé na própria saída —

```
⟐ rtk ✓ — saída comprimida pelo proxy RTK antes do LLM ler (economia de tokens de shell)
```

Você e os agentes veem esse marcador no transcript sempre que o proxy atuar
(a primeira marcação da sessão lembra o comando `rtk gain`). `RTK_VISIBILITY=0`
desliga só o marcador; `RTK_DISABLED=1` desliga o rtk inteiro.

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
```

Antes de publicar, é possível testar o binário localmente:

```bash
node ./bin/sdd-harness.js --opencode --target /tmp/meu-projeto
```

Execute o `npx` dentro do repositório de destino; sem `--target`, ele instala no
diretório atual. O sufixo `#main` garante que o script venha da branch publicada
do módulo. Troque-o por uma tag para instalações reproduzíveis, por exemplo
`#v2.1.0`.

`install.sh` permanece disponível como compatibilidade para instalações antigas
do OpenCode.

### Política de modelos

O instalador decide os modelos por plataforma: no OpenCode o cenário é de custo-benefício
no plano **OpenCode Go** (`opencode-go/*`) — `harness`/`shipper` em `gpt-6-luna`,
`planner`/`supervisor` em `glm-5.3-flash` e `builder`/`reviewer` em `claude-haiku-5-5`;
o Zen free (`opencode/big-pickle` no harness) foi testado e descartado porque a cota
esgota e trava o ciclo, e `console-openai` foi abandonado por
cobrar crédito da organização OpenAI (`credit_balance_exhausted`). Claude
Code usa aliases Anthropic (`haiku`/`sonnet`); e
Codex grava o roteamento GPT-5.6 (Luna, Terra e Sol) por papel em
`.codex/sdd-harness.json`. Não há escolha manual de modelos durante a instalação. Os detalhes estão em
[`platforms/model-policy.md`](platforms/model-policy.md).

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

### Arquitetura

| Agente/Hook | Papel | Skills principais |
|--------|-------|-------------------|
| `harness` | Orquestra `feature/project/bugfix` via `task()` | — |
| `planner` | Planeja — PRD, PLAN, arquitetura + cria o backlog no Trello (cards/epics, tags de prioridade, sprints) | `po-assistant`, `grill-me`, `mermaid-diagrams`, `clean-architecture`, `trello-manager` |
| `builder` | Implementa — full-stack + infra mínima + move o card para execução (nunca cria) | `clean-architecture`, `nextjs-app-router-patterns`, `supabase-postgres-best-practices` |
| `reviewer` | Revisa — só arquitetura técnica/software | `clean-architecture`, `solid`, `clean-code` |
| `shipper` (hook) | Finaliza — branch de `origin/develop` atualizada, PR `--base develop` (nunca main), git/CI/Trello-close (encerra o card, nunca cria)/STATE/HANDOFF via `hooks/shipper.py` + `plugins/shipper.ts` (fallback minimal) | `state-manager`, `git-commit`, `github-cli`, `trello-manager` **obrigatória no fallback** (carregar antes de qualquer operação Trello) |

> **Guard rails** (lint, testes, ruff/pylance/eslint/biome, tsc) são hooks determinísticos (`hooks/guard_rails.py`) — `checker` removido.

Fluxo `feature`: `planner → builder → reviewer → shipper(hook)` (2 gates humanos, hooks validam per-file).

### Pré-requisitos

1. Instale o módulo (veja "Instalação em outros repositórios" acima)
2. O agente precisa estar em `.opencode/agents/` — rode `./install.sh` para copiar

### Fluxo 1: Nova Feature (`feature`)

Para adicionar funcionalidades em projeto existente:

```
@harness Implementar cadastro de usuários com autenticação two-factor
```

O orquestrador executa:
1. **Planner** → discovery + `PRD.md` + `PLAN.md` + `arch/` (memória — nunca em disco) + cria o backlog no Trello (cards/epics, tags de prioridade, sprints; IDs em memória)
2. **Builder** → implementa + resumo em memória (nunca `SUMMARY.md` em disco) + move o card para a lista de execução (nunca cria card) — `hooks/guard_rails.py` valida per-file e bloqueia `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md`
3. **Reviewer** → parecer de arquitetura em memória (nunca `REVIEW.md`/`VALIDATION.md` em disco, sem lint — hooks fazem)
4. **Shipper(hook)** → fetch develop + branch de `origin/develop` atualizada + commit + PR `--base develop` (nunca main) + CI check + `.planning/STATE.md`/`HANDOFF.md` + Trello close (encerra o card → última lista "concluído"; reauth automático em 401; nunca cria card) (via `hooks/shipper.py`)

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
