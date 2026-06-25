import json
import sys

import requests

from trello_auth import get_auth, is_authenticated, authenticate

BASE_URL = "https://api.trello.com/1"


def _ensure_auth():
    if not is_authenticated():
        print("Not authenticated. Starting authentication flow...")
        if not authenticate():
            sys.exit(1)
    return get_auth()


def _get(url, params=None):
    api_key, token = _ensure_auth()
    p = {"key": api_key, "token": token, **(params or {})}
    resp = requests.get(f"{BASE_URL}{url}", params=p)
    resp.raise_for_status()
    return resp.json()


def _post(url, data=None):
    api_key, token = _ensure_auth()
    d = {"key": api_key, "token": token, **(data or {})}
    resp = requests.post(f"{BASE_URL}{url}", data=d)
    resp.raise_for_status()
    return resp.json()


def _put(url, data=None):
    api_key, token = _ensure_auth()
    d = {"key": api_key, "token": token, **(data or {})}
    resp = requests.put(f"{BASE_URL}{url}", data=d)
    resp.raise_for_status()
    return resp.json()


def _delete(url, params=None):
    api_key, token = _ensure_auth()
    p = {"key": api_key, "token": token, **(params or {})}
    resp = requests.delete(f"{BASE_URL}{url}", params=p)
    resp.raise_for_status()
    return resp.json()


# --- Boards ---

def list_boards():
    return _get("/members/me/boards")


# --- Lists ---

def list_lists(board_id):
    return _get(f"/boards/{board_id}/lists")


def create_list(board_id, name, pos="bottom"):
    return _post(f"/boards/{board_id}/lists", {
        "name": name,
        "pos": pos,
    })


def update_list(list_id, **kwargs):
    return _put(f"/lists/{list_id}", kwargs)


def archive_list(list_id):
    return _put(f"/lists/{list_id}", {"closed": True})


# --- Cards ---

def list_cards(list_id):
    return _get(f"/lists/{list_id}/cards")


def get_card(card_id):
    return _get(f"/cards/{card_id}")


def create_card(list_id, name, desc="", pos="bottom", due=None, labels=None):
    data = {
        "idList": list_id,
        "name": name,
        "desc": desc,
        "pos": pos,
    }
    if due:
        data["due"] = due
    if labels:
        data["idLabels"] = ",".join(labels)
    return _post("/cards", data)


def update_card(card_id, **kwargs):
    return _put(f"/cards/{card_id}", kwargs)


def move_card(card_id, list_id):
    return _put(f"/cards/{card_id}", {"idList": list_id})


def archive_card(card_id):
    return _put(f"/cards/{card_id}", {"closed": True})


def delete_card(card_id):
    return _delete(f"/cards/{card_id}")


# --- CLI ---

def _print_json(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Trello Manager CLI")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("auth", help="Authenticate with Trello")
    sub.add_parser("boards", help="List all boards")

    list_parser = sub.add_parser("lists", help="List lists of a board")
    list_parser.add_argument("board_id")

    create_list_parser = sub.add_parser("create-list", help="Create a list")
    create_list_parser.add_argument("board_id")
    create_list_parser.add_argument("name")

    cards_parser = sub.add_parser("cards", help="List cards in a list")
    cards_parser.add_argument("list_id")

    create_card_parser = sub.add_parser("create-card", help="Create a card")
    create_card_parser.add_argument("list_id")
    create_card_parser.add_argument("name")
    create_card_parser.add_argument("--desc", default="")
    create_card_parser.add_argument("--due")

    move_card_parser = sub.add_parser("move-card", help="Move a card to another list")
    move_card_parser.add_argument("card_id")
    move_card_parser.add_argument("list_id")

    delete_card_parser = sub.add_parser("delete-card", help="Delete a card")
    delete_card_parser.add_argument("card_id")

    args = parser.parse_args()

    if args.command == "auth":
        authenticate()
    elif args.command == "boards":
        _print_json(list_boards())
    elif args.command == "lists":
        _print_json(list_lists(args.board_id))
    elif args.command == "create-list":
        _print_json(create_list(args.board_id, args.name))
    elif args.command == "cards":
        _print_json(list_cards(args.list_id))
    elif args.command == "create-card":
        _print_json(create_card(args.list_id, args.name, args.desc))
    elif args.command == "move-card":
        _print_json(move_card(args.card_id, args.list_id))
    elif args.command == "delete-card":
        _print_json(delete_card(args.card_id))
    else:
        parser.print_help()
