---
name: trello-manager
description: >-
  Manages Trello boards, lists, and cards via the Trello REST API. Handles the
  full authentication flow by opening the Trello authorization page in the user's
  browser when needed. Use this skill whenever the user asks to create, read,
  update, delete, move, or organize Trello cards and lists; manage Trello boards;
  or automate any Trello workflow. Also trigger when the user mentions Trello,
  kanban boards, or task tracking that involves Trello.
license: MIT
metadata:
  version: "1.2.0"
---

# Trello Manager

Você gerencia boards, listas e cards do Trello **exclusivamente via o CLI da skill** (`trello_api.py`). Não faça chamadas cruas à API (curl/urllib/requests improvisados) — é isso que faz o agente se perder. O CLI usa apenas stdlib (sem dependências), imprime JSON e erros com orientação acionável.

## Regra OBRIGATÓRIA — autenticação antes de qualquer operação

Toda invocação que toque no Trello começa por aqui, **sem exceção (nem leitura)** — é o gate de entrada:

1. **Carregue esta skill** (descoberta via `find-skills`, query `trello`) — sem ela, **nenhuma** chamada, nem "só um comando rápido".
2. **Rode `ensure-auth`** — valida as credenciais salvas e, se ausentes/inválidas, inicia o fluxo de autenticação sozinho:

```bash
python3 <skill-path>/scripts/trello_api.py ensure-auth
```

3. `status: "ok"` → autenticado, siga para as operações. Falha (exit 2 + `ERRO TRELLO [401]`) → a autenticação precisa do humano (colar token no browser/terminal): **registre a pendência e não execute nenhuma operação** — nem leitura.
4. **401 no meio de uma sequência** (token expirou entre comandos) → rode `ensure-auth` de novo e repita a operação que falhou.
5. Re-autenticação forçada (renovar token): `trello_api.py auth`.
6. **O único teste válido de credencial é rodar `ensure-auth`.** NUNCA conclua "sem credenciais" inspecionando o ambiente (`printenv`, `env`, `0 variáveis TRELLO_*`): as credenciais vivem em **`~/.trello_config.json`** (não aparecem em `env`) — o CLI também aceita env `TRELLO_API_KEY`/`TRELLO_TOKEN` como override. Quem arbitra é o gate, não a sua inspeção.

## Path da skill

O script vive em `scripts/` dentro desta pasta da skill. Use o caminho relativo à raiz do repositório onde estiver rodando:

```bash
# fonte do módulo:
python3 skills/trello-manager/scripts/trello_api.py <comando> ...
# projeto instalado (mirror .opencode):
python3 .opencode/skills/trello-manager/scripts/trello_api.py <comando> ...
```

## Autenticação

O gate `ensure-auth` (regra acima) cobre o fluxo completo automaticamente. Detalhes do que ele faz:

1. **Credenciais** — resolvedas em `get_auth()`: env `TRELLO_API_KEY`/`TRELLO_TOKEN` (override) ou `~/.trello_config.json` (fonte padrão, permissões 600). O output do `ensure-auth` traz `source: "ambiente"|"arquivo"`.
2. **Confere `~/.trello_config.json`** — se tem `api_key` e `token`, valida contra `GET /members/me`; válidas → `status: "ok"` e fim.
3. **Ausentes/inválidas**, inicia o fluxo: pede a API Key (de https://trello.com/power-ups/admin), abre a página de autorização no browser, pede o token de volta e salva em `~/.trello_config.json`, validando ao final.
4. **Para forçar/renovar** (token expirado, 401): `trello_api.py auth`. Para só validar sem reautenticar: `trello_api.py whoami`.

```bash
python3 <skill-path>/scripts/trello_api.py auth      # (re)autenticar
python3 <skill-path>/scripts/trello_api.py whoami    # validar credenciais → username
```

**Segurança:** nunca exponha api_key/token na saída (mascare, ex. `key: abc123...`). Nunca faça commit de credenciais.

## Catálogo de comandos

Substitua `<skill-path>` por `skills/trello-manager/scripts` (ou `.opencode/skills/trello-manager/scripts`).

| Comando | Uso |
|---------|-----|
| `ensure-auth` | **GATE OBRIGATÓRIO** — validar credenciais e (re)autenticar se preciso; rode antes de qualquer operação |
| `auth` | (Re)autenticar manualmente → `~/.trello_config.json` |
| `whoami` | Validar credenciais → id/username |
| `boards` | Listar todos os boards (JSON) |
| `find-board <nome-ou-id>` | **Resolver board por nome** (sem acentos), full ID (24 hex), shortLink ou URL — retorna sempre o full ID |
| `lists <board_id>` | Listar listas do board |
| `create-list <board_id> "Nome"` | Criar lista |
| `cards <list_id>` | Listar cards da lista |
| `find-card <board_id> <nome-ou-id>` | **Buscar card por nome** (ou ID/shortlink) no board inteiro |
| `create-card <list_id> "Nome" --desc "..."` | Criar card |
| `labels <board_id>` | Listar labels (tags) do board |
| `create-label <board_id> "Nome" --color red` | Criar label (tag de prioridade/epic) |
| `add-label <card_id> <label_id>` | Adicionar label ao card (ex.: prioridade Alta) |
| `remove-label <card_id> <label_id>` | Remover label do card |
| `move-card <card_id> <list_id>` | Mover card para outra lista |
| `batch <board> --plan/--plan-file` | **Criar o backlog inteiro** (listas/labels/cards) de um plano JSON — idempotente |
| `update-card <card_id> --name/--desc/--due` | Atualizar card |
| `archive-card <card_id>` | Arquivar card |
| `unarchive-card <card_id>` | Restaurar card arquivado |
| `delete-card <card_id>` | Excluir card (permanente) |

Exemplo:

```bash
python3 <skill-path>/scripts/trello_api.py find-board "squad x"
python3 <skill-path>/scripts/trello_api.py lists <board_id>
python3 <skill-path>/scripts/trello_api.py find-card <board_id> "cadastro 2fa"
python3 <skill-path>/scripts/trello_api.py move-card <card_id> <list_id>
```

## IDs de board — full ID, shortLink ou URL

O Trello exige **full ID (24 hex)** em campos de corpo (`idBoard` do POST `/labels`) e
rejeita shortLink com `400 "Invalid id"`. O CLI resolve sozinho: todo comando que recebe
board aceita **nome** (via `find-board`), **full ID**, **shortLink** (`tFeiIxof`) ou
**URL** (`https://trello.com/b/tFeiIxof/...`) e normaliza para o full ID antes da chamada.
Nunca contorne com curl — o bug é justamente passar o short ID cru.

## Regras de execução (anti-improviso)

Incidentes passados: script bash `mkcard` com `set -u` recebeu 5 args (variável de label
vazia, não-quoted, sumiu da lista) e morreu em `$6: unbound variable` — zero cards criados.
Para nunca repetir:

1. **Nunca escreva script intermediário** (bash/python/whatever) que agrupe ou envolva
   comandos do CLI — é onde nascem args sumidos e `unbound variable`. Chame o CLI
   diretamente, **um comando por card**; para criar o backlog inteiro, use `batch`
   (um único comando, plano via JSON).
2. **Nunca monte argumentos por interpolação posicional** (`"$@"`, `$6`, arrays de args).
   Os dados do `batch` vão por JSON/stdin — não por posição.
3. **Valor vazio nunca vira argumento.** Label/lista não resolvida? Pare, resolva pelo
   nome (`labels`/`lists`) ou reporte a pendência — não passe string vazia adiante.
4. **Sempre quote os argumentos** (`"Nome do card"`, `--desc "..."`), mesmo em linha única.
5. O `batch` é idempotente por nome (lista/label/card existentes são reusados, não
   duplicados) e reporta `unknown_labels` — re-rodar o plano após erro parcial é seguro.
6. **IDs nulos no `context:` não bloqueiam** — o `context:` pode não ter IDs do planner.
   Resolva por nome via CLI (`find-board` → `lists`/`find-card`) e siga; "IDs nulos" nunca
   é motivo para pular a operação, e "0 variáveis TRELLO_*" nunca é teste de credencial
   (item 3 da regra obrigatória: o único árbitro é o `ensure-auth`).

Exemplo de `batch` (plano via stdin — nada de args posicionais):

```bash
python3 <skill-path>/scripts/trello_api.py batch "squad x" --plan-file - <<'JSON'
{
  "lists": ["Backlog", "Sprint 1 — auth"],
  "labels": [{"name": "Alta", "color": "red"}, {"name": "Média", "color": "orange"}, {"name": "Baixa", "color": "sky"}],
  "cards": [
    {"list": "Backlog", "name": "[EPIC] auth", "desc": "resumo do escopo", "labels": ["Alta"]},
    {"list": "Sprint 1 — auth", "name": "login 2fa", "desc": "critérios de aceite", "labels": ["Média"]}
  ]
}
JSON
```

Retorno: `{board_id, listas, labels, cards: [{id, name, list, labels, unknown_labels}]}` —
exatamente o formato que o planner propaga em memória.

## Papéis no Harness V2 (quem faz o quê)

O Trello é operado pelos macros do Harness V2 — cada um com escopo fechado. Sempre via este CLI (nunca API crua):

| Agente | Escopo | Comandos permitidos | Proibido |
|--------|--------|---------------------|----------|
| `planner` | **Criar** backlog: cards/epics, tags de prioridade, sprints | `ensure-auth` (gate, sempre 1º), `auth`, `whoami`, `boards`, `find-board`, `lists`, `create-list` (sprint/backlog), `create-card` (epic/story), `labels`, `create-label`, `add-label`, `batch` (backlog inteiro) | `move-card`, `delete-card`, `archive-card` (encerrar é do shipper) |
| `builder` | **Mover/atualizar** — card entra em execução | `ensure-auth` (gate, sempre 1º), `auth`, `whoami`, `find-board`, `lists`, `find-card`, `move-card` (→ lista de execução), `update-card` | `create-card`, `create-list`, `create-label`, `delete-card` (criar é do planner) |
| `shipper` | **Encerrar** — card vai para "concluído" | `ensure-auth` (gate, sempre 1º), `auth`, `whoami`, `find-board`, `lists`, `find-card`, `move-card` (→ conclusão), `update-card`, `archive-card` | `create-card`, `create-list`, `create-label`, `delete-card` (criar é do planner; exclusão é humana) |

Sprint = **lista** no board (ex.: `Sprint 1 — tema`); prioridade = **label** (sugestão: `Alta`=`red`, `Média`=`orange`, `Baixa`=`sky`); épico = card com nome `[EPIC] nome` na lista de backlog.

## Fluxo padrão (operação por nome)

Quando o pedido é de alto nível ("mova o card X para concluído", "crie card da task Y"), resolva nomes → IDs **sempre via CLI**:

1. `ensure-auth` — **gate obrigatório** (valida e reautentica se preciso; falhou → pendência, zero operações).
2. `find-board "<nome>"` — resolve `board_id` pelo nome (nunca invente ID).
3. `lists <board_id>` — vê as listas e escolhe a destino pelo **nome** (`concluído`/`done`/`shipped`/... — nunca invente destino).
4. `find-card <board_id> "<nome do card>"` — resolve `card_id` (ambíguo? use `cards <list_id>` para desambiguar).
5. Execute a operação: `create-card` / `move-card` / `update-card` / `delete-card`.
6. Mostre resumo: card(s) afetados (id + nome) e lista de destino.

**Confirme antes de operações destrutivas** (`delete-card`, `archive-card`). Para criar card, no mínimo: lista, nome; descrição/prazo opcionais.

## Tratamento de erros

O CLI imprime `ERRO TRELLO [<status>]: <detalhe>` + linha `→ <orientação>` e sai com código 2:

- **401** — token inválido/expirado → rode `trello_api.py auth` e repita a operação.
- **400 "Invalid id"** — ID de board/lista/card inválido (ex.: short ID de URL onde só full ID vale). O CLI resolve nome/full ID/shortLink/URL automaticamente; se persiste, confira se algum argumento veio vazio → descubra o ID com `find-board`/`lists`/`find-card`.
- **404** — board/lista/card não encontrado → confira o ID (descubra com `find-board`/`lists`/`find-card`; IDs Trello têm 24 hex).
- **429** — rate limit → aguarde e tente novamente.
- **rede** — falha de conectividade → verifique a rede.
- **Outros** — leia a mensagem e ajuste os parâmetros.

Nunca contorne um erro chamando a API diretamente.
