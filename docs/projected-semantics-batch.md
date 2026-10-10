# Typed diagram semantics — incremental patch

Apply after `visualization-cleanup-batch.patch` on the f95ee34 base. This diff contains only the next slice; it does not repeat the preceding patch.

## Changes

- Architectural layers become evidence-linked regions containing components, with stable order and horizontal placement within each layer. Unknown layer references are omitted and explained. Layer IDs and component IDs can overlap without overwriting each other.
- Offline layer generation caps both layers and their directory components consistently. Directories outside the layer limit are no longer assigned to the first layer.
- Call graphs emit actual `call` edges. Ownership is a note, rather than a fabricated call or containment connection.
- Module dependency labels retain compile-time, runtime, test and unknown categories.
- Communication diagrams preserve message number and sync/async/return distinctions. Duplicate order numbers remain visible with an explicit ambiguity gap.
- Saga, outbox, system-context, interaction, package, CRC and metric roles match the existing renderer shape vocabulary. DI bindings expose injection kind, qualifier, scope and unresolved status. Atomic and irreversible interpretations remain tentative.
- Duplicate element IDs retain the first declaration and report the omitted duplicate.
- Invalid explicit citations cannot be repaired silently with matching source names. Only uncited offline classifications may derive current source support, and they remain inferred. Member citations do not establish parent declarations; stale member details and unsupported cycle annotations do not leak into notes.
- Sequence fragments remain semantic metadata, so valid frames no longer inflate omitted-node diagnostics.
- Compiler descriptor versions invalidate cached responses under the old projection contract. The generated catalogue and architecture CI command include the new regression coverage.
- The capture server requests an unused OS port and requires its own listening message before accepting health checks, preventing capture of an unrelated stale server.

## Verification

- 13 deterministic semantic regression cases pass.
- Expanded compiler and web regression selection: 297 tests pass. The final offline layer-boundary regression was added afterward and passes independently.
- Dedicated Chrome headless sweep: all 13 affected chart choices captured, zero unavailable or failed; isolated server startup is exercised by this run.
- Final layer-generation change is checked again with the S22 headless capture.
- Type checking and web build pass. Patch application is checked against the preceding patch.
- The existing broad `chart-rendering.test.ts` suite improves from 7 passing / 26 failing to 9 passing / 24 failing. It remains a known failing suite; it includes old matrix and evidence expectations as well as compiler parity work still to complete. Assertions are not skipped or weakened in this patch.

## Limits and next work

Source citations support inspection, not runtime ordering, atomicity, delivery guarantees, replay safety or architectural intent. Projected connections remain INFERENCE. The stub groups directories into layers; it does not establish a validated architecture.

This patch improves notation semantics and evidence boundaries. It does not add native renderers for every remaining projected chart, prove model interpretations, or close the remaining broad-suite failures. Further work should migrate obsolete expectations to the typed semantic payloads while preserving meaningful evidence checks, then implement CRC/metrics-specific surfaces and the remaining compiler parity gaps.
