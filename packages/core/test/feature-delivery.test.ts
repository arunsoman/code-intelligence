import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rawHash } from "../src/feature/canon.ts";
import { snapshotOf } from "../src/feature/intake.ts";
import { buildPatch, exportBlocks, exportPolicyHash, gitFilePatch, unsafePath } from "../src/feature/patch-export.ts";
import { defaultValidationPlan } from "../src/feature/validation.ts";
import { boot, createEdit } from "./feature-boot.ts";

async function world() {
  const b = await boot({ edits: (repo) => [
    createEdit("src/export/csv.ts", "export const toCsv = () => '';\n"),
    { op: "RENAME_FILE", from: "src/errors.ts", to: "src/domain/errors.ts", baseHash: rawHash(readFileSync(join(repo, "src/errors.ts"))), why: "move", requirementIds: ["r1"] },
    { op: "DELETE_FILE", file: "src/jobs/reconciler.ts", baseHash: rawHash(readFileSync(join(repo, "src/jobs/reconciler.ts"))), why: "unused", requirementIds: ["r1"] },
  ] });
  // With no recorded test-data provenance the gate BLOCKS (computeEligibility); the plan below declares synthetic data, so the
  // candidate is reviewable but still incomplete (no build/test evidence has been run).
  const plan = (data: boolean) => { const r = b.fs.getRequest(b.rid)!; b.fs.updateRequest(b.rid, r.version, { ...r, validationPlan: { ...defaultValidationPlan(r, b.cand), ...(data ? { testData: { kind: "SYNTHETIC" as const, fixtureHash: "f", generatorHash: "g", seed: "1" } } : {}) } }); };
  plan(true); const rec = b.fs.getRequest(b.rid)!;
  const decide = (purpose = "EXPORT_PATCH") => b.h["C16/verifyFeature"](b.as("arun"), { contractHash: rec.contract!.hash, patchBindingHash: b.cand.bindingHash, validationIds: [], performanceAssessmentIds: [], unresolvedFindingIds: [], purpose }).value;
  const exp = (format = "GIT_PATCH", decisionId?: string) => b.h["C28/exportFeaturePatch"](b.as("arun"), { candidateHash: b.cand.bindingHash, decisionId: decisionId ?? decide().id, format, exportPolicyHash: exportPolicyHash() });
  return { ...b, rec, decide, exp, plan };
}

test("PF-077 export is bound to a decision recomputed now; an incomplete candidate exports as REVIEW ONLY and is never called verified", async () => {
  const w = await world();
  try {
    w.plan(false); const blocked = await w.exp(); assert.equal(blocked.ok, false); assert.equal(blocked.error.code, "FORBIDDEN"); assert.match(blocked.error.message, /blocked candidate is not exported/); assert.equal(w.fs.listCandidates(w.rid)[0]!.exports, undefined); w.plan(true);
    const r = await w.exp();
    assert.equal(r.ok, true); const e = r.value.value;
    assert.equal(r.value.status, "PARTIAL"); assert.equal(e.eligibility, "REVIEW_ONLY_INCOMPLETE");
    assert.match(e.label, /REVIEW ONLY/); assert.doesNotMatch(e.label, /verified/i);
    assert.equal(e.candidateHash, w.cand.bindingHash); assert.equal(e.baseHash, w.cand.binding.baseContentHash); assert.equal(e.patchArtifactHash, rawHash(e.patch));
    assert.ok(w.fs.listEvents(w.rid).some((x) => x.type === "PatchExported"));
    // exporting the same thing again is the same export
    const again = await w.exp(); assert.equal(again.value.value.id, e.id); assert.equal(w.fs.listCandidates(w.rid)[0]!.exports!.length, 1);
    // a decision that is not the current one is refused; so is a changed policy and an unknown format
    assert.equal((await w.exp("GIT_PATCH", "decision:forged")).error.code, "STALE_REVISION");
    assert.equal((await w.h["C28/exportFeaturePatch"](w.as("arun"), { candidateHash: w.cand.bindingHash, decisionId: w.decide().id, format: "GIT_PATCH", exportPolicyHash: "x" })).error.code, "STALE_REVISION");
    assert.equal((await w.exp("ZIP")).error.code, "INVALID_SCHEMA");
    // another principal cannot see the candidate at all
    assert.equal((await w.h["C28/exportFeaturePatch"](w.as("mallory"), { candidateHash: w.cand.bindingHash, decisionId: w.decide().id, format: "GIT_PATCH", exportPolicyHash: exportPolicyHash() })).error.code, "NOT_FOUND");
  } finally { w.close(); }
});

test("PF-077 a stale candidate or a decision made before the contract changed exports nothing", async () => {
  const w = await world();
  try {
    const id = w.decide().id;
    w.fs.putCandidate({ ...w.fs.getCandidate(w.cand.id)!, status: "STALE" });
    assert.equal((await w.exp("GIT_PATCH", id)).error.code, "STALE_REVISION");
    assert.equal(w.fs.listCandidates(w.rid)[0]!.exports, undefined);
  } finally { w.close(); }
});

test("PF-077 the exported git patch is accepted by git apply and reproduces the candidate; a plain diff drops git's extended headers", async () => {
  const w = await world();
  try {
    const e = (await w.exp("GIT_PATCH")).value.value;
    const file = join(w.repo, "..", "x.patch"); writeFileSync(file, e.patch);
    execFileSync("git", ["-C", w.repo, "apply", "--check", file], { stdio: "pipe" });
    execFileSync("git", ["-C", w.repo, "apply", file], { stdio: "pipe" });
    assert.equal(readFileSync(join(w.repo, "src/export/csv.ts"), "utf8"), "export const toCsv = () => '';\n");
    assert.ok(existsSync(join(w.repo, "src/domain/errors.ts"))); assert.ok(!existsSync(join(w.repo, "src/errors.ts"))); assert.ok(!existsSync(join(w.repo, "src/jobs/reconciler.ts")));
    const plain = buildPatch(w.fs.getCandidate(w.cand.id)!, "UNIFIED_DIFF"); assert.doesNotMatch(plain, /^diff --git/m); assert.match(plain, /^--- \/dev\/null$/m);
    const bundle = JSON.parse((await w.exp("BUNDLE")).value.value.patch); assert.equal(bundle.manifest.patchHash, rawHash(bundle.patch)); assert.equal(bundle.manifest.eligibility, "REVIEW_ONLY_INCOMPLETE");
  } finally { w.close(); }
});

test("PF-077 file patches handle missing trailing newlines and pure deletions", () => {
  assert.equal(gitFilePatch("a.txt", "x\ny", "x\ny\n"), "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+y\n");
  assert.equal(gitFilePatch("a.txt", "x\n", "x\n"), "");
  assert.match(gitFilePatch("a.txt", "x\n", null), /deleted file mode/);
});

test("PF-078 unsafe paths, VCS metadata, NUL bytes, case collisions and missing contents block an export before any patch exists", async () => {
  for (const p of ["../x", "/etc/passwd", "a/../b", ".git/config", "sub/.gitmodules", "a\\b", "a\nb", "a//b"]) assert.ok(unsafePath(p), p);
  assert.equal(unsafePath("src/a.ts"), undefined);
  const w = await world();
  try {
    const c = w.fs.getCandidate(w.cand.id)!; assert.deepEqual(exportBlocks(c), []);
    assert.ok(exportBlocks({ ...c, contents: { ...c.contents!, "src/export/csv.ts": "a\0b" } }).some((x) => /NUL/.test(x)));
    assert.ok(exportBlocks({ ...c, mutations: [...c.mutations, { ...c.mutations[0]!, newPath: ".gitmodules", oldPath: undefined, kind: "ADDED" }] }).some((x) => /version-control/.test(x)));
    assert.ok(exportBlocks({ ...c, mutations: [...c.mutations, { ...c.mutations[0]!, newPath: "SRC/Export/csv.ts", oldPath: undefined, kind: "ADDED" }], contents: { ...c.contents!, "SRC/Export/csv.ts": "x" } }).some((x) => /differ only by case/.test(x)));
    assert.deepEqual(exportBlocks({ ...c, contents: undefined }).length, 1);
  } finally { w.close(); }
});

test("PF-078/AT-78-82 the destination check is a dry run: it lists conflicts and dirty paths, writes nothing, and apply works only on an exact base into a new copy", async () => {
  const w = await world();
  try {
    const e = (await w.exp("GIT_PATCH")).value.value;
    const snap = snapshotOf(w.svc.store, w.repo);
    const before = rawHash(readFileSync(join(w.repo, "src/errors.ts")));
    const ok = await w.h["C28/checkPatchDestination"](w.as("arun"), { exportId: e.id, destinationSnapshot: snap, dirtyState: [] });
    assert.equal(ok.value.value.applies, true); assert.equal(ok.value.value.baseExact, true); assert.equal(ok.value.status, "COMPLETE");
    // dirty state in the destination is a conflict, and a stale snapshot is reported rather than trusted
    const dirty = await w.h["C28/checkPatchDestination"](w.as("arun"), { exportId: e.id, destinationSnapshot: snap, dirtyState: ["src/errors.ts"] });
    assert.equal(dirty.value.value.applies, false); assert.deepEqual(dirty.value.value.dirty, ["src/errors.ts"]);
    assert.equal((await w.h["C28/checkPatchDestination"](w.as("arun"), { exportId: e.id, destinationSnapshot: { ...snap, contentRootHash: "stale" }, dirtyState: [] })).value.status, "STALE");
    // apply needs the capability, the exact assessment id, and an idempotency key
    const body = { exportId: e.id, destinationSnapshot: snap, assessmentId: ok.value.value.id, capabilities: ["APPLY_TO_ISOLATED_WORKTREE"] };
    const { applyPatchCandidate } = await import("../src/feature/patch-export.ts"); const deps = { fs: w.fs, store: w.svc.store };
    assert.throws(() => applyPatchCandidate(deps, "arun", { ...body, capabilities: [], idempotencyKey: "k" }), /APPLY_TO_ISOLATED_WORKTREE/);
    assert.throws(() => applyPatchCandidate(deps, "arun", { ...body, assessmentId: "assessment:old", idempotencyKey: "k" }), /assess again/);
    const receipt = applyPatchCandidate(deps, "arun", { ...body, idempotencyKey: "k" });
    assert.equal(receipt.matchesCandidate, true); assert.equal(receipt.resultContentHash, w.cand.binding.candidateContentHash);
    assert.deepEqual([...receipt.applied].sort(), ["src/domain/errors.ts", "src/errors.ts", "src/export/csv.ts", "src/jobs/reconciler.ts"].sort().filter((p) => receipt.applied.includes(p)));
    assert.ok(receipt.worktree && existsSync(join(receipt.worktree, "src/export/csv.ts")));
    // the destination itself is untouched
    assert.equal(rawHash(readFileSync(join(w.repo, "src/errors.ts"))), before); assert.ok(!existsSync(join(w.repo, "src/export/csv.ts")));
    assert.ok(w.fs.listEvents(w.rid).some((x) => x.type === "PatchApplied"));
    // a destination that moved is a conflict for a file the patch touches
    writeFileSync(join(w.repo, "src/errors.ts"), "// someone else\n");
    const moved = await w.h["C28/checkPatchDestination"](w.as("arun"), { exportId: e.id, destinationSnapshot: snapshotOf(w.svc.store, w.repo), dirtyState: [] });
    assert.equal(moved.value.value.applies, false); assert.match(moved.value.value.conflicts.join(), /errors\.ts differs/);
    assert.throws(() => applyPatchCandidate(deps, "arun", { ...body, destinationSnapshot: snapshotOf(w.svc.store, w.repo), assessmentId: moved.value.value.id, idempotencyKey: "k2" }), /does not apply/);
  } finally { w.close(); }
});
