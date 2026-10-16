# Evidence Core: scope-local host validation

This follow-up applies after `cie-evidence-core-scale-performance.patch`.
The recovered baseline is local commit `20ef83f`; all nine previously delivered
patches were restored at upstream `f4c845cd649bb1625bb1f9f6a90682ed4125b72f`
in an isolated worktree. Existing reviewer changes were preserved separately.

## Change

Streaming persistence previously supplied every file entity to `validatedCore`
for every scope. The validator rebuilt entity/file maps and scanned the entire
manifest for each chunk. Many small files therefore caused quadratic file work.

The transport now indexes file entities once, selecting each scope's file,
subject owners, and all referenced code-evidence source files. Cross-file
evidence remains checked. Delta scope completeness uses changed manifest keys
directly instead of scanning the full manifest for each chunk.

No identity, wire format, producer version, database schema, or configuration
changes. Source, support, coverage, checksum, persisted binding and atomicity
checks remain active. Evidence Core remains off by default.

## Validation

- Repository setup and locked release build passed with Rust/Cargo 1.97.1.
- All 144 Cargo tests passed (3 harness, 141 worker).
- All 44 targeted Node tests passed across evidence-core, evidence-core-stream,
  evidence-core-delta, incremental-index and store-queries.
- TypeScript `npx tsc -p tsconfig.json --noEmit` and `git diff --check` passed.
- New regression: synthetic cross-file evidence is accepted equally by inline
  and stream persistence; a forged source hash rejects both and rolls back.
- All enabled real-source samples before/after have identical persisted
  metadata hashes. All six many-file samples also have identical hashes.

## Measurements

Fresh Node and worker processes per sample, sequential execution without
competing tests/builds, three samples per variant. Sources were frozen before
the change. The existing `tools/bench/evidence-core-scale.ts` runner sets a
1536 MiB Node heap, 250,000 metadata rows and 128 MiB metadata budget;
chunk limits remain 16,384 rows and 8 MiB. Raw data is in the accompanying JSON.

| Corpus / transport | Store median before | Store median after |
|---|---:|---:|
| 313 core source files, off / inline | 1534.00 ms | 1471.49 ms |
| 313 core source files, on / inline | 6036.80 ms | 5574.55 ms |
| 313 core source files, on / stream | 6075.21 ms | 5891.52 ms |
| 6000 one-function files, on / stream | 18883.37 ms | 4050.32 ms |

The real-source corpus contains 105,778 support links; the synthetic corpus
contains 18,000. The many-file Store median improves 4.66x (78.6% less time).
Its host peak RSS median falls from 356,261,888 to 277,843,968 bytes. This is a
process-lifetime high-water mark, not a simultaneous process-tree memory bound.

Before/after series were run in groups rather than interleaved. The real-source
3.0% stream Store reduction is small relative to other timing variation; no
reliable real-source speedup is established by these samples. The native binary
was unchanged. Real-source worker stream/off ratios were 1.24x before and 1.40x
after, both exceeding the 1.15x gate; variation is not a native regression claim.
No default enablement is justified. End-to-end application latency, mixed-language
scale, aggregate memory/concurrency and operational cleanup remain open gates.

## Reproduction

Run `bash scripts/setup-dev.sh`, `cargo build --release --locked`, then use
`node tools/bench/evidence-core-scale.ts PATH_TO_FROZEN_CORE_SOURCE` before and
after applying this patch. Copy `packages/core/src` from the restored baseline
to that fixed source path before either run. The runner asserts inline/stream
metadata parity; compare enabled metadata hashes across the two output files.

For the many-file fixture, create a fixed directory containing `0.ts` through
`5999.ts`, each with `export function fN(){return N;}` followed by a newline.
For each version run this command three times:

```bash
node --max-old-space-size=1536 tools/bench/evidence-core-scale.ts --sample PATH_TO_FIXED_FIXTURE on stream
```

Compare metadata hashes before reporting medians. These diagnostic runs do not
establish production latency or runtime behavior of any indexed application.
