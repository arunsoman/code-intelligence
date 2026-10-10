import { afterEach } from "node:test";
/**
 * F15 — the reviewer feedback loop (acceptance F15-A1..A12) plus the watcher integration of the mutating
 * feedback verbs and the service operations C17/recordUsefulness, C29/setMute, C29/clearMute,
 * C17/getFeedbackState, C17/recomputeWeights. The central design point (§1.2) is tested both ways:
 * usefulness labels never touch claim calibration, and verdicts never touch ranking (F15-A2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StubProvider } from "@cie/model";
import type { AnalysisBatch, Entity, EvidenceRef, Fact, ImpactReport, Relationship } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient, defaultWorkerPath } from "../src/worker.ts";
import { buildImpactReport } from "../src/impact-report.ts";
import { renderImpactComment } from "../src/impact-render.ts";
import { DEFAULT_IMPACT_POLICY } from "../src/impact-report.ts";
import {
  FeedbackStore, computeKindWeight, footerLine, checkFeedbackLine, applyFeedback, mutedCountLines,
  redactReason, SAFETY_CLASS_KINDS, MAX_WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX, FEEDBACK_MARKER,
  type MuteRule,
} from "../src/feedback.ts";
import {
  PrChatWatcher, ReplyLedger, runChatCommand, parseChat,
  type ChatTransport, type PrChatEvent, type PrScope,
} from "../src/pr-chat.ts";
import { policyFor } from "../src/access.ts";
import { ctx } from "./helpers.ts";

// ---------------------------------------------------------------- fixture: the F14 payments PR, re-seeded

const REV = "rev-head";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const REPO_ID = "acme/payments";

const COMMIT = "function:src/payments/commit.ts#commit";
const ADJUST = "function:src/payments/ledger.ts#adjustBalance";
const TEST1 = "test:tests/commit.test.ts#rolls back on failure";

const SOURCES: Record<string, string> = {
  "src/payments/commit.ts": "export function begin() {}\nexport function commit() {\n  begin();\n}\n",
  "src/payments/ledger.ts": "export function adjustBalance() {\n  commit();\n}\n",
  "tests/commit.test.ts": "it('rolls back on failure', () => {\n  commit();\n});\n",
};

const ev = (id: string): EvidenceRef => ({
  id, sourceId: "f", location: { kind: "CodeLocation", span: { file: "f.ts", startLine: 1, startCol: 1, endLine: 1, endCol: 2 } as any },
  class: "STATIC_RESOLVED", observedAt: "2026-01-01T00:00:00Z", accessScopeId: "local", state: "CURRENT",
});

function entity(id: string, kind: string, file: string): Entity {
  const name = id.replace(/^.*#/, "");
  const at = SOURCES[file].indexOf(name);
  return {
    entityId: id, kind, name, file,
    spans: at >= 0 ? [{ sourceId: file, contentHash: "x", revision: REV, startByte: at, endByteExclusive: at + name.length }] : [],
  };
}

function seed() {
  const repoRoot = mkdtempSync(join(tmpdir(), "cie-feedback-"));
  for (const [file, text] of Object.entries(SOURCES)) { mkdirSync(join(repoRoot, dirname(file)), { recursive: true }); writeFileSync(join(repoRoot, file), text); }
  const workerPath = (() => { try { return defaultWorkerPath(); } catch { return "/bin/cat"; } })();
  const svc = new Service(new Store(":memory:"), trackedWorker(workerPath), new StubProvider());
  const ents: Entity[] = [entity(COMMIT, "function", "src/payments/commit.ts"), entity(ADJUST, "function", "src/payments/ledger.ts"), entity(TEST1, "test", "tests/commit.test.ts")];
  const rels: Relationship[] = [[ADJUST, COMMIT], [TEST1, COMMIT]].map(([a, b], i) => ({ id: `rel:${i}`, from: a, to: b, kind: "calls", evidence: [ev(`ev:edge:${i}`)], resolution: "RESOLVED" }));
  const facts: Fact[] = [
    { id: "fact:span:commit", subject: COMMIT, predicate: "span", object: { kind: "Value", value: { startByte: 0 } }, evidence: [ev("ev:span:commit")], resolution: "RESOLVED" },
    { id: "fact:span:adjust", subject: ADJUST, predicate: "span", object: { kind: "Value", value: { startByte: 0 } }, evidence: [ev("ev:span:adjust")], resolution: "RESOLVED" },
  ];
  svc.store.putBatch({ revision: REV, gitHead: HEAD, repoRoot, entities: ents, facts, relationships: rels, diagnostics: [], analyzerVersion: "test" } as AnalysisBatch);

  const now = "2026-10-07T10:00:00.000Z";
  svc.store.db.prepare("insert into pr_analyses values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "pna:one", REPO_ID, "github", 7, repoRoot, BASE, HEAD, BASE, "acme/payments",
    "rev-base", REV, "pol", "polhash", "ash", "DECIDED", null, 1, null, now, now);
  const cs = {
    base: "rev-base", head: REV,
    entities: [{ canonId: "c1", base: COMMIT, head: COMMIT, change: "MODIFIED" }],
    textDiff: { filesChanged: 1, symbolsTouched: 1 },
    consequences: [{ id: "csq:1", kind: "ERROR_PATH_ADDED", text: "commit can now throw InsufficientFunds.", evidenceIds: ["ev:edge:0"], claimId: "clm:1", displayMode: "FACT" }],
    claims: [], blastRadius: [], testImpact: [], gaps: [],
  };
  svc.store.db.prepare("insert or replace into pr_change_sets values (?,?,?)").run("pna:one", JSON.stringify(cs), now);
  const report: ImpactReport = buildImpactReport({
    analysisId: "pna:one", baseHash: BASE, headHash: HEAD, cs: cs as never,
    coverage: { source: "REPOSITORY", executableChangedLines: 2, covered: 2, percent: 80, disclosure: "coverage artifact" },
    analyzers: [{ id: "defect-detectors", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 4, skippedFiles: 0, reason: "scope" } }],
    unresolvedDynamicCalls: 0, incomplete: false, incompleteReasons: [], now,
  });
  svc.store.db.prepare("insert into impact_reports values (?,?,?,?,?,?)").run("pna:one", JSON.stringify(report), "rephash", "CURRENT", now, now);
  const scope: PrScope = {
    analysisId: "pna:one", headHash: HEAD, baseHash: BASE, headRevision: REV, repoRoot,
    changedEntityIds: [COMMIT], reportItems: report.surfaced.map((item, i) => ({ n: i + 1, id: item.id })),
  };
  return { svc, repoRoot, scope, report, fb: new FeedbackStore(svc.store) };
}

// label helper: a fresh (item, analysis) per call, so every label stays live (the live-key is
// (principal, kind, analysis) — §7.2.2); pass analysisId explicitly when a test wants a retraction
let n = 0;
const label = (fb: FeedbackStore, principal: string, kind: string, value: "USEFUL" | "NOISE", over: { analysisId?: string; isPrAuthor?: boolean; at?: string; provenance?: "HUMAN" | "SYNTHETIC" } = {}) =>
  fb.recordLabel({
    repositoryId: REPO_ID, itemKind: kind, itemId: `item:${++n}`, analysisId: over.analysisId ?? `pna:lbl:${n}`,
    label: value, principalId: principal, role: "editor", isPrAuthor: over.isPrAuthor ?? false,
    provenance: over.provenance ?? "HUMAN", at: over.at ?? `2026-10-07T10:${String(n % 60).padStart(2, "0")}:00.000Z`,
  });

const K = "ERROR_PATH_ADDED";

// ---------------------------------------------------------------- fake transport + events (watcher tests)

function fakeTransport(visibility: "public" | "private" = "public") {
  const posts: { pr: number; inReplyTo: string; body: string }[] = [];
  const t: ChatTransport = {
    listComments: async () => [],
    postReply: async (pr, inReplyTo, body) => { posts.push({ pr, inReplyTo, body }); return { id: `reply-${posts.length}` }; },
    visibility: async () => visibility,
  };
  return { t, posts };
}

let seq = 0;
const evOf = (body: string, over: Partial<PrChatEvent> = {}): PrChatEvent => ({
  eventId: `e-${++seq}`, repository: REPO_ID, prNumber: 7, commentId: `c-${seq}`, author: "amy",
  authorAssociation: "MEMBER", body, headHash: HEAD, createdAt: "2026-10-07T10:00:00.000Z", untrusted: true, ...over,
});

const watcherFor = (seeded: ReturnType<typeof seed>, t: ChatTransport, withFeedback = true) =>
  new PrChatWatcher({
    ledger: new ReplyLedger(seeded.svc.store),
    scopeFor: () => seeded.scope,
    buildEnv: (scope) => seeded.svc.prChatEnvFor(scope),
    reportHashOf: () => "rephash",
    nowHeadHashOf: () => null,
    deniedPrefixesOf: () => [],
    evidenceOf: (revision, id) => seeded.svc.store.evidence(revision, id),
    transport: t,
    feedbackFor: withFeedback ? (ev, scope) => seeded.svc.chatFeedbackFor(ev, scope) : undefined,
  });

// ---------------------------------------------------------------- F15-A1: replay gives identical weights

test("F15-A1: replaying the label log on a fresh store gives identical weights and computedFromLogHash", async () => {
  const a = seed();
  label(a.fb, "amy", K, "USEFUL"); label(a.fb, "amy", K, "USEFUL"); label(a.fb, "amy", K, "NOISE");
  label(a.fb, "bob", K, "USEFUL"); label(a.fb, "bob", K, "USEFUL"); label(a.fb, "bob", K, "USEFUL");
  label(a.fb, "cy", K, "NOISE"); label(a.fb, "cy", K, "USEFUL");
  label(a.fb, "amy", K, "USEFUL", { analysisId: "pna:two" }); label(a.fb, "bob", K, "NOISE", { analysisId: "pna:two" });
  label(a.fb, "cy", K, "USEFUL", { analysisId: "pna:two" }); label(a.fb, "amy", K, "NOISE", { analysisId: "pna:three" });
  label(a.fb, "bob", K, "USEFUL", { analysisId: "pna:three" });
  const first = a.fb.recomputeWeights(REPO_ID);
  assert.equal(first.weights.find((w) => w.kind === K)?.status, "uncalibrated-adjusted");

  const b = seed();
  for (const row of a.fb.labels(REPO_ID).rows) {
    const r = b.fb.recordLabel({ repositoryId: REPO_ID, itemKind: row.itemKind, itemId: row.itemId, analysisId: row.analysisId, label: row.label, principalId: row.principalId, role: row.role, source: row.source, isPrAuthor: row.isPrAuthor, provenance: row.provenance, at: row.at });
    assert.equal(r.ok, true);
  }
  const second = b.fb.recomputeWeights(REPO_ID);
  assert.equal(second.logHash, first.logHash);
  assert.deepEqual(
    second.weights.map(({ computedAt, ...w }) => w),
    first.weights.map(({ computedAt, ...w }) => w));
});

// ---------------------------------------------------------------- F15-A2: separation, both directions

test("F15-A2: usefulness labels do not move verdictCounts; a verdict does not move ranking", async () => {
  const s = seed();
  const before = s.svc.store.verdictCounts("FACT");
  for (let i = 0; i < 12; i++) label(s.fb, i % 2 ? "amy" : "bob", K, i % 3 ? "USEFUL" : "NOISE");
  assert.deepEqual(s.svc.store.verdictCounts("FACT"), before); // labels never call addVerdict (§7.1)
  const w1 = s.fb.recomputeWeights(REPO_ID).weights.find((w) => w.kind === K);
  // now a verdict through the claim path (as /cie wrong 1 does)
  const hooks = s.svc.chatFeedbackFor(evOf("/cie wrong 1", {}), s.scope)!;
  const v = await hooks.recordVerdict(1, "REFUTE", "amy");
  assert.equal(v.ok, true);
  assert.deepEqual(s.svc.store.verdictCounts("FACT"), { confirmed: 0, refuted: before.refuted + 1 });
  const w2 = s.fb.recomputeWeights(REPO_ID).weights.find((w) => w.kind === K);
  const strip = ({ computedAt, ...w }: NonNullable<typeof w1>) => w;
  assert.deepEqual(strip(w2!), strip(w1!)); // verdicts never touch the label log: ranking is unchanged
});

// ---------------------------------------------------------------- F15-A3: one principal, or the author alone, cannot move a weight

test("F15-A3: one principal's labels cannot move a weight; PR-author labels do not count toward P", async () => {
  const s = seed();
  for (let i = 0; i < 12; i++) label(s.fb, "amy", K, "NOISE"); // 12 live labels, one principal
  let w = s.fb.recomputeWeights(REPO_ID).weights.find((x) => x.kind === K)!;
  assert.deepEqual({ weight: w.weight, status: w.status }, { weight: 1.0, status: "default" });
  // the PR author's labels are recorded and shown separately, but do not count toward the minimum
  for (let i = 0; i < 8; i++) label(s.fb, "author", K, "USEFUL", { isPrAuthor: true });
  for (let i = 0; i < 4; i++) label(s.fb, "amy", K, "USEFUL");
  w = s.fb.recomputeWeights(REPO_ID).weights.find((x) => x.kind === K)!;
  assert.equal(w.status, "default");
  assert.equal(w.labels.principals, 1);
  assert.ok(w.labels.useful >= 12); // author labels count in the totals, just not toward P
  const st = s.fb.state(REPO_ID);
  assert.equal(st.labels.total, 24);
});

// ---------------------------------------------------------------- F15-A4: bots excluded

test("F15-A4: bot-account labels are excluded", async () => {
  const s = seed();
  for (const bot of ["dependabot[bot]", "github-actions", "cie[bot]"]) {
    const r = label(s.fb, bot, K, "NOISE");
    assert.equal(r.ok, false);
  }
  for (let i = 0; i < 12; i++) label(s.fb, "amy", K, "USEFUL");
  assert.equal(s.fb.state(REPO_ID).labels.total, 12); // nothing from bots is in the log
});

// ---------------------------------------------------------------- F15-A5: muted items are counted, never deleted

test("F15-A5: a muted item is counted in muted, suppressed is untouched, why-not still explains it", async () => {
  const s = seed();
  const subject = s.report.surfaced[0];
  const mute: MuteRule = { id: "m:1", repositoryId: REPO_ID, kind: K, scope: { type: "REPOSITORY" }, createdBy: "amy", createdAt: "2026-10-07T10:00:00.000Z", expiresAt: "2027-01-05T10:00:00.000Z" };
  const out = applyFeedback(s.report, { mutes: [mute], weights: [], labelSummary: { total: 0, principals: 0 }, logHash: "lh" });
  assert.equal(out.surfaced.length, s.report.surfaced.length - 1);
  assert.equal(out.muted?.length, 1);
  assert.equal(out.muted![0].id, subject.id);
  assert.ok(out.muted![0].rank.factors.some((f) => f.name === "MUTE"));
  assert.deepEqual(out.suppressed, s.report.suppressed); // never deleted from suppressed
  assert.ok(out.feedback?.line.includes("1 kind muted"));
  // why-not explains the suppression instead of claiming absence
  const env: import("../src/pr-chat.ts").ChatEnv = { store: s.svc.store, scope: s.scope, access: policyFor(s.svc.store, s.repoRoot), cs: null, report: out, modelAvailable: false };
  const hit = runChatCommand(env, { verb: "why-not", args: "commit" });
  assert.match(hit.claims[0].text, /muted for this repository by reviewer feedback/);
  // silence is never confused with absence: the muted count names what is hidden
  assert.deepEqual(mutedCountLines(out.muted!), ["1 muted item (1 kind)"]);
});

// ---------------------------------------------------------------- F15-A6: the safety floor

test("F15-A6: an editor cannot mute a safety-class kind at path/symbol scope; an owner can; repo scope needs owner", async () => {
  const s = seed();
  assert.ok(SAFETY_CLASS_KINDS.includes("TRANSACTION_BYPASS"));
  const denied = s.fb.setMute({ repositoryId: REPO_ID, kind: "TRANSACTION_BYPASS", scope: { type: "PATH_PREFIX", value: "src/payments" }, createdBy: "amy", role: "editor" });
  assert.equal(denied.ok, false); // §7.5 floor
  const byOwner = s.fb.setMute({ repositoryId: REPO_ID, kind: "TRANSACTION_BYPASS", scope: { type: "PATH_PREFIX", value: "src/payments" }, createdBy: "ops", role: "owner" });
  assert.equal(byOwner.ok, true);
  const repoScopeEditor = s.fb.setMute({ repositoryId: REPO_ID, kind: "MODULE_COUPLING", createdBy: "amy", role: "editor" });
  assert.equal(repoScopeEditor.ok, false); // repository-wide needs owner (§7.4)
  const repoScopeOwner = s.fb.setMute({ repositoryId: REPO_ID, kind: "MODULE_COUPLING", createdBy: "ops", role: "owner" });
  assert.equal(repoScopeOwner.ok, true);
  assert.equal(repoScopeOwner.mute.expiresAt !== undefined, true); // default 90-day expiry (§7.4)
  const safetyCount = mutedCountLines([{ ...s.report.surfaced[0], kindDetail: "TRANSACTION_BYPASS" }]);
  assert.match(safetyCount[0], /1 muted item of kind TRANSACTION_BYPASS \(safety class — counted, never hidden\)/);
});

// ---------------------------------------------------------------- F15-A7: bounded steps and clamp

test("F15-A7: a recompute moves a weight by at most 0.25, clamped to [0.5, 1.5]", async () => {
  const s = seed();
  const weight = () => s.fb.weights(REPO_ID).find((w) => w.kind === K)!;
  const round = () => s.fb.recomputeWeights(REPO_ID).weights.find((w) => w.kind === K)!;
  const stepOk = (from: number, to: number) => Math.abs(to - from) <= MAX_WEIGHT_STEP + 1e-9;

  // round 1: one label — below the minimums, stays at default 1.0, and the row exists
  label(s.fb, "amy", K, "USEFUL");
  const w0 = round();
  assert.equal(w0.weight, 1.0);
  // round 2: twelve NOISE labels from three principals — one bounded step downward only
  for (let i = 0; i < 12; i++) label(s.fb, ["amy", "bob", "cy"][i % 3], K, "NOISE");
  const w1 = round();
  assert.ok(stepOk(w0.weight, w1.weight));
  assert.ok(w1.weight < w1.weight + 1 && w1.weight >= WEIGHT_MIN && w1.weight <= WEIGHT_MAX);
  assert.ok(w1.weight < w0.weight); // moving toward the noise-driven target
  assert.ok(w1.weight >= computeKindWeight({ useful: w1.labels.useful, noise: w1.labels.noise, principals: w1.labels.principals }).weight - 1e-9);
  // repeated recomputes converge to the pure function's answer, every step bounded
  let prev = w1;
  for (let i = 0; i < 10 && Math.abs(weight().weight - computeKindWeight({ useful: prev.labels.useful, noise: prev.labels.noise, principals: prev.labels.principals }).weight) > 1e-9; i++) {
    const cur = round();
    assert.ok(stepOk(prev.weight, cur.weight), `step ${prev.weight} → ${cur.weight}`);
    assert.ok(cur.weight >= WEIGHT_MIN && cur.weight <= WEIGHT_MAX);
    prev = cur;
  }
  const downTarget = computeKindWeight({ useful: prev.labels.useful, noise: prev.labels.noise, principals: prev.labels.principals });
  assert.ok(Math.abs(prev.weight - downTarget.weight) <= 1e-9);
  // and upward: twelve USEFUL labels climb by bounded steps to the new target
  for (let i = 0; i < 12; i++) label(s.fb, ["amy", "bob", "cy"][i % 3], K, "USEFUL");
  for (let i = 0; i < 10; i++) {
    const cur = round();
    assert.ok(stepOk(prev.weight, cur.weight));
    assert.ok(cur.weight >= WEIGHT_MIN && cur.weight <= WEIGHT_MAX);
    prev = cur;
    const t = computeKindWeight({ useful: cur.labels.useful, noise: cur.labels.noise, principals: cur.labels.principals });
    if (Math.abs(cur.weight - t.weight) <= 1e-9) break;
  }
  const upTarget = computeKindWeight({ useful: prev.labels.useful, noise: prev.labels.noise, principals: prev.labels.principals });
  assert.ok(Math.abs(prev.weight - upTarget.weight) <= 1e-9);
  assert.ok(prev.weight > w1.weight); // useful labels pulled the weight back up
});


// ---------------------------------------------------------------- F15-A8: expiry and revoke

test("F15-A8: mute expiry and revoke work; expired mutes are reported", async () => {
  const s = seed();
  const at = "2026-10-07T10:00:00.000Z";
  const short = s.fb.setMute({ repositoryId: REPO_ID, kind: "MODULE_COUPLING", createdBy: "ops", role: "owner", expiresAt: "2026-10-08T10:00:00.000Z", at });
  assert.equal(short.ok, true);
  assert.equal(s.fb.mutes(REPO_ID, at).active.length, 1);
  const later = "2026-10-09T10:00:00.000Z";
  const view = s.fb.mutes(REPO_ID, later);
  assert.equal(view.active.length, 0);
  assert.equal(view.expired.length, 1); // expired mutes are reported, not silently dropped
  const state = s.fb.state(REPO_ID, later);
  assert.equal(state.mutes.expired, 1);
  // an expired mute no longer applies
  const out = applyFeedback(s.report, { mutes: view.active, weights: [], labelSummary: { total: 0, principals: 0 }, logHash: "lh" });
  assert.equal(out.muted?.length ?? 0, 0);
  // revoke
  const long = s.fb.setMute({ repositoryId: REPO_ID, kind: "NEW_CYCLE", createdBy: "ops", role: "owner", at });
  const cleared = s.fb.clearMute(REPO_ID, "NEW_CYCLE", "amy", "editor", later);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.mute.revokedBy, "amy");
  assert.equal(s.fb.mutes(REPO_ID, later).active.length, 0);
  assert.equal(s.fb.state(REPO_ID).mutes.revoked, 1);
  // a viewer cannot unmute
  const denied = s.fb.clearMute(REPO_ID, "MODULE_COUPLING", "rando", "viewer", later);
  assert.equal(denied.ok, false);
});

// ---------------------------------------------------------------- F15-A9: the footer, exactly as stored

test("F15-A9: the footer states ranking status and muted counts exactly as stored; a mutated footer is rejected", async () => {
  const s = seed();
  const state = s.fb.state(REPO_ID);
  assert.equal(footerLine(state), "Ranking: default — no feedback yet");
  const good = checkFeedbackLine(footerLine(state), state);
  assert.deepEqual(good, { ok: true });
  for (const mutated of [footerLine(state).replace("default", "adjusted"), footerLine(state) + " · secretly trained", footerLine(state).replace("yet", "yet!")]) {
    assert.equal(checkFeedbackLine(mutated, state).ok, false); // a mutated footer is rejected
  }
  for (let i = 0; i < 3; i++) label(s.fb, "amy", K, "USEFUL");
  const muted = s.fb.setMute({ repositoryId: REPO_ID, kind: "MODULE_COUPLING", createdBy: "ops", role: "owner" });
  assert.equal(muted.ok, true);
  const withFb = s.fb.state(REPO_ID);
  assert.equal(footerLine(withFb), "Ranking adjusted from 3 labels by 1 reviewer (uncalibrated) · 1 kind muted · log");
  // the line rides inside the impact comment under its own marker
  const out = applyFeedback(s.report, { mutes: withFb.mutes.active, weights: [], labelSummary: { total: withFb.labels.total, principals: withFb.labels.principals }, logHash: s.fb.logHash(REPO_ID) });
  const rendered = renderImpactComment({ report: out, analysisState: "DECIDED", policy: { ...DEFAULT_IMPACT_POLICY, alwaysComment: true }, deniedPrefixes: [], resolveEvidence: () => true });
  assert.match(rendered.markdown, new RegExp(escapeRe(FEEDBACK_MARKER)));
  assert.ok(rendered.markdown.includes(footerLine(withFb)));
  const line = rendered.markdown.split("\n").find((l) => l.startsWith("Ranking"))!;
  assert.deepEqual(checkFeedbackLine(line, withFb), { ok: true });
});
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- F15-A10: reactions never move per-kind weights

test("F15-A10: comment-level reactions never change per-kind weights", async () => {
  const s = seed();
  for (let i = 0; i < 6; i++) {
    const r = s.fb.recordReaction(REPO_ID, "pna:one", "comment:1", i % 2 ? "USEFUL" : "NOISE", `reviewer${i}`);
    assert.equal(r.ok, true);
  }
  const weights = s.fb.recomputeWeights(REPO_ID).weights;
  assert.equal(weights.length, 0); // COMMENT labels have no kind row at all
  const st = s.fb.state(REPO_ID);
  assert.equal(st.reactions.up, 3);
  assert.equal(st.reactions.down, 3);
  assert.equal(st.labels.total, 0); // reactions are not item labels either
  // twelve item labels still do what they always did — reactions did not pollute them
  for (let i = 0; i < 12; i++) label(s.fb, ["amy", "bob"][i % 2], K, "NOISE");
  const w = s.fb.recomputeWeights(REPO_ID).weights.find((x) => x.kind === K)!;
  assert.equal(w.status, "uncalibrated-adjusted");
  assert.equal(w.labels.noise, 12);
});

// ---------------------------------------------------------------- F15-A11: free text is redacted to a reason

test("F15-A11: free text in a command is stored only as a redacted, length-limited mute reason", async () => {
  const hostile = "line one\nline two @alice #123 " + "x".repeat(300);
  const r = redactReason(hostile);
  assert.ok(!r.includes("\n"));
  assert.ok(!r.includes("@"));
  assert.ok(!r.includes("#123"));
  assert.ok(r.length <= 120);
  const s = seed();
  const m = s.fb.setMute({ repositoryId: REPO_ID, kind: "MODULE_COUPLING", createdBy: "ops", role: "owner", reason: hostile });
  assert.equal(m.ok, true);
  const stored = s.fb.mutes(REPO_ID).active.find((x) => x.kind === "MODULE_COUPLING")!;
  assert.equal(stored.reason, r); // only the redacted reason is stored (§10.3)
  assert.ok(!JSON.stringify(s.fb.labels(REPO_ID).rows).includes(hostile.slice(0, 40)));
});

// ---------------------------------------------------------------- F15-A12: reset

test("F15-A12: reset returns weights to default and leaves the log intact", async () => {
  const s = seed();
  for (let i = 0; i < 12; i++) label(s.fb, ["amy", "bob"][i % 2], K, "NOISE");
  const before = s.fb.recomputeWeights(REPO_ID).weights.find((w) => w.kind === K)!;
  assert.equal(before.status, "uncalibrated-adjusted");
  s.fb.resetRanking(REPO_ID, "ops");
  assert.equal(s.fb.weights(REPO_ID).length, 0); // weights return to default (§7.7)
  assert.equal(s.fb.state(REPO_ID).resets, 1);
  assert.equal(s.fb.labels(REPO_ID).rows.length, 12); // the label log is intact
  const again = s.fb.recomputeWeights(REPO_ID).weights.find((w) => w.kind === K)!;
  assert.deepEqual({ weight: again.weight, status: again.status }, { weight: before.weight, status: before.status }); // deterministic rebuild
});

// ---------------------------------------------------------------- watcher: feedback verbs end to end

test("a viewer's /cie noise records a label; the confirmation names the log, not the author", async () => {
  const s = seed();
  const { t, posts } = fakeTransport();
  const w = watcherFor(s, t);
  const r = await w.handleEvent(evOf("/cie noise 1", { commentId: "c-noise", authorAssociation: "CONTRIBUTOR" }));
  assert.equal(r.outcome, "POSTED");
  assert.match(posts[0].body, /recorded NOISE on item 1 \(ERROR_PATH_ADDED\)/);
  assert.equal(s.fb.labels(REPO_ID).rows.length, 1);
  assert.equal(s.fb.labels(REPO_ID).rows[0].principalId, "amy"); // attributed, reversible (§1.4)
});

test("/cie mute needs the owner role at repository scope; an owner mute expires in 90 days", async () => {
  const s = seed();
  const a = fakeTransport();
  const wa = watcherFor(s, a.t);
  const denied = await wa.handleEvent(evOf("/cie mute MODULE_COUPLING", { commentId: "c-m1" })); // MEMBER → editor
  assert.equal(denied.outcome, "POSTED");
  assert.equal(denied.kind, "REFUSED");
  assert.match(a.posts[0].body, /needs the owner role/);
  const b = fakeTransport();
  const wb = watcherFor(s, b.t);
  const ok = await wb.handleEvent(evOf("/cie mute MODULE_COUPLING too chatty", { commentId: "c-m2", authorAssociation: "OWNER" }));
  assert.equal(ok.outcome, "POSTED");
  assert.match(b.posts[0].body, /MODULE_COUPLING muted repository-wide/);
  const mute = s.fb.mutes(REPO_ID).active.find((m) => m.kind === "MODULE_COUPLING")!;
  assert.equal((Date.parse(mute.expiresAt!) - Date.parse(mute.createdAt)) / 86_400_000, 90);
  assert.equal(mute.reason, "too chatty"); // redacted reason only (§10.3)
});

test("/cie mutes lists names only in a private repository (D3)", async () => {
  const s = seed();
  s.fb.setMute({ repositoryId: REPO_ID, kind: "MODULE_COUPLING", createdBy: "amy", role: "owner" });
  const pub = fakeTransport("public");
  await watcherFor(s, pub.t).handleEvent(evOf("/cie mutes", { commentId: "c-li-p" }));
  assert.match(pub.posts[0].body, /MODULE_COUPLING muted/);
  assert.ok(!pub.posts[0].body.includes(" by amy")); // counts and kinds only, no names in public
  const priv = fakeTransport("private");
  await watcherFor(s, priv.t).handleEvent(evOf("/cie mutes", { commentId: "c-li-q" }));
  assert.match(priv.posts[0].body, /MODULE_COUPLING muted \(repository-wide by amy/);
});

test("/cie wrong writes a REFUTE verdict through the claim ledger — ranking stays out of it", async () => {
  const s = seed();
  const { t, posts } = fakeTransport();
  const w = watcherFor(s, t);
  const before = s.svc.store.verdictCounts("FACT");
  const r = await w.handleEvent(evOf("/cie wrong 1", { commentId: "c-wrong" }));
  assert.equal(r.outcome, "POSTED");
  assert.match(posts[0].body, /refute verdict on the claim behind item 1/);
  assert.match(posts[0].body, /not the ranking/);
  assert.deepEqual(s.svc.store.verdictCounts("FACT"), { confirmed: before.confirmed, refuted: before.refuted + 1 });
  assert.equal(s.fb.labels(REPO_ID).rows.length, 0); // the claim ledger received nothing about usefulness
});

test("/cie reset-ranking: an editor is refused, an owner resets — and the log stays", async () => {
  const s = seed();
  for (let i = 0; i < 4; i++) label(s.fb, "amy", K, "USEFUL");
  const a = fakeTransport();
  const refused = await watcherFor(s, a.t).handleEvent(evOf("/cie reset-ranking", { commentId: "c-r1" })); // MEMBER → editor
  assert.equal(refused.kind, "REFUSED");
  assert.match(a.posts[0].body, /needs the owner role/);
  const b = fakeTransport();
  const ok = await watcherFor(s, b.t).handleEvent(evOf("/cie reset-ranking", { commentId: "c-r2", authorAssociation: "OWNER" }));
  assert.equal(ok.outcome, "POSTED");
  assert.match(b.posts[0].body, /ranking reset to default/);
  assert.equal(s.fb.labels(REPO_ID).rows.length, 4);
});

test("feedback commands with no hooks get exactly one explanation, then silence", async () => {
  const s = seed();
  const { t, posts } = fakeTransport();
  const w = watcherFor(s, t, false);
  const first = await w.handleEvent(evOf("/cie noise 1", { commentId: "c-fb1" }));
  assert.equal(first.outcome, "POSTED");
  assert.equal(first.kind, "REFUSED");
  assert.match(posts[0].body, /not enabled/);
  const second = await w.handleEvent(evOf("/cie noise 1", { commentId: "c-fb2" }));
  assert.equal(second.outcome, "SKIPPED");
  assert.equal(posts.length, 1);
});

test("/cie impact is still write-gated for a viewer, but /cie useful is not", async () => {
  const s = seed();
  const { t, posts } = fakeTransport();
  const w = watcherFor(s, t);
  const read = await w.handleEvent(evOf("/cie impact commit", { commentId: "c-gate", authorAssociation: "CONTRIBUTOR" }));
  assert.equal(read.kind, "REFUSED"); // F14 §10.1 unchanged: commands need write access
  const labelCmd = await w.handleEvent(evOf("/cie useful 1", { commentId: "c-gate2", authorAssociation: "CONTRIBUTOR" }));
  assert.equal(labelCmd.outcome, "POSTED");
  assert.equal(s.fb.labels(REPO_ID).rows.length, 1);
  assert.ok(posts[1].body.includes("recorded USEFUL"));
});

// ---------------------------------------------------------------- the service operations (§8)

test("the F15 operations: recordUsefulness, setMute, getFeedbackState, recomputeWeights", async () => {
  const s = seed();
  const c = ctx();
  const recorded = await s.svc.prOps["C17/recordUsefulness"](c, { repositoryId: REPO_ID, itemKind: K, itemId: "item:x", analysisId: "pna:one", label: "USEFUL" });
  assert.equal(recorded.ok, true);
  for (let i = 0; i < 11; i++) {
    const r = await s.svc.prOps["C17/recordUsefulness"](c, { repositoryId: REPO_ID, itemKind: K, itemId: `item:${i}`, analysisId: `pna:extra:${i}`, label: "NOISE" });
    assert.equal(r.ok, true);
  }
  const muted = await s.svc.prOps["C29/setMute"](c, { repositoryId: REPO_ID, kind: "module_coupling" }); // normalised upper-case
  assert.equal(muted.ok, true);
  if (muted.ok) assert.equal((muted.value as { kind: string }).kind, "MODULE_COUPLING");
  const state = await s.svc.prOps["C17/getFeedbackState"](c, { repositoryId: REPO_ID });
  assert.equal(state.ok, true);
  if (state.ok) {
    assert.equal((state.value as { labels: { total: number } }).labels.total, 12);
    assert.equal((state.value as { mutes: { active: unknown[] } }).mutes.active.length, 1);
  }
  const recomputed = await s.svc.prOps["C17/recomputeWeights"](c, { repositoryId: REPO_ID });
  assert.equal(recomputed.ok, true);
  if (recomputed.ok) assert.equal((recomputed.value as { weights: { kind: string }[] }).weights.some((w) => w.kind === K), true);
  const cleared = await s.svc.prOps["C29/clearMute"](c, { repositoryId: REPO_ID, id: "MODULE_COUPLING" });
  assert.equal(cleared.ok, true);
  // the read-only shaping op refuses the mutating feedback verbs
  const viaOp = await s.svc.prOps["C15/runPrCommand"](c, { analysisId: "pna:one", text: "/cie noise 1" });
  assert.equal(viaOp.ok, false);
});

test("parseChat accepts the F15 verbs and still rejects quoting", async () => {
  for (const body of ["/cie noise 2", "/cie mute MODULE_COUPLING", "/cie mutes", "/cie reset-ranking", "/cie wrong 3"]) {
    const p = parseChat(body);
    assert.equal(p.type, "command");
    if (p.type === "command") assert.notEqual(p.verb, "help");
  }
  assert.equal(parseChat("> /cie mute MODULE_COUPLING").type, "ignore");
});

const testWorkers: WorkerClient[] = [];
function trackedWorker(...args: ConstructorParameters<typeof WorkerClient>) { const worker = new WorkerClient(...args); testWorkers.push(worker); return worker; }
afterEach(() => { for (const worker of testWorkers.splice(0)) worker.close(); });
