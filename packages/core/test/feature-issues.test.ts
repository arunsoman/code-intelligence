import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeCandidate } from "../src/feature/candidate.ts";
import { GhIssueForge, type IssueForge } from "../src/feature/issue-forge.ts";
import { DEFAULT_PROJECTION_POLICY, MILESTONES, buildProjection, guardOutgoing, markerFor, projectionPolicyHash, trailState, type ProjectionPolicy } from "../src/feature/issue-trail.ts";
import type { GhRunner } from "../src/gh-forge.ts";
import type { FeatureRecord } from "../src/feature/types.ts";
import { boot, createEdit, none } from "./feature-boot.ts";
import { lifecycleRecord } from "./feature-issues-fixtures.ts";

const PRIVATE = "acme/private-app", PUBLIC = "acme/public-lib";
const FAKE_NOW = Date.parse("2026-10-05T12:00:00Z");

/** A scripted GitHub: repos, labels, issues, comments, and failures injected per endpoint. */
class FakeGitHub {
  repos = new Map<string, { private: boolean; labels: string[]; issues: any[]; comments: Map<number, any[]> }>(); nextId = 1000; calls: string[] = [];
  failures: { match: RegExp; stderr: string; times: number; afterEffect: boolean }[] = [];
  constructor() { this.addRepo(PRIVATE, true, ["enhancement", "bug"]); this.addRepo(PUBLIC, false, ["feature", "cie", "docs"]); }
  addRepo(name: string, priv: boolean, labels: string[]) { this.repos.set(name, { private: priv, labels, issues: [], comments: new Map() }); }
  failNext(match: RegExp, stderr: string, o: { times?: number; afterEffect?: boolean } = {}) { this.failures.push({ match, stderr, times: o.times ?? 1, afterEffect: o.afterEffect ?? false }); }
  issue(repo: string, n: number) { return this.repos.get(repo)!.issues.find((i) => i.number === n); }
  allText(): string { return JSON.stringify([...this.repos.values()].map((r) => [r.issues, [...r.comments.values()]])); }
  run: GhRunner = (args) => {
    let method = "GET"; const fields: Record<string, any> = {}; let endpoint = "";
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-X") method = args[++i]!;
      else if (args[i] === "-f") { const [k, ...v] = args[++i]!.split("="); const val = v.join("="); if (k!.endsWith("[]")) (fields[k!.slice(0, -2)] ??= []).push(val); else fields[k!] = val; }
      else endpoint = args[i]!;
    }
    const key = `${method} ${endpoint}`; this.calls.push(key);
    const f = this.failures.find((x) => x.match.test(key) && x.times > 0);
    const out = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
    const m = /^repos\/([^/]+\/[^/]+)(?:\/(issues|labels)(?:\/(\d+)(?:\/(comments))?)?)?$/.exec(endpoint);
    if (!m) return { status: 1, stdout: "", stderr: "404 not found" };
    const repo = this.repos.get(m[1]!); if (!repo) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    if (f && !f.afterEffect) { f.times--; return { status: 1, stdout: "", stderr: f.stderr }; }
    let result: any;
    if (!m[2]) result = { private: repo.private };
    else if (m[2] === "labels") result = repo.labels.map((name) => ({ name }));
    else if (!m[3]) {
      if (method === "POST") { const n = repo.issues.length + 1; result = { number: n, node_id: `I_${this.nextId++}`, title: fields.title, body: fields.body, state: "open", locked: false, updated_at: "t", labels: fields.labels ?? [] }; repo.issues.push(result); }
      else result = [...repo.issues].reverse();
    } else {
      const issue = repo.issues.find((i) => i.number === Number(m[3])); if (!issue) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      if (!m[4]) { if (method === "PATCH") { if (fields.body !== undefined) issue.body = fields.body; if (fields.state) issue.state = fields.state; if (fields.state_reason) issue.state_reason = fields.state_reason; } result = issue; }
      else if (method === "POST") { const c = { id: this.nextId++, body: fields.body }; (repo.comments.get(issue.number) ?? repo.comments.set(issue.number, []).get(issue.number)!).push(c); result = c; }
      else result = repo.comments.get(issue.number) ?? [];
    }
    if (f && f.afterEffect) { f.times--; return { status: 1, stdout: "", stderr: f.stderr }; }
    return out(result);
  };
}

const setup = async (o: { text?: string; mandatory?: boolean; clock?: { t: number }; policy?: ProjectionPolicy } = {}) => {
  const gh = new FakeGitHub(); const clock = o.clock ?? { t: FAKE_NOW };
  const b = await boot({ text: o.text, prepare: o.mandatory ? (repo) => { mkdirSync(join(repo, ".cie"), { recursive: true }); writeFileSync(join(repo, ".cie", "feature.json"), JSON.stringify({ tracking: { BUILD_PREVIEW: "MANDATORY" } })); } : undefined,
    handlers: { issues: { forge: new GhIssueForge({ run: gh.run }), now: () => clock.t, policy: o.policy } } });
  const call = (key: string, body: unknown, who = "arun", idem = `i-${Math.random()}`) => b.h[key]!(b.as(who, idem), body);
  const preview = async (repositoryId = PRIVATE) => { const r = await call("C30/previewIssueProjection", { requestId: b.rid, repositoryId }); assert.ok(r.ok, JSON.stringify(r)); return r.value as { title: string; body: string; labels: string[]; visibility: string; projectionHash: string; projectionPolicyHash: string }; };
  const bind = async (repositoryId = PRIVATE, over: Record<string, unknown> = {}) => { const p = await preview(repositoryId); return call("C30/bindRequestIssue", { requestId: b.rid, repositoryId, projectionHash: p.projectionHash, expectedVersion: b.fs.getRequest(b.rid)!.workspace.workspaceVersion, ...over }); };
  const sync = (through = 1000, over: Record<string, unknown> = {}) => call("C30/syncRequestMilestones", { requestId: b.rid, throughSequence: through, projectionPolicyHash: projectionPolicyHash(o.policy), ...over });
  return { ...b, gh, clock, call, preview, bind, sync, rec: () => b.fs.getRequest(b.rid)! };
};
const must = <T,>(r: { ok: boolean; value?: T; error?: any }): T => { assert.ok(r.ok, JSON.stringify(r)); return r.value as T; };

test("the gh-backed forge speaks the issue API, validates the repository name and classifies GitHub failures", async () => {
  const gh = new FakeGitHub(); const forge: IssueForge = new GhIssueForge({ run: gh.run });
  assert.deepEqual(await forge.repoInfo(PRIVATE), { private: true }); assert.deepEqual(await forge.labels(PUBLIC), ["feature", "cie", "docs"]);
  const made = await forge.createIssue(PUBLIC, { title: "t", body: `${markerFor("req:1")}\nbody`, labels: ["feature", "cie"] }); assert.deepEqual([made.number, made.state, made.locked], [1, "open", false]); assert.deepEqual(gh.issue(PUBLIC, 1).labels, ["feature", "cie"]);
  assert.equal((await forge.findIssue(PUBLIC, markerFor("req:1")))!.number, 1); assert.equal(await forge.findIssue(PUBLIC, markerFor("req:2")), null);
  assert.equal((await forge.getIssue(PUBLIC, 1)).title, "t"); const upd = await forge.updateIssue(PUBLIC, 1, { body: "new", state: "closed", stateReason: "not_planned" }); assert.deepEqual([upd.body, upd.state], ["new", "closed"]); assert.equal(gh.issue(PUBLIC, 1).state_reason, "not_planned");
  const c = await forge.createComment(PUBLIC, 1, "hello"); assert.equal((await forge.recentComments(PUBLIC, 1))[0]!.id, c.id);
  for (const bad of ["nope", "a/b/c", "../x/y", "a b/c"]) await assert.rejects(forge.repoInfo(bad), (e: any) => e.state === "NOT_FOUND", bad);
  await assert.rejects(forge.repoInfo("acme/missing"), (e: any) => e.state === "NOT_FOUND");
  for (const [stderr, state] of [["API rate limit exceeded", "RATE_LIMITED"], ["HTTP 401: Bad credentials", "EXPIRED"], ["HTTP 403 Forbidden", "REFUSED"], ["connection reset", "UNREACHABLE"]] as const) { gh.failNext(/repos\/acme\/private-app$/, stderr); await assert.rejects(forge.repoInfo(PRIVATE), (e: any) => e.state === state, stderr); }
  const noMerge = [...(forge.constructor.prototype ? Object.getOwnPropertyNames(forge.constructor.prototype) : [])]; assert.ok(!noMerge.some((n) => /merge|approve|delete|label.*(create|edit)/i.test(n)), "the forge has no merge, approve, delete or label-writing method");
});

test("AT-43/PF-054 the projection is an allowlist: ids, enums and counts only; a private destination adds the redacted preview, a public or unknown one gets nothing of the prompt", async () => {
  const w = await setup({ text: "Add CSV export for finance. Contact bob@corp.example, password: hunter22hunter" });
  try {
    const rec = w.rec(); const priv = buildProjection(w.fs, rec, { visibility: "PRIVATE", availableLabels: ["enhancement", "bug"] }), pub = buildProjection(w.fs, rec, { visibility: "PUBLIC_OR_UNKNOWN", availableLabels: ["enhancement"] });
    assert.match(priv.title, /^\[CIE\] Add CSV export for finance\. Contact \[email\]/); assert.ok(priv.body.includes("> Add CSV export")); assert.ok(!/bob@corp|hunter22/.test(priv.title + priv.body), "the preview is redacted");
    assert.match(pub.title, /^\[CIE\] feature request [0-9a-f]{12}$/); assert.ok(!pub.body.includes("> ") && !/CSV|finance/.test(pub.title + pub.body), "a public destination carries nothing of the prompt");
    for (const p of [priv, pub]) { assert.ok(p.body.startsWith(markerFor(rec.requestId))); assert.ok(p.body.includes("<!-- cie:begin -->") && p.body.endsWith("<!-- cie:end -->")); assert.match(p.body, /- Mode: BUILD_PREVIEW\n- State: CONTRACTING\n- Tier: not yet classified\n- Contract version: 0\n- Requirements: 0 · Acceptance criteria: 0 · Open questions: 0\n- Candidate: none yet/); assert.match(p.body, /does not say the work is verified/); assert.ok(!/verified\b(?! \.)/.test(p.body.replace("does not say the work is verified", ""))); }
    assert.deepEqual(priv.labels, ["enhancement"]); assert.deepEqual(buildProjection(w.fs, rec, { visibility: "PRIVATE", availableLabels: ["docs", "bug"] }).labels, [], "labels the repository does not have are not invented");
    assert.deepEqual(buildProjection(w.fs, rec, { visibility: "PRIVATE", availableLabels: ["cie", "feature", "enhancement", "x"] }).labels, ["enhancement", "feature", "cie"], "labels follow the policy's order and are capped at three");
    const same = buildProjection(w.fs, rec, { visibility: "PRIVATE", availableLabels: ["enhancement", "bug"] }); assert.equal(same.hash, priv.hash, "deterministic");
    const richer: FeatureRecord = { ...rec, state: "IMPLEMENTING", tier: "T2", contractVersion: 3, contract: { ...rec.contract!, requirements: [{ id: "r1", text: "SECRET MODEL TEXT: drop table users", source: rec.contract!.requirements[0]?.source ?? { artifactId: "p", version: "1", locator: "prompt", contentHash: "h" }, origin: "USER", type: "FUNCTIONAL", actorIds: [], conditions: [], dependsOn: [], acceptanceIds: [], status: "ACTIVE" }] }, blockers: [{ id: "q1", kind: "QUESTION", requirementIds: [], text: "FREE TEXT QUESTION" }] };
    const r = buildProjection(w.fs, richer, { visibility: "PRIVATE", availableLabels: [] }); assert.notEqual(r.hash, priv.hash); assert.match(r.body, /State: IMPLEMENTING\n- Tier: T2\n- Contract version: 3\n- Requirements: 1 .* Open questions: 1/);
    assert.ok(!/SECRET MODEL TEXT|FREE TEXT QUESTION/.test(r.title + r.body), "requirement and question text never leave: only counts");
    assert.equal(projectionPolicyHash(), projectionPolicyHash(DEFAULT_PROJECTION_POLICY)); assert.notEqual(projectionPolicyHash(), projectionPolicyHash({ ...DEFAULT_PROJECTION_POLICY, minIntervalMs: 1 }));
    assert.equal(projectionPolicyHash({ ...DEFAULT_PROJECTION_POLICY, milestones: [...MILESTONES].reverse() }), projectionPolicyHash(), "list order is not identity");
  } finally { w.close(); }
});

test("AT-35/44 the leak guard fails closed: a secret, personal data or a stretch of the private prompt is refused, never sent altered", async () => {
  const w = await setup({ text: "Please build the settlement export for finance. " + "Details beyond the preview: ".padEnd(60, "x") + " the quarterly settlement export so finance can reconcile ledgers across regions without manual spreadsheets, and the vendor audit trail" });
  try {
    const rec = w.rec();
    for (const leak of ["token ghp_" + "a".repeat(36), "key AKIA" + "ABCDEFGHIJKLMNOP", "mail bob@corp.example", "-----BEGIN RSA PRIVATE KEY-----"]) assert.throws(() => guardOutgoing(rec, `status ${leak}`, "PRIVATE"), (e: any) => e.code === "FORBIDDEN" && /looks like a secret or personal data/.test(e.message), leak);
    const fragment = "can reconcile ledgers across regions without manual";
    assert.throws(() => guardOutgoing(rec, `see: ${fragment}`, "PUBLIC_OR_UNKNOWN"), (e: any) => e.code === "FORBIDDEN" && /part of the private prompt/.test(e.message));
    assert.throws(() => guardOutgoing(rec, `see: ${fragment}`, "PRIVATE"), (e: any) => e.code === "FORBIDDEN", "a private destination still gets only the redacted preview, not arbitrary stretches");
    assert.doesNotThrow(() => guardOutgoing(rec, `> ${rec.promptRef.redactedPreview}`, "PRIVATE"), "the preview itself is allowed for a private destination");
    assert.doesNotThrow(() => guardOutgoing(rec, "State: CONTRACTING, Mode: BUILD_PREVIEW", "PUBLIC_OR_UNKNOWN"));
    assert.equal(guardOutgoing({ ...rec, promptRef: { ...rec.promptRef, text: undefined } }, "anything neutral", "PRIVATE"), "anything neutral");
  } finally { w.close(); }
});

test("PF-054/AT-44 end to end: a seeded secret and personal data in the prompt never reach GitHub, for a private or a public destination, in the issue, its updates or its comments", async () => {
  const secret = "ghp_" + "Z9".repeat(18), email = "ceo.private@corp.example", phrase = "acquire Initech before the Q3 board meeting in strict secrecy";
  const w = await setup({ text: `Add export. ${phrase}. token=${secret} contact ${email}` });
  try {
    for (const repo of [PRIVATE, PUBLIC]) {
      const rec = w.rec(); if (rec.issue.number) break;
      must(await w.bind(repo)); must(await w.sync()); await w.call("C02/resumeRequest", { requestId: w.rid });
      w.clock.t += 20_000; must(await w.sync());
      const text = w.gh.allText();
      for (const bad of [secret, email]) assert.ok(!text.includes(bad), `${bad} leaked to ${repo}`);
      if (repo === PUBLIC) for (const bad of ["Initech", "strict secrecy", "board meeting", "Add export"]) assert.ok(!text.includes(bad), `${bad} leaked to the public destination`);
      else assert.ok(text.includes("Add export"), "a private destination gets the redacted preview");
      assert.ok(text.includes("cie-request:"), "the trail itself was written");
      w.fs.updateRequest(w.rid, w.rec().version, { ...w.rec(), issue: { repository: "", syncState: "UNBOUND", lastSyncedSequence: 0, projectionRevision: 0 } }); // rebind to the other destination
      w.gh.repos.get(PRIVATE)!.issues.length = 0; w.gh.repos.get(PUBLIC)!.issues.length = 0;
    }
    assert.ok(w.gh.calls.every((c) => !/\/merge|\/reviews/.test(c)), "no merge or review endpoint was ever called");
  } finally { w.close(); }
});

test("PF-054 binding: preview then bind creates one issue with a marker and only labels the repository has; the receipt and the request say so; replay changes nothing", async () => {
  const w = await setup();
  try {
    const p = await w.preview(); assert.equal(p.visibility, "PRIVATE"); assert.deepEqual(p.labels, ["enhancement"]); assert.equal(p.projectionPolicyHash, projectionPolicyHash());
    const r = must<any>(await w.bind()); assert.equal(r.created, true); assert.deepEqual([r.issue.repository, r.issue.number, r.issue.createdByCie, r.issue.visibility], [PRIVATE, 1, true, "PRIVATE"]); assert.deepEqual(r.labelsApplied, ["enhancement"]);
    const remote = w.gh.issue(PRIVATE, 1); assert.ok(remote.body.startsWith(markerFor(w.rid))); assert.deepEqual(remote.labels, ["enhancement"]); assert.equal(w.gh.repos.get(PRIVATE)!.issues.length, 1);
    assert.equal(w.rec().workspace.issueRef, `${PRIVATE}#1`); assert.equal(w.rec().issue.syncState, "UNSYNCED", "milestones are still waiting in the outbox, so the trail is not claimed as synced");
    assert.ok(w.fs.listEvents(w.rid).some((e) => e.type === "StateChanged" && /issue bound: acme\/private-app#1 \(PRIVATE; created\)/.test(e.rationale)));
    const again = must<any>(await w.call("C30/bindRequestIssue", { requestId: w.rid, repositoryId: PRIVATE, projectionHash: "stale-is-fine-for-a-replay", expectedVersion: 0, idempotencyKey: "x" })); assert.equal(again.created, false); assert.match(again.warnings[0], /already bound/); assert.equal(w.gh.repos.get(PRIVATE)!.issues.length, 1);
    const other = await w.call("C30/bindRequestIssue", { requestId: w.rid, repositoryId: PUBLIC, projectionHash: "x", expectedVersion: 0 }); assert.ok(!other.ok && other.error.code === "FORBIDDEN" && /already bound to acme\/private-app#1; a binding is not moved/.test(other.error.message));
  } finally { w.close(); }
});

test("binding input and conflicts: stale projection, stale workspace version, bad repository, bad issue id, missing key and a terminal request are all typed refusals that write nothing", async () => {
  const w = await setup();
  try {
    const p = await w.preview(); const v = w.rec().workspace.workspaceVersion;
    const refuse = async (over: Record<string, unknown>, code: string, re: RegExp) => { const r = await w.call("C30/bindRequestIssue", { requestId: w.rid, repositoryId: PRIVATE, projectionHash: p.projectionHash, expectedVersion: v, ...over }); assert.ok(!r.ok && r.error.code === code && re.test(r.error.message), JSON.stringify(over) + JSON.stringify(r)); };
    await refuse({ projectionHash: "other" }, "STALE_REVISION", /what would be sent has changed/); await refuse({ expectedVersion: v + 5 }, "VERSION_CONFLICT", /the request changed/); await refuse({ repositoryId: "nope" }, "INVALID_SCHEMA", /owner\/name/);
    await refuse({ existingIssueId: "abc" }, "INVALID_SCHEMA", /existingIssueId must be/); await refuse({ existingIssueId: "other/repo#3" }, "INVALID_SCHEMA", /different repository/); await refuse({ repositoryId: "acme/missing" }, "NOT_FOUND", /Not Found|not found/i);
    const noKey = await w.h["C30/bindRequestIssue"]!(w.as("arun", ""), { requestId: w.rid, repositoryId: PRIVATE, projectionHash: p.projectionHash, expectedVersion: v }); assert.ok(!noKey.ok);
    assert.equal(w.gh.repos.get(PRIVATE)!.issues.length, 0, "nothing was created by any refusal");
    const rec = w.rec(); w.fs.updateRequest(w.rid, rec.version, { ...rec, state: "CANCELLED" }); await refuse({}, "VERSION_CONFLICT", /CANCELLED/);
    for (const key of ["C30/previewIssueProjection", "C30/bindRequestIssue", "C30/syncRequestMilestones"]) { const r = await w.call(key, { requestId: w.rid, repositoryId: PRIVATE, projectionHash: "x", expectedVersion: 0, throughSequence: 1, projectionPolicyHash: "x" }, "mallory"); assert.ok(!r.ok && r.error.code === "NOT_FOUND", key); }
  } finally { w.close(); }
});

test("PF-056 adopting an existing issue: its text is never edited, progress is a marked comment, and locked, pull-request and missing issues are refused", async () => {
  const w = await setup();
  try {
    const human = await new GhIssueForge({ run: w.gh.run }).createIssue(PRIVATE, { title: "Export is slow", body: "Written by a person.", labels: [] });
    const r = must<any>(await w.bind(PRIVATE, { existingIssueId: `#${human.number}` })); assert.deepEqual([r.created, r.issue.createdByCie, r.issue.number], [false, false, human.number]); assert.deepEqual(r.labelsApplied, []);
    assert.equal(w.gh.issue(PRIVATE, human.number).body, "Written by a person.", "a person's issue text is left alone"); const comments = w.gh.repos.get(PRIVATE)!.comments.get(human.number)!; assert.equal(comments.length, 1); assert.ok(comments[0].body.includes(markerFor(w.rid)) && /Tracking started by CIE/.test(comments[0].body));
    // refusals on a fresh request: locked, pull request, closed (warning), missing
    w.fs.updateRequest(w.rid, w.rec().version, { ...w.rec(), issue: { repository: "", syncState: "UNBOUND", lastSyncedSequence: 0, projectionRevision: 0 } });
    w.gh.issue(PRIVATE, human.number).locked = true; const locked = await w.bind(PRIVATE, { existingIssueId: human.number }); assert.ok(!locked.ok && locked.error.code === "FORBIDDEN" && /locked/.test(locked.error.message));
    const pr = await new GhIssueForge({ run: w.gh.run }).createIssue(PRIVATE, { title: "pr", body: "", labels: [] }); w.gh.issue(PRIVATE, pr.number).pull_request = {}; const notIssue = await w.bind(PRIVATE, { existingIssueId: pr.number }); assert.ok(!notIssue.ok && /pull request, not an issue/.test(notIssue.error.message));
    const missing = await w.bind(PRIVATE, { existingIssueId: 999 }); assert.ok(!missing.ok && missing.error.code === "NOT_FOUND");
    const closed = await new GhIssueForge({ run: w.gh.run }).createIssue(PRIVATE, { title: "old", body: "", labels: [] }); w.gh.issue(PRIVATE, closed.number).state = "closed"; const warn = must<any>(await w.bind(PRIVATE, { existingIssueId: closed.number })); assert.match(warn.warnings[0], /is closed; progress will still be posted as comments/);
  } finally { w.close(); }
});

test("AT-48 reconcile after a timeout: a create that landed but reported failure is adopted by marker, never duplicated; failures leave the request tracking-blocked, not claimed", async () => {
  const w = await setup({ mandatory: true });
  try {
    assert.equal(w.rec().issue.syncState, "TRACKING_BLOCKED");
    w.gh.failNext(/^POST repos\/acme\/private-app\/issues$/, "connection reset by peer", { afterEffect: true });
    const first = await w.bind(); assert.ok(!first.ok && first.error.code === "PROVIDER_UNAVAILABLE", JSON.stringify(first)); assert.equal(w.gh.repos.get(PRIVATE)!.issues.length, 1, "the write landed even though the call reported failure");
    assert.equal(w.rec().issue.syncState, "TRACKING_BLOCKED", "an unconfirmed binding is not a trail"); assert.equal(w.rec().issue.number, undefined);
    assert.ok(w.fs.listEvents(w.rid).some((e) => e.result === "BLOCKED" && /issue binding failed: .*tracking is not claimed/.test(e.rationale)));
    const second = must<any>(await w.bind()); assert.equal(second.created, false); assert.match(second.warnings[0], /already existed and was adopted/); assert.equal(w.gh.repos.get(PRIVATE)!.issues.length, 1, "still exactly one issue"); assert.equal(second.issue.createdByCie, true);
    for (const [stderr, re] of [["HTTP 401: Bad credentials", /credential is missing or expired/], ["API rate limit exceeded", /rate limit/], ["HTTP 403 Forbidden", /refused/]] as const) {
      const x = await setup(); x.gh.failNext(/^GET repos\/acme\/private-app$/, stderr); const r = await x.call("C30/previewIssueProjection", { requestId: x.rid, repositoryId: PRIVATE }); assert.ok(!r.ok && re.test(r.error.message), stderr); x.close(); }
  } finally { w.close(); }
});

test("S13 mandatory tracking blocks building until an issue is bound; binding unblocks it (a failed or missing issue never counts)", async () => {
  const w = await setup({ mandatory: true });
  try {
    const edits = [createEdit("src/export/csv.ts", "export {};\n")]; const deps = { fs: w.fs, store: w.svc.store, auth: none };
    assert.throws(() => materializeCandidate(deps, "arun", { requestId: w.rid, snapshot: w.rec().source, edits, idempotencyKey: "m1" }), (e: any) => e.code === "BLOCKED" && /issue tracking is mandatory/.test(e.message));
    must(await w.bind());
    assert.equal(materializeCandidate(deps, "arun", { requestId: w.rid, snapshot: w.rec().source, edits, idempotencyKey: "m2" }).candidate.status, "MATERIALIZED");
  } finally { w.close(); }
});

test("PF-080/P7/P8 milestone sync: one coalesced comment of milestone events only, no free text, outbox marked SENT or SKIPPED, state SYNCED only when nothing waits", async () => {
  const w = await setup();
  try {
    must(await w.bind()); w.clock.t += 20_000;
    const before = w.fs.listEvents(w.rid); const milestone = before.filter((e) => MILESTONES.includes(e.type)).length; assert.ok(milestone >= 1 && before.some((e) => !MILESTONES.includes(e.type)), "the request has both kinds of event");
    w.fs.appendEvent({ schemaVersion: 1, eventId: "evt:secretish", requestId: w.rid, type: "DecisionRecorded", actor: "arun", producer: "C02", requirementIds: ["r1"], decisionIds: ["decision:abc"], result: "OK", rationale: "FREE TEXT RATIONALE with password: topsecret123", at: "2026-10-05T12:00:05Z" });
    const out = must<any>(await w.sync()); assert.equal(out.sent, milestone + 1); assert.equal(out.skipped, before.length - milestone); assert.equal(out.state, "SYNCED"); assert.equal(out.remoteIds.length, 1, "one comment, not one per event");
    const comments = w.gh.repos.get(PRIVATE)!.comments.get(1)!; assert.equal(comments.length, 1); const text = comments[0].body;
    assert.ok(text.includes("**FeatureSubmitted**") && text.includes("**DecisionRecorded** — OK (2026-10-05T12:00:05Z) [r1, decision:abc]")); assert.ok(!/StateChanged|WizardAdvanced|FREE TEXT|topsecret/.test(text), "non-milestones and rationale never leave");
    assert.match(text, new RegExp(`<!-- cie-sync:${w.rid}:\\d+-\\d+ -->$`));
    const evs = w.fs.listEvents(w.rid), lastMilestone = Math.max(...evs.filter((e) => MILESTONES.includes(e.type)).map((e) => e.sequence));
    assert.ok(evs.filter((e) => MILESTONES.includes(e.type)).every((e) => e.sync.state === "SENT"), "every milestone was posted");
    assert.ok(evs.filter((e) => !MILESTONES.includes(e.type) && e.sequence < lastMilestone).every((e) => e.sync.state === "SKIPPED"), "earlier non-milestones were skipped");
    assert.ok(evs.filter((e) => e.sequence > lastMilestone).every((e) => !MILESTONES.includes(e.type)), "what is still waiting is only the bookkeeping the sync itself wrote");
    assert.ok(w.fs.listEvents(w.rid).filter((e) => e.sync.state === "SENT").every((e) => /^comment:\d+$/.test(e.sync.remoteId!) && e.sync.attempts === 1));
    const rec = w.rec(); assert.equal(rec.issue.syncState, "SYNCED"); assert.ok(rec.issue.lastSyncedSequence >= before.length + 1 - 1);
    assert.equal((must<any>(await w.sync())).sent, 0, "nothing new, nothing sent"); assert.equal(w.gh.repos.get(PRIVATE)!.comments.get(1)!.length, 1);
    assert.equal(trailState(w.fs, w.rec()), "SYNCED");
    w.fs.appendEvent({ schemaVersion: 1, eventId: "evt:new", requestId: w.rid, type: "CandidateCreated", actor: "arun", producer: "C28", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: "t" }); assert.equal(trailState(w.fs, w.rec()), "UNSYNCED", "a new milestone makes the trail unsynced again until it is posted");
  } finally { w.close(); }
});

test("P7 pacing: at most one comment per interval, events coalesce into the next one, and a long backlog is split by the per-comment cap", async () => {
  const policy: ProjectionPolicy = { ...DEFAULT_PROJECTION_POLICY, maxEventsPerComment: 3 }; const w = await setup({ policy });
  try {
    must(await w.bind()); const ev = (n: number) => w.fs.appendEvent({ schemaVersion: 1, eventId: `evt:m${n}`, requestId: w.rid, type: "CandidateCreated", actor: "arun", producer: "C28", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: `t${n}` });
    w.clock.t += 11_000; for (let n = 0; n < 7; n++) ev(n);
    const a = must<any>(await w.sync()); assert.equal(a.sent, 3); assert.equal(a.state, "UNSYNCED", "milestones are still waiting");
    const b = must<any>(await w.sync()); assert.equal(b.sent, 0); assert.ok(Date.parse(b.deferredUntil) > w.clock.t && /at most one comment per 10 s/.test(b.warnings[0]), JSON.stringify(b)); assert.equal(w.gh.repos.get(PRIVATE)!.comments.get(1)!.length, 1);
    w.clock.t += 10_001; const c = must<any>(await w.sync()); assert.equal(c.sent, 3); w.clock.t += 10_001; const d = must<any>(await w.sync()); assert.ok(d.sent >= 1 && d.state === "SYNCED", JSON.stringify(d));
    assert.equal(w.gh.repos.get(PRIVATE)!.comments.get(1)!.length, 3, "three comments for the whole backlog, ten seconds apart");
    const bodies = w.gh.repos.get(PRIVATE)!.comments.get(1)!.map((x: any) => x.body); assert.equal(new Set(bodies.map((x: string) => /cie-sync:[^ ]+/.exec(x)![0])).size, 3, "each comment names its own event range");
  } finally { w.close(); }
});

test("AT-47 outbox recovery: a comment that landed before a timeout is adopted, a rate limit backs off with a doubling delay, and a lost credential is a typed failure with the events kept", async () => {
  const w = await setup();
  try {
    must(await w.bind()); w.clock.t += 20_000;
    w.gh.failNext(/^POST repos\/acme\/private-app\/issues\/1\/comments$/, "connection reset", { afterEffect: true });
    const lost = await w.sync(); assert.ok(!lost.ok && lost.error.code === "PROVIDER_UNAVAILABLE"); assert.equal(w.gh.repos.get(PRIVATE)!.comments.get(1)!.length, 1, "the comment landed");
    assert.ok(w.fs.listEvents(w.rid).some((e) => e.sync.state === "FAILED"), "the events stay in the outbox as FAILED"); assert.equal(w.rec().issue.syncState, "UNSYNCED"); assert.ok(w.rec().issue.retryAfter);
    const wait = must<any>(await w.sync()); assert.equal(wait.sent, 0); assert.ok(wait.deferredUntil && /slow down/.test(wait.warnings[0]), "inside the backoff window nothing is attempted");
    w.clock.t = Date.parse(w.rec().issue.retryAfter!) + 1; const back = must<any>(await w.sync()); assert.ok(back.sent > 0 && back.state === "SYNCED"); assert.equal(w.gh.repos.get(PRIVATE)!.comments.get(1)!.length, 1, "the earlier comment was adopted, not duplicated");
    assert.ok(w.fs.listEvents(w.rid).filter((e) => e.sync.state === "SENT").every((e) => e.sync.attempts === 2), "the retry is counted"); assert.equal(w.rec().issue.failures, 0); assert.equal(w.rec().issue.retryAfter, undefined);
    // rate limiting: doubling backoff, then recovery
    const add = (n: number) => w.fs.appendEvent({ schemaVersion: 1, eventId: `evt:r${n}`, requestId: w.rid, type: "CandidateCreated", actor: "arun", producer: "C28", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: `t${n}` });
    add(1); w.clock.t += 20_000; w.gh.failNext(/comments$/, "API rate limit exceeded", { times: 2 });
    const r1 = must<any>(await w.sync()); const d1 = Date.parse(r1.deferredUntil) - w.clock.t; assert.equal(d1, 60_000); assert.match(r1.warnings[0], /GitHub rate limit/);
    w.clock.t += 60_001; const r2 = must<any>(await w.sync()); assert.equal(Date.parse(r2.deferredUntil) - w.clock.t, 120_000, "the delay doubles");
    w.clock.t += 120_001; const r3 = must<any>(await w.sync()); assert.equal(r3.sent, 1); assert.equal(r3.state, "SYNCED");
    add(2); w.clock.t += 20_000; w.gh.failNext(/comments$/, "HTTP 401: Bad credentials"); const expired = await w.sync(); assert.ok(!expired.ok && expired.error.code === "PROVIDER_UNAVAILABLE" && /credential is missing or expired/.test(expired.error.message)); assert.equal(w.rec().issue.syncState, "UNSYNCED");
    const stalePolicy = await w.sync(1000, { projectionPolicyHash: "x" }); assert.ok(!stalePolicy.ok && stalePolicy.error.code === "STALE_REVISION");
    const badSeq = await w.sync(-1); assert.ok(!badSeq.ok && badSeq.error.code === "INVALID_SCHEMA");
  } finally { w.close(); }
});

test("sync before binding says so, and throughSequence bounds what is sent", async () => {
  const w = await setup();
  try {
    const none_ = await w.sync(); assert.ok(!none_.ok && none_.error.code === "FORBIDDEN" && /no issue is bound/.test(none_.error.message));
    must(await w.bind()); w.clock.t += 20_000; const first = w.fs.listEvents(w.rid)[0]!;
    const partial = must<any>(await w.sync(first.sequence)); assert.equal(partial.sent, 1); assert.equal(partial.throughSequence, first.sequence); assert.ok(w.fs.listEvents(w.rid).some((e) => e.sequence > first.sequence && e.sync.state === "PENDING"), "later events were not touched");
  } finally { w.close(); }
});

test("AT-46 human edits: when a person changes the managed block of a CIE-opened issue it is left alone, the trail is DIVERGED, and progress continues as comments", async () => {
  const w = await setup();
  try {
    must(await w.bind()); const issue = w.gh.issue(PRIVATE, 1); issue.body = issue.body.replace("- Mode: BUILD_PREVIEW", "- Mode: SOMETHING A PERSON WROTE"); const edited = issue.body;
    w.clock.t += 20_000; const out = must<any>(await w.sync()); assert.ok(out.sent > 0); assert.match(out.warnings[0], /managed block was edited by a person/);
    assert.equal(w.rec().issue.syncState, "DIVERGED"); assert.equal(w.gh.issue(PRIVATE, 1).body, edited, "the person's edit is not overwritten");
    assert.match(w.gh.repos.get(PRIVATE)!.comments.get(1)![0].body, /edited outside CIE, so CIE no longer rewrites it/); assert.equal(trailState(w.fs, w.rec()), "DIVERGED");
    w.fs.appendEvent({ schemaVersion: 1, eventId: "evt:later", requestId: w.rid, type: "CandidateCreated", actor: "arun", producer: "C28", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: "t" });
    w.clock.t += 20_000; const next = must<any>(await w.sync()); assert.equal(next.sent, 1); assert.equal(next.state, "DIVERGED", "it stays diverged until a person clears it"); assert.equal(w.gh.issue(PRIVATE, 1).body, edited);
    // a CIE-opened issue whose block was simply removed is also divergence
    const w2 = await setup(); must(await w2.bind()); w2.gh.issue(PRIVATE, 1).body = "I replaced everything."; w2.clock.t += 20_000; must(await w2.sync()); assert.equal(w2.rec().issue.syncState, "DIVERGED"); w2.close();
  } finally { w.close(); }
});

test("PF-054 the managed block follows the request: an untouched CIE issue's body is updated, and the revision moves only when the text does", async () => {
  const w = await setup();
  try {
    const bound = must<any>(await w.bind()); const rev0 = bound.issue.projectionRevision; w.clock.t += 20_000; must(await w.sync()); const after0 = w.rec().issue.projectionRevision;
    assert.match(w.gh.issue(PRIVATE, 1).body, /State: CONTRACTING/);
    const rec = w.rec(); w.fs.updateRequest(w.rid, rec.version, { ...rec, state: "IMPLEMENTING", tier: "T1" });
    w.fs.appendEvent({ schemaVersion: 1, eventId: "evt:cc", requestId: w.rid, type: "ContractVersionCreated", actor: "arun", producer: "C15", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: "t" });
    w.clock.t += 20_000; must(await w.sync()); assert.match(w.gh.issue(PRIVATE, 1).body, /State: IMPLEMENTING\n- Tier: T1/); assert.ok(w.rec().issue.projectionRevision > after0); assert.ok(after0 >= rev0);
    assert.ok(w.gh.issue(PRIVATE, 1).body.startsWith(markerFor(w.rid)), "the marker survives every rewrite");
    const rev1 = w.rec().issue.projectionRevision; w.fs.appendEvent({ schemaVersion: 1, eventId: "evt:cc2", requestId: w.rid, type: "ValidationCompleted", actor: "arun", producer: "C27", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: "t" });
    w.clock.t += 20_000; must(await w.sync()); assert.equal(w.rec().issue.projectionRevision, rev1, "an event that does not change the block does not rewrite it");
  } finally { w.close(); }
});

test("closure: CIE closes only an issue it opened, and only for a cancelled request; a person's issue and a published request stay open", async () => {
  const cancel = async (w: Awaited<ReturnType<typeof setup>>) => { const cancelled = must<any>(await w.call("C07/cancelFeature", { requestId: w.rid, reason: "no longer needed" })); assert.ok(cancelled); w.clock.t += 20_000; return must<any>(await w.sync()); };
  const mine = await setup();
  try { must(await mine.bind()); const out = await cancel(mine); assert.equal(mine.gh.issue(PRIVATE, 1).state, "closed"); assert.equal(mine.gh.issue(PRIVATE, 1).state_reason, "not_planned"); assert.ok(out.warnings.some((x: string) => /closed as not planned/.test(x))); assert.match(mine.gh.repos.get(PRIVATE)!.comments.get(1)!.map((c: any) => c.body).join("\n"), /\*\*Cancelled\*\*/); } finally { mine.close(); }
  const theirs = await setup();
  try { const human = await new GhIssueForge({ run: theirs.gh.run }).createIssue(PRIVATE, { title: "Mine", body: "mine", labels: [] }); must(await theirs.bind(PRIVATE, { existingIssueId: human.number })); await cancel(theirs); assert.equal(theirs.gh.issue(PRIVATE, human.number).state, "open", "a person's issue is never closed by CIE"); } finally { theirs.close(); }
  const published = await setup();
  try { must(await published.bind()); const rec = published.rec(); published.fs.updateRequest(published.rid, rec.version, { ...rec, state: "PUBLISHED" }); published.fs.appendEvent({ schemaVersion: 1, eventId: "evt:pub", requestId: published.rid, type: "PublicationReconciled", actor: "arun", producer: "C30", requirementIds: [], decisionIds: [], result: "OK", rationale: "", at: "t" }); published.clock.t += 20_000; must(await published.sync()); assert.equal(published.gh.issue(PRIVATE, 1).state, "open", "a published request leaves its issue open"); } finally { published.close(); }
  void lifecycleRecord;
});

test("the trail never claims what it has not done: every request starts UNBOUND or TRACKING_BLOCKED and a bound one is SYNCED only with an empty outbox", async () => {
  const w = await setup();
  try {
    assert.equal(w.rec().issue.syncState, "UNBOUND"); assert.equal(trailState(w.fs, w.rec()), "UNBOUND");
    must(await w.bind()); assert.equal(w.rec().issue.syncState, "UNSYNCED");
    w.clock.t += 20_000; must(await w.sync()); assert.equal(w.rec().issue.syncState, "SYNCED");
    assert.ok(w.gh.calls.every((c) => !/DELETE|\/merge|\/labels$/.test(c) || /^GET /.test(c)), "labels are only ever read");
  } finally { w.close(); }
});
