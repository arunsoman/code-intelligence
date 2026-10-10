# Typed table cleanup

Apply `typed-table-cleanup-incremental.patch` after `canvas-space-and-links-incremental.patch` on c789210. This patch contains only the next slice, not the previous canvas changes.

S11 decision tables now display one rule per row, condition values, outcomes and coverage interpretations in separate columns. S24 displays states by events, guards and transition targets. S25 displays failures, impacts and compensation. It does not invent severity, occurrence, detection or risk-priority scores.

All three share `table.v1`, a discovered `table` renderer and bumped chart descriptor versions. Native tables use available canvas width, sticky headers and horizontal/vertical scrolling. Scroll position persists in the existing per-tab camera state. The captured-hover lens previews only the hovered cell. Native button keyboard activation opens inspection; modifier-click adds the underlying row to selection. Selection intentionally remains row-based, while inspection contains only the clicked cell's evidence.

Values are static model interpretations, not runtime proof. Cells without current supporting citations say Unknown. Unknown state/event combinations are not classified as forbidden. Conflicting transitions retain their alternatives; forbidden transitions are labeled FORBIDDEN?. Duplicate axes/rows and missing targets produce gaps. Cell-level evidence cannot borrow the row's source citations when a property is absent.

Malformed table specifications fall back to the existing graph renderer. The table schema checks axis uniqueness, complete cell membership and citation/status consistency. Existing chart contracts and parser inventories are unchanged; no new extractor is introduced.

Validation: focused compiler/renderer/architecture and existing visualization regression tests, TypeScript checks, production build, and clean incremental patch application. Browser interaction needs verification in an environment with Chrome. This slice does not resolve the seven earlier missing chart captures or unsupported fixture capabilities.
