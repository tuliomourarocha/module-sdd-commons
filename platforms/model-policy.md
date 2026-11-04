# Política de modelos — Harness V2

Cada adaptador tem seu próprio provedor. Não há escolha de modelo global nem
modelo pago por fora gravado nos agentes.

| Harness | Provedor | Resolução de modelo |
| --- | --- | --- |
| OpenCode | OpenCode Go | Todos os macros em `opencode-go/*`; `opencode/*` (Zen free) foi testado para o harness (`big-pickle`) e rejeitado: a cota esgota no meio do ciclo e trava o único papel que inicia tudo ("Free usage limit reached", 04/11/2026). |
| Claude Code | Anthropic | Usa aliases `haiku` e `sonnet`, resolvidos pela conta. |
| Codex | OpenAI | O instalador grava automaticamente o roteamento por papel em `.codex/sdd-harness.json`. |

No Codex, `planner` e `builder` usam `gpt-5.6-sol`; `reviewer` e `shipper` usam
`gpt-5.6-terra`; `harness` usa `gpt-5.6-luna`. No OpenCode o cenário é o de melhor
custo-benefício dentro do plano OpenCode Go, cujos modelos de trabalho custam centavos
por milhão de tokens; o único candidato free (Zen `opencode/big-pickle` para o harness)
foi descartado porque a cota esgota e trava o ciclo. `checker` removido — guard rails são
hooks determinísticos. A instalação aplica
essa decisão, sem exigir escolha do usuário.

## Mapa por papel (OpenCode)

| Papel | Modelo | Variante | Por quê | Custo por M tok (in/out) |
| --- | --- | --- | --- | --- |
| `harness` | `opencode-go/gpt-6-luna` | `low` | Só delega e lê `STATE`/`HANDOFF`; exige obediência a procedimento, não raciocínio. (Free `opencode/big-pickle` testado e rejeitado — cota esgotada trava o ciclo inteiro) | $0,10 / $0,50 |
| `planner` | `opencode-go/glm-5.3-flash` | `high` | PRD e arquitetura com raciocínio elevado a $0,15/$0,5 — o reasoner premium do plano custa 13x mais por token | $0,15 / $0,50 |
| `builder` | `opencode-go/claude-haiku-5-5` | `medium` | Volume alto de código com muito contexto reaproveitado — cache de $0,01/M pesa mais que o modelo bruto | $0,10 / $0,50 |
| `reviewer` | `opencode-go/claude-haiku-5-5` | `high` | Mesmo modelo do builder com raciocínio elevado: parecer estrutural sem trocar de família | $0,10 / $0,50 |
| `shipper` | `opencode-go/gpt-6-luna` | `medium` | Procedimento exato (hook, PR em `develop`, card Trello); variantes acima de `low` reduzem desvio sem custo extra | $0,10 / $0,50 |
| `supervisor` | `opencode-go/glm-5.3-flash` | `low` | Auditoria com saída longa e repetitiva; o `low` no flash segura o preço do relatório | $0,15 / $0,50 |

Ajustes que valem a pena conhecer:

- **`harness` de volta ao free?** Só vale testar `opencode/big-pickle` (Zen, $0) se você aceitar
  que uma cota esgotada impede de *iniciar* qualquer fluxo. Reverter é 1 linha:
  `model: opencode-go/gpt-6-luna` + `variant: low`.
- **`planner` mais forte:** `opencode-go/kimi-k3.1-pro` variante `high` ($2/$10) é o reasoner
  premium; use em arquitetura complexa ou quando o flash errar a quebra de tarefas.
  `glm-5.3-flash` tem `low|high|max` (não tem `medium`).
- **`builder` para código difícil:** `opencode-go/kimi-k2.7-code` ($0,95/$4) é especialista em
  implementação; use quando o `haiku` precisar de mais de uma volta no mesmo gate.

## Chaves legadas no frontmatter (OpenCode)

Grave o modelo em duas chaves — `model: provedor/modelo` + `variant: low|medium|high|xhigh|max` —
**nunca** no sufixo inline `model: provedor/modelo#variante`. Motivo: qualquer chave legada no
frontmatter (`permission:` no lugar de `permissions:`, `temperature:`, `tools:`) roteia o arquivo
pela migração v1 do OpenCode, cujo `modelSelection()` rejeita strings com `#` e descarta o modelo
em silêncio (bug aberto [opencode#50849](https://github.com/anomalyco/opencode/issues/50849),
reproduzível na 2.2.5). Sem modelo configurado, o subagente **herda modelo e variante do agente que
o chamou** — foi assim que o `planner` caiu no `gpt-6-luna` variante `low` do `harness` em vez do
modelo declarado, e as requisições bateram no tier errado (cota esgotada).
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
Disponibilidade é outra coisa: preço na catálogo não garante chamada — confirme com
`opencode run --model <provedor/modelo> "Responda apenas OK"` antes de assumir um modelo novo.
