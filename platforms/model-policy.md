# Política de modelos — Harness V2

Cada adaptador tem seu próprio provedor. O instalador traz um **padrão por papel**
e, em terminal interativo, oferece a lista de modelos disponíveis do harness
escolhido para o usuário aceitar ou trocar. A escolha é sempre opcional: Enter
mantém a recomendação da squad.

| Harness | Provedor | Resolução de modelo |
| --- | --- | --- |
| OpenCode | OpenCode Go | Padrão em `opencode-go/*`; a lista vem de `opencode models` + catálogo local. `opencode/*` (Zen free) é oferecido, mas marcado com risco de cota: no harness, um `big-pickle` com cota esgotada trava o único papel que inicia tudo. |
| Claude Code | Anthropic | Aliases `haiku`/`sonnet`/`opus`, resolvidos pela conta; o instalador pergunta por agente. |
| Codex | OpenAI | Roteamento gravado em `.codex/sdd-harness.json`; a lista combina o catálogo OpenAI conhecido com o `model` já configurado em `~/.codex/config.toml`. |

No Codex, o padrão é `planner` e `builder` em `gpt-5.6-sol`; `reviewer`, `shipper` e
`supervisor` em `gpt-5.6-terra`; `harness` em `gpt-5.6-luna`. No OpenCode o cenário é
o de melhor custo-benefício dentro do plano OpenCode Go. `checker` removido — guard
rails são hooks determinísticos.

## Seleção interativa (instalação)

Quando `stdin` e `stdout` são TTY (e `--no-model-picker` não foi passado):

1. O CLI detecta os modelos disponíveis por harness.
2. Para cada agente, imprime até 8 opções ordenadas por qualidade × custo-benefício
   para aquele papel, com preço de referência, contexto e variante sugerida.
3. A recomendação da squad aparece em **verde** com `★ recomendado`.
4. `Enter` aceita todos; `r` revisa agente por agente; `t` mostra a lista completa.
   No modo de revisão, também é possível digitar o número ou o nome do modelo.

Sem TTY, em `--dry-run` (apenas imprime) ou com `--no-model-picker`, a instalação
aplica o padrão da squad sem perguntar. A escolha do OpenCode é gravada como
`model:` + `variant:` no frontmatter (nunca no sufixo `#variante`); no Claude Code,
no `model:` do agente; no Codex, em `.codex/sdd-harness.json`.

### Como o ranking é calculado

O instalador pontua cada modelo em cinco eixos — general, coding, instruction,
speed e reliability — e combina com o custo:

| Papel | Peso de qualidade | Peso de custo | Foco |
| --- | --- | --- | --- |
| `harness` | 35% | 65% | instrução e procedimento |
| `planner` | 65% | 35% | raciocínio e contexto |
| `builder` | 55% | 45% | coding e cache |
| `reviewer` | 60% | 40% | leitura crítica e coding |
| `shipper` | 35% | 65% | instrução e procedimento |
| `supervisor` | 45% | 55% | saída longa e custo |

Custo no OpenCode usa o preço por token (input + 3×output, aproximando uso de
agente); no Claude/Codex assinados, usa uma classe relativa de cota. Modelos free,
`preview`, `legacy` e `console-openai` recebem penalidade de risco; no `harness` e
no `shipper`, free pesa mais porque a cota esgotada interrompe o ciclo. O padrão da
squad recebe um pequeno bônus de fit para continuar no topo — ele é a recomendação
curada, não um empate acidental. A pontuação é uma curadoria local aproximada; a
lista completa (`t`) mostra todas as opções disponíveis para o usuário decidir.

## Mapa por papel (OpenCode — padrão)

| Papel | Modelo | Variante | Por quê | Custo por M tok (in/out) |
| --- | --- | --- | --- | --- |
| `harness` | `opencode-go/gpt-6-luna` | `low` | Só delega e lê `STATE`/`HANDOFF`; exige obediência a procedimento, não raciocínio. (Free `opencode/big-pickle` testado e rejeitado — cota esgotada trava o ciclo inteiro) | $0,10 / $0,50 |
| `planner` | `opencode-go/glm-5.3-flash` | `high` | PRD e arquitetura com raciocínio elevado a $0,15/$0,5 — o reasoner premium do plano custa 13x mais por token | $0,15 / $0,50 |
| `builder` | `opencode-go/claude-haiku-5-5` | `medium` | Volume alto de código com muito contexto reaproveitado — cache de $0,01/M pesa mais que o modelo bruto | $0,10 / $0,50 |
| `reviewer` | `opencode-go/claude-haiku-5-5` | `high` | Mesmo modelo do builder com raciocínio elevado: parecer estrutural sem trocar de família | $0,10 / $0,50 |
| `shipper` | `opencode-go/gpt-6-luna` | `medium` | Procedimento exato (hook, PR em `develop`, issue GitHub); variantes acima de `low` reduzem desvio sem custo extra | $0,10 / $0,50 |
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
