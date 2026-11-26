#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# install.sh — Instala agentes, commands, skills e packs no .opencode/
#
# Uso: ./install.sh [<target-dir>] [--no-rtk] [--rtk-edition full|oss] [--no-codegraph]
#   <target-dir>   Diretório alvo (default: .opencode)
#
# RTK: no fim da instalação, baixa o binário rtk (brew ou install.sh oficial)
# e vincula ao OpenCode com "rtk init --global --opencode" — proxy que comprime
# a saída de shell antes do LLM ler (economia de tokens). Falha em aberto.
# Durante a execução, o plugin rtk-visibility.ts marca cada comando reescrito
# com "⟐ rtk ✓" na saída — prova visível de que o proxy está rodando.
#
# CodeGraph + ast-grep: no fim da instalação, instala o CLI semântico codegraph
# (npm @colbymchenry/codegraph) e o ast-grep (brew/npm), registra o MCP codegraph
# no OpenCode ("opencode mcp add"), indexa o projeto ("codegraph init") e desliga
# a telemetria (CODEGRAPH_TELEMETRY=0). Falha em aberto.
#
# Detecta automaticamente a origem:
#   agents/       → .opencode/agents/       (com conversão tools→permission)
#   commands/     → .opencode/commands/
#   skills/       → .opencode/skills/       (com remoção de allowed-tools)
#   packs/        → .opencode/packs/
#   AGENTS.md     → .opencode/AGENTS.md
#
# Fontes alternativas detectadas:
#   .agents/      → .opencode/agents/       (conversão tools→permission)
#   .claude/      → .opencode/              (skills/, commands/, CLAUDE.md→AGENTS.md)
#   .github/      → .opencode/.github/      (cópia literal)
# =============================================================================

TARGET=".opencode"
RTK_ENABLED=1
RTK_EDITION="${RTK_EDITION:-full}"
CODEGRAPH_ENABLED=1
LAVISH_ENABLED=1
WITH_ARTIFACTS=0

usage() {
  echo "Uso: ./install.sh [<target-dir>] [--with-artifacts] [--no-rtk] [--rtk-edition full|oss] [--no-codegraph] [--no-lavish] [--no-acp]"
  echo "  <target-dir>           Diretório alvo (default: .opencode) — só usado com --with-artifacts"
  echo "  --with-artifacts       Também instala os artefatos da squad no alvo (default OFF: a instalação baixa"
  echo "                         SÓ a pilha ACP; artefatos e MCPs são instalados pelo TMR no run, para o"
  echo "                         harness escolhido no wizard)"
  echo "  --no-rtk               Não baixa nem vincula o rtk"
  echo "  --rtk-edition <full|>  Edição do rtk: full (padrão) ou oss (Apache-2.0)"
  echo "  --no-codegraph         Não instala codegraph/ast-grep"
  echo "  --no-lavish            Não instala o lavish-axi (revisão de planos HTML; cai para npx on-demand)"
  echo "  --no-acp               Não pré-baixa o adaptador codex-acp (client ACP vai com skills/)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-rtk)      RTK_ENABLED=0 ;;
    --rtk-edition) shift; RTK_EDITION="${1:-}"; case "$RTK_EDITION" in full|oss) ;; *) echo "✖ RTK: edição inválida ($RTK_EDITION) — use full ou oss" >&2; exit 1;; esac ;;
    --no-codegraph) CODEGRAPH_ENABLED=0 ;;
    --no-lavish) LAVISH_ENABLED=0 ;;
    --no-acp) ACP_ENABLED=0 ;;
    --with-artifacts) WITH_ARTIFACTS=1 ;;
    --help|-h)     usage; exit 0 ;;
    -*)            echo "Argumento desconhecido: $1 (veja ./install.sh --help)" >&2; exit 1 ;;
    *)             TARGET="$1" ;;
  esac
  shift
done
SRC_ROOT="$(cd "$(dirname "$0")" && pwd)"

info()   { printf "  \033[1;34m➜\033[0m %s\n" "$*"; }
ok()     { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
skip()   { printf "  \033[1;33m–\033[0m %s\n" "$*"; }
error()  { printf "  \033[1;31m✖\033[0m %s\n" "$*" >&2; }

# ── Detecção de fontes ──────────────────────────────────────────────────────

has_dir() {
  local d; d="$1"
  [ -d "$SRC_ROOT/$d" ] && return 0 || return 1
}

has_file() {
  local f; f="$1"
  [ -f "$SRC_ROOT/$f" ] && return 0 || return 1
}

# ── Funções de conversão ─────────────────────────────────────────────────────

convert_tools_to_permission() {
  local file="$1"
  command -v python3 >/dev/null 2>&1 || { error "python3 é necessário para conversão"; return 1; }
  python3 -c "
import sys, re

filepath = '$file'
with open(filepath, 'r') as f:
    content = f.read()

lines = content.splitlines(keepends=True)
result = []
in_fm = False
in_tools = False

for line in lines:
    if line.strip() == '---':
        if not in_fm:
            in_fm = True
        else:
            in_fm = False
            in_tools = False
        result.append(line)
        continue

    if not in_fm:
        result.append(line)
        continue

    raw = line
    stripped = line.strip()
    indent = len(line) - len(line.lstrip())

    if stripped == 'tools:':
        in_tools = True
        result.append(' ' * indent + 'permission:\n')
        continue

    if in_tools:
        if indent <= 0 and stripped:
            in_tools = False
            result.append(raw)
            continue

        if re.match(r'^\s*(write|read|search|notify|command):\s*(false|deny|no)\s*(#.*)?$', stripped):
            continue
        if re.match(r'^\s*(edit|bash|webfetch|task):\s*(false|deny|no)\s*(#.*)?$', stripped):
            continue
        if re.match(r'^\s*(webfetch|bash):\s*(true|yes)\s*(#.*)?$', stripped):
            tool_name = stripped.split(':')[0].strip()
            result.append(' ' * indent + tool_name + ': allow\n')
            continue

        result.append(raw)
        continue

    result.append(line)

with open(filepath, 'w') as f:
    f.writelines(result)
"
}

strip_allowed_tools() {
  local file="$1"
  if grep -q '^allowed-tools:' "$file" 2>/dev/null; then
    sed -i '' '/^allowed-tools:/d' "$file"
  fi
}

# ── Instalação ───────────────────────────────────────────────────────────────

install_agents() {
  local src="$1"
  local dst="$TARGET/agents"
  mkdir -p "$dst"
  local count=0
  for f in "$src"/*.agent.md; do
    [ -f "$f" ] || continue
    # opencode registers agents by filename (minus extension), so strip the
    # ".agent" suffix: "po-agent.agent.md" must install as "po-agent.md"
    local base
    base="$(basename "$f")"
    local target="${base%.agent.md}.md"
    cp "$f" "$dst/$target"
    convert_tools_to_permission "$dst/$target"
    count=$((count + 1))
  done
  ok "agents ($count arquivos de $src → $dst)"
}

install_commands() {
  local src="$1"
  local dst="$TARGET/commands"
  mkdir -p "$dst"
  local count=0
  shopt -s nullglob
  for f in "$src"/*.prompt.md "$src"/*.cmd.md; do
    [ -f "$f" ] || continue
    cp "$f" "$dst/$(basename "$f")"
    count=$((count + 1))
  done
  shopt -u nullglob
  [ "$count" -gt 0 ] && ok "commands ($count arquivos)" || skip "commands: nenhum arquivo encontrado"
}

install_skills() {
  local src="$1"
  local dst="$TARGET/skills"
  mkdir -p "$dst"
  local count=0
  for skill_dir in "$src"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    cp -r "$skill_dir" "$dst/$skill_name"
    strip_allowed_tools "$dst/$skill_name/SKILL.md"
    count=$((count + 1))
  done
  ok "skills ($count pacotes)"
}

install_packs() {
  local src="$1"
  local dst="$TARGET/packs"
  mkdir -p "$dst"
  local count=0
  for pack_dir in "$src"/*/; do
    [ -d "$pack_dir" ] || continue
    cp -r "$pack_dir" "$dst/$(basename "$pack_dir")"
    count=$((count + 1))
  done
  ok "packs ($count pacotes)"
}

install_agents_md() {
  local src="$1"
  cp "$src" "$TARGET/AGENTS.md"
  ok "AGENTS.md"
}

install_plugins() {
  local src="$1"
  local dst="$TARGET/plugins"
  mkdir -p "$dst"
  local count=0
  shopt -s nullglob
  for f in "$src"/*.ts "$src"/*.js; do
    [ -f "$f" ] || continue
    cp "$f" "$dst/$(basename "$f")"
    count=$((count + 1))
  done
  shopt -u nullglob
  [ "$count" -gt 0 ] && ok "plugins ($count arquivos)" || skip "plugins: nenhum arquivo encontrado"
}

# caminho físico real (resolve symlink e "../"); vazio se o diretório não existe
realdir() {
  (cd "$1" 2>/dev/null && pwd -P) || true
}

install_hooks() {
  local src="$1"
  local dst="$TARGET/hooks"
  local src_real; src_real="$(realdir "$src")"
  mkdir -p "$dst"
  local count=0
  shopt -s nullglob
  for f in "$src"/*.py "$src"/*.sh "$src"/*.md; do
    [ -f "$f" ] || continue
    cp "$f" "$dst/$(basename "$f")"
    [[ "$f" == *.py || "$f" == *.sh ]] && chmod +x "$dst/$(basename "$f")" 2>/dev/null || true
    count=$((count + 1))
  done
  shopt -u nullglob
  # também espelha em <target>/hooks quando TARGET é .opencode (para fallback Claude/Codex)
  # pula quando o destino físico é a própria fonte (install dentro do repo do módulo)
  if [[ "$TARGET" == *.opencode ]]; then
    local alt="$(dirname "$TARGET")/hooks"
    if [ "$(realdir "$alt")" != "$src_real" ]; then
      mkdir -p "$alt"
      shopt -s nullglob
      for f in "$src"/*.py "$src"/*.sh "$src"/*.md; do
        [ -f "$f" ] || continue
        cp "$f" "$alt/$(basename "$f")"
        [[ "$f" == *.py || "$f" == *.sh ]] && chmod +x "$alt/$(basename "$f")" 2>/dev/null || true
      done
      shopt -u nullglob
    fi
  fi
  # .opencode/hooks também precisa quando TARGET não é .opencode (ex: .claude)
  if [[ "$TARGET" != *.opencode ]] && [ -d "$SRC_ROOT/hooks" ]; then
    if [ "$(realdir ".opencode/hooks")" != "$src_real" ]; then
      mkdir -p ".opencode/hooks"
      shopt -s nullglob
      for f in "$SRC_ROOT"/hooks/*.py "$SRC_ROOT"/hooks/*.sh "$SRC_ROOT"/hooks/*.md; do
        [ -f "$f" ] || continue
        cp "$f" ".opencode/hooks/$(basename "$f")"
        [[ "$f" == *.py || "$f" == *.sh ]] && chmod +x ".opencode/hooks/$(basename "$f")" 2>/dev/null || true
      done
      shopt -u nullglob
    fi
  fi
  [ "$count" -gt 0 ] && ok "hooks ($count scripts python)" || skip "hooks: nenhum script encontrado"
}

install_github() {
  local src="$1"
  local dst="$TARGET/.github"
  mkdir -p "$dst"
  cp -r "$src"/* "$dst/"
  ok ".github/ ($(find "$src" -type f | wc -l | tr -d ' ') arquivos)"
}

# ── RTK: baixa o binário e vincula ao OpenCode ────────────────────────────────
# https://github.com/rtk-ai/rtk — proxy de comandos que comprime a saída de shell
# antes do LLM ler (economia de 60–90% nos tokens de bash). Falha em aberto:
# sem o binário, a squad segue funcionando sem compressão.

# ── Lavish Editor: revisão de planos HTML pelo browser ───────────────────────
# lavish-axi (npm) — abre o plano do planner como HTML interativo no browser
# local e devolve o feedback do usuário por long-poll (skill plan-review).
# Também é um AXI: se não instalar, os macros usam `npx -y lavish-axi` on-demand.
# Falha em aberto: sem o CLI, os macros caem no npx e a squad segue funcionando.

# ── ACP: client da squad + adaptador Codex ───────────────────────────────────
# O client ACP é zero-dep (scripts/acp_client.mjs + acp_orchestrate.mjs) e já
# acompanha skills/ no alvo instalado. Aqui só (a) confirmamos que os scripts
# existem e (b) pré-baixamos o adaptador oficial do Codex
# (@agentclientprotocol/codex-acp — npm), para o primeiro run codex não pagar
# o download on-demand. Falha em aberto: sem o adaptador, `npx -y` baixa ao vivo.
# O bootstrap de deps (lavish/codegraph/rtk/opencode) roda a cada run ACP.

ACP_ENABLED=1

install_acp_stack_only() {
  # scripts do client vivem no próprio pacote/repo (SRC_ROOT) — sem TARGET
  if [ -f "$SRC_ROOT/skills/acp-client/scripts/acp_orchestrate.mjs" ]; then
    ok "scripts do client ACP presentes (acp_client.mjs + acp_orchestrate.mjs)"
  else
    error "skills/acp-client não encontrado em $SRC_ROOT — pacote incompleto"
    return 1
  fi
  ensure_npm || return 1
  if command -v codex-acp >/dev/null 2>&1; then
    ok "adaptador codex-acp já instalado ($(codex-acp --version 2>/dev/null || echo '?'))"
  else
    info "pré-baixando adaptador Codex (@agentclientprotocol/codex-acp)…"
    if npm install -g @agentclientprotocol/codex-acp >/dev/null 2>&1 && command -v codex-acp >/dev/null 2>&1; then
      ok "codex-acp instalado — primeiro run com --agent codex não precisa de download"
    else
      error "npm install -g @agentclientprotocol/codex-acp falhou — o primeiro run codex usará 'npx -y' on-demand"
      return 1
    fi
  fi
}

install_acp() {
  # scripts do client: fonte (repo) ou alvo instalado
  if [ -f "$TARGET/skills/acp-client/scripts/acp_orchestrate.mjs" ] || \
     [ -f "skills/acp-client/scripts/acp_orchestrate.mjs" ]; then
    ok "scripts do client ACP presentes (acp_client.mjs + acp_orchestrate.mjs)"
  else
    error "skills/acp-client não encontrado nem na fonte nem no alvo — reinstale a squad"
    return 1
  fi

  ensure_npm || return 1
  if command -v codex-acp >/dev/null 2>&1; then
    ok "adaptador codex-acp já instalado ($(codex-acp --version 2>/dev/null || echo '?'))"
  else
    info "pré-baixando adaptador Codex (@agentclientprotocol/codex-acp)…"
    if npm install -g @agentclientprotocol/codex-acp >/dev/null 2>&1 && command -v codex-acp >/dev/null 2>&1; then
      ok "codex-acp instalado — primeiro run com --agent codex não precisa de download"
    else
      error "npm install -g @agentclientprotocol/codex-acp falhou — o primeiro run codex usará 'npx -y' on-demand"
      return 1
    fi
  fi
}

install_lavish() {
  ensure_npm || return 1
  if command -v lavish-axi >/dev/null 2>&1; then
    ok "lavish-axi já instalado ($(lavish-axi --version 2>/dev/null || echo versão desconhecida))"
    return 0
  fi
  info "lavish-axi ausente — instalando (npm install -g lavish-axi)…"
  if npm install -g lavish-axi >/dev/null 2>&1 && command -v lavish-axi >/dev/null 2>&1; then
    ok "lavish-axi instalado ($(lavish-axi --version 2>/dev/null || echo '?')) — skill plan-review pronta"
  else
    error "npm install -g lavish-axi falhou — skill plan-review usará 'npx -y lavish-axi' on-demand (AXI, sem install)"
    return 1
  fi
}

# ── RTK: download + vínculo com o harness (economia de tokens) ───────────────

install_rtk() {
  if command -v rtk >/dev/null 2>&1; then
    ok "rtk já instalado ($(rtk --version 2>/dev/null || echo versão desconhecida))"
  else
    info "RTK ausente — baixando edição ${RTK_EDITION}..."
    if command -v brew >/dev/null 2>&1; then
      if [ "$RTK_EDITION" = "oss" ]; then
        brew install rtk-ai/tap/rtk-oss
      else
        brew install rtk
      fi
    else
      sh -c "export RTK_EDITION=${RTK_EDITION}; curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh"
    fi
  fi

  if ! command -v rtk >/dev/null 2>&1; then
    error "rtk não ficou disponível no PATH (ex.: instalado em ~/.local/bin) — squad segue sem compressão; rode ./install.sh novamente com o PATH ajustado"
    return 1
  fi

  rtk init --global --opencode || { error "rtk init --global --opencode falhou — consulte 'rtk init --help'"; return 1; }
  ok "RTK vinculado ao OpenCode (plugin em ~/.config/opencode/plugins/rtk.ts) — reinicie o OpenCode e acompanhe com 'rtk gain'"
  ok "Visibilidade: rtk-visibility.ts marca comandos reescritos com '⟐ rtk ✓'; observability-visibility.ts marca skills/codegraph/hooks (OBSERVABILITY_VISIBILITY=0 desliga só esses marcadores)"
}

# ── CodeGraph + ast-grep: instala os CLIs e vincula o MCP ao OpenCode ────────
# CodeGraph (github.com/colbymchenry/codegraph) — índice semântico do repositório
# exposto como MCP (`codegraph serve --mcp`); ast-grep — busca estrutural de
# sintaxe (AST). Mesma filosofia do RTK: baixa os binários, vincula ao harness
# e indexa o projeto. Falha em aberto: sem os binários, a squad segue funcionando
# só com leitura de arquivos.
# Telemetria do codegraph fica desligada (CODEGRAPH_TELEMETRY=0) por padrão.

CODEGRAPH_NPM_PKG="@colbymchenry/codegraph"
AST_GREP_NPM_PKG="@ast-grep/cli"

npm_latest_version() {
  command -v npm >/dev/null 2>&1 || return 1
  npm view "$1" version 2>/dev/null || return 1
}

ensure_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    error "npm não encontrado no PATH — necessário para o CodeGraph; instale Node.js e rode ./install.sh novamente"
    return 1
  fi
}

install_codegraph_cli() {
  if command -v codegraph >/dev/null 2>&1; then
    ok "codegraph já instalado ($(codegraph --version 2>/dev/null || echo versão desconhecida))"
    return 0
  fi
  ensure_npm || return 1
  local version
  version="$(npm_latest_version "$CODEGRAPH_NPM_PKG")" || {
    error "não foi possível resolver a versão estável de $CODEGRAPH_NPM_PKG (npm view falhou — rede?) — squad segue sem CodeGraph"
    return 1
  }
  info "CodeGraph ausente — instalando $CODEGRAPH_NPM_PKG@$version (npm global, versão exata)..."
  npm install -g "$CODEGRAPH_NPM_PKG@$version" || {
    error "npm install -g $CODEGRAPH_NPM_PKG falhou — squad segue sem CodeGraph"
    return 1
  }
  command -v codegraph >/dev/null 2>&1 || {
    error "codegraph não ficou disponível no PATH após a instalação — squad segue sem CodeGraph"
    return 1
  }
  ok "codegraph instalado ($(codegraph --version 2>/dev/null || echo versão desconhecida))"
}

install_ast_grep() {
  if command -v ast-grep >/dev/null 2>&1 || command -v sg >/dev/null 2>&1; then
    ok "ast-grep já instalado ($(ast-grep --version 2>/dev/null || sg --version 2>/dev/null || echo versão desconhecida))"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    info "ast-grep ausente — instalando via brew (ast-grep)..."
    if brew install ast-grep >/dev/null 2>&1 && command -v ast-grep >/dev/null 2>&1; then
      ok "ast-grep instalado via brew ($(ast-grep --version 2>/dev/null | head -1))"
      return 0
    fi
    skip "brew install ast-grep falhou — tentando npm antes de desistir"
  fi
  ensure_npm || return 1
  local version
  version="$(npm_latest_version "$AST_GREP_NPM_PKG")" || {
    error "não foi possível resolver a versão estável de $AST_GREP_NPM_PKG — squad segue sem ast-grep"
    return 1
  }
  info "instalando $AST_GREP_NPM_PKG@$version (npm global)..."
  npm install -g "$AST_GREP_NPM_PKG@$version" || {
    error "npm install -g $AST_GREP_NPM_PKG falhou — squad segue sem ast-grep"
    return 1
  }
  command -v ast-grep >/dev/null 2>&1 || {
    error "ast-grep não ficou disponível no PATH — squad segue sem ast-grep"
    return 1
  }
  ok "ast-grep instalado ($(ast-grep --version 2>/dev/null | head -1))"
}

# Registra o MCP codegraph no OpenCode do projeto (equivalente do 'rtk init'
# para o codegraph): tenta a CLI nativa e cai para merge manual no opencode.json.
bind_codegraph_mcp() {
  local project_root="$1"
  if command -v opencode >/dev/null 2>&1; then
    if (cd "$project_root" && opencode mcp add codegraph --env CODEGRAPH_TELEMETRY=0 -- codegraph serve --mcp >/dev/null 2>&1); then
      ok "MCP codegraph registrado no OpenCode do projeto ('opencode mcp list' para conferir)"
      return 0
    fi
    skip "opencode mcp add falhou — tentando merge manual no opencode.json"
  fi
  command -v python3 >/dev/null 2>&1 || { error "python3 ausente — não consigo escrever o opencode.json; registre manualmente"; return 1; }
  python3 - "$project_root" <<'PYEOF'
import json, pathlib, sys

root = pathlib.Path(sys.argv[1])
target = root / "opencode.json"
server = {
    "type": "local",
    "command": ["codegraph", "serve", "--mcp"],
    "environment": {"CODEGRAPH_TELEMETRY": "0"},
}

if not target.exists():
    target.write_text(json.dumps({"$schema": "https://opencode.ai/config.json", "mcp": {"servers": {"codegraph": server}}}, indent=2) + "\n")
    print("  opencode.json criado com o MCP codegraph")
    sys.exit(0)

try:
    config = json.loads(target.read_text())
except Exception as exc:
    print(f"  ✖ opencode.json não é JSON puro ({exc}) — registre o MCP manualmente", file=sys.stderr)
    sys.exit(1)

servers = config.setdefault("mcp", {}).setdefault("servers", {})
if "codegraph" in servers and servers["codegraph"].get("type") == "local":
    print("  MCP codegraph já registrado no opencode.json")
else:
    servers["codegraph"] = server
    target.write_text(json.dumps(config, indent=2) + "\n")
    print("  opencode.json atualizado com o MCP codegraph")
PYEOF
}

# Índice semântico do projeto + .gitignore (estado gerado, nunca versionado)
init_codegraph_index() {
  local project_root="$1"
  if command -v git >/dev/null 2>&1 && git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! grep -qs '^\.codegraph/\?$' "$project_root/.gitignore" 2>/dev/null; then
      printf '\n# CodeGraph (índice semântico gerado)\n.codegraph/\n' >> "$project_root/.gitignore"
      ok ".codegraph/ adicionado ao .gitignore (índice é estado gerado)"
    fi
  fi
  info "Construindo índice semântico do projeto (codegraph init, telemetria desligada)..."
  if CODEGRAPH_TELEMETRY=0 codegraph init "$project_root" >/dev/null 2>&1; then
    ok "índice criado em $project_root/.codegraph/"
  else
    skip "codegraph init falhou — rode 'CODEGRAPH_TELEMETRY=0 codegraph init' manualmente; a squad funciona sem o índice"
  fi
}

install_codegraph() {
  install_codegraph_cli || return 1
  install_ast_grep || return 1
  bind_codegraph_mcp "$PROJECT_ROOT"
  init_codegraph_index "$PROJECT_ROOT"
  ok "CodeGraph + ast-grep prontos — semantic scope via MCP codegraph, evidência estrutural via 'ast-grep' (skill: codegraph-ast-grep)"
}

# ACP-only: só os CLIs — o MCP codegraph e o índice são configurados pelo TMR
# no momento da execução (precisam do harness escolhido no wizard).
install_codegraph_stack() {
  install_codegraph_cli || return 1
  install_ast_grep || return 1
  ok "CodeGraph + ast-grep instalados (MCP e índice serão configurados pelo TMR no run)"
}

install_claude() {
  local src="$1"
  # CLAUDE.md → AGENTS.md
  if [ -f "$src/CLAUDE.md" ]; then
    cp "$src/CLAUDE.md" "$TARGET/AGENTS.md"
    ok "CLAUDE.md → AGENTS.md"
  else
    skip "CLAUDE.md: não encontrado"
  fi
  # .claude/skills/ (com remoção de allowed-tools)
  if [ -d "$src/skills" ]; then
    local dst="$TARGET/skills"
    mkdir -p "$dst"
    local count=0
    for skill_dir in "$src/skills"/*/; do
      [ -d "$skill_dir" ] || continue
      skill_name=$(basename "$skill_dir")
      cp -r "$skill_dir" "$dst/$skill_name"
      strip_allowed_tools "$dst/$skill_name/SKILL.md"
      count=$((count + 1))
    done
    ok "skills ($count pacotes)"
  else
    skip "skills: não encontrado em .claude/"
  fi
  # .claude/commands/
  if [ -d "$src/commands" ]; then
    local dst="$TARGET/commands"
    mkdir -p "$dst"
    local count=0
    for f in "$src/commands"/*.md; do
      [ -f "$f" ] || continue
      cp "$f" "$dst/$(basename "$f")"
      count=$((count + 1))
    done
    [ "$count" -gt 0 ] && ok "commands ($count arquivos)" || skip "commands: nenhum .md encontrado"
  else
    skip "commands: não encontrado em .claude/"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  info "Instalando módulo sdd-commons em $TARGET/"
  echo ""

  PROJECT_ROOT="$(pwd)"

  # ── Modo ACP-only (default): a instalação baixa APENAS a pilha ACP ─────
  # Os artefatos da squad (agents/skills/commands/hooks/plugins) são instalados
  # pelo TMR no momento da execução, para o harness escolhido no wizard.
  if [ "$WITH_ARTIFACTS" = "0" ]; then
    info "Modo ACP-only — instalando apenas a pilha ACP (artefatos viram com o TMR: sdd-acp)"
    echo ""
    if [ "$RTK_ENABLED" = "1" ]; then install_rtk || true; else skip "RTK: pulado (--no-rtk)"; fi
    if [ "$CODEGRAPH_ENABLED" = "1" ]; then install_codegraph_stack || true; else skip "CodeGraph: pulado (--no-codegraph)"; fi
    if [ "$LAVISH_ENABLED" = "1" ]; then install_lavish || true; else skip "Lavish: pulado (--no-lavish)"; fi
    if [ "$ACP_ENABLED" = "1" ]; then install_acp_stack_only || true; else skip "ACP: pulado (--no-acp)"; fi
    echo ""
    ok "Pilha ACP pronta! Os artefatos da squad (agents/skills/hooks/plugins) e os MCPs"
    info "são instalados no harness escolhido quando você roda:"
    echo ""
    info "  sdd-acp        (wizard TMR — também faz os downloads do run)"
    info "  sdd-acp doctor (diagnóstico)"
    echo ""
    return 0
  fi

  mkdir -p "$TARGET"

  # Priority 1: agents/ (formato opencode nativo)
  if has_dir "agents"; then
    install_agents "$SRC_ROOT/agents"
  elif has_dir ".agents"; then
    install_agents "$SRC_ROOT/.agents"
  else
    skip "agents: diretório não encontrado"
  fi

  # ── Determinar modo de instalação ──────────────────────────────────────
  # Se .claude/ existir, instala a partir dele (e pula fontes regulares)
  if has_dir ".claude"; then
    install_claude "$SRC_ROOT/.claude"
  else
    # Commands
    if has_dir "commands"; then
      install_commands "$SRC_ROOT/commands"
    else
      skip "commands: diretório não encontrado"
    fi

    # Skills
    if has_dir "skills"; then
      install_skills "$SRC_ROOT/skills"
    else
      skip "skills: diretório não encontrado"
    fi

    # Packs
    if has_dir "packs"; then
      install_packs "$SRC_ROOT/packs"
    else
      skip "packs: diretório não encontrado"
    fi

    # Plugins (hooks determinísticos)
    if has_dir "plugins"; then
      install_plugins "$SRC_ROOT/plugins"
    else
      skip "plugins: diretório não encontrado"
    fi

    # Hooks python (guard rails + supervisor)
    if has_dir "hooks"; then
      install_hooks "$SRC_ROOT/hooks"
    else
      skip "hooks: diretório não encontrado"
    fi

    # AGENTS.md
    if has_file "AGENTS.md"; then
      install_agents_md "$SRC_ROOT/AGENTS.md"
    else
      skip "AGENTS.md: não encontrado"
    fi
  fi

  # .github/ (cópia literal — maintém workflows mesmo vindo de .claude/)
  if has_dir ".github"; then
    install_github "$SRC_ROOT/.github"
  fi

  # Hooks/Plugins mesmo quando .claude/ existe (são sempre necessários)
  if has_dir ".claude" && has_dir "plugins" && [ ! -d "$TARGET/plugins" ]; then
    install_plugins "$SRC_ROOT/plugins"
  fi
  if has_dir ".claude" && has_dir "hooks" && [ ! -d "$TARGET/hooks" ]; then
    install_hooks "$SRC_ROOT/hooks"
  fi

  # Garante .opencode/package.json com @opencode-ai/plugin para plugins tipados
  if [ -d "$SRC_ROOT/plugins" ] && [ -f "$TARGET/plugins/guard-rails.ts" ]; then
    local pkg_file="$TARGET/package.json"
    if [ ! -f "$pkg_file" ]; then
      echo '{"dependencies":{"@opencode-ai/plugin":"^1.17.11"}}' | python3 -m json.tool > "$pkg_file"
      ok ".opencode/package.json (criado com @opencode-ai/plugin)"
    elif ! grep -q "@opencode-ai/plugin" "$pkg_file"; then
      python3 -c "
import json, pathlib
p = pathlib.Path('$pkg_file')
j = json.loads(p.read_text())
j.setdefault('dependencies', {})['@opencode-ai/plugin'] = '^1.17.11'
p.write_text(json.dumps(j, indent=2) + '\n')
"
      ok ".opencode/package.json (atualizado com @opencode-ai/plugin)"
    fi
  fi

  # RTK: download + vínculo com o harness (economia de tokens)
  if [ "$RTK_ENABLED" = "1" ]; then
    install_rtk || true
  else
    skip "RTK: pulado (--no-rtk)"
  fi

  # CodeGraph + ast-grep: CLIs semânticos + MCP codegraph no OpenCode + índice do projeto
  if [ "$CODEGRAPH_ENABLED" = "1" ]; then
    install_codegraph || true
  else
    skip "CodeGraph: pulado (--no-codegraph)"
  fi

  # Lavish: revisão de planos HTML pelo browser (skill plan-review)
  if [ "$LAVISH_ENABLED" = "1" ]; then
    install_lavish || true
  else
    skip "Lavish: pulado (--no-lavish)"
  fi

  # ACP: client da squad (scripts) + pré-download do adaptador Codex
  if [ "$ACP_ENABLED" = "1" ]; then
    install_acp || true
  else
    skip "ACP: pulado (--no-acp)"
  fi

  echo ""
  ok "Instalação concluída!"
  echo ""
  info "Para verificar os arquivos instalados: ls -la $TARGET/"
  info "Hooks determinísticos: .opencode/plugins/guard-rails.ts (pós-edição) + supervisor.ts (final) → Ver hooks/README.md"
  info "RTK: comandos reescritos aparecem com '⟐ rtk ✓' na saída (economia acumulada: rtk gain); skills/codegraph/hooks aparecem com marcadores ⟐ no transcript"
  info "CodeGraph: MCP 'codegraph' ativo no projeto — 'opencode mcp list' para conferir; ast-grep para busca estrutural"
  info "ACP: rode 'sdd-acp' (se instalado via npm) ou 'node $TARGET/skills/acp-client/scripts/acp_orchestrate.mjs' — wizard interativo: harness → .planning → issue gh → modelos por agente → fases (use --ui lavish para os quadros no browser)"
}

main
