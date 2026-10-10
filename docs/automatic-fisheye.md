# Automatic fisheye follow-up

Apply this incremental patch after `code-intelligence-response-workspace.patch`.

## Behavior

- Outer diameter is 70% of the chart host's shorter dimension, capped at 520 px. Very small hosts additionally retain 8 px of margin on each side.
- Inner radius is 88% of the outer radius. Both rings remain visible, with only a 12% transition band between them. At 800 × 605 px, diameters are 423.5 px outer and 372.68 px inner.
- Geometry updates with the host size. Near an edge, the lens shifts inward to keep its outer circle visible.
- Hovering a node, cell, tree element or edge for 200 ms activates expansion. Empty background does not activate it. The lens stays fixed while interacting inside it; a small corridor connects edge-clamped source elements to their expanded content.
- Aggregate children occupy a spaced grid inside the inner circle. Page capacity adapts to the available space; corners stay inside the circle. The old group's interior drawing is suppressed behind the expanded children.
- Ordinary elements show a larger focused card with bounded text/detail space. Size is automatic; a sparse element is not stretched arbitrarily to fill the entire circle.
- Radius, magnification, falloff, easing, ring toggles, pinning, and the duplicate concept-tree lens zoom buttons are removed from the UI. Old saved geometry settings are ignored.
- Wheel/Shift-wheel/Alt and +/- no longer configure the lens. The normal chart's wheel behavior is left to its renderer. The obsolete global lens zoom command is no longer registered.
- A single Pause/Resume hover expansion action remains for accessibility. L toggles it; Escape dismisses the active lens. Graph keyboard navigation and E expose focused elements; DOM-backed cell/tree focus also expands elements. Touch activates expansion on tap.
- Aggregate paging retains [ and ] keyboard shortcuts. Dedicated touch paging controls are not added in this change.
- Existing radial projection, edge semantics and evidence-bearing callbacks are retained. The 88% inner ring is the content boundary, not a claim of uniform magnification throughout that region.

## Validation

- TypeScript checks and the production build pass.
- 12 focused tests pass, including responsive geometry, viewport bounds, child containment/non-overlap, inverse projection, delayed hover, stable selection, wheel passthrough, ignored legacy geometry settings, pause, and disposal cancellation.
- Browser tests were updated for automatic hover and clamped child coordinates. Their execution is skipped when Chrome is unavailable; interactive appearance, touch behavior, and quantitative/sequence chart readability still require browser review.

## Apply

From the repository root, after applying the earlier response workspace patch:

```sh
git apply --check automatic-fisheye-incremental.patch
git apply automatic-fisheye-incremental.patch
```
