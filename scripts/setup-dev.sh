#!/usr/bin/env bash
set -euo pipefail

# Containers without sudo must provision these packages in their image.
if command -v apt-get >/dev/null 2>&1 && [[ "$(id -u)" == 0 ]]; then
  apt-get update
  apt-get install -y build-essential curl ca-certificates
elif command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo apt-get update
  sudo apt-get install -y build-essential curl ca-certificates
else
  for program in cc c++ make curl; do
    if ! command -v "$program" >/dev/null 2>&1; then
      echo "Missing $program. Install build-essential, curl and ca-certificates in the container image before setup." >&2
      exit 1
    fi
  done
  if [[ ! -r /etc/ssl/certs/ca-certificates.crt && ! -r /etc/pki/tls/certs/ca-bundle.crt ]]; then
    echo "Missing CA certificates. Install ca-certificates in the container image before setup." >&2
    exit 1
  fi
  echo "Using system build tools and certificates provisioned by the environment image."
fi

if ! command -v rustup >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT

  curl --proto '=https' --tlsv1.2 -sSf \
    https://sh.rustup.rs -o "$installer"

  sh "$installer" -y --profile minimal
fi

# Image-provided rustup may already be on PATH without a per-user env file.
if [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

# Use the repository toolchain even when setup is called from another directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rustc --version
cargo --version
