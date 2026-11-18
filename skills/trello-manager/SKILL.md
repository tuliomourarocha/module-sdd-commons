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

## Path da skill

O script vive em `scripts/` dentro desta pasta da skill. Use o caminho relativo à raiz do repositório onde estiver rodando:

```bash
# fonte do módulo:
python3 skills/trello-manager/scripts/trello_api.py <comando> ...
# projeto instalado (mirror .opencode):
python3 .opencode/skills/trello-manager/scripts/trello_api.py <comando> ...
```

## Autenticação (sempre primeiro)

O CLI verifica as credenciais automaticamente antes de qualquer comando. Se quiser validar explicitamente:

1. **Confere `~/.trello_config.json`** — se tem `api_key` e `token`, prossegue.
2. **Sem credenciais**, inicia o fluxo: pede a API Key (de https://trello.com/power-ups/admin), abre a página de autorização no browser, pede o token de volta e salva em `~/.trello_config.json` (permissões 600).
3. **Para forçar/renovar** (token expirado, 401): rode `trello_api.py auth`.

```bash
python3 <skill-path>/scripts/trello_api.py auth      # (re)autenticar
python3 <skill-path>/scripts/trello_api.py whoami    # validar credenciais → username
```

**Segurança:** nunca exponha api_key/token na saída (mascare, ex. `key: abc123...`). Nunca faça commit de credenciais.

## Catálogo de comandos

Substitua `<skill-path>` por `skills/trello-manager/scripts` (ou `.opencode/skills/trello-manager/scripts`).

| Comando | Uso |
|---------|-----|
| `auth` | (Re)autenticar → `~/.trello_config.json` |
| `whoami` | Validar credenciais → id/username |
| `boards` | Listar todos os boards (JSON) |
| `find-board <nome-ou-id>` | **Resolver board por nome** (sem acentos) ou ID |
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

## Papéis no Harness V2 (quem faz o quê)

O Trello é operado pelos macros do Harness V2 — cada um com escopo fechado. Sempre via este CLI (nunca API crua):

| Agente | Escopo | Comandos permitidos | Proibido |
|--------|--------|---------------------|----------|
| `planner` | **Criar** backlog: cards/epics, tags de prioridade, sprints | `auth`, `whoami`, `boards`, `find-board`, `lists`, `create-list` (sprint/backlog), `create-card` (epic/story), `labels`, `create-label`, `add-label` | `move-card`, `delete-card`, `archive-card` (encerrar é do shipper) |
| `builder` | **Mover/atualizar** — card entra em execução | `auth`, `whoami`, `find-board`, `lists`, `find-card`, `move-card` (→ lista de execução), `update-card` | `create-card`, `create-list`, `create-label`, `delete-card` (criar é do planner) |
| `shipper` | **Encerrar** — card vai para "concluído" | `auth`, `whoami`, `find-board`, `lists`, `find-card`, `move-card` (→ conclusão), `update-card`, `archive-card` | `create-card`, `create-list`, `create-label`, `delete-card` (criar é do planner; exclusão é humana) |

Sprint = **lista** no board (ex.: `Sprint 1 — tema`); prioridade = **label** (sugestão: `Alta`=`red`, `Média`=`orange`, `Baixa`=`sky`); épico = card com nome `[EPIC] nome` na lista de backlog.

## Fluxo padrão (operação por nome)

Quando o pedido é de alto nível ("mova o card X para concluído", "crie card da task Y"), resolva nomes → IDs **sempre via CLI**:

1. `whoami` — valida credenciais (diagnóstico rápido de 401).
2. `find-board "<nome>"` — resolve `board_id` pelo nome (nunca invente ID).
3. `lists <board_id>` — vê as listas e escolhe a destino pelo **nome** (`concluído`/`done`/`shipped`/... — nunca invente destino).
4. `find-card <board_id> "<nome do card>"` — resolve `card_id` (ambíguo? use `cards <list_id>` para desambiguar).
5. Execute a operação: `create-card` / `move-card` / `update-card` / `delete-card`.
6. Mostre resumo: card(s) afetados (id + nome) e lista de destino.

**Confirme antes de operações destrutivas** (`delete-card`, `archive-card`). Para criar card, no mínimo: lista, nome; descrição/prazo opcionais.

## Tratamento de erros

O CLI imprime `ERRO TRELLO [<status>]: <detalhe>` + linha `→ <orientação>` e sai com código 2:

- **401** — token inválido/expirado → rode `trello_api.py auth` e repita a operação.
- **404** — board/lista/card não encontrado → confira o ID (descubra com `find-board`/`lists`/`find-card`; IDs Trello têm 24 hex).
- **429** — rate limit → aguarde e tente novamente.
- **rede** — falha de conectividade → verifique a rede.
- **Outros** — leia a mensagem e ajuste os parâmetros.

Nunca contorne um erro chamando a API diretamente.
