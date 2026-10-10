# Visualization cleanup batch

Base: upstream f95ee34, including the canvas, table, ranking and bounded-generation patches. Apply visualization-cleanup-batch.patch directly to that revision; none of the earlier patches are repeated.

## Confirmed defects and fixes

| Area | Evidence | Change |
| --- | --- | --- |
| Idempotency generation | Payments fixture creates more scenarios than the schema permits; S14 falls back to an architecture map | Cap operations at 40 and use three explicitly unverified replay/concurrency scenarios. Unknown outcomes have no borrowed citations. |
| Idempotency rendering | S14 previously projects operations and scenarios into graph nodes | Use the existing native table renderer with operation rows, scenario columns, mechanisms, key scopes, conflicts and explicit unknowns. |
| Table controls | Screenshot shows graph toolbar overlapping the table caption | Remove graph-only controls for tables, retain a dedicated text-outline action, reserve space for hover controls and collapse the lengthy caption. |
| Tab legibility | Inactive labels have white text against a light strip | Explicit active/inactive colors; browser assertion requires 4.5:1 inactive text contrast. |
| Table hover | Shared hover filter excludes buttons other than matrix cells | Permit table-cell targets, provide a clean preview label and preserve captured-hover geometry. Browser test verifies activation and unchanged source cell geometry. |
| Evidence summary | Footer counts hidden row nodes rather than visible cells | Count table cells; unknown = fog, conflicts = hypothesis, supported static interpretations = inference. |
| Runtime/reliability contracts | Projected connections can be labeled facts based solely on supplied citations | Label projected connections as interpretations and disclose limits on ordering, concurrency, atomicity, delivery and replay safety. Explicit inferred elements retain their mode. |
| Gallery revision | A previous catalogue request can complete after revision changes | Reset availability and abort/ignore obsolete requests. |
| Capture identity | Name-fragment lookup relies on removed C4 labels | Add stable gallery code attributes and select by code; separate input updates from the Show click. |
| Capture diagnosis | Failures lose screenshots and stage information | Persist capture-report.json, per-failure diagnostics and screenshots; distinguish captured, unavailable, failed and startup-blocked cases. |
| Layout recovery | Package chart intermittently remains busy for 60 seconds during repeated browser runs | Bound automatic layout to 10 seconds, stop abandoned workers and show a source-layout fallback notice. |

Affected compiler descriptor versions are incremented so existing plan caches cannot silently reuse the older visual contract. No new parser, extractor or runtime guarantee is introduced.

## Headless verification

Desktop Chrome could be downloaded but failed at startup because this runtime blocks the local socket required by its process-singleton service. Chrome's dedicated headless-shell executable starts successfully and can drive the existing CDP harness. This was verified with actual browser runs, not simulated screenshots.

The harness accepts CIE_CHROME and detects common Chrome/Chromium paths. Point CIE_CHROME at an installed headless-shell executable when desktop Chrome is unsuitable. To run the seven originally missing cases:

```bash
CIE_CHROME=/absolute/path/to/chrome-headless-shell \
CIE_CHART_CODES=S1,S2,S9,S10,S14,S27,V15 \
CIE_SCREENSHOT_DIR=/tmp/cie-chart-verification \
node --test apps/web/test/e2e/chart-screenshots.test.ts
```

The plugin-contracts workflow now runs the seven-case browser smoke plus canvas-focus checks, requires a browser instead of silently skipping and uploads captures/diagnostics as CI artifacts.

Remove CIE_CHART_CODES for the complete 47-choice fixture run. A successful unavailable-state capture does not count as a rendered chart: the report records these separately.

## Validation and remaining limits

- 132 focused and regression tests, including the unchanged layout ceilings, passed.
- The full headless fixture sweep renders 43 chart choices and records four unavailable choices: S5, V6, V9, V17. All seven previously missing captures are now obtained.
- Browser checks include canvas-focus restoration, automatic table hover without moving source cells, table-specific controls, cell-based evidence summaries and inactive-tab contrast.
- TypeScript checks, production build and clean application/byte verification are performed before delivery.

The broad packages/core/test/chart-rendering.test.ts suite still reports 26 pre-existing failures against its earlier notation expectations, including actual compiler parity gaps and expectations superseded by the dedicated sequence/state/table contracts. These have not been skipped or weakened. Passing the focused tests and screenshot sweep does not mean all formal notation semantics are implemented. Full semantic regression cleanup remains pending.

Screenshot tests use the offline fixture provider. They establish UI/capture behavior, not live-model quality, concurrency safety, idempotency guarantees or production runtime behavior. A successful fallback capture does not establish optimal graph layout.
