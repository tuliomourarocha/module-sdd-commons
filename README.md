# module-sdd-commons
Repositório central para armazenamento, versionamento e gerenciamento de artefatos de IA, como agentes, skills, prompts, instruções e configurações reutilizáveis.

## Instalação em outros repositórios

Para instalar este módulo em outro projeto, execute o `install.sh` direto da raiz do módulo:

```bash
# 1. Clone ou copie este módulo para seu projeto
git clone https://github.com/tuliomourarocha/module-sdd-commons.git /tmp/module-sdd-commons

# 2. Execute o install.sh apontando para .opencode/ do seu projeto
/tmp/module-sdd-commons/install.sh /caminho/do/seu/projeto/.opencode
```

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

### O que o install.sh faz

1. **Detecta automaticamente** a origem dos artefatos (`agents/`, `.agents/`, `.claude/`, `.github/`)
2. **Copia** agentes, commands, skills e packs para `.opencode/`
3. **Converte** o frontmatter `tools:` (formato Claude Code) para `permission:` (formato opencode) nos arquivos `.agent.md`
4. **Remove** o campo `allowed-tools:` dos `SKILL.md` (incompatível com opencode)

## Uso do Harness Orchestrator

O `harness-orchestrator` orquestra 3 fluxos de desenvolvimento delegando cada gate ao agente especializado.

### Pré-requisitos

1. Instale o módulo (veja "Instalação em outros repositórios" acima)
2. O agente precisa estar em `.opencode/agents/` — rode `./install.sh` para copiar

### Fluxo 1: Nova Feature (`feature`)

Para adicionar funcionalidades em projeto existente:

```
@harness-orchestrator Implementar cadastro de usuários com autenticação two-factor
```

O orquestrador executa:
1. **Discuss** → `po-agent` descobre requisitos, produz PRD
2. **Plan** → `techlead` + `architecture-reviewer` desenham arquitetura
3. **Execute** → `backend-dev` + `frontend-dev` + `devops-infra` implementam
4. **Validate** → `qa-engineer` + `code-reviewer-*` + `linter` validam

### Fluxo 2: Novo Projeto (`project`)

Para projetos novos do zero:

```
@harness-orchestrator Criar um e-commerce com Next.js, Supabase e Vercel
```

O orquestrador executa:
1. **Discover** → `po-agent` define visão do produto e roadmap
2. **Scaffold** → `techlead` + `devops-infra` montam estrutura + CI/CD
3. **Feature Cycle** → repete o fluxo `feature` para cada funcionalidade
4. **Finalize** → `qa-engineer` + `devops-infra` validam e fazem deploy

### Fluxo 3: Correção de Bug (`bugfix`)

Para corrigir bugs de forma rápida:

```
@harness-orchestrator Corrigir erro 500 ao finalizar compra no checkout
```

O orquestrador executa:
1. **Diagnose** → `bug-reporter` + `qa-engineer` reproduzem e identificam causa
2. **Fix** → `backend-dev` ou `frontend-dev` corrigem o código
3. **Verify** → `code-reviewer-*` + `unit-tester` + `linter` verificam

### Avançado

O orquestrador detecta o fluxo automaticamente pela descrição da tarefa. Para forçar um fluxo específico, inicie com:

```
@harness-orchestrator [feature] Adicionar busca por texto nos produtos
@harness-orchestrator [project] Landing page corporativa
@harness-orchestrator [bugfix] Botão de login não funciona no Safari
```

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
