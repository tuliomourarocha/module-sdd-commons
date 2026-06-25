# PO Agent — Hooks de Validação

Este arquivo define os hooks de validação que você deve executar antes de finalizar cada artefato gerado.

---

## Hook 1: Validação de User Story

Execute esta validação após escrever cada user story.

```markdown
### Checklist de Validação — User Story
- [ ] Segue o formato "As a... I want... So that..."?
- [ ] O "I want" descreve uma necessidade do usuário (não implementação técnica)?
- [ ] O "So that" expressa o valor/benefício?
- [ ] Tem pelo menos 2 acceptance criteria (1 happy path + 1 edge/error)?
- [ ] Os cenários Gherkin têm Given/When/Then?
- [ ] É independente de outras histórias?
- [ ] É pequena o suficiente para uma sprint?
- [ ] É testável (critérios objetivos)?
- [ ] O título é claro e orientado a valor?
```

### Exemplo de Validação

**Entrada inválida:**
```markdown
As a usuário
I want uma API GraphQL
So that o sistema funcione
```
**Problemas:** Formato técnico, não descreve valor, falta acceptance criteria, "sistema funcione" é genérico demais.

**Saída corrigida:**
```markdown
As a **usuário do app mobile**
I want **consultar meu saldo em tempo real**
So that **eu possa tomar decisões financeiras com informação atualizada**

Scenario: Consultar saldo com conta ativa
  Given que estou autenticado no app
  When acesso a tela inicial
  Then vejo meu saldo disponível atualizado

Scenario: Consultar saldo com conta inativa
  Given que minha conta está inativa
  When acesso a tela inicial
  Then vejo a mensagem "Conta inativa. Entre em contato com o suporte."
```

---

## Hook 2: Validação de Roadmap

Execute após criar ou revisar um roadmap.

```markdown
### Checklist de Validação — Roadmap
- [ ] Tem uma visão clara do produto?
- [ ] Os horizontes estão definidos (Now/Next/Later)?
- [ ] Cada iniciativa tem uma métrica de sucesso?
- [ ] Riscos e dependências estão mapeados?
- [ ] O período está claramente definido?
- [ ] É orientado a outcomes (não só a features)?
```

---

## Hook 3: Validação de Priorização

Execute após priorizar um conjunto de itens.

```markdown
### Checklist de Validação — Priorização
- [ ] O framework usado está explicitado?
- [ ] A justificativa do ranking é clara?
- [ ] Os critérios de pontuação estão documentados?
- [ ] O resultado é acionável (topo = próximo a fazer)?
```

---

## Hook 4: Validação de Card do Trello

Execute antes de criar ou atualizar um card no Trello.

```markdown
### Checklist de Validação — Card Trello
- [ ] Título claro e orientado a valor?
- [ ] Descrição contém a user story completa?
- [ ] Acceptance criteria incluídos na descrição ou checklist?
- [ ] Labels aplicados (tipo: story/feature/bug/spike)?
- [ ] Lista correta (Backlog vs Sprint vs In Progress)?
- [ ] Membros assinalados (se conhecidos)?
- [ ] Due date definida (se aplicável)?
```

---

## Hook 5: Validação de Divisão (Splitting)

Execute ao dividir uma história grande em histórias menores.

```markdown
### Checklist de Validação — Splitting
- [ ] Cada história resultante entrega valor independente?
- [ ] As histórias são testáveis individualmente?
- [ ] As histórias podem ser implementadas em ordens diferentes?
- [ ] A soma das histórias cobre o escopo original?
- [ ] Dependências entre as histórias estão documentadas?
```

---

## Hook 6: Validação de PRD

Execute após gerar o arquivo `PRD.md`.

```markdown
### Checklist de Validação — PRD
- [ ] Resumo executivo de 2-3 frases no topo?
- [ ] Problema e oportunidade claramente definidos?
- [ ] Visão em uma única frase?
- [ ] In scope vs Out of scope delimitados?
- [ ] Métricas de sucesso quantificáveis (com baseline e target)?
- [ ] Épicos prioritizados com P0/P1/P2?
- [ ] Riscos com probabilidade e impacto?
- [ ] Próximos passos acionáveis?
- [ ] Não ultrapassa 1 página de leitura?
- [ ] Progressive disclosure respeitado (detalhes em arquivos separados)?
```

---

## Hook 7: Consistência com Skills Carregadas

Antes de responder, verifique se você carregou corretamente as skills:

- **po-assistant** → Use para: descoberta de produto, refinamento de backlog, roadmaps, priorização, user stories, estratégia de produto
- **trello-manager** → Use para: criação/atualização de cards, organização de listas, planejamento de sprints, gestão de boards

Se o usuário pedir algo que depende dessas skills, e você não as carregou, informe que precisa delas e carregue-as.

---

## Hook 8: Implementação no Trello

Execute após criar os cards no Trello.

```markdown
### Checklist de Validação — Implementação Trello
- [ ] Board existe com as listas padrão?
- [ ] Todas as user stories foram criadas como cards?
- [ ] Cada card tem título, descrição completa e acceptance criteria?
- [ ] Labels foram aplicados?
- [ ] Cards estão ordenados por prioridade?
- [ ] Usuário confirmou o resultado?
```

---

## Hook 9: Autoavaliação Contínua

Ao final de cada interação significativa, avalie:

1. **Entendi o problema completamente?** — Se não, pergunte mais.
2. **Forneci valor imediato?** — O usuário pode agir com o que entreguei?
3. **Progredi na direção certa?** — Estou resolvendo o problema certo?
4. **Os artefatos estão prontos para uso?** — Podem ser levados para o time ou para o Trello?
5. **Segui as regras?** — Consulte `specs/rules/po.rules.instructions.md` e verifique.
