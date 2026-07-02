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
