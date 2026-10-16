# Default languages and file-discovered adapters

P02a, applied after P02. The reusable Rust semantic pathway now registers Java,
TypeScript and JavaScript automatically. This does not replace existing worker
indexing or enable the new pathway in answers/charts.

## Default registrations and capability boundary

| Language | Extensions | Parser | Semantic lowering today |
| --- | --- | --- | --- |
| Java | java | tree-sitter-java | Method envelopes and supported literal-only returns |
| TypeScript | ts, mts, cts, tsx | tree-sitter-typescript, TSX grammar for tsx | Function/method/arrow envelopes and supported literal-only returns |
| JavaScript | js, mjs, cjs, jsx | tree-sitter-javascript, including JSX | Function/method/arrow envelopes and supported literal-only returns |

No configuration is needed to select these adapters. Registry metadata advertises
the limited semantic scope; an extension registration never means all language
semantics are implemented. All declarations produce validated P02 records or
explicit opaque regions. Syntax recovery cannot produce trusted literal bodies.
Named syntax nodes have an audit disposition; wrappers/metadata not separately
modeled remain opaque. Missing zero-width recovery nodes are covered by the
whole-document syntax-error gap.

Supported literal semantics include Boolean, double-quoted strings in a restricted
escape subset, Java decimal integer/long returns, ECMAScript finite decimal
Number and decimal BigInt. Java integer width/range and suffix rules are checked.
JS Number uses IEEE Binary64 including rounding and signed zero. BigInt stays an
exact integer string. Unsupported octal/hex forms, Java string escapes and unknown
type coercions are opaque rather than approximated as another value.

Branches, calls, printing, delegation, loops, default/rest/destructured parameters,
async/generator/accessor/constructor semantics, synchronization, exception handling,
module initialization, imports and framework bindings are NOT semantically lowered
by this slice. A body outside the supported subset becomes an opaque terminator
with a source-linked gap. Every document additionally reports its excluded module
semantics. No complete-program, purity or authorization-success claim is made.

Parameter typing is best-effort; unresolved types remain opaque. Function IDs
include path/start offset/kind and are not rename/edit-stable semantic identities.
Full construct accounting, parameter binding semantics and identity lineage are
still roadmap work. Empty sources require explicit host exclusion, not a fabricated
nonempty source span.

## File-only adapter registration

`build.rs` discovers and sorts all `.rs` files in
`crates/analysis-foundation/src/languages/adapters/`, then generates modules and a
registry. Adding/removing a file triggers regeneration on the next Cargo build.
There is no central module list, language match or extension table to edit.
Each file exports `pub static ADAPTER` implementing `LanguageAdapter`:

```rust,ignore
use super::{LanguageAdapter, Metadata, Request, Lowered};
pub struct MyAdapter;
pub static ADAPTER: MyAdapter = MyAdapter;
impl LanguageAdapter for MyAdapter {
    fn metadata(&self) -> Metadata {
        Metadata {
            id: "my-language", extensions: &["mylang"],
            adapter_version: "my-adapter.v1", semantics: "my-semantics.v1",
            semantic_scope: "state exactly what is modeled",
        }
    }
    fn lower(&self, request: &Request) -> Result<Lowered, String> {
        // Parse source, lower supported semantics and retain unsupported regions.
        // Return P02 Snapshot, source bytes and syntax accounting records.
        todo!("implement the language semantics and fidelity tests")
    }
}
```

The example is a contract sketch, not a functioning adapter. Duplicate adapter IDs
or case-normalized extensions fail registry construction. Unknown extensions fail
explicitly; no fallback parser guesses a language. Registry consumers validate every
returned snapshot and source digest, including custom adapter results.

The three builtins use a shared `TreeAdapter` for their narrow subset. A new
language can implement the trait directly without modifying its Java/ECMAScript
profiles. If its parser is not already a dependency, Cargo.toml/Cargo.lock changes
are also necessary. Semantic implementation and independent tests are always
necessary. This is compile-time trusted Rust extension, not hot loading arbitrary
user code, a runtime sandbox, or automatic discovery of language semantics.

## Entry points

```
worker semanticLanguages
worker semanticLower request.json
```

`semanticLower` takes exactly one request file with `path`, `source`, `revision`,
and `environmentDigest`; it returns validated `snapshot`, source bytes and
`constructs`. It never follows a source path on disk. The caller owns source
authentication and size/time limits. The command reads its request file as usual.
This slice does not add framed-RPC, TypeScript-store or UI routing.

## Validation and continuing work

The tests require Node with TypeScript stripping (tested Node 24) and Java 17+
with its compiler module for source-file execution. These are explicit fidelity
test prerequisites; the current Rust setup script does not install Java. Production
parsing/lowering itself does not launch Java or Node.

- Cross-language registration/extension tests include TSX/JSX.
- Java long, JS Number rounding and TS signed zero are compared with independent
  Java/Node executions, not only expected IR built by the same lowering code.
- Rebound/dynamic calls, print-only code, default parameters, syntax recovery,
  invalid literal ranges, unknown return types and async forms stay opaque.
- `scripts/test-language-adapter-discovery.py` adds one temporary adapter file,
  builds the actual worker, checks its registration and removes it in `finally`.
  Run in an isolated checkout without concurrent builds; set CARGO if necessary.

Next P03 extends these default adapters toward expressions, real calls, branching
and exception flow. Python becomes an additional adapter rather than a prerequisite
for using Java/TS/JS. P09 still owns Java/Spring binding/transaction semantics;
P17 still owns broader TS/JS asynchronous and dynamic semantics.

## P03a capability extension

The literal-only scope above records P02a. P03a extends each default adapter to
supported straight-line locals, references and selected expressions. Adapter and
semantics versions advance to expression v2. See `straight-line-expressions.md`
for the current contract, exclusions and TypeScript runtime-type assumptions.
