# Development environment setup

The agent environment's setup process must run this command from the repository root:

```bash
bash scripts/setup-dev.sh
```

Configure this command in the environment's setup hook. Committing the script makes setup available; it does not automatically execute setup or install Rust. This repository does not contain a provider-specific agent environment setup configuration.

Before Rust builds or worker-dependent tests, run:

```bash
bash scripts/setup-dev.sh
```

Then validate Rust with:

```bash
cargo build --release --locked
cargo test --workspace --locked
```

If the environment has no sudo access, install `build-essential`, `curl` and `ca-certificates` in its container image instead. The setup script accepts pre-provisioned system tools and certificates and supports rustup installed by the image.

`rust-toolchain.toml` specifies the tested Rust version, the minimal profile, and the `rustfmt` and `clippy` components. After a toolchain upgrade, validate the commands above and pin the exact tested version rather than leaving `channel = "stable"`.
