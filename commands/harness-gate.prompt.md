# Harness Gate — 3 Fluxos de Orquestração

> Comportamento detalhado do Harness Orchestrator. Lido via progressive disclosure.

> **IMPORTANTE:** Toda chamada `task()` neste documento DEVE incluir a instrução de Trello sync ao final do prompt. Use o template definido no `harness-orchestrator.agent.md` — seção "Task Template". O texto "(+ Trello sync)" marca cada task que deve recebê-la.

---

## Sumário dos Fluxos

| Fluxo | Gates | Agentes Chave | Duração |
|-------|-------|---------------|---------|
| **feature** | Discuss → Plan → Execute → Validate | po-agent → techlead → backend/frontend-dev → qa-engineer | completo |
| **project** | Discover → Scaffold → Feature × N → Finalize | po-agent → devops-infra + techlead → [feature cycle] → qa-engineer | longo |
| **bugfix** | Diagnose → Fix → Verify | bug-reporter → backend/frontend-dev → code-reviewers + linter | rápido |

---

## Fluxo 1: New Feature (`feature`)

Para adicionar funcionalidades em projeto existente. Ciclo completo de 4 gates.

```
[Discuss] ──→ [Plan] ──→ [Execute] ──→ [Validate] ──→ [Done]
```

### Gate 1 — Discuss

**Objetivo:** Entender o problema, definir requisitos, produzir PRD validado.

**Pré-condições:** Contexto do projeto carregado, briefing disponível.

```
1. Apresentar: "Gate 1 — Discuss. Vamos entender a demanda."
2. Invocar po-agent via task (+ Trello sync) para:
   - Discovery interview (problema, stakeholders, métricas)
   - Estruturar backlog (Epic → Feature → User Story)
   - Produzir PRD.md com in/out scope, métricas, riscos
3. Invocar requirements-reviewer via task (+ Trello sync) para:
   - Validar INVEST nas user stories
   - Validar Gherkin scenarios (mínimo 2 por história)
   - Verificar métricas quantificáveis
4. Se issues: escalar → "Requirements reviewer apontou {N} issues. Como proceder?"
   Opções: Revisar PRD | Aprovar com ressalvas | Abortar
5. Transição 1→2:
   "PRD.md validado. Avançar para o Gate 2 (Plan)?"
   Opções: Avançar | Revisar PRD | Abortar
```

**Artefatos:** `PRD.md`, backlog estruturado

### Gate 2 — Plan

**Objetivo:** Desenhar arquitetura, quebrar tarefas, produzir PLAN.md.

**Pré-condições:** Gate 1 concluído + transição aprovada.

```
1. Apresentar: "Gate 2 — Plan. Vamos arquitetar a solução."
2. Invocar techlead via task (+ Trello sync) para:
   - Arquitetura frontend (component tree, data flow, rotas)
   - Arquitetura backend (Clean Architecture, DTOs, boundaries)
   - Diagramas Mermaid em docs/arch/
   - Subtasks técnicas com estimativas (P/M/G)
3. Invocar architecture-reviewer via task (+ Trello sync) para:
   - Validar Dependency Rule, SOLID, boundaries
   - Revisar diagramas
4. Se issues: loop de revisão techlead → architecture-reviewer (max 3 iterações)
   Se exaurir: escalar para decisão humana
5. Consolidar PLAN.md: o que será construído por camada, ordem, subagentes
6. Transição 2→3:
   "PLAN.md pronto. Avançar para o Gate 3 (Execute)?"
   Opções: Avançar | Revisar plano | Abortar
```

**Artefatos:** `docs/arch/*.md`, `PLAN.md`

### Gate 3 — Execute

**Objetivo:** Implementar o plano através dos agentes especialistas.

**Pré-condições:** Gate 2 concluído + transição aprovada.

```
1. Apresentar: "Gate 3 — Execute. Vamos implementar."
2. Analisar PLAN.md e determinar ordem:
   a. Infra + Banco → devops-infra, supabase-specialist
   b. Backend → backend-dev (gerencia subagentes internos)
   c. Frontend → frontend-dev (gerencia subagentes internos)
3. Invocar agentes sequencialmente (respeitando dependências) — cada task (+ Trello sync):
   a. devops-infra → CI/CD, ambientes, secrets
   b. backend-dev → API, use cases, entidades, testes
   c. frontend-dev → componentes, páginas, testes
4. Consolidar SUMMARY.md com resultados e desvios
5. Transição 3→4:
   "Implementação concluída. Avançar para o Gate 4 (Validate)?"
   Opções: Avançar | Revisar implementação | Abortar
```

**Artefatos:** Código implementado, commits, `SUMMARY.md`

### Gate 4 — Validate → Done

**Objetivo:** Garantir qualidade através de testes, code review e lint, e finalizar o ciclo com commit+PR.

**Pré-condições:** Gate 3 concluído + transição aprovada.

```
1. Apresentar: "Gate 4 — Validate. Vamos garantir a qualidade."
2. Disparar validações (paralelo quando possível) — cada task (+ Trello sync):
   ├── qa-engineer → orquestra testes
   │   ├── unit-tester → testes unitários
   │   ├── e2e-tester → testes funcionais
   │   └── api-tester → testes de API
   ├── code-reviewer-backend → revisão backend
   ├── code-reviewer-frontend → revisão frontend
   ├── code-reviewer-infra → revisão pipelines
   ├── code-reviewer-general → revisão multi-camada
   ├── linter → lint + type check
   └── ui-reviewer → revisão de UI/UX
3. Coletar resultados (aprovado / blocker / warning / info)
4. Se blockers: loop de correção (max 3 iterações, depois escalar)
5. Git Workflow — Após validação aprovada:
   a. Fazer commit de todo o código com mensagem conventional commit
   b. Criar Pull Request via `gh pr create` com descrição clara
   c. Solicitar code review se aplicável
6. CI Check — Invocar `ci-checker` via `task` (+ Trello sync) passando o número do PR:
   a. Se CI passar ✅ → prosseguir
   b. Se CI falhar ❌ → identificar job com erro e escalar para o agente da camada (backend-dev, frontend-dev, devops-infra)
   c. Loop correção → novo commit → novo CI check (max 2 iterações, depois escalar para decisão humana)
7. Trello Sync — Atualizar card final:
   a. Comentar resultado da validação e CI
   b. Marcar checklists como concluídos
   c. Mover card para "Concluído"
8. Transição → Done:
   "Validação concluída. PR #{número} criado. CI {status}. {N} issues (0 blocker). Finalizar?"
   Opções: Finalizar | Revisar correções | Abortar ciclo
```

**Artefatos:** Relatórios de review, `VALIDATION.md`, commits, Pull Request, CI report

---

## Fluxo 2: New Project (`project`)

Para projetos novos do zero. Bootstrap + múltiplas features.

```
[Discover] ──→ [Scaffold] ──→ [Feature 1] ──→ [Feature N] ──→ [Finalize]
                                     │
                                     └── (Discuss → Plan → Execute → Validate)
```

### Gate 1 — Discover

**Objetivo:** Definir visão do produto, público, métricas de sucesso.

```
1. Apresentar: "Gate 1 — Discover. Vamos definir o produto."
2. Invocar po-agent via task (+ Trello sync) para:
   - Discovery completo (problema, personas, concorrência)
   - PRD.md do projeto (visão, escopo, métricas, riscos)
   - Roadmap de funcionalidades prioritárias
3. Invocar requirements-reviewer via task (+ Trello sync) para validar PRD
4. Consolidar visão do projeto
5. Transição 1→2:
   "PRD do projeto validado. Avançar para o Gate 2 (Scaffold)?"
   Opções: Avançar | Revisar visão | Abortar
```

**Artefatos:** `PRD.md`, roadmap de funcionalidades

### Gate 2 — Scaffold

**Objetivo:** Montar estrutura do projeto, CI/CD, arquitetura base.

```
1. Invocar techlead via task (+ Trello sync) para:
   - Estrutura de diretórios (front + back)
   - Arquitetura base (Clean Architecture, componente tree)
   - Configuração de frameworks e dependências
2. Invocar devops-infra via task (+ Trello sync) para:
   - CI/CD (GitHub Actions)
   - Deploy (Vercel)
   - Variáveis de ambiente e secrets
3. Invocar architecture-reviewer via task (+ Trello sync) para revisar
4. Se necessário: invocar supabase-specialist (+ Trello sync) para schema inicial
5. Transição 2→3:
   "Projeto scaffoldado. Iniciar primeira feature?"
   Opções: Iniciar Feature 1 | Revisar scaffold | Abortar
```

**Artefatos:** Projeto rodando, CI/CD configurado, `docs/arch/`

### Gate 3 — Feature Cycle (repetir para N features)

Para cada feature, executar o **Fluxo 1 (feature)** completo:
Discuss → Plan → Execute → Validate

A cada ciclo:
- **Trello Sync** — Comentar progresso, mover card da feature para "Concluído"
- Atualizar o planejamento com o progresso
- Perguntar ao final: "Feature N concluída. Próxima feature ou finalizar?"
- Opções: Próxima feature | Revisar | Finalizar projeto

### Gate 4 — Finalize

**Objetivo:** Finalizar projeto, deploy produção, documentação.

```
1. Invocar qa-engineer via task (+ Trello sync) para:
   - Suite completa de testes
   - Validação de fluxos ponta a ponta
2. Invocar devops-infra via task (+ Trello sync) para:
   - Deploy de produção
   - Monitoramento e alertas
3. Invocar ci-checker via task (+ Trello sync) para verificar CI dos PRs finais
4. Gerar documentação final
5. Transição → Done:
   "Projeto finalizado. Deploy realizado. CI ok."
```

**Artefatos:** Deploy produzido, testes passando, docs finais, CI report

---

## Fluxo 3: Bug Fix (`bugfix`)

Para correção de bugs. Fluxo leve de 3 gates.

```
[Diagnose] ──→ [Fix] ──→ [Verify] ──→ [Done]
```

### Gate 1 — Diagnose

**Objetivo:** Reproduzir o bug, identificar causa raiz.

```
1. Apresentar: "Gate 1 — Diagnose. Vamos entender o bug."
2. Invocar bug-reporter via task (+ Trello sync) para:
   - Coletar evidências (logs, screenshots, steps)
   - Identificar ambiente e camada afetada
   - Abrir card no Trello (se configurado)
3. Invocar qa-engineer via task (+ Trello sync) para:
   - Criar teste que reproduz o bug
   - Confirmar falha
4. Analisar causa raiz com os dados coletados
5. Transição 1→2:
   "Bug reproduzido, causa identificada. Avançar para correção?"
   Opções: Avançar | Mais investigação | Abortar
```

**Artefatos:** Bug report, teste reproduzindo falha

### Gate 2 — Fix

**Objetivo:** Corrigir o bug.

```
1. Invocar agente da camada afetada via task (+ Trello sync):
   - backend-dev → se bug de API/lógica
   - frontend-dev → se bug de UI/UX
   - devops-infra → se bug de infra/deploy
2. Cada agente gerencia seus subagentes internos
3. Consolidar SUMMARY.md com a correção
4. Transição 2→3:
   "Código corrigido. Avançar para verificação?"
   Opções: Avançar | Revisar correção | Abortar
```

**Artefatos:** Código corrigido, commits, `SUMMARY.md`

### Gate 3 — Verify → Done

**Objetivo:** Verificar correção sem regressões e finalizar com commit+PR.

```
1. Invocar (paralelo quando possível) — cada task (+ Trello sync):
   ├── code-reviewer-backend → revisão (se backend)
   ├── code-reviewer-frontend → revisão (se frontend)
   ├── code-reviewer-general → revisão multi-camada
   ├── unit-tester → testes unitários
   ├── linter → lint + type check
   └── qa-engineer → re-executar teste que reproduzia o bug
2. Coletar resultados
3. Se blocker: loop correção (max 2 iterações, depois escalar)
4. Git Workflow — commit com conventional commit + PR via `gh pr create`
5. CI Check — Invocar `ci-checker` via `task` (+ Trello sync):
   a. Se CI passar ✅ → prosseguir
   b. Se CI falhar ❌ → escalar para agente da camada para correção
6. Trello Sync — Carregar `trello-manager`, comentar resultado, mover card para "Concluído"
7. Transição → Done:
   "Bug corrigido e verificado. PR #{número} criado. CI {status}. Finalizar?"
   Opções: Finalizar | Revisar | Abortar
```

**Artefatos:** Bug fechado, testes verdes, `VALIDATION.md`, commits, Pull Request, CI report

---

## Gate Transition Protocol

Toda transição entre gates segue:

```
1. Verificar pré-condições do gate de destino
2. Trello Sync — Atualizar card:
   a. Comentar o progresso e artefatos produzidos no gate
   b. Mover card para lista do próximo gate
   c. Atualizar checklists com itens concluídos
3. Apresentar: o que foi feito + artefatos produzidos
4. Oferecer escolha:
   - Avançar → registrar, iniciar próximo gate
   - Revisar → loop no gate atual (max 3 iterações, max 2 no bugfix)
   - Abortar → registrar estado, salvar checkpoint
```

### Tabela de Transições

| Fluxo | Transição | Tipo | Validação | Falha |
|-------|-----------|------|-----------|-------|
| feature | 1→2 | Pre-flight | PRD.md existe, requirements ok | Bloquear |
| feature | 2→3 | Pre-flight | PLAN.md existe, arquitetura revisada | Bloquear |
| feature | 3→4 | Pre-flight | Código commitado, SUMMARY.md | Bloquear |
| feature | 4→Done | Revision | Testes verdes, reviews ok, lint limpo | Loop max 3 |
| project | 1→2 | Pre-flight | PRD.md do projeto validado | Bloquear |
| project | 2→3 | Pre-flight | Projeto rodando, CI/CD ok | Bloquear |
| project | 3→4 | Escalation | Features entregues conforme roadmap | Decisão humana |
| bugfix | 1→2 | Pre-flight | Bug reproduzido, causa identificada | Bloquear |
| bugfix | 2→3 | Pre-flight | Código corrigido | Bloquear |
| bugfix | 3→Done | Revision | Testes verdes, review ok | Loop max 2 |

---

## Checkpoints

| Tipo | Frequência | Uso |
|------|-----------|-----|
| `checkpoint:decision` | ~9% | Escolha arquitetural, definição de escopo |
| `checkpoint:human-verify` | ~90% | Validar saída de gate, aprovar transição |
| `checkpoint:human-action` | ~1% | Ação estritamente manual |

Prefira `human-verify`. Evite `human-action` se CLI/API resolver.

---

## Anti-patterns

1. **Pular gates** — nunca ir de Discuss direto para Execute sem Plan
2. **Mesclar fluxos** — não usar bugfix para feature, nem feature para projeto
3. **Implementar diretamente** — você orquestra, os agentes implementam
4. **Ignorar validações** — toda transição requer validação explícita
5. **Loop infinito** — revisão tem limite de iterações, depois escalar
6. **Delegar sem contexto** — sempre passar PRD/PLAN ao agente antes de invocar
