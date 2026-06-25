import json
import os
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
        api_key = input("Paste your API Key: ").strip()
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
    token = input("Paste the token here: ").strip()
    if not token:
        print("No token provided. Aborting.")
        return False

    config["token"] = token
    save_config(config)
    print("\nAuthentication saved successfully!")
    return True


def get_auth():
    config = load_config()
    return config.get("api_key"), config.get("token")


if __name__ == "__main__":
    authenticate()
