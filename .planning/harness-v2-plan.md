# Harness V2 — Plano de Simplificação (5 Macros) — ARQUIVADO

> **⚠️ LEGADO — V2 final implementado com 4 macros + hooks.** Este documento descreve o plano de transição V1→V2 e contém referências históricas a `checker`, `VALIDATION.md`, `SUMMARY.md` e `REVIEW.md` como **arquivos em disco**. **A partir do Harness V2 final (2026-09), esses artefatos são PROIBIDOS em disco**: `SUMMARY.md`/`REVIEW.md`/`VALIDATION.md` nunca devem ser criados como arquivos — builder retorna resumo em memória, reviewer retorna parecer em memória, validação é hook determinístico `guard_rails.py`. Este arquivo é mantido apenas como histórico e **não deve ser recriado** pelo harness; apenas `STATE.md`/`HANDOFF.md`/`CI_REPORT.md`/`SUPERVISOR_REPORT.md` persistem em `.planning/`.

> **Objetivo:** reduzir de 27 agentes para 6 arquivos (1 orquestrador + 5 macros), cortar ~60-70% de tokens por ciclo, reduzir janela de contexto em ~50% e eliminar latência de delegação em árvore.

---

## 1. Diagnóstico do Harness Atual

### 1.1 Inventário

| Artefato | Qtd | Tokens aprox. | Linhas |
|----------|-----|---------------|--------|
| `agents/*.agent.md` | 27 | ~18 700 | 1 829 |
| `commands/*.prompt.md` | 9 | ~6 600 | 1 657 |
| `skills/*` | 28 | — | — |
| `.planning/codebase/*.md` | 7 | ~6 900 | 1 724 |
| **Total prompts carregáveis** | — | **~32k tokens** | **~5 210** |

*Tokens = chars/4. Só o harness-orchestrator (`agents/harness-orchestrator.agent.md:212`) tem 10 589 bytes.*

### 1.2 Fragmentação por papel

```
harness-orchestrator (212 linhas, autoriza 25 agents)
 ├── Discuss:  po-agent (103) → requirements-reviewer (28), prd-writer (36)
 ├── Plan:     techlead (171) → architecture-reviewer (72), po-agent, devops-infra (112), code-reviewer-general (30), unit-tester (68), linter (71)
 ├── Execute:  backend-dev (124) → architecture-reviewer, supabase-specialist (53), code-reviewer-backend (38), vercel-deploy (33), unit-tester, linter
 │            frontend-dev (123) → react-expert (42), nextjs-expert (43), code-reviewer-frontend (36), ui-reviewer (28), unit-tester, linter
 │            devops-infra (112) → ci-cd-specialist (37), vercel-infra (37), code-reviewer-infra (32)
 └── Validate: qa-engineer (165) → e2e-tester (36), api-tester (34), unit-tester, linter, bug-reporter (29), frontend-dev, backend-dev
              + code-reviewer-* (×4) + linter + ui-reviewer + ci-checker (36)
```

- **Profundidade 3:** `orchestrator → backend-dev → architecture-reviewer` significa 3× leitura de `.planning/STATE.md`, `HANDOFF.md`, `PRD.md`, `PLAN.md` para o mesmo ciclo.
- **Fan-out explosivo:** um `feature` completo pode disparar **12-18 tasks** (cada uma com overhead de spawn + serialização de contexto).

### 1.3 Gargalos de Token e Contexto

| Gargalo | Evidência | Custo estimado por ciclo `feature` |
|---------|-----------|-------------------------------------|
| **Template Trello+State repetido** | `agents/harness-orchestrator.agent.md:114-136` — 22 linhas obrigatórias em *toda* `task()`. Replicado em `agents/techlead.agent.md:104-122`, `backend-dev:73-87`, `frontend-dev:72-86`, `devops-infra:74-88`, `qa-engineer:112-130` | ~15 linhas × 12 tasks = **~180 linhas ≈ 720 tokens desperdiçados** |
| **Skill loading redundante** | `state-manager` carregado em 7 agents, `trello-manager` em 7, `caveman` em 20, `find-skills` em 6 | Cada load injeta ~200-400 tokens de instrução de skill → **~2-3k tokens duplicados/ciclo** |
| **4 code-reviewers separados** | `code-reviewer-backend:38`, `frontend:36`, `infra:32`, `general:30` — checklists 80% sobrepostos | 4 prompts carregados onde 1 com seções por camada resolveria |
| **3 testers separados** | `unit-tester:68`, `e2e-tester:36`, `api-tester:34` | 3 agentes quando 1 `checker` com skills `webapp-testing` + `typescript-expert` cobre |
| **Micro-especialistas folhas** | `react-expert:42`, `nextjs-expert:43`, `supabase-specialist:53`, `vercel-deploy:33`, `vercel-infra:37`, `ci-cd-specialist:37` | Cada um <60 linhas, poderiam ser skills invocadas pelo `builder` sem spawn |
| **Commands duplicam orquestrador** | `commands/harness-gate.prompt.md:355` replica fluxos já descritos em `harness-orchestrator.agent.md:52-212` | +355 linhas mantidas em sincronia manual |
| **Model sprawl** | `big-pickle`, `nemotron-3-ultra`, `nemotron-3.5-lightning`, `mimo-v2.5`, `muse-spark-1.2` | Cold start + custo imprevisível; sem benefício mensurável |

### 1.4 Gargalos de Desempenho e Latência

| Problema | Impacto |
|----------|---------|
| **Human-in-the-loop em 4 gates** (`harness-orchestrator.agent.md:66`, `harness-gate.prompt.md:302-332`) | Latência humana domina wall-clock; cada transição exige `question` + aprovação |
| **Delegação sequencial no Execute** (`harness-gate.prompt.md:90-94` — "sequencialmente respeitando dependências") | `devops-infra → backend-dev → frontend-dev` serializados quando boa parte é paralelizável |
| **Trello sync bloqueante em todo gate** (8 syncs por `feature`: Discuss×2, Plan×2, Execute×3, Validate×N, Done) | Cada sync = leitura `~/.trello_config.json` + API call; se Trello não configurado, ainda paga o `read` + branch de fallback |
| **Loops `max 3 iterações` com re-spawn completo** (`harness-gate.prompt.md:68,122,287`) | Cada iteração re-injeta prompt completo do agente + re-lê `.planning/*` |

### 1.5 Gargalo de Simplicidade

- Curva de aprendizado: escolher entre 27 agents exige ler 27 descriptions.
- `AGENTS.md:1-11` promete "Progressive Disclosure" e "Autossuficiência" mas `harness-orchestrator` exige ler `.planning/codebase/*.md` + `commands/harness-gate.prompt.md` + skills antes de começar (`harness-orchestrator.agent.md:62-70`).
- Validação: cada agent repete seus próprios `Validation Hooks` (8-12 checkboxes) — manutenção frágil.

---

## 2. Princípios do Harness V2

1. **Macros, não micros:** 5 agentes que cobrem todo o ciclo; especialidade via *skills*, não via *agents*.
2. **Orquestrador magro:** só roteia e controla gate; nunca carrega skill de domínio.
3. **Estado único, Trello único:** só orquestrador (leitura) e `shipper` (escrita) tocam `STATE.md`/`HANDOFF.md` e Trello.
4. **Skills > Subagentes:** micro-especialistas viram skills carregadas on-demand pelo macro dono do gate.
5. **Paralelo por padrão:** Validate e Review rodam em paralelo; Execute paraleliza quando `PLAN.md` declara `depends: []`.
6. **Dois gates humanos, não quatro:** `Planeja → [Implementa+Valida+Revisa] → Finaliza` com checkpoint opcional no meio.
7. **Um modelo por macro, configurável:** default único (`opencode/big-pickle` ou `muse-spark`) com override só se falhar.

---

## 3. Arquitetura Proposta

### 3.1 Mapa de arquivos

```
agents/
  harness.agent.md      # ~60 linhas — orquestrador (substitui harness-orchestrator.agent.md:212)
  planner.agent.md      # ~90 linhas — PLANEJA  (funde po-agent + techlead + architecture-reviewer + requirements-reviewer + prd-writer)
  builder.agent.md      # ~100 linhas — IMPLEMENTA (funde backend-dev + frontend-dev + devops-infra + supabase-specialist + react-expert + nextjs-expert + vercel-*)
  checker.agent.md      # ~70 linhas — VALIDA  (funde qa-engineer + unit-tester + e2e-tester + api-tester)
  reviewer.agent.md     # ~70 linhas — REVISA  (funde code-reviewer-* ×4 + linter + ui-reviewer + architecture-reviewer review-mode)
  shipper.agent.md      # ~60 linhas — FINALIZA (funde ci-checker + git-commit + github-cli + trello close + deploy)

commands/
  harness.prompt.md     # ~80 linhas — único command (substitui harness-gate.prompt.md:355 + techlead-prompt:322 + qa-prompt:280 + backend:388 + frontend:82 + ...)

skills/                 # sem mudança — reutiliza 28 existentes
.planning/
  STATE.md / HANDOFF.md # protocolo simplificado (ver §5)
```

**De 27 agents + 9 commands (36 arquivos, ~3 486 linhas) → 6 agents + 1 command (7 arquivos, ~530 linhas) = -85% arquivos, -85% linhas de prompt.**

Arquivos legados movidos para `agents/_legacy/` (não deletados) para rollback.

### 3.2 Responsabilidade dos 5 macros

| Macro | Quando | Faz | Skills que carrega | Não faz |
|-------|--------|-----|--------------------|---------|
| **planner** | Gate 1 | Discovery (grill-me), PRD (`po-assistant`), arquitetura (clean-architecture, mermaid-diagrams), quebra de tasks, estimativas, `PLAN.md` | `po-assistant`, `grill-me`, `mermaid-diagrams`, `clean-architecture`, `solid`, `design-doc-mermaid` | Não implementa código |
| **builder** | Gate 2 | Implementa full-stack a partir de `PLAN.md`, migrations, componentes, APIs, infra mínima, testes unitários colocados | `clean-architecture`, `nextjs-app-router-patterns`, `supabase-postgres-best-practices`, `react-best-practices`, `typescript-expert`, `git-commit`, `github-cli` | Não valida e2e, não faz review formal |
| **checker** | Gate 3a (paralelo) | Suite de testes: unit (vitest), api (contratos), e2e (playwright/webapp-testing). Gera `VALIDATION.md` parcial | `webapp-testing`, `typescript-expert` | Não faz lint nem review de estilo |
| **reviewer** | Gate 3b (paralelo) | Lint+typecheck, review multi-camada (backend/frontend/infra), segurança, a11y. Gera `REVIEW.md` | `clean-code`, `solid`, `clean-architecture`, `typescript-expert`, `typescript-react-reviewer`, `react-best-practices` | Não escreve testes |
| **shipper** | Gate 4 | Commit conventional, PR (`gh`), CI check, preview deploy, Trello close, `HANDOFF.md` final | `git-commit`, `github-cli`, `trello-manager`, `state-manager` | Não implementa feature |

> **Por que 5 e não 3?** Separar `checker` (dinâmico — roda código) de `reviewer` (estático — lê código) permite paralelismo real e evita um agente "faz-tudo" que estoura janela de contexto. `shipper` isolado garante que Trello/CI/deploy só acontecem uma vez, no final — elimina 7 Trello syncs intermediários.

### 3.3 Orquestrador enxuto (`harness.agent.md`)

```markdown
---
description: Harness — roteia 3 fluxos para 5 macros. Só orquestra via task().
mode: primary
model: opencode/muse-spark-1.2-contributor-free
temperature: 0.15
steps: 20
permission:
  edit: deny
  bash: deny
  webfetch: deny
  read: allow
  glob: allow
  grep: allow
  task:
    "*": deny
    "planner": allow
    "builder": allow
    "checker": allow
    "reviewer": allow
    "shipper": allow
---

Fluxos:
- feature: planner → builder → [checker ∥ reviewer] → shipper
- project: planner(discover) → builder(scaffold) → loop feature → shipper(finalize)
- bugfix:  planner(triage) → builder(fix) → [checker ∥ reviewer] → shipper

Regras:
- Detecta fluxo pela mensagem; se ambíguo, pergunta (feature|project|bugfix).
- Lê .planning/STATE.md e HANDOFF.md uma vez no início; repassa como contexto nas tasks (não manda cada macro reler).
- Uma task por macro; checker e reviewer em paralelo.
- Estado/Trello: só shipper escreve STATE.md/HANDOFF.md e Trello no final; planner/builder/checker/reviewer apenas retornam artefatos.
- Human gate: após planner e após [checker∥reviewer]; shipper é auto se CI verde.
```

~60 linhas vs `harness-orchestrator.agent.md:212` (-72%).

---

## 4. Fluxos Simplificados

### 4.1 Feature (caso mais comum)

```
Antes (4 gates humanos):  Discuss → Plan → Execute → Validate → Done
                          po-agent  techlead  3 devs   qa+4 reviewers+lint
                          2 tasks   2 tasks   3 tasks  7+ tasks
                          = 14 tasks, 4 aprovações humanas, 8 Trello syncs

Depois (2 gates humanos): Planner → Builder → Checker ∥ Reviewer → Shipper
                          1 task    1 task    2 tasks (paralelo)   1 task
                          = 5 tasks, 2 aprovações humanas, 1 Trello sync
```

Detalhe:

```
1. Detect  — harness lê STATE/HANDOFF uma vez, detecta "feature", pergunta se ambíguo
2. Planner — 1 task(planner):
     grill-me interview (se PRD ausente) → PRD.md → PLAN.md + arch/*.md + tasks quebradas
     → retorna {prd, plan, arch}  (NÃO escreve STATE/HANDOFF, NÃO toca Trello)
   Gate humano 1: "PRD+PLAN prontos. Avançar para implementação?"
3. Builder — 1 task(builder) com PRD+PLAN injetados:
     implementa backend/frontend/infra/supabase conforme PLAN → SUMMARY.md
4. Checker ∥ Reviewer — 2 tasks paralelas com SUMMARY + código:
     checker → VALIDATION.md (testes)
     reviewer → REVIEW.md (lint+review)
   Gate humano 2: "Testes {pass/fail}, Review {0 blockers}. Avançar para ship?"
5. Shipper — 1 task(shipper):
     commit + PR + ci-check + (deploy preview se project) + STATE.md + HANDOFF.md + Trello close
   Done.
```

### 4.2 Project

```
Planner(discover: PRD roadmap) → Builder(scaffold: repo+CI+arch base) → loop Feature → Shipper(finalize: deploy prod+docs)
```

### 4.3 Bugfix

```
Planner(triage: reproduz, causa, escopo fix) → Builder(fix) → Checker∥Reviewer → Shipper
```

*Planner no bugfix é leve: só triagem e plano de correção (1-2 parágrafos), não PRD completo. Evita `bug-reporter` dedicado.*

### 4.4 Tabela de gates

| Fluxo | Transição | Validação | Falha |
|-------|-----------|-----------|-------|
| feature | planner→builder | `PRD.md` + `PLAN.md` existem | Bloquear, pedir ajuste ao planner |
| feature | builder→checker/reviewer | `SUMMARY.md` + código commitado local | Bloquear |
| feature | checker/reviewer→shipper | `VALIDATION.md` + `REVIEW.md` sem blocker | Loop max 2 (builder corrige) |
| feature | shipper→Done | PR criado + CI verde + Trello fechado | Escalar humano |
| project | planner→builder | PRD roadmap validado | Bloquear |
| bugfix | planner→builder | causa identificada + teste de reprodução | Bloquear |

---

## 5. Protocolo de Estado Simplificado

**Antes:** 7 agents escrevem `HANDOFF.md` + `STATE.md` + Trello (cada um com 8 linhas de template). Conflito de escrita e sobrescrita.

**Depois:**

- **Leitura:** só `harness` lê `STATE.md`/`HANDOFF.md` no início e injeta o conteúdo como `context:` nas tasks. Macros não precisam reler.
- **Escrita:** só `shipper` escreve `STATE.md` + `HANDOFF.md` final. `planner`/`builder` apenas retornam artefatos em memória; `harness` consolida.
- **Trello:** só `shipper` faz Trello sync (cria/atualiza card, comenta artefatos, move para Done). Elimina `trello-manager` de 6 agents.
- **Artefatos intermediários:** `PRD.md`, `PLAN.md`, `SUMMARY.md`, `VALIDATION.md`, `REVIEW.md` são escritos diretamente pelo macro dono (1 escritor por artefato, sem contenção).

Template `STATE.md` enxuto (8 linhas vs 20):

```markdown
# State
flow: feature | project | bugfix
gate: planner | builder | check-review | shipper | done
artifacts: PRD.md:done PLAN.md:done SUMMARY.md:pending ...
next: builder
```

---

## 6. Comparativo Quantitativo

### 6.1 Tokens por ciclo `feature` (estimativa)

| Componente | Antes | Depois | Delta |
|------------|-------|--------|-------|
| Prompts de agents carregados | ~18 700 (27 agents no contexto do orchestrator) | ~6 000 (6 agents) | **-68%** |
| Skills injetadas por ciclo | ~3 000 (state+trello+caveman×7) | ~1 000 (shipper só) | **-67%** |
| Template Trello+State repetido | ~720 | ~0 (só shipper) | **-100%** |
| Leitura `.planning/*` duplicada | ~2 000 (cada nível relê) | ~400 (harness lê 1× e injeta) | **-80%** |
| Commands carregados | ~6 600 (9 commands) | ~320 (1 command) | **-95%** |
| **Total contexto por ciclo** | **~31k tokens** | **~8k tokens** | **-74%** |
| Tasks spawnadas | 12-18 | 5 | **-65%** |
| Trello API calls | 8 | 1 | **-87%** |
| Gates humanos | 4 | 2 | **-50% wall-clock** |

> Método: chars/4 por arquivo; skills estimado 300 tokens cada; Trello template 60 tokens × tasks.

### 6.2 Janela de contexto por agente

- **Antes:** `techlead:171` + `backend-dev:124` + `frontend-dev:123` + `qa-engineer:165` cada um carrega 5-7 skills + 4 arquivos `.planning/*` → janela efetiva por task ~4-6k tokens antes do código do projeto.
- **Depois:** `planner:90` + 3 skills + contexto injetado (PRD ~500 tokens) → ~2k tokens; `builder:100` + 4 skills + PLAN → ~2.5k; `checker/reviewer:70` cada → ~1.5k. **Margem para código do projeto dobra.**

### 6.3 Latência

- Spawn de subagente: ~1-2s de overhead (serialização + model init). 12 tasks → ~15s overhead vs 5 tasks → ~6s.
- Trello sync: ~1-2s cada (com retry). 8 → ~12s vs 1 → ~1.5s.
- Gates humanos: 4× espera humana (minutos-horas) → 2×.

---

## 7. Estrutura de Arquivos — O que Criar / Arquivar / Remover

### 7.1 Criar (7 arquivos)

```
agents/harness.agent.md        # novo, ~60 linhas
agents/planner.agent.md        # novo, ~90 linhas
agents/builder.agent.md        # novo, ~100 linhas
agents/checker.agent.md        # novo, ~70 linhas
agents/reviewer.agent.md       # novo, ~70 linhas
agents/shipper.agent.md        # novo, ~60 linhas
commands/harness.prompt.md     # novo, ~80 linhas (fluxos detalhados)
```

### 7.2 Arquivar (mover para `agents/_legacy/` — não deletar)

```
agents/harness-orchestrator.agent.md
agents/po-agent.agent.md, techlead.agent.md, backend-dev.agent.md, frontend-dev.agent.md
agents/devops-infra.agent.md, qa-engineer.agent.md
agents/architecture-reviewer.agent.md, requirements-reviewer.agent.md, prd-writer.agent.md
agents/unit-tester.agent.md, e2e-tester.agent.md, api-tester.agent.md
agents/code-reviewer-*.agent.md (×4), linter.agent.md, ui-reviewer.agent.md
agents/bug-reporter.agent.md, ci-checker.agent.md, ci-cd-specialist.agent.md
agents/vercel-*.agent.md (×2), supabase-specialist.agent.md, react-expert.agent.md, nextjs-expert.agent.md
commands/harness-gate.prompt.md, techlead-prompt.prompt.md, qa-prompt.prompt.md,
         backend-prompt.prompt.md, frontend-prompt.prompt.md, po-prompt.prompt.md, devops-prompt.prompt.md
```

Manter `skills/` intacta. `packs/agentic-squad/apm.yml` atualizar lista de agents.

### 7.3 Atualizar

```
AGENTS.md                      # regras globais: trocar lista de 27 agents por 5 macros + harness
install.sh                     # detectar agents/_legacy e não instalar; instalar 6 novos
README.md                      # seção "Uso do Harness Orchestrator" → nova tabela de fluxos
.planning/codebase/*.md        # opcional: adicionar nota de harness v2
```

---

## 8. Esqueletos dos Prompts (enxutos)

### 8.1 `harness.agent.md` (~60 linhas)

- Frontmatter com `task: planner|builder|checker|reviewer|shipper` apenas.
- Corpo: detecção de fluxo, leitura única de STATE/HANDOFF, roteamento, injeção de contexto, paralelismo checker∥reviewer, gates humanos.

### 8.2 `planner.agent.md` (~90 linhas)

- Input: `context: {STATE, HANDOFF, PRD existente}`.
- Steps: discovery (grill-me se needed) → PRD → arquitetura (mermaid) → PLAN + tasks.
- Output: `{PRD.md, PLAN.md, arch/*.md}`.
- Skills: `po-assistant`, `grill-me`, `mermaid-diagrams`, `clean-architecture`.
- Sem Trello, sem STATE write.

### 8.3 `builder.agent.md` (~100 linhas)

- Input: `PRD.md + PLAN.md`.
- Steps: scaffold/infra → backend (entities→use cases→adapters) → frontend (components→pages) conforme PLAN. Usa skills para guidance, mas implementa diretamente.
- Output: `SUMMARY.md` + código.
- Skills: `clean-architecture`, `nextjs-app-router-patterns`, `supabase-*`, `typescript-expert`.

### 8.4 `checker.agent.md` (~70 linhas)

- Input: `SUMMARY.md + código`.
- Steps: unit (vitest) → api (contratos) → e2e (playwright) conforme PRD.
- Output: `VALIDATION.md` com pass/fail + evidências.
- Skills: `webapp-testing`, `typescript-expert`.

### 8.5 `reviewer.agent.md` (~70 linhas)

- Input: `código + PLAN.md`.
- Steps: lint (`npm run lint` + `tsc --noEmit`) → review por camada (backend: Dependency Rule, frontend: React patterns, infra: workflows) → `REVIEW.md` com HIGH/MED/LOW.
- Skills: `clean-code`, `solid`, `typescript-expert`, `typescript-react-reviewer`.

### 8.6 `shipper.agent.md` (~60 linhas)

- Input: `VALIDATION.md + REVIEW.md + código`.
- Steps: commit conventional → `gh pr create` → `ci-check` (poll) → Trello sync → `STATE.md`+`HANDOFF.md` final.
- Skills: `git-commit`, `github-cli`, `trello-manager`, `state-manager`.
- Único com `edit: allow` para `.planning/*` e `bash: allow` para `gh`.

### 8.7 `commands/harness.prompt.md` (~80 linhas)

- Tabela de fluxos, pré-condições por transição, tabela de gates, anti-patterns. Sem replicar prompts dos macros.

---

## 9. Estratégia Skills vs Subagentes

| Antes (subagente) | Depois (skill no macro) | Por quê |
|--------------------|-------------------------|---------|
| `architecture-reviewer` | `clean-architecture` + `mermaid-diagrams` no `planner`/`reviewer` | Guidance e review são checklists, não precisam spawn |
| `react-expert`, `nextjs-expert` | `nextjs-app-router-patterns`, `react-best-practices` no `builder` | Patterns são consulta, não orquestração |
| `supabase-specialist` | `supabase-postgres-best-practices` no `builder` | Schema/migration é parte do build |
| `vercel-deploy`, `vercel-infra`, `ci-cd-specialist` | `deploy-to-vercel`, `github-actions-docs` no `builder`/`shipper` | Deploy é finalização, não fase separada |
| `unit-tester`, `e2e-tester`, `api-tester` | `webapp-testing` no `checker` | Um executor com 3 modos |
| `code-reviewer-*` ×4 + `linter` + `ui-reviewer` | `reviewer` único com seções | Um leitor com checklist por camada |
| `bug-reporter`, `requirements-reviewer`, `prd-writer` | `planner` absorve | Triagem e escrita são sub-steps do planejar |
| `ci-checker` | `shipper` faz | CI check é pós-PR, não fase isolada |

**Critério:** se o agente tem `<60 linhas` e `task: deny` (folha), vira skill. Se orquestra (`task: allow`), vira macro.

---

## 10. Plano de Migração (4 fases)

### Fase 1 — Scaffold V2 (1 dia, sem impacto)

- [ ] Criar `agents/_legacy/` e mover 27 agents + 7 commands antigos (git mv, manter histórico)
- [ ] Criar 6 novos `agents/*.agent.md` + `commands/harness.prompt.md` conforme esqueletos §8
- [ ] Atualizar `AGENTS.md` (lista de agents, regras de progressive disclosure)
- [ ] Atualizar `install.sh` para instalar só 6 agents + 1 command (ignorar `_legacy`)
- [ ] Atualizar `packs/agentic-squad/apm.yml`
- [ ] Validar: `wc -l agents/*.md` deve dar ~530 linhas

### Fase 2 — Validação em Dry-Run (1 dia)

- [ ] Rodar 1 ciclo `feature` fake (ex: "adicionar campo bio ao perfil") com harness v2 em branch `harness-v2-dryrun`
- [ ] Medir: tokens (via `opencode models` logs), wall-clock, arquivos gerados
- [ ] Comparar `PRD.md`, `PLAN.md`, `VALIDATION.md` com ciclo v1 anterior
- [ ] Ajustar prompts onde `reviewer`/`checker` deixarem gaps

### Fase 3 — Cutover (meio dia)

- [ ] Merge `harness-v2-dryrun` em `main`
- [ ] Tag `harness-v1-final` no commit anterior para rollback
- [ ] Atualizar `README.md` (seção Harness) com novos fluxos e exemplos `@harness`
- [ ] Comunicar breaking change: `@harness-orchestrator` → `@harness` (manter alias por 1 versão)

### Fase 4 — Limpeza (após 2 ciclos reais sem regressão)

- [ ] Remover `agents/_legacy/` ou manter como `packs/legacy`
- [ ] Arquivar `harness-orchestrator` do registry se houver

**Rollback:** `git revert` + `install.sh` reinstala `_legacy` (1 comando).

---

## 11. Riscos e Mitigações

| Risco | Prob. | Impacto | Mitigação |
|-------|-------|---------|-----------|
| `builder` estoura janela de contexto em projetos grandes | Média | Alto | `PLAN.md` declara `scope: backend|frontend|infra`; builder respeita e só carrega skills da camada ativa |
| `reviewer` único perde nuance de 4 reviewers especializados | Baixa | Médio | `reviewer` carrega checklists segmentados por camada (seções backend/frontend/infra) extraídas dos 4 prompts originais |
| Perda de Trello granularidade (antes 8 updates, depois 1) | Baixa | Baixo | Shipper comenta com timeline consolidada (planner→builder→check/review) — mais legível que 8 updates fragmentados |
| `planner` funde PO+TechLead e mistura negócio com técnica | Média | Médio | Estrutura interna em 2 fases: `1. Negócio (PRD)` → `2. Técnica (PLAN+arch)` com validação interna antes de emitir |
| Skills não cobrem casos edge que subagente cobria | Baixa | Médio | `builder`/`checker` podem invocar `task()` pontual para skill faltante; `find-skills` mantido no planner |

---

## 12. Métricas de Sucesso (medir nos 3 primeiros ciclos reais)

| Métrica | Meta | Como medir |
|---------|------|------------|
| Tokens por ciclo feature | <10k (vs ~31k) | `opencode --verbose` ou contagem chars/4 dos prompts carregados |
| Tasks por ciclo | 5 (vs 12-18) | logs do harness |
| Gates humanos | 2 (vs 4) | contagem de `question` |
| Wall-clock feature simples | -40% | timestamp Discuss→Done |
| Artefatos faltantes | 0 | checklist `PRD+PLAN+SUMMARY+VALIDATION+REVIEW+PR` |
| Regressão de qualidade (blockers escapados) | 0 | `reviewer` deve pegar ≥ o que 4 reviewers pegavam |

---

## 13. Próximos Passos

1. **Aprovar este plano** (ou pedir ajustes: ex: manter 4 macros em vez de 5, ou 6 com `architect` separado).
2. **Autorizar implementação da Fase 1** — scaffold dos 6 agents enxutos.
3. Opcional: escolher modelo padrão único (recomendado: `opencode/big-pickle` para planner/builder/reviewer e `muse-spark` para harness/shipper por custo).

---

*Gerado em 2026-09-02 a partir de análise de `agents/*.agent.md:1-212`, `commands/harness-gate.prompt.md:1-355`, `skills/*` (28), `.planning/codebase/*`.*
