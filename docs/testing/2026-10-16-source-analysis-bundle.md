# Bundle 1 validation — 2026-10-16

Base: local P03b `b5711fc`. Alternative cumulative base: P02a `38158aa`.

- Required setup: `bash scripts/setup-dev.sh`, successful.
- `cargo test --workspace --locked`: 246 passed, 0 failed.
- `cargo build --release --locked`: passed (existing worker warnings remain).
- `cargo clippy -p analysis-foundation --all-targets --locked -- -D warnings`: passed.
- Formatting: changed foundation files formatted with rustfmt. Existing worker
  formatting retained outside the edited CLI branch.

Seventeen added tests comprise sixteen bundle regressions and one CLI integration.
Node/Java execution comparisons exercise boolean branches and early returns;
Node comparisons cover loop outcomes and thrown-provider catch behavior. The
bounded test IR interpreter rejects opaque operations rather than inventing their
values. Branch joins, loop backedges/updates, scoping, unsupported finally/break,
throws, exception routing, dominators, data/control dependencies, bounded slices,
work/node/dependency exhaustion, recursive SCCs, transitive unknown gaps, memory
effect provenance, source-hash rejection and deterministic JSON are covered.

These are selected execution comparisons and structural regressions. They are
not equivalence proofs for all Java/JS/TS programs, browser acceptance, payment
failure injection or application answer/chart validation. Both patch variants
were checked with git apply against their declared local bases.
