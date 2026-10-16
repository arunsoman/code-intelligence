# P03b — call binding and continuations

Base: P03a `3523023`. Patch: `cie-p03b-calls.patch`.
Default Java/TS/JS adapters now emit explicit P02 Invoke terminators, using the
existing semantic IR v1. Adapter/semantics versions advance to call v3.

## Call semantics

Calls are supported as return expressions, initialized locals, reassignment,
expression statements and nested arguments within the existing straight-line
subset. Argument expressions retain left-to-right order. Each invoke has a
distinct normal successor and an explicit exceptional exit propagated out of
the function. A result value is defined for the normal continuation only; calls
used as statements discard their results. JS fallthrough and Java void bodies
containing supported calls can end with unit return.

Receiver/member lookup can execute getters, nested receiver code or throw before
arguments run. The adapter emits that lookup as an opaque operation with a
propagated exceptional exit BEFORE argument instructions. Known receiver/local
dependencies are retained as inputs. This is an explicit approximation, not full
getter/receiver/this semantics or a promise to enumerate calls hidden inside it.
Java bare method lookup needs no corresponding ECMAScript lookup phase.

Unknown ECMAScript lookup/invocation may change local state, including through
direct eval. The adapter conservatively invalidates all local-value assumptions
around those phases. New opaque values replace old bindings; it must not return
a stale constant as established fact. This deliberately loses precision, including
for immutable locals. A later arithmetic operation may consequently force whole-
body fallback. Contextual call-result types are assumptions, never verification
that the external result has that type or represents success.

## Resolved versus unresolved bindings

Java resolution is restricted to unique same-class private static methods, bare
calls, supported exact parameter/return types and matching arity. Candidates are
indexed by class ownership and method name. Argument types are inferred before
binding checks; signatures cannot force literals to narrow or invent implicit
promotions. Unsupported overloads, generics, annotations, virtual calls, explicit
receivers, imports, native/absent bodies and unsupported signatures stay unresolved.

JS/TS call targets always stay unresolved in this slice: a lexical spelling is
not proof against rebinding, shadowing, ambient configuration or dynamic dispatch.
Binding evidence retains the source call span and the unresolved reason. The
document carries an explicit gap for each unresolved invocation. Binding a Java
method proves a declaration link only; an opaque callee body remains unknown.
Names such as `authorize` and `refund` do not establish effective business effects.

## Limitations and compatibility

Optional calls, spreads, exception handlers, branches, loops, async, constructors,
dynamic conversions and other unsupported constructs still force opaque fallback.
Exceptional exits are propagation only; no catch/finally/raise lowering, exception
type matching or executable provider model is claimed. Missing argument/global
value semantics may cause the whole candidate body to remain opaque. Existing
caller statements after a return still cause conservative fallback.

Every block has function-owned provenance; argument and lookup instructions and
binding evidence retain exact source spans. Value/instruction identities remain
unique across split blocks. Source compilation, SSA/dominance verification,
runtime provider behavior and application routing are not implemented here.
Existing source/IR expression goldens change only version fields. No schema or
existing worker indexing API changes are required. `semanticLower` consumes the
new default adapter versions automatically, outside answer/chart routing.

## Validation

Sixteen new tests cover print-only authorization, actual local delegation,
overloads, receiver lookup, nested arguments, captured/discarded results,
continuations, propagation, dynamic shadowing, eval/local-state invalidation,
optional/spread rejection and opaque callees. A narrow test-only interpreter
executes resolved integer calls and is compared with actual Java execution.
Getter/argument/call ordering and direct eval are checked with actual Node.
The interpreter refuses unresolved or opaque operations; it is not a production
execution engine or a proof of runtime correctness.

Next P03c: explicit branch/control-flow lowering and supported exceptional
statement fidelity. Whole P03 remains open; P04/P05 must establish analysis
projections/contracts before reporting source-level business defects.
