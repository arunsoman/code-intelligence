# Native responsibility and metric tables

Apply `native-catalog-tables-incremental.patch` after `projected-semantics-incremental.patch` (and its preceding visualization cleanup patch). The diff contains only this slice.

## User-visible changes

CRC cards and metrics maps now use the native table surface in the existing chart workspace. They retain source inspection, selection, text alternatives, automatic hover expansion and scroll state. Graph-only controls do not cover the tables.

| View | Row | Columns |
| --- | --- | --- |
| Decision table (S11) | Rule | Conditions, outcome, coverage interpretation |
| Idempotency matrix (S14) | Operation | Replay/duplicate scenarios |
| CRC cards (S20) | Class | Responsibilities, collaborators |
| State transition table (S24) | State | Declared events |
| FMEA matrix (S25) | Failure | Impact, compensation |
| Metrics map (S26) | Metric name | Meaning interpretation, declared emitters |

List cells preserve line breaks. CRC context explicitly distinguishes unknown responsibilities from none; metrics context explicitly states that no live values are shown. Tables with grounded rows but no grounded columns now explain that state instead of showing an unexplained empty body.

## Evidence and compiler corrections

- CRC responsibilities and collaborators each need their own current citations. A class declaration cannot supply their missing evidence. Duplicate class rows retain the first declaration and report the omission.
- Metrics require a grounded declaration; emitter entries are checked separately. Meaning remains interpreted against the declaration's citations because the current model contract has no separate meaning-evidence field.
- Offline CRC output leaves unestablished responsibilities/collaborators empty and caps its class inventory at 60. A placeholder sentence is no longer classified as an evidenced responsibility.
- Offline metrics accept nonempty string names from `metric_declaration` facts. Numeric telemetry values, unrelated metric predicates and malformed names are excluded.
- State and event declarations must have their own current evidence. Transition citations cannot silently rescue missing declarations. Unknown or ungrounded targets are dropped before comparing valid alternatives, preventing false conflict cells. Genuine allowed/forbidden alternatives remain conflicting.
- FMEA gaps explicitly identify missing grounded compensation without claiming irreversibility.
- Repository-wide required kinds now work independently of file-local required kinds. Previously S26's function/method requirements were ignored when its file-local list was empty, producing empty charts even when the worker had indexed metric declarations. Top-up still honors source permissions, ignored entities and token-budget checks.
- Compiler versions and generated catalog entries invalidate responses under the old contracts.

## Regression coverage

Six former matrix-shaped tests were moved from `chart-rendering.test.ts` into `chart-table-contract.test.ts` and migrated to the current `table.v1` payload. The assertions cover citations, unknowns, interpreted values, rejected references and native row identity. CI runs these contracts alongside new negative evidence cases; tests are not skipped.

A separate one-file fixture contains real classes and two statically parsed `createCounter` declarations. The populated headless run requires rows, so empty output cannot pass as renderer coverage. The existing payments fixture also exercises all six table choices, including zero-column state output. Browser checks cover native dispatch, table context, readable inactive tabs, cell summaries, automatic hover expansion and unchanged source-cell geometry.

Validation performed:

- 327 selected compiler, retrieval and web regression tests passed.
- All six table choices captured in headless Chrome, with zero capture failures.
- Populated CRC and metric views captured separately with nonempty-row assertions and hover checks.
- Rust release build passed; workspace tests passed (88 tests plus successful doc-test phase).
- Type checking and web build passed.
- Incremental application checked against both preceding patches and resulting files byte-compared.

The remaining original notation suite contains 27 tests: 9 pass and 18 fail. The six migrated table cases pass separately. The whole repository test command is therefore still not green; non-table semantic payload migrations and remaining compiler parity work are subsequent slices.

## Reproduce populated browser checks

After building the worker and web app, run:

```bash
CIE_CHART_CODES=S20,S26 \
CIE_SCREENSHOT_REPO="$PWD/fixtures/native-tables-repo" \
CIE_REQUIRE_TABLE_ROWS=1 \
node --test apps/web/test/e2e/chart-screenshots.test.ts
```

Set `CIE_CHROME` to a headless-capable Chrome executable if it is not in a standard location. The tests exercise static analysis with the stub provider; they do not establish live telemetry, production correctness, or hosted-model quality. Large repositories remain subject to retrieval and chart inventory bounds, so a table is not a guarantee of exhaustive coverage.
