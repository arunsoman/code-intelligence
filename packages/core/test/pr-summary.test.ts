import { afterEach } from "node:test";
/**
 * F13 — PR summary and reading-order walkthrough (acceptance F13-A1..A11) and the service operation
 * C23/getPrSummary plus the summary section inside C30/previewImpactComment.
 *
 * The builder takes the ChangeSet plus injected, deterministic lookups, so every acceptance runs as a pure test
 * with no index and no worker. The two service tests seed analysis + report rows directly (the impact-publish
 * pattern); the forge is never addressed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ImpactReport, PrSummary } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient, defaultWorkerPath } from "../src/worker.ts";
import type { ChangeSet } from "../src/history.ts";
import type { AccessPolicy } from "../src/access.ts";
import type { Mentions } from "../src/mentions.ts";
import {
  buildPrSummary, finalizeSummaryBudget, renderSummarySection, checkSummaryLine, countsLine,
  stripDescription, consequenceNoteFor, SUMMARY_MARKER, SUMMARY_BUDGET_BYTES, MAX_READING_ORDER_LINES,
  type PrSummaryInput,
} from "../src/pr-summary.ts";
import { buildImpactReport } from "../src/impact-report.ts";
import { ctx } from "./helpers.ts";

// ---------------------------------------------------------------- fixture: a payments PR

const COMMIT = "function:src/payments/commit.ts#commit";
const BEGIN = "function:src/payments/commit.ts#begin";
const ADJUST = "function:src/payments/ledger.ts#adjustBalance";
const CHARGE = "function:src/payments/api.ts#charge";
const RECORD = "function:src/audit/log.ts#record";
const GHOST = "function:src/secret/ghost.ts#ghost";
const LOGIN = "function:src/auth/session.ts#login";
const RETRY = "function:src/net/retry.ts#retryOnTimeout";
const TEST1 = "test:tests/commit.test.ts#rolls back on failure";
const TEST2 = "test:tests/commit.test.ts#compensates on timeout";

const FILES: Record<string, string> = {
  [COMMIT]: "src/payments/commit.ts", [BEGIN]: "src/payments/commit.ts",
  [ADJUST]: "src/payments/ledger.ts", [CHARGE]: "src/payments/api.ts",
  [RECORD]: "src/audit/log.ts", [GHOST]: "src/secret/ghost.ts", [LOGIN]: "src/auth/session.ts",
  [RETRY]: "src/net/retry.ts", [TEST1]: "tests/commit.test.ts", [TEST2]: "tests/commit.test.ts",
};

const DEPS: Record<string, string[]> = {
  [COMMIT]: [ADJUST, CHARGE],   // commit is depended on by two changed entities
  [BEGIN]: [COMMIT],            // the new helper is called by the changed commit
  [ADJUST]: [CHARGE],
  [CHARGE]: ["function:src/api/controller.ts#handler", "function:src/api/controller.ts#admin", "function:src/jobs/nightly.ts#run", "function:src/ui/pay.tsx#PayButton", "function:test:e2e.ts#e2e"],
  [RECORD]: [], [GHOST]: [], [LOGIN]: [], [RETRY]: [],
};

const SIZES: Record<string, number> = { [RECORD]: 500, [LOGIN]: 100, [COMMIT]: 900, [BEGIN]: 40, [ADJUST]: 300, [CHARGE]: 200 };

const csOf = (): ChangeSet => ({
  base: "rev-base", head: "rev-head",
  entities: [
    { canonId: "c-commit", base: COMMIT, head: COMMIT, change: "MODIFIED" },
    { canonId: "c-begin", base: null, head: BEGIN, change: "ADDED" as const },
    { canonId: "c-adjust", base: ADJUST, head: ADJUST, change: "MODIFIED" },
    { canonId: "c-charge", base: CHARGE, head: CHARGE, change: "MODIFIED" },
    { canonId: "c-record", base: RECORD, head: RECORD, change: "MODIFIED" },
    { canonId: "c-ghost", base: GHOST, head: GHOST, change: "MODIFIED" },
    { canonId: "c-login", base: LOGIN, head: LOGIN, change: "MODIFIED" },
    { canonId: "c-test1", base: null, head: TEST1, change: "ADDED" as const },
  ],
  textDiff: { filesChanged: 7, symbolsTouched: 8 },
  consequences: [
    { id: "csq:1", kind: "ERROR_PATH_ADDED", text: "commit can now throw InsufficientFunds.", evidenceIds: ["ev:1"], claimId: "clm:1", displayMode: "FACT" },
    { id: "csq:2", kind: "CALL_ADDED", text: "commit now calls begin.", evidenceIds: ["ev:2"], claimId: "clm:2", displayMode: "FACT" },
  ],
  claims: [],
  blastRadius: [{ entityId: COMMIT, dependents: 4, files: ["src/payments/ledger.ts"] }],
  testImpact: [{ entityId: COMMIT, lost: [TEST1], gained: [TEST2], unchanged: [] }],
  gaps: [],
});

const OPEN_ACCESS: AccessPolicy = { denied: () => false, deniedEntity: () => false, prefixes: [] };
const DENY_SECRET: AccessPolicy = { denied: (f) => f.startsWith("src/secret"), deniedEntity: () => false, prefixes: ["src/secret"] };

const inputOf = (over: Partial<PrSummaryInput> = {}): PrSummaryInput => ({
  cs: csOf(),
  access: OPEN_ACCESS,
  entityFile: (id) => FILES[id] ?? null,
  dependentsOf: (id) => DEPS[id] ?? [],
  isEntryPoint: (id) => id === CHARGE,
  changeSize: (id) => SIZES[id] ?? 0,
  ...over,
});

/** Mentions stub: resolves "commit" to the changed commit, "retryOnTimeout" to an unchanged symbol. */
const mentionsOf = (resolved: Mentions["resolved"] = [
  { text: "commit", how: "exact", matches: [{ entityId: COMMIT, name: "commit", kind: "function", file: FILES[COMMIT] }] },
  { text: "retryOnTimeout", how: "exact", matches: [{ entityId: RETRY, name: "retryOnTimeout", kind: "function", file: FILES[RETRY] }] },
], unresolved: string[] = ["WeirdSymbolX"]): Mentions => ({ resolved, unresolved });

const DESCRIPTION = "Make commit transactional and wire the retryOnTimeout path, also touches WeirdSymbolX handling.";

// ---------------------------------------------------------------- A1: counts are the compare() counts

test("F13-A1: counts equal compare() entity counts; a mutated counts line is rejected", async () => {
  const cs = csOf();
  const s = buildPrSummary(inputOf());
  assert.equal(s.counts.added, cs.entities.filter((e) => e.change === "ADDED").length);
  assert.equal(s.counts.modified, cs.entities.filter((e) => e.change === "MODIFIED").length);
  assert.equal(s.counts.deleted, 0);
  assert.equal(s.counts.files, new Set(Object.values(FILES)).size - 1); // RETRY is unchanged, not in the set
  assert.equal(s.counts.testFiles, 1);

  const good = checkSummaryLine({ kind: "COUNTS", text: countsLine(s.counts) }, { counts: s.counts });
  assert.deepEqual(good, { ok: true });
  const mutated = checkSummaryLine({ kind: "COUNTS", text: countsLine({ ...s.counts, modified: s.counts.modified + 1 }) }, { counts: s.counts });
  assert.equal(mutated.ok, false);
  if (!mutated.ok) assert.equal(mutated.rule, 3);
});

// ---------------------------------------------------------------- A2: no behaviour wording without a consequence

test("F13-A2: a changed function with no consequence record is described only as 'modified'", async () => {
  const s = buildPrSummary(inputOf());
  const commitLine = s.readingOrder.find((r) => r.path === "src/payments/commit.ts");
  const recordLine = s.readingOrder.find((r) => r.path === "src/audit/log.ts");
  assert.ok(commitLine && recordLine);
  assert.match(commitLine.note, /gains a guard that can throw/);      // ERROR_PATH_ADDED names commit
  assert.match(commitLine.note, /\(modified\)/);
  assert.doesNotMatch(recordLine.note, /transaction|guard|throw|now calls/);
  assert.match(recordLine.note, /\(modified\)/);
  // the mapping is a closed table: a kind with no phrase never produces wording
  assert.equal(consequenceNoteFor(RECORD, csOf()), null);
  assert.equal(consequenceNoteFor("function:x.ts#nobody", csOf()), null);
});

// ---------------------------------------------------------------- A3: reproducible order

test("F13-A3: the reading order is identical for shuffled input and across two builds", async () => {
  const a = buildPrSummary(inputOf());
  const shuffled = { ...csOf(), entities: [...csOf().entities].reverse(), consequences: [...csOf().consequences].reverse(), testImpact: [...csOf().testImpact].reverse() };
  const b = buildPrSummary(inputOf({ cs: shuffled }));
  assert.deepEqual(b.readingOrder, a.readingOrder);
  assert.deepEqual(b.highImpact, a.highImpact);
  assert.equal(JSON.stringify(finalizeSummaryBudget(b)), JSON.stringify(finalizeSummaryBudget(a)));
  // the fixture exercises every rule: depended-on first, entry point next, then size, tests last
  assert.deepEqual(a.readingOrder.map((r) => r.path), [
    "src/payments/commit.ts", "src/payments/ledger.ts", "src/payments/api.ts",
    "src/audit/log.ts", "src/auth/session.ts", "src/secret/ghost.ts", "tests/commit.test.ts",
  ]);
  assert.deepEqual(a.readingOrder[0].why.filter((w) => w.name === "DEPENDED_ON").map((w) => w.value), [2]);
});

// ---------------------------------------------------------------- A4: denied prefix counted, never named

test("F13-A4: a changed file in a denied prefix is counted in the budget, never named", async () => {
  const s = buildPrSummary(inputOf({ access: DENY_SECRET }));
  assert.ok(s.budget.omitted >= 1);
  assert.ok(!s.readingOrder.some((r) => r.path.includes("secret")));
  const rendered = renderSummarySection(s, {});
  assert.ok(!rendered.markdown.includes("ghost"));
  assert.ok(!rendered.markdown.includes("src/secret"));
});

// ---------------------------------------------------------------- A5: hostile title cannot ping, link or forge a marker

test("F13-A5: a hostile description is escaped — no ping, no link, no marker forgery", async () => {
  const hostile = 'Hey @ghost see #1 <!-- cie-summary --> `code` [click](https://evil.example/x) — and some more prose to pass the threshold.';
  const s = buildPrSummary(inputOf({
    descriptionText: hostile,
    resolveDescription: () => ({ resolved: [], unresolved: [] }),
  }));
  assert.ok(s.description);
  const rendered = renderSummarySection(s, {});
  assert.ok(!rendered.markdown.includes("@ghost"));        // the mention is broken with a zero-width escape
  assert.ok(rendered.markdown.includes("\\[click](https://evil.example/x)")); // the link is escaped, not live
  // the only HTML comments in the section are the two genuine markers (one at the top of the file-level check below)
  const forged = rendered.markdown.replace(SUMMARY_MARKER, "").replace("<!-- cie-gate:impact-comment -->", "");
  assert.ok(!forged.includes("<!--"));
  assert.ok(rendered.markdown.includes("Author's description (unverified)"));
});

// ---------------------------------------------------------------- A6: mentioned-but-not-changed and unresolved are separate

test("F13-A6: mentioned-not-changed and unresolved phrases are listed separately", async () => {
  const s = buildPrSummary(inputOf({ access: DENY_SECRET, descriptionText: DESCRIPTION, resolveDescription: () => mentionsOf() }));
  assert.ok(s.description);
  assert.deepEqual(s.description.mentionedNotChanged.map((m) => m.phrase), ["retryOnTimeout"]);
  assert.deepEqual(s.description.unresolved, ["WeirdSymbolX"]);
  // module-level aggregation: src/payments is mentioned (via commit); src/audit and src/auth are not
  const notMentioned = s.description.changedNotMentioned.map((c) => c.path);
  assert.ok(!notMentioned.includes("src/payments"));
  assert.ok(notMentioned.includes("src/audit"));
  assert.ok(notMentioned.includes("src/auth"));
  assert.ok(!notMentioned.includes("src/secret")); // denied prefix never named
  const rendered = renderSummarySection(s, {});
  assert.match(rendered.markdown, /Mentioned but not changed: "retryOnTimeout"/);
  assert.match(rendered.markdown, /not claimed as missing/);
  assert.match(rendered.markdown, /does not understand meaning/);
});

// ---------------------------------------------------------------- A7: empty or short description

test("F13-A7: an empty or short description yields 'no description to compare' and no lists", async () => {
  for (const text of ["", "   ", "fix typo"]) {
    const s = buildPrSummary(inputOf({ descriptionText: text, resolveDescription: () => mentionsOf() }));
    assert.equal(s.description, null, `description for ${JSON.stringify(text)}`);
    const rendered = renderSummarySection(s, {});
    assert.match(rendered.markdown, /no description to compare/i);
    assert.ok(!rendered.markdown.includes("Mentioned but not changed"));
  }
});

// ---------------------------------------------------------------- A8: intent wording is rejected

test("F13-A8: intent wording attributed to CIE never renders; the gate rejects it", async () => {
  const bad = checkSummaryLine({ kind: "READING_ORDER", text: "This PR fixes the payments flow (modified)" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.rule, 2);
  const aims = checkSummaryLine({ kind: "READING_ORDER", text: "commit aims to improve throughput (modified)" });
  assert.equal(aims.ok, false);
  // the author's own words may contain intent verbs — inside the labelled quote only
  const quote = checkSummaryLine({ kind: "DESCRIPTION_INTRO", quoted: true, text: `> Author's description (unverified): "this fixes everything"` });
  assert.deepEqual(quote, { ok: true });
  // and no template line the renderer emits carries intent wording
  const s = buildPrSummary(inputOf({ descriptionText: DESCRIPTION, resolveDescription: () => mentionsOf() }));
  const rendered = renderSummarySection(s, {});
  for (const line of rendered.markdown.split("\n")) {
    if (line.startsWith(">")) continue; // the labelled author quote
    assert.doesNotMatch(line, /\b(fixes|fixes|improves|refactors|aims to)\b/i, line);
  }
});

// ---------------------------------------------------------------- A9: INCOMPLETE stated first; order omitted

test("F13-A9: an incomplete analysis states it first and omits the reading order", async () => {
  const s = buildPrSummary(inputOf({ graphComplete: false }));
  assert.equal(s.readingOrder.length, 0);
  assert.equal(s.graphComplete, false);
  const rendered = renderSummarySection(s, { incomplete: true, incompleteReasons: ["analyzer defect-detectors states FAILED"] });
  const lines = rendered.markdown.split("\n").filter((l) => l.length);
  assert.match(lines[1], /^\*\*INCOMPLETE\*\*/); // stated first, right under the marker
  assert.ok(rendered.markdown.includes("Reading order omitted"));
  assert.ok(!rendered.markdown.includes("### Start here"));
});

// ---------------------------------------------------------------- A10: size budget with named cuts

test("F13-A10: a large PR renders under the budget and names what was cut", async () => {
  const entities = [];
  for (let i = 0; i < 100; i++) {
    const pad = "verylongdirectoryname".repeat(4);
    const path = `src/${pad}/module${String(i).padStart(3, "0")}/implementation${i}.ts`;
    for (let j = 0; j < 4; j++) {
      const id = `function:${path}#veryLongHandlerFunctionNameNumber${i}Variant${j}`;
      FILES[id] = path;
      entities.push({ canonId: `c-${i}-${j}`, base: null, head: id, change: "ADDED" as const });
    }
  }
  const cs: ChangeSet = { base: "rev-base", head: "rev-head", entities, textDiff: { filesChanged: 100, symbolsTouched: 400 }, consequences: [], claims: [], blastRadius: [], testImpact: [], gaps: [] };
  const s = buildPrSummary(inputOf({ cs }));
  assert.ok(s.readingOrder.length <= MAX_READING_ORDER_LINES);
  assert.ok(s.budget.omitted >= 100 - MAX_READING_ORDER_LINES);
  const rendered = renderSummarySection(s, {});
  assert.ok(rendered.bytes < SUMMARY_BUDGET_BYTES, `rendered ${rendered.bytes} bytes`);
  assert.ok(rendered.cuts.length > 0, "cuts are named");
  assert.ok(rendered.cuts.some((c) => c.includes("reading order trimmed")));
});

// ---------------------------------------------------------------- A11: docs-only PR

test("F13-A11: a docs-only PR renders the single documentation-only line", async () => {
  const docsCs: ChangeSet = {
    base: "rev-base", head: "rev-head",
    entities: [
      { canonId: "c-d1", base: "function:docs/guide.md#section", head: "function:docs/guide.md#section", change: "MODIFIED" },
      { canonId: "c-d2", base: "function:docs/deep/guide.md#other", head: "function:docs/deep/guide.md#other", change: "MODIFIED" },
    ],
    textDiff: { filesChanged: 2, symbolsTouched: 2 }, consequences: [], claims: [], blastRadius: [], testImpact: [], gaps: [],
  };
  const FILES_DOCS: Record<string, string> = {
    "function:docs/guide.md#section": "docs/guide.md", "function:docs/deep/guide.md#other": "docs/deep/guide.md",
  };
  const s = buildPrSummary(inputOf({ cs: docsCs, entityFile: (id) => FILES_DOCS[id] ?? null }));
  assert.equal(s.docsOnly, true);
  const rendered = renderSummarySection(s, {});
  assert.match(rendered.markdown, /Documentation only/);
  // the counts appear inside the single docs-only line, never as the standalone counts sentence
  assert.ok(!rendered.markdown.split("\n").some((l) => l === countsLine(s.counts)));
});

// ---------------------------------------------------------------- misc: strip, gate discipline, finalize

test("stripDescription removes code fences and quoted replies; finalizeSummaryBudget is stable", async () => {
  assert.equal(stripDescription("text\n```js\ncodeShapedWord\n```\n> quoted reply CodeWord\nrest CodeWord"), "text rest CodeWord");
  const s = buildPrSummary(inputOf({ descriptionText: DESCRIPTION, resolveDescription: () => mentionsOf() }));
  const once = finalizeSummaryBudget(s);
  const twice = finalizeSummaryBudget(once);
  assert.equal(twice.budget.renderedBytes, once.budget.renderedBytes);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test("checkSummaryLine rejects a line with no fact kind and an over-budget line", async () => {
  const noKind = checkSummaryLine({ kind: "" as never, text: "some text" });
  assert.equal(noKind.ok, false);
  if (!noKind.ok) assert.equal(noKind.rule, 1);
  const long = checkSummaryLine({ kind: "GAP", text: "x".repeat(500) });
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.rule, 4);
});

// ---------------------------------------------------------------- service: C23/getPrSummary + preview section

const REPO_ID = "repo-payments";
const REPO_ROOT = "/srv/git/payments";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);

const reportFor = (summary: PrSummary): ImpactReport => {
  const report = buildImpactReport({
    analysisId: "pna:x", baseHash: BASE, headHash: HEAD, cs: csOf(),
    coverage: { source: "REPOSITORY", executableChangedLines: 2, covered: 2, percent: 80, disclosure: "coverage artifact" },
    analyzers: [{ id: "defect-detectors", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 12, skippedFiles: 0, reason: "scope" } }],
    unresolvedDynamicCalls: 0, incomplete: false, incompleteReasons: [], now: "2026-10-07T10:00:00.000Z",
  });
  report.summary = summary;
  return report;
};

const workerPath = (() => { try { return defaultWorkerPath(); } catch { return "/bin/cat"; } })();
const newSvc = () => new Service(new Store(":memory:"), trackedWorker(workerPath), new StubProvider());

function seed(svc: Service, analysisId: string, report: ImpactReport): void {
  report.analysisId = analysisId;
  const now = "2026-10-07T10:00:00.000Z";
  svc.store.db.prepare("insert into pr_analyses values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    analysisId, REPO_ID, "github", 1, REPO_ROOT, BASE, HEAD, BASE, "acme/payments",
    "rev-base", "rev-head", "pol", "polhash", "ash", "DECIDED", null, 1, null, now, now);
  svc.store.db.prepare("insert into impact_reports values (?,?,?,?,?,?)")
    .run(analysisId, JSON.stringify(report), "hash", "CURRENT", now, now);
}

test("C23/getPrSummary returns the stored summary; a report without one is NOT_FOUND", async () => {
  const svc = newSvc();
  const summary = finalizeSummaryBudget(buildPrSummary(inputOf()));
  seed(svc, "pna:one", reportFor(summary));
  const hit = await svc.prOps["C23/getPrSummary"](ctx(), { analysisId: "pna:one" });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.deepEqual(hit.value, summary);
  const miss = await svc.prOps["C23/getPrSummary"](ctx(), { analysisId: "pna:none" });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.error.code, "NOT_FOUND");
});

test("C30/previewImpactComment includes the summary section under its own sub-marker", async () => {
  const svc = newSvc();
  const summary = finalizeSummaryBudget(buildPrSummary(inputOf({ descriptionText: DESCRIPTION, resolveDescription: () => mentionsOf() })));
  seed(svc, "pna:one", reportFor(summary));
  const hit = await svc.prOps["C30/previewImpactComment"](ctx(), { analysisId: "pna:one" });
  assert.equal(hit.ok, true);
  if (hit.ok) {
    const { markdown } = hit.value as { markdown: string };
    assert.ok(markdown.includes(SUMMARY_MARKER));
    assert.ok(markdown.includes("### Start here (suggested reading order)"));
    assert.ok(markdown.includes("The description versus the change"));
  }
});

const testWorkers: WorkerClient[] = [];
function trackedWorker(...args: ConstructorParameters<typeof WorkerClient>) { const worker = new WorkerClient(...args); testWorkers.push(worker); return worker; }
afterEach(() => { for (const worker of testWorkers.splice(0)) worker.close(); });

test("stored PR summaries are withheld after a new path restriction or source revocation", async () => {
 const svc=newSvc();const summary=finalizeSummaryBudget(buildPrSummary(inputOf()));
 assert.ok(summary.readingOrder.length);seed(svc,"pna:restricted",reportFor(summary));
 svc.store.denyPath(REPO_ROOT,summary.readingOrder[0]!.path);
 const restricted=await svc.prOps["C23/getPrSummary"](ctx(),{analysisId:"pna:restricted"});
 assert.equal(restricted.ok,false);assert.ok(!JSON.stringify(restricted).includes(summary.readingOrder[0]!.path));
 svc.store.setRevoked(REPO_ROOT,true);
 const revoked=await svc.prOps["C23/getImpactReport"](ctx(),{analysisId:"pna:restricted"});assert.equal(revoked.ok,false);
});
