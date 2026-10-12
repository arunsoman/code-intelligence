#!/usr/bin/env node
// Parity A/B for the worker's index op. Runs the same full index into fresh worker processes —
// optionally from different worker binaries — and compares canonical row content. The raw JSON byte
// stream was never cross-run stable because git-history facts are emitted in HashMap order
// (pre-existing), so rows are sorted by id before comparison; any row set/per-row difference still
// mismatches. Also checks revision and, cross-binary, that row counts agree.
//
// Usage: node scripts/index-parity-ab.mjs [repoPath]
// Env:   CIE_OLD_BIN=...   second (old) binary to compare against the current one
//        CIE_WORKER_BIN=... override of the current worker binary
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const repoPath = process.argv[2] || path.join(process.cwd(), 'packages', 'core');
const newBin = process.env.CIE_WORKER_BIN || path.join(process.cwd(), 'target', 'release', 'worker');
const oldBin = process.env.CIE_OLD_BIN || '';

function runIndex(label, bin, parallel) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.CIE_WORKER_PARALLEL = String(parallel);
    const child = spawn(bin, { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const req = Buffer.from(JSON.stringify({ id: label, op: 'index', params: { repoPath } }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(req.length, 0);
    child.stdin.write(len);
    child.stdin.write(req);
    child.stdin.end();
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${label}: worker exit ${code}`));
      try {
        if (out.length < 4) throw new Error(`${label}: no response frame`);
        const rlen = out.readUInt32BE(0);
        const res = JSON.parse(out.subarray(4, 4 + rlen).toString('utf8'));
        if (!res.ok) throw new Error(`${label}: not ok: ${JSON.stringify(res).slice(0, 300)}`);
        if (!existsSync(res.handle)) throw new Error(`${label}: handle missing: ${res.handle}`);
        resolve(res.handle);
      } catch (e) { reject(e); }
    });
  });
}

// Canonical hash of a batch handle: rows sorted by id (ids are unique after merge_duplicate_rows),
// evidence sorted by id inside each row.
function canonicalHash(handlePath) {
  const b = JSON.parse(readFileSync(handlePath, 'utf8'));
  const sortRows = (key, arr) => {
    arr.sort((a, c) => (a[key] < c[key] ? -1 : a[key] > c[key] ? 1 : 0));
    for (const r of arr) if (Array.isArray(r.evidence)) r.evidence.sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    return arr.map((r) => JSON.stringify(r));
  };
  const ents = sortRows('entity_id', b.entities);
  const facts = sortRows('id', b.facts);
  const rels = sortRows('id', b.relationships);
  const diag = (b.diagnostics || []).map((d) => JSON.stringify(d)).sort();
  const canon = JSON.stringify({
    entities: ents, facts, relationships: rels, diagnostics: diag,
    revision: b.revision, mode: b.mode,
    removed_files: [...(b.removed_files || [])].sort(),
    changed_files: [...(b.changed_files || [])].sort(),
  });
  return {
    hash: createHash('sha256').update(canon).digest('hex'),
    bytes: statSync(handlePath).size,
    counts: { e: b.entities.length, f: b.facts.length, r: b.relationships.length },
    revision: b.revision,
  };
}

function cleanHandle(handlePath) {
  if (handlePath && existsSync(handlePath)) rmSync(handlePath, { force: true });
}

const runs = [
  { label: 'old-seq', bin: oldBin || newBin, parallel: 0 },
  { label: 'new-seq', bin: newBin, parallel: 0 },
  { label: 'new-par', bin: newBin, parallel: 1 },
];
if (!oldBin) runs[0].label = 'new-seq-b';

const results = [];
for (const r of runs) {
  const t0 = Date.now();
  const handle = await runIndex(r.label, r.bin, r.parallel);
  const info = canonicalHash(handle);
  info.label = r.label;
  info.parity = r.parallel;
  info.ms = Date.now() - t0;
  results.push(info);
  console.log(`${r.label.padEnd(16)} sha256=${info.hash.slice(0, 16)}  ${info.bytes} bytes  counts(ents/facts/rels)=${info.counts.e}/${info.counts.f}/${info.counts.r}  ${info.ms} ms`);
  cleanHandle(handle);
}

const hashes = [...new Set(results.map((r) => r.hash))];
if (hashes.length !== 1) {
  console.error('MISMATCH between canonical outputs:');
  for (const r of results) console.error(`  ${r.label}: ${r.hash}`);
  process.exit(1);
}
console.log('PARITY OK: all runs canonically identical');