# React Frontend Agent — Validation Hooks

## Pre-Delivery Checklist

Run these validation hooks before delivering any frontend implementation.

### Hook: Performance

- [ ] No sequential `await` waterfall — independent operations use `Promise.all()`
- [ ] Heavy components lazy-loaded with `next/dynamic` or `React.lazy`
- [ ] No barrel file imports (`import { X } from 'lucide-react'`) — use direct imports or `optimizePackageImports`
- [ ] `useMemo`/`useCallback` not wrapping primitive expressions or trivial computations
- [ ] No components defined inside other components (causes remount)
- [ ] Lazy state initialization for expensive computations (`useState(() => compute())`)
- [ ] Static JSX elements hoisted outside components
- [ ] `content-visibility: auto` applied to long lists
- [ ] Derived state computed during render, not in `useEffect`
- [ ] Functional `setState` used when updating from current value

### Hook: React Best Practices

- [ ] Server Component used by default; `'use client'` only when necessary
- [ ] RSC boundary props minimized — pass only fields the client needs
- [ ] Server Actions include authentication check inside the action
- [ ] `React.cache()` used for non-fetch deduplication (DB queries, auth)
- [ ] Effects separated by concern — not combined with unrelated dependencies
- [ ] Event handler logic in handlers, not modeled as state + effect
- [ ] `useDeferredValue` or `useTransition` for non-urgent updates
- [ ] Early returns in async functions before expensive `await` calls
- [ ] `toSorted()` used instead of `sort()` to avoid mutation

### Hook: Accessibility

- [ ] Color contrast ≥ 4.5:1 body text, ≥ 3:1 large text
- [ ] Visible focus states on all interactive elements
- [ ] Keyboard navigation order matches visual order
- [ ] Color is not the only means of conveying information
- [ ] `reduced-motion` media query respected
- [ ] Form fields have `<label>`, `aria-label`, or `aria-labelledby`
- [ ] Images have `alt` text or `aria-hidden="true"`
- [ ] Touch targets ≥ 44x44pt on mobile
- [ ] Dynamic text scaling supported without layout breakage

### Hook: Design Consistency

- [ ] Semantic color tokens used (no ad-hoc hex values in components)
- [ ] SVG icons from a consistent family with uniform stroke width
- [ ] 4pt/8dp incremental spacing system throughout
- [ ] Responsive breakpoints verified: 375px, 768px, 1024px, 1440px
- [ ] Light and dark mode variants tested where applicable
- [ ] Consistent border-radius, shadow, and elevation tokens
- [ ] Typography follows defined scale (display, body, utility faces)

### Hook: Code Quality

- [ ] TypeScript types defined for all props and state
- [ ] No `any` or unsafe type assertions without justification
- [ ] Early returns used to avoid unnecessary computation
- [ ] Array `.find()` replaced with `Set`/`Map` for repeated lookups
- [ ] `flatMap` used instead of `.map().filter(Boolean)` chain
- [ ] Combined array iterations reduced to single pass where possible
- [ ] Storage API calls wrapped in try-catch
- [ ] Module-level cache for repeated function calls

## Post-Generation Hook

After generating code, verify against the skills:

```bash
# Load the react-best-practices skill and check performance rules 1-5
# Load the frontend-design skill and confirm design tokens are applied
```

Run a final validation scan against all Critical and High priority items above.
