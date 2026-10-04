import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { Claim, ModelProvider, ModelRequest } from "@cie/schema";
import { CALIBRATION_MIN_LABELS, applyVerdict, gateClaim, wilson } from "../src/claims.ts";
import { retrieveAround } from "../src/retrieval.ts";
import { routeIntent, matchName, chooseForm } from "../src/router.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const login = "method:src/auth/service.ts#AuthService.login", sign = "function:src/auth/token.ts#signToken", users = "function:src/db/users.ts#findByEmail";

async function fixtureClaim(svc: any, revision: string, entityIds: string[], over: Partial<Parameters<typeof gateClaim>[0]> = {}) {
  const bundle = retrieveAround(svc.store, revision, [login, sign, users]);
  const ev = bundle.relationships.find((r) => r.kind === "calls" && r.from === login && r.to === sign)!.evidence.map((e) => e.id);
  return gateClaim({ assertion: `login reaches ${entityIds.at(-1)}`, claimClass: "structural-path", evidenceIds: ev, rationaleSummary: "t", structure: { kind: "path", entityIds }, ...over }, bundle, { store: svc.store });
}

test("wilson interval matches known values", () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lower - 0.490) < 0.01 && Math.abs(w.upper - 0.943) < 0.01, JSON.stringify(w));
  assert.deepEqual(wilson(0, 0), { lower: 0, upper: 1 });
});

test("CONSISTENCY re-verifies the asserted path against the stored graph; a fabricated hop is hidden", async () => {
  const { svc, worker, revision } = await setup();
  const good = await fixtureClaim(svc, revision, [login, sign]);
  assert.equal(good.gates.find((g) => g.gate === "CONSISTENCY")!.status, "PASS");
  assert.equal(good.displayMode, "INFERENCE");
  const bad = await fixtureClaim(svc, revision, [sign, users]); // signToken does not touch findByEmail
  const c = bad.gates.find((g) => g.gate === "CONSISTENCY")!;
  assert.equal(c.status, "FAIL");
  assert.match(c.reasons.join(" "), /no static edge/);
  assert.equal(bad.displayMode, "HIDDEN");
  const ghost = await fixtureClaim(svc, revision, [login, "function:nope#x"]);
  assert.equal(ghost.displayMode, "HIDDEN");
  worker.close();
});

test("five gates are always reported, and calibration abstains without labels", async () => {
  const { svc, worker, revision } = await setup();
  const c = await fixtureClaim(svc, revision, [login, sign]);
  assert.deepEqual(c.gates.map((g) => g.gate), ["GROUNDING", "CONSISTENCY", "ADVERSARIAL", "CALIBRATION", "DISPLAY"]);
  const cal = c.gates.find((g) => g.gate === "CALIBRATION")!;
  assert.equal(cal.status, "INSUFFICIENT");
  assert.equal(c.confidence.mode, "NOT_ESTIMATED");
  assert.match(cal.reasons[0], new RegExp(`0/${CALIBRATION_MIN_LABELS}`));
  worker.close();
});

test("verdicts: confirm never becomes FACT; refute hides and stales dependents; versions are enforced; refuted claims stay hidden", async () => {
  const { svc, worker, revision } = await setup();
  const parent = await fixtureClaim(svc, revision, [login, sign]);
  svc.store.putClaim(parent);
  const child = await fixtureClaim(svc, revision, [login, sign], { assertion: "derived from parent", dependencyIds: [parent.draft.id] });
  svc.store.putClaim(child);
  const grandchild = await fixtureClaim(svc, revision, [login, sign], { assertion: "derived from child", dependencyIds: [child.draft.id] });
  svc.store.putClaim(grandchild);

  const noExpl = svc.verdict(ctx(), { claimId: parent.draft.id, verdict: "CONFIRM", explanation: " ", expectedVersion: 1 });
  assert.ok(!noExpl.ok && noExpl.error.code === "INVALID_SCHEMA");
  const stale = svc.verdict(ctx(), { claimId: parent.draft.id, verdict: "CONFIRM", explanation: "ok", expectedVersion: 7 });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.currentVersion === 1);

  const dis = svc.verdict(ctx(), { claimId: parent.draft.id, verdict: "DISPUTE", explanation: "not sure", expectedVersion: 1 });
  assert.ok(dis.ok && dis.value.claim.displayMode === "HYPOTHESIS" && dis.value.claim.version === 2);
  const conf = svc.verdict(ctx(), { claimId: parent.draft.id, verdict: "CONFIRM", explanation: "read the code", expectedVersion: 2 });
  assert.ok(conf.ok);
  assert.equal(conf.value.claim.state, "CONFIRMED");
  assert.equal(conf.value.claim.displayMode, "INFERENCE", "human confirmation is not deterministic proof");
  assert.equal(conf.value.claim.verdicts.length, 2);

  const ref = svc.verdict(ctx(), { claimId: parent.draft.id, verdict: "REFUTE", explanation: "actually dead code", expectedVersion: 3 });
  assert.ok(ref.ok);
  assert.equal(ref.value.claim.displayMode, "HIDDEN");
  assert.deepEqual(ref.value.affected.map((c) => c.draft.id).sort(), [child.draft.id, grandchild.draft.id].sort(), "transitive dependents");
  assert.ok(ref.value.affected.every((c) => c.state === "STALE"));
  assert.equal(svc.store.getClaim(grandchild.draft.id)!.state, "STALE");
  // Re-deriving the same claim later stays hidden.
  const again = await fixtureClaim(svc, revision, [login, sign]);
  assert.equal(again.displayMode, "HIDDEN");
  assert.match(again.gates.find((g) => g.gate === "CONSISTENCY")!.reasons.join(" "), /previously refuted/);
  worker.close();
});

test("calibration: after enough labelled verdicts a claim class gets a calibrated Wilson band", async () => {
  const { svc, worker, revision } = await setup();
  const seed = async (i: number) => { const c = await fixtureClaim(svc, revision, [login, sign], { assertion: `calib ${i}`, claimClass: "calib-class" }); svc.store.putClaim(c); return c; };
  for (let i = 0; i < CALIBRATION_MIN_LABELS; i++) {
    const c = await seed(i);
    const r = applyVerdict(svc.store, { claimId: c.draft.id, verdict: i < 14 ? "CONFIRM" : "REFUTE", explanation: "label", actorId: "t", expectedVersion: 1 });
    assert.ok(r.ok);
    if (i === 0) assert.equal((await fixtureClaim(svc, revision, [login, sign], { assertion: "probe", claimClass: "calib-class" })).confidence.mode, "UNCALIBRATED");
  }
  const probe = await fixtureClaim(svc, revision, [login, sign], { assertion: "probe 2", claimClass: "calib-class" });
  assert.equal(probe.confidence.mode, "CALIBRATED");
  const b = probe.confidence.band!;
  assert.equal(b.sampleCount, 20);
  assert.ok(b.lower < 0.7 && b.upper > 0.7 && b.lower > 0.45 && b.upper < 0.9, JSON.stringify(b));
  assert.equal(probe.gates.find((g) => g.gate === "CALIBRATION")!.status, "PASS");
  worker.close();
});

test("audit log is hash-chained; tampering is detected; verdicts and asks are recorded", async () => {
  const { svc, worker, revision } = await setup();
  await svc.ask(ctx(), { question: "authentication", revision });
  const c = await fixtureClaim(svc, revision, [login, sign]); svc.store.putClaim(c);
  svc.verdict(ctx(), { claimId: c.draft.id, verdict: "CONFIRM", explanation: "yes", expectedVersion: 1 });
  const log = svc.auditLog(ctx(), {});
  assert.ok(log.ok && log.value.chain.ok);
  const actions = (log.value.events as any[]).map((e) => e.action);
  for (const a of ["repo.ingest", "ask", "claim.confirm"]) assert.ok(actions.includes(a), a);
  svc.store.db.prepare("update audit set meta = '{}' where seq = 2").run();
  const bad = svc.auditLog(ctx(), {});
  assert.ok(bad.ok && !bad.value.chain.ok && bad.value.chain.brokenAt === 2);
  worker.close();
});

test("concept cards: capabilities, failure modes, invariants and async workflows, each grounded", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.extractConcepts(ctx(), { revision });
  assert.ok(r.ok);
  const cards = r.value.cards;
  const kinds = new Set(cards.map((c) => c.kind));
  for (const k of ["capability", "failure-mode", "invariant", "workflow"]) assert.ok(kinds.has(k as any), k);
  const inv = cards.find((c) => c.kind === "invariant" && c.title.includes("balance"))!;
  assert.equal(inv.members.length, 3);
  assert.match(inv.summary, /outside a transaction/);
  assert.ok(cards.some((c) => c.kind === "workflow" && c.title.includes("refund.requested")));
  assert.ok(cards.some((c) => c.kind === "failure-mode" && c.title === "Failure: FraudRejectedError"));
  for (const c of cards) {
    assert.ok(c.evidenceIds.length > 0 && svc.store.evidence(revision, c.evidenceIds[0]), "card cites stored evidence");
    const claim = svc.store.getClaim(c.claimId)!;
    assert.ok(claim && claim.gates[0].status === "PASS" && claim.displayMode !== "HIDDEN");
    assert.equal(c.statedConfidence.length > 0, true);
  }
  // Cards feed retrieval: a question about "refund.requested" finds the workflow members.
  const listed = svc.listConcepts(ctx(), { revision });
  assert.ok(listed.ok && listed.value.length === cards.length);
  worker.close();
});

class Hosted implements ModelProvider {
  readonly name = "hosted-fake"; readonly model = "x:cloud"; readonly hosted = true;
  seen: ModelRequest[] = []; private inner = new StubProvider();
  async generate(req: ModelRequest) { this.seen.push(req); return this.inner.generate(req); }
}

test("egress: hosted models are blocked until the repo is opted in; secrets are scrubbed; everything is audited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-secret-"));
  const secretName = "f_" + "A".repeat(60);
  writeFileSync(join(dir, "a.ts"), `export function ${secretName}() { return 1; }\nexport function okThing() { return ${secretName}(); }\n`);
  const hosted = new Hosted();
  const { svc, worker, revision } = await setup(hosted, dir);

  const before = await svc.ask(ctx(), { question: "ok thing", revision });
  assert.ok(before.ok);
  assert.equal(hosted.seen.length, 0, "nothing sent without approval, not even for routing");
  assert.ok(before.metadata.warnings.some((w) => /not approved/.test(w)));
  assert.ok((svc.auditLog(ctx(), {}) as any).value.events.some((e: any) => e.action === "egress.denied"));

  assert.ok(!svc.setEgress(ctx(), { repoRoot: "/not/indexed", allow: true }).ok);
  assert.ok(svc.setEgress(ctx(), { repoRoot: svc.store.revision(revision)!.repoRoot, allow: true }).ok);
  const after = await svc.ask(ctx(), { question: "ok thing", revision });
  assert.ok(after.ok);
  // The routing call carries the question and an empty bundle: no code, no names from the repository.
  const routing = hosted.seen.filter((r) => r.purpose === "ROUTE");
  assert.ok(routing.every((r) => r.bundle.entities.length === 0 && r.bundle.relationships.length === 0 && r.bundle.facts.length === 0));
  const rep = hosted.seen.filter((r) => r.purpose !== "ROUTE");
  assert.equal(rep.length, 1);
  const sent = JSON.stringify(rep[0].bundle);
  assert.ok(!sent.includes("AAAAAAAAAA"), "secret-looking identifier removed before egress");
  assert.ok(sent.includes("okThing"));
  assert.ok(after.metadata.warnings.some((w) => /removed before sending/.test(w)));
  const ev = (svc.auditLog(ctx(), {}) as any).value.events.find((e: any) => e.action === "egress.approved");
  assert.ok(ev && JSON.parse(ev.meta).payloadHash.length === 64 && JSON.parse(ev.meta).redactions >= 1);
  assert.ok((svc.auditLog(ctx(), {}) as any).value.chain.ok);
  worker.close();
});

test("router: intents and form selection are explicit and predictable", () => {
  const c = (o: Partial<Parameters<typeof routeIntent>[1]> = {}) => ({ hasView: true, selectionCount: 0, looksLikeTrace: false, ...o });
  assert.equal(chooseForm("show me everything that could cause a payment to fail").kind, "failure");
  assert.equal(chooseForm("why could this balance become incorrect?").kind, "invariant");
  assert.equal(chooseForm("show me how authentication works").form, "SemanticMap");
  assert.deepEqual(routeIntent("continue the payment investigation", c({ hasView: false })), { type: "resume", name: "payment" });
  assert.equal(routeIntent("x", c({ looksLikeTrace: true })).type, "investigate");
  assert.deepEqual(routeIntent("ignore checkFraud", c({ viewForm: "HypothesisGraph" })), { type: "ignore", target: "checkFraud" });
  assert.equal(routeIntent("ignore checkFraud", c({ viewForm: "SemanticMap" })).type, "ask");
  assert.deepEqual(routeIntent("why do you suspect charge?", c({ viewForm: "HypothesisGraph" })), { type: "whySuspect", target: "charge" });
  assert.equal(routeIntent("why are you showing this?", c({ selectionCount: 1 })).type, "whyShown");
  assert.deepEqual(routeIntent("why isn't handleRefund shown?", c()), { type: "whyHidden", target: "handleRefund" });
  assert.equal(routeIntent("why are these connected?", c({ selectionCount: 2 })).type, "connected");
  assert.equal(routeIntent("why are these connected?", c({ selectionCount: 0 })).type, "ask");
  assert.deepEqual(routeIntent("zoom out", c()), { type: "zoom", direction: "out" });
  assert.deepEqual(routeIntent("give me the overview", c()), { type: "zoom", direction: "overview" });
  assert.equal(routeIntent("how does login work", c()).type, "ask");
  assert.equal(matchName("payment", [{ name: "Auth Understanding" }, { name: "Payment failure investigation" }])!.name, "Payment failure investigation");
  assert.equal(matchName("billing", [{ name: "Auth Understanding" }]), null);
});

test("converse: question → view, trace → investigation, steering, why-shown/hidden, resume", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const trace = (await import("./helpers.ts")).traceFor(repo);
  const q = await svc.converse(ctx(), { text: "Show me everything that could cause a payment to fail", revision });
  assert.ok(q.ok && q.value.kind === "view" && q.value.view.formId === "CausalGraph");
  assert.match(q.value.message, /failure/i);

  const inv = await svc.converse(ctx(), { text: trace, revision });
  assert.ok(inv.ok && inv.value.kind === "view" && inv.value.view.formId === "HypothesisGraph");
  const view = inv.value.view;

  const ign = await svc.converse(ctx(), { text: "ignore checkFraud", view });
  assert.ok(ign.ok && ign.value.kind === "view" && !ign.value.view.nodes.some((n) => n.label === "checkFraud") && ign.value.view.version === view.version + 1);
  const why = await svc.converse(ctx(), { text: "why do you suspect charge?", view: ign.value.kind === "view" ? ign.value.view : view });
  assert.ok(why.ok && why.value.kind === "explanation" && why.value.explanation.evidence.length > 0);

  const shownNode = view.nodes.find((n) => n.label === "charge")!;
  const shown = await svc.converse(ctx(), { text: "why are you showing this?", view, selection: [shownNode.id] });
  assert.ok(shown.ok && shown.value.kind === "explanation" && /runtime hotness|stack/i.test(shown.value.message));

  const hid = await svc.converse(ctx(), { text: "why isn't handleRefund shown?", view });
  assert.ok(hid.ok && hid.value.kind === "explanation" && /handleRefund/.test(hid.value.message));
  const none = await svc.converse(ctx(), { text: "why isn't frobnicate shown?", view });
  assert.ok(none.ok && none.value.kind === "explanation" && /Nothing in this repository is named like/.test(none.value.message));

  const noMatch = await svc.converse(ctx(), { text: "continue the billing investigation", view: null });
  assert.ok(noMatch.ok && noMatch.value.kind === "message");
  svc.saveWorkspace(ctx(), { name: "Payment failure investigation", expectedVersion: 0, revision, state: { question: "", view, claims: [], selection: [], explanation: null, events: [] } });
  const res = await svc.converse(ctx(), { text: "continue the payment investigation", view: null });
  assert.ok(res.ok && res.value.kind === "resume" && res.value.workspaceId.startsWith("ws:"));
  const z = await svc.converse(ctx(), { text: "zoom out", view });
  assert.ok(z.ok && z.value.kind === "zoom" && z.value.direction === "out");
  worker.close();
});

test("changesSince: re-index and report what changed in the repository since the investigation was saved", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const asked = await svc.ask(ctx(), { question: "Why could this balance become incorrect?", revision });
  assert.ok(asked.ok);
  const saved = svc.saveWorkspace(ctx(), { name: "Balance investigation", expectedVersion: 0, revision, state: { question: "balance", view: asked.value.view, claims: asked.value.claims, selection: [], explanation: null, events: [] } });
  assert.ok(saved.ok);
  const same = await svc.changesSince(ctx(), { workspaceId: saved.value.workspaceId });
  assert.ok(same.ok && !same.value.changed);

  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const ledger = join(repo, "src/ledger/ledger.ts");
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace("account.balance += delta;", "account.balance = Math.max(0, account.balance + delta);"));
  execFileSync("git", ["-C", repo, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", "Hotfix: guard adjustBalance"]);
  const r = await svc.changesSince(ctx(), { workspaceId: saved.value.workspaceId });
  assert.ok(r.ok && r.value.changed);
  assert.deepEqual(r.value.files.changed, ["src/ledger/ledger.ts"]);
  assert.ok(r.value.affectedNodes.some((n) => n.label === "adjustBalance" && n.change === "changed"));
  assert.ok(!r.value.affectedNodes.some((n) => n.label === "commit" || n.label === "reconcileBalances"), "symbols whose own code did not change are not affected, even in a changed file");
  assert.ok(r.value.commits.some((c) => c.subject === "Hotfix: guard adjustBalance" && c.author === "Sam"));
  assert.match(r.value.summary, /Since you left: 1 file\(s\) changed/);
  assert.notEqual(r.value.toRevision, r.value.fromRevision);
  const opened = svc.openWorkspace(ctx(), { workspaceId: saved.value.workspaceId });
  assert.ok(opened.ok && opened.value.staleFiles.includes("src/ledger/ledger.ts"));
  worker.close();
});

test("CONSISTENCY accepts containment hops, so a claim routed through a file is checkable", async () => {
  const { svc, worker, revision } = await setup();
  const c = await fixtureClaim(svc, revision, [login, "file:src/auth/service.ts", "file:src/auth/token.ts", sign], { assertion: "via files" });
  assert.equal(c.gates.find((g) => g.gate === "CONSISTENCY")!.status, "PASS", c.gates.find((g) => g.gate === "CONSISTENCY")!.reasons.join(";"));
  worker.close();
});

test("'give me the project overview' builds a zoomed-out map of the project; zoom commands need a map", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  for (const text of ["give me the project overview", "overview of the codebase", "what does this project do", "architecture overview", "could u show the flow  diagram for the whole project?", "map the entire codebase", "show an architecture diagram of this project"]) {
    assert.equal(routeIntent(text, { hasView: false, selectionCount: 0, looksLikeTrace: false }).type, "overview", text);
  }
  assert.equal(routeIntent("overview", { hasView: true, selectionCount: 0, looksLikeTrace: false }).type, "zoom", "bare 'overview' with a map still means zoom out");
  assert.equal(routeIntent("zoom out", { hasView: false, selectionCount: 0, looksLikeTrace: false }).type, "ask", "no map, nothing to zoom");
  const r = await svc.converse(ctx(), { text: "give me the project overview", view: null, revision });
  assert.ok(r.ok && r.value.kind === "view", "it produces a map, not a bare message");
  const v = r.value.view;
  assert.equal(v.level, 1, "starts zoomed out");
  assert.ok(v.nodes.length >= 10 && v.groups.some((g) => g.kind === "concept"), `${v.nodes.length} nodes`);
  assert.ok(v.nodes.some((n) => n.label === "charge") && v.nodes.every((n) => n.evidenceIds.length > 0));
  assert.match(r.value.message, /overview/i);
  worker.close();
});
