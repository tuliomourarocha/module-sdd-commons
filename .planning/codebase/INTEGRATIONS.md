# External Integrations

**Analysis Date:** 2026-07-03

## APIs & External Services

**Authentication Services:**
- **Supabase Auth** — Authentication provider for target projects
  - SDK: `@supabase/ssr`, `@supabase/supabase-js`
  - Coverage: `skills/nextjs-supabase-auth/SKILL.md` (313 lines), `agents/supabase-specialist.agent.md`
  - Auth methods: email/password, OAuth providers, magic link
  - Config: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

- **Clerk** — Next.js authentication middleware and SDK
  - SDK: `@clerk/nextjs`, `@clerk/nextjs/server`
  - Coverage: `skills/clerk-nextjs-patterns/SKILL.md` (252 lines)
  - Auth methods: `auth()` server-side, `useAuth()` client-side, middleware strategies
  - Config: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
  - Compatibility: SDK version >= 2.x

**Project Management:**
- **Trello REST API** — Board, list, card management
  - Coverage: `skills/trello-manager/SKILL.md` (133 lines)
  - Auth: API Key + Token, stored in `~/.trello_config.json`
  - Auth URL: `https://trello.com/1/authorize`
  - Endpoints used: boards, lists, cards CRUD

**Deployment:**
- **Vercel Platform** — Application deployment and hosting
  - CLI: `vercel` (npm package)
  - Coverage: `skills/deploy-to-vercel/SKILL.md` (296 lines), `skills/vercel-cli-with-tokens/SKILL.md` (353 lines), `agents/vercel-deploy.agent.md`, `agents/vercel-infra.agent.md`
  - Auth: Token-based (`VERCEL_TOKEN` env var) or interactive login
  - Config: `vercel.json` (framework, rewrites, headers, redirects, regions, cron jobs)
  - Deploy types: preview (per branch) and production (main/tag)
  - Team support via `--scope` flag

- **Vercel MCP** — Configured via `packs/agentic-squad/apm.yml`:
  ```yaml
  mcp:
    supabase:
      type: remote
      url: https://mcp.supabase.com/mcp?project_ref=evrwkvxjjmljvbbgistd&features=database%2Cdevelopment%2Caccount%2Cstorage%2Cfunctions%2Cdocs
      enabled: true
  ```

**CI/CD:**
- **GitHub Actions** — Workflow automation
  - Coverage: `skills/github-actions-docs/SKILL.md` (98 lines)
  - Topics: workflow syntax, triggers, matrices, runners, reusable workflows, artifacts, caching, secrets, OIDC, deployments
  - Referenced tools: `gh` CLI for PR/issue/workflow management

**Git Operations:**
- **GitHub CLI (`gh`)** — Terminal-based GitHub operations
  - Coverage: `skills/github-cli/SKILL.md` (135 lines)
  - Operations: PR creation/review/merge, issues, labels, milestones, workflow management, branches, releases

**Diagramming:**
- **Mermaid.js** — Text-based diagram generation
  - Coverage: `skills/mermaid-diagrams/SKILL.md` (217 lines), `skills/design-doc-mermaid/SKILL.md` (498 lines)
  - Diagram types: class, sequence, flowchart, ERD, C4, state, Gantt, git graph, pie, quadrant
  - Python utilities for diagram extraction and image conversion

**Testing:**
- **Playwright (Python)** — Browser automation for web application testing
  - Coverage: `skills/webapp-testing/SKILL.md` (96 lines)
  - Helper script: `scripts/with_server.py` for server lifecycle management

## Data Storage

**Databases (documented for target projects):**
- **PostgreSQL** (via Supabase) — Primary database for target applications
  - Coverage: `skills/supabase-postgres-best-practices/SKILL.md` (64 lines + reference files)
  - Topics: query performance, connection management, RLS, schema design, indexes, concurrency, monitoring
  - RLS policies for row-level security
  - Edge Functions for serverless SQL operations

**File Storage:**
- **Supabase Storage** — Bucket and file management
  - Coverage: `agents/supabase-specialist.agent.md` references storage capabilities
  - Features: buckets, file upload/download, access policies, CDN delivery

**Caching:**
- **In-memory LRU cache** — Pattern referenced in `skills/react-best-practices/SKILL.md` for cross-request caching
  - Library: `lru-cache` (npm package)
  - Use case: server-side data caching with TTL between sequential requests
- **React.cache()** — Per-request deduplication pattern
- **SWR** — Client-side caching and revalidation pattern (`skills/react-best-practices/SKILL.md`)

## Authentication & Identity

**Auth Providers Covered:**
| Provider | Implementation | Skill/Agent |
|----------|---------------|-------------|
| Supabase Auth | `@supabase/ssr` server/client clients, cookie-based sessions, RLS integration | `skills/nextjs-supabase-auth/SKILL.md`, `agents/supabase-specialist.agent.md` |
| Clerk | `@clerk/nextjs` middleware, `auth()` server function, `useAuth()` client hook, org/role-based auth | `skills/clerk-nextjs-patterns/SKILL.md` |
| Custom (via JWT) | Manual JWT verification with `CLERK_JWT_KEY` or `CLERK_PEM_PUBLIC_KEY` | `skills/clerk-nextjs-patterns/SKILL.md` |

## Monitoring & Observability

**Error Tracking:**
- Not covered by any agent or skill in this module

**Logging:**
- Not covered as a dedicated topic (referenced only in skill patterns as `after()` for non-blocking response logging)

## CI/CD & Deployment

**Hosting:**
- **Vercel** — Primary deployment target with full agent/skill coverage
  - 3 dedicated agents: `agents/vercel-deploy.agent.md`, `agents/vercel-infra.agent.md`, `agents/ci-cd-specialist.agent.md`
  - 3 dedicated skills: `skills/deploy-to-vercel/SKILL.md`, `skills/vercel-cli-with-tokens/SKILL.md`, `skills/github-actions-docs/SKILL.md`
- **Supabase** — Backend hosting (database, auth, functions, storage)

**CI Pipeline:**
- **GitHub Actions** — Workflow creation and management
  - Coverage via `skills/github-actions-docs/SKILL.md`
  - Agent: `agents/ci-cd-specialist.agent.md`

## Environment Configuration

**Required env vars (for target projects using covered technologies):**
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk publishable key
- `CLERK_SECRET_KEY` — Clerk secret key
- `VERCEL_TOKEN` — Vercel access token (CI/CD deployments)

**Secrets location:**
- `~/.trello_config.json` — Trello API credentials (JSON with `api_key` and `token`)
- Environment variables — Clerk, Supabase, Vercel tokens
- No secrets stored in repository

## Webhooks & Callbacks

**Incoming:**
- Not covered by any agent or skill in this module

**Outgoing:**
- Not covered by any agent or skill in this module

## APM (Agent Package Manager) Integration

**Pack:**
- `packs/agentic-squad/apm.yml` — Single pack definition for installing the full agent squad
- 73 dependencies across all artifact types (agents, commands, skills)
- Requires `apm` tool for installation
- Post-install script guides Supabase MCP authentication

## Knowledge Base / External References

**Skills that reference external documentation sources:**
- `skills/github-actions-docs/SKILL.md` — Official GitHub docs (`docs.github.com/en/actions`)
- `skills/react-best-practices/SKILL.md` — Vercel blog, React docs, Next.js docs
- `skills/supabase-postgres-best-practices/SKILL.md` — Supabase documentation

---

*Integration audit: 2026-07-03*
