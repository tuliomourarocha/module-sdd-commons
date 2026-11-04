# Política de modelos — Harness V2

Cada adaptador tem seu próprio provedor. Não há uma escolha de modelo global nem
um modelo OpenAI gravado nos agentes do OpenCode ou do Claude Code.

| Harness | Provedor | Resolução de modelo |
| --- | --- | --- |
| OpenCode | OpenAI + OpenCode Go | Papéis GPT (`harness`, `planner`, `shipper`) usam o provedor exclusivo OpenAI (`console-openai/gpt-*`); papéis Anthropic (`builder`, `reviewer`, `supervisor`) usam o catálogo pago `opencode-go/claude-*`. |
| Claude Code | Anthropic | Usa aliases `haiku` e `sonnet`, resolvidos pela conta. |
| Codex | OpenAI | O instalador grava automaticamente o roteamento por papel em `.codex/sdd-harness.json`. |

No Codex, `planner` e `builder` usam `gpt-5.6-sol`; `reviewer` e `shipper` usam
`gpt-5.6-terra`; `harness` usa `gpt-5.6-luna`. No OpenCode, os modelos OpenAI
(Luna, Sol) são exclusivos do provedor OpenAI (`console-openai/*`) — nunca
roteados por um provedor multimodelo. Os papéis Anthropic ficam no plano pago
`opencode-go/claude-*`: o tier free `opencode/*` esgota a cota no meio do ciclo e
derruba o gate com `Free usage limit reached`. `checker` removido — guard rails são hooks determinísticos. A instalação aplica
essa decisão, sem exigir escolha do usuário.

## Sintaxe de variante no frontmatter (OpenCode)

Grave o modelo em duas chaves — `model: provedor/modelo` + `variant: low|medium|high|xhigh|max` —
**nunca** no sufixo inline `model: provedor/modelo#variante`. Motivo: qualquer chave legada no
frontmatter (`permission:` no lugar de `permissions:`, `temperature:`, `tools:`) roteia o arquivo
pela migração v1 do OpenCode, cujo `modelSelection()` rejeita strings com `#` e descarta o modelo
em silêncio (bug aberto [opencode#50849](https://github.com/anomalyco/opencode/issues/50849),
reproduzível na 2.2.5). Sem modelo configurado, o subagente **herda modelo e variante do agente que
o chamou** — foi assim que o `planner` caiu no `gpt-6-luna` variante `low` do `harness` em vez do
`gpt-6.1-sol` variante `medium`, e as requisições bateram no tier errado (cota free esgotada).
O `harness` usa `permissions:` nativo, por isso sempre resolvia o próprio modelo e mascarava o problema.

Verificação (sem custo de LLM, no diretório do projeto):

```sh
opencode debug agents | python3 -c "
import json,sys
roles = {'harness','planner','builder','reviewer','shipper','supervisor'}
for a in json.load(sys.stdin):
    if a.get('name') in roles:
        m = a.get('model') or {}
        print(a['name'], '->', f\"{m.get('providerID')}/{m.get('id')}\", m.get('variant'))
"
```

Cada macro deve listar o próprio `providerID`/`id`/`variant`; `model: null` significa herança do pai.
