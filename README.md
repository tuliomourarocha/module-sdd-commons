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

O instalador decide os modelos por plataforma: OpenCode preserva os modelos
originais `opencode/*`; Claude Code usa aliases Anthropic (`haiku`/`sonnet`); e
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

O `harness` (V2) orquestra 3 fluxos com 5 macros (planner, builder, checker, reviewer, shipper).

### Arquitetura

| Agente | Papel | Skills principais |
|--------|-------|-------------------|
| `harness` | Orquestra `feature/project/bugfix` via `task()` | — |
| `planner` | Planeja — PRD, PLAN, arquitetura | `po-assistant`, `grill-me`, `mermaid-diagrams`, `clean-architecture` |
| `builder` | Implementa — full-stack + infra mínima | `clean-architecture`, `nextjs-app-router-patterns`, `supabase-postgres-best-practices` |
| `checker` | Valida — testes unit/API/e2e | `webapp-testing`, `typescript-expert` |
| `reviewer` | Revisa — lint, typecheck, code review | `clean-code`, `solid`, `typescript-react-reviewer` |
| `shipper` | Finaliza — commit, PR, CI, Trello close | `git-commit`, `github-cli`, `trello-manager`, `state-manager` |

Fluxo `feature`: `planner → builder → [checker ∥ reviewer] → shipper` (2 gates humanos, 5 tasks, 1 Trello sync).

### Pré-requisitos

1. Instale o módulo (veja "Instalação em outros repositórios" acima)
2. O agente precisa estar em `.opencode/agents/` — rode `./install.sh` para copiar

### Fluxo 1: Nova Feature (`feature`)

Para adicionar funcionalidades em projeto existente:

```
@harness Implementar cadastro de usuários com autenticação two-factor
```

O orquestrador executa:
1. **Planner** → discovery + `.planning/PRD.md` + `.planning/PLAN.md` + `arch/`
2. **Builder** → implementa + `.planning/SUMMARY.md`
3. **Checker ∥ Reviewer** → `.planning/VALIDATION.md` + `.planning/REVIEW.md` (paralelo)
4. **Shipper** → commit + PR + CI check + `.planning/STATE.md`/`HANDOFF.md` + Trello close

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
3. **Checker ∥ Reviewer** → testes + review
4. **Shipper** → PR + CI + close

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
