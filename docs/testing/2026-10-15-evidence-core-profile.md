# Evidence-core stage profiling and typed emission

Apply after scope-validation checkpoint dc891e2. Default remains off. No schema,
identity, producer version, revision namespace or source access changes.

## Instrumentation and optimization

The existing opt-in CIE_WORKER_TIMING log now records normalization, delta
sharding, provenance emission, metadata wire-limit checking, and handle
serialization/flush separately, at sub-millisecond precision. It remains outside
AnalysisBatch and is inactive without the environment variable. Existing parent
stage entries and some shard/pass entries are cumulative: do not sum all labels.

A Python fresh-process harness records OS user/system CPU time and ru_maxrss,
alongside those stage times. RSS is a process-lifetime high-water mark, including
waited descendants and the launch/pre-exec floor, not simultaneous aggregate
process-tree memory. Tiny workers show an approximately 9 MiB floor. Larger
worker readings are more useful. It is not TypeScript-host peak memory.
CPU counters may exceed wall time because the worker uses parallel threads.

Neither perf nor Valgrind is installed. No call-stack CPU profile or allocation
trace was obtained. Stage timing identified provenance emission as the largest
Rust-side added stage on the 600-file synthetic corpus (~140 ms before).

The emitter now constructs final typed producer runs, links and coverage directly
instead of building an intermediate whole JSON object tree and deserializing it
back into those types. Association canonicalization and all identity rules remain
unchanged. This removes a concrete allocation/serialization pass, without claiming
measured allocation counts.

## Measurements

Full profiling uses three sequential samples per mode with alternating order:
TypeScript sample/Express fixtures, Java Spring fixture, CIE core source and a
600-file/4,800-function synthetic corpus. Source fixtures are not modified.
Raw before/after, full/delta and parity measurements accompany this report.
Some profiling overlapped host typecheck work: results are diagnostic, not a
controlled speedup or performance acceptance claim.

Final full-worker and Store medians (ms); worker excludes Python launch and host
JSON parsing, but includes worker startup, handle serialization and exit:

| Corpus | Files | Worker off | Worker on | Store off | Store on |
|---|---:|---:|---:|---:|---:|
| TypeScript sample | 6 | 26.27 | 28.18 | 1.50 | 6.25 |
| Express | 4 | 28.27 | 27.35 | 1.12 | 3.39 |
| Spring | 9 | 29.41 | 31.71 | 2.26 | 11.13 |
| Synthetic | 600 | 173.94 | 376.06 | 163.97 | 547.03 |
| CIE core source | 312 | 4033.50 | rejected | 1533.05 | unavailable |

Synthetic enabled provenance stage: 139.80 ms before, 81.81 ms final. Enabled
OS peak RSS: 101.31 MiB before, 83.82 MiB final. These are directional changes.
Standalone validation is measured as an extra call before persistence; it is
already included inside Store timing and must not be added to it.

A separate 600-file/600-function corpus tests native full/unchanged/delta modes:

| Operation | Worker off | Worker on | Store off | Store on |
|---|---:|---:|---:|---:|
| Full | 47.45 | 71.07 | 25.02 | 134.78 |
| Unchanged | 12.32 | 11.93 | no write | no write |
| Single-file delta | 38.45 | 39.76 | 20.37 | 51.29 |

Unchanged/delta workers are fresh processes; a persisted base is supplied. Delta
has fewer functions than the full-profile synthetic fixture; do not compare the
two synthetic tables as though their source workload were identical.

## Validation and release decision

Release build, 138 Cargo tests, 27 targeted Node tests and typecheck passed.
All ten baseline/current complete-batch comparisons passed on 60/600-file
synthetic corpora. A new test verifies that timing produces the expected stages
without changing AnalysisBatch. Existing full/delta parity, strict rollback,
resource caps and access-control tests remain green.

The 1.15x target is NOT met: the final full synthetic worker ratio is 2.16x,
and persistence adds substantial overhead. Ratios differ from earlier smoke
benchmarks because corpus size and measurement boundaries differ.

More seriously, enabled indexing of packages/core/src failed all three runs with
INVALID_SCHEMA / EVIDENCE_CORE_ID_COLLISION. Off indexing succeeded. This is a
newly observed compatibility blocker, not a performance success. Do not relax
collision checks or silently invent IDs. Investigate the colliding emitter and
add a minimal regression fixture before making any semantic correction.

Default enablement remains blocked by collision compatibility, performance,
larger representative corpora and missing host/aggregate-memory acceptance.

## Reproduce

- Build release worker first; run with no competing jobs where possible.
- `node tools/bench/evidence-core-profile.ts [absolute-worker-path]`
- `node tools/bench/evidence-core-delta-profile.ts`
- `node tools/bench/evidence-core-facts.ts /absolute/path/to/baseline-worker`

The Python helper uses the existing length-prefixed worker protocol, consumes
one handle response, and returns metrics plus the response. The TS harness reads
and deletes handles; temporary source/parameter directories are removed.
