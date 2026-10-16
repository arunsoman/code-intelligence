# Rust analysis foundation validation

Base: origin/main `4a748fd`.

- `bash scripts/setup-dev.sh`: passed, Rust 1.97.1.
- `cargo build --release --locked`: passed; existing worker warnings remain.
- `cargo test --workspace --locked`: 164 tests passed (12 foundation, 1 CLI,
  148 worker unit tests, 3 defect harness tests), zero failed.
- `cargo clippy -p analysis-foundation --all-targets --locked -- -D warnings`: passed.
- `cargo fmt -p analysis-foundation --check`: passed.
- `git diff --check`: passed.

New regression coverage: print-only inventory does not imply authorization;
multi-hop delegation evidence/effects; unresolved providers and producer gaps;
recursive fixed-point convergence; budget exhaustion; removed callee invalidation;
transitive changes; semantics/environment changes; deterministic fingerprints;
revision provenance refresh; malformed schema/identity/source rejection; real
worker CLI success/error serialization.

These are normalized-inventory tests, not end-to-end source extraction or business
contract verification. The library provides an invalidation plan; persistent
cache reuse, checkpoints, CFG/SSA, contracts and application routing are later slices.
