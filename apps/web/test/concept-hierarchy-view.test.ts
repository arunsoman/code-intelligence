import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArchConcept, ConceptHierarchyView, HierarchyStats, Invariant, JobView, SemanticConcept } from "@cie/schema";
import {
  CONCEPT_MODE_KEY, MODE_INFO, archRows, conceptTitle, groupConcepts, hierarchyBuilds, hierarchySummary, isEmptyHierarchy, mechanicalNamesNotice, memberNames, namingBadge, namingProvenance, readConceptMode,
  sortInvariants, statsNotes, writeConceptMode, type ModeStorage,
} from "../src/concept-hierarchy-view.ts";

const concept = (over: Partial<SemanticConcept>): SemanticConcept => ({
  id: "c1", revision: "r1", kind: "guarded-write", label: null, namedBy: null, members: ["function:src/a.ts#debit"], evidenceIds: ["e1"],
  canonicalMotifHash: "h", compositionRule: null, features: {}, soundness: { tier: "supported", basis: "guards" }, source: "MOTIF", ...over,
});
const job = (over: Partial<JobView>): JobView => ({ id: "j1", kind: "concept-hierarchy", state: "RUNNING", cancelRequested: false, committing: false, phase: "motifs", message: "", params: { revision: "r1" }, createdAt: "2026-01-01T00:00:00.000Z", ...over }) as JobView;
const memory = (init: Record<string, string> = {}): ModeStorage & { data: Record<string, string> } => ({ data: init, getItem(k) { return k in init ? init[k] : null; }, setItem(k, v) { init[k] = v; } });

test("the method toggle remembers its choice, starts on the structural hierarchy, and survives storage that throws", () => {
  assert.equal(readConceptMode(undefined), "hierarchy", "no storage at all");
  assert.equal(readConceptMode(memory()), "hierarchy", "nothing remembered yet");
  assert.equal(readConceptMode(memory({ [CONCEPT_MODE_KEY]: "cards" })), "cards");
  assert.equal(readConceptMode(memory({ [CONCEPT_MODE_KEY]: "nonsense" })), "hierarchy", "an unknown value is not trusted");
  const s = memory(); writeConceptMode("cards", s);
  assert.equal(readConceptMode(s), "cards");
  const blocked: ModeStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readConceptMode(blocked), "hierarchy");
  assert.doesNotThrow(() => writeConceptMode("cards", blocked));
});

test("each method starts its own kind of job, so the two never write to each other's store", () => {
  assert.equal(MODE_INFO.hierarchy.jobKind, "concept-hierarchy");
  assert.equal(MODE_INFO.cards.jobKind, "concepts");
  assert.notEqual(MODE_INFO.hierarchy.button, MODE_INFO.cards.button);
});

test("a build in progress, waiting or failed is reported for its own revision only", () => {
  const jobs = [
    job({ id: "a", state: "RUNNING", message: "building graphs" }),
    job({ id: "b", state: "QUEUED" }),
    job({ id: "c", state: "FAILED", message: "interrupted by a restart" }),
    job({ id: "d", state: "FAILED", message: "boom" }),
    job({ id: "e", kind: "concepts" }),
    job({ id: "f", params: { revision: "other" } }),
  ];
  const builds = hierarchyBuilds(jobs, "r1");
  assert.deepEqual(builds.map((b) => b.id), ["a", "b", "c", "d"], "concept-card jobs and other revisions are not hierarchy builds");
  assert.equal(builds[0].detail, "Building concept hierarchy: building graphs");
  assert.equal(builds[1].detail, "Waiting to start");
  assert.ok(builds[2].interrupted && builds[2].failed);
  assert.ok(builds[3].failed && !builds[3].interrupted);
});

test("a concept with no name says so; a name is labelled a suggestion, not a finding", () => {
  assert.equal(conceptTitle(concept({})), "unnamed guarded-write");
  assert.equal(conceptTitle(concept({ label: "  Balance debit  " })), "Balance debit");
  assert.equal(namingBadge(concept({ namedBy: "MODEL" })), "name suggested by a model");
  assert.equal(namingBadge(concept({ namedBy: "FALLBACK" })), "mechanical name");
  assert.equal(namingBadge(concept({ namedBy: null })), "not named");
});

test("a name is only called a model's when the version's provider really is a model", () => {
  const stub = namingProvenance("stub/deterministic-graph-v1");
  assert.deepEqual([stub.known, stub.deterministic], [true, true]);
  assert.equal(namingBadge(concept({ namedBy: "MODEL" }), stub), "name from the offline stub, not model-read", "the stub names things mechanically, whatever the record says");
  const real = namingProvenance("ollama/llama3.2:1b");
  assert.deepEqual([real.known, real.deterministic], [true, false]);
  assert.equal(namingBadge(concept({ namedBy: "MODEL" }), real), "name suggested by a model");
  for (const missing of ["unknown", "", null, undefined]) {
    const u = namingProvenance(missing);
    assert.deepEqual([u.known, u.badge], [false, "provider not recorded"], String(missing));
    assert.equal(namingBadge(concept({ namedBy: "MODEL" }), u), "name from an unrecorded provider", "never claims a model it cannot show");
  }
  assert.equal(namingBadge(concept({ namedBy: "FALLBACK" }), real), "mechanical name", "a fallback is mechanical under any provider");
});

test("concepts group by shape, biggest group first, and the filter searches names, shapes and members", () => {
  const cs = [
    concept({ id: "1", kind: "loop-accumulate", members: ["function:src/sum.ts#total"] }),
    concept({ id: "2", kind: "guarded-write", members: ["function:src/a.ts#debit"] }),
    concept({ id: "3", kind: "guarded-write", label: "Credit", members: ["function:src/a.ts#credit", "function:src/b.ts#credit2"] }),
  ];
  const g = groupConcepts(cs);
  assert.deepEqual(g.map((x) => [x.kind, x.concepts.length]), [["guarded-write", 2], ["loop-accumulate", 1]]);
  assert.deepEqual(g[0].concepts.map((c) => c.id), ["3", "2"], "the widest concept leads its group");
  assert.deepEqual(groupConcepts(cs, "credit").flatMap((x) => x.concepts.map((c) => c.id)), ["3"], "by name");
  assert.deepEqual(groupConcepts(cs, "LOOP").map((x) => x.kind), ["loop-accumulate"], "by shape, case-insensitive");
  assert.deepEqual(groupConcepts(cs, "sum.ts").flatMap((x) => x.concepts.map((c) => c.id)), ["1"], "by member");
  assert.deepEqual(groupConcepts(cs, "zzz"), []);
  assert.equal(memberNames(concept({ members: ["function:a#1", "function:a#2", "function:a#3"] }), 2), "a#1, a#2 and 1 more");
});

test("invariants list the surest first and say how sure each is", () => {
  const inv = (id: string, tier: Invariant["tier"], subject = "function:src/a.ts#f"): Invariant => ({ id, revision: "r1", subjectEntityId: subject, variable: "balance", statement: "s", tier, basis: "b", guardCondition: null, evidenceIds: [], members: 1 });
  const sorted = sortInvariants([inv("s", "speculative"), inv("v", "verified"), inv("p", "supported")]);
  assert.deepEqual(sorted.map((i) => i.id), ["v", "p", "s"]);
});

test("the architecture tree flattens depth first and cannot loop or crash on a cycle or a dangling id", () => {
  const n = (id: string, parent: string | null, children: string[], kind: ArchConcept["kind"] = "module"): ArchConcept => ({ id, revision: "r1", kind, name: id, path: id, parent, memberEntityIds: [], children });
  const tree = [n("repo", null, ["pkg"], "repo"), n("pkg", "repo", ["m1", "m2", "ghost"], "package"), n("m1", "pkg", []), n("m2", "pkg", [])];
  assert.deepEqual(archRows(tree).map((r) => [r.node.id, r.depth]), [["repo", 0], ["pkg", 1], ["m1", 2], ["m2", 2]], "a dangling child id is skipped");
  const cyc = [n("a", "b", ["b"]), n("b", "a", ["a"])];
  assert.deepEqual(archRows(cyc), [], "a cycle has no root, so nothing is drawn and nothing hangs");
  const selfLoop = [n("r", null, ["r"])];
  assert.equal(archRows(selfLoop).length, 1);
  assert.equal(archRows(tree, 2).length, 2, "the row limit holds");
});

test("the summary and the build notes say what was reused, what was named, and what is missing", () => {
  const view = { revision: "r1", version: 2, versions: [], concepts: [concept({}), concept({ id: "c2" })], invariants: [], arch: [], surfaces: [], entryPoints: [], crossPackage: [], links: [], stats: null } as ConceptHierarchyView;
  assert.equal(hierarchySummary(view), "2 concepts · 0 invariants · 0 cross-package concepts · 0 tree nodes");
  assert.equal(isEmptyHierarchy(view), false);
  assert.equal(isEmptyHierarchy({ ...view, version: 0 }), true);
  assert.equal(isEmptyHierarchy(null), true);

  assert.deepEqual(statsNotes(null), ["Build statistics are kept only for the current version."]);
  const stats: HierarchyStats = {
    fullRebuild: false, changedFileRatio: 0.1, files: { changed: 3, total: 30 }, pdgs: { built: 4, reused: 26, skipped: 2, unresolved: 1 },
    conceptsCarried: 5, renamed: 0, naming: { named: 6, fallback: 2, cacheHits: 3 }, phasesMs: {}, warnings: ["a function was too large and was truncated"],
  };
  const notes = statsNotes(stats);
  assert.match(notes[0], /Incremental: 3 of 30 files changed; 26 graph\(s\) reused, 4 rebuilt/);
  assert.ok(notes.some((x) => /2 function\(s\) skipped over budget, 1 whose source could not be read\. They are not in the results/.test(x)), "what was left out is stated");
  assert.ok(notes.some((x) => x === "Names: 6 from a model, 2 mechanical, 3 reused from earlier builds."));
  assert.ok(notes.includes("a function was too large and was truncated"), "warnings pass through");
  assert.match(statsNotes({ ...stats, fullRebuild: true })[0], /^Full rebuild/);
});

test("when no model wrote any name the dialog says so and why; when one did, it stays quiet", () => {
  const base: HierarchyStats = { fullRebuild: true, changedFileRatio: 1, files: { changed: 1, total: 1 }, pdgs: { built: 1, reused: 0, skipped: 0, unresolved: 0 }, conceptsCarried: 0, renamed: 0, naming: { named: 0, fallback: 5, cacheHits: 0 }, phasesMs: {}, warnings: [] };
  assert.equal(mechanicalNamesNotice(null), null);
  assert.match(mechanicalNamesNotice(base)!, /Every name here is mechanical: the shape plus the function it sits in\. No model wrote them\. No model was available/);
  const denied = mechanicalNamesNotice({ ...base, warnings: ["Sending code structure to the hosted model is not approved for this repository, so the offline model answered."] })!;
  assert.match(denied, /not approved for this repository/);
  assert.match(denied, /Approve it, then build again to get descriptive names\./, "the way out is stated");
  assert.equal(mechanicalNamesNotice({ ...base, naming: { named: 2, fallback: 3, cacheHits: 0 } }), null, "partly named by a model: the per-concept badge says which");
  assert.equal(mechanicalNamesNotice({ ...base, naming: { named: 0, fallback: 0, cacheHits: 4 } }), null, "nothing mechanical to explain");
});
