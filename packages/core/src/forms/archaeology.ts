// V7 Archaeology Chain: why code became what it is. Every event is a commit that touched this code, every constraint is a
// comment in the code that still binds. Nothing is narrated by a model: the timeline is the grounded events.
import type { Claim, EvidenceRef, ViewNode } from "@cie/schema";
import { commentsAround, isGitRepo, symbolLog } from "../gitinfo.ts";
import type { RevisionRow, Store } from "../store.ts";
import { queryTerms } from "../retrieval.ts";
import { baseView, claimOf, emptyForm, hash, observation, readSource, short } from "./common.ts";

const STOP = new Set(["the", "for", "and", "not", "this", "that", "with", "from", "are", "was", "has", "have", "used", "when", "into"]);
const stems = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)));

export function pickSymbol(store: Store, rev: string, question: string, subject?: string) {
  const code = store.entities(rev).filter((e) => /^(function|method|class)$/.test(e.kind));
  const terms = subject ? [subject.toLowerCase()] : queryTerms(question).concat((question.match(/[A-Za-z_$][\w$]*/g) ?? []).map((w) => w.toLowerCase()));
  const exact = code.filter((e) => terms.includes(e.name.split(".").pop()!.toLowerCase()) || terms.includes(e.name.toLowerCase()));
  const loose = code.filter((e) => terms.some((t) => t.length > 3 && e.name.toLowerCase().includes(t)));
  return (exact.length ? exact : subject ? [] : loose).sort((a, b) => a.entityId.localeCompare(b.entityId))[0] ?? null;
}

export function buildArchaeology(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "Archaeology" as const, question, kind: "archaeology", caption: "", reason: "You asked why code is the way it is, so this is a timeline of the commits that shaped it, beside the constraints written in the code that still apply." };
  const e = pickSymbol(store, rev.id, question, subject);
  if (!e) return emptyForm(o, "I can't tell which code you mean. Name a function, e.g. “why is adjustBalance not transactional?”.");
  if (!isGitRepo(rev.repoRoot)) return emptyForm(o, "This folder is not a git repository, so there is no history to dig through.");
  const src = readSource(rev, e.file);
  const span = e.spans[0];
  const buf = src ? Buffer.from(src, "utf8") : null;
  const lineOf = (byte: number) => (buf ? buf.subarray(0, byte).toString("utf8").split("\n").length : 1);
  const a = span ? lineOf(span.startByte) : 1, b = span ? lineOf(span.endByteExclusive) : 1;
  const { commits, precise } = symbolLog(rev.repoRoot, e.file, a, b);
  if (commits.length === 0) return emptyForm(o, `No commits touch ${e.name} yet.`);

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const ordered = [...commits].reverse(); // oldest first, reading down
  ordered.forEach((c, i) => {
    const ev = observation(store, rev.id, `commit:${c.hash}:${e.entityId}`, "HISTORY", e.file, `${c.hash.slice(0, 8)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`, c.date);
    v.nodes.push({ id: `n:commit:${c.hash}`, entityRefs: [e.entityId], label: c.subject, kind: "commit", file: e.file, claimIds: [], evidenceIds: [ev.id], tier: i === ordered.length - 1 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "event", pos: { x: 0, y: i * 96 }, badge: `${c.date.slice(0, 10)} · ${c.author}`, notes: [`${c.hash.slice(0, 8)} on ${c.date.slice(0, 10)} by ${c.author}.`] });
    if (i > 0) v.edges.push({ id: `e:t:${i}`, fromNodeId: `n:commit:${ordered[i - 1].hash}`, toNodeId: `n:commit:${c.hash}`, kind: "then", evidenceIds: [ev.id], displayMode: "FACT" });
  });
  const last = ordered[ordered.length - 1];
  v.nodes.push({ id: `n:sym:${e.entityId}`, entityRefs: [e.entityId], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: store.relationshipsFor(rev.id, e.entityId).filter((r) => r.kind === "contains" && r.to === e.entityId).flatMap((r) => r.evidence.map((x) => x.id)), tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: "subject", pos: { x: 0, y: ordered.length * 96 }, notes: ["The code as it is now."] });
  v.edges.push({ id: "e:now", fromNodeId: `n:commit:${last.hash}`, toNodeId: `n:sym:${e.entityId}`, kind: "resulted in", evidenceIds: v.nodes.find((n) => n.id === `n:commit:${last.hash}`)!.evidenceIds, displayMode: "FACT" });

  // Constraints that still bind: comments in the code, cited by exact span.
  const found = src && span ? commentsAround(src, span.startByte, span.endByteExclusive) : [];
  found.slice(0, 6).forEach((cm, i) => {
    const ev: EvidenceRef = { id: "ev:" + hash(rev.id, "comment", e.file, String(cm.startByte)), sourceId: e.file, location: { kind: "CodeLocation", span: { sourceId: e.file, contentHash: span!.contentHash, revision: rev.id, startByte: cm.startByte, endByteExclusive: cm.endByte } }, class: "STATIC_PARSED", observedAt: new Date().toISOString(), accessScopeId: "local", state: "CURRENT" };
    store.putEvidence(rev.id, ev);
    v.nodes.push({ id: `n:con:${i}`, entityRefs: [e.entityId], label: cm.text.slice(0, 70), kind: "constraint", file: e.file, claimIds: [], evidenceIds: [ev.id], tier: cm.kind === "marker" ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "constraint", pos: { x: 360, y: i * 96 }, badge: cm.kind === "marker" ? "still binds" : cm.kind, notes: [`Comment on line ${cm.line}: “${cm.text}”`] });
    // Which commit likely introduced it? Only a claim, and only when the wording overlaps.
    const cs = stems(cm.text);
    const best = ordered.map((c) => ({ c, n: [...stems(c.subject)].filter((s) => cs.has(s)).length })).filter((x) => x.n >= 1).sort((p, q) => q.n - p.n)[0];
    if (best) {
      const cl = claimOf(store, rev.id, { assertion: `The commit “${best.c.subject}” likely introduced the constraint “${cm.text}”.`, claimClass: "archaeology-link", evidenceIds: [ev.id, v.nodes.find((n) => n.id === `n:commit:${best.c.hash}`)!.evidenceIds[0]], rationaleSummary: "Matched by overlapping wording between the commit message and the comment; not proven." });
      claims.push(cl);
      v.edges.push({ id: `e:link:${i}`, fromNodeId: `n:commit:${best.c.hash}`, toNodeId: `n:con:${i}`, kind: "likely introduced", claimId: cl.draft.id, evidenceIds: cl.draft.evidenceIds, displayMode: "HYPOTHESIS", label: "likely" });
      const n = v.nodes.find((x) => x.id === `n:con:${i}`)!; n.claimIds = [cl.draft.id];
    }
  });
  v.caption = `${commits.length} commit(s) shaped ${e.name}${precise ? "" : " (file-level: line history was unavailable)"}; ${found.length} constraint(s) in the code. Oldest first, reading down.`;
  v.meta = { kind: "archaeology", subject: e.entityId };
  v.params = { subject: short(e.entityId) };
  if (!found.length) v.gaps.push("There are no comments in this code explaining it; the commit messages are all there is.");
  v.gaps.push("Pull requests, tickets and incident records are not connected, so only commits and code comments appear; no model narration is added.");
  if (!precise) v.gaps.push("Line-level history was not available, so commits touching other parts of the file may appear.");
  return { view: v, claims };
}
