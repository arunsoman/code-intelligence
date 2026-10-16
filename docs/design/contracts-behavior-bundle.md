# Bundle 2 — contracts and bounded behavioral detection

## Delivery and integration

Pulled upstream main `f902662` (P03a). Its tree exactly matched the existing local
P03a tree `3523023`; add/add merge conflicts were resolved by retaining the newer
delivered P03b/Bundle 1 files. Merge base for this bundle: `a9f7dfe`.

- `cie-contracts-behavior-bundle.patch` applies directly to upstream `f902662`.
  It includes the P03b and Bundle 1 changes not yet present upstream.
- `cie-contracts-behavior-incremental.patch` applies after delivered Bundle 1
  (`9983a3d` or identical tree after merge `a9f7dfe`).
- Apply ONE alternative. Neither patch includes a git pull or changes remote refs.

Public Rust API: `behavior::Registry::parse(bytes)` and
`behavior::check(snapshot, sources, registry, budget)`. Standalone worker:

```bash
target/release/worker semanticCheck \
  fixtures/behavior-contracts/unconditional-source.json \
  fixtures/behavior-contracts/unconditional-contracts.json
python3 scripts/demo-behavior-bundle.py
```

`semanticLower` exposes exact function/block/instruction identities to bind
contracts/models. `semanticCheck` lowers one source request and checks its exact
revision/environment registry. Cross-file callers can use the library with a
host-supplied validated multi-document snapshot; cross-file source linking is not
added here. This pathway is not wired into application answers, charts, indexing
or the TypeScript store.

## Authority and contract language

`cie.behavior-contracts.v1` records contract ID/key, exact FunctionId, finite
parameter domains, precondition, obligations, provenance authority/reference/
version, explicit supersession and optional display label.

Approved specifications and explicit annotations permit normative findings.
Test observations and hypotheses produce candidates only, whether the observed
check passes or fails. Authority is declared by the host/repository; this library
does not authenticate approvers or verify signatures. A hypothesis cannot
supersede or conflict-block an active normative contract. Multiple active
normative contracts with the same function/key yield Unknown until explicitly
superseded. Cycles, duplicate IDs, invalid supersession and stale scope fail
validation. Every supplied contract, including superseded entries, is validated.

Supported predicates: typed equality, numeric less-than, Not, And and Or over
arguments, return value and literal constants. Preconditions cannot refer to the
return. Obligations support:

| Obligation | Meaning |
| --- | --- |
| Ensures | Predicate holds on each completed normal return |
| RequiresEffect | Required represented/model-declared effect occurs before each selected normal return |
| RequiresCallResult | Latest completed call to the exact target returned the accepted value before each selected normal return |
| NoExceptionToSuccess | No handled exception appears in a trace ending in the selected success Boolean |
| OrderedEffects | Each `then` event has an earlier `first` event, on completed normal AND exceptional paths |

Effect events describe represented operations/model assumptions. They do not
prove a bank debit, provider action or refund actually succeeded. Non-completed
paths remain Unknown; detected protocol violations are currently reported on
completed paths. No normal completion is not certified vacuously, even for a
protocol-only contract.

## Finite mathematical model

For parameter domains D1…Dn, the input scope is their finite Cartesian product
D = D1 × … × Dn (one empty argument tuple when n = 0). Preconditions select a
subset of D; they do not assert anything about inputs outside D.

A machine state is `(call stack, block, instruction index, value map, trace)`.
Supported primitive operations induce concrete transitions. Exact-site external
models enumerate their declared outcomes. A resolved call must have exactly one
target: a candidate target set is not enough to establish a feasible witness.
Each transition consumes bounded work; finite path exploration includes normal
and exceptional continuations and concrete Boolean branch decisions.

For a normative contract, a stored completed trace violating an obligation gives
`violatedWithinModel`. A scoped satisfaction result requires exhaustion of the
entire declared domain/outcome exploration, at least one normal return, no gaps
and no exhausted bounds. This gives `satisfiedWithinDomain`, never an unbounded
proof. Unsupported, missing or unavailable values/semantics give `unknown`.
Non-normative authority always gives `candidate`. Completion is a separate axis:
`completeWithinModel`, `partial` or `budgetExhausted`. A recorded counterexample
can remain valid while the remainder of exploration is exhausted.

There is NO SMT solver, UNSAT certificate, abstraction refinement, inferred
inductive invariant or unbounded termination proof in this bundle. P07 remains
open. Concrete infeasible Boolean paths are excluded by evaluating actual
conditions, rather than treating every CFG branch as feasible.

## Value and source boundary

The concrete evaluator supports booleans, Unit, bounded strings, signed/unsigned
8/16/32/64-bit integers, bounded-i128 evaluation of unbounded integers, and
IEEE binary32/binary64 values. Fixed-width integers wrap; unsupported evaluator
range becomes Unknown. Float operations use the declared width, preserving
NaN/signed-zero semantics. Division exceptions require explicit IR exception
continuations. Decimal, references, bytes and concrete heap reads are unsupported.

Source adapters still define the source subset. Java source integer/Boolean and
TS/JS supported number/Boolean constructs are exercised end-to-end. Binary32
arithmetic and catch transformation tests also use manually constructed IR; they
do NOT claim new Java float/catch lowering. All opaque operations stop checking
unless an exact-site authoritative model covers them. Branch/loop joins remain
opaque, so this bundle does not silently make approximated values concrete.

## External models and evidence

A model binds FunctionId, BlockId, optional InstructionId and an exact checked
source span. Only unresolved invokes and opaque instructions may be modeled;
models cannot override known resolved code. Outputs must exactly match the
opaque instruction's output identities and types. Outcomes enumerate return or
raise behavior and ordered effect events. Models are contextual, exhaustive
assumptions for that site and declared input domain; actual provider correctness
must be established elsewhere. Opaque input values/call arguments must already
be available. Missing/ambiguous targets and memory values remain explicit gaps.

Findings embed the contract, function source, assumptions, counts, completion,
semantic digest and bounded counterexample inputs/traces. Model IDs, provenance
and versions remain inspectable. Digests bind checked IR/source/environment,
registry semantics and budgets; display labels are excluded from semantic
digests, including labels on conflicting contracts. Full input digests still
identify the exact request. Duplicate JSON model-output keys are rejected.

## Bounded rule candidates

Candidates include represented calculations, branch guards, calls, discarded
call results and returns, each with source location, revision, expression and
semantic ID. They are explicitly `unverified` and describe static represented IR
syntax only. They do not assert execution frequency, reachability, invariants or
expected business behavior. Extraction is capped at 10,000 report entries with
`candidatesTruncated`; a standalone bounded extraction API is also available.
State-transition inference, statistical mining, equivalence-based predicate
merging, candidate validation linkage and measured precision remain open in P10.

## Resource scope

Registry parsing has an 8 MiB input limit; counts, predicate depth/arity, domains,
models and effect arrays have validation bounds. Execution limits cover cases,
global steps, steps per path, pending path count, call depth and trace length.
Counterexamples have per-finding count and shared report event limits; discarded
evidence has an explicit truncation flag. A violation without a stored witness
is Unknown. Invalid inputs return errors; they are not business findings.
These are work/data-structure limits, not measured wall-time/RSS enforcement.
Validation, candidate traversal and host parsing are outside execution-step
counts. Durable checkpoints, cancellation and persistent caching remain Bundle 4.
