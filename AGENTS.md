# Global Rules — module-sdd-commons

Regras globais que se aplicam a todos os agentes neste projeto.

## Estrutura do Projeto

- `agents/` — Definições de agentes (máx. 200 linhas cada, com regras e hooks próprios)
- `commands/` — Prompts detalhados e templates referenciados pelos agentes
- `skills/` — Habilidades carregadas pelos agentes
- `packs/` — Configurações de empacotamento APM

## Regras Gerais

1. **Progressive Disclosure** — Arquivos de agente são concisos e autossuficientes. Comportamento detalhado fica em `commands/`.
2. **Autossuficiência** — Cada agente incorpora suas próprias regras e hooks de validação. Não busca regras em arquivos externos.
3. **Idioma** — Padrão português para artefatos, salvo contexto do produto exigir inglês.
4. **Qualidade** — Prefira artefatos concisos, prontos para uso e validados contra os hooks do agente.
5. **Validação** — Execute hooks de validação antes de finalizar cada artefato.

## Trello Sync

Todo agente que executa trabalho em um ciclo deve manter o card do Trello atualizado:

1. **Início** — Mover card para "Em Andamento" ou lista correspondente ao gate atual
2. **A cada passo** — Comentar no card o progresso, decisões tomadas e artefatos gerados
3. **Checklists** — Atualizar checklists com itens concluídos
4. **Término** — Mover card para a lista do próximo gate ou "Concluído" ao finalizar

Skills a carregar quando aplicável: `trello-manager`

## Git Workflow

Ao final de cada ciclo de trabalho (feature completa, bugfix resolvido, etc.), o agente deve:

1. **Fazer commit** com conventional commit message
2. **Criar Pull Request** via `gh pr create` com descrição clara do que foi feito
3. **Solicitar code review** se aplicável

Skills a carregar quando aplicável: `git-commit`, `github-cli`
