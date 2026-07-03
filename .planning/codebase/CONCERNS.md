# Codebase Concerns

**Analysis Date:** 2026-07-03

## Tech Debt

### Root `.gitignore` Missing

**Issue:** The repository root has no `.gitignore`, causing untracked build artifacts and runtime state to appear in `git status`. The `.opencode/` (293+ generated files) and `.planning/` directories show as untracked. A `.gitignore` exists only inside `.opencode/.gitignore`, which itself is inside the untracked directory tree, rendering it ineffective.

**Files:** (root) — missing file

**Impact:** Developers must manually ignore these directories. Generated state leaks into accidental staging. New contributors see a dirty `git status` on first clone.

**Fix approach:** Add a root `.gitignore` containing:
```
.opencode/
.planning/
```

### Dead Skills (Declared in `apm.yml`, Referenced by No Agent)

**Issue:** Two skill packages exist in `skills/` and are declared in `packs/agentic-squad/apm.yml` as APM dependencies, but no agent definition (`agents/*.agent.md`) ever loads them via a `Load **...** skill` directive:

- `skills/caveman-review/` — referenced in `apm.yml` line 20, never loaded by any agent
- `skills/clerk-nextjs-patterns/` — referenced in `apm.yml` line 24, never loaded by any agent

**Files:**
- `packs/agentic-squad/apm.yml` (lines 20, 24)
- `skills/caveman-review/SKILL.md`
- `skills/clerk-nextjs-patterns/SKILL.md`
- `agents/*.agent.md` (all 25 — none reference these skills)

**Impact:** APM downloads and installs these skills into every target project that uses the `agentic-squad` pack. They consume bandwidth, disk space, and token context budget with zero benefit.

**Fix approach:** Either remove from `apm.yml`, or add `Load` directives to appropriate agent definitions. If they are architectural future work, add a comment explaining intent.

### `install.sh` Has macOS-Specific Sed Syntax

**Issue:** The `strip_allowed_tools` function at `install.sh:108-113` uses `sed -i ''` (BSD sed syntax with empty-string backup extension). On GNU/Linux systems, `sed -i` requires either a non-empty backup extension or `sed -i` without `''` (which means something different). The script will fail on standard Linux CI runners.

**Files:** `install.sh:111`

```bash
sed -i '' '/^allowed-tools:/d' "$file"
```

**Impact:** Installation on Linux (GitHub Actions, Gitpod, Codespaces) silently fails to strip `allowed-tools` from SKILL.md files.

**Fix approach:** Use a portable pattern that works on both BSD and GNU sed, or switch to a Python/perl one-liner for the stripping:

```bash
# Portable approach using perl
perl -i -pe 's/^allowed-tools:.*\n//' "$file"
```

### `install.sh` Requires Python3 Runtime

**Issue:** The `convert_tools_to_permission` function at `install.sh:45-106` calls `python3` to rewrite agent frontmatter. If `python3` is not installed on the target system, the function returns a non-zero exit code but installation continues, leaving agent files unconverted.

**Files:** `install.sh:47`

```bash
command -v python3 >/dev/null 2>&1 || { error "python3 é necessário para conversão"; return 1; }
```

**Impact:** On systems without Python3 (minimal Docker images, some CI runners), 25 agent files get copied without the `tools:` → `permission:` conversion. This corrupts the opencode agent definitions, which may fail to load.

**Fix approach:** Use `sed`/`awk` for the conversion, add `install_agents` return-code handling in `main()`, or stop the installation if `python3` is missing.

### `install.sh` Has No Rollback On Failure

**Issue:** Each install step (`install_agents`, `install_commands`, `install_skills`, etc.) runs independently. If step 4 fails, steps 1-3 have already copied files to the target directory, leaving a partial installation.

**Files:** `install.sh:238-284` (main function)

**Impact:** Target project has a broken installation. A re-run may conflict with partially written files.

**Fix approach:** Install to a temporary staging directory first, then atomically move to the target on success. Or add explicit rollback steps.

### PRD Template Contains Shell Expansion That Won't Render

**Issue:** `commands/PRD.prompt.md` line contains `$(date +%Y-%m-%d)` which is shell syntax embedded in a Markdown prompt template. When this template is loaded as an opencode command prompt, the `$()` will not be evaluated by a shell — it will be rendered literally as `$(date +%Y-%m-%d)` in the generated PRD.

**Files:** `commands/PRD.prompt.md`

```markdown
**Versão:** 1.0 | **Data:** `$(date +%Y-%m-%d)` | **Autor:** PO Agent
```

**Impact:** Every PRD generated from this template has the literal string `$(date +%Y-%m-%d)` instead of an actual date. Affects PRD accuracy and tracking.

**Fix approach:** Use a date placeholder string that the AI knows to replace, e.g., `<current-date>` or `YYYY-MM-DD`, and instruct the agent to fill it in.

### Skills-Lock Contains Only One Entry

**Issue:** `skills-lock.json` only locks `webapp-testing` skill version (11 lines total). The remaining 24 skill packages installed via APM have no version pinning. Future updates to skills may introduce breaking changes.

**Files:** `skills-lock.json`

```json
{
  "version": 1,
  "skills": {
    "webapp-testing": {
      "source": "anthropics/skills",
      "sourceType": "github",
      "skillPath": "skills/webapp-testing/SKILL.md",
      "computedHash": "ad5b1fc52807e9afa4635e59218a026b164dc58b6c3f41b0f7c644dcd6ccf572"
    }
  }
}
```

**Impact:** The 24 skills sourced from the community (`skills/clean-code/`, `skills/solid/`, `skills/react-best-practices/`, etc.) are unversioned snapshots. No ability to detect drift or revert to known-good versions.

**Fix approach:** Run `npx skills add --lock` for all sourced skills after verifying compatibility, or add a CI step to regenerate the lock file on skill changes.

## Security Considerations

### No Root `.gitignore` — Secrets Exposure Risk

**Issue:** The missing root `.gitignore` means any files written to `.opencode/` during development (tokens, session state, credentials cached by the opencode runtime) are visible to `git status` and could be accidentally committed. The `.opencode/.gitignore` masks files inside `.opencode/`, but the directory itself still appears in untracked listings.

**Files:** (root) — missing file

**Risk:** A developer running `git add .` could stage and commit `.opencode/` files containing session tokens, API keys cached by opencode hooks, or other sensitive runtime data.

**Current mitigation:** `.opencode/` is currently untracked and not staged. No automated protection.

**Recommendations:** Add root `.gitignore` with `.opencode/` and `.planning/` immediately.

### Agent Permission Model — Subagent Task Permissions Are Overly Permissive

**Issue:** Orchestrator agents (e.g., `agents/backend-dev.agent.md`) grant `task` permission to subagents (`"architecture-reviewer": allow`, `"supabase-specialist": allow`, etc.) but do not restrict what those subagents can do. A compromised or misconfigured subagent inherits the orchestrator's `bash: allow` and `edit: allow` broad permissions.

**Files:**
- `agents/backend-dev.agent.md` (lines 17-22)
- `agents/frontend-dev.agent.md` (lines 18-23)
- `agents/techlead.agent.md` (lines 17-22)
- `agents/qa-engineer.agent.md` (lines 22-26)

**Risk:** Subagent delegation creates a transitive-trust chain. If one subagent is compromised or given incorrect instructions, it can execute arbitrary shell commands and modify any file the orchestrator can touch.

**Current mitigation:** Subagents are defined as allow-listed (wildcard `"*": deny` plus specific allows). This constrains which subagents can be called.

**Recommendations:** Audit whether subagents need `bash: allow` or `edit: allow` in their own definitions, or whether the orchestrator's permissions should be scoped per-subagent invocation.

## Performance Bottlenecks

### Agent File Size is Close to AGENTS.md Maximum

**Issue:** `AGENTS.md` specifies a 200-line maximum for agent files. Multiple agents approach this limit:

| Agent File | Lines | % of Limit |
|---|---|---|
| `agents/techlead.agent.md` | 145 | 72% |
| `agents/qa-engineer.agent.md` | 139 | 70% |
| `agents/backend-dev.agent.md` | 102 | 51% |
| `agents/frontend-dev.agent.md` | 97 | 49% |

**Files:**
- `agents/techlead.agent.md` (145 lines)
- `agents/qa-engineer.agent.md` (139 lines)

**Impact:** Expanding these agents risks exceeding the 200-line limit. At 200+ lines, the `AGENTS.md` Progressive Disclosure rule is violated, and the agent definition becomes too large for the context window to load efficiently.

**Fix approach:** Extract detailed orchestration logic into `commands/` prompts (as AGENTS.md rule #1 suggests). The techlead and QA agents should push more content into their corresponding `commands/techlead-prompt.prompt.md` and `commands/qa-prompt.prompt.md` files.

### Agent Cross-Reference Graph is Tightly Coupled

**Issue:** The 25 agents form a dense subagent delegation network with 79+ cross-references. Removing or renaming any single agent breaks references in 3-5 other agent definitions.

**Files:** All 25 `agents/*.agent.md` files

**Impact:** Any refactoring of the agent roster requires updating multiple file references. No automated validation catches broken references. This creates fragility during maintenance.

**Fix approach:** Add a validation script that checks every quoted subagent name in `permission.task` and `Load **...** skill` blocks against the actual file inventory. Run this as a pre-commit hook.

## Fragile Areas

### `install.sh` — The Single Distribution Mechanism

**Files:** `install.sh` (292 lines)

**Why fragile:** The shell script is the sole distribution mechanism for the entire module. It handles 4 source formats (`agents/`, `.agents/`, `.claude/`, `.github/`), performs in-place frontmatter conversion via embedded Python, and regex-based tool-permission rewriting. It has:
- No automated tests
- No dry-run mode
- No rollback (partial failure leaves broken installation)
- Platform-specific `sed` syntax (BSD vs GNU)
- Hard dependency on `python3`
- No file conflict detection (silently overwrites)

**Safe modification:** Test changes on both macOS and Linux. Use `shfmt` for shell formatting. Add `set -x` debugging mode that can be toggled.

**Test coverage:** Zero. The install.sh has never been tested on a clean CI environment.

### Agent Permission Frontmatter (YAML-in-Markdown)

**Files:** All 25 `agents/*.agent.md` files

**Why fragile:** Agent definitions embed YAML frontmatter that defines `permission` blocks, model selection, and subagent authorization. There is no schema validation:
- Model names (`opencode-go/qwen3.7-plus`, `opencode-go/deepseek-v4-flash`) could be misspelled
- Permission keys (`allow` vs `deny`) are validated only at opencode runtime
- Cross-reference agent names in `task:` blocks could reference non-existent agents

**Safe modification:** Always verify frontmatter YAML is valid after editing. Consider adding a JSON Schema or a small validation script.

**Test coverage:** None.

### `techlead.agent.md` Model Recommendation Contradiction

**Issue:** `techlead.agent.md` line 135 states: *"Preferir `opencode-go/deepseek-v4-flash` para tarefas de orquestração simples"* — yet the agent itself uses `opencode-go/qwen3.7-plus` (line 4). The recommendation contradicts the agent's own configuration. A subagent told to use the cheaper model while the orchestrator uses the premium model could lead to quality inconsistency in delegated tasks.

**Files:** `agents/techlead.agent.md` (lines 4, 135)

**Impact:** When the Tech Lead delegates "simple orchestration tasks" to itself or to subagents, there is ambiguous guidance on which model to prefer. The line was likely a copy-paste from another agent definition.

**Fix approach:** Either remove line 135 or align it with the agent's actual model. If a specific subagent should use the cheaper model, reference it by name rather than making a general preference statement.

## Dependencies at Risk

### External Skills Sourced From Community Repositories

**Risk:** 22 of 25 skill packages are sourced from third-party repositories (`ClawForge`, `vibeship-spawner-skills`, `anthropics/skills`). These have varying license terms, update frequencies, and compatibility guarantees.

**Impact:** A breaking change upstream could silently corrupt agent behavior across all target projects. The `skills-lock.json` only pins one skill (`webapp-testing`), so 24 skills have no version protection.

**Migration plan:** For each sourced skill:
1. Review license terms (e.g., `skills/frontend-design/LICENSE.txt`)
2. Consider forking high-risk skills into this repository
3. Use `npx skills add --lock` to pin all 24 community skills
4. Add a periodic update workflow (`skills-lock.json` regeneration via CI)

**Skills without pinned versions:**
- 24 of 25 skills are unpinned (only `webapp-testing` has a hash in `skills-lock.json`)

## Missing Critical Features

### No Automated Validation for Module Integrity

**Problem:** The module has no automated tests to validate:
- Agent frontmatter YAML is well-formed
- All agent `"agent-name": allow` references resolve to existing `agents/agent-name.agent.md` files
- All `Load **skill-name** skill` directives resolve to existing `skills/skill-name/SKILL.md` directories
- Command references in agent documentation resolve to existing `commands/` files
- `apm.yml` YAML structure is valid
- `install.sh` runs correctly on both macOS and Linux

**Blocks:** Reliable module refactoring. Adding or removing agents requires manual cross-reference audit.

### No CI/CD Pipeline

**Problem:** The repository has no `.github/` directory (despite `install.sh` supporting it). There are no CI workflows for:
- Validating agent/skill cross-references on pull request
- Running install.sh end-to-end test on PR (both macOS and Linux matrix)
- Checking frontmatter YAML validity
- Updating `skills-lock.json` automatically

**Blocks:** Cannot safely accept contributions or evolve the module.

## Test Coverage Gaps

| Area | What's Not Tested | Risk | Priority |
|---|---|---|---|
| `install.sh` | Conversion, file copying, edge cases, platform compatibility | Broken installations in target projects | High |
| Agent frontmatter | YAML validity, cross-reference integrity, model names | Broken agent loading at runtime | High |
| Skill references | Agent-to-skill resolution (Load directives vs directory existence) | Dead load directives waste context budget | Medium |
| `apm.yml` | Valid references, valid YAML | Pack installation failures | Medium |
| Cross-platform | `sed` syntax, `python3` availability, path handling | Linux installation silently broken | High |

---

*Concerns audit: 2026-07-03*
