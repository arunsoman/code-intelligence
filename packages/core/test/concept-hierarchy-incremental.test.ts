// The plan's key end-to-end guarantee: a single-line edit has a BOUNDED BLAST RADIUS. One function's
// graph is rebuilt, its concept is re-anchored, every other graph, concept, invariant and name is
// carried over, and the naming cache absorbs the naming work. Below the (uncalibrated) full-rebuild
// threshold, nothing is recomputed from scratch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACCUMULATE, FLAG, LEDGER, putRevision, setupService } from "./concept-hierarchy-helpers.ts";
import { ctx } from "./helpers.ts";

const files = { "src/ledger.ts": LEDGER, "src/total.ts": ACCUMULATE, "src/flag.ts": FLAG };

const makeRepoDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "cie-incr-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
};

test("a single-line edit rebuilds one graph and one function's concepts; everything else is carried", async () => {
  const repo = makeRepoDir();
  const { svc, worker } = setupService(repo);
  try {
    // --- revision A
    putRevision(svc.store, "rev-a", repo, files);
    const a = await svc.buildConceptHierarchy(ctx(), { revision: "rev-a" });
    assert.ok(a.ok, JSON.stringify(a));
    assert.equal(a.value.version, 1);
    assert.equal(a.value.stats!.fullRebuild, true, "the first build has no previous revision to reuse");
    // withdraw+deposit pair into a transfer-form and their single-sided forms are consumed; the
    // visible credit-form belongs to total (an unpaired guarded addition over `sum`).
    const aTransfer = a.value.concepts.find((c) => c.kind === "transfer-form")!;
    const aCredit = a.value.concepts.find((c) => c.kind === "credit-form")!;
    assert.ok(aTransfer && aCredit && aCredit.members[0].endsWith("#total"), JSON.stringify(a.value.concepts.map((c) => c.kind)));
    assert.ok(aTransfer.label && aCredit.label);

    // --- revision B: one line of withdraw's body changes
    const edited = LEDGER.replace("balance = balance - amount;", "balance = balance - amount - 1;");
    assert.notEqual(edited, LEDGER);
    writeFileSync(join(repo, "src/ledger.ts"), edited);
    putRevision(svc.store, "rev-b", repo, { ...files, "src/ledger.ts": edited });
    const b = await svc.buildConceptHierarchy(ctx(), { revision: "rev-b" });
    assert.ok(b.ok, JSON.stringify(b));
    const s = b.value.stats!;

    // bounded rebuild: one file of three changed, so no full rebuild
    assert.equal(s.fullRebuild, false, `ratio ${s.changedFileRatio} is below the threshold`);
    assert.ok(Math.abs(s.changedFileRatio - 1 / 3) < 1e-9);
    // exactly one graph rebuilt: withdraw's. The other three came back untouched.
    assert.equal(s.pdgs.built, 1, JSON.stringify(s.pdgs));
    assert.equal(s.pdgs.reused, 3, "deposit, total and checkFlag were reused whole");

    // concepts: same identities, carried labels — including the concept whose member function changed
    const bTransfer = b.value.concepts.find((c) => c.kind === "transfer-form")!;
    const bCredit = b.value.concepts.find((c) => c.kind === "credit-form")!;
    assert.equal(bTransfer.id, aTransfer.id, "the transfer keeps its anchored id even though a member changed");
    assert.equal(bTransfer.label, aTransfer.label, "and its label: member Jaccard is still 1");
    assert.equal(bCredit.id, aCredit.id, "untouched functions keep their concepts verbatim");
    assert.ok(s.conceptsCarried >= 3, JSON.stringify({ carried: s.conceptsCarried, concepts: b.value.concepts.length }));

    // naming: nothing re-asked, everything from the cache (every concept plus the one package node)
    assert.equal(s.naming.cacheHits, b.value.concepts.length + 1, JSON.stringify(s.naming));
    assert.equal(s.naming.named, 0, "no new model calls for unchanged shapes");
    assert.equal(s.naming.fallback, 0);

    // invariants for untouched functions are byte-identical
    const invA = a.value.invariants.filter((i) => !i.subjectEntityId.endsWith("#withdraw")).map((i) => i.id).sort();
    const invB = b.value.invariants.filter((i) => !i.subjectEntityId.endsWith("#withdraw")).map((i) => i.id).sort();
    assert.ok(invA.length >= 1);
    assert.deepEqual(invB, invA, "unchanged functions keep their invariants");

    // versions accumulate, and version 1 is still readable exactly as it was
    assert.equal(b.value.version, 2);
    assert.deepEqual(b.value.versions.map((v) => v.version), [2, 1]);
    const v1 = svc.conceptHierarchy(ctx(), { revision: "rev-a", version: 1 });
    assert.ok(v1.ok && v1.value.concepts.length === a.value.concepts.length);

    // the architecture tree also carried: the same module and package nodes
    const archA = new Set(a.value.arch.filter((n) => n.kind === "module").map((n) => n.id));
    const archB = new Set(b.value.arch.filter((n) => n.kind === "module").map((n) => n.id));
    assert.deepEqual([...archB].sort(), [...archA].sort());
  } finally { worker.close(); }
});

test("above the full-rebuild threshold the orchestrator says so and rebuilds from scratch", async () => {
  const repo = makeRepoDir();
  const { svc, worker } = setupService(repo);
  try {
    putRevision(svc.store, "rev-a", repo, files);
    const a = await svc.buildConceptHierarchy(ctx(), { revision: "rev-a" });
    assert.ok(a.ok);
    // two of three files change: ratio 2/3 > threshold
    const editedLedger = LEDGER.replace("balance = balance - amount;", "balance = balance - amount - 1;");
    const editedTotal = ACCUMULATE.replace("sum = sum + x;", "sum = sum + x + 1;");
    writeFileSync(join(repo, "src/ledger.ts"), editedLedger);
    writeFileSync(join(repo, "src/total.ts"), editedTotal);
    putRevision(svc.store, "rev-b", repo, { ...files, "src/ledger.ts": editedLedger, "src/total.ts": editedTotal });
    const b = await svc.buildConceptHierarchy(ctx(), { revision: "rev-b" });
    assert.ok(b.ok);
    const s2 = b.value.stats!;
    assert.equal(s2.fullRebuild, true, `ratio ${s2.changedFileRatio} exceeds the threshold`);
    assert.equal(s2.pdgs.reused, 0, "a full rebuild reuses nothing");
    assert.ok(s2.warnings.some((w: string) => /full-rebuild threshold/.test(w)), s2.warnings.join(" | "));
  } finally { worker.close(); }
});

test("a repository that edits only whitespace still counts as changed and re-anchors honestly", async () => {
  const repo = makeRepoDir();
  const { svc, worker } = setupService(repo);
  try {
    putRevision(svc.store, "rev-a", repo, files);
    const a = await svc.buildConceptHierarchy(ctx(), { revision: "rev-a" });
    assert.ok(a.ok);
    const reformatted = LEDGER.replace("balance = balance - amount;", "balance = balance - amount;  // keep the guard");
    writeFileSync(join(repo, "src/ledger.ts"), reformatted);
    putRevision(svc.store, "rev-b", repo, { ...files, "src/ledger.ts": reformatted });
    const b = await svc.buildConceptHierarchy(ctx(), { revision: "rev-b" });
    assert.ok(b.ok);
    assert.equal(b.value.stats!.fullRebuild, false);
    assert.equal(b.value.stats!.pdgs.built, 1, "the comment changed the body text, so the graph is rebuilt");
    const aTransfer = a.value.concepts.find((c) => c.kind === "transfer-form")!;
    const bTransfer = b.value.concepts.find((c) => c.kind === "transfer-form")!;
    assert.ok(bTransfer, JSON.stringify(b.value.concepts.map((c) => c.kind)));
    assert.equal(bTransfer.id, aTransfer.id, "same shape, same anchored identity");
    assert.equal(bTransfer.label, aTransfer.label, "same shape, same name");
  } finally { worker.close(); }
});
