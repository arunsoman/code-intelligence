# Rust evidence-core allocation reduction

Apply after performance/resource checkpoint 5ccd049. No schema, identity,
producer version or default changes.

Entity/evidence collision checks now retain borrowed records and serialize only
when an ID repeats. Equal duplicates remain accepted; conflicting duplicates
remain rejected using the same serde_json Value comparison. Fact/relationship
checks retain their existing shared collision namespace. Evidence span and
source-confinement validation are unchanged. The fallback repository manifest
identity is computed lazily, once, when a scope actually needs it.

Release build and 138 Rust tests passed (3 harness, 135 worker). All 22 targeted
Node tests passed, including canonical identity vectors, clean/full versus delta
metadata equivalence, known chained-call collision handling, revision limits,
rollback and default-off compatibility. A new Rust test specifically checks
both equal and conflicting repeated evidence IDs. TypeScript was unchanged.

Five sequential samples per mode, 60 files/480 functions, fresh workers and a
warm filesystem. Raw measurements accompany this report. Medians, milliseconds:

| Operation | Off | On |
|---|---:|---:|
| Full index | 29.791 | 47.687 |
| Persistence | 18.585 | 70.758 |
| Delta index | 11.243 | 17.511 |
| Delta persistence | 12.972 | 28.851 |

The preceding patch measured enabled full indexing at 50.006 ms and delta at
20.405 ms. These small samples suggest improvement but do not establish a
statistically robust speedup. Metadata payload sizes remain 409,099 bytes full
and 1,960 bytes delta. Enabled/off full-index ratio is 1.60x, still above the
1.15x acceptance target. Default mode remains off; broader CPU profiling,
larger corpora and trustworthy peak-memory measurement remain outstanding.
