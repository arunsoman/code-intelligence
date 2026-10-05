import assert from "node:assert/strict";
import { test } from "node:test";
import { EFFECTFUL_ACTIONS, STAGES } from "../src/build/stages.ts";
import { buildFixtureWorkspace, FIXTURE_REQUEST_ID, memoryStore } from "../src/build/fixture.ts";
import { advanceWizard, groupTasks, recordDecision, stageGate, statusBanners, type WizardWorkspace } from "../src/build/wizard.ts";

// AT-67 (submit/resume through the panel), AT-68 (Next with a material blocker), AT-69 (backward edit
// stales the candidate), PF-069 (persistent six-stage wizard), PF-070 (action boundaries, stale impact),
// PF-043/§30.2 (blocked/progress visibility).

test("AT-67 resume: a saved workspace restores stage, saved decisions and the current candidate", () => {
  const store = memoryStore();
  const started = buildFixtureWorkspace();
  const moved = advanceWizard(started, "CLARIFY", started.workspaceVersion);
  assert.ok(moved.ok);
  store.save(moved.value);

  const resumed = store.load(FIXTURE_REQUEST_ID);
  assert.ok(resumed);
  assert.equal(resumed.stage, "CLARIFY");
  assert.equal(resumed.decisions.length, 3, "saved decisions survive the close/reopen");
  assert.equal(resumed.candidate?.hash, "cand-9f31c0", "the current candidate pointer is restored, not reset");
  assert.equal(resumed.contractVersion, 3);
  assert.deepEqual(store.list().map((s) => s.requestId), [FIXTURE_REQUEST_ID]);
});

test("AT-67 advance: version check passes with the current version and bumps it", () => {
  const ws = buildFixtureWorkspace();
  const r = advanceWizard(ws, "CLARIFY", ws.workspaceVersion);
  assert.ok(r.ok);
  assert.equal(r.value.stage, "CLARIFY");
  assert.equal(r.value.workspaceVersion, ws.workspaceVersion + 1);
});

test("advance with a stale expected version is a conflict, not a silent overwrite", () => {
  const ws = buildFixtureWorkspace();
  const r = advanceWizard(ws, "PLAN", ws.workspaceVersion - 1);
  assert.ok(!r.ok);
  assert.equal(r.ok ? "" : r.error.code, "VERSION_CONFLICT");
  assert.equal(ws.stage, "DESCRIBE", "the recorded workspace is unchanged");
});

test("AT-68 Next with a material question: navigation stays free, the blocker is explicit, independent work continues", () => {
  const ws = buildFixtureWorkspace();
  // "View next stage" is navigation: it works even though a material question blocks one task.
  const moved = advanceWizard(ws, "CLARIFY", ws.workspaceVersion);
  assert.ok(moved.ok);

  const gate = stageGate(moved.value, "PLAN");
  assert.equal(gate.primaryEnabled, false, "the blocked stage's primary action is held");
  assert.match(gate.disabledReason ?? "", /obligation/i);
  assert.ok(gate.visibleBlockers.some((b) => b.question === "Q4"), "the material question is named, not hidden");

  const groups = groupTasks(moved.value.tasks);
  const t4 = groups.needsAnswer.find((t) => t.id === "t4");
  assert.ok(t4, "the blocked question task is in Needs your answer");
  assert.deepEqual(t4.requirementIds, ["R4"]);
  assert.ok(t4.blocker && t4.question && t4.nextAction, "blocker, question and next action are all shown");
  assert.ok(t4.independent.some((t) => t.id === "t2" && t.state === "RUNNING"), "independent running work is listed");
  assert.equal(groups.running.length, 1);
  assert.equal(groups.ready.length, 1);
  assert.ok(groups.blocked.some((t) => t.id === "t5"), "the provider-waiting task is blocked, not silently dropped");
  assert.equal(groups.failed.length, 1, "failures have their own group, not a green aggregate");
});

test("§30.2 groups always render all five buckets, and waits are distinguishable", () => {
  const groups = groupTasks(buildFixtureWorkspace().tasks);
  for (const key of ["running", "ready", "blocked", "failed", "needsAnswer"] as const) assert.ok(Array.isArray(groups[key]));
  const waits = new Set([...groups.blocked, ...groups.needsAnswer].flatMap((t) => (t.waiting ? [t.waiting] : [])));
  assert.ok(waits.has("USER") && waits.has("PROVIDER"), "waiting for user vs provider is explicit");
});

test("AT-69 backward edit: a changed earlier-stage answer creates a new contract and stales candidate and evidence before navigation continues", () => {
  const ws: WizardWorkspace = { ...buildFixtureWorkspace(), stage: "CHANGES" };
  const { workspace, impact } = recordDecision(ws, {
    questionId: "Q3",
    question: "Q3: Who may request the export?",
    answer: "Finance role plus named auditors; tenant scope preserved.",
    stage: "CLARIFY",
    actor: "user",
  });

  assert.equal(workspace.contractVersion, 4, "a new contract version is created");
  assert.equal(workspace.workspaceVersion, ws.workspaceVersion + 1);
  assert.equal(workspace.candidate?.status, "STALE", "the current candidate is stale before anything continues");
  assert.ok(workspace.evidence.every((e) => e.status === "STALE"), "affected evidence is stale");
  assert.match(impact.summary, /v4/);
  assert.match(impact.summary, /STALE/);
  const superseding = workspace.decisions[workspace.decisions.length - 1]!;
  assert.equal(superseding.supersedesId, "dec-3-Q3", "the old decision is superseded, not rewritten");

  // Forward navigation is still possible but the banner keeps the stale state visible.
  const moved = advanceWizard(workspace, "VALIDATE", workspace.workspaceVersion);
  assert.ok(moved.ok);
  assert.ok(statusBanners(moved.value).some((b) => /STALE/.test(b)), "stale impact follows every later stage");
});

test("answering the material question unblocks exactly its task and clears the blocker", () => {
  const ws = buildFixtureWorkspace();
  const { workspace } = recordDecision(ws, {
    questionId: "Q4",
    question: "Delivery policy: recipient disclosure is new and needs an explicit decision.",
    answer: "Approved recipients only; no free-text addresses.",
    stage: "CLARIFY",
    actor: "user",
  });
  const t4 = workspace.tasks.find((t) => t.id === "t4")!;
  assert.equal(t4.state, "READY");
  assert.ok(!workspace.blockers.some((b) => b.question === "Q4"));
  assert.equal(workspace.candidate?.status, "MATERIALIZED", "a forward, first-time answer stales nothing");
  assert.ok(statusBanners(workspace).every((b) => !/BLOCKED — Delivery policy/.test(b)));
});

test("§30.2 banners: implemented-but-unvalidated and unvalidated performance are shown, never a verified/green-complete claim", () => {
  const banners = statusBanners(buildFixtureWorkspace());
  assert.ok(banners.some((b) => b.startsWith("IMPLEMENTED — VALIDATION INCOMPLETE")), "exact §30.2 wording");
  assert.ok(banners.some((b) => b === "PERFORMANCE UNVALIDATED"));
  assert.ok(banners.some((b) => b.startsWith("MOCKED — provider integration")), "mocks carry a persistent label");
  assert.ok(banners.some((b) => b.startsWith("BLOCKED — ") && b.includes("Q4")));
  for (const b of banners) {
    assert.ok(!/verified/i.test(b), `banner must not claim verified: ${b}`);
    assert.ok(!/complete/i.test(b) || /INCOMPLETE/.test(b), `no green completion aggregate: ${b}`);
  }
});

test("PF-070 boundaries: stage primaries are gated on prerequisites and say why", () => {
  const ws = buildFixtureWorkspace();
  assert.equal(stageGate(ws, "VALIDATE").primaryEnabled, true, "an exact materialized candidate may be validated");
  const staleWs: WizardWorkspace = { ...ws, candidate: { hash: "cand-9f31c0", status: "STALE" } };
  assert.equal(stageGate(staleWs, "VALIDATE").primaryEnabled, false);
  assert.match(stageGate(staleWs, "VALIDATE").disabledReason ?? "", /stale/i);
  assert.equal(stageGate(ws, "CHANGES").primaryEnabled, true);
  const noCandidate: WizardWorkspace = { ...ws, candidate: null };
  assert.equal(stageGate(noCandidate, "CHANGES").primaryEnabled, false);
  assert.equal(stageGate(noCandidate, "DELIVER").primaryEnabled, false);
  assert.match(stageGate(noCandidate, "DELIVER").disabledReason ?? "", /mandatory|candidate/i);
});

test("effectful actions stay separate from stage navigation", () => {
  assert.deepEqual([...EFFECTFUL_ACTIONS], ["Build candidate", "Run validation", "Export patch", "Create draft PR"]);
  assert.ok(![...EFFECTFUL_ACTIONS, ...STAGES.map((s) => s.primary)].some((a) => /^next$/i.test(a)));
});
