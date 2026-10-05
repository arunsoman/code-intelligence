import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureWorkspace } from "../src/build/fixture.ts";
import { STAGES } from "../src/build/stages.ts";
import { actionReasons, ago, cardOf, digestOf, issueLink, landingStage, openQuestions, primaryOf, retryTask, sectionsOf, splitQuestion, stepsOf, summaryNotes } from "../src/build/view.ts";
import { recordDecision } from "../src/build/wizard.ts";

const ws = () => buildFixtureWorkspace();

test("UX-68 the open question is full text, with what it blocks, and comes from the workspace", () => {
  const [q, ...rest] = openQuestions(ws());
  assert.equal(rest.length, 0);
  assert.deepEqual([q!.id, q!.text], ["Q4", "Who may receive the export?"]);
  assert.deepEqual(q!.blockedTasks, ["Delivery policy for email recipients"]);
  assert.match(q!.context, /recipient disclosure is new/);
  assert.deepEqual(splitQuestion("Q9"), { id: "Q9", text: "Q9" }); assert.deepEqual(splitQuestion("Q9", "why"), { id: "Q9", text: "why" });
});

test("UX-71 exactly one primary action, derived from state: an unanswered question wins, then submit once text exists, then the stage's own step", () => {
  const w = ws();
  assert.deepEqual(primaryOf(w, {}), { kind: "FOCUS_ANSWER", label: "Answer Q4 →", questionId: "Q4" });
  assert.equal(primaryOf({ ...w, stage: "CLARIFY" }, { Q4: "  " }).kind, "FOCUS_ANSWER");
  assert.deepEqual(primaryOf({ ...w, stage: "CLARIFY" }, { Q4: "finance only" }), { kind: "SUBMIT_ANSWER", label: "Submit answer to Q4", questionId: "Q4" });
  assert.equal(primaryOf({ ...w, stage: "PLAN" }, { Q4: "x" }).kind, "FOCUS_ANSWER", "a draft typed elsewhere does not submit from another stage");
  const answered = recordDecision(w, { questionId: "Q4", question: "Q4: Who may receive the export?", answer: "Finance", stage: "CLARIFY", actor: "user" }).workspace;
  assert.equal(openQuestions(answered).length, 0);
  assert.deepEqual(primaryOf({ ...answered, stage: "DESCRIBE" }, {}), { kind: "ANALYSE", label: "Start analysis", disabledReason: null });
  assert.equal((primaryOf({ ...answered, stage: "DESCRIBE", prompt: " " }, {}) as any).disabledReason, "Describe what should change first.");
  assert.deepEqual(primaryOf({ ...answered, stage: "PLAN" }, {}), { kind: "GO", label: "Review Changes →", target: "CHANGES" });
  assert.equal(primaryOf({ ...answered, stage: "DELIVER" }, {}).kind, "NONE");
});

test("UX-72 a saved workspace resumes where it was; a fresh one that already has work opens where the work is", () => {
  const w = ws();
  assert.equal(w.stage, "DESCRIBE"); assert.equal(landingStage(w), "CLARIFY");
  assert.equal(landingStage({ ...w, stage: "PLAN" }), "PLAN", "AT-67: a saved stage is restored, not overridden");
  const answered = recordDecision(w, { questionId: "Q4", question: "Q4: x", answer: "y", stage: "CLARIFY", actor: "u" }).workspace;
  assert.equal(landingStage({ ...answered, stage: "DESCRIBE" }), "VALIDATE");
  assert.equal(landingStage({ ...answered, stage: "DESCRIBE", candidate: null }), "DESCRIBE");
});

test("UX-73/84 one digest: counts agree with the progress groups, criteria are progress not proof, mocked is merged into a single line", () => {
  const w = ws(); const d = digestOf(w);
  assert.deepEqual([d.needsAnswer, d.blocked, d.running, d.ready, d.failed], [1, 2, 1, 1, 1]);
  assert.deepEqual(d.criteria, { passed: 1, total: 6 }); assert.equal(d.evidence, "mocked");
  const n = summaryNotes(w);
  assert.ok(n.shown.length <= 2, "at most two lines at once");
  assert.equal(n.shown[0]!.severity, "blocked"); assert.match(n.shown[0]!.text, /1 question\(s\) need your answer; independent tasks keep running/);
  assert.equal(n.all.filter((x) => x.text.startsWith("MOCKED")).length, 2, "the full list keeps every original note");
  assert.ok(n.shown.concat(n.all).every((x) => !/verified|all green|complete\b/i.test(x.text.replace("VALIDATION INCOMPLETE", ""))), "no completion claim is made");
  const clean = recordDecision({ ...w, mocked: [], blockers: [] }, { questionId: "none", question: "none", answer: "x", stage: "CLARIFY", actor: "u" }).workspace;
  assert.equal(digestOf(clean).evidence, "real");
});

test("UX-76 stepper states: current, needs attention, done, open; blocked steps say why but stay reachable", () => {
  const steps = stepsOf({ ...ws(), stage: "CLARIFY" });
  assert.deepEqual(steps.map((s) => s.id), STAGES.map((s) => s.id));
  const by = Object.fromEntries(steps.map((s) => [s.id, s]));
  assert.deepEqual([by.CLARIFY!.state, by.CLARIFY!.glyph], ["current", "●"]);
  assert.equal(by.DESCRIBE!.state, "done"); assert.equal(by.CHANGES!.state, "done");
  assert.equal(by.PLAN!.state, "open"); assert.match(by.PLAN!.hint!, /unresolved obligation/);
  const onPlan = Object.fromEntries(stepsOf({ ...ws(), stage: "PLAN" }).map((s) => [s.id, s]));
  assert.deepEqual([onPlan.CLARIFY!.state, onPlan.CLARIFY!.glyph, onPlan.CLARIFY!.hint], ["attention", "⚠", "1 question(s) need your answer"]);
  assert.ok(steps.every((s) => s.word.length > 0), "every step has a spoken state, not only a glyph");
  assert.equal(by.DELIVER!.state, "open", "delivery is never shown as done by this shell");
});

test("UX-69/77/78 task cards: one canonical card per task, a next action that is a real action, retry for failures", () => {
  const w = ws(); const secs = sectionsOf(w);
  assert.deepEqual(secs.map((s) => [s.key, s.cards.length]), [["running", 1], ["ready", 1], ["blocked", 2], ["failed", 1]]);
  const all = secs.flatMap((s) => s.cards.map((c) => c.task.id));
  assert.equal(new Set(all).size, all.length, "no task appears twice");
  const blocked = secs.find((s) => s.key === "blocked")!.cards;
  assert.deepEqual([blocked[0]!.chip, blocked[0]!.needsAnswer, blocked[0]!.action], ["Needs your answer", true, { label: "Answer Q4", kind: "ANSWER", questionId: "Q4" }]);
  assert.deepEqual([blocked[1]!.chip, blocked[1]!.action], ["Blocked", undefined]);
  assert.equal(cardOf(secs[0]!.cards[0]!.task).chip, "Running · queued");
  const failed = secs[3]!.cards[0]!; assert.deepEqual(failed.action, { label: "Retry", kind: "RETRY" }); assert.match(failed.detail!, /times out after 30 s/);
  const after = retryTask(w, failed.task.id);
  assert.equal(after.tasks.find((t) => t.id === failed.task.id)!.state, "READY"); assert.equal(after.workspaceVersion, w.workspaceVersion + 1);
  assert.equal(retryTask(w, "t1").tasks.find((t) => t.id === "t1")!.state, "COMPLETE", "only failed tasks are retried");
});

test("UX-70 every effectful action says exactly what it waits for, as text", () => {
  const r = actionReasons(ws());
  assert.deepEqual(r.map((a) => a.action), ["Build candidate", "Run validation", "Export patch", "Create draft PR"]);
  assert.ok(r.every((a) => !a.enabled && a.reason.length > 20));
  assert.match(r[0]!.reason, /unresolved obligation/); assert.match(r[2]!.reason, /mandatory criterion/); assert.match(r[3]!.reason, /publication check/);
});

test("UX-75/86 references: tracker links only where a repository is known, and age text for live updates", () => {
  assert.deepEqual(issueLink("o/r#9"), { text: "o/r#9", href: "https://github.com/o/r/issues/9" });
  assert.deepEqual(issueLink("#812"), { text: "#812" }); assert.equal(issueLink(undefined), null);
  assert.equal(issueLink("javascript:alert(1)")!.href, undefined, "only a recognised owner/repo#n becomes a link");
  const t = Date.parse("2026-10-05T00:00:00Z");
  assert.deepEqual([ago("2026-10-05T00:00:00Z", t + 12_000), ago("2026-10-05T00:00:00Z", t + 300_000), ago("2026-10-05T00:00:00Z", t + 7_200_000)], ["12s ago", "5 min ago", "2 h ago"]);
});
