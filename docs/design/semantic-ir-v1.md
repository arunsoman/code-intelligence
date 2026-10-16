# Semantic IR v1: P02 contract and trust boundary

Schema: `cie.semantic-ir.v1`. Public API: `analysis_foundation::semantic_ir`.
This is a library boundary; no source adapter or application switch is added.
P01's `cie.analysis-foundation.v1` inventory API is unchanged.

## Data model

| Record | Contract |
| --- | --- |
| Snapshot | Schema, revision, producer version, environment digest, document/function maps |
| Document | Unique normalized repository-relative path, verified SHA-256, language, lowering and semantics versions, coverage gaps |
| Span | Document identity and nonempty half-open UTF-8 byte range |
| Function | Source owner, ordered parameters, return type, value types, entry and owned blocks |
| Block | Ordered instructions, source owner and exactly one terminator |
| Instruction | Identity, source, action and optional exceptional continuation |
| Call site | Ordered arguments and resolved candidate set or unresolved reason; binding evidence span |

IDs are separate Rust types. Documents/functions have snapshot scope. Block,
instruction and value IDs have function scope; consumers must use the function
identity with them when building global keys. Resource IDs are producer-defined
abstract locations; this schema does not resolve aliases or certify ownership.

Values have a single declared definition, either a parameter, instruction output
or invoke result. This is not yet validated SSA: dominance, availability on
exceptional paths, phi/block arguments and feasible execution are P04 work.
Declarations and argument order are checked, not inferred from spelling.

## Types and exact constants

- Unit, Boolean, UTF-8 string, bytes, integers, binary floats, decimal,
  references with a named model and opaque types with a reason.
- Fixed integer widths are 8/16/32/64/128; `bits: null` is unbounded. Signedness
  is explicit. Integer literals use canonical decimal strings; fixed-width
  range checks reject overflow. No JSON floating-point coercion is used.
- Binary32/64 literals use lowercase hexadecimal IEEE bit patterns in most
  significant digit order. NaN payloads and negative zero survive round trips.
- Decimal literals use canonical unscaled integer strings plus scale. Declared
  precision/scale are checked; trailing decimal significance follows the type.
- Byte literals use even-length lowercase hex. Empty strings/byte literals are
  valid. Opaque/reference types cannot masquerade as checked numeric constants.

Operators are explicit enum values. Operand/result type compatibility is checked.
Language-specific overflow, rounding, division, overloaded operations and other
runtime semantics are not inferred from these enums: a producer must reference
its versioned semantics, represent exceptions, or emit an opaque region/gap.
Unsupported operations are not rewritten to a similar supported operator.

## Control flow and calls

Normal flow follows instruction order, then the block terminator. Terminators:
goto, Boolean branch, return, raise, invoke and opaque control flow. Invoke has
an explicit normal successor and an exceptional continuation: a local block or
propagation out of the function. Instructions can also carry an exceptional
continuation. A missing instruction exception continuation asserts no modeled
exceptional exit; validation cannot establish whether that assertion is faithful.

Resolved call bindings contain a nonempty set of snapshot function identities,
with source evidence. Arity and exact parameter types must match every candidate;
captured results must match return types. Discarding a result is permitted.
Implicit conversions must be lowered explicitly or left opaque. Targets absent
from the snapshot must be unresolved, with a reason and evidence. The schema does
not assume a name denotes authorization or that a represented call succeeds.

Each successor must belong to its owning function. Return types and Boolean
conditions are checked. Raise carries an optional exception value; language
exception typing is not certified here. Opaque terminators carry possible local
successors, input values and a reason; unknown escape behavior must additionally
be recorded by the producer's coverage gaps.

## Source trust and coverage

`Snapshot::validate(&Sources)` requires the exact document set and source bytes
from the caller. It verifies SHA-256, UTF-8, byte boundaries, span nesting,
document/path consistency and referenced declarations. The library never follows
file paths or reads arbitrary disk locations. Producers supply language and
version fields; hosts must obtain bytes from their trusted revision/build snapshot.
Matching a digest does not authenticate the repository, generated-code origin,
dependency bindings or compiler configuration. `environmentDigest` identifies
that separate host-owned build model.

Coverage gaps have source regions and nonempty reasons. Opaque operations,
opaque types and unresolved bindings preserve their reasons in the wire format.
There is no semantic-completeness or verification verdict in this schema. P03
must add construct accounting and translation-fidelity tests; P04 and later
consumers must propagate unknowns. Structurally valid IR can still be mistranslated.

## Serialization, digest and compatibility

- Serde wire records reject unknown fields and enum variants. Identity maps reject
  duplicate JSON keys rather than overwriting records. Other typed validation is
  explicit: deserialization alone is not acceptance.
- `checked_digest` validates source and graph consistency before hashing the
  deterministic Rust serialization. Map order is sorted; instruction, parameter,
  argument and gap order is preserved. This is an exact input/provenance digest,
  not an identifier for semantic equivalence or an order-insensitive graph hash.
- Schema, revision, environment, types, literals, edges and producer versions
  participate. There is no claim of stable identity after local renames.
- Unknown schema versions are rejected. No implicit migration from the lossy
  similarity IR or P01 inventory is supported. An adapter requires a versioned
  explicit conversion and must disclose lost semantics.
- The checked-in JSON/source/SHA-256 vector pins this version's serializer output.
  A wire change requires compatibility review and, when incompatible, a new
  schema and vectors. Other runtimes must reproduce this representation or treat
  the digest as producer-owned rather than assume generic JSON canonicalization.

Example use:

```rust,ignore
use analysis_foundation::semantic_ir::{Snapshot, Sources};
let snapshot: Snapshot = serde_json::from_slice(&wire_bytes)?;
let sources: Sources = load_host_verified_revision_bytes()?;
snapshot.validate(&sources)?;
let input_digest = snapshot.checked_digest(&sources)?;
```

## Explicit exclusions and next boundary

No source parsing/lowering, executable interpreter, dominance/SSA proof,
reachability, alias analysis, memory model, business contract checking, solver,
async/concurrency model, source completeness certification, cache migration or
application integration is implemented by P02. Input memory/time limits belong
to the host; validation is not a sandbox for unbounded JSON. Repeated span checks
are not yet a scale-optimized source-validation pass.

The golden source/IR pair is manually authored to test this boundary, not evidence
that Python lowering is implemented. P03 is the source adapter and independent
translation-fidelity suite; it must preserve values, ordering and exception paths
and emit coverage gaps for constructs this version cannot faithfully represent.
