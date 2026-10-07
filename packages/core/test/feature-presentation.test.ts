import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCandidateFile } from "../src/feature/candidate.ts";
import { rawHash } from "../src/feature/canon.ts";
import { compileChangeGraph, featureReview, reviewFiles } from "../src/feature/presentation.ts";
import type { AcceptanceCriterion, DecisionRecord, FeatureRecord, OverlapAssessment, Requirement } from "../src/feature/types.ts";
import { boot, createEdit, none } from "./feature-boot.ts";

const req = (id: string, text: string): Requirement => ({ id, source: { artifactId: "p", version: "1", locator: "prompt", contentHash: "h" }, text, origin: "USER", type: "FUNCTIONAL", actorIds: [], conditions: [], dependsOn: [], acceptanceIds: [], status: "ACTIVE" });
const crit = (id: string, requirementIds: string[]): AcceptanceCriterion => ({ id, requirementIds, scenario: "s", expectedOutcome: `expected ${id}`, mandatory: true, oracleSourceRefs: [], oracleOrigin: "GENERATED_UNREVIEWED", validationKinds: ["UNIT"] });
const task = (id: string, componentId: string, requirementIds: string[], plannedEdits: string[]) => ({ id, componentId, requirementIds, dependencyTaskIds: [], obligationIds: [], plannedEdits, capabilityIds: [], state: "READY" as const, evidenceIds: [] });

async function world(withCandidate = true) {
  const b = await boot({ acceptance: [crit("ac1", ["r1"]), crit("ac2", ["r2"])], edits: withCandidate ? (repo) => {
    const errors = readFileSync(join(repo, "src/errors.ts")), recon = readFileSync(join(repo, "src/jobs/reconciler.ts"));
    return [createEdit("src/export/csv.ts", "export const toCsv = () => '';\n"), createEdit("tests/csv.test.ts", "// t\n"),
      { op: "RENAME_FILE", from: "src/errors.ts", to: "src/domain/errors.ts", baseHash: rawHash(errors), why: "move", requirementIds: ["r2"], taskIds: ["t2"] },
      { op: "DELETE_FILE", file: "src/jobs/reconciler.ts", baseHash: rawHash(recon), why: "unused" }];
  } : undefined });
  const rec = b.fs.getRequest(b.rid)!;
  const contract = { ...rec.contract!, requirements: [req("r1", "Export transactions as CSV"), req("r2", "Keep the error classes together")] };
  const upd: FeatureRecord = { ...rec, contract, tasks: [task("t1", "C28", ["r1"], ["src/export/csv.ts", "docs/export.md"]), task("t2", "C23", ["r2"], ["src/domain/errors.ts"])],
    blockers: [{ id: "q1", kind: "QUESTION", requirementIds: ["r1"], text: "Which delimiter?", scope: "business" }, { id: "q2", kind: "QUESTION", requirementIds: [], text: "Who may export?" }] };
  b.fs.updateRequest(b.rid, rec.version, upd);
  return { ...b, req: () => b.fs.getRequest(b.rid)! };
}

test("PF-064/071 the review model is built from the recorded inventory, not from the prompt: files carry their requirements, components and an honest attribution note", async () => {
  const w = await world();
  try {
    const files = reviewFiles(w.req(), w.cand); const by = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(by).sort(), ["src/domain/errors.ts", "src/export/csv.ts", "src/jobs/reconciler.ts", "tests/csv.test.ts"]);
    assert.deepEqual([by["src/export/csv.ts"]!.kind, by["src/export/csv.ts"]!.requirementIds, by["src/export/csv.ts"]!.attribution], ["ADDED", ["r1"], "COMPLETE"]);
    assert.deepEqual([by["src/domain/errors.ts"]!.kind, by["src/domain/errors.ts"]!.oldPath, by["src/domain/errors.ts"]!.componentIds], ["RENAMED", "src/errors.ts", ["C23"]]);
    assert.equal(by["src/jobs/reconciler.ts"]!.attribution, "UNATTRIBUTED"); assert.ok(by["src/jobs/reconciler.ts"]!.gaps.includes("Some mutation origins are missing."));
    assert.ok(files.every((f) => f.gaps[0]!.startsWith("Attribution links the file mutation to requirements; individual lines do not establish unique causation")), "no line-level causation is claimed");
    const planned = Object.fromEntries(reviewFiles({ ...w.req(), tasks: [...w.req().tasks, task("t3", "C10", ["r2"], ["docs/export.md"])] }, null).map((f) => [f.path, f]));
    assert.deepEqual([planned["docs/export.md"]!.kind, planned["docs/export.md"]!.requirementIds, planned["docs/export.md"]!.taskIds, planned["docs/export.md"]!.componentIds], ["PLANNED", ["r1", "r2"], ["t1", "t3"], ["C28", "C10"]], "a planned path owned by two tasks is one file with both");
    assert.match(planned["docs/export.md"]!.gaps[0]!, /no file mutation is claimed/);
  } finally { w.close(); }
});

test("AT-70/71 featureReview: questions, decisions, criteria, counts, results and the eligibility decision, with gaps stated and denied paths counted but never named", async () => {
  const w = await world();
  try {
    const dec: DecisionRecord = { schemaVersion: 1, id: "d1", requestId: w.rid, kind: "ANSWER", answer: "comma", actorId: "arun", contractVersion: 0, affectedIds: ["r1"], rationale: "", createdAt: "2026-10-05T00:00:00Z" }; w.fs.putDecision(dec);
    const r = featureReview(w.fs, w.req(), w.cand);
    assert.equal(r.prompt, "Add export"); assert.deepEqual(r.requirements.map((x) => x.id), ["r1", "r2"]); assert.deepEqual(r.criteria.map((x) => x.id), ["ac1", "ac2"]); assert.deepEqual(r.decisions.map((x) => x.id), ["d1"]);
    assert.deepEqual(r.questions.map((q) => [q.id, q.scope, q.requirementIds]), [["q1", "business", ["r1"]], ["q2", "business", []]]); assert.match(r.questions[0]!.whyNeeded, /Blocks r1; business authority is required/); assert.match(r.questions[1]!.whyNeeded, /Blocks request progress/);
    assert.deepEqual(r.fileCounts, { ADDED: 2, MODIFIED: 0, DELETED: 1, RENAMED: 1, REUSED: 0, AFFECTED_UNCHANGED: 0, PLANNED: 0 });
    assert.ok(r.decision && r.decision.eligibility !== "VERIFIED_WITHIN_SCOPE", "nothing was validated, so nothing is verified"); assert.match(r.validationPlanHash!, /^pf-canon-v1\//);
    assert.ok(r.gaps.includes("Overlap assessment has not been recorded.")); assert.ok(!r.gaps.includes("No contract draft recorded."));
    const planOnly = featureReview(w.fs, w.req(), null); assert.equal(planOnly.decision, undefined); assert.equal(planOnly.validationPlanHash, undefined); assert.deepEqual(planOnly.results, []); assert.equal(planOnly.fileCounts.PLANNED, 3);
    const noContract = featureReview(w.fs, { ...w.req(), contract: undefined }, null); assert.ok(noContract.gaps.includes("No contract draft recorded."));
    const overlap: OverlapAssessment = { id: "o1", contractHash: "c", comparedSnapshots: [], relationship: "PARTIAL_OVERLAP", strategy: "EXTEND", mappings: [], alternatives: [], unresolvedIds: [] };
    assert.equal(featureReview(w.fs, { ...w.req(), contract: { ...w.req().contract!, overlap } }, null).overlap!.relationship, "PARTIAL_OVERLAP");
    w.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(w.repo, "src/domain");
    const limited = featureReview(w.fs, w.req(), w.cand, w.svc.store);
    assert.ok(!limited.files.some((f) => f.path.startsWith("src/domain") || f.oldPath?.startsWith("src/domain")), "a rename into a denied path is hidden"); assert.equal(limited.files.length, 3);
    assert.ok(limited.gaps.includes("Some files are outside your source access scope; counts cover visible inventory only.")); assert.ok(!JSON.stringify(limited).includes("src/domain"), "the denied path is not named anywhere in the model, including task plans (issue #86)");
  } finally { w.close(); }
});

test("PF-072/AT-73 the change graph is bounded and layered (requirement → component → file), filterable, paged with a cursor tied to the view, and the accessible list names the same files", async () => {
  const w = await world();
  try {
    const files = reviewFiles(w.req(), w.cand); const g = (over = {}) => compileChangeGraph(w.req(), files, { candidateHash: w.cand.bindingHash, budget: { nodes: 90 }, ...over });
    for (const bad of [2, 301, 1.5, NaN]) assert.throws(() => g({ budget: { nodes: bad } }), (e: any) => e.code === "INVALID_SCHEMA", String(bad));
    const out = g(); assert.equal(out.status, "COMPLETE"); const v = out.value!.viewSpec as any; const m = out.value!.presentationManifest as any;
    assert.deepEqual(v.nodes.filter((n: any) => n.kind === "requirement").map((n: any) => n.label).sort(), ["Export transactions as CSV", "Keep the error classes together"], "requirement nodes carry the requirement text");
    assert.deepEqual([...new Set(v.nodes.map((n: any) => `${n.kind}:${n.layer}`))].sort(), ["component:1", "file:2", "requirement:0"]);
    assert.ok(v.edges.some((e: any) => e.id === "requirement:r2->component:C23:implements") && v.edges.some((e: any) => e.id === "component:C23->file:src/domain/errors.ts:affects"), "the component comes from the task that made the edit");
    assert.ok(v.edges.some((e: any) => e.id === "requirement:r1->component:unassigned:implements"), "an edit with no task is shown under 'unassigned', with its requirement");
    assert.ok(v.edges.some((e: any) => e.fromNodeId === "component:unassigned" && e.toNodeId === "file:src/jobs/reconciler.ts"), "a file with no component sits under 'unassigned', it is not dropped");
    assert.deepEqual(m.files.map((f: any) => f.path).sort(), files.map((f) => f.path).sort(), "the accessible list names every file the graph shows"); assert.deepEqual([m.shown, m.total], [4, 4]);
    assert.deepEqual((g().value!.viewSpec as any).nodes.map((n: any) => n.id), v.nodes.map((n: any) => n.id), "deterministic"); assert.equal(v.id, m.identity);
    const byReq = g({ filters: { requirementId: "r2" } }).value!.presentationManifest as any; assert.deepEqual(byReq.files.map((f: any) => f.path), ["src/domain/errors.ts"]);
    assert.deepEqual((g({ filters: { status: "ADDED" } }).value!.presentationManifest as any).files.map((f: any) => f.path).sort(), ["src/export/csv.ts", "tests/csv.test.ts"]);
    assert.deepEqual((g({ filters: { componentId: "C23" } }).value!.presentationManifest as any).files.map((f: any) => f.path), ["src/domain/errors.ts"]);
    assert.deepEqual((g({ filters: { path: "CSV" } }).value!.presentationManifest as any).files.map((f: any) => f.path).sort(), ["src/export/csv.ts", "tests/csv.test.ts"], "path search ignores case");
    assert.deepEqual((g({ filters: { gap: "yes" } }).value!.presentationManifest as any).files.map((f: any) => f.path), ["src/jobs/reconciler.ts"], "the gap filter shows files whose attribution is incomplete");
    const p1 = g({ budget: { nodes: 6 } }); assert.equal(p1.status, "PARTIAL"); assert.equal((p1.value!.presentationManifest as any).shown, 2); assert.match(p1.diagnostics.join(" "), /Showing 2 of 4 matching files/); assert.ok(p1.value!.nextCursor);
    const p2 = g({ budget: { nodes: 6 }, cursor: p1.value!.nextCursor }); assert.deepEqual((p2.value!.presentationManifest as any).files.map((f: any) => f.path).filter((p: string) => (p1.value!.presentationManifest as any).files.some((f: any) => f.path === p)), [], "pages do not overlap");
    assert.equal(p2.value!.nextCursor, undefined); assert.equal(p2.status, "COMPLETE", "the last page is complete");
    assert.throws(() => g({ budget: { nodes: 6 }, cursor: p1.value!.nextCursor!.replace(/\|\d+$/, "|abc") }), (e: any) => e.code === "STALE_REVISION");
    assert.throws(() => g({ budget: { nodes: 6 }, cursor: p1.value!.nextCursor, filters: { status: "ADDED" } }), (e: any) => e.code === "STALE_REVISION" && /no longer matches this view/.test(e.message), "a cursor from one view cannot page another");
    assert.throws(() => compileChangeGraph({ ...w.req(), workspace: { ...w.req().workspace, workspaceVersion: 99 } }, files, { candidateHash: w.cand.bindingHash, budget: { nodes: 6 }, cursor: p1.value!.nextCursor }), (e: any) => e.code === "STALE_REVISION", "the workspace moved on");
    const planned = compileChangeGraph(w.req(), reviewFiles(w.req(), null), { budget: { nodes: 90 } }); assert.ok((planned.value!.viewSpec as any).edges.some((e: any) => e.kind === "potential-impact" && e.displayMode === "INFERENCE"), "planned work is drawn as inference, not fact");
  } finally { w.close(); }
});

test("C19/compileChangeGraph: owner-only, bound to the request's own candidate, and a denied path is absent from the graph", async () => {
  const w = await world();
  try {
    const call = (who: string, body: unknown) => w.h["C19/compileChangeGraph"]!(w.as(who), body);
    const ok = await call("arun", { requestId: w.rid, candidateHash: w.cand.bindingHash }); assert.ok(ok.ok, JSON.stringify(ok)); assert.equal((ok.value.value.presentationManifest as any).total, 4);
    assert.equal(ok.value.value.viewSpec.nodes.length <= 90, true, "the default budget applies");
    const planned = await call("arun", { requestId: w.rid }); assert.ok(planned.ok && (planned.value.value.presentationManifest as any).files.every((f: any) => f.kind === "PLANNED"));
    const other = await call("mallory", { requestId: w.rid, candidateHash: w.cand.bindingHash }); assert.ok(!other.ok && other.error.code === "NOT_FOUND");
    const wrong = await call("arun", { requestId: w.rid, candidateHash: "pf-canon-v1/not-mine" }); assert.ok(!wrong.ok && wrong.error.code === "NOT_FOUND" && /no such candidate for this request/.test(wrong.error.message));
    const tiny = await call("arun", { requestId: w.rid, candidateHash: w.cand.bindingHash, budget: { nodes: 1 } }); assert.ok(!tiny.ok && tiny.error.code === "INVALID_SCHEMA");
    const filtered = await call("arun", { requestId: w.rid, candidateHash: w.cand.bindingHash, filters: { requirementId: "r2" } }); assert.deepEqual(filtered.value.value.presentationManifest.files.map((f: any) => f.path), ["src/domain/errors.ts"]);
    const page1 = await call("arun", { requestId: w.rid, candidateHash: w.cand.bindingHash, budget: { nodes: 6 } }); assert.ok(page1.value.value.nextCursor);
    const page2 = await call("arun", { requestId: w.rid, candidateHash: w.cand.bindingHash, budget: { nodes: 6 }, cursor: page1.value.value.nextCursor }); assert.ok(page2.ok);
    w.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(w.repo, "src/jobs");
    const hidden = await call("arun", { requestId: w.rid, candidateHash: w.cand.bindingHash }); assert.ok(!JSON.stringify(hidden).includes("reconciler"), "a denied path never reaches the graph"); assert.equal(hidden.value.value.presentationManifest.total, 3);
  } finally { w.close(); }
});

test("PF-072 paged file reads for the viewer: line window, next line, total lines, full download, split-diff paging and bad requests", async () => {
  const w = await world();
  try {
    const big = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    w.fs.updateRequest(w.rid, w.req().version, { ...w.req(), blockers: [] }); const r = w.req(); const cand = (await import("../src/feature/candidate.ts")).materializeCandidate({ fs: w.fs, store: w.svc.store, auth: none }, "arun", { requestId: w.rid, snapshot: r.source, edits: [createEdit("src/export/big.ts", big)], idempotencyKey: "big" }).candidate;
    const rd = (path: string, representation: any, range?: [number, number], download?: boolean) => readCandidateFile({ fs: w.fs, store: w.svc.store, auth: none }, { candidateHash: cand.bindingHash, path, representation, range, download });
    const first = rd("src/export/big.ts", "CANDIDATE", [1, 200]).value!; assert.deepEqual([first.startLine, first.nextLine, first.totalLines, first.complete], [1, 201, 451, false]); assert.ok(first.content.startsWith("line 1\n") && first.content.endsWith("line 200"));
    const last = rd("src/export/big.ts", "CANDIDATE", [401, 600]).value!; assert.deepEqual([last.startLine, last.nextLine, last.totalLines, last.complete], [401, undefined, 451, false], "a window that starts late is still not the whole file");
    const dflt = rd("src/export/big.ts", "CANDIDATE").value!; assert.equal(dflt.nextLine, 401, "the default window is 400 lines");
    const all = rd("src/export/big.ts", "CANDIDATE", undefined, true).value!; assert.equal(all.complete, true); assert.equal(all.content, big.replace(/\n$/, "\n")); assert.equal(all.nextLine, undefined);
    const split = rd("src/export/big.ts", "SPLIT_DIFF", [1, 100]).value!; const rows = JSON.parse(split.content); assert.equal(rows.length, 100); assert.equal(split.nextLine, 101); assert.ok(rows.every((x: any) => x.change === "changed" && x.left === null));
    assert.throws(() => rd("src/export/big.ts", "SIDEWAYS"), (e: any) => e.code === "INVALID_SCHEMA" && /unknown file representation/.test(e.message));
    assert.throws(() => rd("src/export/big.ts", "CANDIDATE", [0, 5]), /ordered/); assert.throws(() => rd("src/export/big.ts", "CANDIDATE", [5, 2]), /ordered/);
    const dl = rd("src/export/big.ts", "UNIFIED_DIFF", undefined, true).value!; assert.equal(dl.complete, true); assert.match(dl.content, /^--- \/dev\/null\n\+\+\+ b\/src\/export\/big\.ts\n@@ -0,0 \+1,451 @@/); assert.equal(dl.totalLines, dl.content.split("\n").length);
  } finally { w.close(); }
});

test("C01/openFeatureWorkspace carries the review the wizard renders, hides denied paths, and still answers NOT_MODIFIED for an unchanged version", async () => {
  const w = await world();
  try {
    const open = (since?: number) => w.h["C01/openFeatureWorkspace"]!(w.as("arun"), { requestId: w.rid, sinceWorkspaceVersion: since });
    const a = await open(); assert.ok(a.ok, JSON.stringify(a)); const review = a.value.value.review;
    assert.deepEqual(review.files.map((f: any) => f.path).sort(), ["src/domain/errors.ts", "src/export/csv.ts", "src/jobs/reconciler.ts", "tests/csv.test.ts"]); assert.deepEqual(review.questions.map((q: any) => q.id), ["q1", "q2"]); assert.equal(review.requirements.length, 2);
    assert.equal(a.value.diagnostics.length, 0); const same = await open(a.value.value.workspaceVersion); assert.deepEqual(same.value.diagnostics, ["NOT_MODIFIED"]); assert.equal(same.value.value, undefined);
    w.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(w.repo, "src/domain");
    const hidden = await open(); assert.ok(!JSON.stringify(hidden.value.value.review).includes("src/domain"));
  } finally { w.close(); }
});
