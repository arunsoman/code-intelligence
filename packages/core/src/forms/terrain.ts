// V16 Change-Risk Terrain: how hard each part of the code is to change, composed from grounded measures. It is a composite,
// labelled as one: the formula is shown, the weights are yours to tune, and data that is missing is shown as missing.
import type { Claim, TerrainCell, ViewNode } from "@cie/schema";
import { authorCounts, isGitRepo } from "../gitinfo.ts";
import { runtimeHotness } from "../hotness.ts";
import type { RevisionRow, Store } from "../store.ts";
import { baseView, claimOf, emptyForm, flowGraph, observation } from "./common.ts";

export const FACTORS = [
  { id: "coupling", label: "Coupling", description: "How many call and async links the file's code has with other code." },
  { id: "churn", label: "Churn", description: "How often the file has been changed (commits)." },
  { id: "incidents", label: "Incidents", description: "Reported exceptions and failing tests that point at the file." },
  { id: "testGap", label: "Test gap", description: "How little of the file's code is covered by tests." },
  { id: "knowledge", label: "Thin knowledge", description: "How concentrated the knowledge of the file is in few people." },
] as const;
export const PRESETS: Record<string, Record<string, number>> = {
  default: { coupling: 0.25, churn: 0.2, incidents: 0.2, testGap: 0.2, knowledge: 0.15 },
  security: { coupling: 0.35, churn: 0.1, incidents: 0.3, testGap: 0.15, knowledge: 0.1 },
  refactor: { coupling: 0.35, churn: 0.25, incidents: 0.1, testGap: 0.2, knowledge: 0.1 },
  incident: { coupling: 0.1, churn: 0.15, incidents: 0.5, testGap: 0.15, knowledge: 0.1 },
};

export function buildTerrain(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const task = subject && subject in PRESETS ? subject : /\b(security|trust|attack)\b/i.test(question) ? "security" : /\b(refactor|restructure|rewrite|migrate)\b/i.test(question) ? "refactor" : /\b(incident|outage|failing|broken)\b/i.test(question) ? "incident" : "default";
  const o = { rev, form: "ChangeRisk" as const, question, kind: "terrain", caption: "", reason: "You asked where change is risky, so each file is a region of a relief map: warm ridges are hard to change safely, cool valleys are safe. It is a composite of measures, never a fact." };
  const flow = flowGraph(store, rev.id);
  const files = store.entities(rev.id).filter((e) => e.kind === "file" && (flow.byFile.get(e.file)?.length ?? 0) > 0);
  if (!files.length) return emptyForm(o, "There are no source files to assess.");
  const git = isGitRepo(rev.repoRoot);
  const hot = runtimeHotness(store, rev);
  const degree = (file: string) => (flow.byFile.get(file) ?? []).reduce((n, e) => n + (flow.out.get(e.entityId)?.length ?? 0) + (flow.inn.get(e.entityId)?.length ?? 0), 0);
  const raw = files.map((f) => {
    const hist = store.factsFor(rev.id, f.entityId).find((x) => x.predicate === "history");
    const hv = hist ? ((hist.object as unknown) as { value: { commits: number; authors: number } }).value : null;
    const cov = store.factsFor(rev.id, f.entityId).find((x) => x.predicate === "coverage");
    const cv = cov ? ((cov.object as unknown) as { value: { percent: number; lines: number; covered: number } }).value : null;
    const hits = (flow.byFile.get(f.file) ?? []).map((e) => hot.get(e.entityId)).filter((h): h is NonNullable<typeof h> => !!h);
    return { f, hv, hist, cv, cov, hits, coupling: degree(f.file), size: (flow.byFile.get(f.file) ?? []).length };
  });
  const maxC = Math.max(1, ...raw.map((r) => r.coupling)), maxH = Math.max(1, ...raw.map((r) => r.hv?.commits ?? 0));
  const maxI = Math.max(1, ...raw.map((r) => r.hits.reduce((n, h) => n + h.value, 0)));
  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const cells: TerrainCell[] = [];
  const weights = PRESETS[task];
  const compose = (fs: Record<string, number>) => Object.entries(weights).reduce((s, [k, w]) => s + w * (fs[k] ?? 0.5), 0) / Object.values(weights).reduce((a, b) => a + b, 0);
  let thin = 0;
  for (const r of raw) {
    const missing: string[] = [];
    const incidents = r.hits.reduce((n, h) => n + h.value, 0);
    const factors: Record<string, number> = {
      coupling: r.coupling / maxC,
      churn: r.hv ? r.hv.commits / maxH : (missing.push("churn"), 0.5),
      incidents: incidents / maxI,
      testGap: r.cv ? 1 - r.cv.percent / 100 : (missing.push("testGap"), 0.5),
      knowledge: r.hv ? 1 / Math.max(1, r.hv.authors) : (missing.push("knowledge"), 0.5),
    };
    const authors = git ? authorCounts(rev.repoRoot, r.f.file) : [];
    const rawText: Record<string, string> = {
      coupling: `${r.coupling} link(s)`, churn: r.hv ? `${r.hv.commits} commit(s)` : "no data", incidents: r.hits.length ? r.hits.slice(0, 2).map((h) => h.reason).join("; ") : "none reported",
      testGap: r.cv ? `${r.cv.percent}% covered (${r.cv.covered}/${r.cv.lines} lines)` : "no coverage data", knowledge: r.hv ? `${r.hv.authors} author(s)${authors[0] ? `, most by ${authors[0].author}` : ""}` : "no data",
    };
    const evidenceIds = [...(r.hist?.evidence.map((e) => e.id) ?? []), ...(r.cov?.evidence.map((e) => e.id) ?? []), ...r.hits.flatMap((h) => h.evidenceIds).slice(0, 3)];
    if (evidenceIds.length === 0) evidenceIds.push(observation(store, rev.id, `terrain:${r.f.file}`, "HISTORY", r.f.file, `${r.f.file}: ${r.coupling} link(s), ${r.size} symbol(s); no history, coverage or incident data.`).id);
    if (missing.length >= 3) thin++;
    const cell: TerrainCell = { id: `n:cell:${r.f.file}`, label: r.f.file.split("/").slice(-2).join("/"), file: r.f.file, factors, raw: rawText, evidenceIds, area: Math.max(1, r.size), entityIds: [r.f.entityId], note: missing.length ? `Missing data (counted as a neutral 0.5): ${missing.join(", ")}.` : undefined };
    cells.push(cell);
  }
  const ranked = [...cells].sort((a, b) => compose(b.factors) - compose(a.factors));
  for (const c of cells) {
    const risk = compose(c.factors);
    const top = Object.entries(c.factors).sort((a, b) => b[1] * (weights[b[0]] ?? 0) - a[1] * (weights[a[0]] ?? 0)).slice(0, 2).map(([k]) => FACTORS.find((f) => f.id === k)!.label.toLowerCase());
    const node: ViewNode = { id: c.id, entityRefs: c.entityIds, label: c.label, kind: "file", file: c.file, claimIds: [], evidenceIds: c.evidenceIds, tier: risk > 0.55 ? "CRITICAL" : "RELEVANT", displayMode: c.note ? "FOG" : "FACT", unresolvedCalls: 0, role: "cell", heat: { value: risk, label: `risk ${Math.round(risk * 100)}%: driven by ${top.join(" and ")}` }, notes: [...FACTORS.map((f) => `${f.label}: ${Math.round(c.factors[f.id] * 100)}% (${c.raw[f.id]})`), ...(c.note ? [c.note] : [])], pos: { x: 0, y: 0 } };
    if (ranked.indexOf(c) < 3 && risk > 0.45) {
      const cl = claimOf(store, rev.id, { assertion: `${c.label} is among the hardest places to change safely (composite risk ${Math.round(risk * 100)}%, driven by ${top.join(" and ")}).`, claimClass: "change-risk", evidenceIds: c.evidenceIds, rationaleSummary: `A composite of five measures (${Object.entries(weights).map(([k, w]) => `${k} ${w}`).join(", ")}); the metaphor is not a fact.` });
      claims.push(cl); node.claimIds = [cl.draft.id]; node.ownClaimId = cl.draft.id; node.displayMode = node.displayMode === "FOG" ? "FOG" : "INFERENCE";
    }
    v.nodes.push(node);
  }
  v.terrain = { cells, factors: FACTORS.map((f) => ({ ...f, weight: weights[f.id] })), formula: "risk = Σ weight × factor ÷ Σ weight, where each factor is scaled 0–1 across this repository; missing data counts as a neutral 0.5 and is flagged." };
  v.caption = `Change-risk terrain for ${cells.length} file(s), weighted for ${task === "default" ? "general change" : task + " work"}. Hardest: ${ranked.slice(0, 3).map((c) => c.label).join(", ")}. Drag the weights to re-shape it.`;
  v.meta = { kind: "terrain", subject: task };
  v.params = { subject: task };
  if (thin) v.gaps.push(`${thin} file(s) have little or no history, coverage or incident data; they are drawn in fog, and their position on the map is mostly the neutral default.`);
  v.gaps.push("Planning a route across the terrain and comparing terrains over time are not built.");
  v.gaps.push("The terrain is a composite of measures with tunable weights; it is a way to see where to look, not a statement of fact.");
  return { view: v, claims };
}
