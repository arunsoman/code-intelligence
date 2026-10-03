// HypothesisGraph: a symptom (the pasted exception), ranked suspects, and the evidence that discriminates between them.
// Ranking is the six-factor salience score, so every position can be explained and cited.
import type { Claim, FactorScore, ViewEdge, ViewNode, ViewSpec } from "@cie/schema";
import { gateClaim } from "../claims.ts";
import { retrieveForQuestion } from "../retrieval.ts";
import { revisionIndex, WEIGHTS, type Scored } from "../salience.ts";
import type { RevisionRow, Store } from "../store.ts";
import { mapTrace } from "../trace.ts";
import { createHash } from "node:crypto";
import { testFactsFor, testsReaching } from "../testartifacts.ts";

const MAX_SUSPECTS = 6;
const LEGEND: ViewSpec["legend"] = [
  { label: "Fact", displayMode: "FACT", description: "On the stack or statically proven; click for the exact line." },
  { label: "Hypothesis", displayMode: "HYPOTHESIS", description: "A suspect or link that cannot be proven from the code alone; evidence shown." },
  { label: "Inference", displayMode: "INFERENCE", description: "Derived from cited evidence by the pipeline." },
  { label: "Fog", displayMode: "FOG", description: "Has calls static analysis could not resolve." },
  { label: "✓ Supported", displayMode: "FACT", description: "On the stack and raises the traced error class; the strongest kind of suspect." },
];

export interface HypothesisInput { trace: string; ignored?: string[]; pins?: string[] }

const top = (factors: FactorScore[], weights = WEIGHTS.hypothesis) =>
  [...factors].filter((f) => f.normalizedScore > 0).sort((a, b) => b.normalizedScore * weights[b.factor] - a.normalizedScore * weights[a.factor]).slice(0, 3);

export function buildHypothesis(store: Store, rev: RevisionRow, input: HypothesisInput): { view: ViewSpec; claims: Claim[] } | { error: string } {
  const mapped = mapTrace(store, rev, input.trace);
  const { parsed } = mapped;
  if (!parsed.errorClass && parsed.frames.length === 0) return { error: "I could not find an exception or stack frames in that text." };
  if (mapped.frames.length === 0) return { error: "None of the stack frames are in this repository, so there is nothing to investigate here." };

  const frameIdx = new Map<string, number>();
  mapped.frames.forEach((f, i) => { if (f.entityId && !frameIdx.has(f.entityId)) frameIdx.set(f.entityId, i); });
  const frameEv = new Map<string, string>();
  for (const f of mapped.frames) if (f.entityId && !frameEv.has(f.entityId)) frameEv.set(f.entityId, f.evidence.id);

  // Throw sites of the same error class anywhere in the repo are strong task evidence.
  const taskBoost = new Map<string, { value: number; reason: string; evidenceIds: string[] }>();
  if (parsed.errorClass) for (const f of store.factsByPredicate(rev.id, "throws")) {
    if ((f.object as any).value === parsed.errorClass) taskBoost.set(f.subject, { value: 1, reason: `throws ${parsed.errorClass}, the class in the trace`, evidenceIds: f.evidence.map((e) => e.id) });
  }
  const question = `${(parsed.errorClass ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")} ${parsed.message}`;
  const ignored = new Set(input.ignored ?? []);
  const r = retrieveForQuestion(store, rev.id, question, { maxNodes: 24, weights: WEIGHTS.hypothesis, frames: frameIdx, ignored, pins: new Set(input.pins), taskBoost, extraSeeds: [...frameIdx.keys()] });

  const symbolScores = [...r.scored.values()].filter((s) => r.tiers.has(s.id));
  const factorOf = (s: Scored, f: string) => s.factors.find((x) => x.factor === f)!;
  const kindOf = new Map(r.bundle.entities.map((e) => [e.entityId, e.kind]));
  const ranked = symbolScores
    .filter((s) => /^(function|method)$/.test(kindOf.get(s.id) ?? ""))
    .filter((s) => factorOf(s, "RUNTIME_HOTNESS").normalizedScore > 0 || taskBoost.has(s.id) || s.tier !== "CONTEXT")
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_SUSPECTS);
  const suspectIds = new Set(ranked.map((s) => s.id));

  const byId = new Map(r.bundle.entities.map((e) => [e.entityId, e]));
  const unresolvedBy = new Map<string, number>();
  for (const f of r.bundle.facts) if (f.resolution === "UNRESOLVED" && f.predicate === "calls") unresolvedBy.set(f.subject, (unresolvedBy.get(f.subject) ?? 0) + 1);
  const containsEv = new Map<string, string[]>();
  for (const x of r.bundle.relationships) if (x.kind === "contains") containsEv.set(x.to, x.evidence.map((e) => e.id));
  const hist = revisionIndex(store, rev.id).history;
  const tested = (id: string) => store.relationshipsFor(rev.id, id).some((x) => x.kind === "calls" && x.to === id && x.from.startsWith("test:"));

  const symptomId = "n:symptom";
  const nodes: ViewNode[] = [{
    id: symptomId, entityRefs: [], label: parsed.errorClass ? `${parsed.errorClass}: ${parsed.message}`.slice(0, 80) : "Exception", kind: "exception", file: mapped.frames[0]?.file ?? "",
    claimIds: [], evidenceIds: mapped.headEvidence ? [mapped.headEvidence.id] : [], tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0,
    role: "symptom", layer: 0, notes: ["Observed: pasted by you (not verified against a running system)."],
  }];
  const edges: ViewEdge[] = [];
  const claims: Claim[] = [];

  ranked.forEach((s, i) => {
    const e = byId.get(s.id)!;
    const notes: string[] = [];
    const idx = frameIdx.get(s.id);
    if (idx !== undefined) notes.push(idx === 0 ? "Top frame of the trace." : `On the stack (frame #${idx + 1}).`);
    const bst = taskBoost.get(s.id);
    if (bst) notes.push(`Raises ${parsed.errorClass} here (matches the trace).`);
    const h = hist.get(e.file);
    if (h) notes.push(`${e.file} last changed ${h.lastDate.slice(0, 10)} by ${h.author}: "${h.subject}".`);
    const { coverage } = testFactsFor(store, rev.id, s.id);
    const reaching = testsReaching(store, rev.id, s.id);
    const failingTests = reaching.filter((t) => t.status === "failed");
    if (failingTests.length) notes.push(`Failing test: “${failingTests[0].name}”${failingTests[0].message ? ` — ${failingTests[0].message}` : ""}.`);
    if (coverage) notes.push(`${coverage.percent}% of its lines are covered by tests (${coverage.covered}/${coverage.lines}).`);
    else if (!tested(s.id)) notes.push("No test directly exercises it.");
    if ((unresolvedBy.get(s.id) ?? 0) > 0) notes.push(`${unresolvedBy.get(s.id)} call(s) here are statically unresolvable.`);
    const strong = idx !== undefined && !!bst;
    const evidenceIds = [...(bst?.evidenceIds ?? []), ...failingTests.slice(0, 1).flatMap((t) => t.evidenceIds), ...(coverage?.evidenceIds ?? []), ...(frameEv.has(s.id) ? [frameEv.get(s.id)!] : []), ...(h?.evidenceId ? [h.evidenceId] : []), ...(containsEv.get(s.id) ?? [])];
    const neighbour = [...frameIdx.keys()].find((f) => f !== s.id && store.relationshipsFor(rev.id, s.id).some((x) => (x.from === f || x.to === f) && (x.kind === "calls" || x.kind === "async-flow")));
    const claim = gateClaim({
      assertion: `${e.name} may explain ${parsed.errorClass ?? "the exception"}: ${top(s.factors).map((f) => f.reason).join("; ")}.`,
      claimClass: "suspect", evidenceIds: [...new Set(evidenceIds)],
      rationaleSummary: `Rank ${i + 1} of ${ranked.length} by six-factor salience (score ${s.score.toFixed(2)}).`,
      structure: idx !== undefined ? undefined : neighbour ? { kind: "path", entityIds: [s.id, neighbour] } : undefined,
    }, r.bundle, { store, trusted: true });
    const claimFixed: Claim = claim;
    claims.push(claimFixed);
    const nodeId = `n:${s.id}`;
    nodes.push({
      id: nodeId, entityRefs: [s.id], label: e.name, kind: e.kind, file: e.file, claimIds: [claimFixed.draft.id], evidenceIds: [...new Set(evidenceIds)],
      tier: s.tier === "HIDDEN" ? "CONTEXT" : s.tier, displayMode: (unresolvedBy.get(s.id) ?? 0) > 0 ? "FOG" : claimFixed.displayMode === "HIDDEN" ? "HYPOTHESIS" : "FACT",
      unresolvedCalls: unresolvedBy.get(s.id) ?? 0, role: "suspect", rank: i + 1, score: s.score, factors: s.factors, notes, layer: 1,
      hypothesisState: strong ? "SUPPORTED" : "OPEN",
    });
    edges.push({
      id: `e:explains:${s.id}`, fromNodeId: nodeId, toNodeId: symptomId, kind: "may-explain", claimId: claimFixed.draft.id, evidenceIds: [...new Set(evidenceIds)],
      displayMode: claimFixed.displayMode === "HIDDEN" ? "HYPOTHESIS" : strong ? "INFERENCE" : "HYPOTHESIS", label: strong ? "explains" : "may explain",
    });
  });

  // Stack call chain between suspects/frames (deterministic edges).
  const shown = new Set(ranked.map((s) => s.id));
  for (const rel of r.bundle.relationships) {
    if ((rel.kind === "calls" || rel.kind === "async-flow") && shown.has(rel.from) && shown.has(rel.to)) {
      edges.push({ id: `e:${rel.id}`, fromNodeId: `n:${rel.from}`, toNodeId: `n:${rel.to}`, kind: rel.kind, relationshipId: rel.id, evidenceIds: rel.evidence.map((e) => e.id), displayMode: rel.kind === "async-flow" ? "INFERENCE" : "FACT", label: rel.label });
    }
  }

  const gaps: string[] = [];
  if (mapped.unmatched.length) gaps.push(`${mapped.unmatched.length} stack frame(s) are outside this repository and were not analysed.`);
  if (!parsed.errorClass) gaps.push("No exception class found in the trace; ranking uses stack position only.");
  const supported = nodes.filter((n) => n.hypothesisState === "SUPPORTED").length;
  const id = "view:hyp:" + createHash("sha256").update(rev.id + input.trace).digest("hex").slice(0, 10);
  const view: ViewSpec = {
    id, version: 1, revision: rev.id, taskId: "task:" + id, formId: "HypothesisGraph",
    caption: `${ranked.length} ranked suspect(s) for ${parsed.errorClass ?? "the exception"}${supported ? ` — ${supported} backed by both the stack and a matching throw site` : ""}. Dashed edges are hypotheses, not proof.`,
    question: `Investigate: ${parsed.errorClass ?? "exception"} ${parsed.message}`.trim(), level: 5, nodes, edges, groups: [], legend: LEGEND, cameraPolicy: { behavior: "PRESERVE" }, gaps,
    formReason: "You pasted a stack trace, so this is an investigation: suspects are ranked by how well they explain it.",
    hidden: r.hidden, ignored: [...ignored], investigation: { trace: input.trace, ignored: [...ignored] },
  };
  return { view, claims };
}
