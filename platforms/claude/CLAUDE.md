# SDD Harness V2

Para uma feature, projeto ou bugfix, inicie pelo subagente `harness`. Ele deve
seguir `planner → builder → [checker || reviewer] → shipper`, preservando os
gates humanos e os artefatos em `.planning/`.

Os subagentes são instalados em `.claude/agents/`. Somente `shipper` pode
escrever `.planning/STATE.md` e `.planning/HANDOFF.md` — demais artefatos (`PRD.md`, `PLAN.md`, `SUMMARY.md`, `VALIDATION.md`, `REVIEW.md`, `arch/*`) são **em memória** via `Agent tool` e injetados como `context:` pelo `harness` (nunca em disco). `permission: .planning/** deny` para `planner|builder|checker|reviewer` evita loop de verificação e reaproveita contexto.

## Memória e Política de Artefatos — Restrição Obrigatória

- **Disco (allow):** Apenas `.planning/STATE.md` e `.planning/HANDOFF.md`, exclusivamente pelo `shipper` no Gate 4.
- **Memória (deny em disco):** `PRD.md`, `PLAN.md`, `SUMMARY.md`, `VALIDATION.md`, `REVIEW.md`, `arch/*` retornados em memória; proibido `Write`/`Edit`/`Bash` nesses caminhos.
- **Injeção única:** `harness` lê `STATE`/`HANDOFF` **uma vez** e injeta; macros consomem `context:` sem reler disco — evita loop de verificação.

Use `/sdd-harness <pedido>` para solicitar explicitamente o fluxo.
