# Evidence core performance and resource limits

Incremental patch after native-delta checkpoint 8e63282. Defaults and producer
identities are unchanged.

Canonical association sort keys are now computed once per item per operation,
instead of serializing both operands on every comparison. Validation and
persisted binding checks remain independent; no cache survives a mutable batch.

Both full and delta Store transactions enforce a whole-revision limit of
100,000 rows per metadata table and 16 MiB of serialized persisted metadata
payload. Links are accounted as serialized arrays of their five payload fields;
run/coverage JSON is counted as UTF-8 bytes. This is a stored-payload cap, not
SQLite page usage or an exact reconstruction of the wire JSON envelope. It
includes unchanged provenance copied from a delta base. Exceeding either cap
aborts the transaction even in optional mode. Incoming wire limits still apply.

Validation: release build, 137 Cargo tests, typecheck and 22 targeted Node tests
passed. A fault-injection trigger enlarges stored coverage after validation;
the resource guard rejects the revision atomically and preserves its base.
Existing tests check exact metadata identity against full indexing.

## Measurement

Five samples per mode, fresh workers, warm filesystem, 60 files / 480 functions.
Raw samples are in 2026-10-15-evidence-core-performance.json. Final run was
sequential without competing test jobs. Medians in milliseconds:

| Operation | Off | On |
|---|---:|---:|
| Full index | 30.823 | 50.006 |
| Full persistence | 22.936 | 68.888 |
| Unchanged index | 3.287 | 3.716 |
| Single-file delta index | 14.804 | 20.405 |
| Delta persistence | 15.132 | 28.174 |

Enabled metadata: full 409,099 bytes; delta 1,960 bytes (99.52% smaller).
The earlier, sequential pre-change smoke run measured enabled persistence
74.418 ms; the final run measured 68.888 ms. These small samples are directional,
not proof of a durable speedup. Benchmark now also records unchanged/delta
latency and payload size. Database bytes include both held revisions. RSS is
sampled best-effort and is not memory acceptance evidence.

Full-index overhead is 1.62x, above the 1.15x target. Default enablement remains
blocked. Rust normalization/hashing profiling, larger repositories and reliable
peak-memory measurement remain follow-ups; this patch does not claim completion
of that performance roadmap.
