import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRunner, dockerAvailable } from "../src/feature/docker-runner.ts";
import { auditRunner } from "../src/feature/runner.ts";

const have = dockerAvailable();
const skip = have ? false : "docker or the node:24-alpine image is not available on this machine";
const script = (root: string, name: string, body: string) => { writeFileSync(join(root, name), body); return join(root, name); };
const caps = (root: string, scratch: string, over: Record<string, unknown> = {}) => ({ commands: [["node"], ["npm"]], readRoots: [root], writeRoots: [scratch], network: "DENY" as const, secretRefs: [], limits: { wallMs: 30_000, outputBytes: 65536, ...over } });
function dirs() { const base = realpathSync(mkdtempSync(join(tmpdir(), "pf-dr-"))); const root = join(base, "checkout"), scratch = join(base, "scratch"); mkdirSync(root); mkdirSync(scratch); return { base, root, scratch }; }

test("1.F the container runner passes the audit written for it, and says what it does not provide", { skip }, async () => {
  const r = new DockerRunner(); const report = await auditRunner(r);
  assert.equal(r.isolation, "CONTAINER"); assert.ok(report.omissions.some((o) => /shares the host kernel/.test(o)));
  assert.deepEqual(report.checks.filter((c) => !c.enforced).map((c) => `${c.name}: ${c.detail}`), []); assert.equal(report.audited, true);
  assert.ok(report.checks.some((c) => /fork bomb/.test(c.name)) && report.checks.some((c) => /root filesystem/.test(c.name)));
});

test("1.F the container runner runs a real command, keeps stdout, refuses what the local runner refuses, and never starts docker for a refused request", { skip }, async () => {
  const { root, scratch } = dirs(); writeFileSync(join(root, "hello.js"), `console.log("hello " + process.version.split(".")[0])`);
  const r = new DockerRunner();
  const ok = await r.run({ capabilities: caps(root, scratch), argv: ["node", join(root, "hello.js")], cwd: root }); assert.equal(ok.status, "PASSED", JSON.stringify(ok)); assert.match(ok.stdout, /hello v24/); assert.equal(ok.isolation, "CONTAINER");
  const fail = await r.run({ capabilities: caps(root, scratch), argv: ["node", script(root, "exit3.js", "process.exit(3)")], cwd: root }); assert.equal(fail.status, "FAILED"); assert.equal(fail.exitCode, 3);
  for (const [name, req] of [
    ["allowlist", { capabilities: caps(root, scratch), argv: ["sh", "-c", "id"], cwd: root }],
    ["network", { capabilities: { ...caps(root, scratch), network: { allow: ["x"] } }, argv: ["node", "-v"], cwd: root }],
    ["env", { capabilities: caps(root, scratch), argv: ["node", "-v"], cwd: root, env: { NODE_OPTIONS: "--require x" } }],
    ["secret env", { capabilities: caps(root, scratch), argv: ["node", "-v"], cwd: root, env: { GITHUB_TOKEN: "t" } }],
    ["cwd outside", { capabilities: caps(root, scratch), argv: ["node", "-v"], cwd: tmpdir() }],
    ["root", { capabilities: { ...caps(root, scratch), readRoots: ["/"] }, argv: ["node", "-v"], cwd: root }],
    ["flag command", { capabilities: { ...caps(root, scratch), commands: [["--privileged"]] }, argv: ["--privileged", "x"], cwd: root }],
  ] as const) assert.equal((await r.run(req as never)).status, "REFUSED", name);
  assert.equal((await new DockerRunner({ fence: () => false }).run({ capabilities: caps(root, scratch), argv: ["node", "-v"], cwd: root, fencingToken: 1 })).status, "REFUSED");
});

test("1.F the container runner stops a run at the wall limit and when it is cancelled, and reports a missing image as an infrastructure error, not a failure", { skip }, async () => {
  const { root, scratch } = dirs(); const r = new DockerRunner();
  const slow = await r.run({ capabilities: caps(root, scratch, { wallMs: 1500 }), argv: ["node", script(root, "loop.js", "setInterval(() => {}, 1000)")], cwd: root }); assert.equal(slow.status, "TIMEOUT"); assert.ok(slow.usage.wallMs < 10_000);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 1200);
  const stopped = await r.run({ capabilities: caps(root, scratch), argv: ["node", script(root, "loop.js", "setInterval(() => {}, 1000)")], cwd: root }, ac.signal); assert.equal(stopped.status, "CANCELLED");
  const flood = await r.run({ capabilities: caps(root, scratch, { outputBytes: 5000 }), argv: ["node", script(root, "flood.js", "process.stdout.write('x'.repeat(2_000_000))")], cwd: root }); assert.equal(flood.status, "RESOURCE_LIMIT"); assert.ok(flood.stdout.length <= 5000);
  const missing = await new DockerRunner({ image: "cie-no-such-image:0" }).run({ capabilities: caps(root, scratch), argv: ["node", script(root, "x.js", "1")], cwd: root }); assert.equal(missing.status, "INFRA_ERROR"); assert.match(missing.reason ?? "", /docker could not run/);
});
