#!/usr/bin/env python3
"""Exercise file-only registration; run in an isolated checkout, outside other builds."""
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
probe = root / "crates/analysis-foundation/src/languages/adapters/zz_discovery_probe.rs"
if probe.exists():
    raise SystemExit("probe path already exists; refusing to overwrite")
try:
    probe.write_text('''use super::{LanguageAdapter, Metadata, Request, Lowered};
pub struct Probe;
pub static ADAPTER: Probe = Probe;
impl LanguageAdapter for Probe {
    fn metadata(&self) -> Metadata {
        Metadata { id: "discovery-probe", extensions: &["probe"], adapter_version: "test-v1",
            semantics: "test-only", semantic_scope: "registration test only" }
    }
    fn lower(&self, _: &Request) -> Result<Lowered, String> { Err("registration test only".into()) }
}
''')
    result = subprocess.run(
        [os.environ.get("CARGO", "cargo"), "run", "--locked", "-q", "-p", "worker", "--", "semanticLanguages"],
        cwd=root, text=True, capture_output=True, check=True,
    )
    assert any(adapter["id"] == "discovery-probe" for adapter in json.loads(result.stdout))
    print("PASS: one adapter file discovered without registry or dispatch edits")
finally:
    probe.unlink(missing_ok=True)
