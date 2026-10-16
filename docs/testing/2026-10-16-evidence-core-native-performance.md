# Native Evidence Core follow-up on latest main

Base: `acfafaf55ba73fa4a2b2994eb05b28ccc98a17ff` (latest `origin/main`
fetched and pulled for this task). This commit already contains the delivered
scope-performance patch. Work proceeded in a clean worktree; existing changes
in the older reviewer checkout were preserved.

## Change

Duplicate entity and evidence IDs now compare borrowed DTOs directly instead
of allocating temporary JSON values. SourceSpan, EvidenceRef and Entity derive
PartialEq; all their fields participate in the comparison. Optional omissions
and nested JSON values retain their existing comparison semantics. Fact and
relationship collisions compare the same payload fields as before, excluding
evidence so duplicate observations can still union support. The shared ID
namespace still rejects cross-kind collisions.

Streamed scopes now share one borrowed file-input digest map per batch. The old
scope emitter scanned every entity and rebuilt that map for every scope,
making many-file emission quadratic. Run identities, manifest fallback,
support sorting, byte/row budgets and stream checksums remain unchanged.

The scale benchmark's `--sample` mode accepts an optional final worker-binary
path so old and new releases can be compared without swapping executables.
No producer version, schema, flags, defaults or access rules changed. This
patch is incremental against the pulled main commit; previous patches need
not be applied again.

## Checks

- Repository setup and locked release build passed with Rust/Cargo 1.97.1.
- All 147 Cargo tests passed (3 harness, 144 worker).
- All 44 targeted Node tests passed across evidence-core, evidence-core-stream,
  evidence-core-delta, incremental-index and store-queries.
- TypeScript checks (`npx tsc -p tsconfig.json --noEmit`) passed.
- New mutation checks cover entity metadata and spans, evidence metadata,
  all fact/relationship payload fields, and fact/relationship shared-ID conflicts.
  Equal duplicates remain accepted; differing metadata remains rejected.
- Ten baseline/current comparison pairs on 60/600-file corpora (eight functions
  per file) have exactly equal complete worker batches, including inline metadata.
- All 12 enabled core-source samples have identical persisted metadata hashes.
- All six enabled many-file samples have byte-identical metadata JSONL streams.

## Measured results

Three fresh processes per variant, sequential execution without competing
builds/tests, alternating variant order. Same frozen sources for both binaries.
Raw data, per-stage timings and CPU/RSS counters are in the accompanying JSON.

| Corpus | Variant | Worker median |
|---|---|---:|
| 313 core source files / 105,888 support links | current off / inline | 3589.02 ms |
| Same | baseline on / inline | 4614.30 ms |
| Same | current on / inline | 4608.49 ms |
| Same | baseline on / stream | 4739.53 ms |
| Same | current on / stream | 4523.39 ms |
| 6000 files / 6000 one-line functions | current off / stream | 287.15 ms |
| Same | baseline on / stream | 3990.19 ms |
| Same | current on / stream | 483.24 ms |

Many-file native indexing improves **8.26x** (87.9% less time). The core-source
stream median improves 4.6%; inline is essentially unchanged. Core-source
normalization stage median changes from 558.59 to 443.57 ms; stream emission
and flush changes from 535.49 to 499.96 ms. Three samples are diagnostic and
do not establish production latency or a guaranteed speedup on other corpora.

Core-source Store medians were 4612.97/4374.11 ms for baseline/current inline,
and 4759.09/4551.34 ms for baseline/current stream. Host persistence code was
unchanged; these differences must not be attributed to a host optimization.
The many-file run measures native worker output only, not Store or application
latency. RSS values are individual process-lifetime high-water marks, not a
simultaneous aggregate memory bound.

The 1.15x native overhead gate remains **unmet**: core-source stream/off is
1.26x, and many-file stream/off is 1.68x. This patch does not close the grouped
performance milestone. Evidence Core remains off by default. Mixed-language
scale, full application latency, aggregate memory/concurrency and operational
cleanup remain acceptance work.

## Reproduction

Build a baseline worker at the base commit and retain it outside the target
directory. Build the patched release. Run:

```bash
node tools/bench/evidence-core-facts.ts /absolute/path/to/baseline-worker
node --max-old-space-size=1536 tools/bench/evidence-core-scale.ts --sample /fixed/source on stream /absolute/path/to/worker
```

Run the second command for each binary, plus current off/inline and enabled
inline variants, three times each in alternating order. Freeze the base commit's
`packages/core/src` at the source path before either binary indexes it. The
sampler uses 250,000 metadata rows, 128 MiB metadata bytes, 16,384 chunk rows,
8 MiB chunk bytes and a 1536 MiB host heap. Compare enabled metadata hashes.

For the many-file native case, generate `0.ts` through `5999.ts`, each containing
`export function fN(){return N;}` plus a newline, under one fixed directory.
Set `CIE_EVIDENCE_CORE_TRANSPORT=stream`, then invoke
`python3 tools/bench/worker-resource.py WORKER SOURCE on` for each binary and
`off` for the current binary, three times per variant in alternating order.
Hash each returned metadata handle before deleting it and the graph handle.
These native samples used the same 250,000-row/128 MiB metadata budgets.
