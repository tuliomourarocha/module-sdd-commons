# SDD Harness V2

Para uma feature, projeto ou bugfix, inicie pelo subagente `harness`. Ele deve
seguir `planner → builder → [checker || reviewer] → shipper`, preservando os
gates humanos e os artefatos em `.planning/`.

Os subagentes são instalados em `.claude/agents/`. Somente `shipper` pode
escrever `.planning/STATE.md` e `.planning/HANDOFF.md`.

Use `/sdd-harness <pedido>` para solicitar explicitamente o fluxo.
