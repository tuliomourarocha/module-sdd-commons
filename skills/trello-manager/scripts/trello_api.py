"""trello_api.py — CLI determinístico do Trello (skill trello-manager).

Toda operação de Trello passa por aqui — nunca faça chamadas cruas à API
(curl/urllib/requests improvisados). Usa apenas stdlib (sem dependências).

- Saída de dados: JSON (parse direto pelo agente).
- Erros: mensagem curta com status + orientação acionável (401 → auth,
  404 → confira o ID, 429 → aguarde). Exit code 2 em erro de API.
"""
import argparse
import json
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from trello_auth import authenticate, get_auth, is_authenticated, validate

BASE_URL = "https://api.trello.com/1"


class TrelloCliError(Exception):
    """Erro de API com status HTTP e orientação acionável."""

    def __init__(self, status, message, guidance=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.guidance = guidance


def _guidance(status):
    if status == 401:
        return "credencial inválida/expirada → rode: trello_api.py auth"
    if status == 404:
        return "ID não encontrado → descubra com find-board / lists / cards / find-card"
    if status == 429:
        return "rate limit → aguarde alguns segundos e tente novamente"
    return "confira os parâmetros do comando"


def _request(method, path, params=None):
    """Chamada HTTP ao Trello com auth embutida na query string."""
    if not is_authenticated():
        print("Sem credenciais (~/.trello_config.json). Iniciando autenticação...", file=sys.stderr)
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


# --- Members ---

def whoami():
    """Valida credenciais e retorna o membro autenticado."""
    member, err = validate()
    if err:
        status = 401 if "HTTP 401" in err else 0
        raise TrelloCliError(status, err, "rode: trello_api.py auth")
    return {"id": member.get("id"), "username": member.get("username"),
            "fullName": member.get("fullName")}


# --- Boards ---

def list_boards():
    return _request("GET", "/members/me/boards", {"fields": "id,name,url,closed"})


def find_board(query):
    """Resolve board(s) por nome (sem acentos) ou ID."""
    q = _norm(query)
    hits = []
    for b in list_boards():
        if b.get("closed"):
            continue
        hay = f"{_norm(b.get('name', ''))} {b.get('id', '').lower()}"
        if q and q in hay:
            hits.append({"id": b["id"], "name": b["name"], "url": b.get("url")})
    return hits


# --- Lists ---

def list_lists(board_id):
    return _request("GET", f"/boards/{board_id}/lists", {"fields": "id,name,closed"})


def create_list(board_id, name, pos="bottom"):
    return _request("POST", f"/boards/{board_id}/lists", {"name": name, "pos": pos})


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
    return _request("GET", f"/boards/{board_id}/labels", {"fields": "id,name,color"})


def create_label(board_id, name, color=None):
    data = {"name": name, "idBoard": board_id}
    if color:
        data["color"] = color
    return _request("POST", "/labels", data)


def add_label(card_id, label_id):
    return _request("POST", f"/cards/{card_id}/idLabels", {"value": label_id})


def remove_label(card_id, label_id):
    return _request("DELETE", f"/cards/{card_id}/idLabels/{label_id}")


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
        print(f"→ {e.guidance or _guidance(e.status or 0)}", file=sys.stderr)
        return 2
    if out is not None:
        _print_json(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
