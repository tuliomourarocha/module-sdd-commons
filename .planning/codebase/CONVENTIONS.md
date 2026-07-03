# Coding Conventions

**Analysis Date:** 2026-07-03

## Overview

This project is a **skill/agent configuration repository** for opencode. It defines coding conventions and patterns that AI agents apply when working on target projects. There is no application source code (`src/`) in this repo — the conventions are encoded in agent definitions (`agents/`), skills (`skills/`), and command prompts (`commands/`).

The project itself uses **Markdown (.md)** as its primary authoring format for agent files, skill files, and command prompts, plus **TypeScript** in skill reference files and templates.

## Project-Language Convention

**Rule:** All agent, skill, and command documentation is written in **Portuguese** unless the product context requires English.

**Source:** `AGENTS.md` rule #3: *"Idioma — Padrão português para artefatos, salvo contexto do produto exigir inglês."*

**Observed pattern:** Agent descriptions, rules, validation hooks, and response formats are in Portuguese (`agents/frontend-dev.agent.md`, `agents/backend-dev.agent.md`, `agents/unit-tester.agent.md`). English is used for skills sourced from the community (`skills/clean-code/SKILL.md`, `skills/react-best-practices/`).

## Naming Patterns

**Files:**
- Agent files: `kebab-case.agent.md` — e.g., `unit-tester.agent.md`, `code-reviewer-backend.agent.md`, `frontend-dev.agent.md`
- Skill files: `SKILL.md` (convention, uppercase) in each skill directory — e.g., `skills/caveman/SKILL.md`, `skills/solid/SKILL.md`
- Command prompts: `kebab-case.prompt.md` — e.g., `qa-prompt.prompt.md`, `backend-prompt.prompt.md`
- Skill references: `kebab-case.md` — e.g., `references/dependency-rule.md`, `rules/bundle-barrel-imports.md`
- Pack configs: `kebab-case/` directory naming — e.g., `packs/agentic-squad/`
- Utility types reference: `utility-types.ts`
- Template files: Named descriptively — e.g., `nextjs-basic-auth/proxy.ts`

**Directories:**
- `agents/` — Agent definitions (25 agents)
- `commands/` — Detailed prompts and templates
- `skills/` — Loadable skills (26 skills)
- `packs/` — APM pack configurations
- `.opencode/` — opencode configuration (hidden)

## Code Style (as prescribed by skills)

This project does not have its own lint/format config files (no `.eslintrc`, `.prettierrc`, `biome.json`, or `tsconfig.json` at root). Instead, it *prescribes* the following conventions for target projects:

### General TypeScript Style (from `skills/typescript-expert/SKILL.md`)

**Strict mode required:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true
  }
}
```

**Patterns:**
- No implicit `any` types — use `unknown` or proper types
- Type assertions (`as`) must be justified and minimal
- Prefer `interface` over `type` for object shapes (better error messages)
- Use `const` assertions for literal types
- Leverage type guards and predicates
- Branded types for domain primitives (`Brand<K, T>` pattern)
- Discriminated unions for error handling
- Return types explicitly declared for public APIs

**Import styles:**
- Prefer statically analyzable paths over dynamic imports
- Avoid barrel file imports (direct imports only)
- Consistent import/export patterns
- No circular dependencies
- ESM-first: `"type": "module"` in package.json, `"moduleResolution": "bundler"`

### Clean Code Style (from `skills/clean-code/SKILL.md`)

**Functions:**
- Small! Functions should be <20 lines
- Do One Thing — a function should do only one thing
- One level of abstraction per function
- Descriptive names: `isPasswordValid` better than `check`
- 0-2 arguments ideal; 3+ needs strong justification
- No side effects — functions shouldn't secretly change global state

**Naming (from `skills/solid/SKILL.md`):**
1. **Consistency** — Same concept = same name everywhere
2. **Understandability** — Domain language, not technical jargon
3. **Specificity** — Precise, not vague (avoid `data`, `info`, `manager`)
4. **Brevity** — Short but not cryptic
5. **Searchability** — Unique, greppable names

**Classes (from `skills/solid/SKILL.md`):**
- Single Responsibility Principle (SRP) — one reason to change
- <50 lines for classes, <10 lines for methods
- No more than two instance variables per class
- One level of indentation per method
- No `else` keyword when possible (use early returns)
- No more than one dot per line (Law of Demeter)

### SOLID Architecture Style (from `skills/solid/SKILL.md`)

**Mandatory patterns for domain code:**
| Principle | Application |
|-----------|-------------|
| **SRP** | One class = one responsibility |
| **OCP** | Extend by adding code, not modifying existing |
| **LSP** | Subtypes must be usable through base interface |
| **ISP** | Split fat interfaces into role interfaces |
| **DIP** | Depend on abstractions, not concretions |

**Value Objects mandatory for domain primitives:**
```typescript
// ALWAYS create value objects for:
class UserId { constructor(private readonly value: string) {} }
class Email { constructor(private readonly value: string) { /* validate */ } }
class Money { constructor(private readonly amount: number, private readonly currency: string) {} }
class OrderId { constructor(private readonly value: string) {} }

// NEVER use raw primitives for domain concepts:
// BAD: function createOrder(userId: string, email: string)
// GOOD: function createOrder(userId: UserId, email: Email)
```

### React / Next.js Style (from `skills/react-best-practices/AGENTS.md`)

**Component patterns (from `commands/frontend-prompt.prompt.md`):**

**Server Component (default):**
```tsx
interface ProductListProps {
  categoryId: string
}

export async function ProductList({ categoryId }: ProductListProps) {
  const products = await fetchProductsByCategory(categoryId)
  return (
    <ul>
      {products.map(product => (
        <ProductCard key={product.id} product={product} />
      ))}
    </ul>
  )
}
```

**Client Component (only when needed):**
```tsx
'use client'
import { useState, useTransition } from 'react'

interface SearchInputProps {
  onSearch: (query: string) => Promise<void>
}

export function SearchInput({ onSearch }: SearchInputProps) {
  const [query, setQuery] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      await onSearch(query)
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={query} onChange={e => setQuery(e.target.value)} disabled={isPending} />
    </form>
  )
}
```

**Key React rules (from `agents/code-reviewer-frontend.agent.md`):**
- Server first: avoid unnecessary `'use client'`
- Data fetching on the server, not client
- Dynamic imports for heavy components (code splitting)
- `useMemo`/`useCallback`/`memo` where necessary
- Props typed with `interface` (not `type`)
- Error boundaries for loading/error states
- `next/image` with width/height, lazy loading

## Error Handling (as prescribed)

**Patterns from `skills/typescript-expert/SKILL.md` and `skills/clean-code/SKILL.md`:**

1. **Use Exceptions instead of Return Codes** — Keeps logic clean
2. **Write Try-Catch-Finally First** — Defines scope of operation
3. **Don't Return Null** — Forces caller to check null every time
4. **Don't Pass Null** — Leads to null pointer errors
5. **Custom Error Classes with proper inheritance:**
   ```typescript
   class DomainError extends Error {
     constructor(
       message: string,
       public code: string,
       public statusCode: number
     ) {
       super(message);
       this.name = 'DomainError';
       Error.captureStackTrace(this, this.constructor);
     }
   }
   ```
6. **Result types or discriminated unions for errors** (from `skills/typescript-expert/references/utility-types.ts`):
   ```typescript
   type Result<T, E = Error> =
     | { success: true; data: T }
     | { success: false; error: E }
   ```
7. **Exhaustive switch cases with `never` type**:
   ```typescript
   export function assertNever(value: never, message?: string): never {
     throw new Error(message ?? `Unexpected value: ${value}`)
   }
   ```

**Backend error strategy (from `commands/backend-prompt.prompt.md`):**
- Domain errors are specific exception classes, not generic ones
- Input validated at the boundary (API Route / Controller) using Zod
- Custom error classes in `src/shared/errors/`
- API validation uses `z.safeParse()` for structured error responses

## Logging

**From skills:**
- No specific logging framework is prescribed for target projects
- `skills/solid/SKILL.md` advocates for dependency injection, so logging should be injected as a dependency
- `skills/clean-code/SKILL.md` says to use exceptions over return codes, implying structured error logging

## Comments

**From `skills/clean-code/SKILL.md`:**
- **Don't Comment Bad Code — Rewrite It** — Most comments are a sign of failure to express in code
- **Explain Yourself in Code**: Prefer expressive code over comments
- **Good Comments**: Legal, Informative (regex intent), Clarification (external libraries), TODOs
- **Bad Comments**: Mumbling, Redundant, Misleading, Mandated, Noise, Position Markers

## Module Design

**From `skills/backend-prompt.prompt.md` recommended structure:**
```
src/
├── domain/          # entities, value-objects, events, services
├── application/     # use-cases, ports (interfaces), dto
├── infrastructure/  # persistence, http, messaging
├── presentation/    # api (controllers, middleware, validators), server-actions
├── config/          # DI Container, env vars (composition root)
└── shared/          # errors, types, utils
```

**Export patterns:**
- **Dependency Rule**: Inner circles define interfaces; outer circles implement
- **Repository interfaces** defined in the domain/application layer, implementation in infrastructure
- **Use Cases** accept Request Models and return Response Models — never framework objects
- **Composition Root** centralized in `config/container.ts` — not DI sprinkled everywhere
- **Value Objects** co-located with domain concepts

## Agent-Specific Conventions

**File format for agent definitions (`agents/*.agent.md`):**

Every agent file follows a strict YAML front-matter + Markdown body structure:

```yaml
---
description: <role description>
mode: primary | subagent
model: opencode-go/<model-name>
temperature: <0.0-1.0>
max_steps: <number>        # primary agents only
hidden: true | false       # subagents only
tools:
  edit:                    # glob-based permissions
    "pattern": allow|deny
  bash:                    # command permissions
    "command": allow|deny
  webfetch: true | false
  write: true | false
  task:
    "agent-name": allow|deny
---
```

**Required sections for agent files:**
1. **Shared State** — Skills to load at startup
2. Role description (title + one-line summary)
3. **Especialidades** (for subagents) / **Orchestration Workflow** (for primary agents)
4. **Regras** (numbered rules, prescriptive)
5. **Validation Hooks** (checklist with `[ ]`)
6. **Response Format** (what to output on success/failure)
7. **Subagent Authorization** (for primary agents)

**Commit convention (from `skills/git-commit/SKILL.md`):**
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```
Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- One logical change per commit
- Present tense, imperative mood
- Description under 72 characters

---

*Convention analysis: 2026-07-03*
