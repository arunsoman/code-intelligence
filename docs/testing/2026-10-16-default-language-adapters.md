# P02a default languages and adapter discovery

Base: P02 commit `48f1ba2`; delivery: `cie-default-language-adapters.patch`.
Applies after `cie-p02-semantic-ir.patch`.

## Scope

Java, TypeScript/TSX and JavaScript/JSX default registrations, actual parser
grammars, shared literal-return lowering and explicit opaque regions. Public
adapter trait and automatic build-time `.rs` discovery. Existing indexing,
store, answers and charts are unchanged. See `docs/design/language-adapters.md`.

## Validation

- Rust setup command completed with Rust 1.97.1.
- `cargo test --workspace --locked`: 200 passed, zero failed (14 source-adapter,
  21 semantic IR, 12 foundation, 148 worker, 2 worker CLI and 3 harness tests).
- `cargo build --release --locked`: passed; existing worker warnings remain.
- `cargo clippy -p analysis-foundation --all-targets --locked -- -D warnings`: passed.
- `cargo fmt -p analysis-foundation --check`: passed.
- `CARGO=/root/.cargo/bin/cargo python3 scripts/test-language-adapter-discovery.py`:
  passed; one temporary adapter file registered without dispatch/module-list edits.
  The probe was removed; normal builds contain only the builtin adapters.

## Evidence covered

- Default extensions: java; ts/mts/cts/tsx; js/mjs/cjs/jsx.
- Actual Java/Node execution comparison for Java long precision, JS Number
  rounding and TS negative zero. Tests require Java 17+ compiler module and
  Node with TypeScript stripping; production lowering requires neither runtime.
- Java integer range/suffix and legacy octal cases; BigInt exactness.
- Typed constants retain source byte spans; syntax recovery stays opaque.
- Print-only functions, delegation, branches, default parameters, unknown return
  annotations, async, getters and constructors cannot become pure literal bodies.
- Duplicate IDs/extensions, unknown paths, empty input and unrelated custom
  adapter output are rejected. Registry binds output to request source, path,
  revision, environment and advertised adapter semantics.
- CLI metadata and real-source lowering exercise the actual worker binary.

## Limits

Literal-return lowering only; no complete language, source-level anomaly or
business-contract verification claim. Modules always carry an explicit scope
gap. Broader P03/P09/P17 tasks remain open. Adding an adapter file is automatic
registration, not automatic semantic implementation. New parser packages still
require dependency changes and independent fidelity tests.
