# D004 — Browser, coverage and runtime validation evidence

**Status:** Accepted product-policy baseline, 2026-10-06
**Origin:** GitHub issue #98, decisions 2–4
**Unblocks:** #94, #88, #89 and #90

### Browser gate

For UI changes, use Playwright with headless Chromium against the live application server. Server-rendered markup is not browser evidence. Cover the supported journeys: open Prompt-to-feature; enter request; clarify; review plan; build; inspect changed files; validate; inspect tests; inspect declarations; deliver; export patch; create draft PR. Include the applicable authorization and denial journeys.

Run responsive checks at **1366×768, 1920×1080 and 1280×720**, plus axe-based accessibility checks. Record browser/runtime/image identity and traces/screenshots as supporting artifacts; screenshots alone do not prove interaction correctness. The exact Chromium image reference must be selected and audited in #94 before certification; do not silently float an unpinned browser image.

### Coverage evidence

Coverage has three distinct strengths: declared/static links, inferred links, and coverage **observed during the validation test run**. Only the observed category may satisfy an acceptance criterion that requires execution coverage. Provide an adapter boundary for Jest/Vitest/Istanbul, JaCoCo, coverage.py and generic LCOV/Cobertura as needed; unsupported formats remain explicit gaps. Bind observed file/symbol/test results to the candidate hash and run ID.

### Runtime telemetry

The initial run telemetry contract records `run_id`, `feature_id`, `stage`, start/finish time, duration, status, queue wait, model/build/test/browser durations, memory peak, CPU peak and error code when measurable. Missing measurements are null/unknown, never zero. Telemetry feeds #90's measured QA report and does not substitute for gate evidence.
