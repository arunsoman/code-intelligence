# D003 — Performance applicability and evidence

**Status:** Accepted product-policy baseline, 2026-10-06
**Origin:** GitHub issue #98, decision 3
**Unblocks:** #94 and #88

Performance applicability is determined from the candidate and workload, not chosen to make a gate pass. Changes touching request paths, data queries, loops over unbounded or large inputs, background jobs or shared resources are performance-applicable unless an authorized reviewer records a scoped rationale to the contrary.

Use the `pf-perf-core-v1` measurement method already specified by the implementation plan: equivalent baseline/candidate workload, at least 10 repetitions per case, p50/p95/p99, and bootstrap confidence intervals on the difference. If the interval crosses the budget limit, report **INCONCLUSIVE**. If required measurements or approved budgets are missing, report **UNVALIDATED**. Missing authority must never turn performance into NOT_APPLICABLE.

Budget limits must be supplied and signed by a bound performance/release authority. Implementers must not invent latency, throughput or resource thresholds. An authorized not-applicable declaration records its scope, rationale and principal and is reported as “not measured,” never as a performance pass.

### Demo measurements required by #94/#88

Before the golden-path feature run, define the workload script, data shape/size, environment identity, metrics/units, repetition count, budget source and authority binding for `fixtures/transactions-app`. Record CPU, memory, toolchain, repository size, relevant file/LOC counts, index time and stage durations where available. Publish actual measurements and uncertainty; do not turn one machine's values into universal product targets.

Until the environment and authority-bound budgets exist, performance eligibility remains UNVALIDATED or REVIEW ONLY. A demo may proceed for independent gates, but cannot claim complete performance verification.
