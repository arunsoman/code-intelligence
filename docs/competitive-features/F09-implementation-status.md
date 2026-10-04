# F09 implementation status

This file tracks what has been landed for **F09 — Readable semantic zoom and camera transitions** and what remains.

## Landed in this slice

### Pure-function foundation (unit-tested under node)

| File | What | Tests | Status |
|---|---|---|---|
| `apps/web/src/detail.ts` | `DetailPolicy`, `DetailLevel`, `RenderedLevel`, `SemanticAnchor`, `TransitionPlan`, `ZoomIntent` data model; policy validator; per-form policy table (`detailPolicyFor`); policy summary; form enumeration. | `apps/web/test/detail.test.ts` | ✅ |
| `apps/web/src/legibility.ts` | Extended with `measureLabels`, `chooseInitialLevel`, `evaluateCandidateCamera`, `planTransition`, `fitZoomForBBox`. | `apps/web/test/legibility.test.ts` | ✅ |
| `apps/web/src/rendered-level.ts` | Adapter from `graph.ts Rendered` → `RenderedLevel` to feed the planner. | `apps/web/test/rendered-level.test.ts` | ✅ |
| `apps/web/src/Canvas.tsx` | Explicit level selection (stepper / `fitTick`) now uses `planTransition` for forms that support semantic levels, landing readable and anchored instead of fitting everything unreadably. | e2e | 🟡 wired, needs probes |
| `apps/web/src/App.tsx` | `levelsApply` now uses `semanticLevelsApply(view)` from the policy instead of a heuristic; `formId` passed to `Canvas`. | — | ✅ |

### Tests added / extended

- `apps/web/test/detail.test.ts` — F09-A7/D1/D2 (every form has a valid policy; validator rejects bad thresholds and `LABEL_ONLY`).
- `apps/web/test/legibility.test.ts` — F09-D4/D8 (`chooseInitialLevel`, `planTransition` readable landing, coverage disclosure, anchor resolution).
- `apps/web/test/rendered-level.test.ts` — adapter correctness.

### What works now

1. Every form declares a `DetailPolicy`; the build-time validator catches missing/invalid declarations (F09-A7, D1, D2).
2. The semantic-map policy models all seven levels with per-level font units and caveat channels.
3. `planTransition` is the single camera-math function: it resolves anchors, chooses zoom by transition kind, pulls small drawings into view, and reports off-screen counts / unmet constraints.
4. Explicit level selection (stepper, keyboard `+`/`-`) lands readable on the anchor and discloses off-screen content for semantic-level forms.
5. `chooseInitialLevel` is a pure function that can replace the timeout cascade for new views once per-level candidates are supplied.

## Not yet implemented (work packages remaining)

| WP | Title | Status | Notes |
|---|---|---|---|
| WP-01 | Audit all 16 forms | ⚠️ partial | Semantic map, ownership, journey, runtime done; remaining forms use default no-aggregation policy. |
| WP-02 | Remove legacy relative-zoom code (`ENTER`/`LEAVE`/`nextLevel`/`zoomForLevel`) | ❌ | Still in `graph.ts`; unused by Canvas but tests reference them. |
| WP-03 | `measureLabels` from real stylesheet / truncation collision | ⚠️ | Function exists; needs DOM-backed measurement and collision handling. |
| WP-04 | `chooseInitialLevel` wired for new views | ⚠️ | Function exists; needs per-level `RenderedLevel` cache and candidate pipeline. |
| WP-05 | Candidate-aware expansion rule (`evaluateCandidateCamera`) | ⚠️ | Function exists; needs cache integration in wheel handler. |
| WP-06 | Auto-detail toggle replacing `lockZoom`; keyboard `A`; announcements | ❌ | Not started. |
| WP-07 | `RenderedLevel` cache, neighbour precompute, generations, worker threshold | ❌ | Not started. |
| WP-08 | Aspect-aware `basePositions` | ❌ | Not started. |
| WP-09 | Non-label caveat channels; aggregate display-mode rule | ❌ | Not started. |
| WP-10 | Persist `DetailPreference` and rebind on restore | ❌ | Not started. |
| WP-11 | Ownership roll-up aggregation by directory/team | ❌ | Policy declared; `graph.ts` render still hard-coded by level number. |
| WP-12 | Browser conformance suite (fixtures, fixed device metrics, resize/pointer/reduced-motion) | ❌ | Not started. |
| WP-13 | Disclosure panels no longer shrink stage (#52) | ❌ | Not started. |
| WP-14 | Ledger items and release-check wiring | ❌ | Not started. |

## Suggested next steps

1. **WP-07 + WP-04 + WP-05**: build the `RenderedLevel` cache and candidate pipeline so `chooseInitialLevel` and `evaluateCandidateCamera` can run against real data. This replaces the timeout cascade in `Canvas.tsx` and fixes the candidate-aware expansion rule.
2. **WP-06**: replace `lockZoom` with a visible Auto-detail toggle (`aria-pressed`) and keyboard shortcut `A`.
3. **WP-12**: add deterministic fixtures and headless browser probes with `Emulation.setDeviceMetricsOverride` to assert F09-A1…A8.
4. **WP-02**: delete the legacy `ENTER`/`LEAVE`/`nextLevel`/`zoomForLevel` code and their tests once Canvas no longer imports them.

## Migration flag

No flag is required for the data-model and validator additions; they are additive. The Canvas stepper change is active for any form whose policy declares `aggregationSupported: true`. To fully gate the new planner behind a flag, add `const ZOOM_V2 = true` in `Canvas.tsx` and guard the planner path with it.
