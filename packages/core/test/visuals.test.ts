import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Claim, ViewSpec } from "@cie/schema";
import { provenanceAudit } from "../src/demobar.ts";
import { VISUALS } from "../src/visuals.ts";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

const claimsOf = (cs: Claim[]) => Object.fromEntries(cs.map((c) => [c.draft.id, c]));
const names = (v: ViewSpec, role?: string) => v.nodes.filter((n) => !role || n.role === role).map((n) => n.label);

async function ask(svc: any, revision: string, question: string, extra: object = {}) {
  const r = await svc.ask(ctx(), { question, revision, ...extra });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.value as { view: ViewSpec; claims: Claim[] };
}
/** Every form obeys the same contract: every element cites evidence that exists, nothing inferred is shown as fact. */
function audited(svc: any, v: ViewSpec, claims: Claim[]) {
  const bad = provenanceAudit(svc, v, claimsOf(claims));
  assert.deepEqual(bad, [], `${v.formId}: ${bad.join("; ")}`);
  assert.ok(v.nodes.length > 0 && v.caption && v.formReason);
}

test("all seventeen forms are in the catalogue, each with a builder or a built-in route", () => {
  assert.equal(new Set(VISUALS.map((v) => v.code)).size, 17);
});

test("V4 transaction journey: lanes by module, steps in call order, failure exits, async hand-offs as hypotheses", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Walk me through createPayment step by step");
  assert.equal(v.formId, "TransactionJourney");
  const steps = v.nodes.filter((n) => n.role === "operation" || n.role === "step");
  assert.equal(steps[0].label, "createPayment");
  const order = steps.map((n) => n.label);
  assert.ok(order.indexOf("claimKey") < order.indexOf("checkFraud") && order.indexOf("checkFraud") < order.indexOf("reserve"), `call order: ${order}`);
  assert.ok(steps.every((n, i) => i === 0 || n.pos!.x > steps[i - 1].pos!.x), "x increases with execution order");
  assert.ok(v.groups.filter((g) => g.kind === "lane").length >= 3, "api, payments and ledger lanes");
  const fraud = v.nodes.find((n) => n.label === "fails: FraudRejectedError")!;
  assert.ok(fraud && fraud.role === "decision" && fraud.evidenceIds.length > 0);
  const cap = v.nodes.find((n) => n.label === "handleCapture")!;
  assert.equal(cap.displayMode, "HYPOTHESIS", "behind an async hand-off");
  assert.ok(cap.ownClaimId && claims.find((c) => c.draft.id === cap.ownClaimId)!.counterArgument.length > 0);
  assert.ok(v.edges.some((e) => e.kind === "async-flow" && e.label?.includes("payment.capture.requested")));
  audited(svc, v, claims);
  worker.close();
});

test("V5 data lineage: writers and readers of one field, transaction region, order-of-application risks", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Who reads and writes balance?");
  assert.equal(v.formId, "DataLineage");
  assert.deepEqual(names(v, "writer").sort(), ["adjustBalance", "commit", "reconcileBalances"]);
  assert.ok(names(v, "reader").includes("reserve"), "reserve reads account.balance");
  assert.ok(v.nodes.some((n) => n.role === "state" && n.label === "account.balance" && n.pos!.x === 0));
  assert.ok(v.nodes.filter((n) => n.role === "writer").every((n) => n.pos!.x < 0) && v.nodes.filter((n) => n.role === "reader").every((n) => n.pos!.x > 0));
  assert.ok(v.groups.some((g) => g.kind === "region" && g.label === "inside a transaction" && g.childNodeIds.includes("n:function:src/ledger/ledger.ts#commit")));
  const hazards = v.nodes.filter((n) => n.role === "hazard");
  assert.ok(hazards.length >= 1 && hazards.every((n) => n.displayMode === "HYPOTHESIS" && n.evidenceIds.length >= 2));
  assert.ok(claims.find((c) => c.draft.id === hazards[0].ownClaimId)!.counterArgument.length > 0);
  audited(svc, v, claims);
  worker.close();
});

test("V6 semantic diff: before and after side by side, with the consequences of what changed", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const only = await ask(svc, revision, "what changed since the last index");
  assert.match(only.view.caption, /Only one revision/, "with one revision it says so instead of inventing a diff");
  const f = join(repo, "src/ledger/ledger.ts");
  let src = readFileSync(f, "utf8");
  const a = src.indexOf("export async function commit"), b = src.indexOf("// Used by background jobs");
  src = src.slice(0, a) + `export async function commit(id: string, amount: number) {\n  const account = getAccount(id);\n  account.balance -= amount;\n  account.held -= amount;\n  await db.update("accounts", { balance: account.balance, held: account.held });\n}\n\n` + src.slice(b);
  src += `\nexport class LedgerLockedError extends Error {}\nexport function freeze(id: string) { if (!id) throw new LedgerLockedError(id); }\n`;
  writeFileSync(f, src);
  execFileSync("git", ["-C", repo, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", "Drop the transaction from commit; add freeze"]);
  const r2 = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(r2.ok);
  const { view: v, claims } = await ask(svc, r2.value.id, "what changed since the last index");
  assert.equal(v.formId, "SemanticDiff");
  assert.ok(v.nodes.some((n) => n.id === "b:function:src/ledger/ledger.ts#commit" && n.role === "before-changed"));
  assert.ok(v.nodes.some((n) => n.id === "a:function:src/ledger/ledger.ts#commit" && n.role === "after-changed"));
  assert.ok(v.nodes.some((n) => n.id === "b:function:src/ledger/ledger.ts#freeze" && n.ghost), "added code did not exist before");
  const text = (v.consequences ?? []).map((c) => c.text).join("\n");
  assert.match(text, /commit is no longer inside a transaction/);
  assert.match(text, /freeze can now fail with LedgerLockedError/);
  assert.ok((v.consequences ?? []).every((c) => c.evidenceIds.length > 0 && c.claimId));
  assert.ok(v.nodes.some((n) => n.role === "commit" && n.label.startsWith("Drop the transaction")), "history strip names the commit");
  audited(svc, v, claims);
  worker.close();
});

test("V7 archaeology: commits that shaped this code beside the constraints that still bind it", async () => {
  const repo = demoRepo();
  const f = join(repo, "src/ledger/ledger.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace("account.balance += delta;", "account.balance += delta; // no await: latency budget"));
  execFileSync("git", ["-C", repo, "-c", "user.name=Lee", "-c", "user.email=l@x", "commit", "-qam", "Make adjustBalance non-transactional for refund latency"]);
  const { svc, worker, revision } = await setup(undefined, repo);
  const { view: v, claims } = await ask(svc, revision, "Why is adjustBalance not transactional?");
  assert.equal(v.formId, "Archaeology");
  const events = v.nodes.filter((n) => n.role === "event");
  assert.ok(events.length >= 2 && events[events.length - 1].label.startsWith("Make adjustBalance"), "oldest first, newest last");
  assert.ok(events.every((e, i) => i === 0 || e.pos!.y > events[i - 1].pos!.y));
  const cons = v.nodes.filter((n) => n.role === "constraint");
  assert.ok(cons.some((c) => /deliberately not transactional/.test(c.label)) && cons.every((c) => c.evidenceIds.length > 0));
  const ev = svc.resolveEvidence(svc.store.revision(revision)!, svc.store.evidence(revision, cons[0].evidenceIds[0])!);
  assert.match(ev.snippet, /deliberately not transactional|latency budget/, "the constraint's evidence is the exact comment");
  const link = v.edges.find((e) => e.kind === "likely introduced");
  assert.ok(link && link.displayMode === "HYPOTHESIS" && link.claimId, "which commit introduced it is only a claim");
  assert.ok(v.gaps.some((g) => /no model narration/.test(g)));
  audited(svc, v, claims);
  worker.close();
});

test("V8 trust boundary: entries, gates, protected state, and unprotected paths as hypotheses with counter-arguments", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Who can reach adjustBalance and what stops them?");
  assert.equal(v.formId, "TrustBoundary");
  assert.ok(names(v, "entry").includes("openDispute"), names(v).join());
  assert.ok(names(v, "sink").includes("adjustBalance"));
  assert.ok(v.groups.some((g) => g.label.startsWith("outside")) && v.groups.some((g) => g.label.startsWith("protected state")));
  const open = v.nodes.filter((n) => n.role === "unprotected");
  assert.ok(open.length >= 1 && open.every((n) => n.displayMode === "HYPOTHESIS"));
  assert.match(claims.find((c) => c.draft.id === open[0].ownClaimId)!.counterArgument, /asynchronous boundary|caveat/);
  const all = await ask(svc, revision, "Show the trust boundaries");
  assert.ok(names(all.view, "gate").includes("checkFraud") && all.view.nodes.filter((n) => n.role === "gate").every((n) => n.displayMode !== "FACT" && n.ownClaimId), "gates are inferences, never facts");
  audited(svc, v, claims); audited(svc, all.view, all.claims);
  worker.close();
});

test("V15 policy map: rules enforced in code, escape routes around them, rules held only by convention", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Which policies are enforced and where do they have gaps?");
  assert.equal(v.formId, "PolicyMap");
  const policies = v.nodes.filter((n) => n.role === "policy" && !n.ghost).map((n) => n.label);
  for (const p of ["FraudRejected", "DuplicateRequest", "InsufficientFunds"]) assert.ok(policies.includes(p), `${p} in ${policies}`);
  const esc = (v.consequences ?? []).filter((c) => c.kind === "escape route");
  assert.ok(esc.some((c) => /adjustBalance|reconcileBalances/.test(c.text)), "the refund path and the job change balance without the fraud and funds checks");
  assert.equal(new Set(esc.map((c) => c.text)).size, esc.length, "each way around is listed once, naming every check it skips");
  assert.ok(esc.some((c) => /without .*,.*—/.test(c.text)), "several skipped checks are named together");
  assert.ok(esc.every((c) => c.evidenceIds.length > 0 && c.displayMode === "HYPOTHESIS"));
  const hollow = v.nodes.filter((n) => n.role === "policy" && n.ghost);
  assert.ok(hollow.some((n) => /not transactional/.test(n.label) && n.badge === "by convention"), "a rule stated only in a comment is hollow");
  assert.ok(v.edges.some((e) => e.kind === "governed by") && v.edges.some((e) => e.kind === "escape route" || e.kind === "guards"));
  audited(svc, v, claims);
  worker.close();
});

test("V9 runtime overlay: reported exceptions and failing tests on the structure; frames outside the repository are fog", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const none = await ask(svc, revision, "what has been going wrong in the last 7 days");
  assert.ok(none.view.nodes.length > 0, "the failing test alone is something to show");
  for (let i = 0; i < 3; i++) svc.reportException(ctx(), { trace: traceFor(repo), source: "api" });
  svc.reportException(ctx(), { trace: "TypeError: x\n    at f (/elsewhere/a.js:1:1)", source: "other" });
  const { view: v, claims } = await ask(svc, revision, "what has been going wrong in the last 7 days");
  assert.equal(v.formId, "RuntimeOverlay");
  const hot = v.nodes.filter((n) => n.role === "hot").sort((a, b) => b.heat!.value - a.heat!.value);
  assert.equal(hot[0].label, "checkFraud");
  assert.ok(hot[0].notes!.some((n) => /3× FraudRejectedError raised here/.test(n)));
  assert.ok(hot.every((n) => n.evidenceIds.length > 0) && v.nodes.some((n) => n.role === "structure"));
  assert.ok(v.gaps.some((g) => /outside this repository/.test(g)), "uninstrumented hops are fog, not lines");
  assert.ok(v.gaps.some((g) => /not live telemetry/.test(g)));
  audited(svc, v, claims);
  worker.close();
});

test("V10 race windows: strands side by side, transaction brackets, flagged windows citing both statements", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Where can balance race?");
  assert.equal(v.formId, "RaceWindow");
  const lanes = v.groups.filter((g) => g.kind === "lane");
  assert.ok(lanes.length >= 3, `${lanes.map((l) => l.label)}`);
  assert.ok(lanes.some((l) => /async handler/.test(l.label)) || lanes.some((l) => /via async/.test(l.label)));
  assert.ok(v.groups.some((g) => g.kind === "region" && g.label === "transaction"));
  const win = v.nodes.filter((n) => n.role === "race");
  assert.ok(win.length >= 1 && win.every((n) => n.displayMode === "HYPOTHESIS" && n.entityRefs.length === 2 && n.evidenceIds.length >= 2));
  assert.match(claims.find((c) => c.draft.id === win[0].ownClaimId)!.draft.assertion, /outside a transaction/);
  assert.ok(v.gaps.some((g) => /possible, not that it happens/.test(g)));
  audited(svc, v, claims);
  worker.close();
});

test("V11 counterfactual: ghost removal, solid surroundings, consequences that are all hypotheses", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "What if we remove the ledger module?");
  assert.equal(v.formId, "Counterfactual");
  const ghosts = v.nodes.filter((n) => n.role === "removed");
  assert.ok(ghosts.length >= 4 && ghosts.every((n) => n.ghost && n.displayMode === "HYPOTHESIS"));
  assert.ok(v.nodes.some((n) => n.role === "present" && n.label === "charge" && !n.ghost), "the code that stays is solid");
  const cons = v.consequences ?? [];
  assert.ok(cons.length >= 3 && cons.every((c) => c.displayMode === "HYPOTHESIS" && c.evidenceIds.length > 0));
  const text = cons.map((c) => c.text).join("\n");
  assert.match(text, /charge calls reserve.*would no longer exist/s);
  assert.match(text, /“account\.balance”.*writer\(s\).*disappear/s);
  assert.ok(v.edges.filter((e) => e.ghost).length >= 4 && v.nodes.filter((n) => n.ghost).every((n) => n.displayMode === "HYPOTHESIS"), "everything hypothetical is ghost-drawn by construction");
  const guarded = await ask(svc, revision, "What happens without checkFraud?");
  assert.ok(guarded.view.consequences!.some((c) => c.kind === "failure mode gone"));
  const unknown = await ask(svc, revision, "What if we remove the flux capacitor?");
  assert.match(unknown.view.caption, /can't tell what to remove/);
  audited(svc, v, claims);
  worker.close();
});

test("V12 test confidence: operations against the tests that reach them, with coverage and untested properties", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "How well tested are our operations?");
  assert.equal(v.formId, "TestConfidence");
  const beh = v.nodes.filter((n) => n.role === "behavior");
  assert.ok(beh.length >= 2);
  const cp = beh.find((n) => n.label === "createPayment")!;
  assert.ok(cp && /\d+% confidence/.test(cp.heat!.label));
  const dispute = beh.find((n) => n.label === "openDispute");
  assert.ok(!dispute || dispute.heat!.value > cp.heat!.value, "the untested refund path is warmer than the tested payment path");
  assert.ok(v.nodes.some((n) => n.role === "test" && n.label === "flags large amounts" && n.badge === "failed"));
  assert.ok(v.nodes.some((n) => n.role === "protected" && /0% lines covered|no test/.test(n.heat!.label)));
  const gap = v.nodes.find((n) => n.role === "gap" && /idempotency/.test(n.label));
  assert.ok(gap && gap.displayMode === "HYPOTHESIS", "no test asserts idempotency");
  assert.ok(v.gaps.some((g) => /branch coverage/.test(g)));
  audited(svc, v, claims);
  worker.close();
});

test("V13 ownership: formal vs de facto owners, bus factor, and a confirmation-pending claim for each de facto owner", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Who owns what and where is the bus factor 1?");
  assert.equal(v.formId, "Ownership");
  const owners = new Set(v.nodes.filter((n) => n.role === "owned-file").map((n) => n.badge));
  assert.ok(owners.has("@payments-team") && owners.has("@risk-team"), `${[...owners]}`);
  assert.ok(v.groups.filter((g) => g.kind === "region").length >= 2);
  const ledger = v.nodes.find((n) => n.file === "src/ledger/ledger.ts")!;
  assert.ok(ledger.notes!.some((n) => /Formal owner: @payments-team \(CODEOWNERS line 2\)/.test(n)));
  assert.ok(ledger.notes!.some((n) => /Members from teams\.json: Dana, Lee/.test(n)), `team members are resolved locally: ${ledger.notes}`);
  assert.ok(ledger.notes!.some((n) => /commit\(s\) by \d+ author/.test(n)));
  const c = claims.find((x) => x.draft.id === ledger.ownClaimId)!;
  assert.match(c.draft.assertion, /de facto owner.*formal owner is @payments-team \(members here: Dana, Lee, including Lee\)/, "mapped teams are named in the claim");
  assert.ok(!/team membership is not known/.test(c.draft.assertion), "with teams.json present, membership is known");
  assert.ok(!/differs/.test(v.caption), "no mismatch is claimed between people and teams");
  assert.ok(ledger.displayMode === "INFERENCE" && ledger.evidenceIds.length > 0);
  assert.match(v.caption, /bus factor 1/);
  audited(svc, v, claims);
  worker.close();
});

test("V14 concept atlas: concepts pinned onto the code that implements them, scatter, and missing enforcement", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const none = await ask(svc, revision, "Show the implicit concepts in this code");
  assert.match(none.view.caption, /no concept cards yet/i);
  assert.ok((await svc.extractConcepts(ctx(), { revision })).ok);
  const { view: v, claims } = await ask(svc, revision, "Show the implicit concepts in this code");
  assert.equal(v.formId, "ConceptAtlas");
  const concepts = v.nodes.filter((n) => n.role === "concept");
  assert.ok(concepts.length >= 3 && concepts.every((n) => n.displayMode === "INFERENCE" && n.heat && n.badge));
  const inv = concepts.find((n) => /balance/.test(n.label) && n.badge === "invariant")!;
  assert.ok(inv.notes!.some((n) => /Consistency: 1 of 3 writer\(s\) of balance are transactional/.test(n)));
  const gaps = v.nodes.filter((n) => n.role === "gap");
  assert.ok(gaps.length >= 2 && gaps.every((n) => n.ghost && n.evidenceIds.length > 0), "writers without a transaction are marked as missing enforcement");
  // A refuted concept disappears from the atlas.
  const card = svc.store.concepts(revision).find((c) => c.id && inv.id.endsWith(c.id))!;
  const cl = svc.store.getClaim(card.claimId)!;
  assert.ok(svc.verdict(ctx(), { claimId: cl.draft.id, verdict: "REFUTE", explanation: "not a real concept", expectedVersion: cl.version }).ok);
  const after = await ask(svc, revision, "Show the implicit concepts in this code");
  assert.ok(!after.view.nodes.some((n) => n.id === inv.id));
  audited(svc, v, claims);
  worker.close();
});

test("V16 change-risk terrain: a composite per file with a shown formula, tunable weights, and missing data flagged", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Where is it risky to change things?");
  assert.equal(v.formId, "ChangeRisk");
  const t = v.terrain!;
  assert.ok(t.cells.length >= 8 && t.factors.length === 5 && /Σ weight × factor/.test(t.formula));
  assert.ok(Math.abs(t.factors.reduce((s, f) => s + f.weight, 0) - 1) < 1e-9);
  for (const c of t.cells) { assert.ok(Object.values(c.factors).every((x) => x >= 0 && x <= 1)); assert.ok(c.evidenceIds.length > 0 && svc.store.evidence(revision, c.evidenceIds[0])); }
  const ledger = t.cells.find((c) => c.file === "src/ledger/ledger.ts")!, fraud = t.cells.find((c) => c.file === "src/payments/fraud.ts")!;
  assert.ok(ledger.factors.testGap > fraud.factors.testGap, "ledger has less test coverage than the fraud check");
  assert.match(ledger.raw.testGap, /\d+% covered/);
  assert.ok(v.nodes.every((n) => n.heat && n.heat.value >= 0 && n.heat.value <= 1));
  const sec = await ask(svc, revision, "Where is it risky to change things for a security review?");
  assert.equal(sec.view.terrain!.factors.find((f) => f.id === "incidents")!.weight, 0.3, "task type re-weights the terrain");
  assert.ok(v.gaps.some((g) => /composite/.test(g)) && v.gaps.some((g) => /route/.test(g)));
  audited(svc, v, claims);
  worker.close();
});

test("the gallery reports what each visual needs and whether it is available", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const r = svc.visuals(ctx(), { revision });
  assert.ok(r.ok);
  assert.equal(r.value.length, 17);
  const by = (c: string) => r.value.find((x) => x.code === c)!;
  assert.ok(by("V1").available && by("V4").available && by("V16").available);
  assert.equal(by("V6").available, false); assert.match(by("V6").reason!, /two indexed revisions/);
  assert.equal(by("V14").available, false); assert.match(by("V14").reason!, /concept cards/);
  assert.equal(by("V9").available, false); assert.match(by("V9").reason!, /reported exceptions/);
  assert.equal(by("V17").available, false); assert.match(by("V17").reason!, /imported profile/);
  assert.ok(by("V12").available && by("V13").available, "test results and git exist in the demo repo");
  worker.close();
});

test("V7 archaeology reads pull request references out of commit messages, and says the forge is not connected", async () => {
  const repo = demoRepo();
  const f = join(repo, "src/ledger/ledger.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace("export async function adjustBalance", "export async function adjustBalanceV2"));
  execFileSync("git", ["-C", repo, "-c", "user.name=Kim", "-c", "user.email=k@x", "commit", "-qam", "Rename adjustBalance after the refund hotfix (#12) fixing #7"]);
  const { svc, worker, revision } = await setup(undefined, repo);
  const { view: v, claims } = await ask(svc, revision, "Why is adjustBalanceV2 not transactional?");
  assert.equal(v.formId, "Archaeology");
  const pr = v.nodes.filter((n) => n.role === "event" && /PR #12/.test(n.badge ?? ""));
  assert.ok(pr.length >= 1, `a commit node carries a PR badge: ${v.nodes.filter((n) => n.role === "event").map((n) => n.badge)}`);
  assert.ok(pr[0].notes!.some((x) => /forge is not connected|not connected/.test(x)) || v.gaps.some((g) => /forge is not connected/.test(g)));
  assert.ok(v.caption.includes("reference"), `caption mentions the references: ${v.caption}`);
  audited(svc, v, claims);
  worker.close();
});

test("V9 runtime overlay gains measured latency from an ingested OpenTelemetry trace export", async () => {
  const repo = demoRepo();
  mkdirSync(join(repo, "traces"));
  writeFileSync(join(repo, "traces/otlp.json"), JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: [
      { name: "POST /payments", startTimeUnixNano: String((Date.now() - 3600_000) * 1e6), endTimeUnixNano: String(Date.now() - 3600_000 * 1e6 + 120 * 1e6), status: { code: 1 }, attributes: [{ key: "code.filepath", value: { stringValue: "src/api/payments-controller.ts" } }, { key: "code.lineno", value: { intValue: "6" } }, { key: "code.function", value: { stringValue: "createPayment" } }] },
      { name: "POST /payments", startTimeUnixNano: String((Date.now() - 1800_000) * 1e6), endTimeUnixNano: String(Date.now() - 1800_000 * 1e6 + 400 * 1e6), status: { code: 2, message: "declined" }, attributes: [{ key: "code.filepath", value: { stringValue: "src/api/payments-controller.ts" } }, { key: "code.function", value: { stringValue: "createPayment" } }] },
      { name: "orphan", startTimeUnixNano: String((Date.now() - 60_000) * 1e6), endTimeUnixNano: String(Date.now() - 60_000 * 1e6 + 5 * 1e6), status: { code: 1 } },
    ] }] }],
  }));
  const { svc, worker, revision } = await setup(undefined, repo);
  const { view: v, claims } = await ask(svc, revision, "what has been going wrong in the last 7 days");
  assert.equal(v.formId, "RuntimeOverlay");
  const hot = v.nodes.find((n) => n.role === "hot" && n.label === "createPayment");
  assert.ok(hot, "the traced operation is on the map");
  assert.ok(hot!.notes!.some((n) => /2 span\(s\).*1 error span\(s\).*p95/.test(n)), `span facts are shown: ${hot!.notes}`);
  assert.match(v.caption, /2 trace span\(s\)/);
  assert.ok(v.gaps.some((g) => /trace spans come from exports/i.test(g)), "the gap says what the trace data is: a recorded export, not telemetry");
  audited(svc, v, claims);
  worker.close();
});
