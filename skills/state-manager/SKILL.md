---
name: state-manager
description: >
  Protocolo padronizado de estado e handoff entre agentes.
  Define como ler/escrever .planning/STATE.md e .planning/HANDOFF.md
  para garantir continuidade entre sessoes e handoff entre agentes.
  Todo agente DEVE carregar esta skill no inicio.
---

# State Manager

Protocolo padronizado de estado e handoff entre agentes.

## Estrutura

```
.planning/
├── STATE.md          # Estado atual da execucao (escrito pelo harness via subagente)
├── HANDOFF.md        # Ultimo handoff do agente anterior (sobrescrito a cada execucao)
├── ROADMAP.md        # Roadmap do produto
├── PRD.md            # Documento de requisitos (ex-Discuss/Plan)
├── PLAN.md           # Plano tecnico (ex-Plan)
├── SUMMARY.md        # Resumo da implementacao (ex-Execute/Fix)
├── VALIDATION.md     # Relatorio de validacao (ex-Validate/Verify)
└── arch/             # Diagramas de arquitetura
    └── epic-XX/
        ├── frontend-arch.md
        ├── backend-arch.md
        ├── sequence-flows.md
        ├── deployment.md
        └── technical-refinement.md
```

## Protocolo

### Ao iniciar (todo agente)
1. Load this skill
2. Read `.planning/STATE.md` (if exists) -- understand flow, gate, current context
3. Read `.planning/HANDOFF.md` (if exists) -- understand what previous agent did
4. Read `.planning/PRD.md`, `.planning/PLAN.md` etc. as needed for context

### Ao finalizar (agentes executores -- backend-dev, frontend-dev, techlead, po-agent, qa-engineer, devops-infra)
1. Write `.planning/HANDOFF.md` **overwriting** previous content:
   - What was done, files changed, decisions, pending items
   - Use template below
2. If instructed by harness: also update `.planning/STATE.md` with new gate info

### Nas transicoes de gate (harness-orchestrator)
1. Instruir o subagente via `task()` para:
   - Escrever `.planning/HANDOFF.md` com o resultado do trabalho
   - Atualizar `.planning/STATE.md` com o novo estado (proximo gate)
2. O harness nao escreve arquivos diretamente (edit: deny) -- delega a escrita ao subagente

## Template: STATE.md

```markdown
# State

## Flow
- **Type:** feature | project | bugfix
- **Gate:** discuss | plan | execute | validate | done
- **Step:** descricao do passo atual

## Context
- **Card/Epic:** link ou identificador
- **Description:** descricao do que esta sendo feito

## Artifacts
- `.planning/PRD.md` -- aprovado
- `.planning/PLAN.md` -- pendente
- `.planning/SUMMARY.md` -- pendente
- `.planning/VALIDATION.md` -- pendente

## Decisions
- Decisao 1
- Decisao 2

## Next Step
- O que o proximo agente deve fazer
```

## Template: HANDOFF.md

```markdown
# Handoff

## From
- **Agent:** nome-do-agente
- **Gate:** gate-atual
- **Status:** completed | partial | failed

## What Was Done
- Resumo do que foi feito

## Files Changed
- `caminho/arquivo1`
- `caminho/arquivo2`

## Decisions
- Decisao 1
- Decisao 2

## Pending / Blockers
- Nenhum

## Context for Next Agent
- Dicas, padroes usados, gotchas
```

## Rules

1. HANDOFF.md e **sempre sobrescrito** (overwrite) -- apenas o ultimo handoff importa
2. STATE.md e atualizado pelo harness atraves do subagente em cada transicao de gate
3. Se STATE.md nao existir, o agente assume primeiro acesso e continua normalmente
4. Todo artefato de execucao (PRD, PLAN, SUMMARY, VALIDATION) vai em `.planning/`
5. Diagramas de arquitetura vao em `.planning/arch/epic-XX/`
