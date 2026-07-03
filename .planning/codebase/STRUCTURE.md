# Codebase Structure

**Analysis Date:** 2026-07-03

## Directory Layout

```
module-sdd-commons/
├── .opencode/                      # Installed opencode configuration (target)
│   ├── .gsd-profile                # GSD profile mode ("full")
│   ├── get-shit-done/              # GSD system: contexts, references, templates, workflows
│   │   ├── bin/
│   │   ├── contexts/
│   │   ├── references/
│   │   ├── templates/
│   │   ├── workflows/
│   │   └── VERSION
│   ├── hooks/                      # GSD validation & monitoring hooks (12 JS/SH files)
│   ├── agents/                     # Agent definitions (populated by install.sh)
│   ├── command/                    # Command prompts (populated by install.sh)
│   ├── node_modules/               # Frontend dependencies
│   ├── opencode.json               # opencode config (read/external_directory permissions)
│   ├── package.json
│   ├── package-lock.json
│   └── settings.json
├── .planning/                      # Planning artifacts
│   └── codebase/                   # Codebase map documents (this file)
├── agents/                         # [Source] Agent definitions (25 files)
│   ├── techlead.agent.md
│   ├── frontend-dev.agent.md
│   ├── backend-dev.agent.md
│   ├── po-agent.agent.md
│   ├── devops-infra.agent.md
│   ├── qa-engineer.agent.md
│   ├── architecture-reviewer.agent.md
│   ├── react-expert.agent.md
│   ├── nextjs-expert.agent.md
│   ├── supabase-specialist.agent.md
│   ├── code-reviewer-frontend.agent.md
│   ├── code-reviewer-backend.agent.md
│   ├── code-reviewer-general.agent.md
│   ├── code-reviewer-infra.agent.md
│   ├── ui-reviewer.agent.md
│   ├── unit-tester.agent.md
│   ├── e2e-tester.agent.md
│   ├── api-tester.agent.md
│   ├── bug-reporter.agent.md
│   ├── linter.agent.md
│   ├── ci-cd-specialist.agent.md
│   ├── vercel-infra.agent.md
│   ├── vercel-deploy.agent.md
│   ├── prd-writer.agent.md
│   └── requirements-reviewer.agent.md
├── commands/                       # [Source] Detailed prompt templates (7 files)
│   ├── techlead-prompt.prompt.md
│   ├── frontend-prompt.prompt.md
│   ├── backend-prompt.prompt.md
│   ├── devops-prompt.prompt.md
│   ├── po-prompt.prompt.md
│   ├── qa-prompt.prompt.md
│   └── PRD.prompt.md
├── skills/                         # [Source] Reusable knowledge packages (25 skills)
│   ├── caveman/                    # Ultra-compressed communication
│   ├── caveman-review/             # Ultra-compressed code review
│   ├── clean-architecture/         # Clean Architecture principles + 6 references
│   ├── clean-code/                 # Clean Code best practices
│   ├── clerk-nextjs-patterns/      # Clerk auth + Next.js patterns + 5 references
│   ├── deploy-to-vercel/           # Vercel deployment guide
│   ├── design-doc-mermaid/         # Design docs with Mermaid diagrams
│   ├── find-skills/                # Skill discovery agent
│   ├── frontend-design/            # Frontend design principles
│   ├── git-commit/                 # Conventional commits workflow
│   ├── github-actions-docs/        # GitHub Actions documentation + references
│   ├── github-cli/                 # GitHub CLI usage guide
│   ├── mermaid-diagrams/           # Mermaid diagram types + 6 references
│   ├── nextjs-app-router-patterns/ # Next.js App Router patterns + references
│   ├── nextjs-react-typescript/    # Next.js + React + TypeScript setup
│   ├── nextjs-supabase-auth/       # Next.js + Supabase auth integration
│   ├── po-assistant/               # Product Owner assistant frameworks
│   ├── react-best-practices/       # React performance + 70+ rule files
│   ├── solid/                      # SOLID principles + 8 references
│   ├── supabase-postgres-best-practices/ # Supabase/Postgres + 30+ references
│   ├── trello-manager/             # Trello API integration
│   ├── typescript-expert/          # TypeScript advanced types + references
│   ├── typescript-react-reviewer/  # TS/React review patterns + references
│   ├── vercel-cli-with-tokens/     # Vercel CLI token management
│   └── webapp-testing/             # Web app testing with Playwright
├── packs/                          # [Source] APM distribution packs
│   └── agentic-squad/              # Full squad pack (83-line apm.yml)
│       └── apm.yml
├── AGENTS.md                       # Global rules for all agents (18 lines)
├── README.md                       # Project documentation (51 lines)
├── install.sh                      # Installation script (292 lines)
├── skills-lock.json                # Skill version lock file
└── .gitkeep                        # (in skills/)
```

## Directory Purposes

**`agents/` (Source — 25 files):**
- Purpose: Agent definitions that declare roles, permissions, skills, workflows, and subagent authorizations
- Contains: `.agent.md` files with YAML frontmatter + Markdown behavioral body
- Key files: `techlead.agent.md`, `frontend-dev.agent.md`, `backend-dev.agent.md`, `po-agent.agent.md`, `qa-engineer.agent.md` (primary orchestrators); `architecture-reviewer.agent.md`, `react-expert.agent.md` (specialized subagents)

**`commands/` (Source — 7 files):**
- Purpose: Detailed behavioral prompts and templates that agents reference via progressive disclosure
- Contains: `.prompt.md` files with Mermaid diagrams, code templates, checklists
- Key files: `techlead-prompt.prompt.md` (322 lines — largest command), `PRD.prompt.md`, `frontend-prompt.prompt.md`

**`skills/` (Source — 25 packages):**
- Purpose: Modular domain knowledge packages, each self-contained with SKILL.md + optional references
- Contains: Subdirectories named by domain; each has `SKILL.md` and optional `references/` with deep-dive Markdown
- Key packages: `react-best-practices/` (70+ rule files), `supabase-postgres-best-practices/` (30+ references), `clean-architecture/` (6 references), `mermaid-diagrams/` (6 references)

**`packs/` (Source — 1 pack):**
- Purpose: APM distribution manifests that bundle agents, commands, and skills into installable packs
- Contains: `apm.yml` files with dependency declarations
- Key files: `packs/agentic-squad/apm.yml`

**`.opencode/` (Target — installed):**
- Purpose: Runtime configuration for the opencode tool, populated by `install.sh`
- Contains: GSD system (`get-shit-done/`), validation hooks (`hooks/`), installed agents/commands/skills, opencode config
- Key files: `.opencode/opencode.json` (permissions), `.opencode/.gsd-profile` (profile mode)

**`.opencode/get-shit-done/` (GSD System):**
- Purpose: GSD (Get Shit Done) workflow engine — contexts, references, templates, and workflows for task execution
- Contains: `bin/` (executables), `contexts/` (context definitions), `references/` (reference files), `templates/` (templates), `workflows/` (workflow definitions)

**`.opencode/hooks/` (12 files):**
- Purpose: Validation and monitoring hooks that guard agent operations
- Contains: JS and shell scripts for commit validation, session state, status line, context monitoring, prompt guarding, and update checking

## Key File Locations

**Global Rules:**
- `AGENTS.md`: Global rules applied to all agents (progressive disclosure, autossuficiência, idioma português)

**Installation:**
- `install.sh`: Single-entry installer script (292 lines)

**Agent Definitions (Primary):**
- `agents/techlead.agent.md`: Tech Lead — orchestrates the entire squad
- `agents/frontend-dev.agent.md`: Frontend development orchestrator
- `agents/backend-dev.agent.md`: Backend development orchestrator
- `agents/po-agent.agent.md`: Product Owner — discovery, PRD, backlog
- `agents/devops-infra.agent.md`: DevOps — CI/CD, Vercel, secrets
- `agents/qa-engineer.agent.md`: QA — Playwright, API tests, bug reporting

**Agent Definitions (Subagent):**
- `agents/architecture-reviewer.agent.md`: Architecture review (subagent, hidden)
- `agents/react-expert.agent.md`: React expertise (subagent)
- `agents/nextjs-expert.agent.md`: Next.js expertise (subagent)
- `agents/supabase-specialist.agent.md`: Supabase/DB ops (subagent)
- `agents/code-reviewer-general.agent.md`: General multi-layer code review (subagent, hidden)
- `agents/code-reviewer-frontend.agent.md`: Frontend code review (subagent)
- `agents/code-reviewer-backend.agent.md`: Backend code review (subagent)
- `agents/code-reviewer-infra.agent.md`: Infrastructure code review (subagent)
- `agents/unit-tester.agent.md`: Unit test writing (subagent)
- `agents/e2e-tester.agent.md`: E2E test writing (subagent)
- `agents/api-tester.agent.md`: API test writing (subagent)
- `agents/linter.agent.md`: Lint/type-check runner (subagent)
- `agents/ci-cd-specialist.agent.md`: CI/CD workflow specialist (subagent)
- `agents/vercel-infra.agent.md`: Vercel infrastructure config (subagent)
- `agents/vercel-deploy.agent.md`: Vercel deployment executor (subagent)
- `agents/ui-reviewer.agent.md`: UI/UX review (subagent)
- `agents/bug-reporter.agent.md`: Bug reporting (subagent)
- `agents/prd-writer.agent.md`: PRD writing (subagent)
- `agents/requirements-reviewer.agent.md`: Requirements review (subagent)

**Command Prompts:**
- `commands/techlead-prompt.prompt.md`: Architecture templates, code review checklists, refinement templates
- `commands/frontend-prompt.prompt.md`: Frontend development detailed behavior
- `commands/backend-prompt.prompt.md`: Backend development detailed behavior
- `commands/devops-prompt.prompt.md`: DevOps detailed workflow
- `commands/po-prompt.prompt.md`: PO detailed frameworks
- `commands/qa-prompt.prompt.md`: QA detailed workflow
- `commands/PRD.prompt.md`: PRD writing template

**Largest Skill Packages:**
- `skills/react-best-practices/`: 70+ individual rule files in `rules/` directory
- `skills/supabase-postgres-best-practices/`: 30+ reference files in `references/`
- `skills/solid/`: 8 reference files
- `skills/typescript-expert/`: 3 reference files + TypeScript utility types

**Configuration:**
- `.opencode/opencode.json`: opencode permissions (read + external_directory for GSD)
- `.opencode/.gsd-profile`: Profile mode setting ("full")
- `skills-lock.json`: Version-locked skill sources

## Naming Conventions

**Files:**
- Agent definitions: `{role-name}.agent.md` (kebab-case) — e.g., `code-reviewer-frontend.agent.md`
- Command prompts: `{role-name}-prompt.prompt.md` (kebab-case) — e.g., `techlead-prompt.prompt.md`
- Skill directories: `{domain-name}/` (kebab-case) — e.g., `clean-architecture/`, `typescript-expert/`
- Skill content files: `SKILL.md` (always uppercase), `README.md`
- Skill reference files: `{topic-name}.md` (kebab-case) — e.g., `dependency-rule.md`, `solid-principles.md`
- React best practice rules: `{category}-{rule-name}.md` (kebab-case) — e.g., `rerender-memo.md`, `async-parallel.md`
- Pack manifest: `apm.yml` (always lowercase)
- GSD files: Various naming conventions within `.opencode/get-shit-done/`

**Directories:**
- Source artifact directories are plurals: `agents/`, `commands/`, `skills/`, `packs/`
- Skill subdirectories use singular kebab-case: `caveman/`, `clean-architecture/`, `solid/`
- Reference directories within skills: `references/`
- Rule directories within skills: `rules/` (react-best-practices)

**Frontmatter Fields:**
- Agent mode: `primary` or `subagent`
- Agent visibility: `hidden: true` for subagents not meant for direct user invocation
- Models: `opencode-go/qwen3.7-plus` (orchestrators), `opencode-go/deepseek-v4-flash` (subagents/lighter tasks)
- Temperature: `0.15` (tech lead/architecture), `0.2` (developers), `0.3` (PO), `0.05` (reviewers), `0.0` (linter)

## Where to Add New Code

**New Agent:**
- Primary code: `agents/{role-name}.agent.md`
- Guideline: Must stay under 200 lines; use `---` YAML frontmatter for mode, model, permissions, task auth
- Pattern: Copy from `agents/techlead.agent.md` or `agents/frontend-dev.agent.md`
- Subagents should be `mode: subagent` and `hidden: true`

**New Detailed Prompt for Existing Agent:**
- Primary code: `commands/{role-name}-prompt.prompt.md`
- Guideline: Include templates, checklists, Mermaid diagrams where relevant

**New Skill Package:**
- Implementation: `skills/{domain-name}/SKILL.md`
- Guidelines: Follow existing skill format — description in frontmatter, content sections, "Common Mistakes" table, "Quick Diagnostic" table
- Optional references: Add to `skills/{domain-name}/references/`

**New APM Pack:**
- Implementation: `packs/{pack-name}/apm.yml`
- Guideline: List all agent, command, and skill dependencies; include MCP config and post-install scripts if needed

**New React Best Practice Rule:**
- Implementation: `skills/react-best-practices/rules/{category}-{rule-name}.md`
- Guideline: Follow the pattern in `skills/react-best-practices/rules/_template.md`

**New Supabase/Postgres Reference:**
- Implementation: `skills/supabase-postgres-best-practices/references/{topic-name}.md`
- Guideline: Follow existing reference format from that directory

## Special Directories

**`.opencode/`:**
- Purpose: Installed configuration target for the opencode runtime
- Generated: Yes (by `install.sh` or APM)
- Committed: Yes (lockfile tracks what's installed)

**`.opencode/get-shit-done/`:**
- Purpose: GSD workflow engine (contexts, references, templates, workflows)
- Generated: Partially (some content may be installed)
- Committed: Yes

**`.opencode/hooks/`:**
- Purpose: Validation and monitoring hooks for GSD
- Generated: Yes (installed by GSD system)
- Committed: Yes

**`.planning/codebase/`:**
- Purpose: Codebase analysis documents consumed by GSD planning tools
- Generated: Yes (by `/gsd-map-codebase` command)
- Committed: Yes

---

*Structure analysis: 2026-07-03*
