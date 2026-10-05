#!/usr/bin/env node
// Runs the pf-canon-v1 vectors in Node and in Rust and writes docs/prompt-to-feature/canon-parity.json.
// feature/config.ts `exactBindingEnabled` reads that file; exact-bound publication stays off until both runtimes pass.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const vectors = resolve(root, "fixtures/canon/canon-vectors.json");
const bytes = readFileSync(vectors);
const count = JSON.parse(bytes.toString("utf8")).vectors.length;
const node = spawnSync(process.execPath, ["--test", "packages/core/test/feature-canon.test.ts"], { cwd: root, encoding: "utf8" });
const rust = spawnSync("cargo", ["test", "-p", "worker", "canon::tests", "--", "--nocapture"], { cwd: root, encoding: "utf8" });
const att = {
  protocol: "pf-canon-v1",
  vectorsSha256: createHash("sha256").update(bytes).digest("hex"),
  node: { passed: node.status === 0, vectors: count },
  rust: { passed: rust.status === 0, vectors: count },
};
writeFileSync(resolve(root, "docs/prompt-to-feature/canon-parity.json"), JSON.stringify(att, null, 2) + "\n");
console.log(JSON.stringify(att));
if (!att.node.passed || !att.rust.passed) { console.error((node.stdout + node.stderr).slice(-2000)); console.error((rust.stdout + rust.stderr).slice(-2000)); process.exit(1); }
