# Bundle 2 validation — 2026-10-16

## Repository base

`git pull --no-rebase origin main` fetched `f902662`. Upstream P03a exactly matched
local P03a `3523023`; add/add conflicts from patch-applied history were reconciled
by retaining delivered P03b/Bundle 1. Reconciliation commit: `a9f7dfe`.

Primary patch: upstream `f902662` → combined foundation plus Bundle 2.
Alternative incremental patch: Bundle 1 / merge tree → Bundle 2.
Both alternatives passed `git apply --check` against their stated base trees.

## Checks

| Check | Result |
| --- | --- |
| `bash scripts/setup-dev.sh` | Passed; Rust 1.97.1 |
| `cargo test --workspace --locked` | 285 passed, 0 failed |
| `cargo build --release --locked` | Passed; existing worker warnings remain |
| `cargo clippy -p analysis-foundation --all-targets --locked -- -D warnings` | Passed |
| `python3 scripts/demo-behavior-bundle.py` | Three release-worker cases passed |
| New behavior regressions | 38 passed |
| New worker CLI integration | 1 passed |

Release demo outcomes:

| Case | Conclusion | Inputs checked | Counterexamples |
| --- | --- | --- | --- |
| Unconditional success | violatedWithinModel | 2 | 1 |
| Valid delegation | satisfiedWithinDomain | 2 | 0 |
| Unavailable provider | unknown | 2 | 0 |

## Scope of evidence

Tests exercise contract authority, conflicts, supersession, malformed/stale
registries, duplicate model keys, exact source bindings, typed domains, label-free
semantic identity, explicit provider models, missing providers, print-only bodies,
ignored failures, valid delegation, branch bypasses, infeasible Boolean branches,
opaque joins, effect ordering, source hashes and model assumptions. Limits cover
work, cases, path steps, trace length, call depth, frontier, per-finding witnesses
and shared saved-event budgets. A retained witness survives partial exploration;
an unrecorded witness is not promoted to a verified finding.

Node independently executes the unconditional-success return pattern. Java
independently executes the private-static delegation pattern. Other tests inspect
counterexample arguments/events and source spans. The checked-in CLI fixtures use
real Java source lowering; no IR patching is required for those demos.

Exception-to-success, exception-result availability, memory effect ordering and
binary32 arithmetic also use manually constructed IR. They validate the generic
checker, not missing Java catch/float source translation. The suite does not
prove arbitrary compiler equivalence, unbounded path coverage, actual provider
behavior, eventual refunds, browser acceptance or enabled product routing.
No SMT solver or business-specification inference is claimed.
