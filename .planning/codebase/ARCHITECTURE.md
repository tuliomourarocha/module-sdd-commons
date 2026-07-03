<!-- refreshed: 2026-07-03 -->
# Architecture

**Analysis Date:** 2026-07-03

## System Overview

This repository (`module-sdd-commons`) is a **central registry for AI agent artifacts** — agents, skills, commands, and packs — designed to be installed into target projects via `install.sh` or APM (Agent Package Manager). It is not an application runtime; it is a **content distribution system** for opencode-based development workflows.

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     Source Repository (module-sdd-commons)           │
├──────────────────┬──────────────────┬──────────────────┬────────────┤
│   agents/        │   commands/      │   skills/        │   packs/   │
│  25 .agent.md    │  7 .prompt.md    │  25 skill pkgs   │  1 pack    │
└────────┬─────────┴────────┬─────────┴─────────┬────────┴─────┬──────┘
         │                  │                   │              │
         ▼                  ▼                   ▼              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    install.sh (detect → copy → convert)             │
│  - tools: → permission: conversion (Python3)                        │
│  - allowed-tools: removal from SKILL.md                              │
│  - Source detection: agents/, .agents/, .claude/, .github/          │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  Target: .opencode/ in any project                   │
│  .opencode/agents/    .opencode/commands/   .opencode/skills/       │
│  .opencode/packs/     .opencode/AGENTS.md   .opencode/.github/      │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File(s) |
|-----------|----------------|---------|
| `agents/` | Agent definitions in Markdown frontmatter format — describe role, permissions, loaded skills, subagent authorizations, validation hooks | `agents/*.agent.md` |
| `commands/` | Detailed behavioral prompts referenced by agents (progressive disclosure pattern) | `commands/*.prompt.md` |
| `skills/` | Reusable knowledge packages — each with `SKILL.md` and optional `references/` directory of detailed guides | `skills/*/SKILL.md` |
| `packs/` | APM packaging manifests declaring which artifacts belong to a named pack | `packs/*/apm.yml` |
| `AGENTS.md` | Global rules applied to all agents operating in this project context | `AGENTS.md` |
| `install.sh` | Single-entry installer — detects source artifacts, copies to target `.opencode/`, performs format conversions | `install.sh` |
| `.opencode/` | Installed output — mirrors the source structure for opencode runtime consumption | `.opencode/` |

## Pattern Overview

**Overall:** Agent Orchestration with Progressive Disclosure

**Key Characteristics:**
- **Orchestrator pattern** — Primary agents (TechLead, FrontendDev, BackendDev, DevopsInfra, PO, QA) delegate specialized work to subagents via `task` permission
- **Progressive disclosure** — Agent definitions (`agents/`) are concise (<200 lines) with core rules; detailed behavior lives in `commands/` prompt files
- **Skill injection** — Agents load skills dynamically (`Load **caveman** skill`); skills provide domain expertise as modular plug-in knowledge
- **APM distribution** — `packs/` declare dependencies for the Agent Package Manager, enabling declarative installation
- **Single installer** — `install.sh` handles all source formats (`agents/`, `.agents/`, `.claude/`, `.github/`) and converts them to opencode format

## Layers

**Agent Layer:**
- Purpose: Define AI agent behavior, permissions, skills to load, and subagent delegation rules
- Location: `agents/`
- Contains: 25 `.agent.md` files with YAML frontmatter + Markdown body
- Depends on: Skills (via `Load` directives), Commands (via progressive disclosure references)
- Used by: opencode runtime; invoked by user or orchestrated by other agents

**Command Layer:**
- Purpose: Detailed behavioral prompts, templates, and workflow reference for agents
- Location: `commands/`
- Contains: 7 `.prompt.md` files with architecture templates, code review checklists, refinement templates
- Depends on: Nothing (consumed by agents who reference them)
- Used by: Primary agents for detailed behavior

**Skill Layer:**
- Purpose: Reusable domain knowledge packages — architecture patterns, best practices, tool usage guides
- Location: `skills/` (25 skill directories)
- Contains: Each skill has `SKILL.md` + optional `references/` directory with deep-dive docs
- Depends on: Nothing (self-contained knowledge)
- Used by: Agents via `Load` directive

**Pack Layer:**
- Purpose: Declarative bundling of agents, commands, and skills into distribution packs
- Location: `packs/`
- Contains: `apm.yml` manifest files listing artifact URLs
- Depends on: APM tooling for installation
- Used by: Developers installing the pack via `apm install agentic-squad`

## Data Flow

### Installation Flow

1. **User runs** `./install.sh [target-dir]` (`install.sh`)
2. **install.sh detects sources** — checks for `agents/`, `.agents/`, `.claude/`, `.github/` (`install.sh:238-283`)
3. **Copies agents** from `agents/` → `target/agents/`, applying `tools:` → `permission:` conversion via Python3 (`install.sh:117-129`)
4. **Copies commands** from `commands/` → `target/commands/` (`install.sh:131-144`)
5. **Copies skills** from `skills/` → `target/skills/`, stripping `allowed-tools:` lines from `SKILL.md` (`install.sh:146-159`)
6. **Copies packs** from `packs/` → `target/packs/` (`install.sh:161-172`)
7. **Copies AGENTS.md** to target root (`install.sh:174-178`)
8. **Installed artifacts** are now consumable by opencode at runtime

### Agent Delegation Flow (at runtime)

1. **Primary Agent** receives a user request (e.g., TechLead gets "implement feature X")
2. **Primary Agent** loads skills from its `## Shared State` section (e.g., caveman, mermaid-diagrams, git-commit)
3. **Primary Agent** delegates specialized work via `task` permission to subagents (e.g., `architecture-reviewer`, `code-reviewer-general`)
4. **Subagents** complete their specialized analysis and return results
5. **Primary Agent** synthesizes subagent outputs and produces final artifact
6. **Validation hooks** in the agent definition are run before finalizing

**State Management:**
- No persistent runtime state — artifacts are static files
- Runtime orchestration happens entirely within the opencode session
- Shared state between agents is communicated via `task` subagent calls

## Key Abstractions

**Agent Definition (`.agent.md`):**
- Purpose: Declarative + behavioral specification for an AI agent
- Examples: `agents/techlead.agent.md`, `agents/frontend-dev.agent.md`, `agents/po-agent.agent.md`
- Pattern: YAML frontmatter (description, mode, model, temperature, max_steps, permission, tools) + Markdown body (role, shared state, workflow, validation hooks, rules, subagent authorization)

**Skill Package (`skills/*/`):**
- Purpose: Self-contained domain knowledge module
- Examples: `skills/clean-architecture/`, `skills/react-best-practices/`, `skills/supabase-postgres-best-practices/`
- Pattern: `SKILL.md` (main content + scoring criteria + quick diagnostic) + optional `references/` directory with deep-dive Markdown files

**Command Prompt (`.prompt.md`):**
- Purpose: Detailed behavioral reference that agents can use for progressive disclosure
- Examples: `commands/techlead-prompt.prompt.md`, `commands/frontend-prompt.prompt.md`
- Pattern: Markdown document with templates, workflow steps, checklists, and diagrams

**Pack Manifest (`apm.yml`):**
- Purpose: Declarative pack definition for APM installation
- Example: `packs/agentic-squad/apm.yml`
- Pattern: YAML with `name`, `version`, `description`, `targets`, `dependencies` (listing agent, command, and skill paths), `mcp` server configs, `scripts`

**Primary vs Subagent (`mode` field):**
- `mode: primary` — User-facing agent that orchestrates work. Has `task` permissions to call subagents.
- `mode: subagent` — Internal specialist agent, usually `hidden: true`. Has restricted permissions (often `write: false`, `edit: false`).

## Entry Points

**Installation Entry Point:**
- Location: `install.sh`
- Triggers: Explicit user execution (`./install.sh [target-dir]`)
- Responsibilities: Detect sources, copy artifacts, perform format conversions, output status

**Agent Runtime Entry Points:**
- Location: `agents/*.agent.md`
- Triggers: User invokes agent by name in opencode (e.g., `/agent techlead`)
- Responsibilities: Execute the agent's defined workflow, load skills, delegate to subagents, produce outputs

**Pack Installation Entry Point:**
- Location: `packs/agentic-squad/apm.yml`
- Triggers: `apm install agentic-squad`
- Responsibilities: Fetches all declared dependencies from the module registry and installs them

## Architectural Constraints

- **Threading:** Not applicable — this is a static content repository, not a runtime application
- **Global state:** `AGENTS.md` acts as shared global rules applied to all agents; each agent carries its own self-contained rules
- **Circular imports:** Agents reference commands and skills unidirectionally (agents → commands, agents → skills). No circular dependency chains exist.
- **Progressive disclosure constraint:** Agent files must remain under 200 lines; detailed behavior belongs in `commands/` prompts
- **Format compatibility:** `install.sh` must handle both opencode native format (`tools:` → `permission:`) and Claude Code format (`.claude/` directory structure)
- **Maximum agent line count:** 200 lines per agent file (`AGENTS.md:7`)

## Anti-Patterns

### tools: → permission: Leakage

**What happens:** Agent `.agent.md` files use the deprecated `tools:` frontmatter field instead of `permission:`.
**Why it's wrong:** Opencode uses `permission:` for tool access control; `tools:` is a Claude Code format that is incompatible.
**Do this instead:** All new agents MUST use `permission:` format (e.g., `agents/techlead.agent.md:7-22`). The `install.sh` script converts `tools:` → `permission:` automatically during installation (`install.sh:45-106`), but source files should be maintained in modern format.

### allowed-tools: in SKILL.md

**What happens:** Some `SKILL.md` files contain an `allowed-tools:` frontmatter field.
**Why it's wrong:** Opencode does not understand `allowed-tools:` in skill definitions.
**Do this instead:** The `install.sh` script strips `allowed-tools:` lines during skill installation (`install.sh:108-113`). Source `SKILL.md` files should not use `allowed-tools:`.

### Hardcoded Tools in Subagents

**What happens:** Subagent definitions (e.g., `agents/architecture-reviewer.agent.md:8-15`) still use `tools:` frontmatter instead of `permission:`.
**Why it's wrong:** This is the Claude Code format and will not work correctly with opencode.
**Do this instead:** Convert all agent files to use `permission:` frontmatter at source. The `install.sh` conversion is a fallback, not a permanent solution.

## Error Handling

**Strategy:** Validation hooks embedded in each agent definition. Agents validate against checklists at each workflow stage before proceeding.

**Patterns:**
- **Pre-flight validation hooks** — Agents list `## Validation Hooks` with checkboxes; they must pass before finalization (e.g., `agents/techlead.agent.md:117-126`)
- **Progressive disclosure** — If behavior details are missing, the agent reads the referenced command file for full prompts
- **Subagent fallback** — If a primary agent cannot resolve a technical decision, it must consult a subagent before proceeding (mandated by rules)

## Cross-Cutting Concerns

**Logging:** Not applicable — agents handle their own output within the opencode session
**Validation:** Each agent has its own `## Validation Hooks` section with task-specific checklists
**Authentication:** Not applicable at this repository level; authentication is handled by the target project's Supabase/Clerk configuration via installed skills

---

*Architecture analysis: 2026-07-03*
