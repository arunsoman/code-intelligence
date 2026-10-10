# Consolidated remaining notation cleanup

Apply `remaining-visualization-consolidated.patch` after `native-catalog-tables-incremental.patch`. This is one incremental diff containing the remaining non-table notation cleanup, its regression contracts, and the native-chart selection correction. Earlier patches are prerequisites and are not repeated.

## Result

The original non-table `chart-rendering.test.ts` suite now passes all 27 tests. Its assertions follow the typed state, ER and sequence payloads and the current evidence contract. No tests are skipped or removed. Duplicate message numbers remain visible with an ambiguity warning; source citations alone do not prove execution order, cardinality, atomicity, replay safety or forbidden behavior.

| Area | Correction |
| --- | --- |
| Selected view | Preserve registered chart identity for matching native forms before building the response portfolio. A selected test-guarantee matrix remains the primary S5 tab instead of appearing as a separate on-demand duplicate. Contradictory compiler identities and different forms are not overwritten. |
| Type mismatch | Accept registered names and aliases after case/punctuation normalization. Display a gap when the model's chart name disagrees with the selected typed contract. A different chart ID remains a hard error. |
| State | Omitted transition warnings include their trigger, making stale/missing paths identifiable. Forbidden and replay metadata remain interpreted. |
| DFD | Preserve explicit levels, including zero, with an uncertainty marker. Unspecified levels remain unspecified. Duplicate element IDs retain the first declaration; repeated flows have unique IDs. |
| BPMN | Retain the first element for duplicate IDs. Repeated flows have distinct edge identities; conditioned and message flows keep their existing notation. |
| Saga | Route compensation edges as returns. Missing recovery is a named gap; a stale edge or uncited compensation target cannot close it. Missing compensation is not proof of irreversibility. |
| UML classes | Class declarations require their own citations; member citations cannot rescue an uncited parent. Duplicate IDs retain the first declaration. Ambiguous source names are not arbitrarily linked. Relation facts require a matching indexed relationship and evidence; otherwise the relation remains an interpretation. |
| Context | Use renderer-compatible roles and relationship kinds, preserve technology labels, and warn when there are zero or multiple grounded subject systems. |
| Sequence | Keep participants, messages and fragments in `sequence.v1`, rather than fabricating message nodes. Count all rejected messages in omission diagnostics. Duplicate fragment IDs retain the first grounded declaration and disclose the omission. |
| Contracts and CI | Run the repaired legacy suite plus new negative regressions. Browser readiness checks use stable selected-chart identity for native choices as well as generated charts. Bump affected compiler versions and regenerate the catalog. |

Communication, package, call, interaction overview, outbox and ER assertions were migrated to current roles, labels, typed metadata and uncertainty semantics. Existing evidence, unknown-endpoint, stale-citation and ambiguity assertions remain active. The offline stub test checks schema-valid output for every chart ID and visible offline limitations; it no longer assumes every notation lacks an offline implementation.

## Validation

- 178 selected compiler, planner, renderer and architecture tests passed, including all 27 original notation tests and 11 new consolidation cases; no skips.
- Four worker-backed table retrieval tests passed separately.
- Rust release build and all 88 workspace tests passed; doc-test phase passed.
- Type checking and web build passed.
- Full headless catalog sweep: 47 choices attempted, 43 captured, four explicitly unavailable for the fixture, zero failures. Unavailable choices were S5, V6, V9 and V17; unavailable results are not renderer coverage.
- Final saga/sequence captures and canvas-focus test passed. Populated CRC and metric captures passed separately with required nonempty rows and hover checks.
- Incremental patch application and resulting-file comparison verified against the preceding three patches.

The browser tests use static indexing and the stub provider. They do not establish hosted-model response quality or production execution guarantees. Content inventories remain bounded by retrieval and chart limits.

## Broader repository tests

The repository-wide Node test attempt found failures outside this notation cleanup and did not finish cleanly. In particular, an existing chat-agent test expects an analysis without building the now-required concept hierarchy. The same test fails against the preceding patch baseline with the same hierarchy prerequisite. Other failures included legacy service/database and parser/resource expectations; they have not all been classified or fixed here. Therefore the complete repository test command is not claimed green. This patch closes the remaining notation-contract batch, not every unrelated repository defect.

## Apply

From the repository root, after the preceding native-table patch:

```bash
git apply --check remaining-visualization-consolidated.patch
git apply remaining-visualization-consolidated.patch
```

CI includes the notation contracts. For worker-dependent checks, run `bash scripts/setup-dev.sh`, then `cargo build --release --locked` and `cargo test --workspace --locked`. Use a headless-capable Chrome binary through `CIE_CHROME` when necessary.
