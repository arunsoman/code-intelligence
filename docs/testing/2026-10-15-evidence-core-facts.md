# Lazy fact collision payloads

Incremental patch after 4532bac (Rust allocation patch). No identity, schema,
producer version, revision namespace or default changes.

Fact/relationship validation now retains borrowed observations in the shared ID
namespace and constructs the previous JSON payload only for a repeated ID.
Conflicting cross-kind IDs still fail according to the same array comparison.
The known-collision normalizer skips payload generation for IDs outside its two
eligible legacy prefixes. These facts still pass the generic collision checker;
they do not bypass validation. Span validation and resource limits are unchanged.

## Verification

Release build, Cargo workspace (138 tests), targeted Node suites and TypeScript
checks passed. Existing tests cover arbitrary duplicate conflicts, chained-call
repair, exact delta/full equivalence, access controls and resource rollback.

The new benchmark accepts an optional previous worker executable. With that
argument it compares complete AnalysisBatch outputs using deep equality, not
only hashes or counts. It alternates baseline/current ordering over five fresh
workers per variant, on 60-file and 600-file corpora (eight functions/file).
All ten baseline/current pairs had exactly equal output, including sidecars.
Raw samples are in 2026-10-15-evidence-core-facts.json.

| Corpus | Previous worker median | Current median | Reduction |
|---|---:|---:|---:|
| 60 files / 480 functions | 55.036 ms | 51.047 ms | 7.25% |
| 600 files / 4,800 functions | 580.329 ms | 552.362 ms | 4.82% |

These are small synthetic samples, not production latency guarantees. Source
inspection identified eager serialization; no CPU flamegraph or allocation
profiler was run. This comparison measures enabled versus previous enabled,
not enabled/off acceptance. The 1.15x acceptance target remains open and default
mode stays off. Peak-memory measurement and broader profiling remain pending.

Reproduce with `node tools/bench/evidence-core-facts.ts /absolute/path/to/previous/worker`.
Without the optional argument it records current timings without asserting
baseline parity. The previous binary is not distributed in this patch.
