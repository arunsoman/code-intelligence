/**
 * F11 — publishing the impact comment (acceptance A1, A2, A3, A4, A6, A13) and the service operations
 * C23/getImpactReport, C23/explainImpactItem, C30/previewImpactComment, C30/publishImpactComment.
 *
 * The analysis and its impact report are seeded directly (the builder itself is covered by impact-report.test.ts);
 * the forge is a fake in-memory transport, so no publication ever leaves the machine. No worker is needed: nothing
 * here runs an index.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ImpactReport } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient, defaultWorkerPath } from "../src/worker.ts";
import { newGrant, type GitHubTransport } from "../src/pr-publish.ts";
import { buildImpactReport, DEFAULT_IMPACT_POLICY, impactReportHash, type ImpactBuildInput } from "../src/impact-report.ts";
import { checkCommentContract, IMPACT_MARKER } from "../src/impact-render.ts";
import { ctx } from "./helpers.ts";

const REPO_ID = "repo-payments";
const REPO_ROOT = "/srv/git/payments";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const CHARGE = "function:src/payments/payment-service.ts#charge";

// ---------------------------------------------------------------- fake forge (the pr-flow pattern, trimmed)

function fakeForge() {
  const state = { heads: new Map<number, string | undefined>(), vis: "private" as "public" | "private" };
  const comments = new Map<number, { id: string; body: string }[]>();
  const t: GitHubTransport = {
    resolvePrHead: async (prNumber) => state.heads.get(prNumber) ?? null,
    visibility: async () => state.vis,
    publishStatus: async (sha, s) => ({ id: `st-${sha.slice(0, 6)}`, url: `http://statuses/${s.context}` }),
    findStatus: async () => null,
    findComment: async (prNumber, marker) => (comments.get(prNumber) ?? []).find((c) => c.body.includes(marker)) ?? null,
    postComment: async (prNumber, body) => {
      const list = comments.get(prNumber) ?? [];
      const id = `c-${prNumber}-${list.length + 1}`;
      list.push({ id, body });
      comments.set(prNumber, list);
      return { id };
    },
    updateComment: async (commentId, body) => {
      for (const list of comments.values()) { const hit = list.find((c) => c.id === commentId); if (hit) hit.body = body; }
      return { id: commentId };
    },
  };
  return { t, state, comments };
}

function attachForge(svc: Service, forge: ReturnType<typeof fakeForge>): void {
  const pub = svc.prPublisher as unknown as { transportFor: (root: string) => GitHubTransport; selfUrl: string | null };
  Object.defineProperty(pub, "transportFor", { value: () => forge.t, configurable: true });
  Object.defineProperty(pub, "selfUrl", { value: "https://cie.test", configurable: true });
}

// ---------------------------------------------------------------- seeded analysis + report

const csOf = (): ImpactBuildInput["cs"] => ({
  base: "rev-base", head: "rev-head",
  entities: [{ canonId: "c1", base: CHARGE, head: CHARGE, change: "MODIFIED" }],
  textDiff: { filesChanged: 1, symbolsTouched: 1 },
  consequences: [{
    id: "csq:1", kind: "ERROR_PATH_ADDED", text: "charge can now throw InsufficientFunds.",
    evidenceIds: ["ev:1"], claimId: "clm:1", displayMode: "FACT",
  }],
  claims: [],
  blastRadius: [{ entityId: CHARGE, dependents: 4, files: ["src/api/payments-controller.ts"] }],
  testImpact: [{ entityId: CHARGE, lost: ["payments.test › rolls back on failure"], gained: [], unchanged: [] }],
  gaps: [],
});

const reportFor = (over: Partial<ImpactBuildInput> = {}): ImpactReport =>
  buildImpactReport({
    analysisId: "pna:x", baseHash: BASE, headHash: HEAD, cs: csOf(),
    coverage: { source: "REPOSITORY", executableChangedLines: 2, covered: 2, percent: 80, disclosure: "coverage artifact" },
    analyzers: [{ id: "defect-detectors", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 12, skippedFiles: 0, reason: "scope" } }],
    unresolvedDynamicCalls: 0, incomplete: false, incompleteReasons: [], now: "2026-10-07T10:00:00.000Z",
    ...over,
  });

/** Seed one PR analysis row plus its CURRENT impact report. */
function seed(svc: Service, analysisId: string, headHash: string, report: ImpactReport, state = "DECIDED"): void {
  report.analysisId = analysisId; // the seeded row is the report's identity (reportFor builds a generic one)
  const now = "2026-10-07T10:00:00.000Z";
  svc.store.db.prepare("insert into pr_analyses values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    analysisId, REPO_ID, "github", 1, REPO_ROOT, BASE, headHash, BASE, "acme/payments",
    "rev-base", "rev-head", "pol", "polhash", "ash", state, null, 1, null, now, now);
  svc.store.db.prepare("insert into impact_reports values (?,?,?,?,?,?)")
    .run(analysisId, JSON.stringify(report), impactReportHash(report), "CURRENT", now, now);
}

// These tests seed analysis rows directly and never index, so the parser child is never addressed. When the Rust
// worker is built it is used; until then an idle stand-in keeps the suite runnable on a fresh checkout.
const workerPath = (() => { try { return defaultWorkerPath(); } catch { return "/bin/cat"; } })();
const newSvc = () => new Service(new Store(":memory:"), new WorkerClient(workerPath), new StubProvider());
const impactGrant = (svc: Service) => newGrant(svc.store, { repositoryId: REPO_ID, headHash: HEAD, principalId: "t", operation: "PUBLISH_IMPACT", ttlMs: 60_000 });

// ---------------------------------------------------------------- C23: reading the report

test("C23/getImpactReport returns the stored report; unknown analyses are NOT_FOUND", () => {
  const svc = newSvc();
  const report = reportFor();
  seed(svc, "pna:one", HEAD, report);
  const hit = svc.prOps["C23/getImpactReport"](ctx(), { analysisId: "pna:one" });
  assert.equal(hit.ok, true);
  if (hit.ok) {
    assert.equal(hit.value.analysisId, "pna:one");
    assert.equal(impactReportHash(hit.value as ImpactReport), impactReportHash(report));
  }
  const miss = svc.prOps["C23/getImpactReport"](ctx(), { analysisId: "pna:none" });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.error.code, "NOT_FOUND");
});

test("C23/explainImpactItem answers why-this for a surfaced item and not-found for unknown ids", () => {
  const svc = newSvc();
  const report = reportFor();
  seed(svc, "pna:one", HEAD, report);
  const itemId = report.surfaced[0].id;
  const hit = svc.prOps["C23/explainImpactItem"](ctx(), { analysisId: "pna:one", itemId });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.value.kind, "surfaced");
  const miss = svc.prOps["C23/explainImpactItem"](ctx(), { analysisId: "pna:one", itemId: "imp:missing" });
  assert.equal(miss.ok, true);
  if (miss.ok) assert.equal(miss.value.kind, "not-found");
});

// ---------------------------------------------------------------- F11-A13: the dry run is what gets posted

test("F11-A13: C30/previewImpactComment is byte-identical to the comment C30/publishImpactComment posts", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  seed(svc, "pna:one", HEAD, reportFor());
  const preview = await svc.prOps["C30/previewImpactComment"](ctx(), { analysisId: "pna:one" });
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(checkCommentContract(preview.value.markdown).ok, true);
  const stamped = reportFor();
  stamped.analysisId = "pna:one"; // seed() stamps the stored report with the analysis id
  assert.equal(preview.value.reportHash, impactReportHash(stamped));
  const published = await svc.prOps["C30/publishImpactComment"](ctx(), { analysisId: "pna:one" });
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.value.state, "PUBLISHED");
  const posted = forge.comments.get(1) ?? [];
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body, preview.value.markdown, "the publisher posted exactly the previewed markdown");
});

test("C30/previewImpactComment validates a caller-supplied policy and reports NOT_FOUND without a report", async () => {
  const svc = newSvc();
  seed(svc, "pna:one", HEAD, reportFor());
  const bad = await svc.prOps["C30/previewImpactComment"](ctx(), { analysisId: "pna:one", policy: { minScore: -1 } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, "INVALID_SCHEMA");
  const miss = await svc.prOps["C30/previewImpactComment"](ctx(), { analysisId: "pna:none" });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.error.code, "NOT_FOUND");
});

// ---------------------------------------------------------------- F11-A4: one comment per head, receipts repeat

test("F11-A4: a repeated delivery for one head updates the one comment and repeats the same receipt", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  seed(svc, "pna:one", HEAD, reportFor());
  const g1 = impactGrant(svc);
  const r1 = await svc.prPublisher.publishImpact(g1.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(r1.state, "PUBLISHED");
  const g2 = impactGrant(svc);
  const r2 = await svc.prPublisher.publishImpact(g2.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(r2.state, "PUBLISHED");
  assert.equal(r2.publicationId, r1.publicationId, "the same saying returns the same receipt");
  assert.equal((forge.comments.get(1) ?? []).length, 1, "find-before-create: still exactly one impact comment");
});

// ---------------------------------------------------------------- F11-A1: a moved head is never published

test("F11-A1: when the PR head moved after the report, publication fails STALE_REVISION and nothing is posted", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  forge.state.heads.set(1, "f".repeat(40));
  attachForge(svc, forge);
  seed(svc, "pna:one", HEAD, reportFor());
  const g = impactGrant(svc);
  const receipt = await svc.prPublisher.publishImpact(g.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(receipt.state, "FAILED");
  assert.match(receipt.lastError ?? "", /STALE_REVISION/);
  assert.equal((forge.comments.get(1) ?? []).length, 0, "a stale report is superseded, not published");
});

// ---------------------------------------------------------------- F11-A6: silence is a designed outcome

test("F11-A6: with nothing above the threshold nothing is posted; a stale earlier comment is retired", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  const silentReport = reportFor({ policy: { ...DEFAULT_IMPACT_POLICY, minScore: 1000 } });
  seed(svc, "pna:one", HEAD, silentReport);

  const g1 = impactGrant(svc);
  const r1 = await svc.prPublisher.publishImpact(g1.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(r1.state, "PREPARED", "silent: no comment, but the attempt is recorded");
  assert.match(r1.lastError ?? "", /silent/);
  assert.equal((forge.comments.get(1) ?? []).length, 0);

  // an earlier impact comment exists — it must not keep claiming stale items
  await forge.t.postComment(1, IMPACT_MARKER + "\n## CIE blast radius\n\n1. INFERENCE  old item.\n\nNot shown: 0 item(s) — why?");
  const g2 = impactGrant(svc);
  const r2 = await svc.prPublisher.publishImpact(g2.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(r2.state, "PUBLISHED");
  const comments = forge.comments.get(1) ?? [];
  assert.equal(comments.length, 1, "still one comment — updated, not appended");
  assert.match(comments[0].body, /no longer apply/i);
  assert.ok(comments[0].body.startsWith(IMPACT_MARKER));
});

// ---------------------------------------------------------------- grants: the operation is enforced

test("a grant for another operation cannot publish an impact comment", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  seed(svc, "pna:one", HEAD, reportFor());
  const wrong = newGrant(svc.store, { repositoryId: REPO_ID, headHash: HEAD, principalId: "t", operation: "PUBLISH_CHECK" });
  await assert.rejects(
    () => svc.prPublisher.publishImpact(wrong.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" }),
    (e: unknown) => (e as { code?: string }).code === "FORBIDDEN",
  );
  assert.equal((forge.comments.get(1) ?? []).length, 0);
});

// ---------------------------------------------------------------- F11-A3: evidence deletion is visible at publish time

test("F11-A3: deleting the evidence row drops the dependent line from the published comment", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  // The consequence cites ev:1; the store has the row for the first analysis only.
  svc.store.putEvidence("rev-head", { id: "ev:1" } as never);
  seed(svc, "pna:with-evidence", HEAD, reportFor());
  const g1 = impactGrant(svc);
  const r1 = await svc.prPublisher.publishImpact(g1.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:with-evidence" });
  assert.equal(r1.state, "PUBLISHED");
  const body1 = (forge.comments.get(1) ?? [])[0].body;
  assert.match(body1, /can now throw InsufficientFunds/, "the evidence-backed line is published");

  // A new head, same consequence, but the evidence row is gone: the line cannot be produced.
  svc.store.db.prepare("delete from evidence where revision = 'rev-head' and id = 'ev:1'").run();
  const head2 = "H".repeat(40);
  const report2 = buildImpactReport({
    analysisId: "pna:ev-gone", baseHash: BASE, headHash: head2, cs: csOf(),
    coverage: { source: "REPOSITORY", executableChangedLines: 2, covered: 2, percent: 80, disclosure: "coverage artifact" },
    analyzers: [{ id: "defect-detectors", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 12, skippedFiles: 0, reason: "scope" } }],
    unresolvedDynamicCalls: 0, incomplete: false, incompleteReasons: [], now: "2026-10-07T10:05:00.000Z",
  });
  seed(svc, "pna:ev-gone", head2, report2);
  const g2 = newGrant(svc.store, { repositoryId: REPO_ID, headHash: head2, principalId: "t", operation: "PUBLISH_IMPACT", ttlMs: 60_000 });
  const r2 = await svc.prPublisher.publishImpact(g2.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:ev-gone", headHash: head2 });
  assert.equal(r2.state, "PUBLISHED");
  // find-before-create: the one impact comment on the PR is updated in place
  const comments = forge.comments.get(1) ?? [];
  assert.equal(comments.length, 1);
  const body2 = comments[0].body;
  assert.ok(!body2.includes("can now throw InsufficientFunds"), "the line whose evidence was deleted is not produced");
  assert.match(body2, /Not shown: 1 item\(s\)/);
});

// ---------------------------------------------------------------- F11-A2: INCOMPLETE is stated first

test("F11-A2: publishing an INCOMPLETE analysis states the incompleteness before any item", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  const incompleteReport = reportFor({
    analyzers: [{ id: "defect-detectors", version: "1", state: "TIMED_OUT", coverage: { analyzedFiles: 2, skippedFiles: 10, reason: "scope" }, reason: "timed out after 300 s" }],
  });
  seed(svc, "pna:one", HEAD, incompleteReport, "INCOMPLETE");
  const preview = await svc.prOps["C30/previewImpactComment"](ctx(), { analysisId: "pna:one" });
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  const md = preview.value.markdown;
  const incompleteAt = md.indexOf("INCOMPLETE");
  const firstItemAt = md.search(/\d\. (FACT|INFERENCE)/);
  assert.ok(incompleteAt > 0 && (firstItemAt === -1 || incompleteAt < firstItemAt));
  const g = impactGrant(svc);
  const receipt = await svc.prPublisher.publishImpact(g.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(receipt.state, "PUBLISHED", "an INCOMPLETE analysis still publishes — saying so first");
});

// ---------------------------------------------------------------- public repository + denied scope: refused

test("a public repository whose scope is narrower than the platform's publishes nothing (FORBIDDEN)", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  forge.state.vis = "public";
  attachForge(svc, forge);
  svc.store.db.prepare("insert into access_deny values (?,?)").run(REPO_ROOT, "src/secret");
  seed(svc, "pna:one", HEAD, reportFor());
  const g = impactGrant(svc);
  const receipt = await svc.prPublisher.publishImpact(g.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(receipt.state, "FAILED");
  assert.match(receipt.lastError ?? "", /FORBIDDEN/);
  assert.equal((forge.comments.get(1) ?? []).length, 0);
});

// ---------------------------------------------------------------- supersession: a new head supersedes the old saying

test("a new head's publication supersedes the earlier impact receipt for the same PR", async () => {
  const svc = newSvc();
  const forge = fakeForge();
  attachForge(svc, forge);
  seed(svc, "pna:one", HEAD, reportFor());
  const g1 = impactGrant(svc);
  const r1 = await svc.prPublisher.publishImpact(g1.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:one" });
  assert.equal(r1.state, "PUBLISHED");

  const head2 = "H".repeat(40);
  const report2 = reportFor({ now: "2026-10-07T10:05:00.000Z" });
  seed(svc, "pna:two", head2, report2);
  const g2 = newGrant(svc.store, { repositoryId: REPO_ID, headHash: head2, principalId: "t", operation: "PUBLISH_IMPACT", ttlMs: 60_000 });
  const r2 = await svc.prPublisher.publishImpact(g2.id, { repositoryId: REPO_ID, prNumber: 1, analysisId: "pna:two", headHash: head2 });
  assert.equal(r2.state, "PUBLISHED");
  assert.notEqual(r2.publicationId, r1.publicationId);
  const old = svc.store.db.prepare("select state from check_publications where id = ?").get(r1.publicationId) as { state: string };
  assert.equal(old.state, "SUPERSEDED", "the old saying is superseded, never reused");
  assert.equal((forge.comments.get(1) ?? []).length, 1);
});
