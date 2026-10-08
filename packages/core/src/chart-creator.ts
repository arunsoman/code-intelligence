// CIE chart creator: the model chooses a visual arrangement, but returns a bounded plan over
// indexed entities and relationships. Plans are compiled to ViewSpec, never executed as source.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChartOutput, ChartOutputV2, SCHEMA_CHART, SCHEMA_CHART_V2, type ChartDiagnostics, type ChartOutput as ChartPlan, type Claim, type EvidenceBundle, type ModelRequest, type ViewRoute, type ViewSpec } from "@cie/schema";
import { modelText } from "./claims.ts";
import type { RevisionRow } from "./store.ts";

export type { ChartDiagnostics } from "@cie/schema";

export const CHART_CREATOR_PROMPT = `You create a chart plan for Code Intelligence Explorer (CIE), not executable JavaScript, JSX, HTML, SVG, CSS, or shell code.
Choose the chart form that best answers the question. CIE renders the returned plan through its native interactive canvas, so every node must be an indexed code entity and every edge must be an indexed relationship.
Return JSON matching chart.v1. Use chartType for the chart name; choose layout flow, lanes, hierarchy, timeline, or network. Use only exact entityId, relationship id, and evidence ids from the supplied bundle. A node's evidenceIds must come from relationships touching that entity. An edge must exactly match one relationship's id, endpoints, and evidence. Never invent states, numeric values, runtime events, probabilities, or relationships. If the bundle cannot support a useful chart, return empty nodes and edges and explain the limitation in caption.
Keep the diagram focused: at most 40 nodes and 80 edges. Give each node a shape (process, decision, event, state, or external), integer column and row positions in the stated bounds. For lanes or timelines, provide short lane names and order nodes from left to right. Keep labels factual and concise.`;

export const CHART_CREATOR_PROMPT_V2 = `You create a chart plan for Code Intelligence Explorer (CIE), not executable JavaScript, JSX, HTML, SVG, CSS, or shell code.
Choose the chart form that best answers the question. CIE renders the returned plan through its native interactive canvas, so every node must be an indexed code entity and every edge must be an indexed relationship.
Return JSON matching chart.v2. Use chartType for the chart name; choose layout flow, lanes, hierarchy, timeline, or network. Use only exact entityId, relationship id, and evidence ids from the supplied bundle. A node's evidenceIds must come from relationships touching that entity. An edge must exactly match one relationship's id, endpoints, and evidence. Never invent states, numeric values, runtime events, probabilities, or relationships. If the bundle cannot support a useful chart, set nodes to [] and explain the limitation in caption.
Keep the diagram focused: at most 40 nodes and 80 edges. Give each node a shape (process, decision, event, state, or external), integer column and row positions in the stated bounds. For lanes or timelines, provide short lane names and order nodes from left to right. Keep labels factual and concise.

IMPORTANT — chartId rules:
- The selected chartId is provided to you in the instructions as "Selected chart type: <chartId>".
- You MUST preserve the chartId exactly as given; do NOT change it.
- Allowed chartId values: S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, S15, generic.
- If the available evidence is insufficient to fill the chart's required fields, set nodes: [] and explain in caption, but keep chartId unchanged.
- contractVersion must always be "chart.v2".

Notation hints per chartId:
- S3 (state-machine): populate states[] (id, label, evidenceIds, isInitial?, isFinal?) and transitions[] (from, to, trigger, guard?, evidenceIds, isIdempotentReplay?). states[] is required.
- S4, S9 (er-diagram): populate tables[] (id, name, columns[], evidenceIds) and relationships[] (fromTable, toTable, cardinality "1:1"|"1:N"|"N:M", fkColumn?, isInferred, evidenceIds). tables[] is required.
- S7 (bpmn): populate elements[] (id, kind "startEvent"|"endEvent"|"task"|"xorGateway"|"andGateway"|"intermediateEvent"|"compensation", label, laneId?, evidenceIds), flows[] (from, to, kind "sequence"|"message"|"default", condition?, evidenceIds), and lanes[] (id, label, participantId?, evidenceIds). elements[] is required.
- S8 (event-storming): populate elements[] (id, kind "command"|"domainEvent"|"policy"|"aggregate"|"readModel"|"externalSystem", label, band "commands"|"events"|"aggregates"|"readModels"|"external", orderHint, evidenceIds) and flows[] (from, to, kind "triggers"|"produces"|"consumes"|"reacts", isAsync, evidenceIds). Band placement is required.
- S10 (dfd): populate elements[] (id, kind "externalEntity"|"process"|"dataStore", label, level?, evidenceIds) and flows[] (from, to, label, kind "sync"|"async"|"persisted", evidenceIds). elements[] is required.
- S11 (decision-table): populate conditions[] (id, label, evidenceIds) and rules[] (id, values Record<conditionId,string>, outcome, outcomeEvidenceIds, evidenceIds, isCovered). conditions[] is required.
- S12 (saga): populate steps[] (id, label, kind "forward"|"compensation"|"retry", isIrreversible?, evidenceIds) and edges[] (from, to, kind "happyPath"|"failure"|"compensation"|"retry", triggerCondition?, evidenceIds). steps[] is required.
- S13 (outbox): populate elements[] (id, kind "writer"|"outboxStore"|"poller"|"consumer"|"deadLetter", label, evidenceIds) and flows[] (from, to, kind "transactionalWrite"|"poll"|"deliver"|"retry"|"deadLetter", isAtomic?, evidenceIds). elements[] is required.
- S14 (idempotency-matrix): populate operations[] (id, label, evidenceIds), scenarios[] (id, label) and cells[] (operationId, scenarioId, outcome "idempotent"|"noOp"|"rejected"|"unknown", mechanism?, keyScope?, evidenceIds). operations[] is required.
- S15 (di-wiring): populate components[] (id, label, kind "class"|"interface"|"factory", evidenceIds), bindings[] (from, to, injectionKind "constructor"|"field"|"factory"|"unknown", qualifier?, scope?, isUnresolved?, evidenceIds) and cycles[] (componentIds, evidenceIds). components[] is required.
- S1, S2, S5, S6, generic: use the standard nodes[] and edges[] fields only.`;

let cacheDir: string | undefined;
const cache = new Map<string, ChartPlan>();

export const chartPlanCacheKey = (bundle: EvidenceBundle, question: string, chartId?: string) => {
  if (chartId !== undefined) {
    return createHash("sha256").update(`chart.v2|${chartId}|${bundle.id}|${question}`).digest("hex");
  }
  return createHash("sha256").update(`chart.v1|${bundle.id}|${question}`).digest("hex");
};

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

export function chartCreatorRequest(question: string, bundle: EvidenceBundle, chartId?: string): ModelRequest {
  if (chartId !== undefined) {
    return {
      purpose: "CHART", schemaId: SCHEMA_CHART_V2, question, bundle, chartId,
      instructions: `${CHART_CREATOR_PROMPT_V2}\nSelected chart type: ${chartId}\nQuestion: ${JSON.stringify(question)}`,
    };
  }
  return { purpose: "CHART", schemaId: SCHEMA_CHART, question, bundle, instructions: `${CHART_CREATOR_PROMPT}\nQuestion: ${JSON.stringify(question)}` };
}

/** Returns a warning when the model changed the chartId from the requested value. */
export function validateChartIdNotChanged(plan: ChartOutputV2, requestedChartId: string): { ok: boolean; warning?: string } {
  if (plan.chartId !== requestedChartId) {
    return { ok: false, warning: `Chart creator changed chartId from "${requestedChartId}" to "${plan.chartId}"; the original chartId has been restored.` };
  }
  return { ok: true };
}

function legendEntriesForChartId(chartId: string): ViewSpec["legend"] {
  switch (chartId) {
    case "S3": // state-machine
      return [
        { label: "Initial state", displayMode: "FACT", description: "The starting state of the state machine." },
        { label: "Terminal state", displayMode: "FACT", description: "A final accepting state of the state machine." },
        { label: "Idempotent replay", displayMode: "INFERENCE", description: "A transition that can be safely replayed without side effects." },
      ];
    case "S4":
    case "S9": // er-diagram
      return [
        { label: "Primary key", displayMode: "FACT", description: "Column is the primary key of its table." },
        { label: "Foreign key", displayMode: "FACT", description: "Column references a primary key in another table." },
        { label: "Inferred relationship", displayMode: "INFERENCE", description: "Relationship inferred from naming conventions or code patterns, not an explicit foreign-key constraint." },
      ];
    case "S7": // bpmn
      return [
        { label: "Start/End event", displayMode: "FACT", description: "Process start or end boundary event." },
        { label: "XOR gateway", displayMode: "FACT", description: "Exclusive decision: exactly one outgoing path is taken." },
        { label: "Compensation", displayMode: "INFERENCE", description: "A compensating activity that undoes an earlier step." },
      ];
    case "S8": // event-storming
      return [
        { label: "Command", displayMode: "FACT", description: "An intent to change state, issued by a user or system." },
        { label: "Domain event", displayMode: "FACT", description: "A fact that has occurred in the domain." },
        { label: "Aggregate", displayMode: "INFERENCE", description: "A consistency boundary that handles commands and emits events." },
        { label: "Policy", displayMode: "INFERENCE", description: "A reactive rule that listens to events and issues commands." },
      ];
    case "S10": // dfd
      return [
        { label: "External entity", displayMode: "FACT", description: "A data source or sink outside the system boundary." },
        { label: "Process", displayMode: "FACT", description: "A transformation of data flows." },
        { label: "Data store", displayMode: "FACT", description: "A repository of data at rest." },
      ];
    case "S11": // decision-table
      return [
        { label: "Covered rule", displayMode: "FACT", description: "This rule combination is reached by at least one test." },
        { label: "Uncovered rule", displayMode: "HYPOTHESIS", description: "This rule combination has no known test coverage." },
      ];
    case "S12": // saga
      return [
        { label: "Forward step", displayMode: "FACT", description: "A step on the happy path." },
        { label: "Compensation step", displayMode: "INFERENCE", description: "A step that undoes a previous forward step." },
        { label: "Irreversible step", displayMode: "HYPOTHESIS", description: "A step that cannot be compensated once committed." },
      ];
    case "S13": // outbox
      return [
        { label: "Transactional write", displayMode: "FACT", description: "Write to the outbox store inside the same transaction as the business change." },
        { label: "At-least-once delivery", displayMode: "INFERENCE", description: "Messages may be delivered more than once; consumers must be idempotent." },
        { label: "Dead letter", displayMode: "HYPOTHESIS", description: "Messages that could not be delivered after retries." },
      ];
    case "S14": // idempotency-matrix
      return [
        { label: "Idempotent", displayMode: "FACT", description: "Repeating the operation has no additional effect." },
        { label: "No-op", displayMode: "FACT", description: "The operation has no effect in this scenario." },
        { label: "Rejected", displayMode: "FACT", description: "The operation is rejected (e.g. duplicate key error)." },
        { label: "Unknown", displayMode: "FOG", description: "Idempotency behaviour under this scenario could not be determined." },
      ];
    case "S15": // di-wiring
      return [
        { label: "Constructor injection", displayMode: "FACT", description: "Dependency injected via constructor parameter." },
        { label: "Field injection", displayMode: "INFERENCE", description: "Dependency injected into a field directly." },
        { label: "Unresolved binding", displayMode: "FOG", description: "The binding target could not be statically resolved." },
        { label: "Cycle", displayMode: "HYPOTHESIS", description: "A circular dependency chain was detected." },
      ];
    default:
      return [];
  }
}

export function compileChartPlan(o: { plan: ChartPlan; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
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
    if (!evidenceIds.length) { gaps.push(`"${entity.name}" was omitted because the chart plan did not cite supporting current evidence.`); continue; }
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

  const chartId = o.chartId;
  const chartSpecificLegend = chartId ? legendEntriesForChartId(chartId) : [];

  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart", caption,
    question: o.question, level: 5, nodes, edges,
    groups: o.plan.layout === "lanes" || o.plan.layout === "timeline" ? laneNames.map((name): ViewSpec["groups"][number] => ({ id: `g:lane:${name}`, label: name, kind: "lane", childNodeIds: nodes.filter((n) => n.lane === name).map((n) => n.id), level: 1, evidenceIds: [...new Set(nodes.filter((n) => n.lane === name).flatMap((n) => n.evidenceIds))], displayMode: "INFERENCE" })) : [],
    legend: [
      { label: "Code fact", displayMode: "FACT", description: "Element or connection is linked to current indexed evidence; click to inspect it." },
      { label: "Generated layout", displayMode: "INFERENCE", description: "The chart type and arrangement were proposed by the chart creator." },
      ...chartSpecificLegend,
    ],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} layout from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, ...(chartId ? { subject: chartId } : {}) },
    params: { chartType, chartLayout: o.plan.layout, ...(chartId ? { chartId } : {}) },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: chartId ?? "generic",
    contractVersion: chartId ? "chart.v2" : "chart.v1",
    provider: "",
    model: "",
    cacheHit: false,
    schemaValidationPassed: true,
    suppliedEntities: o.bundle.entities.length,
    suppliedRelationships: o.bundle.relationships.length,
    suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length,
    omittedNodes: o.plan.nodes.length - nodes.length,
    gaps,
  };

  return { view, claims: [], diagnostics };
}
