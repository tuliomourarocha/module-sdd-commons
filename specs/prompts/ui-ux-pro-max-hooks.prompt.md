---
description: "UI/UX Pro Max agent validation hooks — pre-delivery checklists for visual quality, interaction, light/dark mode, layout, performance, accessibility, and design system persistence."
---

# UI/UX Pro Max — Validation Hooks

## Pre-Delivery Checklist

Run these validation hooks before delivering any UI implementation.

### Hook: Visual Quality

- [ ] No emoji used as icons (vector SVG only)
- [ ] All icons from a consistent family with uniform stroke width
- [ ] Pressed states do not shift layout bounds
- [ ] Semantic theme tokens used; no ad-hoc hex values
- [ ] Brand assets use correct proportions and clear space
- [ ] Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text

### Hook: Interaction

- [ ] All tappable elements provide pressed feedback within 80-150ms
- [ ] Touch targets ≥ 44x44pt (iOS) or ≥ 48x48dp (Android)
- [ ] Disabled states visually clear (opacity 0.38-0.5) and non-interactive
- [ ] Screen reader focus order matches visual order
- [ ] No gesture conflicts in overlapping regions

### Hook: Light/Dark Mode

- [ ] Primary text ≥ 4.5:1 in both modes
- [ ] Secondary text ≥ 3:1 in both modes
- [ ] Dividers, borders, and state colors distinguishable in both modes
- [ ] Modal scrim opacity sufficient for foreground legibility

### Hook: Layout

- [ ] Safe areas respected for headers, tab bars, bottom CTAs
- [ ] Scroll content not hidden behind fixed/sticky bars
- [ ] Verified at 375px (small phone) and landscape orientation
- [ ] Horizontal gutters adapt by device size
- [ ] 4pt/8dp spacing rhythm maintained

### Hook: Performance

- [ ] Images optimized (WebP/AVIF) with declared dimensions
- [ ] Lazy loading for non-hero content
- [ ] No layout shift from async content
- [ ] Font-display: swap for web fonts
- [ ] No expensive animations on scroll

### Hook: Accessibility

- [ ] Color is not the only means of conveying information
- [ ] `reduced-motion` respected
- [ ] Dynamic text scaling supported without layout breakage
- [ ] Form fields have labels, hints, and clear error messages
- [ ] Keyboard navigation works for all interactive elements

## Post-Generation Hook

After generating code, verify using the skill:

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "accessibility animation contrast layout" --domain ux
```

Run a final validation scan against the Quick Reference priority 1-3 items.

## Hook: Design System Persistence

When building multi-page projects:

1. Generate the design system with `--persist`
2. Check `design-system/pages/` for page-specific overrides before each new page
3. If no override exists, use `design-system/MASTER.md`
4. Create page overrides only for significant deviations from the master
