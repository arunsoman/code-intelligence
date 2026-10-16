# P02 semantic IR validation

Local baseline: P01 plus checklist commit `3d13731`, upstream base `4a748fd`.
Delivery patch: `cie-p02-semantic-ir.patch`, applied after P01. The checklist is
included as a new file because the original P01 downloadable patch predates it.

## Results

- `bash scripts/setup-dev.sh`: passed, Rust 1.97.1.
- `cargo test --workspace --locked`: 185 passed, zero failed: 21 new semantic IR,
  12 foundation, 148 worker, 1 worker CLI, 3 defect-harness tests.
- `cargo build --release --locked`: passed; existing worker warnings remain.
- `cargo clippy -p analysis-foundation --all-targets --locked -- -D warnings`: passed.
- `cargo fmt -p analysis-foundation --check`: passed.

## New coverage

Exact large integers, decimal/unbounded integers, IEEE NaN payloads and signed
zero, invalid literal encodings/ranges/types, source digest/document mismatches,
normalized paths, UTF-8 boundaries, span ownership, duplicate/missing values,
duplicate instruction IDs, missing call targets, signature mismatches, explicit
normal/exceptional edges, opaque/unresolved regions, Boolean branch typing,
instruction order, operator and branch-edge changes, revision/environment/version
digests, unknown fields/schema versions and duplicate wire-map identities.

The manually authored JSON/source/SHA-256 vector pins exact v1 serialization.
Round-trip equality and independently computed fixture SHA-256 are checked.
P01 tests remain unchanged and passing, preserving its existing API boundary.

## Limits

This establishes schema and model consistency, not source lowering correctness,
SSA/dominance, reachability, business contracts or runtime properties. No adapter,
analysis projection, worker command or answer/chart routing is newly enabled.
See `docs/design/semantic-ir-v1.md` for explicit semantics and exclusions.
