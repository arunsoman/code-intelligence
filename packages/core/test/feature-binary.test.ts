// Issue #91: binary files, executable bits and symlinks through the candidate, the Git patch, the destination check, apply, validation,
// the security gate, publication, integration and the issue trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeCandidate, type FeatureEdit } from "../src/feature/candidate.ts";
import { contentRoot, entriesFromDirectory, rawHash } from "../src/feature/canon.ts";
import { assessConcurrentChanges } from "../src/feature/coordination.ts";
import { securityGate } from "../src/feature/gates.ts";
import { gateContextFor } from "../src/feature/security-handlers.ts";
import { snapshotOf } from "../src/feature/intake.ts";
import { DEFAULT_PROJECTION_POLICY, projectionPolicyHash, syncRequestMilestones } from "../src/feature/issue-trail.ts";
import { applyPatchCandidate, buildPatch, checkPatchDestination, exportBlocks, exportFeaturePatch, exportPolicyHash } from "../src/feature/patch-export.ts";
import { publishFeaturePR, branchFor } from "../src/feature/publish.ts";
import { applyCandidateToDir, copyTreeKeepLinks, symlinkProblem } from "../src/feature/tree.ts";
import { defaultValidationPlan } from "../src/feature/validation.ts";
import { Forge } from "./feature-pipeline-forge.ts";
import { boot, createEdit, none } from "./feature-boot.ts";

const b = (...n: number[]) => Buffer.from(n);
const PNG1 = b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 0xff), PNG2 = b(0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0xfe), PNG3 = b(0x89, 0x50, 0x4e, 0x47, 0, 7, 7, 7, 0xfd, 0x00);
const root = (dir: string) => contentRoot(entriesFromDirectory(dir, { exclude: [] }));

function prepare(repo: string): void {
  mkdirSync(join(repo, "assets"), { recursive: true }); mkdirSync(join(repo, "scripts"), { recursive: true }); mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "assets/logo.png"), PNG1); writeFileSync(join(repo, "assets/old.bin"), b(1, 0, 2, 0, 3));
  writeFileSync(join(repo, "scripts/run.sh"), "#!/bin/sh\necho run\n"); chmodSync(join(repo, "scripts/run.sh"), 0o755);
  writeFileSync(join(repo, "scripts/plain.sh"), "#!/bin/sh\necho plain\n"); chmodSync(join(repo, "scripts/plain.sh"), 0o644);
  writeFileSync(join(repo, "docs/v1.md"), "# v1\n"); writeFileSync(join(repo, "docs/v2.md"), "# v2\n");
  symlinkSync("v1.md", join(repo, "docs/latest")); symlinkSync("v1.md", join(repo, "docs/gone"));
}
const R = ["r1"];
const matrix = (repo: string): FeatureEdit[] => [
  { op: "CREATE_BINARY", file: "assets/new.png", base64: PNG2.toString("base64"), why: "icon", requirementIds: R },
  { op: "REPLACE_BINARY", file: "assets/logo.png", baseHash: rawHash(PNG1), base64: PNG3.toString("base64"), why: "new logo", requirementIds: R },
  { op: "DELETE_FILE", file: "assets/old.bin", baseHash: rawHash(readFileSync(join(repo, "assets/old.bin"))), why: "unused", requirementIds: R },
  { op: "SET_MODE", file: "scripts/run.sh", baseHash: rawHash(readFileSync(join(repo, "scripts/run.sh"))), mode: "100644", why: "not a command", requirementIds: R },
  { op: "SET_MODE", file: "scripts/plain.sh", baseHash: rawHash(readFileSync(join(repo, "scripts/plain.sh"))), mode: "100755", why: "make runnable", requirementIds: R },
  { op: "CREATE_SYMLINK", file: "docs/next", target: "v2.md", why: "alias", requirementIds: R },
  { op: "RETARGET_SYMLINK", file: "docs/latest", baseTarget: "v1.md", target: "v2.md", why: "latest is v2", requirementIds: R },
  { op: "REMOVE_SYMLINK", file: "docs/gone", baseTarget: "v1.md", why: "dead alias", requirementIds: R },
  createEdit("src/mixed.ts", "export const mixed = true;\n"),
  { op: "CREATE_FILE", file: "scripts/new.sh", content: "#!/bin/sh\necho new\n", why: "script", requirementIds: R }, { op: "SET_MODE", file: "scripts/new.sh", mode: "100755", why: "script runs", requirementIds: R },
];
async function world() {
  const w = await boot({ prepare, edits: matrix });
  const rec = w.fs.getRequest(w.rid)!; w.fs.updateRequest(w.rid, rec.version, { ...rec, validationPlan: { ...defaultValidationPlan(rec, w.cand), testData: { kind: "SYNTHETIC", fixtureHash: "f", generatorHash: "g", seed: "1" } } });
  const cand = () => w.fs.getCandidate(w.cand.id)!;
  const decide = (purpose = "EXPORT_PATCH") => w.h["C16/verifyFeature"](w.as("arun"), { contractHash: w.fs.getRequest(w.rid)!.contract!.hash, patchBindingHash: w.cand.bindingHash, validationIds: [], performanceAssessmentIds: [], unresolvedFindingIds: [], purpose }).value;
  const exp = (format = "GIT_PATCH") => w.h["C28/exportFeaturePatch"](w.as("arun"), { candidateHash: w.cand.bindingHash, decisionId: decide().id, format, exportPolicyHash: exportPolicyHash() });
  return { ...w, cand: w.cand, c: cand, decide, exp, deps: { fs: w.fs, store: w.svc.store } };
}

test("#91 the candidate records every kind: binary add, replace and delete, executable bit on and off, symlink add, retarget and remove, mixed with text", async () => {
  const w = await world();
  try {
    const m = Object.fromEntries(w.c().mutations.map((x) => [x.newPath ?? x.oldPath, x]));
    assert.deepEqual([m["assets/new.png"]!.kind, m["assets/new.png"]!.entryKind], ["ADDED", "BINARY"]); assert.deepEqual([m["assets/logo.png"]!.kind, m["assets/logo.png"]!.entryKind, m["assets/logo.png"]!.beforeHash, m["assets/logo.png"]!.afterHash], ["MODIFIED", "BINARY", rawHash(PNG1), rawHash(PNG3)]);
    assert.deepEqual([m["assets/old.bin"]!.kind, m["assets/old.bin"]!.entryKind], ["DELETED", "BINARY"]);
    assert.deepEqual([m["scripts/run.sh"]!.kind, m["scripts/run.sh"]!.beforeMode, m["scripts/run.sh"]!.afterMode, m["scripts/run.sh"]!.beforeHash === m["scripts/run.sh"]!.afterHash], ["MODIFIED", "100755", "100644", true], "a mode-only change is a real change, with the same bytes");
    assert.deepEqual([m["scripts/plain.sh"]!.beforeMode, m["scripts/plain.sh"]!.afterMode], ["100644", "100755"]);
    assert.deepEqual([m["docs/next"]!.kind, m["docs/next"]!.entryKind, m["docs/next"]!.afterMode], ["ADDED", "SYMLINK", "120000"]); assert.deepEqual([m["docs/latest"]!.kind, m["docs/latest"]!.entryKind], ["MODIFIED", "SYMLINK"]); assert.deepEqual([m["docs/gone"]!.kind, m["docs/gone"]!.entryKind], ["DELETED", "SYMLINK"]);
    assert.equal(m["src/mixed.ts"]!.entryKind, undefined, "text carries no entry kind"); assert.deepEqual([m["scripts/new.sh"]!.kind, m["scripts/new.sh"]!.afterMode], ["ADDED", "100755"]);
    assert.ok(w.c().mutations.every((x) => x.attribution === "COMPLETE"));
    const e = w.c().entries!; assert.equal(e["assets/logo.png"]!.base64, PNG3.toString("base64")); assert.equal(e["docs/latest"]!.target, "v2.md"); assert.equal(e["assets/old.bin"], null); assert.equal(e["docs/gone"], null); assert.equal(e["src/mixed.ts"]!.kind, "TEXT"); assert.equal(e["src/mixed.ts"]!.base64, undefined);
    assert.equal(w.c().baseEntries!["docs/latest"]!.target, "v1.md"); assert.equal(w.c().baseEntries!["assets/logo.png"]!.base64, PNG1.toString("base64"));
    assert.equal(w.c().contents!["src/mixed.ts"], "export const mixed = true;\n"); assert.ok(!("assets/logo.png" in w.c().contents!), "bytes are not in the text map");
    // the same edits are the same binding; a mode-only difference is a different one
    const again = materializeCandidate({ fs: w.fs, store: w.svc.store, auth: none }, "arun", { requestId: w.rid, snapshot: w.fs.getRequest(w.rid)!.source, edits: matrix(w.repo), idempotencyKey: "again" }); assert.equal(again.replayed, true);
    // applying the candidate to a copy of the base reproduces its content hash
    const dir = mkdtempSync(join(tmpdir(), "pf-b-")); copyTreeKeepLinks(w.repo, dir); applyCandidateToDir(dir, w.c()); assert.equal(root(dir), w.c().binding.candidateContentHash);
    assert.equal(readlinkSync(join(dir, "docs/latest")), "v2.md"); assert.ok(!existsSync(join(dir, "assets/old.bin"))); assert.equal(lstatSync(join(dir, "docs/gone"), { throwIfNoEntry: false }), undefined); assert.ok(lstatSync(join(dir, "scripts/new.sh")).mode & 0o111); assert.ok(!(lstatSync(join(dir, "scripts/run.sh")).mode & 0o111));
    assert.deepEqual(readFileSync(join(dir, "assets/logo.png")), PNG3);
  } finally { w.close(); }
});

test("#91 unsafe binary, mode and symlink edits are refused with a reason, each on its own", async () => {
  const w = await boot({ prepare });
  try {
    const d = { fs: w.fs, store: w.svc.store, auth: none }; const snap = () => w.fs.getRequest(w.rid)!.source; let k = 0;
    const refuse = (edits: FeatureEdit[], re: RegExp, scope = {}) => assert.throws(() => materializeCandidate(d, "arun", { requestId: w.rid, snapshot: snap(), edits, scope, idempotencyKey: `n${k++}` }), (e: any) => re.test(e.message) && ["FORBIDDEN", "INVALID_SCHEMA", "RESOURCE_LIMIT", "STALE_REVISION"].includes(e.code), re.source);
    const logo = rawHash(PNG1), sym = (target: string, file = "docs/evil"): FeatureEdit => ({ op: "CREATE_SYMLINK", file, target, why: "x" });
    refuse([sym("../../etc/passwd")], /must stay inside the repository/); refuse([sym("/etc/passwd")], /must be relative/); refuse([sym("../.git/config")], /stay inside|version-control/); refuse([sym("a/../../../x")], /must stay inside/); assert.equal(symlinkProblem("docs/evil", "a/../../x"), undefined, "a/../../x resolves to x, which is inside"); refuse([sym("docs/.git/config")], /version-control/); refuse([sym("v1.md\nx")], /control or backslash/); refuse([sym("")], /needs a target/);
    refuse([{ op: "CREATE_BINARY", file: "assets/big.bin", base64: Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64"), why: "x" }], /binary limit|larger than/); refuse([{ op: "CREATE_BINARY", file: "assets/x.bin", base64: "not base64!!", why: "x" }], /base64 is invalid/);
    refuse([{ op: "CREATE_BINARY", file: ".git/hooks/pre-commit", base64: "AA==", why: "x" }], /never edited/); refuse([{ op: "CREATE_BINARY", file: ".env", base64: "AA==", why: "x" }], /never edited/); refuse([{ op: "CREATE_BINARY", file: "assets/logo.png", base64: "AA==", why: "x" }], /already exists/);
    refuse([{ op: "REPLACE_BINARY", file: "assets/logo.png", baseHash: "0".repeat(64), base64: "AA==", why: "x" }], /base hash mismatch/); refuse([{ op: "REPLACE_BINARY", file: "docs/latest", baseHash: logo, base64: "AA==", why: "x" }], /not an existing file/);
    refuse([{ op: "SET_MODE", file: "scripts/run.sh", baseHash: rawHash(readFileSync(join(w.repo, "scripts/run.sh"))), mode: "160000" as never, why: "x" }], /mode must be 100644 or 100755/); refuse([{ op: "SET_MODE", file: "scripts/run.sh", mode: "100644", why: "x" }], /needs its baseHash/); refuse([{ op: "SET_MODE", file: "docs/latest", baseHash: logo, mode: "100755", why: "x" }], /symlink/); refuse([{ op: "SET_MODE", file: "nope.sh", mode: "100755", why: "x" }], /does not exist/);
    refuse([{ op: "RETARGET_SYMLINK", file: "docs/latest", baseTarget: "other.md", target: "v2.md", why: "x" }], /base target mismatch/); refuse([{ op: "REMOVE_SYMLINK", file: "docs/v1.md", baseTarget: "x", why: "x" }], /not an existing symlink/); refuse([sym("v2.md", "docs/latest")], /already exists/);
    refuse([{ op: "CREATE_BINARY", file: "assets/a.bin", base64: "AA==", why: "x" }, { op: "CREATE_BINARY", file: "assets/a.bin", base64: "AQ==", why: "x" }], /conflicting operations/); refuse([{ op: "CREATE_BINARY", file: "assets/z.bin", base64: "AA==", why: "x", extra: 1 } as never], /unknown field/);
    refuse([{ op: "CREATE_BINARY", file: "package-lock.json", base64: "AA==", why: "x" }], /protected path/); refuse([{ op: "CREATE_BINARY", file: "assets/p.bin", base64: "AA==", why: "x" }, { op: "CREATE_BINARY", file: "assets/q.bin", base64: "AA==", why: "x" }], /limit is 1/, { maxFilesChanged: 1 });
    // below a symlink: a file under docs/latest/ is under a link, not a directory
    refuse([{ op: "CREATE_BINARY", file: "docs/latest/x.bin", base64: "AA==", why: "x" }], /below a symlink/);
    assert.equal(symlinkProblem("a/b", "../c"), undefined); assert.match(symlinkProblem("a", "../c")!, /inside/);
    assert.equal(w.fs.listCandidates(w.rid).length, 0, "no refused edit left a candidate");
  } finally { w.close(); }
});

test("#91 Git is the patch engine: the export is a git binary patch that git applies to a copy of the base and reproduces the candidate exactly", async () => {
  const w = await world();
  try {
    const r = await w.exp(); assert.equal(r.ok, true, JSON.stringify(r.error)); const e = r.value.value; const patch: string = e.patch;
    assert.match(patch, /GIT binary patch/); assert.match(patch, /new file mode 120000/); assert.match(patch, /deleted file mode 120000/); assert.match(patch, /old mode 100755\nnew mode 100644/); assert.match(patch, /old mode 100644\nnew mode 100755/); assert.match(patch, /new file mode 100755/); assert.match(patch, /index [0-9a-f]{40}\.\.[0-9a-f]{40}/, "full object ids");
    assert.equal(e.patchArtifactHash, rawHash(patch));
    assert.equal(buildPatch(w.c(), "GIT_PATCH"), patch, "the same candidate always yields the same bytes");
    const dir = mkdtempSync(join(tmpdir(), "pf-b-")); copyTreeKeepLinks(w.repo, dir); writeFileSync(join(dir, "..", "x.patch"), patch);
    execFileSync("git", ["apply", "--check", "--binary", join(dir, "..", "x.patch")], { cwd: dir, stdio: "pipe" }); execFileSync("git", ["apply", "--binary", join(dir, "..", "x.patch")], { cwd: dir, stdio: "pipe" });
    assert.equal(root(dir), w.c().binding.candidateContentHash, "git applying the exported patch gives the candidate's content hash"); assert.deepEqual(readFileSync(join(dir, "assets/logo.png")), PNG3); assert.equal(readlinkSync(join(dir, "docs/next")), "v2.md");
    // a plain unified diff cannot carry any of this, and says so; a bundle carries the same patch
    const plain = await w.exp("UNIFIED_DIFF"); assert.equal(plain.ok, false); assert.match(plain.error.message, /export it as GIT_PATCH/);
    const bundle = JSON.parse((await w.exp("BUNDLE")).value.value.patch); assert.equal(bundle.patch, patch); assert.equal(bundle.manifest.files.length, w.c().mutations.length);
    assert.deepEqual(exportBlocks(w.c()), []);
    // a tampered record is refused before a patch exists
    const bad = structuredClone(w.c()); bad.entries!["docs/next"] = { ...bad.entries!["docs/next"]!, target: "../../etc/passwd" }; assert.ok(exportBlocks(bad).some((x) => /must stay inside the repository/.test(x)));
    const big = structuredClone(w.c()); big.entries!["assets/new.png"] = { ...big.entries!["assets/new.png"]!, size: 3 }; assert.ok(exportBlocks(big).some((x) => /does not match its recorded size/.test(x)));
    const gl = structuredClone(w.c()); gl.entries!["docs/next"] = { ...gl.entries!["docs/next"]!, mode: "160000" as never }; assert.ok(exportBlocks(gl).some((x) => /submodule/.test(x)));
  } finally { w.close(); }
});

test("#91 destination: a binary, mode or link that differs is a conflict; on an exact base git applies into a new copy and the result equals the candidate; the destination is untouched", async () => {
  const w = await world();
  try {
    const e = (await w.exp()).value.value; const snap = () => snapshotOf(w.svc.store, w.repo);
    const ok = checkPatchDestination(w.deps, "arun", { exportId: e.id, destinationSnapshot: snap(), dirtyState: [] }).value!; assert.equal(ok.applies, true, JSON.stringify(ok)); assert.equal(ok.baseExact, true);
    const receipt = applyPatchCandidate(w.deps, "arun", { exportId: e.id, destinationSnapshot: snap(), assessmentId: ok.id, capabilities: ["APPLY_TO_ISOLATED_WORKTREE"], idempotencyKey: "k" });
    assert.equal(receipt.matchesCandidate, true); assert.equal(receipt.resultContentHash, w.c().binding.candidateContentHash); const wt = receipt.worktree!;
    assert.deepEqual(readFileSync(join(wt, "assets/logo.png")), PNG3); assert.equal(readlinkSync(join(wt, "docs/latest")), "v2.md"); assert.ok(lstatSync(join(wt, "scripts/plain.sh")).mode & 0o111); assert.ok(!existsSync(join(wt, "assets/old.bin")));
    assert.deepEqual(readFileSync(join(w.repo, "assets/logo.png")), PNG1, "the destination itself is untouched"); assert.equal(readlinkSync(join(w.repo, "docs/latest")), "v1.md");
    assert.ok(w.fs.listEvents(w.rid).some((x) => x.type === "PatchApplied"));
    // each kind of drift in the destination is its own conflict
    const conflict = (re: RegExp) => { const a = checkPatchDestination(w.deps, "arun", { exportId: e.id, destinationSnapshot: snap(), dirtyState: [] }).value!; assert.equal(a.applies, false); assert.match(a.conflicts.join("; "), re); };
    writeFileSync(join(w.repo, "assets/logo.png"), b(9, 9, 9)); conflict(/assets\/logo\.png differs/); writeFileSync(join(w.repo, "assets/logo.png"), PNG1);
    chmodSync(join(w.repo, "scripts/plain.sh"), 0o755); conflict(/scripts\/plain\.sh differs/); chmodSync(join(w.repo, "scripts/plain.sh"), 0o644);
    execFileSync("rm", [join(w.repo, "docs/latest")]); symlinkSync("elsewhere.md", join(w.repo, "docs/latest")); conflict(/docs\/latest differs/);
    execFileSync("rm", [join(w.repo, "docs/latest")]); symlinkSync("v1.md", join(w.repo, "docs/latest"));
    writeFileSync(join(w.repo, "docs/next"), "a file where the link should go"); conflict(/docs\/next already exists/);
  } finally { w.close(); }
});

test("#91 validation and integration use the same writer: the scratch tree equals the candidate hash, and an integrated tree with links and binaries is computed", async () => {
  const w = await world();
  try {
    const other = await import("../src/feature/coordination.ts"); void other;
    const snap = snapshotOf(w.svc.store, w.repo);
    const r = assessConcurrentChanges(w.deps, "arun", { requestIds: [w.rid], candidateBindings: [w.cand.bindingHash], snapshot: snap }); assert.equal(r.status, "COMPLETE", JSON.stringify(r.diagnostics));
    assert.equal(r.value!.integratedContentHash, w.c().binding.candidateContentHash, "one candidate integrated alone is the candidate");
  } finally { w.close(); }
});

test("#91 the security gate: unscanned binary files are a gap unless a security-authorised suppression names them; an executable bit and a symlink are visible findings", async () => {
  const w = await world();
  try {
    const rec = w.fs.getRequest(w.rid)!; const ctx = gateContextFor({}, w.c(), rec); const run = (c = ctx) => securityGate({ ...c, policy: { ...c.policy, requireExternalSast: false } });
    const r = await run(); assert.equal(r.status, "INCOMPLETE"); assert.ok(r.gaps.some((g) => /2 binary file\(s\) were not analysed/.test(g)), r.gaps.join("; "));
    assert.ok(r.findings.some((f) => f.rule === "EXEC-BIT" && f.path === "scripts/plain.sh" && f.severity === "MEDIUM")); assert.ok(r.findings.some((f) => f.rule === "SYMLINK-ADDED" && f.path === "docs/next" && /v2\.md/.test(f.message)));
    assert.ok(!r.findings.some((f) => f.path === "scripts/run.sh" && f.rule === "EXEC-BIT"), "removing the bit is not a finding");
    // a suppression by someone with security authority clears the gap; one without it, or an expired one, does not
    const supp = (owner: string, expires: string) => ({ rule: "BINARY-UNSCANNED", path: "assets/", reason: "reviewed the images", owner, expires });
    const withAuth = { ...ctx, auth: { bindings: [{ id: "sec", scope: "security" as const, principals: ["arun"] }] }, policy: { ...ctx.policy, suppressions: [supp("arun", "2999-01-01T00:00:00Z")] } };
    assert.equal((await run(withAuth)).gaps.filter((g) => /binary/.test(g)).length, 0);
    assert.equal((await run({ ...withAuth, auth: { bindings: [] } })).gaps.filter((g) => /binary/.test(g)).length, 1, "no security authority: the suppression is ignored");
    assert.equal((await run({ ...withAuth, policy: { ...ctx.policy, suppressions: [supp("arun", "2000-01-01T00:00:00Z")] } })).gaps.filter((g) => /binary/.test(g)).length, 1, "expired");
  } finally { w.close(); }
});

test("#91 the file viewer never shows bytes as text: a summary, base64 only on an explicit download, and a link as what it is", async () => {
  const w = await world();
  try {
    const rd = (path: string, representation = "CANDIDATE", extra: Record<string, unknown> = {}) => w.h["C28/readCandidateFile"](w.as("arun"), { candidateHash: w.cand.bindingHash, path, representation, ...extra });
    const bin = rd("assets/logo.png"); assert.equal(bin.value.status, "PARTIAL"); assert.equal(bin.value.value.binary, true); assert.match(bin.value.value.content, new RegExp(`binary file assets/logo.png\\n${PNG3.length} bytes · mode 100644 · sha-256 ${rawHash(PNG3)}`)); assert.doesNotMatch(bin.value.value.content, /PNG/);
    assert.match(rd("assets/logo.png", "BASELINE").value.value.content, new RegExp(String(PNG1.length)));
    const dl = rd("assets/logo.png", "CANDIDATE", { download: true }); assert.equal(dl.value.value.encoding, "base64"); assert.deepEqual(Buffer.from(dl.value.value.content, "base64"), PNG3);
    assert.match(rd("docs/latest").value.value.content, /symlink docs\/latest -> v2\.md/); assert.match(rd("docs/latest", "BASELINE").value.value.content, /-> v1\.md/);
    assert.equal(rd("assets/old.bin").error.code, "NOT_FOUND"); assert.equal(rd("assets/new.png", "BASELINE").error.code, "NOT_FOUND");
    assert.equal(rd("assets/logo.png", "CANDIDATE", { download: true }).ok, true); assert.equal(w.h["C28/readCandidateFile"](w.as("mallory"), { candidateHash: w.cand.bindingHash, path: "assets/logo.png", representation: "CANDIDATE" }).error.code, "NOT_FOUND");
    const files = w.h["C01/openFeatureWorkspace"](w.as("arun"), { requestId: w.rid }).value.value.review.files; const f = Object.fromEntries(files.map((x: any) => [x.path, x]));
    assert.equal(f["assets/logo.png"].entryKind, "BINARY"); assert.deepEqual([f["docs/next"].entryKind, f["docs/next"].target], ["SYMLINK", "v2.md"]); assert.deepEqual([f["scripts/plain.sh"].beforeMode, f["scripts/plain.sh"].afterMode], ["100644", "100755"]); assert.equal(f["src/mixed.ts"].entryKind, undefined);
  } finally { w.close(); }
});

test("#91 a draft PR carries the binary, the link and the executable bit: the pushed tree has the exact modes and bytes", async () => {
  const clones = mkdtempSync(join(tmpdir(), "pf-clones-"));
  const w = await boot({ mode: "CREATE_DRAFT_PR", prepare: (repo) => { prepare(repo); execFileSync("git", ["-C", repo, "add", "-A"]); execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture files"]); execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/payments.git"]); mkdirSync(join(repo, ".cie"), { recursive: true }); writeFileSync(join(repo, ".cie/authority.json"), JSON.stringify({ bindings: [{ id: "pub", scope: "publish", principals: ["arun"], repositories: ["acme/payments"], bases: ["main"], permissions: ["draft_pr.create"] }] })); } });
  try {
    const r0 = w.fs.getRequest(w.rid)!; w.fs.updateRequest(w.rid, r0.version, { ...r0, issue: { ...r0.issue, syncState: "UNSYNCED" } });
    const cand = materializeCandidate({ fs: w.fs, store: w.svc.store, auth: none }, "arun", { requestId: w.rid, snapshot: w.fs.getRequest(w.rid)!.source, edits: matrix(w.repo), idempotencyKey: "m" }).candidate;
    const rec = w.fs.getRequest(w.rid)!; w.fs.updateRequest(w.rid, rec.version, { ...rec, validationPlan: { ...defaultValidationPlan(rec, cand), testData: { kind: "SYNTHETIC", fixtureHash: "f", generatorHash: "g", seed: "1" } } });
    const decision = w.h["C16/verifyFeature"](w.as("arun"), { contractHash: rec.contract!.hash, patchBindingHash: cand.bindingHash, validationIds: [], performanceAssessmentIds: [], unresolvedFindingIds: [], purpose: "PUBLISH_DRAFT_PR" }).value;
    const forge = new Forge(w.repo);
    const pub = await publishFeaturePR({ fs: w.fs, store: w.svc.store, forge, cloneRoot: clones, authority: () => ({ bindings: [{ id: "pub", scope: "publish", principals: ["arun"], repositories: ["acme/payments"], bases: ["main"], permissions: ["draft_pr.create"] }] }), requireVerified: false }, "arun", { proposalId: cand.id, decisionId: decision.id, expectedHeadHash: cand.binding.candidateContentHash, destination: "acme/payments:main", idempotencyKey: "p1" });
    const ls = execFileSync("git", ["-C", w.repo, "ls-tree", "-r", branchFor(w.rid)], { encoding: "utf8" }); const mode = (p: string) => new RegExp(`^(\\d+) \\w+ [0-9a-f]+\\t${p.replace(/\./g, "\\.")}$`, "m").exec(ls)?.[1];
    assert.equal(mode("docs/next"), "120000"); assert.equal(mode("docs/latest"), "120000"); assert.equal(mode("scripts/new.sh"), "100755"); assert.equal(mode("scripts/plain.sh"), "100755"); assert.equal(mode("scripts/run.sh"), "100644"); assert.equal(mode("assets/old.bin"), undefined); assert.equal(mode("docs/gone"), undefined);
    assert.equal(execFileSync("git", ["-C", w.repo, "show", `${branchFor(w.rid)}:docs/latest`], { encoding: "utf8" }), "v2.md");
    assert.deepEqual(execFileSync("git", ["-C", w.repo, "cat-file", "blob", `${branchFor(w.rid)}:assets/logo.png`]), PNG3); assert.equal(pub.commit, execFileSync("git", ["-C", w.repo, "rev-parse", `refs/heads/${branchFor(w.rid)}`], { encoding: "utf8" }).trim());
  } finally { w.close(); }
});

test("#91 PatchExported and PatchApplied reach the issue as progress lines, and the comment carries no paths or file contents", async () => {
  const w = await world();
  try {
    const e = (await w.exp()).value.value; const snap = snapshotOf(w.svc.store, w.repo);
    const a = checkPatchDestination(w.deps, "arun", { exportId: e.id, destinationSnapshot: snap, dirtyState: [] }).value!; applyPatchCandidate(w.deps, "arun", { exportId: e.id, destinationSnapshot: snap, assessmentId: a.id, capabilities: ["APPLY_TO_ISOLATED_WORKTREE"], idempotencyKey: "k" });
    const rec = w.fs.getRequest(w.rid)!; w.fs.updateRequest(w.rid, rec.version, { ...rec, issue: { ...rec.issue, repository: "acme/private-app", number: 7, syncState: "UNSYNCED", visibility: "PRIVATE" } });
    const comments: { id: number; body: string }[] = []; const forge = { recentComments: async () => comments, createComment: async (_r: string, _n: number, body: string) => { const c = { id: comments.length + 1, body }; comments.push(c); return c; } };
    const receipt = await syncRequestMilestones({ fs: w.fs, forge: forge as never, now: () => Date.parse("2026-10-06T12:00:00Z") }, "arun", { requestId: w.rid, throughSequence: 1000, projectionPolicyHash: projectionPolicyHash(DEFAULT_PROJECTION_POLICY) });
    assert.ok((receipt.sent ?? 0) >= 2, JSON.stringify(receipt)); const text = comments.map((c) => c.body).join("\n");
    assert.match(text, /\*\*PatchExported\*\* — OK/); assert.match(text, /\*\*PatchApplied\*\* — OK/); assert.doesNotMatch(text, /assets\/|docs\/|scripts\/|logo|PNG|v2\.md/, "no path or content leaves in the progress comment");
    assert.ok(DEFAULT_PROJECTION_POLICY.milestones.includes("PatchExported") && DEFAULT_PROJECTION_POLICY.milestones.includes("PatchApplied"));
  } finally { w.close(); }
});
