#!/usr/bin/env python3
"""Replay the shipped contract examples using the real Rust worker binary."""
import json
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
worker = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'target/release/worker'
expected = {'unconditional': 'violatedWithinModel', 'delegation': 'satisfiedWithinDomain', 'provider-unknown': 'unknown'}
for name, conclusion in expected.items():
    folder = root / 'fixtures/behavior-contracts'
    result = subprocess.run([str(worker), 'semanticCheck', str(folder / f'{name}-source.json'), str(folder / f'{name}-contracts.json')], capture_output=True, check=True, text=True)
    finding = json.loads(result.stdout)['findings'][0]
    assert finding['conclusion'] == conclusion, finding
    print(json.dumps({'case': name, 'conclusion': conclusion, 'completion': finding['completion'], 'cases': finding['casesStarted'], 'counterexamples': len(finding['counterexamples']), 'gaps': sorted(finding['gaps'])}))
