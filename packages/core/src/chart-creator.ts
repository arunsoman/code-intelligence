// CIE chart creator: the model chooses a visual arrangement, but returns a bounded plan over
// indexed entities and relationships. Plans are compiled to ViewSpec, never executed as source.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChartOutput, SCHEMA_CHART, type ChartOutput as ChartPlan, type Claim, type EvidenceBundle, type ModelRequest, type ViewRoute, type ViewSpec } from "@cie/schema";
import { modelText } from "./claims.ts";
import type { RevisionRow } from "./store.ts";

export const CHART_CREATOR_PROMPT = `You create a chart plan for Code Intelligence Explorer (CIE), not executable JavaScript, JSX, HTML, SVG, CSS, or shell code.
Choose the chart form that best answers the question. CIE renders the returned plan through its native interactive canvas, so every node must be an indexed code entity and every edge must be an indexed relationship.
Return JSON matching chart.v1. Use chartType for the chart name; choose layout flow, lanes, hierarchy, timeline, or network. Use only exact entityId, relationship id, and evidence ids from the supplied bundle. A node's evidenceIds must come from relationships touching that entity. An edge must exactly match one relationship's id, endpoints, and evidence. Never invent states, numeric values, runtime events, probabilities, or relationships. If the bundle cannot support a useful chart, return empty nodes and edges and explain the limitation in caption.
Keep the diagram focused: at most 40 nodes and 80 edges. Give each node a shape (process, decision, event, state, or external), integer column and row positions in the stated bounds. For lanes or timelines, provide short lane names and order nodes from left to right. Keep labels factual and concise.`;

let cacheDir: string | undefined;
const cache = new Map<string, ChartPlan>();
export const chartPlanCacheKey = (bundle: EvidenceBundle, question: string) => createHash("sha256").update(`chart.v1|${bundle.id}|${question}`).digest("hex");

/** Return a validated cached plan from this process's private temp directory, if one exists. */
export function cachedChartPlan(bundle: EvidenceBundle, question: string): ChartPlan | null {
  const key = chartPlanCacheKey(bundle, question);
  const known = cache.get(key);
  if (known) return known;
  if (!cacheDir) return null;
  try {
    const parsed = ChartOutput.safeParse(JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8")));
    if (!parsed.success) return null;
    cache.set(key, parsed.data);
    return parsed.data;
  } catch { return null; }
}

export function rememberChartPlan(bundle: EvidenceBundle, question: string, plan: ChartPlan): void {
  const parsed = ChartOutput.safeParse(plan);
  if (!parsed.success) return;
  const key = chartPlanCacheKey(bundle, question), value = parsed.data;
  cache.set(key, value);
  try {
    cacheDir ??= mkdtempSync(join(tmpdir(), "cie-generated-charts-"));
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify(value), { mode: 0o600, flag: "wx" });
  } catch { /* Temp caching is an optimization; a validated in-memory plan still works. */ }
}

export function chartCreatorRequest(question: string, bundle: EvidenceBundle): ModelRequest {
  return { purpose: "CHART", schemaId: SCHEMA_CHART, question, bundle, instructions: `${CHART_CREATOR_PROMPT}\nQuestion: ${JSON.stringify(question)}` };
}

export function compileChartPlan(o: { plan: ChartPlan; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute }): { view: ViewSpec; claims: Claim[] } {
  const entities = new Map(o.bundle.entities.filter((e) => e.kind !== "file").map((e) => [e.entityId, e]));
  const evidence = new Map(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => [e.id, e]));
  const relationships = new Map(o.bundle.relationships.map((r) => [r.id, r]));
  const support = new Map<string, Set<string>>();
  for (const r of o.bundle.relationships) {
    for (const id of [r.from, r.to]) {
      const ids = support.get(id) ?? new Set<string>();
      r.evidence.forEach((e) => { if (evidence.has(e.id)) ids.add(e.id); });
      support.set(id, ids);
    }
  }
  const gaps: string[] = [];
  const nodes: ViewSpec["nodes"] = [];
  const laneNames: string[] = [];
  const byEntity = new Map<string, string>();
  for (const spec of o.plan.nodes) {
    const entity = entities.get(spec.entityId), allowed = support.get(spec.entityId);
    if (!entity || !allowed) { gaps.push(`A generated chart element referencing an unknown entity was omitted.`); continue; }
    if (byEntity.has(spec.entityId)) continue;
    const evidenceIds = spec.evidenceIds.filter((id) => allowed.has(id));
    if (!evidenceIds.length) { gaps.push(`“${entity.name}” was omitted because the chart plan did not cite supporting current evidence.`); continue; }
    const lane = spec.lane?.trim().slice(0, 80) || undefined;
    if (lane && !laneNames.includes(lane)) laneNames.push(lane);
    const id = `n:${entity.entityId}`;
    byEntity.set(entity.entityId, id);
    const role = { process: "step", decision: "decision", event: "event", state: "state", external: "external" }[spec.shape];
    nodes.push({ id, entityRefs: [entity.entityId], label: entity.name, kind: entity.kind, file: entity.file, claimIds: [], evidenceIds, tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role, ...(lane ? { lane } : {}), pos: { x: spec.column * 210, y: (spec.row + (lane ? laneNames.indexOf(lane) * 2 : 0)) * 110 } });
  }
  const edges: ViewSpec["edges"] = [];
  for (const spec of o.plan.edges) {
    const rel = relationships.get(spec.relationshipId);
    if (!rel || rel.from !== spec.from || rel.to !== spec.to || !byEntity.has(rel.from) || !byEntity.has(rel.to)) { gaps.push("A generated chart connection that did not match an indexed relationship was omitted."); continue; }
    const valid = new Set(rel.evidence.map((e) => e.id));
    const evidenceIds = spec.evidenceIds.filter((id) => valid.has(id) && evidence.has(id));
    if (evidenceIds.length === 0) { gaps.push("A generated chart connection without supporting current evidence was omitted."); continue; }
    edges.push({ id: `ge:${rel.id}`, fromNodeId: byEntity.get(rel.from)!, toNodeId: byEntity.get(rel.to)!, kind: rel.kind, relationshipId: rel.id, label: spec.label || rel.label, evidenceIds, displayMode: "FACT" });
  }
  if (o.plan.nodes.length > 0 && nodes.length === 0) gaps.push("The requested chart could not be grounded in this revision's indexed evidence.");
  if (o.plan.nodes.length === 0) gaps.push("The chart creator found no useful code elements in the available evidence.");
  const chartType = modelText(o.plan.chartType, "custom").text;
  const caption = `${chartType} chart · ${modelText(o.plan.caption, "Arranged from indexed code relationships.").text}`;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart", caption,
    question: o.question, level: 5, nodes, edges,
    groups: o.plan.layout === "lanes" || o.plan.layout === "timeline" ? laneNames.map((name): ViewSpec["groups"][number] => ({ id: `g:lane:${name}`, label: name, kind: "lane", childNodeIds: nodes.filter((n) => n.lane === name).map((n) => n.id), level: 1, evidenceIds: [...new Set(nodes.filter((n) => n.lane === name).flatMap((n) => n.evidenceIds))], displayMode: "INFERENCE" })) : [],
    legend: [
      { label: "Code fact", displayMode: "FACT", description: "Element or connection is linked to current indexed evidence; click to inspect it." },
      { label: "Generated layout", displayMode: "INFERENCE", description: "The chart type and arrangement were proposed by the chart creator." },
    ],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} layout from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType }, params: { chartType, chartLayout: o.plan.layout },
  };
  return { view, claims: [] };
}
