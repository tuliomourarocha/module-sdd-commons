# Política de modelos — Harness V2

Cada adaptador tem seu próprio provedor. Não há uma escolha de modelo global nem
um modelo OpenAI gravado nos agentes do OpenCode ou do Claude Code.

| Harness | Provedor | Resolução de modelo |
| --- | --- | --- |
| OpenCode | OpenAI + OpenCode | Papéis GPT (`harness`, `planner`, `shipper`) usam o provedor exclusivo OpenAI (`console-openai/gpt-*`); papéis Anthropic (`builder`, `reviewer`, `supervisor`) mantêm o catálogo `opencode/claude-*`. |
| Claude Code | Anthropic | Usa aliases `haiku` e `sonnet`, resolvidos pela conta. |
| Codex | OpenAI | O instalador grava automaticamente o roteamento por papel em `.codex/sdd-harness.json`. |

No Codex, `planner` e `builder` usam `gpt-5.6-sol`; `reviewer` e `shipper` usam
`gpt-5.6-terra`; `harness` usa `gpt-5.6-luna`. No OpenCode, os modelos OpenAI
(Luna, Sol) são exclusivos do provedor OpenAI (`console-openai/*`) — nunca
roteados pelo provedor multimodelo `opencode/*`, que fica reservado aos papéis
Anthropic (`claude-*`). `checker` removido — guard rails são hooks determinísticos. A instalação aplica
essa decisão, sem exigir escolha do usuário.
