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
  version: "1.0.0"
---

# Trello Manager

You help the user manage their Trello boards, lists, and cards programmatically using the Trello REST API. You have Python scripts in `scripts/` that handle authentication and API calls.

## Important: Authentication First

Before any API operation, check if the user is authenticated. If not, guide them through the flow:

1. **Check `~/.trello_config.json`** — if it has `api_key` and `token`, proceed.
2. **If not authenticated**, run the auth script:
   ```bash
   python <skill-path>/scripts/trello_auth.py
   ```
   This will:
   - Prompt the user for their Trello API Key (from https://trello.com/power-ups/admin)
   - Open the Trello authorization page in their browser
   - Ask them to paste the token back
   - Save credentials securely to `~/.trello_config.json` (permissions 600)

3. **If the auth script fails**, fall back to manually:
   - Ask the user to visit https://trello.com/power-ups/admin to get an API Key
   - Open https://trello.com/1/authorize?expiration=never&scope=read,write,account&response_type=token&name=TrelloManager&key={api_key} in their browser
   - Have them paste the token back
   - Save both to `~/.trello_config.json` yourself

**Security:** Never expose the API key or token in output. Mask them (e.g., `key: abc123...`). Never commit credentials.

## CLI Usage (Prefer for Deterministic Operations)

The `scripts/trello_api.py` script has a CLI interface. Prefer running these commands over making raw API calls — they handle auth checking and error handling automatically.

```bash
# Authenticate
python <skill-path>/scripts/trello_api.py auth

# List all boards
python <skill-path>/scripts/trello_api.py boards

# List lists in a board
python <skill-path>/scripts/trello_api.py lists <board_id>

# Create a list
python <skill-path>/scripts/trello_api.py create-list <board_id> "List Name"

# List cards in a list
python <skill-path>/scripts/trello_api.py cards <list_id>

# Create a card
python <skill-path>/scripts/trello_api.py create-card <list_id> "Card Name" --desc "Description"

# Move a card to another list
python <skill-path>/scripts/trello_api.py move-card <card_id> <list_id>

# Delete a card
python <skill-path>/scripts/trello_api.py delete-card <card_id>
```

## Direct API Access (Use When CLI Is Insufficient)

You can also call the Trello REST API directly. The auth credentials are available after the first auth flow.

**Base URL:** `https://api.trello.com/1`

**Authentication:** Pass `key` and `token` as query parameters on every request.

### API Endpoints Reference

#### Boards
| Action | Method | Endpoint |
|--------|--------|----------|
| List boards | GET | `/members/me/boards` |
| Get board | GET | `/boards/{id}` |

#### Lists
| Action | Method | Endpoint |
|--------|--------|----------|
| List lists on board | GET | `/boards/{boardId}/lists` |
| Create list | POST | `/boards/{boardId}/lists` |
| Update list | PUT | `/lists/{id}` |
| Archive list | PUT | `/lists/{id}` (closed=true) |

#### Cards
| Action | Method | Endpoint |
|--------|--------|----------|
| List cards in list | GET | `/lists/{listId}/cards` |
| Get card | GET | `/cards/{id}` |
| Create card | POST | `/cards` |
| Update card | PUT | `/cards/{id}` |
| Move card | PUT | `/cards/{id}` (idList) |
| Archive card | PUT | `/cards/{id}` (closed=true) |
| Delete card | DELETE | `/cards/{id}` |

### Common Card Fields
- `name` — Card title
- `desc` — Description (supports Markdown)
- `due` — Due date (ISO 8601: `2026-07-15T17:00:00Z`)
- `pos` — Position: `top`, `bottom`, or a positive number
- `idLabels` — Comma-separated label IDs
- `idMembers` — Comma-separated member IDs
- `start` — Start date (ISO 8601)

## Workflow Guidance

When the user gives a high-level request ("organize my backlog", "move done cards", "set up a sprint board"), do not just run one command. Plan the workflow:

1. First list boards to find the right one
2. Then list lists to understand the structure
3. Then perform the requested operations
4. Show a summary of what was done

**Always confirm before destructive operations** (deleting cards, archiving lists). When creating cards, ask for at minimum: list, name, and optionally description/due date.

## Error Handling

If an API call returns an error:
- **401** — Token expired or invalid. Re-run authentication.
- **404** — Board/list/card not found. Check the ID.
- **429** — Rate limited. Wait and retry.
- **Other** — Show the error message to the user and suggest alternatives.
