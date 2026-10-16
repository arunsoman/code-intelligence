# P03a — straight-line source expressions

Applies after P02a (`38158aa`). Reuses default Java, TypeScript and JavaScript
adapters and the P02 semantic IR. No new language registration or dependency.

## Delivered scope

- Parameter references; parameters retain declared types where supported, otherwise
  explicit opaque types. No type is guessed from a parameter/function name.
- Initialized local declarations and simple local reassignment with distinct value
  definitions. Name lookup follows the supported straight-line environment.
- Parentheses, Boolean negation, numeric negation, addition, subtraction,
  multiplication, less-than and supported primitive equality.
- Java int/long operations retain width and Java wrapping semantics. Unsupported
  mixed-width promotion is conservative; no eager widening that changes overflow.
- JavaScript/TypeScript Number uses Binary64; BigInt stays unbounded integer.
  String concatenation, coercive JS equality and unsupported numeric domains are
  not silently mapped onto numeric operators.
- Java primitive `==` and ECMAScript strict `===` for supported operands.
  String/reference equality is excluded. NaN behavior follows Number semantics.
- Final returns and supported expression-bodied arrows. Bare return is supported
  where the modeled return type is unit; implicit fallthrough remains opaque.
- Whole-body fallback on any unsupported statement or invalid binding. Partial
  candidate instructions are discarded atomically; prior effects cannot disappear.

Syntax wrappers and unmodeled regions retain audit dispositions. Module semantics
remain excluded explicitly. TypeScript parameter annotations are assumptions,
not runtime enforcement; successful lowering records a source-linked assumption
gap. Unknown JS parameter types support value-preserving identity but not numeric
arithmetic. Java source is not compiler-typechecked by the production adapter.

## Intentional exclusions

Calls/delegation/printing, branching, loops, short-circuit operations, division,
remainder, compound assignment, property writes, closures, aliasing, shadowing,
uninitialized locals, async, generators, constructors and exception handling
remain opaque. Unsupported statements after a return also cause fallback,
rather than rely on unimplemented reachability reasoning. Unknown conversions,
redeclared bindings, use before definition and const/final reassignment fail
conservatively. The source parser can accept compiler-invalid code; this slice
does not certify source compilation.

Straight-line expression recursion is capped at 128; bodies over 4096 statements
fall back to opaque. These are not global request memory/time limits. Deep or
unsupported expressions do not claim that no behavior exists.

## Provenance and cache compatibility

Instructions preserve source expression/assignment byte spans and execution order.
Values have distinct definitions; local reassignment emits Copy to a new identity.
Function IDs continue to use path/start/kind; rename lineage is not solved here.
Adapter and semantics versions advance from literal v1 to expression v2, ensuring
that caches keyed by those versions cannot silently reuse older lowering results.
There is no IR schema migration: this uses existing v1 records and operators.

## Validation

Thirteen new tests cover supported execution and conservative rejection. Three
source-to-IR golden snapshots pin full records, values, order, gaps and spans.
They are regression fixtures generated from the implemented adapter and reviewed
alongside independent source executions, not an independent proof of translation.

The test-only straight-line IR evaluator is deliberately narrow. Tests compare its
results with actual Java and Node execution for Java overflow, JS/TS expression
chains and NaN strict equality. It is not a production interpreter or a verifier.
Oracle temporary files use unique per-process sequence IDs to avoid parallel-test
collisions. The full workspace has 213 passing tests.

P03 remains incomplete. Next: explicit calls/bindings and their normal/exceptional
continuations, then branch/control-flow fidelity, before claiming anomaly detection.
