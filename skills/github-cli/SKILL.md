---
name: github-cli
description: GitHub CLI (gh) operations — abrir pull requests, revisar código, gerenciar issues, status checks e merge via terminal
---

# GitHub CLI (gh)

Habilidade especializada em operações via `gh` (GitHub CLI). Automatiza fluxos de PR, code review, merge e gerenciamento de repositórios sem sair do terminal.

## When to Use

- Criar, listar, visualizar e gerenciar pull requests
- Fazer code review (aprovar, solicitar mudanças, comentar)
- Fazer merge de PRs (squash, merge, rebase)
- Gerenciar issues, labels, milestones
- Executar e visualizar GitHub Actions workflows
- Gerenciar branches, releases e tags

## Commands Reference

### Pull Requests

```bash
# Criar PR
gh pr create --title "título" --body "descrição" --base main --head branch

# Listar PRs
gh pr list --state open --limit 20
gh pr list --author @me
gh pr list --review-requested @me

# Visualizar PR
gh pr view <number>
gh pr view <number> --json title,body,additions,deletions,files,reviews

# Checkout PR localmente
gh pr checkout <number>
```

### Code Review

```bash
# Aprovar
gh pr review <number> --approve --body "LGTM"

# Solicitar mudanças
gh pr review <number> --request-changes --body "precisa ajustar X"

# Comentar
gh pr review <number> --comment --body "sugestão: ..."

# Revisar diff completo
gh pr diff <number>
gh pr view <number> --json files --jq '.files[].path'
```

### Merge

```bash
# Merge com squash (padrão)
gh pr merge <number> --squash --subject "mensagem"

# Merge commit
gh pr merge <number> --merge

# Rebase
gh pr merge <number> --rebase

# Auto-merge
gh pr merge <number> --auto --squash
```

### Status Checks

```bash
# Verificar status
gh pr view <number> --json statusCheckRollup
gh run list --limit 10
gh run view <run-id> --log
```

### Issues

```bash
# Criar issue
gh issue create --title "título" --body "descrição" --label bug

# Listar
gh issue list --state open
gh issue view <number>
gh issue close <number>
gh issue reopen <number>
```

### Releases e Tags

```bash
gh release create v1.0.0 --title "v1.0.0" --notes "changelog"
gh release list
gh release view v1.0.0
gh tag list
```

## Workflow: PR Review Cycle

1. **Listar PRs pendentes de revisão:**
   ```bash
   gh pr list --review-requested @me --state open
   ```

2. **Selecionar e revisar:**
   - Ler descrição: `gh pr view <number>`
   - Ver diff: `gh pr diff <number>`
   - Ver arquivos alterados: `gh pr view <number> --json files --jq '.files[] | {path: .path, status: .status, additions: .additions, deletions: .deletions}'`
   - Fazer checkout: `gh pr checkout <number>` (se precisar testar)

3. **Submeter review:**
   - Aprovar: `gh pr review <number> --approve --body "review summary"`
   - Solicitar mudanças: `gh pr review <number> --request-changes --body "reason"`
   - Comentar: `gh pr review <number> --comment --body "suggestion"`

4. **Merge após aprovação:**
   ```bash
   gh pr merge <number> --squash --subject "feat: ..." --body "closes #issue"
   ```

## Rules

- Sempre usar `gh` em vez de chamar a REST API do GitHub diretamente
- Preferir squash merge como estratégia padrão
- Nunca fazer merge sem code review de pelo menos um aprovador
- Usar labels nos PRs para categorização (feat, fix, chore, docs)
- Executar `gh pr view <number> --json statusCheckRollup` antes do merge para verificar CI
- Ao revisar, sempre puxar o diff e checar arquivos alterados antes de opinar
- Em caso de conflito de merge, orientar resolução local antes de tentar merge via CLI
