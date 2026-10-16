# Evidence Core: performance, reproducibility and recovery

Incremental patch after `cie-evidence-core-native-performance.patch`, local
baseline `16c666c` (on upstream `acfafaf`). Evidence Core remains off by default;
this does not complete the grouped performance milestone.

## Feature gains and availability

| Capability | What changed / user benefit | Availability |
|---|---|---|
| Stable concept labels | Equal-frequency heuristic names now break ties by UTF-8 name bytes. Identical source no longer receives random labels. | New fix, including default/off mode |
| Stale metadata recovery | A dead host's claimed stream handles can be reclaimed after 24 hours, with a reclamation-count diagnostic. Live hosts/workers, unknown owners, foreign namespaces and symlinks are retained. | New, Linux stream transport; checked at WorkerClient creation, at most hourly |
| Less duplicate hashing work | Borrowed JSON canonicalization avoids cloning a Canon tree; canonical support sort keys are reused for the output digest. | New optimization for enabled metadata; IDs and wire format preserved |
| Mixed-language incremental reuse | Verified full, unchanged and edit/add/delete flows for 500 TypeScript/Java/Python/Go/Rust files; final graph and metadata equal clean indexing. | Existing capability, newly validated beyond TypeScript |
| Concurrent-resource validation | Reusable harness measures summed RSS of concurrent process trees and stops its workload on budget exhaustion. | New acceptance tooling; not a production job scheduler or global quota |
| Versioned evidence trails | Stored support links bind observations to source evidence, producer runs and revisions. | Foundation from earlier patches; optional backend metadata |
| Explicit partial coverage | Coverage records include limitations and exclusions; no closed-world/runtime guarantee is asserted. | Foundation from earlier patches; coverage gates remain disabled |
| Bounded atomic metadata persistence | Stream row/byte limits and transactional staging reject tampering or failures without publishing partial revisions. | Foundation from earlier patches, regression-tested again |

The new user-visible change is stable concept naming. Recovery and performance
improvements operate in the backend. No new language parser or visualization UI
was introduced by this patch; downstream presentation/answer consumers still
need their own integration with the optional provenance data.

## Correctness findings and fixes

The mixed-language comparison exposed a pre-existing nondeterministic choice:
`cluster_concepts` selected the most frequent name using HashMap iteration when
counts tied. The fix preserves frequency priority and selects the smallest
UTF-8 name on a tie. A repeated Java-class fixture asserts `Alpha` consistently.
Mixed-workload comparisons exclude only the baseline's unstable heuristicName;
all other batch fields match. Current labels match across all nine mixed runs.

Canonicalization retains shared quote rules, ASCII schema-key checks, safe
integers and depth limits. It accepts constructed serde values, not unvalidated
external JSON: strict parsing remains authoritative for duplicate keys and
lexical negative zero. Tests compare canonical bytes/digests against the strict
path across Unicode, control characters, nesting and numeric/key limits.
Output digest assembly reuses sorted canonical association strings, including
deduplication, rather than re-serializing a cloned association tree.

Stream claim markers are private zero-byte files. They contain a boot/PID-
namespace fingerprint and the host PID in their filenames; they never enter
AnalysisBatch or model inputs. Normal release/finalization/exit removes claims.
The reclaimer requires an owned regular data file, owned regular claim files,
dead host and worker PIDs in the same boot/namespace, and a minimum age of 24h
for data and claims. Inaccessible PIDs are treated as live. Unknown and reused
PIDs are retained conservatively. Linux/proc unavailability disables reclamation.

The SIGKILL-during-staging regression now checks database integrity/no partial
revision, then verifies recent files are retained and aged dead-host handles
and their claims are reclaimed. Live hosts/workers, foreign markers and both
data/claim symlinks are negative cases.

## Measured performance

Raw results are in the accompanying JSON. Baseline/current use the same frozen
source and release binaries, three fresh sequential processes per variant,
alternating order, without concurrent builds/tests. The core corpus is 313 files
and 105,888 support links. Three samples are diagnostic, not production SLO proof.

| Corpus / metric | Baseline | Current |
|---|---:|---:|
| Core, enabled stream emission + flush stage | 567.26 ms | 319.05 ms |
| Core, enabled stream worker wall | 4510.58 ms | 4342.68 ms |
| Core, enabled inline worker wall | 4606.43 ms | 4534.96 ms |
| 6000 one-function files, enabled stream worker wall | 532.80 ms | 468.47 ms |
| Core, enabled stream Store | 4490.02 ms | 4868.88 ms |
| Core, enabled stream transport/parse + Store subtotal | 10130.00 ms | 9850.92 ms |

Emission falls 43.8%; the many-file worker median falls 12.1%. Core stream
worker wall improves 3.7%, while Store varies upward 8.4%. The measured subtotal
improves 2.8%; no broad end-to-end application speedup is established. The
subtotal excludes DB construction, verification hashing, naming/model work and
UI/service latency. Core peak RSS is essentially unchanged: stream worker
816,496,640 -> 816,226,304 bytes; host 976,310,272 -> 973,672,448 bytes. These
are separate high-water marks, not simultaneous process-tree memory.

Current off core worker median is 3930.69 ms, so enabled stream/off is 1.10x
in this run, within the 1.15x native target for this corpus. The 6000-file off
median is 293.31 ms: enabled/off remains 1.60x and fails the same target.
The performance gate therefore remains open across workloads.

## Five-language workflows

Synthetic corpus: 100 files per language, with calls, fields, control flow and
exception paths. Three repetitions per mode. The same worker stays alive for
full/unchanged/delta operations to exercise its incremental cache. Every delta
edits Python, deletes Go and adds Java, then compares the persisted graph and
metadata with a clean full index. All nine comparisons pass; removed files
lose their metadata and added files acquire it. Initial diagnostics were empty.

| Median, ms | off / inline | on / inline | on / stream |
|---|---:|---:|---:|
| Full index RPC including handle read/parse | 109.47 | 144.64 | 155.92 |
| Full Store | 63.64 | 244.39 | 428.38 |
| Unchanged index | 9.51 | 9.73 | 8.79 |
| Delta index RPC | 35.84 | 43.41 | 44.86 |
| Delta Store | 62.66 | 112.26 | 109.01 |

These are supported-language synthetic workloads, not representative production
framework dependency trees. Full/delta RPC timings include host transport and
cannot be equated with the native-only 1.15x gate. Existing discovery excludes
`.js` files; no JavaScript indexing claim is made by this five-language result.

## Concurrency and memory

Two independent fresh Node/worker/Store jobs run concurrently. The harness
samples summed process-tree RSS at a nominal 20 ms interval. It resolves local
PIDs through NSpid when /proc is mounted from an outer PID namespace, and refuses
to report an all-zero/unobservable result. An initial invalid zero-RSS run was
discarded; only corrected measurements are in the saved data.

| Workload | Repetitions | Observed aggregate RSS peaks | Test budget |
|---|---:|---:|---:|
| Two 500-file mixed-language jobs | 3 | 307.15 / 307.12 / 301.84 MiB | 1536 MiB |
| Two dense core-source jobs | 1 | 1859.23 MiB | 3072 MiB |

All job results have matching persisted metadata hashes. The mixed jobs use a
768 MiB V8 heap per host; dense jobs use 1536 MiB. Metadata limits are 250,000
rows/128 MiB per revision with 16,384-row/8 MiB chunks. A separate 1 MiB budget
test stops two sleeping child processes and reaps their process groups in 34 ms.
This exercises the harness's guard, not a new CIE-wide admission mechanism.

RSS sums can double-count shared pages and polling can miss transient peaks.
These sampled results do not guarantee an aggregate memory ceiling or laptop
capacity. The dense concurrency run demonstrates substantial simultaneous use.

## Validation and remaining gates

- Locked release build and all 150 Cargo tests passed (3 harness, 147 worker).
- All 127 selected Node tests passed, including canonical contracts, structural
  concepts, provenance/delta/stream/cleanup and Store regressions; typecheck passed.
- Ten 60/600-file baseline/current pairs have exactly equal complete batches.
- All 12 enabled dense-source samples have equal persisted metadata hashes;
  all six enabled many-file streams have byte-identical JSONL metadata.
- Three baseline/current mixed comparisons match all fields except intentionally
  stabilized heuristic labels; nine clean/full-versus-delta comparisons pass.
- Concurrent metadata parity, memory-budget rejection and SIGKILL recovery pass.

Still open: native <=15% overhead across all corpora; production-scale real
mixed-language applications; complete service/model/UI latency; global memory
and job admission; and comprehensive temporary-storage quotas/recovery. The
new reclaimer intentionally retains unclaimed artifacts, missing-data markers,
other users' files and foreign boot/namespaces. It does not reclaim abandoned
graph handles or replace disk quotas. No default enablement is justified yet.

## Reproduction

After repository setup and a locked release build, retain the baseline worker
from `16c666c`, then build the patched binary. Freeze baseline core sources at a
separate fixed directory. Run sequentially:

```bash
node tools/bench/evidence-core-facts.ts /absolute/baseline-worker
node tools/bench/evidence-core-compare.ts /fixed/core-source /absolute/baseline-worker
node tools/bench/evidence-core-mixed.ts /absolute/baseline-worker
python3 tools/bench/process-tree-memory.py --jobs 2 --budget-mib 3072 -- node --max-old-space-size=1536 tools/bench/evidence-core-scale.ts --sample /fixed/core-source on stream
```

Generate the fixed mixed corpus using `populateMixed` in
`tools/bench/evidence-core-workloads.ts`; run the memory command three times on
that corpus with a 1536 MiB budget and 768 MiB host heap. For the many-file
native comparison use the prior one-function `0.ts`..`5999.ts` fixture and
`worker-resource.py`, as described in the native-performance report.
