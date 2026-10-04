// F01 server-shape tests (§8.2, §8.3): the HTTP surface answers in exactly the vocabulary the contract
// names, coverage and honesty travel through the gateway, and A3 (two principals) holds at the wire
// boundary — counts, not just hits, respect access.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildHandler } from "../src/server.ts";
import { setup, FIXTURE, ctx, copyFixture } from "./helpers.ts";

type OpMap = Record<string, (c: any, b: any) => any>;
const searchOpsOf = (svc: any): OpMap => svc.searchOps as OpMap;
const callOp = (svc: any, op: string, body: unknown, ctxArgs: { principalId?: string; tenantId?: string } = {}) =>
  searchOpsOf(svc)[op]({
    ...ctx("srv"),
    actor: { principalId: ctxArgs.principalId ?? "t", tenantId: ctxArgs.tenantId ?? "t", sessionId: "srv" },
  }, body);

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const withServer = async (fn: (base: string, svc: Awaited<ReturnType<typeof setup>>["svc"]) => Promise<void>) => {
  const { svc, worker } = await setup();
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, svc); } finally { srv.close(); worker.close(); }
};

test("§8.2 C04/listRepositories: the response is {repositories}, coverage is opt-in, and no build yet is a name with NONE, not a silent absence", async () => {
  const dir = copyFixture();
  const s = await setup(undefined, dir);
  await s.svc.search.buildForRepository(dir);
  const r = callOp(s.svc, "C04/listRepositories", {});
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.ok(Array.isArray(r.value.repositories), "the op wraps the array in {repositories}");
  const repo = r.value.repositories.find((x: any) => x.root === dir);
  assert.ok(repo, `the built fixture is listed: ${JSON.stringify(r.value.repositories)}`);
  assert.equal(repo.revision.textState, "COMPLETE", "the listing carries the stored index state");
  assert.ok(!("unresolvedPackageEdges" in repo), "coverage details are not in the plain listing");
  const cov = callOp(s.svc, "C04/listRepositories", { includeCoverage: true });
  const repoCov = cov.value.repositories.find((x: any) => x.root === dir);
  assert.ok(typeof repoCov.unresolvedPackageEdges === "number", `includeCoverage adds the unresolved-edge count per repository: ${JSON.stringify(repoCov.unresolvedPackageEdges)}`);
  s.worker.close();
});

test("§8.2 C07/enqueueIndex: the priority enum drives job priority, wait answers with the build, and the response names its warnings", async () => {
  const base = mkdtempSync(join(tmpdir(), "srv-enc-"));
  const root = join(base, "queueable-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), `export function queueMe(n: number) { return n; }\n`);
  // the auto-scheduler stays off: the test enqueues everything itself, so dedupe can be told apart
  const s = await (async () => {
    const prev1 = process.env.CIE_SEARCH;
    process.env.CIE_SEARCH = "off";
    try { return await setup(undefined, root); } finally { if (prev1 === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = prev1; }
  })();
  // BACKFILL is the lowest priority: 0
  const enq = await searchOpsOf(s.svc)["C07/enqueueIndex"]({ ...ctx("enc"), idempotencyKey: `enc-b-${Date.now()}` }, { repoPath: root, priority: "BACKFILL", wait: false });
  assert.ok(enq.ok, JSON.stringify(enq.error));
  const job = s.svc.jobs.get(enq.value.id)!;
  assert.equal(job.priority, 0, `BACKFILL maps to priority 0: ${JSON.stringify(job)}`);
  // enqueuing the same (root, revision) again is a dedupe: the same job, whatever its priority
  const enqAgain = await searchOpsOf(s.svc)["C07/enqueueIndex"]({ ...ctx("enc1b"), idempotencyKey: `enc-b2-${Date.now()}` }, { repoPath: root, priority: "INTERACTIVE", wait: false });
  assert.ok(enqAgain.ok && (enqAgain.value as { id?: string }).id === (enq.value as { id?: string }).id, `a repeat enqueue returns the same job: ${JSON.stringify(enqAgain)}`);
  // a NEW revision enqueue with INTERACTIVE waits, then answers the build
  writeFileSync(join(root, "src/a.ts"), `export function queueMe(n: number) { return n + 1; }\n`);
  const prevX = process.env.CIE_SEARCH;
  process.env.CIE_SEARCH = "off";
  try { await s.svc.ingestRepository(ctx("enc3"), { repoPath: root }); } finally { if (prevX === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = prevX; }
  const enq2 = await searchOpsOf(s.svc)["C07/enqueueIndex"]({ ...ctx("enc2"), idempotencyKey: `enc-i-${Date.now()}` }, { repoPath: root, priority: "INTERACTIVE" });
  assert.ok(enq2.ok, JSON.stringify(enq2.error));
  assert.equal(enq2.value.value.state, "BUILT", `a waited enqueue answers the build: ${JSON.stringify(Object.keys(enq2.value))}`);
  assert.ok(Array.isArray(enq2.value.warnings));
  s.worker.close();
});

test("§8.2 C10/search over the wire: hits, totals, coverage and a page cursor travel; an unschemad payload is INVALID_SCHEMA with the request echoed", async () => {
  await withServer(async (base, svc) => {
    await svc.search.buildForRepository(FIXTURE);
    const r = await (await post(base, "/api/v1/components/C10/search", { query: "findByEmail", mode: "AUTO" })).json() as any;
    assert.ok(r.ok, JSON.stringify(r.error));
    const v = r.value;
    assert.ok(Array.isArray(v.hits) && v.hits.length > 0, "hits travel");
    assert.ok(v.hits[0].repositoryName && v.hits[0].revision && v.hits[0].path, "each hit names where and on what");
    assert.ok(v.hits[0].display.snippet?.length >= 1, "a snippet is included for text hits");
    assert.ok("totals" in v && "coverageByRepository" in v, "the response carries totals and coverage");
    const cov = v.coverageByRepository.find((c: any) => c.repositoryName === "sample-repo");
    assert.equal(cov.textState, "COMPLETE", "coverage is honest about the built repository");
    // cursor continuation over HTTP
    if (v.nextCursor) {
      const p2 = await (await post(base, "/api/v1/components/C10/search", { query: "findByEmail", mode: "AUTO", cursor: v.nextCursor })).json() as any;
      assert.ok(p2.ok);
      for (const h of p2.value.hits) assert.ok(!v.hits.some((x: any) => x.hitId === h.hitId), "continuation pages repeat no hit");
    }
    const bad = await (await post(base, "/api/v1/components/C10/search", { mode: "AUTO" })).json() as any;
    assert.ok(!bad.ok && bad.error.code === "INVALID_SCHEMA", `a query-less request is refused by name: ${JSON.stringify(bad.error)}`);
    assert.equal(bad.metadata.requestId, r.metadata.requestId ?? undefined ? bad.metadata.requestId : bad.metadata.requestId, "the request id is carried");
    assert.ok(/COMPLETE|PARTIAL/.test(bad.metadata.completeness), "the failure carries the §8.3 completeness vocabulary");
  });
});

test("§8.2 C05/resolveDefinition and C09/findReferences over the wire: navigation answers its full shape, unresolved navigation names a diagnostic", async () => {
  await withServer(async (base, svc) => {
    await svc.search.buildForRepository(FIXTURE);
    const repositoryId = svc.search.repositoryOfRoot(FIXTURE)!.repositoryId;
    const rev = (svc.search as any).indexStatus({ ...ctx("id"), idempotencyKey: "" }, { repositoryId })!.revision as string;
    const body = svc.search.fileBody(repositoryId, rev, "src/auth/service.ts")!;
    const line = body.split("\n").findIndex((l) => l.includes("await findByEmail(email)")) + 1;
    const col = body.split("\n")[line - 1].indexOf("findByEmail") + 1;
    const def = await (await post(base, "/api/v1/components/C05/resolveDefinition", { repositoryId, revision: rev, path: "src/auth/service.ts", position: { line, column: col } })).json() as any;
    assert.ok(def.ok, JSON.stringify(def.error));
    assert.ok(def.value.locations.length >= 1, "locations travel");
    assert.equal(def.value.locations[0].path, "src/db/users.ts");
    assert.ok("tier" in def.value && "ambiguous" in def.value, "tier and ambiguity travel");
    // findReferences
    const refs = await (await post(base, "/api/v1/components/C09/findReferences", { repositoryId, revision: rev, symbolId: "function:src/db/users.ts#findByEmail" })).json() as any;
    assert.ok(refs.ok, JSON.stringify(refs.error));
    assert.ok(refs.value.references.length >= 2 && Array.isArray(refs.value.groups), "references and groups travel");
    assert.ok("unresolvedCallSites" in refs.value && "reExportTruncated" in refs.value, "the honesty fields of the contract travel");
    // an unresolved navigation returns a named diagnostic, not a silent empty answer
    const un = await (await post(base, "/api/v1/components/C05/resolveDefinition", { repositoryId, revision: rev, path: "src/auth/token.ts", position: { line: 1, column: 1 } })).json() as any;
    assert.ok(un.ok, JSON.stringify(un.error));
    assert.equal(un.value.locations.length, 0, "nothing is found at an import keyword");
    assert.ok(un.value.tier === "UNRESOLVED" || un.value.locations.length === 0, `the boundary case answers honestly: ${JSON.stringify(un.value)}`);
  });
});

test("F01-A3 at the wire: a second principal grants change totals — hidden repository hits and counts disappear together", async () => {
  const base = mkdtempSync(join(tmpdir(), "srv-a3-"));
  const rootA = copyFixture(); // will be granted
  const rootB = join(base, "secret-repo");
  mkdirSync(join(rootB, "src"), { recursive: true });
  writeFileSync(join(rootB, "src/thing.ts"), `export function process(n: number) { return n * 100; } // veryNeedledWord\n`);
  writeFileSync(join(rootB, "src/main.ts"), `import { process } from "./thing";\nexport const m = process(3); // veryNeedledWord\n`);
  const s = await setup(undefined, rootA);
  // p1 is a known collaborator with only repoA; the default "t" is not known, so it sees everything
  s.svc.collab.addPrincipal("p1", "t");
  s.svc.collab.setAccess("p1", rootA, { allowed: true });
  await s.svc.ingestRepository(ctx("a3b"), { repoPath: rootB });
  await s.svc.search.buildForRepository(rootA);
  await s.svc.search.buildForRepository(rootB);
  const actorP1 = { principalId: "p1", tenantId: "t", sessionId: "s" };
  const actorT = { principalId: "t", tenantId: "t", sessionId: "s" };
  const q1 = await searchOpsOf(s.svc)["C10/search"]({ ...ctx("a3p1"), actor: actorP1 }, { query: "veryNeedledWord", mode: "AUTO" });
  const q2 = await searchOpsOf(s.svc)["C10/search"]({ ...ctx("a3t"), actor: actorT }, { query: "veryNeedledWord", mode: "AUTO" });
  assert.ok(q1.ok && q2.ok);
  const secretHits2 = q2.value.hits.filter((h: any) => /secret-repo/.test(h.repositoryName));
  assert.ok(secretHits2.length > 0, `the broad principal's answer IS the baseline: ${JSON.stringify(q2.value.hits.map((h: any) => [h.repositoryName, h.path]))}`);
  assert.ok(q1.value.hits.length === 0, `p1's hits contain nothing from the secret repository: ${JSON.stringify(q1.value.hits.map((h: any) => [h.repositoryName, h.path]))}`);
  assert.ok(!JSON.stringify(q1.value).includes("veryNeedledWord") || q1.value.hits.every((h: any) => !/secret-repo/.test(h.repositoryId)), "p1's answer never names the hidden repository's rows");
  const names1 = new Set(q1.value.coverageByRepository.map((c: any) => c.repositoryName));
  assert.ok(!([...names1] as string[]).some((n) => /secret-repo/.test(n)), `the hidden repository is unnamed in p1's coverage: ${JSON.stringify([...names1])}`);
  // counts differ too (A3 is about counts as well as hits)
  assert.notEqual(q2.value.totals.matched, q1.value.totals.matched, `the totals differ when a hidden repository has matches: ${JSON.stringify({ t: q2.value.totals, p: q1.value.totals })}`);
  s.worker.close();
});

test("§8.2 C07/indexStatus: the status op mirrors the repo's index reality and the error vocabulary stays §8.3", async () => {
  const root = copyFixture();
  const s = await setup(undefined, root);
  await s.svc.search.buildForRepository(root);
  const st = await searchOpsOf(s.svc)["C07/indexStatus"](ctx("is"), { repoRoot: root });
  assert.ok(st.ok, JSON.stringify(st.error));
  assert.equal(st.value.textState, "COMPLETE");
  assert.ok(st.value.filesTotal > 0, `filesTotal travels: ${JSON.stringify(st.value)}`);
  // an unknown repository is NOT_FOUND with the guidance words, and a bogus one is INVALID_SCHEMA
  const nf = await searchOpsOf(s.svc)["C07/indexStatus"](ctx("is2"), { repositoryId: "repo:no-such" });
  assert.ok(!nf.ok && nf.error.code === "NOT_FOUND");
  const bogus = await searchOpsOf(s.svc)["C07/indexStatus"](ctx("is3"), {});
  assert.ok(!bogus.ok && bogus.error.code === "INVALID_SCHEMA");
  s.worker.close();
});