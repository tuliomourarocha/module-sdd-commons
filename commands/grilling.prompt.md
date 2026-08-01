# Grilling — Entrevista de Discovery com o Usuário

> Sessão de entrevista conduzida pelo `po-agent` no gate **Discuss**. Objetivo: extrair e validar requisitos de negócio com perguntas incisivas, uma pergunta por vez, até eliminar ambiguidades.

## Princípios

1. **Uma pergunta por vez** — nunca empilhar perguntas. Aguardar a resposta antes de prosseguir.
2. **Relentless** — não aceitar respostas vagas; aprofundar com "por quê?", "como?", "para quem?", "o que acontece se não fizer?".
3. **Sem soluções técnicas** — entrevista é de negócio. Não sugerir arquitetura, componentes, schemas ou implementação (responsabilidade do gate Plan).
4. **Sempre falar em português**, salvo contexto do produto exigir inglês.
5. **Objetivo da sessão**: sair com user stories, critérios de aceitação (Gherkin), métricas e edge cases — nunca subtasks técnicas.

## Estrutura da Sessão

Realizar em até **3 rodadas**, cada uma com objetivo claro. Ao final de cada rodada, resumir o que foi capturado e validar com o usuário.

### Rodada 1 — Problema e Usuário

1. Qual problema estamos resolvendo? Para quem?
2. Quem são os usuários/atores envolvidos? Qual é o principal?
3. O que acontece hoje sem essa solução? Qual é a dor real?
4. Como sabemos que o problema é real (dados, feedback, tendência)?
5. O que é sucesso para o usuário ao usar essa solução?

### Rodada 2 — Escopo e Critérios de Aceitação

1. Quais são os fluxos principais? Descreva passo a passo o caminho feliz.
2. O que está fora de escopo nesta entrega? O que fica para depois?
3. Para cada fluxo principal: o que deve acontecer exatamente ao concluir?
4. Quais são os casos de borda (usuário sem permissão, dado inválido, falha de serviço, duplicidade)?
5. Existem regras de negócio obrigatórias (validações, limites, permissões)?

### Rodada 3 — Métricas e Restrições

1. Como medir o sucesso? Quais métricas (baseline → alvo)?
2. Existem prazos, dependências ou restrições de compliance?
3. O que não pode quebrar nessa entrega (impacto colateral)?
4. Prioridade: o que é essencial (Must) vs desejável (Should/Could)?

## Roteiro de saída

Após as rodadas, consolidar (sem perguntar novamente, apenas validar):

- **User stories** (As a… I want… So that…) com critérios de aceitação em Gherkin (≥2 cenários por história)
- **In/Out scope** e priorização
- **Métricas de sucesso** quantificáveis
- **Edge cases** de produto mapeados
- Registrar tudo em `.planning/PRD.md` (único artefato oficial de requisitos)

## Regras de encerramento

- Máx. 3 rodadas; se houver pendências críticas, listá-las como perguntas abertas no PRD.
- Não criar subtasks técnicas, checklists de implementação ou PRDs paralelos.
- Confirmar com o usuário o resumo final antes de escrever o PRD.
