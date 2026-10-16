# Incremental concept-building performance

Base: origin/main 0337482. Work is isolated from the existing dirty checkout.

## Changes

- Reuse motif results for identical graph inputs across builds in the same server process. Only cache misses are sent to the Rust batch matcher, and duplicate graph inputs within a batch are matched once.
- Keys hash all matcher-relevant graph fields, including node names/IDs/operations/order, edges, locals, truncation and statement count. Entity ID, file, bodyHash and graphHash are not motif authority; results are rebound to the current entity ID and defensively copied.
- Worker path, device/inode, size and nanosecond modification/change times namespace the production cache. Missing workers still fail; replacing the binary invalidates cached motifs. Custom matcher overrides bypass the production cache.
- Bound the process cache to 5,000 entries and 16 MiB of serialized retained payload/key bytes using LRU eviction. This is not a process RSS/heap limit. Restarting the server starts cold.
- Fetch evidence once per entity per semantic build instead of up to five reads per concept. Evidence is always read for the current revision, never reused from the motif cache.
- Replace repeated previous-concept searches and Rust PDG response searches with maps.
- Add motif hit/miss/cache size statistics and the previously missing naming-phase duration to hierarchy build stats.

Global concept composition, invariant extraction, architectural construction, cross-axis links and naming decisions still run. The existing PDG/naming reuse rules remain. This patch does not yet implement dependency-based invalidation of those global phases or a durable motif cache.

## Measured result

Reproducible command (from repository root, with the release worker built):

```sh
node scripts/benchmark-concept-incremental.ts 1000 docs/testing/2026-10-16-incremental-concepts-benchmark.json
```

The script loads the actual baseline semantic builder from git, compares identical edited graph inputs, and asserts full concept-output equality on every round. The workload has 1,000 distinct 31-node graphs and changes one graph per round. Five rounds; no model, source indexing or architecture/persistence I/O. Evidence reads use a counting Store stand-in, so read-count improvement is measured but database latency is not.

| Metric | Baseline | Optimized |
| --- | ---: | ---: |
| Median semantic phase | 357.76 ms | 121.66 ms |
| Graphs sent to motif matcher per edit | 1,000 | 1 |
| Evidence lookup calls | 5,000 | 1,000 |

Semantic-phase speedup: **2.94x**, about **66% less elapsed time** in this workload. Full concept outputs matched. Optimized first cold build took 601.45 ms; the benchmark does not claim a cold-build speedup. Detailed round timings, cache statistics and limitations are in the companion JSON.

These numbers do not predict end-to-end speedup for a real repository, especially when model naming, indexing or global architectural work dominates. Cache hashing/copying has a cost, and large graphs may exceed the bounded cache. A representative repository profile is the next step before changing more global phases.

## Verification

setup-dev.sh completed; the release worker was built from the pulled sources with cargo build --release --locked. No Rust implementation changed. All 65 selected hierarchy tests passed. They cover cache invalidation, warm/cold output parity, single edits, current-revision evidence, limits/eviction, failure handling, PDGs, motifs, semantic composition, anchoring, naming and service integration. Core/web typechecks passed. No browser implementation changed.

```sh
node --test packages/core/test/concept-hierarchy-*.test.ts packages/core/test/concepts-entity-loads.test.ts
npm run typecheck
```
