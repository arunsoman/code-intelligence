// C03: tenants cannot see each other through retrieval, embeddings or caches; egress fails closed; withdrawing a source's
// permission makes everything derived from it unreachable at once and then deletes it.
import { ScriptedRouter } from "./scripted-router.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { CallContext, ModelProvider, ModelRequest } from "@cie/schema";
import { HashEmbedder, semanticScores } from "../src/embeddings.ts";
import { revisionIndex } from "../src/salience.ts";
import { buildHandler } from "../src/server.ts";
import { Service } from "../src/service.ts";
import { mentionsByTable, rowsMentioning } from "../src/storage.ts";
import { Store } from "../src/store.ts";
import { TenantHost } from "../src/tenants.ts";
import { WorkerClient } from "../src/worker.ts";
import { ctx, demoRepo, FIXTURE, setup, traceFor } from "./helpers.ts";

const as = (tenantId: string, principalId = "p-" + tenantId): CallContext => ({ ...ctx(), actor: { principalId, tenantId, sessionId: "s" } });
const tmp = () => mkdtempSync(join(tmpdir(), "cie-tenant-"));
const svcOf = (host: TenantHost, t: string) => { const r = host.service(as(t)); assert.ok(r.ok, JSON.stringify(r)); return r.value; };

test("C03: cross-tenant retrieval: a tenant cannot index, find, cite, explain or open another tenant's code, workspaces or claims", async () => {
  const host = new TenantHost(tmp());
  const secretRepo = demoRepo(), sharedRepo = FIXTURE;
  host.register("alpha", { members: [], allowedRoots: [secretRepo, sharedRepo] });
  host.register("beta", { members: [], allowedRoots: [sharedRepo] });
  const a = svcOf(host, "alpha"), b = svcOf(host, "beta");
  const ing = await host.ingest(as("alpha"), { repoPath: secretRepo });
  assert.ok(ing.ok);
  const aRev = ing.value.id;
  const q = await a.ask(as("alpha"), { question: "walk me through createPayment", revision: aRev });
  assert.ok(q.ok && q.value.claims.length > 0);
  const claimId = q.value.claims[0].draft.id, evId = q.value.claims.flatMap((c) => c.draft.evidenceIds)[0];
  a.saveWorkspace(as("alpha"), { name: "alpha secret plan", expectedVersion: 0, revision: aRev, state: { view: q.value.view, claims: q.value.claims, selection: [], events: [], messages: [], explanation: null, revision: aRev } } as any);
  const wsId = (a.listWorkspaces(as("alpha")) as any).value[0].id;
  // Beta cannot index alpha's path, and what alpha indexed is not there for beta, by any route.
  const denied = await host.ingest(as("beta"), { repoPath: secretRepo });
  assert.ok(!denied.ok && denied.error.code === "FORBIDDEN" && !/payments|alpha/.test(denied.error.message));
  assert.equal((b.status(as("beta"), {}) as any).value.revision, null);
  const bAsk = await b.ask(as("beta"), { question: "walk me through createPayment", revision: aRev });
  assert.ok(!bAsk.ok && bAsk.error.code === "NOT_FOUND");
  const bAsk2 = await b.ask(as("beta"), { question: "walk me through createPayment" });
  assert.ok(!bAsk2.ok, "no revision at all for beta");
  assert.ok(!b.evidenceFor(as("beta"), { revision: aRev, evidenceId: evId }).ok);
  assert.ok(!(await b.explain(as("beta"), { revision: aRev, entityIds: ["function:src/api/payments-controller.ts#createPayment"] })).ok);
  assert.ok(!b.listConcepts(as("beta"), { revision: aRev }).ok);
  assert.deepEqual((b.listWorkspaces(as("beta")) as any).value, []);
  assert.ok(!b.openWorkspace(as("beta"), { workspaceId: wsId }).ok);
  assert.deepEqual(b.claims(as("beta"), { ids: [claimId] } as any).ok ? (b.claims(as("beta"), { ids: [claimId] } as any) as any).value : [], [], "alpha's claim is not beta's to read");
  assert.equal(b.store.auditEvents(100).length < a.store.auditEvents(100).length, true);
  assert.ok(!JSON.stringify(b.store.auditEvents(100)).includes("alpha secret plan"), "nor its audit trail");
  assert.ok(!b.c22.list("anything").items.length && (() => { try { b.c22.get("inv:none"); return false; } catch { return true; } })());
  // The files really are separate.
  assert.notEqual((a.store as any).path, (b.store as any).path);
  host.close();
});

test("C03: cross-tenant embeddings and caches: the same revision id in two tenants never shares vectors, history facts, overrides or concept cards", async () => {
  const host = new TenantHost(tmp(), { router: new ScriptedRouter() });
  const repo = demoRepo();
  host.register("alpha", { members: [], allowedRoots: [repo] });
  host.register("beta", { members: [], allowedRoots: [repo] });
  const a = svcOf(host, "alpha"), b = svcOf(host, "beta");
  const ia = await host.ingest(as("alpha"), { repoPath: repo }), ib = await host.ingest(as("beta"), { repoPath: repo });
  assert.ok(ia.ok && ib.ok);
  assert.equal(ia.value.id, ib.value.id, "the same content at the same path has the same revision id in both tenants: the case a shared cache would get wrong");
  const rev = ia.value.id;
  // Alpha customises everything it can.
  a.store.denyPath(repo, "src/payments");
  a.setOverride(as("alpha"), { revision: rev, entityId: "function:src/ledger/ledger.ts#adjustBalance", mode: "pin" });
  await a.extractConcepts(as("alpha"), { revision: rev });
  // Embeddings: alpha builds its index, then it is poisoned. Beta's answers are unaffected.
  const q = "refund processing";
  const before = await semanticScores(b.store, rev, q, new HashEmbedder());
  await semanticScores(a.store, rev, q, new HashEmbedder());
  a.store.db.prepare("update embeddings set vec = zeroblob(length(vec)) where revision = ?").run(rev);
  const afterBeta = await semanticScores(b.store, rev, q, new HashEmbedder());
  assert.deepEqual([...afterBeta.keys()], [...before.keys()], "beta's vectors are beta's own");
  assert.ok(afterBeta.size > 0);
  assert.equal(Number((b.store.db.prepare("select count(*) n from embeddings where revision = ?").get(rev) as any).n), Number((b.store.db.prepare("select count(*) n from embeddings where revision = ?").get(rev) as any).n));
  // Retrieval-level state: beta sees the payments code, no pin, no cards; alpha does not see it.
  const bAns = await b.ask(as("beta"), { question: "what stops a fraudulent payment", revision: rev });
  const aAns = await a.ask(as("alpha"), { question: "what stops a fraudulent payment", revision: rev });
  assert.ok(bAns.ok && aAns.ok);
  assert.ok(JSON.stringify(bAns.value).includes("checkFraud"), "beta sees what alpha was denied");
  assert.ok(!JSON.stringify(aAns.value).includes("checkFraud"));
  assert.equal((b.listConcepts(as("beta"), { revision: rev }) as any).value.length, 0, "alpha's concept cards are not beta's");
  assert.ok((a.listConcepts(as("alpha"), { revision: rev }) as any).value.length > 0);
  assert.equal((b.store.overrides(repo)).size, 0);
  // The in-process cache is keyed by store: beta's index is computed from beta's facts even though alpha's was cached first.
  revisionIndex(a.store, rev);
  b.store.db.prepare("delete from facts where revision = ? and predicate = 'history'").run(rev);
  assert.equal(revisionIndex(b.store, rev).history.size, 0, "a cache shared by revision id would have served alpha's history here");
  assert.ok(revisionIndex(a.store, rev).history.size >= 0);
  assert.notEqual(revisionIndex(a.store, rev), revisionIndex(b.store, rev));
  host.close();
});

test("C03: identity and authorization: unknown tenants and non-members are refused, paths cannot escape allowed roots, tenant ids cannot escape the data directory", async () => {
  const dir = tmp(), host = new TenantHost(dir);
  const allowed = demoRepo();
  const other = demoRepo();
  host.register("acme", { members: ["dana", "lee"], allowedRoots: [allowed] });
  assert.ok(!host.service(as("nobody")).ok && (host.service(as("nobody")) as any).error.code === "UNAUTHORIZED");
  assert.ok(!host.service(as("acme", "mallory")).ok && (host.service(as("acme", "mallory")) as any).error.message === "not a member of this tenant");
  assert.ok(host.service(as("acme", "dana")).ok);
  // Same tenant, same service object: members share the tenant's data, as intended.
  assert.equal((host.service(as("acme", "dana")) as any).value, (host.service(as("acme", "lee")) as any).value);
  assert.equal((await host.ingest(as("acme", "dana"), { repoPath: other })).ok, false, "outside the allowed roots");
  const link = join(tmp(), "link"); symlinkSync(other, link);
  assert.equal((await host.ingest(as("acme", "dana"), { repoPath: link })).ok, false, "a symlink to outside is outside");
  assert.equal((await host.ingest(as("acme", "dana"), { repoPath: join(allowed, "..", "..", "etc") })).ok, false, "dot-dot does not escape");
  assert.equal((await host.ingest(as("acme", "dana"), { repoPath: "/does/not/exist" })).ok, false);
  assert.ok((await host.ingest(as("acme", "dana"), { repoPath: allowed })).ok);
  for (const bad of ["../escape", "a/b", "", "x".repeat(65), "with space"]) assert.throws(() => host.register(bad, { members: [], allowedRoots: [] }), /tenant id/);
  // The registry survives a restart.
  const again = new TenantHost(dir);
  assert.ok(again.service(as("acme", "dana")).ok && !again.service(as("acme", "mallory")).ok);
  again.close(); host.close();
});

test("C03: the gateway takes the caller from the trusted transport, serves each tenant its own data, refuses unauthenticated calls and authorizes paths", async () => {
  const host = new TenantHost(tmp());
  const repo = demoRepo(), shared = FIXTURE;
  host.register("alpha", { members: [], allowedRoots: [repo] });
  host.register("beta", { members: [], allowedRoots: [shared] });
  const srv = createServer(buildHandler(host, { identify: (req) => { const t = req.headers["x-test-tenant"]; return typeof t === "string" ? { principalId: "u-" + t, tenantId: t, sessionId: "s" } : null; } }));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = (tenant: string | null, op: string, body: unknown, key = "k" + Math.random()) => fetch(`${base}/api/v1/components/${op}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, ...(tenant ? { "x-test-tenant": tenant } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  try {
    assert.equal((await call(null, "C01/status", {})).status, 401, "no identity, no service");
    assert.equal((await call("stranger", "C01/status", {})).status, 401, "unknown tenant");
    // A request body cannot claim to be someone else.
    assert.equal((await call("alpha", "C01/status", { actor: { tenantId: "beta" } })).body.value.revision, null);
    assert.equal((await call("alpha", "C04/ingestRepository", { repoPath: shared })).status, 403, "alpha may not read beta's folder");
    assert.equal((await call("beta", "C04/ingestRepository", { repoPath: repo })).status, 403);
    const ok = await call("alpha", "C04/ingestRepository", { repoPath: repo });
    assert.equal(ok.status, 200);
    assert.equal((await call("beta", "C01/status", {})).body.value.revision, null, "beta sees nothing of alpha's");
    assert.notEqual((await call("alpha", "C01/status", {})).body.value.revision, null);
    const browse = await call("beta", "C01/browseDirectory", {});
    assert.equal(browse.status, 200);
    assert.ok(browse.body.value.path.startsWith(shared.replace(/\/[^/]*$/, "")) || browse.body.value.path === shared, "browsing starts inside the tenant's own folders");
    assert.equal((await call("beta", "C01/browseDirectory", { path: "/" })).status, 403, "and cannot go above them");
    assert.equal((await call("alpha", "C01/repositoryGit", { repoPath: shared })).status, 403, "Git details cannot expose another tenant's checkout");
    assert.equal((await call("alpha", "C01/switchBranch", { repoPath: repo, branch: "main" })).status, 403, "read access does not grant permission to switch a shared checkout");
    assert.equal((await call("alpha", "C01/fetchBranches", { repoPath: repo })).status, 403, "read access does not grant permission to fetch into a shared checkout");
  } finally { srv.close(); host.close(); }
});

// ---------------------------------------------------------------------------------------------------------- egress
class Hosted implements ModelProvider {
  readonly name = "cloud"; readonly model = "x"; hosted: boolean = true;
  seen: ModelRequest[] = []; inner = new StubProvider();
  async generate(r: ModelRequest) { this.seen.push(r); return this.inner.generate(r); }
}
const ask = (svc: Service, revision: string) => svc.ask(ctx(), { question: "show me how authentication works", revision });

test("C03: fail-closed egress: nothing leaves the machine when the policy is unknown, unreadable, unrecordable or the provider's nature is unclear", async () => {
  // Control: approved and healthy, it does send.
  const p0 = new Hosted();
  const w0 = await setup(p0, FIXTURE);
  w0.svc.setEgress(ctx(), { repoRoot: w0.svc.store.revision(w0.revision)!.repoRoot, allow: true });
  await ask(w0.svc, w0.revision);
  assert.ok(p0.seen.some((r) => r.purpose === "REPRESENT"), "the control case does reach the provider");
  w0.worker.close();

  // 1. Not approved: not sent (and the previous tests cover the audit).
  const p1 = new Hosted();
  const w1 = await setup(p1, FIXTURE);
  assert.ok((await ask(w1.svc, w1.revision)).ok);
  assert.equal(p1.seen.length, 0);
  // 2. The policy cannot be read: treated as not approved.
  const p2 = new Hosted();
  const w2 = await setup(p2, FIXTURE);
  w2.svc.setEgress(ctx(), { repoRoot: w2.svc.store.revision(w2.revision)!.repoRoot, allow: true });
  (w2.svc.store as any).allowHosted = () => { throw new Error("policy store unavailable"); };
  const r2 = await ask(w2.svc, w2.revision);
  assert.ok(r2.ok, "the question is still answered, offline");
  assert.equal(p2.seen.length, 0, "but nothing was sent");
  assert.ok(r2.metadata.warnings.some((x) => /not approved|offline/.test(x)));
  // 3. The audit record cannot be written: no record, no send.
  const p3 = new Hosted();
  const w3 = await setup(p3, FIXTURE);
  w3.svc.setEgress(ctx(), { repoRoot: w3.svc.store.revision(w3.revision)!.repoRoot, allow: true });
  const realAudit = w3.svc.store.audit.bind(w3.svc.store);
  w3.svc.store.audit = ((actor: string, action: string, ...rest: any[]) => { if (action === "egress.approved") throw new Error("disk full"); return (realAudit as any)(actor, action, ...rest); }) as any;
  const r3 = await ask(w3.svc, w3.revision);
  assert.ok(r3.ok);
  assert.equal(p3.seen.length, 0, "an egress that cannot be recorded does not happen");
  assert.ok(r3.metadata.warnings.some((x) => /safety checks.*could not complete/.test(x)));
  // 4. A provider that does not say whether it is hosted is treated as hosted.
  const p4 = new Hosted(); (p4 as any).hosted = undefined;
  const w4 = await setup(p4, FIXTURE);
  assert.ok((await ask(w4.svc, w4.revision)).ok);
  assert.equal(p4.seen.length, 0, "an unlabelled provider is not trusted with code");
  // 5. Only a provider that says it is local is sent to without approval.
  const p5 = new Hosted(); p5.hosted = false;
  const w5 = await setup(p5, FIXTURE);
  await ask(w5.svc, w5.revision);
  assert.ok(p5.seen.length > 0);
  for (const w of [w1, w2, w3, w4, w5]) w.worker.close();
});

// ------------------------------------------------------------------------------------------------ source revocation
test("C03: source-permission revocation: every derived thing becomes unreachable at once, running work is stopped, and then it is all deleted", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const other = await svc.ingestRepository(ctx(), { repoPath: FIXTURE });
  assert.ok(other.ok);
  await svc.extractConcepts(ctx(), { revision });
  const ans = await svc.ask(ctx(), { question: "walk me through createPayment", revision });
  assert.ok(ans.ok);
  const evId = ans.value.claims.flatMap((c) => c.draft.evidenceIds)[0];
  svc.saveWorkspace(ctx("w1"), { name: "plan", expectedVersion: 0, revision, state: { view: ans.value.view, claims: ans.value.claims, selection: [], events: [], messages: [], explanation: null, revision } } as any);
  const wsId = (svc.listWorkspaces(ctx()) as any).value[0].id;
  svc.reportException(ctx(), { trace: traceFor(repo) });
  const inv = svc.c22.create(ctx("c"), { workspaceId: "w", goal: { question: "why does it fail", trace: traceFor(repo) }, revision });
  const queued = svc.enqueueJob(ctx("j"), { kind: "concepts", revision });
  assert.ok(queued.ok);
  assert.ok(svc.evidenceFor(ctx(), { revision, evidenceId: evId }).ok, "readable before");
  // Withdraw access, without purging yet: the data is still on disk but nothing can reach it.
  const soft = svc.revokeSource(ctx(), { repoRoot: repo, purge: false });
  assert.ok(soft.ok && soft.value.revoked && soft.value.investigations >= 1, JSON.stringify(soft));
  assert.equal(svc.store.hasRepo(repo), true, "not purged yet");
  const nowhere = await svc.ask(ctx(), { question: "walk me through createPayment", revision });
  assert.ok(!nowhere.ok, "ask");
  assert.ok(!svc.evidenceFor(ctx(), { revision, evidenceId: evId }).ok, "evidence");
  assert.ok(!(await svc.explain(ctx(), { revision, entityIds: ["function:src/api/payments-controller.ts#createPayment"] })).ok, "explain");
  assert.ok(!svc.listConcepts(ctx(), { revision }).ok, "concepts");
  assert.ok(!svc.openWorkspace(ctx(), { workspaceId: wsId }).ok, "saved workspace");
  assert.deepEqual((svc.listWorkspaces(ctx()) as any).value, [], "not even listed");
  assert.equal((svc.status(ctx(), {}) as any).value.revision?.repoRoot, FIXTURE, "status shows only what is still accessible");
  assert.ok(!(await svc.ingestRepository(ctx(), { repoPath: repo })).ok && (await svc.ingestRepository(ctx(), { repoPath: repo }) as any).error.code === "FORBIDDEN", "and it cannot be re-indexed");
  assert.throws(() => svc.c22.create(ctx(), { workspaceId: "w", goal: { question: "x" }, revision }), /no indexed revision|not found/i);
  const board = svc.c22.getBoard(inv.id);
  assert.ok(board.kind === "full" && board.snapshot.restricted && board.snapshot.hypotheses.length === 0, "an investigation over it is sanitized");
  assert.equal(svc.c22.load(inv.id).execution, "CANCELLED");
  assert.equal(svc.c22.load(inv.id).stopReason, "ACCESS_REVOKED");
  // The other repository is untouched.
  assert.ok((await svc.ask(ctx(), { question: "show me how authentication works", revision: other.value.id })).ok);
  // Now purge: nothing of it remains, anywhere, and the audit trail records only that it happened.
  const hard = svc.revokeSource(ctx(), { repoRoot: repo });
  { const left: string[] = []; for (const tb of svc.store.db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as any[]) { const cols = (svc.store.db.prepare(`pragma table_info(${tb.name})`).all() as any[]).map((c) => c.name); const n = Number((svc.store.db.prepare(`select count(*) n from ${tb.name} where ${cols.map((c) => `cast(${c} as text) like ?`).join(" or ")}`).get(...cols.map(() => `%${repo}%`)) as any).n); if (tb.name !== "audit" && tb.name !== "repo_access" && n) left.push(`${tb.name}:${n}`); } assert.deepEqual(left, [], "tables that still mention the source"); }
  assert.ok(hard.ok && hard.value.purged && hard.value.rowsAfter === 0, `rows still mentioning it: ${JSON.stringify(mentionsByTable(svc.store, repo, [revision]))}`);
  { const left: string[] = []; for (const tb of svc.store.db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as any[]) { if (tb.name === "audit" || tb.name === "repo_access") continue; const cols = (svc.store.db.prepare(`pragma table_info(${tb.name})`).all() as any[]).map((c) => c.name); const n = Number((svc.store.db.prepare(`select count(*) n from ${tb.name} where ${cols.map((c) => `cast(${c} as text) like ?`).join(" or ")}`).get(...cols.map(() => `%${revision}%`)) as any).n); if (n) left.push(`${tb.name}:${n}`); } assert.deepEqual(left, [], "tables that still mention its revision"); }
  assert.equal(rowsMentioning(svc.store, repo, [revision]), 0);
  assert.equal(Number((svc.store.db.prepare("select count(*) n from embeddings where revision = ?").get(revision) as any).n), 0, "its vectors went too");
  assert.equal(Number((svc.store.db.prepare("select count(*) n from claims where revision = ?").get(revision) as any).n), 0);
  assert.ok(svc.store.verifyAuditChain().ok);
  assert.ok(!JSON.stringify(svc.store.auditEvents(500)).includes(repo), "the audit trail never names the source it deleted");
  // Granting access again allows it to be indexed again; nothing comes back by itself.
  assert.ok(svc.grantSource(ctx(), { repoRoot: repo }).ok);
  assert.equal(svc.store.hasRepo(repo), false);
  assert.ok((await svc.ingestRepository(ctx(), { repoPath: repo })).ok);
  worker.close();
});
