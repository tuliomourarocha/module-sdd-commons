"""trello_api.py — CLI determinístico do Trello (skill trello-manager).

Toda operação de Trello passa por aqui — nunca faça chamadas cruas à API
(curl/urllib/requests improvisados). Usa apenas stdlib (sem dependências).

- Saída de dados: JSON (parse direto pelo agente).
- Erros: mensagem curta com status + orientação acionável (401 → auth,
  404 → confira o ID, 429 → aguarde). Exit code 2 em erro de API.
"""
import argparse
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from trello_auth import authenticate, cred_source, get_auth, is_authenticated, validate

BASE_URL = "https://api.trello.com/1"


class TrelloCliError(Exception):
    """Erro de API com status HTTP e orientação acionável."""

    def __init__(self, status, message, guidance=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.guidance = guidance


def _guidance(status, message=""):
    if status == 401:
        return "credencial inválida/expirada → rode: trello_api.py auth"
    if status == 404:
        return "ID não encontrado → descubra com find-board / lists / cards / find-card"
    if status == 429:
        return "rate limit → aguarde alguns segundos e tente novamente"
    if status == 400 and "invalid id" in (message or "").lower():
        return ("board/lista/card com ID inválido — o CLI aceita nome (via find-board), "
                "full ID (24 hex), shortLink ou URL de board e resolve sozinho; "
                "confira também se algum argumento não veio vazio")
    return "confira os parâmetros do comando"


def _request(method, path, params=None):
    """Chamada HTTP ao Trello com auth embutida na query string."""
    if not is_authenticated():
        print("Sem credenciais (nem env TRELLO_API_KEY/TRELLO_TOKEN, nem ~/.trello_config.json). Iniciando autenticação...", file=sys.stderr)
        if not authenticate():
            raise TrelloCliError(401, "autenticação não concluída", "rode: trello_api.py auth")
    api_key, token = get_auth()
    qs = urllib.parse.urlencode({"key": api_key, "token": token, **(params or {})})
    req = urllib.request.Request(f"{BASE_URL}{path}?{qs}", method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace").strip()
        raise TrelloCliError(e.code, detail or e.reason) from None
    except urllib.error.URLError as e:
        raise TrelloCliError(0, f"falha de rede: {e.reason}") from None
    return json.loads(body) if body else {}


def _norm(text):
    """Normaliza para busca: minúsculas e sem acentos."""
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower().strip()


_FULL_ID_RE = re.compile(r"^[0-9a-f]{24}$")
_BOARD_URL_RE = re.compile(r"trello\.com/b/([A-Za-z0-9]+)")


def _board_ref(ref):
    """Extrai full ID ou shortLink de um full ID, shortLink ou URL de board."""
    ref = (ref or "").strip()
    m = _BOARD_URL_RE.search(ref)
    if m:
        return m.group(1)
    return ref.rstrip("/")


def _resolve_board_id(board_ref):
    """Resolve board → full ID (24 hex).

    Endpoints que exigem full ID no corpo (ex.: POST /labels com idBoard)
    retornam 400 "Invalid id" para shortLink — aqui normalizamos: 24 hex
    passa direto; shortLink/URL resolve via GET /boards/{ref} (que os aceita).
    """
    ref = _board_ref(board_ref)
    if _FULL_ID_RE.match(ref.lower()):
        return ref.lower()
    board = _request("GET", f"/boards/{ref}", {"fields": "id"})
    return board["id"]


# --- Members ---

def whoami():
    """Valida credenciais e retorna o membro autenticado."""
    member, err = validate()
    if err:
        status = 401 if "HTTP 401" in err else 0
        raise TrelloCliError(status, err, "rode: trello_api.py auth")
    return {"id": member.get("id"), "username": member.get("username"),
            "fullName": member.get("fullName")}


def ensure_auth():
    """GATE obrigatório de autenticação — rode antes de qualquer operação.

    Valida as credenciais salvas (env TRELLO_API_KEY/TRELLO_TOKEN ou
    ~/.trello_config.json); se ausentes/inválidas, inicia (re)autenticação
    e valida de novo. Retorna {status: "ok", source, ...} ou falha com exit 2.
    """
    api_key, _token = get_auth()
    if api_key and _token:
        member, err = validate()
        if not err:
            return {"status": "ok", "source": cred_source(), "id": member.get("id"),
                    "username": member.get("username"), "fullName": member.get("fullName")}
        print(f"Credencial inválida ({err}). Iniciando reautenticação...", file=sys.stderr)
    if not authenticate():
        raise TrelloCliError(401, "autenticação não concluída",
                             "rode: trello_api.py auth (interativo) e repita a operação")
    member, err = validate()
    if err:
        status = 401 if "HTTP 401" in err else 0
        raise TrelloCliError(status, f"autenticação não validada: {err}",
                             "confira a api_key/token em ~/.trello_config.json e rode: trello_api.py auth")
    return {"status": "ok", "source": cred_source(), "id": member.get("id"),
            "username": member.get("username"), "fullName": member.get("fullName")}


# --- Boards ---

def list_boards():
    return _request("GET", "/members/me/boards", {"fields": "id,name,url,closed,shortLink"})


def find_board(query):
    """Resolve board(s) por nome (sem acentos), full ID, shortLink ou URL."""
    q = _norm(query)
    ref = _board_ref(query).lower()
    hits = []
    for b in list_boards():
        if b.get("closed"):
            continue
        hay = " ".join([_norm(b.get("name", "")), b.get("id", "").lower(),
                        (b.get("shortLink") or "").lower()])
        if q and (q in hay or ref in hay):
            hits.append({"id": b["id"], "name": b["name"], "url": b.get("url")})
    return hits


# --- Lists ---

def list_lists(board_id):
    return _request("GET", f"/boards/{_resolve_board_id(board_id)}/lists", {"fields": "id,name,closed"})


def create_list(board_id, name, pos="bottom"):
    return _request("POST", f"/boards/{_resolve_board_id(board_id)}/lists", {"name": name, "pos": pos})


def update_list(list_id, **kwargs):
    return _request("PUT", f"/lists/{list_id}", kwargs)


def archive_list(list_id):
    return _request("PUT", f"/lists/{list_id}", {"closed": "true"})


# --- Cards ---

def list_cards(list_id):
    return _request("GET", f"/lists/{list_id}/cards",
                    {"fields": "id,name,idList,closed,shortUrl,labels"})


def get_card(card_id):
    return _request("GET", f"/cards/{card_id}",
                    {"fields": "id,name,idList,closed,shortUrl,labels"})


def find_card(board_id, query):
    """Busca cards por nome (sem acentos), ID ou shortlink em todo o board."""
    q = _norm(query)
    board_id = _resolve_board_id(board_id)
    hits = []
    for lst in list_lists(board_id):
        if lst.get("closed"):
            continue
        for card in list_cards(lst["id"]):
            hay = " ".join([_norm(card.get("name", "")), card.get("id", "").lower(),
                            (card.get("shortUrl") or "").lower()])
            if q and q in hay:
                hits.append({"id": card["id"], "name": card["name"],
                             "list": lst["name"], "idList": lst["id"],
                             "shortUrl": card.get("shortUrl"),
                             "labels": [l.get("name") or l.get("color") for l in (card.get("labels") or [])]})
    return hits


def create_card(list_id, name, desc="", pos="bottom", due=None):
    data = {"idList": list_id, "name": name, "desc": desc, "pos": pos}
    if due:
        data["due"] = due
    return _request("POST", "/cards", data)


def update_card(card_id, name=None, desc=None, due=None):
    data = {k: v for k, v in {"name": name, "desc": desc, "due": due}.items() if v is not None}
    if not data:
        raise TrelloCliError(None, "update-card exige ao menos --name, --desc ou --due",
                             "ex.: update-card <card_id> --name \"Novo nome\"")
    return _request("PUT", f"/cards/{card_id}", data)


def move_card(card_id, list_id):
    return _request("PUT", f"/cards/{card_id}", {"idList": list_id})


def archive_card(card_id):
    return _request("PUT", f"/cards/{card_id}", {"closed": "true"})


def unarchive_card(card_id):
    return _request("PUT", f"/cards/{card_id}", {"closed": "false"})


def delete_card(card_id):
    return _request("DELETE", f"/cards/{card_id}")


# --- Labels (tags/prioridade) ---

def list_labels(board_id):
    return _request("GET", f"/boards/{_resolve_board_id(board_id)}/labels", {"fields": "id,name,color"})


def create_label(board_id, name, color=None):
    data = {"name": name, "idBoard": _resolve_board_id(board_id)}
    if color:
        data["color"] = color
    return _request("POST", "/labels", data)


def add_label(card_id, label_id):
    return _request("POST", f"/cards/{card_id}/idLabels", {"value": label_id})


def remove_label(card_id, label_id):
    return _request("DELETE", f"/cards/{card_id}/idLabels/{label_id}")


# --- Batch (backlog inteiro em uma chamada) ---

def batch(board_ref, plan):
    """Cria listas/labels/cards de um plano JSON com reuso idempotente por nome.

    plan: {"lists": ["Backlog", ...] ou [{"name": ..., "color"? só em labels}],
           "labels": [{"name": "Alta", "color": "red"}, ...],
           "cards": [{"list": "Backlog", "name": "[EPIC] x",
                      "desc": "...", "labels": ["Alta"]}, ...]}

    Reuso: lista/label existente com o mesmo nome (sem acento, case-insensitive)
    é reaproveitada — nunca duplicada; card existente no board com o mesmo nome
    é reutilizado (idempotente: re-rodar o plano não duplica). Label de card
    desconhecida não vira argumento vazio: é reportada em `unknown_labels`.
    Retorna {board_id, listas, labels, cards} — o formato que o planner propaga.
    """
    if not isinstance(plan, dict):
        raise TrelloCliError(None, "plano inválido: --plan/--plan-file deve conter um objeto JSON",
                             'ex.: --plan \'{"lists":[...], "labels":[...], "cards":[...]}\'')
    board_id = _resolve_board_id(board_ref)

    lists_by_key = {}
    lists_orig = {}
    for lst in list_lists(board_id):
        if not lst.get("closed"):
            key = _norm(lst.get("name", ""))
            lists_by_key.setdefault(key, lst["id"])
            lists_orig.setdefault(key, lst["name"])
    for spec in plan.get("lists") or []:
        name = spec.get("name") if isinstance(spec, dict) else spec
        key = _norm(name)
        if not key:
            continue
        if key not in lists_by_key:
            lists_by_key[key] = create_list(board_id, name)["id"]
        lists_orig[key] = name

    labels_by_key = {}
    labels_orig = {}
    for lbl in list_labels(board_id):
        if lbl.get("name"):
            key = _norm(lbl["name"])
            labels_by_key.setdefault(key, lbl["id"])
            labels_orig.setdefault(key, lbl["name"])
    for spec in plan.get("labels") or []:
        name = spec.get("name") if isinstance(spec, dict) else spec
        key = _norm(name)
        if not key or key in labels_by_key:
            continue
        color = spec.get("color") if isinstance(spec, dict) else None
        labels_by_key[key] = create_label(board_id, name, color=color)["id"]
        labels_orig[key] = name

    existing = {}
    for list_id in set(lists_by_key.values()):
        for card in list_cards(list_id):
            existing.setdefault(_norm(card.get("name", "")), card["id"])

    out_cards = []
    for spec in plan.get("cards") or []:
        name = (spec.get("name") or "").strip()
        if not name:
            raise TrelloCliError(None, "item de 'cards' sem 'name' no plano",
                                 "todo card do plano exige 'name' e 'list'")
        list_name = (spec.get("list") or "").strip()
        list_id = lists_by_key.get(_norm(list_name))
        if not list_id:
            raise TrelloCliError(None, f"card '{name}': lista '{list_name}' não existe no board nem no plano",
                                 "inclua a lista em 'lists' ou use o nome exato de uma existente")
        card_id = existing.get(_norm(name))
        if not card_id:
            card_id = create_card(list_id, name, desc=spec.get("desc", ""))["id"]
            existing[_norm(name)] = card_id
        used_labels = []
        unknown_labels = []
        for ln in spec.get("labels") or []:
            label_id = labels_by_key.get(_norm(ln))
            if label_id:
                add_label(card_id, label_id)
                used_labels.append(ln)
            else:
                unknown_labels.append(ln)
        out_cards.append({"id": card_id, "name": name, "list": list_name,
                          "labels": used_labels, "unknown_labels": unknown_labels})

    used_list_keys = [_norm(c["list"]) for c in out_cards] + [_norm(s) if isinstance(s, str)
                                                              else _norm(s.get("name"))
                                                              for s in plan.get("lists") or []]
    return {
        "board_id": board_id,
        "listas": {lists_orig[k]: lists_by_key[k] for k in dict.fromkeys(used_list_keys) if k in lists_by_key},
        "labels": {labels_orig[k]: labels_by_key[k] for k in labels_by_key},
        "cards": out_cards,
    }


# --- CLI ---

def _print_json(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="trello_api.py",
        description="CLI do Trello — auth, boards, listas, cards e labels (criar/mover/excluir etc.)",
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("auth", help="Autenticar (abre browser, salva ~/.trello_config.json)")
    sub.add_parser("ensure-auth", help="GATE: validar credenciais e (re)autenticar se preciso — rode ANTES de qualquer operação")
    sub.add_parser("whoami", help="Validar credenciais (GET /members/me)")
    sub.add_parser("boards", help="Listar todos os boards")

    p = sub.add_parser("find-board", help="Resolver board por nome (ou ID)")
    p.add_argument("query")

    p = sub.add_parser("lists", help="Listar listas de um board")
    p.add_argument("board_id")

    p = sub.add_parser("create-list", help="Criar lista")
    p.add_argument("board_id")
    p.add_argument("name")

    p = sub.add_parser("cards", help="Listar cards de uma lista")
    p.add_argument("list_id")

    p = sub.add_parser("find-card", help="Buscar card por nome (ou ID/shortlink) no board inteiro")
    p.add_argument("board_id")
    p.add_argument("query")

    p = sub.add_parser("create-card", help="Criar card")
    p.add_argument("list_id")
    p.add_argument("name")
    p.add_argument("--desc", default="")
    p.add_argument("--due")

    p = sub.add_parser("update-card", help="Atualizar card (--name/--desc/--due)")
    p.add_argument("card_id")
    p.add_argument("--name")
    p.add_argument("--desc")
    p.add_argument("--due")

    p = sub.add_parser("labels", help="Listar labels (tags) de um board")
    p.add_argument("board_id")

    p = sub.add_parser("create-label", help="Criar label (tag) no board")
    p.add_argument("board_id")
    p.add_argument("name")
    p.add_argument("--color",
                   choices=["yellow", "purple", "blue", "red", "green", "orange", "sky", "lime", "pink", "black"],
                   default=None)

    p = sub.add_parser("add-label", help="Adicionar label (tag/prioridade) a um card")
    p.add_argument("card_id")
    p.add_argument("label_id")

    p = sub.add_parser("remove-label", help="Remover label de um card")
    p.add_argument("card_id")
    p.add_argument("label_id")

    p = sub.add_parser("move-card", help="Mover card para outra lista")
    p.add_argument("card_id")
    p.add_argument("list_id")

    p = sub.add_parser("batch", help="Criar backlog inteiro (listas/labels/cards) a partir de um plano JSON")
    p.add_argument("board_ref", help="Board: nome (via find-board), full ID (24 hex), shortLink ou URL")
    p.add_argument("--plan", help="Plano JSON inline: {lists, labels, cards}")
    p.add_argument("--plan-file", help="Arquivo com o plano JSON ('-' = stdin)")

    p = sub.add_parser("archive-card", help="Arquivar card")
    p.add_argument("card_id")

    p = sub.add_parser("unarchive-card", help="Restaurar card arquivado")
    p.add_argument("card_id")

    p = sub.add_parser("delete-card", help="Excluir card (permanente)")
    p.add_argument("card_id")

    return parser


def _dispatch(args):
    if args.command == "auth":
        authenticate()
        return {"status": "ok", "config": "~/.trello_config.json"}
    if args.command == "ensure-auth":
        return ensure_auth()
    if args.command == "whoami":
        return whoami()
    if args.command == "boards":
        return list_boards()
    if args.command == "find-board":
        return find_board(args.query)
    if args.command == "lists":
        return list_lists(args.board_id)
    if args.command == "create-list":
        return create_list(args.board_id, args.name)
    if args.command == "cards":
        return list_cards(args.list_id)
    if args.command == "find-card":
        return find_card(args.board_id, args.query)
    if args.command == "create-card":
        return create_card(args.list_id, args.name, args.desc, due=args.due)
    if args.command == "update-card":
        return update_card(args.card_id, name=args.name, desc=args.desc, due=args.due)
    if args.command == "labels":
        return list_labels(args.board_id)
    if args.command == "create-label":
        return create_label(args.board_id, args.name, color=args.color)
    if args.command == "add-label":
        return add_label(args.card_id, args.label_id)
    if args.command == "remove-label":
        return remove_label(args.card_id, args.label_id)
    if args.command == "move-card":
        return move_card(args.card_id, args.list_id)
    if args.command == "batch":
        if args.plan_file:
            if args.plan_file == "-":
                raw = sys.stdin.read()
            else:
                with open(args.plan_file, encoding="utf-8") as fh:
                    raw = fh.read()
        elif args.plan:
            raw = args.plan
        else:
            raise TrelloCliError(None, "batch exige --plan ou --plan-file",
                                 'ex.: batch <board> --plan-file - <<<\'{"lists":[...],...}\'')
        try:
            plan = json.loads(raw)
        except json.JSONDecodeError as e:
            raise TrelloCliError(None, f"plano JSON inválido: {e}",
                                 "valide o JSON do plano (aspas e vírgulas)")
        return batch(args.board_ref, plan)
    if args.command == "archive-card":
        return archive_card(args.card_id)
    if args.command == "unarchive-card":
        return unarchive_card(args.card_id)
    if args.command == "delete-card":
        return delete_card(args.card_id)
    return None


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        out = _dispatch(args)
    except TrelloCliError as e:
        label = e.status if e.status else ("uso" if e.status is None else "rede")
        print(f"ERRO TRELLO [{label}]: {e.message}", file=sys.stderr)
        print(f"→ {e.guidance or _guidance(e.status or 0, e.message)}", file=sys.stderr)
        return 2
    if out is not None:
        _print_json(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
