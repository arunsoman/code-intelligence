// V6 Semantic Diff Timeline: what changed between two indexed revisions, at the level of symbols, behaviour and concepts.
// The before/after pair is level-locked: both sides show exactly the same elements.
import type { Claim, Entity, Fact, ViewNode } from "@cie/schema";
import { recentCommits, isGitRepo } from "../gitinfo.ts";
import type { RevisionRow, Store } from "../store.ts";
import { baseView, claimOf, containsEvidence, emptyForm, observation, short } from "./common.ts";

const SYMBOLS = new Set(["function", "method", "class"]);
const fkey = (f: Fact) => `${f.subject}|${f.predicate}|${JSON.stringify((f.object as { value?: unknown }).value)}`;
const BEHAVIOR = new Set(["throws", "writes", "uses_transaction", "publishes", "subscribes"]);

export function buildDiff(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "SemanticDiff" as const, question, kind: "diff", caption: "", reason: "You asked what changed, so this compares two indexed revisions: the before and after side by side, and what the change means." };
  const before = (subject && store.revision(subject)) || store.previousRevision(rev.id);
  if (!before) return emptyForm(o, "Only one revision of this repository is indexed. Change something and re-index, and I can show what changed between the two.");
  if (before.id === rev.id) return emptyForm(o, "Those are the same revision; nothing changed.");

  const ents = (id: string) => new Map(store.entities(id).filter((e) => SYMBOLS.has(e.kind)).map((e) => [e.entityId, e]));
  const A = ents(before.id), B = ents(rev.id);
  const added = [...B.keys()].filter((id) => !A.has(id)), removed = [...A.keys()].filter((id) => !B.has(id));
  const changed = [...B.keys()].filter((id) => A.has(id) && A.get(id)!.symbolHash !== B.get(id)!.symbolHash);
  const factsOf = (id: string) => store.allFacts(id).filter((f) => BEHAVIOR.has(f.predicate));
  const fa = new Map(factsOf(before.id).map((f) => [fkey(f), f])), fb = new Map(factsOf(rev.id).map((f) => [fkey(f), f]));
  const newFacts = [...fb].filter(([k]) => !fa.has(k)).map(([, f]) => f), goneFacts = [...fa].filter(([k]) => !fb.has(k)).map(([, f]) => f);

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [], consequences: NonNullable<typeof v.consequences> = [];
  const touched = [...new Set([...changed, ...added, ...removed])].sort();
  if (touched.length === 0 && newFacts.length === 0 && goneFacts.length === 0) return emptyForm(o, `Nothing about the code changed between ${before.id} and ${rev.id}.`);

  const shown = touched.slice(0, 30);
  const status = (id: string) => (added.includes(id) ? "added" : removed.includes(id) ? "removed" : "changed");
  shown.forEach((id, i) => {
    const e = (B.get(id) ?? A.get(id)) as Entity, st = status(id), y = i * 64;
    const beforeEv = st === "added" ? [observation(store, rev.id, `absent:${before.id}:${id}`, "HISTORY", e.file, `Revision ${before.id}: ${e.name} did not exist yet.`).id] : [observation(store, rev.id, `before:${before.id}:${id}`, "HISTORY", e.file, `Revision ${before.id}: ${e.name} existed here (symbol hash ${A.get(id)?.symbolHash ?? "?"}).`).id];
    const afterEv = st === "removed" ? [observation(store, rev.id, `gone:${rev.id}:${id}`, "HISTORY", e.file, `Revision ${rev.id}: ${e.name} no longer exists.`).id] : containsEvidence(store, rev.id, id);
    const mk = (side: "b" | "a", x: number, ev: string[], present: boolean): ViewNode => ({
      id: `${side}:${id}`, entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: ev, tier: st === "changed" ? "CRITICAL" : "RELEVANT", unresolvedCalls: 0,
      displayMode: present ? "FACT" : "HIDDEN", role: `${side === "b" ? "before" : "after"}-${st}`, pos: { x, y }, ghost: !present, lane: side === "b" ? "before" : "after",
      badge: side === "b" ? (st === "added" ? "didn't exist" : st) : (st === "removed" ? "deleted" : st), notes: [`${st[0].toUpperCase() + st.slice(1)} between ${before.id} and ${rev.id}.`],
    });
    v.nodes.push(mk("b", -320, beforeEv, st !== "added"), mk("a", 320, afterEv, st !== "removed"));
    v.edges.push({ id: `e:pair:${id}`, fromNodeId: `b:${id}`, toNodeId: `a:${id}`, kind: "became", evidenceIds: [...beforeEv, ...afterEv], displayMode: "FACT", label: st });
  });
  v.groups.push({ id: "g:lane:before", label: `before · ${before.id.slice(0, 14)}`, kind: "lane", childNodeIds: v.nodes.filter((n) => n.lane === "before").map((n) => n.id), level: 1, evidenceIds: [], displayMode: "FACT" }, { id: "g:lane:after", label: `after · ${rev.id.slice(0, 14)}`, kind: "lane", childNodeIds: v.nodes.filter((n) => n.lane === "after").map((n) => n.id), level: 1, evidenceIds: [], displayMode: "FACT" });

  const push = (c: Claim, kind: string, entityIds: string[]) => { claims.push(c); consequences.push({ id: `c:${c.draft.id}`, text: c.draft.assertion, kind, displayMode: c.displayMode === "HIDDEN" ? "HIDDEN" : c.displayMode, claimId: c.draft.id, evidenceIds: c.draft.evidenceIds.slice(0, 6), entityIds }); };
  const name = (id: string) => short(id);
  for (const f of newFacts) {
    const val = String((f.object as { value?: unknown }).value), who = name(f.subject);
    if (f.predicate === "throws") push(claimOf(store, rev.id, { assertion: `${who} can now fail with ${val}.`, claimClass: "diff-failure-mode", evidenceIds: f.evidence.map((x) => x.id), rationaleSummary: "A new throw site appeared." }), "new failure mode", [f.subject]);
    if (f.predicate === "writes") push(claimOf(store, rev.id, { assertion: `${who} now writes ${val}.`, claimClass: "diff-new-writer", evidenceIds: f.evidence.map((x) => x.id), rationaleSummary: "A new writer of this state appeared." }), "new writer", [f.subject]);
    if (f.predicate === "uses_transaction") push(claimOf(store, rev.id, { assertion: `${who} now runs inside a transaction.`, claimClass: "diff-tx", evidenceIds: f.evidence.map((x) => x.id), rationaleSummary: "A transaction boundary was added." }), "transaction added", [f.subject]);
    if (f.predicate === "publishes" || f.predicate === "subscribes") push(claimOf(store, rev.id, { assertion: `${who} now ${f.predicate === "publishes" ? "publishes to" : "subscribes to"} “${val}”.`, claimClass: "diff-topic", evidenceIds: f.evidence.map((x) => x.id), rationaleSummary: "A new asynchronous hand-off appeared." }), "new async hand-off", [f.subject]);
  }
  for (const f of goneFacts) {
    const val = String((f.object as { value?: unknown }).value), who = name(f.subject);
    const ev = observation(store, rev.id, `gonefact:${before.id}:${f.id}`, "HISTORY", (A.get(f.subject) ?? B.get(f.subject))?.file ?? "", `Revision ${before.id} had “${f.predicate} ${val}” in ${who}; revision ${rev.id} does not.`).id;
    if (f.predicate === "uses_transaction") push(claimOf(store, rev.id, { assertion: `${who} is no longer inside a transaction; its writes can now interleave with others.`, claimClass: "diff-tx-lost", evidenceIds: [ev], rationaleSummary: "A transaction boundary was removed." }), "transaction removed", [f.subject]);
    else if (f.predicate === "throws") push(claimOf(store, rev.id, { assertion: `${who} can no longer fail with ${val}; callers that handled it now have dead handling, and a check may have been lost.`, claimClass: "diff-failure-removed", evidenceIds: [ev], rationaleSummary: "A throw site disappeared." }), "failure mode removed", [f.subject]);
    else push(claimOf(store, rev.id, { assertion: `${who} no longer ${f.predicate} ${val}.`, claimClass: "diff-removed-behavior", evidenceIds: [ev], rationaleSummary: "A behavioural fact disappeared." }), "behaviour removed", [f.subject]);
  }
  // Tests whose subject changed, and tests that no longer reach anything they used to.
  const tests = store.entities(rev.id).filter((e) => e.kind === "test");
  const callsB = store.relationshipsAmong(rev.id, "calls"), callsA = new Set(store.relationshipsAmong(before.id, "calls").map((r) => r.id));
  const changedSet = new Set(changed);
  for (const t of tests.slice(0, 200)) {
    const hits = callsB.filter((r) => r.from === t.entityId && changedSet.has(r.to));
    if (hits.length) push(claimOf(store, rev.id, { assertion: `The test “${t.name}” exercises ${hits.map((h) => name(h.to)).join(", ")}, which changed; what it asserts may no longer match.`, claimClass: "diff-test-meaning", evidenceIds: hits.flatMap((h) => h.evidence.map((x) => x.id)).slice(0, 4), rationaleSummary: "The code under test changed but the test did not necessarily follow." }), "test meaning", [t.entityId]);
  }
  const lost = [...callsA].filter((id) => id.startsWith("rel:calls:test:") && !callsB.some((r) => r.id === id));
  for (const id of lost.slice(0, 5)) {
    const m = /^rel:calls:(test:[^>]+)->(.+)$/.exec(id); if (!m) continue;
    const ev = observation(store, rev.id, `testlost:${id}`, "HISTORY", "", `Revision ${before.id}: “${short(m[1])}” called ${short(m[2])}; in ${rev.id} it no longer does.`).id;
    push(claimOf(store, rev.id, { assertion: `${short(m[2])} is no longer exercised by the test “${short(m[1])}”.`, claimClass: "diff-test-lost", evidenceIds: [ev], rationaleSummary: "A test-to-code link disappeared." }), "no longer tested", [m[2]]);
  }
  // Concept level: which capabilities do the changes belong to?
  const cards = store.concepts(rev.id);
  const touchedSet = new Set(touched);
  for (const c of cards.filter((x) => x.members.some((m) => touchedSet.has(m))).slice(0, 6)) {
    push(claimOf(store, rev.id, { assertion: `The concept “${c.title}” is affected: ${c.members.filter((m) => touchedSet.has(m)).map(name).join(", ")} changed.`, claimClass: "diff-concept", evidenceIds: c.evidenceIds.slice(0, 6), rationaleSummary: `A ${c.kind} card lists these elements as members.` }), "concept affected", c.members.filter((m) => touchedSet.has(m)));
  }
  v.consequences = consequences;

  // Historical strip: the commits that touched the changed files.
  if (isGitRepo(rev.repoRoot)) {
    const files = new Set(shown.map((id) => (B.get(id) ?? A.get(id))!.file));
    const strip = recentCommits(rev.repoRoot, 40).filter((c) => c.files.some((f) => files.has(f))).slice(0, 6);
    strip.forEach((c, i) => {
      const ev = observation(store, rev.id, `commit:${c.hash}`, "HISTORY", c.files.find((f) => files.has(f)) ?? "", `${c.hash.slice(0, 8)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`, c.date);
      v.nodes.push({ id: `n:commit:${c.hash}`, entityRefs: [], label: c.subject.slice(0, 40), kind: "commit", file: "", claimIds: [], evidenceIds: [ev.id], tier: "CONTEXT", displayMode: "FACT", unresolvedCalls: 0, role: "commit", pos: { x: (i - (strip.length - 1) / 2) * 150, y: shown.length * 64 + 70 }, badge: c.author, notes: [`${c.date.slice(0, 10)} by ${c.author}.`] });
    });
  }
  const parts = [`${changed.length} changed`, `${added.length} added`, `${removed.length} removed`];
  v.caption = `Between ${before.id.slice(0, 14)} and ${rev.id.slice(0, 14)}: ${parts.join(", ")} symbol(s); ${consequences.length} consequence(s). Before on the left, after on the right.`;
  v.meta = { kind: "diff", subject: before.id };
  v.params = { subject: before.id };
  if (touched.length > shown.length) v.gaps.push(`${touched.length - shown.length} more changed symbol(s) are not drawn; the consequences above still count them.`);
  v.gaps.push("Changes are detected per symbol by comparing the text of each symbol; a pure rename of a variable counts as a change.");
  return { view: v, claims };
}
