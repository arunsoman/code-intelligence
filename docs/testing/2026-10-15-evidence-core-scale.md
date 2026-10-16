# Patch 1 of 4: bounded metadata transport and scale measurements

Apply after nested-read checkpoint `2674c9b` (the nested-reads patch). This
implements the scale path and performance instrumentation/optimizations; it does
not mark the performance acceptance gate complete. Default mode remains off,
transport defaults to inline, coverage stays PARTIAL, and proof gates stay off.

## Transport and atomic staging

`CIE_EVIDENCE_CORE_TRANSPORT=stream` moves additive metadata to a private JSONL
handle alongside the existing graph handle. AnalysisBatch's serialized graph
shape is preserved. WorkerClient attaches an in-process, non-serializable handle
capability; it does not expose paths to models. Store consumes it in one write.
Cloning/serializing a streamed batch loses that capability: persist it in-process,
or explicitly release it with releaseCoreStream when abandoning it.

Each scope contributes one chunk, including evidence-free scopes. Records carry
sequence numbers, explicit scope, strict typed metadata, and a completion footer
with a SHA-256 checksum over exact chunk lines. Header revision, sequence,
expected scopes, links, producer/coverage identities, source bindings and footer
must all agree. A changed-file delta emits only changed scopes; unchanged file
metadata is copied, and repository scopes are recomputed.

Rust builds a scope's metadata directly from borrowed graph rows. It does not
build a whole-revision sidecar first. Reference grouping is bounded by the total
row budget. The TS reader uses fixed-size reads and a bounded line buffer;
validated scope metadata is released before advancing. Identifier bytes are preflighted before association allocation; final escaped wire bytes are checked by a bounded writer. A scope exceeding its
own row/byte budget is rejected; this version does not split a single producer
scope across multiple chunks. The legacy graph is still materialized in Rust
and TypeScript, so this is metadata streaming, not graph streaming.

Uncommitted rows in the existing SQLite tables serve as staging. No new migration
or durable staging table is needed: the outer transaction publishes the revision
only after stream completion and all checks pass. A savepoint lets optional
invalid metadata be discarded as a unit while keeping legacy rows. Strict or
storage/resource failures roll back the entire new revision. On a delta, copied
and incoming metadata must fit the combined revision budget.

Handles are removed after consumption/failure, on explicit release, at normal
host exit, or after collection of an abandoned batch. Worker-exit cleanup removes
unclaimed partial stream files while preserving claimed handles after worker
close. An abrupt host SIGKILL can leave temporary files; SQLite recovery still
rolls back the revision. The crash test cleans its orphan explicitly. Durable
orphan sweeping and a global concurrent-handle disk quota remain rollout work.

## Explicit budgets

All values are positive decimal integers; malformed, zero, and above-ceiling
values fail configuration validation in both runtimes. Defaults are unchanged.

| Environment variable | Default | Hard ceiling | Meaning |
|---|---:|---:|---|
| CIE_EVIDENCE_CORE_MAX_ROWS | 100,000 | 1,000,000 | Rows per metadata table per revision |
| CIE_EVIDENCE_CORE_MAX_BYTES | 16 MiB | 512 MiB | Stream wire and persisted metadata payload budgets |
| CIE_EVIDENCE_CORE_CHUNK_ROWS | 16,384 | 100,000 | Support links per scope chunk |
| CIE_EVIDENCE_CORE_CHUNK_BYTES | 8 MiB | 32 MiB | Bytes per JSON record, excluding terminating newline |

Revision bytes include the stream envelope on the wire; persisted bytes use run/
coverage JSON and serialized link payloads. Both checks apply. These limits do
not count graph rows, SQLite pages/indexes/WAL, heap allocation overhead, or
aggregate process RSS. The existing worker memory supervisor remains in place;
these flags are not a substitute for process/container memory and disk limits.

Large-core test settings (explicit opt-in, not new production defaults):

```bash
CIE_EVIDENCE_CORE_MODE=on
CIE_EVIDENCE_CORE_STRICT=1
CIE_EVIDENCE_CORE_TRANSPORT=stream
CIE_EVIDENCE_CORE_MAX_ROWS=250000
CIE_EVIDENCE_CORE_MAX_BYTES=134217728
```

The expanded schema ceiling and runtime budgets require matching updated worker
and TS components for large/streamed ingestion. Default inline behavior remains
compatible. Existing producer version 3, fact/edge/evidence IDs and file-run IDs
are unchanged; inline and stream revisions can alternate as delta bases.

## Measured optimizations and repository input repair

- Rust emits scope metadata from borrowed graph rows instead of cloning facts,
  relationships and entities into a temporary AnalysisBatch per scope.
- Canonical identity generation converts internally constructed serde Values
  directly to Canon, retaining numeric/depth/schema-key checks and removing a
  JSON serialize/reparse pass. Shared canonical vectors and complete-batch
  baseline comparisons check byte identity. Untrusted JSON parsing is unchanged.
- TS performs strict core validation once per chunk, rather than cloning it in
  both the outer transport schema and core validator.
- SQLite checks persisted owner/evidence membership with bounded JSON joins and
  inserts links in batches instead of one JS/native query round trip per link.
  Regression tests retain rejection of missing owners/evidence/membership.

Repository input hashing previously tried to canonicalize a manifest object with
an empty repository-owner key. Canon rejects empty schema keys. The new additive
`cie.evidence-core.manifest-input@1` domain hashes sorted entry tuples instead.
That root case previously could not produce valid metadata; existing file-run
IDs are unaffected. Shared Rust/TS vectors, inline persistence and streamed-root
regressions cover the repaired case. Old `input` identities are not relabeled.

## Validation

Release build, 144 Cargo tests (3 harness + 141 worker), 43 targeted Node tests,
and TypeScript checks passed. No additional dependencies were introduced.

Tests cover inline/stream exact persisted parity; mixed transport delta bases;
full/delta/unchanged equivalence; missing/duplicate/reordered/forged/truncated
chunks and wrong footer checksum; optional discard; strict rollback; SQL failure;
revision-wide exhaustion; bad flags; denied/revoked reads; worker cancellation
and partial-file cleanup; cross-connection visibility; and process death during
staging followed by SQLite integrity/recovery checks. Complete worker-batch
comparisons against the previous release binary cover 60/600-file corpora.

## Scale benchmark

The accompanying scale JSON records nine fresh Node/worker samples: three per
mode/transport, alternating order, on CIE's own core source. Every enabled sample
must produce the same persisted metadata digest. Native CPU/RSS counters come
from the Python fresh-worker helper; host peak RSS comes from Node resourceUsage.
Host heap is configured to 1536 MiB in benchmark children. Neither a simultaneous
aggregate-process peak nor an allocation trace is measured. No CPU/heap profiler
such as perf or Valgrind is installed. Runs are sequential without competing
tests/typecheck jobs; three samples are diagnostic, not a production guarantee.

The real corpus contains **313 files and 106,090 persisted support links**. All six enabled samples have exactly the same metadata digest. The final guarded-binary smoke run has the same digest and reusable producer version 3.

| Mode | Worker ms | Store ms | Transfer/parse + Store ms | Worker peak MiB | Host peak MiB |
|---|---:|---:|---:|---:|---:|
| off/inline | 4037.78 | 1354.15 | 6135.18 | 732.12 | 806.14 |
| on/inline | 5539.01 | 5326.07 | 12149.45 | 866.00 | 1216.02 |
| on/stream | 5713.76 | 5828.40 | 12532.72 | 778.77 | 927.96 |

Worker overhead is **1.42x**, above the **1.15x** target: **FAIL**. The subtotal excludes DB initialization, verification hashing, service-level naming and model work; it is not complete application latency. No default enablement is authorized by these measurements.

Peak counters are individual process-lifetime high-water marks, not a measured simultaneous aggregate. Small worker counters include a launcher floor. The timing snapshot preceded the final identifier-allocation preflight; the delivered binary was then re-tested and re-indexed against the same metadata digest. No post-guard speedup claim is made.

A separate three-sample-per-mode 600-file/600-function corpus exercises full,
unchanged and single-file delta operations, using fresh workers and persisted
bases. Its raw measurements are included separately. Do not compare its latency
directly with the much larger real-core corpus.

The scale path is reviewable, but the release gate remains open: full pipeline
latency, representative mixed-language scale, aggregate-memory/concurrency
acceptance and operational cleanup need further work before default enablement.
