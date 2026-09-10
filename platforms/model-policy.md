# Política de modelos — Harness V2

Cada adaptador tem seu próprio provedor. Não há uma escolha de modelo global nem
um modelo OpenAI gravado nos agentes do OpenCode ou do Claude Code.

| Harness | Provedor | Resolução de modelo |
| --- | --- | --- |
| OpenCode | OpenCode | Mantém os IDs originais do catálogo `opencode/*`. |
| Claude Code | Anthropic | Usa aliases `haiku` e `sonnet`, resolvidos pela conta. |
| Codex | OpenAI | O instalador grava automaticamente o roteamento por papel em `.codex/sdd-harness.json`. |

No Codex, `planner` e `builder` usam `gpt-5.6-sol`; `reviewer` e `shipper` usam
`gpt-5.6-terra`; `harness` e `checker` usam `gpt-5.6-luna`. A instalação aplica
essa decisão, sem exigir escolha do usuário.
