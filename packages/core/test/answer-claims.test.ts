import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimsFromAnswer, claimsFromContainer, renderEnumeration } from "../src/claim.ts";
import { verifyClaims } from "../src/verifier.ts";
import { policyFor } from "../src/access.ts";
import type { ToolEnv } from "../src/chat-tools.ts";
import { ctx, setup, copyFixture, demoRepo } from "./helpers.ts";

function envFor(svc: Awaited<ReturnType<typeof setup>>["svc"], revision: string, repoRoot: string): ToolEnv {
  return { svc, ctx: ctx(), rev: svc.store.revision(revision)!, access: policyFor(svc.store, repoRoot), seen: new Map(), results: [], warnings: [] };
}

test("a fully read citation verifies; a partially read one does not", async () => {
  const repo = copyFixture();
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    const rev = svc.store.revision(revision)!;
    const entity = svc.store.entities(revision).find((e) => e.name === "AuthService")!;
    assert.ok(entity, "fixture must contain AuthService");
    const env = envFor(svc, revision, rev.repoRoot);
    env.seen.set(entity.entityId, { name: entity.name, file: entity.file });
    env.sourceReads = new Map([[entity.entityId, { total: 500, contentHash: entity.spans[0].contentHash, ranges: [[0, 500]] }]]);
    const [full] = claimsFromAnswer(env, revision, [entity.entityId]);
    assert.equal(full.status, "VERIFIED");
    assert.equal(full.predicate, "cited_in_answer");
    assert.equal(full.subject.entityId, entity.entityId);

    env.sourceReads.set(entity.entityId, { total: 500, contentHash: entity.spans[0].contentHash, ranges: [[0, 200]] });
    const [partial] = claimsFromAnswer(env, revision, [entity.entityId]);
    assert.equal(partial.status, "UNRESOLVED");
    assert.match(partial.statusReason!, /only 200 of 500/);
  } finally { worker.close(); }
});

test("the deterministic verifier checks the live file, not just the stored claim", async () => {
  const repo = copyFixture();
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    const rev = svc.store.revision(revision)!;
    const entity = svc.store.entities(revision).find((e) => e.name === "AuthService")!;
    const env = envFor(svc, revision, rev.repoRoot);
    env.seen.set(entity.entityId, { name: entity.name, file: entity.file });
    // Full coverage of the real on-disk file length, not a guess, so the claim's status is genuinely VERIFIED.
    const fullLen = readFileSync(join(repo, entity.file), "utf8").length;
    env.sourceReads = new Map([[entity.entityId, { total: fullLen, contentHash: entity.spans[0].contentHash, ranges: [[0, fullLen]] }]]);
    const claims = claimsFromAnswer(env, revision, [entity.entityId]);
    assert.equal(claims[0].status, "VERIFIED");

    const [verifiedBefore] = verifyClaims(svc.store, claims);
    assert.equal(verifiedBefore.status, "VERIFIED");

    appendFileSync(join(repo, entity.file), "\n// changed after the claim was recorded\n");
    const [verifiedAfter] = verifyClaims(svc.store, claims);
    assert.equal(verifiedAfter.status, "UNRESOLVED");
    assert.match(verifiedAfter.reason, /changed on disk/);
  } finally { worker.close(); }
});

test("an unindexed entity, or one from a revision that no longer exists, is reported unresolved rather than throwing", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const rev = svc.store.revision(revision)!;
    const env = envFor(svc, revision, rev.repoRoot);
    env.seen.set("class:src/auth/service.ts#Ghost", { name: "Ghost", file: "src/auth/service.ts" });
    env.sourceReads = new Map([["class:src/auth/service.ts#Ghost", { total: 10, contentHash: "deadbeef", ranges: [[0, 10]] }]]);
    const claims = claimsFromAnswer(env, revision, ["class:src/auth/service.ts#Ghost"]);
    const [verified] = verifyClaims(svc.store, claims);
    assert.equal(verified.status, "UNRESOLVED");
    assert.match(verified.reason, /not indexed/);
  } finally { worker.close(); }
});

test("enumerating a file's members answers 'how many X are in Y' with zero model calls", async () => {
  // This is the deterministic analog of the original motivating bug: several sibling error classes in one file,
  // the exact fan-out shape that used to burn the chat agent's investigation budget one find_code/read_code pair
  // at a time. Here it is one relationship-table lookup, with no model, no tool loop, no budget to exhaust.
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    const file = svc.store.entities(revision).find((e) => e.kind === "file" && e.file === "src/errors.ts")!;
    assert.ok(file, "fixture must contain src/errors.ts");
    const claims = claimsFromContainer(svc.store, revision, file.entityId);
    assert.equal(claims.length, 6, "errors.ts defines exactly 6 error classes");
    assert.ok(claims.every((c) => c.predicate === "member_of"));

    const verifications = verifyClaims(svc.store, claims);
    assert.ok(verifications.every((v) => v.status === "VERIFIED"), JSON.stringify(verifications));

    const kindOf = (id: string) => svc.store.entitiesById(revision, [id])[0]?.kind;
    const message = renderEnumeration("src/errors.ts", claims, verifications, kindOf);
    assert.match(message, /defines 6 classes:/);
    for (const name of ["DuplicateRequestError", "FraudRejectedError", "InsufficientFundsError", "CardDeclinedError", "GatewayTimeoutError", "CaptureFailedError"]) assert.match(message, new RegExp(name));
    assert.match(message, /independently verified against the indexed source, with no model call involved/);

    // Edit the file on disk (a 7th error class, and a change to one existing class's body) without re-indexing:
    // every member's content hash is now stale, so re-verifying against the live file must catch it, not
    // silently keep reporting the old, now-incorrect claims as VERIFIED.
    appendFileSync(join(repo, "src/errors.ts"), "export class RefundFailedError extends Error {}\n");
    const staleVerifications = verifyClaims(svc.store, claims);
    assert.ok(staleVerifications.every((v) => v.status === "UNRESOLVED"), "every claim's recorded file hash is now stale");
    assert.ok(staleVerifications.every((v) => /changed on disk/.test(v.reason)));
  } finally { worker.close(); }
});
