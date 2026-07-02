#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# install.sh — Instala agentes, commands, skills e packs no .opencode/
#
# Uso: ./install.sh [<target-dir>]
#   <target-dir>   Diretório alvo (default: .opencode)
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

TARGET="${1:-.opencode}"
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
    cp "$f" "$dst/$(basename "$f")"
    convert_tools_to_permission "$dst/$(basename "$f")"
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

install_github() {
  local src="$1"
  local dst="$TARGET/.github"
  mkdir -p "$dst"
  cp -r "$src"/* "$dst/"
  ok ".github/ ($(find "$src" -type f | wc -l | tr -d ' ') arquivos)"
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

  echo ""
  ok "Instalação concluída!"
  echo ""
  info "Para verificar os arquivos instalados: ls -la $TARGET/"
}

main
