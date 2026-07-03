# Technology Stack

**Analysis Date:** 2026-07-03

## Languages

**Primary:**
- Markdown — All agent definitions (`agents/*.agent.md`), skills (`skills/*/SKILL.md`), and command prompts (`commands/*.prompt.md`)
- YAML — Pack configuration (`packs/agentic-squad/apm.yml`)
- JSON — Lock file (`skills-lock.json`), opencode config (`.opencode/opencode.json`)
- Shell — Install script (`install.sh`), Bash

**Secondary (referenced in skills for target projects):**
- TypeScript — Referenced extensively in skills for frontend/backend code generation (`skills/nextjs-react-typescript/SKILL.md`, `skills/typescript-expert/SKILL.md`)
- Python — Referenced in `skills/webapp-testing/SKILL.md` (Playwright) and `skills/trello-manager/SKILL.md`
- SQL — Referenced in `skills/supabase-postgres-best-practices/SKILL.md` (Postgres queries, RLS, schema design)
- JavaScript — Referenced across frontend skills for React/Next.js patterns

## Runtime

**Environment:**
- Node.js — Required by `.opencode/` local tooling (`.opencode/package.json` declares `@opencode-ai/plugin` as dependency)
- Python 3 — Required by `install.sh` for frontmatter conversion (`convert_tools_to_permission`), and by skills (`webapp-testing`, `trello-manager`)

**Package Manager:**
- npm — `.opencode/package-lock.json` present
- Lockfile: present (`.opencode/package-lock.json`)

## Frameworks

**Agent Framework:**
- opencode — Primary target platform. Artifacts format uses `opencode.json`, `.agent.md` with `permission:` frontmatter, `skills/`, `commands/`, `packs/` directory structure
- Claude Code (legacy) — Install script (`install.sh`) also supports `.claude/` source directories, converting `tools:` → `permission:` frontmatter

**Frontend (documented in skills for target projects):**
- Next.js 14+ App Router — Extensive skill coverage (`skills/nextjs-app-router-patterns/SKILL.md`, `skills/nextjs-supabase-auth/SKILL.md`, `skills/nextjs-react-typescript/SKILL.md`)
- React 19 — Server Components, Client Components, hooks patterns (`skills/react-best-practices/SKILL.md`)
- Shadcn UI / Radix UI — Referenced in `skills/nextjs-react-typescript/SKILL.md`
- Tailwind CSS — Referenced as primary styling approach

**Backend (documented in skills for target projects):**
- Supabase — Full coverage: database, auth, storage, Edge Functions, RLS (`skills/supabase-postgres-best-practices/SKILL.md`, `skills/nextjs-supabase-auth/SKILL.md`, `agents/supabase-specialist.agent.md`)
- Clerk — Authentication patterns for Next.js (`skills/clerk-nextjs-patterns/SKILL.md`)

**Testing:**
- Playwright (Python) — Web application testing (`skills/webapp-testing/SKILL.md`)

**Design/Architecture (documented in skills):**
- Clean Architecture — Layer separation, Dependency Rule, ports & adapters (`skills/clean-architecture/SKILL.md`)
- SOLID Principles — Professional software engineering practices (`skills/solid/SKILL.md`)
- Clean Code — Naming, functions, comments, code smells (`skills/clean-code/SKILL.md`)

## Key Dependencies

**Critical (opencode infrastructure):**
- `@opencode-ai/plugin` v1.17.11 — Plugin dependency for runtime (`.opencode/package.json`)

**Referenced Technologies (in skills for generated/analyzed projects):**
- `@supabase/ssr` — Server-side rendering auth client (referenced in `skills/nextjs-supabase-auth/SKILL.md`)
- `@clerk/nextjs` — Clerk Next.js SDK (referenced in `skills/clerk-nextjs-patterns/SKILL.md`)
- `swr` — React data fetching with deduplication (referenced in `skills/react-best-practices/SKILL.md`)
- `nuqs` — URL search parameter state management (referenced in `skills/nextjs-react-typescript/SKILL.md`)
- `next/script`, `next/dynamic` — Next.js optimization patterns (referenced in skills)
- `lru-cache` — Cross-request caching for server-side data (referenced in skill patterns)
- `zod` — Input validation for Server Actions (referenced in skill patterns)
- `better-all` — Dependency-based parallelization utility (referenced in skill patterns)

## Configuration

**Environment:**
- No `.env` files present
- Skills reference environment variables for target projects:
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk publishable key (`skills/clerk-nextjs-patterns/SKILL.md`)
  - `CLERK_SECRET_KEY` — Clerk secret key
  - `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL (`skills/nextjs-supabase-auth/SKILL.md`)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key
  - `VERCEL_TOKEN` — Vercel deployment token (`skills/vercel-cli-with-tokens/SKILL.md`)

**Build:**
- `install.sh` — Shell script for installing agents, commands, skills, packs into target `.opencode/` directory
- `.opencode/opencode.json` — opencode permissions configuration (read + external_directory for get-shit-done)
- `.opencode/package.json` — npm dependency declaration

**Secrets:**
- `skills/trello-manager/SKILL.md` references `~/.trello_config.json` for Trello API key/token storage
- No secrets committed to repository

## Platform Requirements

**Development:**
- opencode-compatible editor/CLI for authoring
- Bash shell for `install.sh`
- Python 3 for frontmatter conversion and skill scripts

**Production (target deployment platforms documented in skills):**
- Vercel — Deployment platform (`skills/deploy-to-vercel/SKILL.md`, `agents/vercel-deploy.agent.md`, `agents/vercel-infra.agent.md`)
- Supabase — BaaS platform (database, auth, storage, functions)
- GitHub Actions — CI/CD pipeline (`skills/github-actions-docs/SKILL.md`)

---

*Stack analysis: 2026-07-03*
