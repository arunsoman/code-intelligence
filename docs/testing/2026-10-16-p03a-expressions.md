# P03a validation

Base P02a `38158aa`; patch `cie-p03a-expressions.patch`, applied after
`cie-default-language-adapters.patch`.

- `bash scripts/setup-dev.sh`: passed; Rust 1.97.1.
- `cargo test --workspace --locked`: 213 passed, zero failed (13 new expression,
  14 language, 21 semantic IR, 12 foundation, 148 worker, 2 worker CLI, 3 harness).
- `cargo clippy -p analysis-foundation --all-targets --locked -- -D warnings`: passed.
- `cargo build --release --locked`: passed; existing worker warnings remain.
- `cargo fmt -p analysis-foundation --check`: passed.

New fidelity evidence includes actual Java integer-overflow execution, JS/TS
expression execution, TS NaN strict equality, and three checked-in source/IR
golden vectors with validated source byte spans. Conservative cases include
side effects preceding/following return, dynamic values, unknown coercion,
short circuit, division, property writes, redeclaration, use-before-definition,
unsupported promotions and immutable binding reassignment.

Source runtime prerequisites remain Java 17+ compiler module and Node with
TypeScript stripping. No runtime is launched by production lowering itself.
No compiler-validity, complete-language, business-contract, call/branch/exception
analysis or answer/chart integration guarantee is added.
