import json
import os
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

CONFIG_PATH = Path.home() / ".trello_config.json"

AUTHORIZE_URL = (
    "https://trello.com/1/authorize?"
    "expiration=never&"
    "scope=read,write,account&"
    "response_type=token&"
    "name=TrelloManager&"
    "key={api_key}"
)


def load_config():
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    return {}


def save_config(config):
    CONFIG_PATH.write_text(json.dumps(config, indent=2))
    os.chmod(CONFIG_PATH, 0o600)


def get_auth():
    """Credenciais — env `TRELLO_API_KEY`/`TRELLO_TOKEN` (override) ou `~/.trello_config.json`."""
    cfg = load_config()
    api_key = os.environ.get("TRELLO_API_KEY") or cfg.get("api_key")
    token = os.environ.get("TRELLO_TOKEN") or cfg.get("token")
    return api_key, token


def cred_source():
    """De onde vieram as credenciais: 'ambiente', 'arquivo' ou None (nenhuma completa)."""
    cfg = load_config()
    if os.environ.get("TRELLO_API_KEY") and os.environ.get("TRELLO_TOKEN"):
        return "ambiente"
    if cfg.get("api_key") and cfg.get("token"):
        return "arquivo"
    return None


def is_authenticated():
    config = load_config()
    return bool(config.get("api_key") and config.get("token"))


def authenticate():
    print("=== Trello Authentication ===")

    config = load_config()

    if not config.get("api_key"):
        print("\nYou need a Trello API Key.")
        print("Get one at: https://trello.com/power-ups/admin")
        print("(Create a Power-Up if you haven't, then go to the API Key tab)\n")
        try:
            api_key = input("Paste your API Key: ").strip()
        except (EOFError, KeyboardInterrupt):
            api_key = ""
        if not api_key:
            print("No API Key provided. Aborting.")
            return False
        config["api_key"] = api_key
    else:
        api_key = config["api_key"]
        print(f"Using saved API Key: {api_key[:8]}...")

    auth_url = AUTHORIZE_URL.format(api_key=api_key)
    print(f"\nOpening browser for Trello authorization...")
    print(f"If the browser doesn't open, visit:\n{auth_url}\n")
    webbrowser.open(auth_url)

    print("\nAfter authorizing, Trello will show you a token (a long string of letters and numbers).")
    try:
        token = input("Paste the token here: ").strip()
    except (EOFError, KeyboardInterrupt):
        token = ""
    if not token:
        print("No token provided. Aborting.")
        return False

    config["token"] = token
    save_config(config)
    print("\nAuthentication saved successfully!")
    return True


def validate():
    """Valida as credenciais salvas contra GET /members/me.

    Retorna (member, None) em caso de sucesso ou (None, motivo) em falha.
    """
    api_key, token = get_auth()
    if not (api_key and token):
        return None, f"sem credenciais em {CONFIG_PATH}"
    url = "https://api.trello.com/1/members/me?" + urllib.parse.urlencode(
        {"key": api_key, "token": token, "fields": "id,username,fullName"}
    )
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code} ({e.reason}) — token inválido ou expirado"
    except urllib.error.URLError as e:
        return None, f"falha de rede: {e.reason}"


if __name__ == "__main__":
    authenticate()
