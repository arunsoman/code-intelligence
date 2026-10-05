import { test } from "node:test";
import assert from "node:assert/strict";
import { authorityPolicyHash } from "../src/feature/authority.ts";
import { materializeCandidate } from "../src/feature/candidate.ts";
import { assertFence, relationsOf, releaseLeases, unmetDependencies } from "../src/feature/coordination.ts";
import { loadFeatureConfig } from "../src/feature/config.ts";
import { contractHashOf, contractIdOf } from "../src/feature/decisions.ts";
import { discoverFeatureContext, snapshotOf, submitFeature } from "../src/feature/intake.ts";
import type { IssueForge } from "../src/feature/issue-forge.ts";
import type { FeatureContract } from "../src/feature/types.ts";
import { boot, createEdit, none } from "./feature-boot.ts";

type B = Awaited<ReturnType<typeof boot>>;
/** A second request in the same repository, with its own contract and candidate. */
function second(b: B, key: string, files: Record<string, string>) {
  const intake = { fs: b.fs, store: b.svc.store, config: loadFeatureConfig };
  const rid = submitFeature(intake, "arun", { inputRefs: [], text: `Another feature ${key}`, repositoryId: b.repo, mode: "BUILD_PREVIEW", idempotencyKey: key }).requestId;
  discoverFeatureContext(intake, "arun", { requestId: rid, snapshot: b.fs.getRequest(rid)!.source, retrievalBudget: { tokens: 1000, files: 1000 } });
  let rec = b.fs.getRequest(rid)!;
  const draft = { schemaVersion: 1 as const, id: contractIdOf(rid), version: 0, requestId: rid, snapshot: rec.source, requirements: [], acceptance: [], assumptions: [], obligationIds: [], authorityPolicyHash: authorityPolicyHash(none) };
  const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) }; rec = b.fs.updateRequest(rid, rec.version, { ...rec, contract });
  const cand = Object.keys(files).length ? materializeCandidate({ fs: b.fs, store: b.svc.store, auth: none }, "arun", { requestId: rid, snapshot: rec.source, edits: Object.entries(files).map(([f, c]) => createEdit(f, c)), idempotencyKey: `m-${key}` }).candidate : null;
  return { rid, cand: cand! };
}
const world = async () => { const b = await boot({ edits: () => [createEdit("src/a/one.ts", "export const one = 1;\n")] }); return { ...b, deps: { fs: b.fs, store: b.svc.store, now: () => clock.t } }; };
const clock = { t: 1_000_000 };

test("PF-063/AT-24/57 a lease is all-or-nothing, names another holder only to its owner, and a replaced holder is fenced out by its lower token", async () => {
  const w = await world();
  try {
    const other = second(w, "k2", { "src/b/two.ts": "export const two = 2;\n" }); const rev = snapshotOf(w.svc.store, w.repo).contentRootHash;
    const reserve = (requestId: string, surfaceIds: string[], ttlMs = 60_000, who = "arun") => w.h["C07/reserveMutationSurfaces"](w.as(who), { requestId, surfaceIds, expectedRevision: rev, ttlMs });
    clock.t = 1_000_000; // the handler uses the real clock; time-dependent steps below use the module directly
    const a = reserve(w.rid, ["src/shared/x.ts", "src/a/one.ts"]); assert.equal(a.ok, true, JSON.stringify(a.error)); assert.equal(a.value.status, "COMPLETE"); const la = a.value.value; assert.equal(la.fencingToken, 1);
    const clash = reserve(other.rid, ["src/b/two.ts", "src/shared/x.ts"]); assert.equal(clash.value.status, "FAILED"); assert.match(clash.value.diagnostics[0], new RegExp(`your request ${w.rid}`));
    // nothing was taken for the free surface: all-or-nothing
    assert.equal(reserve(other.rid, ["src/b/two.ts"]).value.value.fencingToken, 2);
    // same request renewing gets a NEW, higher token and the old one stops working
    const renewed = reserve(w.rid, ["src/shared/x.ts", "src/a/one.ts"]).value.value; assert.equal(renewed.fencingToken, 3);
    assert.throws(() => assertFence(w.deps, w.rid, ["src/a/one.ts"], la.fencingToken), /not held/);
    assertFence(w.deps, w.rid, ["src/a/one.ts", "src/shared/x.ts"], renewed.fencingToken);
    assert.throws(() => assertFence(w.deps, other.rid, ["src/a/one.ts"], renewed.fencingToken), /not held/);
    // an expired lease can be taken over, and the previous holder is then refused
    const late = { ...w.deps, now: () => Date.now() + 120_000 };
    const { reserveMutationSurfaces } = await import("../src/feature/coordination.ts");
    const taken = reserveMutationSurfaces(late, "arun", { requestId: other.rid, surfaceIds: ["src/shared/x.ts"], expectedRevision: rev, ttlMs: 60_000 }).value!; assert.equal(taken.fencingToken, 4);
    assert.throws(() => assertFence(late, w.rid, ["src/shared/x.ts"], renewed.fencingToken), /not held/);
    assert.equal(releaseLeases(w.deps, "arun", other.rid) >= 1, true);
    // another person sees nothing of any of this; bad input is typed
    assert.equal(reserve(w.rid, ["src/a/one.ts"], 60_000, "mallory").error.code, "NOT_FOUND");
    assert.equal(reserve(w.rid, ["../etc/passwd"]).error.code, "INVALID_SCHEMA"); assert.equal(reserve(w.rid, []).error.code, "INVALID_SCHEMA"); assert.equal(reserve(w.rid, ["a.ts"], 5).error.code, "INVALID_SCHEMA");
    assert.equal(w.h["C07/reserveMutationSurfaces"](w.as("arun"), { requestId: w.rid, surfaceIds: ["a.ts"], expectedRevision: "stale", ttlMs: 60_000 }).value.status, "STALE");
  } finally { w.close(); }
});

test("PF-063 relations are proposals between a person's own requests; a DEPENDS_ON cycle is refused and unpublished dependencies are listed", async () => {
  const w = await world();
  try {
    const b2 = second(w, "k2", {}); const b3 = second(w, "k3", {});
    const rel = (from: string, to: string, relationship: string, who = "arun") => w.h["C07/relateRequests"](w.as(who), { fromRequestId: from, toRequestId: to, relationship });
    const r1 = rel(w.rid, b2.rid, "DEPENDS_ON"); assert.equal(r1.value.state, "PROPOSED"); assert.equal(rel(w.rid, b2.rid, "DEPENDS_ON").ok, true);
    assert.equal(relationsOf(w.deps, "arun", w.rid).length, 1); // idempotent
    assert.equal(rel(b2.rid, w.rid, "DEPENDS_ON").error.code, "VERSION_CONFLICT"); // cycle
    assert.equal(rel(b2.rid, b3.rid, "DEPENDS_ON").ok, true); assert.equal(rel(b3.rid, w.rid, "DEPENDS_ON").error.code, "VERSION_CONFLICT"); // longer cycle
    assert.equal(rel(w.rid, w.rid, "DUPLICATES").error.code, "INVALID_SCHEMA"); assert.equal(rel(w.rid, b2.rid, "LIKES").error.code, "INVALID_SCHEMA");
    assert.equal(rel(w.rid, b2.rid, "DUPLICATES", "mallory").error.code, "NOT_FOUND");
    assert.deepEqual(unmetDependencies(w.deps, "arun", w.rid), [b2.rid]);
    assert.deepEqual(unmetDependencies(w.deps, "arun", b3.rid), []);
  } finally { w.close(); }
});

test("PF-063/AT-55/56 concurrent candidates: shared files conflict, disjoint ones need joint re-verification and name the combined tree, dependencies order them", async () => {
  const w = await world();
  try {
    const b2 = second(w, "k2", { "src/b/two.ts": "export const two = 2;\n" }); const clash = second(w, "k3", { "src/a/one.ts": "export const one = 'other';\n" });
    // k3 cannot be built on a file k1 also creates only if the base has it; it creates the same path, so the PATH overlaps
    const snap = snapshotOf(w.svc.store, w.repo);
    const assess = (ids: [string, string][]) => w.h["C23/assessConcurrentChanges"](w.as("arun"), { requestIds: ids.map((x) => x[0]), candidateBindings: ids.map((x) => x[1]), snapshot: snap });
    const ok = assess([[w.rid, w.cand.bindingHash], [b2.rid, b2.cand.bindingHash]]); assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(ok.value.value.compatible, true); assert.equal(ok.value.value.reverify, true); assert.match(ok.value.value.integratedContentHash, /^pf-canon-v1\//); assert.notEqual(ok.value.value.integratedContentHash, snap.contentRootHash);
    assert.ok(ok.value.diagnostics.some((x: string) => /not verified until/.test(x)));
    const bad = assess([[w.rid, w.cand.bindingHash], [clash.rid, clash.cand.bindingHash]]); assert.equal(bad.value.value.compatible, false); assert.deepEqual(bad.value.value.overlaps, [{ path: "src/a/one.ts", requestIds: [w.rid, clash.rid] }]); assert.equal(bad.value.value.integratedContentHash, undefined);
    const single = assess([[w.rid, w.cand.bindingHash]]); assert.equal(single.value.value.reverify, false);
    w.h["C07/relateRequests"](w.as("arun"), { fromRequestId: w.rid, toRequestId: b2.rid, relationship: "DEPENDS_ON" });
    assert.deepEqual(assess([[w.rid, w.cand.bindingHash], [b2.rid, b2.cand.bindingHash]]).value.value.order, [b2.rid, w.rid]);
    w.h["C07/relateRequests"](w.as("arun"), { fromRequestId: w.rid, toRequestId: clash.rid, relationship: "CONFLICTS_WITH" });
    // a candidate built on a base that has since moved, a stale snapshot, a mismatched pair and a stranger
    assert.equal(w.h["C23/assessConcurrentChanges"](w.as("arun"), { requestIds: [w.rid], candidateBindings: [b2.cand.bindingHash], snapshot: snap }).error.code, "NOT_FOUND");
    assert.equal(w.h["C23/assessConcurrentChanges"](w.as("arun"), { requestIds: [w.rid], candidateBindings: [w.cand.bindingHash], snapshot: { ...snap, contentRootHash: "old" } }).value.status, "STALE");
    assert.equal(w.h["C23/assessConcurrentChanges"](w.as("mallory"), { requestIds: [w.rid], candidateBindings: [w.cand.bindingHash], snapshot: snap }).error.code, "NOT_FOUND");
    assert.equal(w.h["C23/assessConcurrentChanges"](w.as("arun"), { requestIds: [w.rid, w.rid], candidateBindings: [w.cand.bindingHash, w.cand.bindingHash], snapshot: snap }).error.code, "INVALID_SCHEMA");
  } finally { w.close(); }
});

test("PF-063 mutation origins list only the caller's own requests and say what they cannot know", async () => {
  const w = await world();
  try {
    const q = (who: string, path = "src/a/one.ts") => w.h["C23/getMutationOrigins"](w.as(who), { repositoryId: w.repo, path, revision: "r" });
    const mine = q("arun"); assert.equal(mine.value.value.origins.length, 1); assert.equal(mine.value.value.origins[0].requestId, w.rid); assert.ok(mine.value.value.origins[0].eventId.startsWith("evt:"));
    assert.deepEqual(q("mallory").value.value.origins, []); assert.match(q("mallory").value.diagnostics.join(), /no request of yours/);
    assert.equal(q("arun", "../x").error.code, "INVALID_SCHEMA");
  } finally { w.close(); }
});

test("PF-065/AT-59 retirement lists static consumers and always keeps the unknown-consumer gap open", async () => {
  const w = await boot({ edits: (repo) => [{ op: "DELETE_FILE", file: "src/jobs/reconciler.ts", baseHash: require_hash(repo, "src/jobs/reconciler.ts"), why: "retire" }] });
  try {
    const r = w.h["C23/assessRetirement"](w.as("arun"), { requestId: w.rid, candidateHash: w.cand.bindingHash }); assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.value.status, "PARTIAL"); assert.match(r.value.value.gaps[0], /unknown-consumer gap/); assert.deepEqual(r.value.value.affectedIds, ["src/jobs/reconciler.ts"]); assert.ok(r.value.value.reasons.length >= 3);
    assert.equal(w.h["C23/assessRetirement"](w.as("mallory"), { requestId: w.rid, candidateHash: w.cand.bindingHash }).error.code, "NOT_FOUND");
  } finally { w.close(); }
  const none2 = await boot({ edits: () => [createEdit("src/n.ts", "export {};\n")] });
  try { const r = none2.h["C23/assessRetirement"](none2.as("arun"), { requestId: none2.rid, candidateHash: none2.cand.bindingHash }); assert.equal(r.value.status, "COMPLETE"); assert.deepEqual(r.value.value.gaps, []); } finally { none2.close(); }
});

test("PF-065 relations reach the bound issue once, as allowlisted text, and a retry finds its own comment", async () => {
  const w = await world();
  try {
    const b2 = second(w, "k2", {}); const rel = w.h["C07/relateRequests"](w.as("arun"), { fromRequestId: w.rid, toRequestId: b2.rid, relationship: "EXTENDS" }); assert.equal(rel.ok, true);
    const id = relationsOf(w.deps, "arun", w.rid)[0]!.id;
    const comments: { id: number; body: string }[] = []; const forge = { recentComments: async () => comments, createComment: async (_r: string, _n: number, body: string) => { const c = { id: comments.length + 1, body }; comments.push(c); return c; } } as unknown as IssueForge;
    const h = (await import("../src/feature/handlers.ts")).featureHandlers(w.svc, { issues: { forge } }) as Record<string, (c: any, b: any) => any>;
    const call = () => h["C30/syncCapabilityRelations"](w.as("arun"), { requestId: w.rid, assessmentId: "a", relationIds: [id] });
    assert.equal((await call()).error.code, "FORBIDDEN"); // no issue bound yet (BLOCKED maps to FORBIDDEN)
    const r = w.fs.getRequest(w.rid)!; w.fs.updateRequest(w.rid, r.version, { ...r, issue: { ...r.issue, repository: "acme/payments", number: 7, syncState: "SYNCED", visibility: "PUBLIC_OR_UNKNOWN" } });
    const first = await call(); assert.equal(first.ok, true, JSON.stringify(first.error)); assert.equal(first.value.sent, 1);
    const again = await call(); assert.equal(again.value.sent, 0); assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /extends/); assert.doesNotMatch(comments[0]!.body, /Another feature|Add export/);
    assert.equal((await h["C30/syncCapabilityRelations"](w.as("arun"), { requestId: w.rid, assessmentId: "a", relationIds: ["rel:nope"] })).error.code, "NOT_FOUND");
  } finally { w.close(); }
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rawHash } from "../src/feature/canon.ts";
function require_hash(repo: string, rel: string) { return rawHash(readFileSync(join(repo, rel))); }
