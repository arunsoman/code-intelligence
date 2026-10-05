import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureWorkspace } from "../src/build/fixture.ts";
import { MODE_LABEL, SYNC_LABEL, advanceRemote, mergeServer, openRemote, type RemoteCall } from "../src/build/remote.ts";

const server = { requestId: "req:abc", stage: "PLAN" as const, workspaceVersion: 4, contractVersion: 2, mode: "CREATE_DRAFT_PR", candidateHash: "pf-canon-v1/x:1", candidateStatus: "STALE" as const, issueRef: "o/r#9" };
const fake = (handlers: Record<string, (body: any) => unknown>, log: string[] = []): RemoteCall => (async (component: string, op: string, body: unknown) => {
  log.push(`${component}/${op}`); const h = handlers[`${component}/${op}`]; if (!h) throw new Error(`unexpected ${component}/${op}`);
  const out = h(body) as any; return out && out.__error ? { ok: false, error: out.__error } : { ok: true, value: out };
}) as RemoteCall;

test("server-owned fields replace the sample ones, everything else stays and is labelled as sample data", () => {
  const base = buildFixtureWorkspace(); const m = mergeServer(base, server);
  assert.deepEqual([m.requestId, m.stage, m.workspaceVersion, m.contractVersion, m.outcomeMode, m.issueRef], ["req:abc", "PLAN", 4, 2, "DRAFT_PR", "o/r#9"]);
  assert.deepEqual(m.candidate, { hash: "pf-canon-v1/x:1", status: "STALE" });
  assert.deepEqual(m.tasks, base.tasks, "tasks are not taken from the server yet");
  assert.ok(m.mocked.includes(SYNC_LABEL)); assert.equal(mergeServer(m, server).mocked.filter((x) => x === SYNC_LABEL).length, 1, "the label is not duplicated");
  assert.equal(mergeServer(base, { ...server, candidateHash: undefined }).candidate, null, "no candidate on the server means no candidate shown");
  assert.deepEqual(Object.values(MODE_LABEL), ["PLAN_ONLY", "BUILD_AND_PREVIEW", "DRAFT_PR"]);
});

test("openRemote asks only for what changed: an unchanged version is NOT_MODIFIED and keeps the local workspace", async () => {
  const base = { ...buildFixtureWorkspace(), requestId: "req:abc", workspaceVersion: 4 };
  const seen: any[] = [];
  const r = await openRemote(fake({ "C01/openFeatureWorkspace": (b) => { seen.push(b); return { status: "COMPLETE", diagnostics: ["NOT_MODIFIED"] }; } }), base, "req:abc");
  assert.ok(r.ok && r.unchanged && r.value === base); assert.equal(seen[0].sinceWorkspaceVersion, 4);
  const other = await openRemote(fake({ "C01/openFeatureWorkspace": (b) => { seen.push(b); return { status: "COMPLETE", value: server, diagnostics: [] }; } }), buildFixtureWorkspace(), "req:abc");
  assert.equal(seen[1].sinceWorkspaceVersion, undefined, "a different request's version is never sent");
  assert.ok(other.ok && !other.unchanged && other.value.workspaceVersion === 4);
  const bad = await openRemote(fake({ "C01/openFeatureWorkspace": () => ({ __error: { code: "NOT_FOUND", message: "no such request req:abc" } }) }), base, "req:abc");
  assert.ok(!bad.ok && bad.message === "no such request req:abc");
});

test("advanceRemote sends the expected version, then re-reads the full pointer set", async () => {
  const log: string[] = []; let sent: any;
  const ws = { ...buildFixtureWorkspace(), requestId: "req:abc", workspaceVersion: 3, stage: "CLARIFY" as const };
  const call = fake({
    "C02/advanceWizard": (b) => { sent = b; return { status: "COMPLETE", value: { ...server, stage: "PLAN", workspaceVersion: 4 }, diagnostics: [] }; },
    "C01/openFeatureWorkspace": () => ({ status: "COMPLETE", value: server, diagnostics: [] }),
  }, log);
  const r = await advanceRemote(call, ws, "PLAN");
  assert.deepEqual(sent, { requestId: "req:abc", targetStage: "PLAN", expectedWorkspaceVersion: 3 });
  assert.ok(r.ok && r.value.stage === "PLAN" && r.value.workspaceVersion === 4 && r.value.contractVersion === 2); assert.deepEqual(log, ["C02/advanceWizard", "C01/openFeatureWorkspace"]);
});

test("a stale version is a readable conflict, not a silent overwrite; other failures pass their message through", async () => {
  const ws = { ...buildFixtureWorkspace(), requestId: "req:abc", workspaceVersion: 2 };
  const conflict = await advanceRemote(fake({ "C02/advanceWizard": () => ({ __error: { code: "VERSION_CONFLICT", message: "the workspace changed (version 5, expected 2)", currentVersion: 5 } }) }), ws, "PLAN");
  assert.ok(!conflict.ok && conflict.conflict && /Reloading the request will show the current state; nothing you recorded was lost/.test(conflict.message));
  const other = await advanceRemote(fake({ "C02/advanceWizard": () => ({ __error: { code: "NOT_FOUND", message: "no such request" } }) }), ws, "PLAN");
  assert.ok(!other.ok && !other.conflict && other.message === "no such request");
  const fallback = await advanceRemote(fake({ "C02/advanceWizard": () => ({ status: "COMPLETE", value: { ...server, stage: "PLAN", workspaceVersion: 3 }, diagnostics: [] }), "C01/openFeatureWorkspace": () => ({ status: "COMPLETE", diagnostics: ["NOT_MODIFIED"] }) }), ws, "PLAN");
  assert.ok(fallback.ok && fallback.value.stage === "PLAN" && fallback.value.workspaceVersion === 3, "if the follow-up read is unchanged the advance result is used");
});
