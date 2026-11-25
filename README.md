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

O instalador continua com um padrão por plataforma — no OpenCode o cenário é de
custo-benefício no plano **OpenCode Go** (`opencode-go/*`) — `harness`/`shipper` em
`gpt-6-luna`, `planner`/`supervisor` em `glm-5.3-flash` e `builder`/`reviewer` em
`claude-haiku-5-5`; no Claude Code, aliases Anthropic (`haiku`/`sonnet`); no Codex,
o roteamento GPT-5.6 (Luna, Terra e Sol) gravado em `.codex/sdd-harness.json`.

Em terminal interativo, antes de copiar os artefatos o instalador **lista os modelos
disponíveis do harness escolhido, por agente**, ordenados por qualidade ×
custo-benefício para aquele papel. O recomendado aparece destacado em verde com `★`.
Enter aceita todos os recomendados; `r` revisa agente por agente; `t` mostra a lista
completa; e o usuário pode escolher outro modelo ou manter o padrão. A escolha é
aplicada no frontmatter de cada agente OpenCode, no `model:` do Claude Code e no
`sdd-harness.json` do Codex.

Sem TTY (CI, pipe) ou com `--no-model-picker`, a instalação usa o padrão da squad.
No OpenCode a lista vem de `opencode models` + catálogo local do harness; no Claude
Code, dos aliases resolvidos pela conta; no Codex, do catálogo OpenAI conhecido e do
modelo já configurado em `~/.codex/config.toml`. Preços são referência — no plano
assinado o que pesa é a cota. Os detalhes e o racional de ranking estão em
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
