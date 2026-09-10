---
name: sdd-harness
description: Execute o Harness V2 para fluxos feature, project ou bugfix, usando os seis papéis versionados deste pacote.
---

# Harness V2 para Codex

Use este skill quando o pedido envolver uma feature, projeto novo ou bugfix.
Leia `../../roles/harness.md` e siga seu pipeline. Os cartões de papel estão em
`../../roles/{planner,builder,checker,reviewer,shipper}.md`. O roteamento de
modelos está em `../../sdd-harness.json`.

## Regras de adaptação

- O Codex é o orquestrador. Delegue os papéis quando o ambiente oferecer agentes
  filhos; caso contrário, execute as fases sequencialmente mantendo os mesmos
  gates e artefatos.
- Planner → Builder → Checker e Reviewer em paralelo → Shipper.
- Preserve os dois gates humanos definidos pelo harness.
- Apenas Shipper escreve `.planning/STATE.md` e `.planning/HANDOFF.md`.
- Ao delegar, use o modelo OpenAI indicado para cada papel em
  `sdd-harness.json`. Não peça ao usuário para escolher modelos e não substitua
  o roteamento salvo. Em ambientes sem delegação com modelo por agente, use o
  modelo de `harness` para a sessão principal e mantenha o pipeline.
