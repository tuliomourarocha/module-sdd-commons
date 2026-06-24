# Product Owner Agent — Validation Hooks

## Pre-Delivery Checklist

Run these validation hooks before delivering any output.

### Hook: User Stories

- [ ] Follows INVEST principle (Independent, Negotiable, Valuable, Estimable, Small, Testable)
- [ ] Format: "As a [role], I want [goal] so that [benefit]"
- [ ] Acceptance criteria in Given/When/Then (Gherkin) format
- [ ] Criteria are objectively verifiable — no "should work" or "should be fast"
- [ ] Story describes user value, not technical implementation
- [ ] Story is small enough for one sprint (if not, suggest split)
- [ ] Edge cases and negative scenarios considered in criteria

### Hook: Backlog Refinement

- [ ] Each item has a clear user or role identified
- [ ] Acceptance criteria defined for top-priority items
- [ ] Dependencies identified and noted
- [ ] Items that are too large have a suggested split
- [ ] Epics broken down into at least 2-3 candidate stories
- [ ] Items inactive for 3+ months flagged for removal/archival

### Hook: Roadmap

- [ ] One-sentence vision stated at the top
- [ ] Organized by time horizon (Now / Next / Later or quarters)
- [ ] Each theme has at least one measurable outcome
- [ ] Risks and dependencies section included
- [ ] Audience-appropriate level of detail (outcomes vs features vs themes)

### Hook: Prioritization

- [ ] An explicit framework was used (RICE, MoSCoW, Value vs Effort, etc.)
- [ ] Framework dimensions explained to the user
- [ ] Ranked list produced with rationale
- [ ] Tradeoffs and assumptions documented

### Hook: Requirements

- [ ] Problem statement clearly defined
- [ ] Target users identified
- [ ] Functional requirements separated from non-functional
- [ ] Success metrics defined
- [ ] Open questions documented

### Hook: Trello Operations

- [ ] Authentication verified before any API call
- [ ] Correct board selected (board listed confirmed)
- [ ] Cards have description populated (not just title)
- [ ] Destructive actions (delete, archive, bulk move) confirmed with user
- [ ] Summary provided after creation (how many, where, which board)

## Post-Generation Hook

After delivering output, verify against the skills:

```bash
# Load po-assistant skill and confirm templates were applied correctly
# Load trello-manager skill and confirm Trello operations are ready to execute
```

Run a final validation scan against all Critical and High priority items above before considering the task complete.
