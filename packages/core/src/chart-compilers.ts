import { stateTransitionLabel, type StateSpec } from "@cie/schema";
import { erColumnLabel, type ErSpec } from "@cie/schema";
// CIE chart creator: the model chooses a visual arrangement, but returns a bounded plan over
// indexed entities and relationships. Plans are compiled to ViewSpec, never executed as source.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChartDiagnostics, ChartPlanStateMachine, ChartPlanErDiagram, ChartPlanBpmn, ChartPlanEventStorming, ChartPlanDfd, ChartPlanDecisionTable, ChartPlanSaga, ChartPlanOutbox, ChartPlanIdempotencyMatrix, ChartPlanDiWiring, ChartPlanPackageDiagram, ChartPlanCommunication, ChartPlanInteractionOverview, ChartPlanCrcCards, ChartPlanCallGraph, ChartPlanLayeredArchitecture, ChartPlanModuleGraph, ChartPlanStateTransitionTable, ChartPlanFmeaMatrix, ChartPlanMetricsMap, ChartPlanC4Context, ChartPlanSequence, ChartPlanGeneric } from "@cie/schema";
import { ChartOutput, ChartOutputV2, CHART_REGISTRY, SCHEMA_CHART, SCHEMA_CHART_V2, type ChartId, type ChartOutput as ChartPlan, type ChartOutputV2 as ChartPlanV2, type Claim, type EvidenceBundle, type ModelRequest, type ModelRunRef, type ViewRoute, type ViewSpec, type ViewGroup, type DisplayMode } from "@cie/schema";
import { gateClaim, modelText } from "./claims.ts";
import type { RevisionRow } from "./store.ts";

export type { ChartDiagnostics } from "@cie/schema";
export interface ChartCompileDiag { provider?: string; model?: string; cacheHit: boolean; schemaValidationPassed: boolean; fallbackReason?: string }

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
- Allowed chartId values: S1–S28, generic.
- If the available evidence is insufficient to fill the chart's required fields, set nodes: [] and explain in caption, but keep chartId unchanged.
- contractVersion must always be "chart.v2".

Notation hints per chartId:
- S3 (state-machine): populate states[] (id, label, evidenceIds, isInitial?, isFinal?) and transitions[] (from, to, trigger, guard?, evidenceIds, isIdempotentReplay?). states[] is required.
- S4, S9 (er-diagram): populate tables[] (id, name, columns[], evidenceIds) and relationships[] (fromTable, toTable, cardinality "1:1"|"1:N"|"N:M", fkColumn?, isInferred, evidenceIds). tables[] is required.
- For S4/S9, indexed Java JPA entities are available as kind "table", their persistent members as kind "column", and their annotation evidence as persisted_table / persisted_column facts. Use those AST facts alongside migrations; do not require a migration when the source declares the mapping.
- S7 (bpmn): populate elements[] (id, kind "startEvent"|"endEvent"|"task"|"xorGateway"|"andGateway"|"intermediateEvent"|"compensation", label, laneId?, evidenceIds), flows[] (from, to, kind "sequence"|"message"|"default", condition?, evidenceIds), and lanes[] (id, label, participantId?, evidenceIds). elements[] is required.
- S8 (event-storming): populate elements[] (id, kind "command"|"domainEvent"|"policy"|"aggregate"|"readModel"|"externalSystem", label, band "commands"|"events"|"aggregates"|"readModels"|"external", orderHint, evidenceIds) and flows[] (from, to, kind "triggers"|"produces"|"consumes"|"reacts", isAsync, evidenceIds). Band placement is required.
- S10 (dfd): populate elements[] (id, kind "externalEntity"|"process"|"dataStore", label, level?, evidenceIds) and flows[] (from, to, label, kind "sync"|"async"|"persisted", evidenceIds). elements[] is required.
- S11 (decision-table): populate conditions[] (id, label, evidenceIds) and rules[] (id, values Record<conditionId,string>, outcome, outcomeEvidenceIds, evidenceIds, isCovered). conditions[] is required.
- S12 (saga): populate steps[] (id, label, kind "forward"|"compensation"|"retry", isIrreversible?, evidenceIds) and edges[] (from, to, kind "happyPath"|"failure"|"compensation"|"retry", triggerCondition?, evidenceIds). steps[] is required.
- S13 (outbox): populate elements[] (id, kind "writer"|"outboxStore"|"poller"|"consumer"|"deadLetter", label, evidenceIds) and flows[] (from, to, kind "transactionalWrite"|"poll"|"deliver"|"retry"|"deadLetter", isAtomic?, evidenceIds). elements[] is required.
- S14 (idempotency-matrix): populate operations[] (id, label, evidenceIds), scenarios[] (id, label) and cells[] (operationId, scenarioId, outcome "idempotent"|"noOp"|"rejected"|"unknown", mechanism?, keyScope?, evidenceIds). operations[] is required.
- S15 (di-wiring): populate components[] (id, label, kind "class"|"interface"|"factory", evidenceIds), bindings[] (from, to, injectionKind "constructor"|"field"|"factory"|"unknown", qualifier?, scope?, isUnresolved?, evidenceIds) and cycles[] (componentIds, evidenceIds). components[] is required.
- S16 (UML class): include every supplied class/interface/enum and populate attributes[] from supplied field entities and operations[] from supplied method entities/signature facts. Use each member's own source evidenceIds; do not return name-only class boxes when members are present in the bundle.
- S1, S2, S5, S6, generic: use the standard nodes[] and edges[] fields only.`;

let cacheDir: string | undefined;
const cache = new Map<string, ChartPlan | ChartPlanV2>();

export const chartPlanCacheKey = (bundle: EvidenceBundle, question: string, chartId?: string) => {
  if (chartId !== undefined) {
    const promptVersion = CHART_REGISTRY[chartId as ChartId]?.version ?? 0;
    const promptHash = createHash("sha256").update(CHART_CREATOR_PROMPT_V2).digest("hex").slice(0, 12);
    return createHash("sha256").update(`chart.v2|${chartId}|definition-${promptVersion}|prompt-${promptHash}|${bundle.id}|${question}`).digest("hex");
  }
  return createHash("sha256").update(`chart.v1|${bundle.id}|${question}`).digest("hex");
};

/** Return a validated cached plan from this process's private temp directory, if one exists. */
export function cachedChartPlan(bundle: EvidenceBundle, question: string, chartId?: string): ChartPlan | ChartPlanV2 | null {
  const key = chartPlanCacheKey(bundle, question, chartId);
  const known = cache.get(key);
  if (known) return known;
  if (!cacheDir) return null;
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8"));
    const parsed = chartId !== undefined ? ChartOutputV2.safeParse(raw) : ChartOutput.safeParse(raw);
    if (!parsed.success) return null;
    // Check chartId match if requested (safe because parsed.data is validated)
    if (chartId !== undefined && (parsed.data as { chartId?: string }).chartId !== chartId) return null;
    cache.set(key, parsed.data);
    return parsed.data;
  } catch { return null; }
}

export function rememberChartPlan(bundle: EvidenceBundle, question: string, plan: ChartPlan | ChartPlanV2): void {
  const chartId = (plan as { chartId?: string }).chartId;
  const parsed = chartId !== undefined ? ChartOutputV2.safeParse(plan) : ChartOutput.safeParse(plan);
  if (!parsed.success) return;
  const key = chartPlanCacheKey(bundle, question, chartId), value = parsed.data;
  cache.set(key, value);
  try {
    cacheDir ??= mkdtempSync(join(tmpdir(), "cie-generated-charts-"));
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify(value), { mode: 0o600, flag: "w" });
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
    return { ok: false, warning: `Chart creator returned "${plan.chartId}" for a request for "${requestedChartId}"; the mismatched plan was rejected.` };
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
    case "S16": // UML class diagram
      return [
        { label: "UML class", displayMode: "FACT", description: "A class declaration with attributes and operations." },
        { label: "UML interface", displayMode: "FACT", description: "An interface declaration." },
        { label: "UML enum", displayMode: "FACT", description: "An enum declaration." },
        { label: "Inheritance", displayMode: "FACT", description: "Extends relationship between classes." },
        { label: "Realization", displayMode: "FACT", description: "Implements relationship (interface implementation)." },
        { label: "Association", displayMode: "INFERENCE", description: "A semantic relationship between classes." },
      ];
    case "S17": // UML package diagram
      return [
        { label: "Package", displayMode: "FACT", description: "A namespace containing members." },
        { label: "Dependency", displayMode: "FACT", description: "A dependency from one package to another." },
      ];
    case "S18": // UML communication diagram
      return [
        { label: "Participant", displayMode: "FACT", description: "An object or actor in the interaction." },
        { label: "Sync message", displayMode: "FACT", description: "A synchronous message call." },
        { label: "Async message", displayMode: "INFERENCE", description: "An asynchronous message." },
        { label: "Return message", displayMode: "INFERENCE", description: "A return message from a call." },
      ];
    case "S19": // UML interaction overview
      return [
        { label: "Interaction frame", displayMode: "FACT", description: "A nested interaction reference." },
        { label: "Decision frame", displayMode: "INFERENCE", description: "A decision point in the interaction." },
        { label: "Sequence flow", displayMode: "FACT", description: "Ordering of messages between frames." },
      ];
    case "S20": // CRC cards
      return [
        { label: "Class responsibility", displayMode: "FACT", description: "A responsibility of the class." },
        { label: "Collaborator", displayMode: "INFERENCE", description: "Another class this class interacts with." },
      ];
    case "S21": // call graph
      return [
        { label: "Function", displayMode: "FACT", description: "A standalone function." },
        { label: "Method", displayMode: "FACT", description: "A method belonging to a class." },
        { label: "Call edge", displayMode: "FACT", description: "A resolved call relationship." },
      ];
    case "S22": // layered architecture
      return [
        { label: "Layer", displayMode: "FACT", description: "An architectural layer." },
        { label: "Component", displayMode: "FACT", description: "A component within a layer." },
        { label: "Uses edge", displayMode: "FACT", description: "A dependency between layers." },
      ];
    case "S23": // dependency / module graph
      return [
        { label: "Module", displayMode: "FACT", description: "A module, package, or crate." },
        { label: "Compile-time dep", displayMode: "FACT", description: "A compile-time dependency." },
        { label: "Runtime dep", displayMode: "INFERENCE", description: "A runtime dependency." },
      ];
    case "S24": // state transition table
      return [
        { label: "State", displayMode: "FACT", description: "A state in the state machine." },
        { label: "Event", displayMode: "FACT", description: "An event that triggers transitions." },
        { label: "Forbidden transition", displayMode: "FACT", description: "A transition that is explicitly forbidden." },
      ];
    case "S25": // FMEA / compensation matrix
      return [
        { label: "Failure", displayMode: "FACT", description: "A potential failure mode." },
        { label: "Impact", displayMode: "FACT", description: "The impact of the failure." },
        { label: "Compensation", displayMode: "INFERENCE", description: "A compensation action." },
      ];
    case "S26": // metrics / telemetry map
      return [
        { label: "Metric", displayMode: "FACT", description: "A declared metric name." },
        { label: "Emitter", displayMode: "INFERENCE", description: "Code that emits the metric." },
      ];
    case "S27": // C4 context diagram
      return [
        { label: "Person", displayMode: "FACT", description: "A human actor." },
        { label: "Software system", displayMode: "FACT", description: "A software system." },
        { label: "External system", displayMode: "FACT", description: "An external system dependency." },
      ];
    case "S28": // UML sequence diagram
      return [
        { label: "Lifeline", displayMode: "FACT", description: "An object lifeline." },
        { label: "Sync message", displayMode: "FACT", description: "A synchronous message." },
        { label: "Async message", displayMode: "INFERENCE", description: "An asynchronous message." },
        { label: "Alt fragment", displayMode: "INFERENCE", description: "An alternative fragment." },
      ];
    default:
      return [];
  }
}

export function compileClassDiagramV2(o: { plan: ChartPlanV2; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const classes = o.plan.chartId === "S16" ? o.plan.classes : [];
  const byName = new Map(o.bundle.entities.filter((e) => ["class", "interface", "enum"].includes(e.kind)).map((e) => [e.name, e]));
  const evidenceById = new Map(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => [e.id, e]));
  const nodeIds = new Map<string, string>(), entityIds = new Map<string, string>();
  const nodes: ViewSpec["nodes"] = [], gaps: string[] = [];
  for (const c of classes.slice(0, 60)) {
    const entity = byName.get(c.name);
    const evidenceIds = [...new Set([...c.evidenceIds, ...c.attributes.flatMap((x) => x.evidenceIds), ...c.operations.flatMap((x) => x.evidenceIds)].filter((id) => valid.has(id)))].slice(0, 20);
    if (!evidenceIds.length) { gaps.push(`"${c.name}" was omitted because its declaration lacks current evidence.`); continue; }
    const notes = [
      ...c.attributes.filter((x) => x.evidenceIds.some((id) => valid.has(id))).map((x) => `- ${x.text}`),
      ...c.operations.filter((x) => x.evidenceIds.some((id) => valid.has(id))).map((x) => `+ ${x.text}`),
    ].map((x) => x.slice(0, 300)).slice(0, 60);
    const id = `n:uml:${c.id}`;
    nodeIds.set(c.id, id); if (entity) entityIds.set(c.id, entity.entityId);
    nodes.push({ id, entityRefs: entity ? [entity.entityId] : [], label: entity?.name ?? c.name, kind: entity?.kind ?? c.kind, file: entity?.file ?? evidenceById.get(evidenceIds[0]!)?.sourceId ?? "", claimIds: [], evidenceIds, tier: nodes.length ? "RELEVANT" : "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: c.kind === "interface" ? "uml-interface" : c.kind === "enum" ? "uml-enum" : c.kind === "abstract" ? "uml-abstract" : "uml-class", notes });
  }
  const edges: ViewSpec["edges"] = [];
  const claims: Claim[] = [];
  for (const r of (o.plan.chartId === "S16" ? o.plan.relations : []).slice(0, 120)) {
    const from = entityIds.get(r.from), to = entityIds.get(r.to), fromNodeId = nodeIds.get(r.from), toNodeId = nodeIds.get(r.to);
    if (!fromNodeId || !toNodeId) { gaps.push("A UML relation with missing class endpoints was dropped."); continue; }
    if (r.isInferred && !r.reason?.trim()) { gaps.push("A UML relation was dropped because it gave no reason for the inference."); continue; }
    const relKind = r.kind === "inheritance" ? "extends" : r.kind === "realization" ? "implements" : r.kind;
    const rel = from && to ? o.bundle.relationships.find((x) => x.from === from && x.to === to && x.kind === relKind) : undefined;
    const relEvidence = rel ? new Set(rel.evidence.filter((e) => valid.has(e.id)).map((e) => e.id)) : valid;
    const evidenceIds = r.evidenceIds.filter((id) => relEvidence.has(id));
    if (!evidenceIds.length) { gaps.push("A UML relation without matching current source evidence was dropped."); continue; }
    const claim = r.isInferred ? gateClaim({ assertion: `UML ${r.kind} relation from ${r.from} to ${r.to}${r.label ? ` (${r.label})` : ""}.`, claimClass: "uml-relation", evidenceIds, rationaleSummary: r.reason! }, o.bundle) : undefined;
    if (claim) claims.push(claim);
    const label = r.label ?? rel?.label;
    edges.push({ id: `ge:${rel?.id ?? `${o.plan.chartId}:${r.from}:${r.to}:${edges.length}`}`, fromNodeId, toNodeId, kind: r.kind, ...(rel ? { relationshipId: rel.id } : {}), ...(claim ? { claimId: claim.draft.id } : {}), label: r.isInferred ? `${label ?? r.kind} (inferred: ${r.reason})` : label, evidenceIds, displayMode: r.isInferred ? "INFERENCE" : "FACT" });
  }
  if (!classes.length) gaps.push("The chart creator found no UML classes in the available evidence.");
  const chartType = CHART_REGISTRY.S16.name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed class declarations and relationships.").text}`,
    question: o.question, level: 5, nodes, edges, groups: [],
    legend: [{ label: "Code fact", displayMode: "FACT", description: "Class declarations and relationships link to current indexed source evidence." }, ...legendEntriesForChartId("S16")],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: "S16" }, params: { chartType, chartLayout: o.plan.layout, chartId: "S16" },
  };
  const diagnostics: ChartDiagnostics = {
    chartId: "S16", contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: classes.length - nodes.length, acceptedEdges: edges.length,
    omittedEdges: (o.plan.chartId === "S16" ? o.plan.relations.length : 0) - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims, diagnostics };
}

// ── Typed chart view spec generators (Part C: tier 2 detectors) ─────────────────────────────────

export function compileStateMachineV2(o: { plan: ChartPlanStateMachine; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const states = o.plan.chartId === "S3" ? o.plan.states : [];
  const nameOf = new Map(o.bundle.entities.filter((e) => e.kind !== "file").map((e) => [e.entityId, e.name]));
  const byEntity = new Map<string, string>();
  const nodeIds = new Map<string, string>();
  const nodes: ViewSpec["nodes"] = [];
  const gaps: string[] = [];
  const semantic: StateSpec = { schemaVersion: "state.v1", states: [], transitions: [] };

  for (const s of states.slice(0, 60)) {
    const evidenceIds = s.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`State "${s.label}" was omitted because it lacks current evidence.`);
      continue;
    }
    const id = `n:s3:${s.id}`;
    if (nodeIds.has(s.id)) { gaps.push(`Duplicate state ${s.id} was omitted.`); continue; }
    nodeIds.set(s.id, id);
    semantic.states.push({ nodeId: id, initial: !!s.isInitial, final: !!s.isFinal });
    nodes.push({
      id, entityRefs: [], label: s.label, kind: "state", file: "", claimIds: [], evidenceIds,
      tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: "INFERENCE", unresolvedCalls: 0,
      role: "state", badge: s.isInitial ? "start" : s.isFinal ? "end" : undefined,
      pos: { x: 0, y: 0 }
    });
  }

  const edges: ViewSpec["edges"] = [];
  const transitions = o.plan.chartId === "S3" ? o.plan.transitions : [];
  for (const t of transitions.slice(0, 120)) {
    const fromNodeId = nodeIds.get(t.from), toNodeId = nodeIds.get(t.to);
    if (!fromNodeId || !toNodeId) {
      gaps.push(`Transition from "${t.from}" to "${t.to}" was omitted - state not found.`);
      continue;
    }
    const evidenceIds = t.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Transition from "${t.from}" to "${t.to}" was omitted - no current evidence.`);
      continue;
    }
    const edgeId = `ge:state:${edges.length}:${t.from}>${t.to}`;
    const transition: StateSpec["transitions"][number] = { edgeId, trigger: t.trigger, ...(t.guard ? { guard: t.guard } : {}), forbidden: !!t.isForbidden, replay: !!t.isIdempotentReplay, basis: "plan-inferred" };
    semantic.transitions.push(transition);
    edges.push({ id: edgeId, fromNodeId, toNodeId, kind: t.isForbidden ? "forbidden-transition" : t.isIdempotentReplay ? "replay-transition" : "transition", label: stateTransitionLabel(transition), evidenceIds, displayMode: "INFERENCE" });
  }

  if (nodes.length) gaps.push("State boundaries, guards, replay and forbidden paths are plan interpretations; current citations do not independently prove their semantics.");
  if (!states.length) gaps.push("The chart creator found no states in the available evidence.");

  const chartType = CHART_REGISTRY[o.plan.chartId].name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed state declarations and transitions.").text}`,
    question: o.question, level: 5, nodes, edges, groups: [], state: semantic,
    legend: [{ label: "Plan interpretation", displayMode: "INFERENCE", description: "Current source references support inspection; lifecycle semantics remain interpreted." }, ...legendEntriesForChartId("S3")],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: "S3" }, params: { chartType, chartLayout: o.plan.layout, chartId: "S3" },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: "S3", contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: states.length - nodes.length, acceptedEdges: edges.length,
    omittedEdges: (o.plan.chartId === "S3" ? o.plan.transitions.length : 0) - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

export function compileErDiagramV2(o: { plan: ChartPlanErDiagram; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const tables = o.plan.chartId === "S4" || o.plan.chartId === "S9" ? o.plan.tables : [];
  const byName = new Map(o.bundle.entities.filter((e) => e.kind !== "file").map((e) => [e.entityId, e.name]));
  const nodes: ViewSpec["nodes"] = [];
  const gaps: string[] = [];
  const entityIds = new Map<string, string>();
  const semantic: ErSpec = { schemaVersion: "er.v1", tables: [], relationships: [] };

  for (const t of tables.slice(0, 40)) {
    const evidenceIds = t.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Table "${t.name}" was omitted because it lacks current evidence.`);
      continue;
    }
    const id = `n:er:${t.id}`;
    entityIds.set(t.id, id);
    if (entityIds.has(t.id) && nodes.some(n => n.id === id)) { gaps.push(`Duplicate table ${t.id} was omitted.`); continue; }
    const columns = t.columns.flatMap(c => {
      const current = [...new Set(c.evidenceIds.filter(id => valid.has(id)))];
      if (!current.length) { gaps.push(`Column ${t.name}.${c.name} was omitted because it lacks current evidence.`); return []; }
      return [{ ...c, evidenceIds: current }];
    });
    semantic.tables.push({ nodeId: id, columns });
    const notes = columns.map(erColumnLabel);
    const matched = o.bundle.entities.filter(e => e.kind === "table" && e.name === t.name);
    nodes.push({
      id, entityRefs: matched.length === 1 ? [matched[0].entityId] : [], label: t.name, kind: "table", file: matched[0]?.file ?? "", claimIds: [], evidenceIds: [...new Set([...evidenceIds,...columns.flatMap(c=>c.evidenceIds)])],
      tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0,
      role: "er-entity", notes,
      pos: { x: 0, y: 0 }
    });
  }

  const edges: ViewSpec["edges"] = [];
  const relationships = o.plan.chartId === "S4" || o.plan.chartId === "S9" ? o.plan.relationships : [];
  for (const r of relationships.slice(0, 80)) {
    const fromNodeId = entityIds.get(r.fromTable), toNodeId = entityIds.get(r.toTable);
    if (!fromNodeId || !toNodeId) {
      gaps.push(`Relationship from "${r.fromTable}" to "${r.toTable}" was omitted - table not found.`);
      continue;
    }
    const evidenceIds = r.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Relationship from "${r.fromTable}" to "${r.toTable}" was omitted - no current evidence.`);
      continue;
    }
    if (r.isInferred && !r.reason?.trim()) { gaps.push(`Inferred relationship ${r.fromTable} → ${r.toTable} was omitted because it has no rationale.`); continue; }
    const fromEntity = nodes.find(n => n.id === fromNodeId)?.entityRefs[0], toEntity = nodes.find(n => n.id === toNodeId)?.entityRefs[0];
    const verified = !r.isInferred && !!fromEntity && !!toEntity && o.bundle.relationships.some(link => link.from === fromEntity && link.to === toEntity && ["foreign_key","persistence_association"].includes(link.kind) && link.evidence.some(e => valid.has(e.id) && evidenceIds.includes(e.id)));
    const labelParts: string[] = [`${r.cardinality}?`];
    if (r.fkColumn) labelParts.push(`fk:${r.fkColumn}`);
    const relKind = !verified ? "inferred-relationship" : "relationship";
    const edgeId = `ge:er:${edges.length}:${r.fromTable}>${r.toTable}`;
    semantic.relationships.push({ edgeId, cardinality: r.cardinality, cardinalityBasis: "plan-inferred", ...(r.fkColumn ? { fkColumn: r.fkColumn } : {}), ...(r.reason ? { reason: r.reason } : {}) });
    edges.push({
      id: edgeId, fromNodeId, toNodeId, kind: relKind,
      label: labelParts.join(" "), evidenceIds, displayMode: verified ? "FACT" : "INFERENCE"
    });
  }

  if (tables.length) gaps.push("Column properties and relationship cardinalities are plan interpretations (?) and are not proven by source citations alone.");
  if (!tables.length) gaps.push("The chart creator found no tables in the available evidence.");

  const chartType = CHART_REGISTRY[o.plan.chartId].name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed table declarations and relationships.").text}`,
    question: o.question, level: 5, nodes, edges, groups: [], er: semantic,
    legend: [{ label: "Code fact", displayMode: "FACT", description: "Table declarations and relationships link to current indexed source evidence." }, ...legendEntriesForChartId(o.plan.chartId)],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: o.plan.chartId }, params: { chartType, chartLayout: o.plan.layout, chartId: o.plan.chartId },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: o.plan.chartId, contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: tables.length - nodes.length, acceptedEdges: edges.length,
    omittedEdges: (o.plan.chartId === "S4" || o.plan.chartId === "S9" ? o.plan.relationships.length : 0) - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

export function compileBpmnV2(o: { plan: ChartPlanBpmn; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const elements = o.plan.chartId === "S7" ? o.plan.elements : [];
  const lanes = o.plan.chartId === "S7" ? o.plan.lanes : [];
  const laneNames = lanes.map((l) => l.label).filter((l, i, a) => a.indexOf(l) === i).slice(0, 10);
  const nodeIds = new Map<string, string>();
  const nodes: ViewSpec["nodes"] = [];
  const gaps: string[] = [];

  for (const e of elements.slice(0, 40)) {
    const evidenceIds = e.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`BPMN element "${e.label}" was omitted because it lacks current evidence.`);
      continue;
    }
    const id = `n:bpmn:${e.id}`;
    nodeIds.set(e.id, id);
    const roleMap: Record<string, string> = {
      startEvent: "start-event", endEvent: "end-event", task: "step",
      xorGateway: "gateway-xor", andGateway: "gateway-and", intermediateEvent: "event",
      compensation: "compensation-task"
    };
    nodes.push({
      id, entityRefs: [], label: e.label, kind: "bpmn-element", file: "", claimIds: [], evidenceIds,
      tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: o.diag?.provider === "stub" ? "INFERENCE" : "FACT", unresolvedCalls: 0,
      role: roleMap[e.kind] || "step", lane: e.laneId || undefined,
      pos: { x: 0, y: 0 }
    });
  }

  const edges: ViewSpec["edges"] = [];
  const flows = o.plan.chartId === "S7" ? o.plan.flows : [];
  for (const f of flows.slice(0, 60)) {
    const fromNodeId = nodeIds.get(f.from), toNodeId = nodeIds.get(f.to);
    if (!fromNodeId || !toNodeId) {
      gaps.push(`Flow from "${f.from}" to "${f.to}" was omitted - element not found.`);
      continue;
    }
    const evidenceIds = f.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Flow from "${f.from}" to "${f.to}" was omitted - no current evidence.`);
      continue;
    }
    let kind: string = f.kind === "sequence" ? "sequence-flow" : f.kind === "message" ? "message-flow" : "default-flow";
    let label = f.condition ? `[${f.condition}]` : "";
    edges.push({
      id: `ge:bpmn:${f.from}>${f.to}`, fromNodeId, toNodeId, kind,
      label, evidenceIds, displayMode: "FACT"
    });
  }

  const laneGroups = lanes.slice(0, 10).map((l) => ({
    id: `g:lane:${l.label}`, label: l.label, kind: "lane" as const,
    childNodeIds: nodes.filter((n) => n.lane === l.label).map((n) => n.id),
    level: 1, evidenceIds: l.evidenceIds.filter((id) => valid.has(id)), displayMode: "INFERENCE" as const
  }));

  if (!elements.length) gaps.push("The chart creator found no BPMN elements in the available evidence.");

  const chartType = CHART_REGISTRY.S7.name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed BPMN elements and flows.").text}`,
    question: o.question, level: 5, nodes, edges, groups: laneGroups,
    legend: [{ label: "Code fact", displayMode: "FACT", description: "BPMN elements and flows link to current indexed source evidence." }, ...legendEntriesForChartId("S7")],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: "S7" }, params: { chartType, chartLayout: o.plan.layout, chartId: "S7" },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: "S7", contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: elements.length - nodes.length, acceptedEdges: edges.length,
    omittedEdges: (o.plan.chartId === "S7" ? o.plan.flows.length : 0) - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

export function compileEventStormingV2(o: { plan: ChartPlanEventStorming; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const elements = o.plan.chartId === "S8" ? o.plan.elements : [];
  const nodeIds = new Map<string, string>();
  const nodes: ViewSpec["nodes"] = [];
  const gaps: string[] = [];

  const bandOrder: Record<string, number> = { commands: 0, events: 1, aggregates: 2, readModels: 3, external: 4 };
  const roleMap: Record<string, string> = {
    command: "command", domainEvent: "event", policy: "policy",
    aggregate: "aggregate", readModel: "read-model", externalSystem: "external"
  };

  for (const e of elements.slice(0, 60)) {
    const evidenceIds = e.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Event storming element "${e.label}" was omitted because it lacks current evidence.`);
      continue;
    }
    const id = `n:es:${e.id}`;
    nodeIds.set(e.id, id);
    nodes.push({
      id, entityRefs: [], label: e.label, kind: "event-storming-element", file: "", claimIds: [], evidenceIds,
      tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0,
      role: roleMap[e.kind] || "step", lane: e.band, pos: { x: 0, y: 0 }
    });
  }

  const edges: ViewSpec["edges"] = [];
  const flows = o.plan.chartId === "S8" ? o.plan.flows : [];
  for (const f of flows.slice(0, 60)) {
    const fromNodeId = nodeIds.get(f.from), toNodeId = nodeIds.get(f.to);
    if (!fromNodeId || !toNodeId) {
      gaps.push(`Flow from "${f.from}" to "${f.to}" was omitted - element not found.`);
      continue;
    }
    const evidenceIds = f.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Flow from "${f.from}" to "${f.to}" was omitted - no current evidence.`);
      continue;
    }
    edges.push({
      id: `ge:es:${f.from}>${f.to}`, fromNodeId, toNodeId,
      kind: f.kind === "triggers" ? "triggers" : f.kind === "produces" ? "produces" : f.kind === "consumes" ? "consumes" : "reacts",
      label: f.isAsync ? `${f.kind} · async` : f.kind, evidenceIds, displayMode: "FACT"
    });
  }

  const laneGroups = ["commands", "events", "aggregates", "readModels", "external"]
    .filter((b) => elements.some((e) => e.band === b))
    .map((band, i) => ({
      id: `g:band:${band}`, label: band, kind: "lane" as const,
      childNodeIds: nodes.filter((n) => n.lane === band).map((n) => n.id),
      level: 1, evidenceIds: [], displayMode: "INFERENCE" as const
    }));

  if (!elements.length) gaps.push("The chart creator found no event storming elements in the available evidence.");

  const chartType = CHART_REGISTRY.S8.name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed event storming elements and flows.").text}`,
    question: o.question, level: 5, nodes, edges, groups: laneGroups,
    legend: [{ label: "Code fact", displayMode: "FACT", description: "Event storming elements link to current indexed source evidence." }, ...legendEntriesForChartId("S8")],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: "S8" }, params: { chartType, chartLayout: o.plan.layout, chartId: "S8" },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: "S8", contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: elements.length - nodes.length, acceptedEdges: edges.length,
    omittedEdges: (o.plan.chartId === "S8" ? o.plan.flows.length : 0) - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

export function compileDfdV2(o: { plan: ChartPlanDfd; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const elements = o.plan.chartId === "S10" ? o.plan.elements : [];
  const nodeIds = new Map<string, string>();
  const nodes: ViewSpec["nodes"] = [];
  const gaps: string[] = [];

  const roleMap: Record<string, string> = {
    externalEntity: "external-entity", process: "process", dataStore: "data-store"
  };

  for (const e of elements.slice(0, 40)) {
    const evidenceIds = e.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`DFD element "${e.label}" was omitted because it lacks current evidence.`);
      continue;
    }
    const id = `n:dfd:${e.id}`;
    nodeIds.set(e.id, id);
    nodes.push({
      id, entityRefs: [], label: e.label, kind: "dfd-element", file: "", claimIds: [], evidenceIds,
      tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0,
      role: roleMap[e.kind] || "process", pos: { x: 0, y: 0 }
    });
  }

  const edges: ViewSpec["edges"] = [];
  const flows = o.plan.chartId === "S10" ? o.plan.flows : [];
  for (const f of flows.slice(0, 40)) {
    const fromNodeId = nodeIds.get(f.from), toNodeId = nodeIds.get(f.to);
    if (!fromNodeId || !toNodeId) {
      gaps.push(`Flow from "${f.from}" to "${f.to}" was omitted - element not found.`);
      continue;
    }
    const evidenceIds = f.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Flow from "${f.from}" to "${f.to}" was omitted - no current evidence.`);
      continue;
    }
    const kind = f.kind === "sync" ? "sync" : f.kind === "async" ? "async" : "persisted";
    edges.push({
      id: `ge:dfd:${f.from}>${f.to}`, fromNodeId, toNodeId, kind,
      label: f.label || "", evidenceIds, displayMode: "FACT"
    });
  }

  if (!elements.length) gaps.push("The chart creator found no DFD elements in the available evidence.");

  const chartType = CHART_REGISTRY.S10.name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed DFD elements and flows.").text}`,
    question: o.question, level: 5, nodes, edges, groups: [],
    legend: [{ label: "Code fact", displayMode: "FACT", description: "DFD elements and flows link to current indexed source evidence." }, ...legendEntriesForChartId("S10")],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: "S10" }, params: { chartType, chartLayout: o.plan.layout, chartId: "S10" },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: "S10", contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: elements.length - nodes.length, acceptedEdges: edges.length,
    omittedEdges: (o.plan.chartId === "S10" ? o.plan.flows.length : 0) - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

export function compileDecisionTableV2(o: { plan: ChartPlanDecisionTable; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag; chartId?: string }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const valid = new Set(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const conditions = o.plan.chartId === "S11" ? o.plan.conditions : [];
  const rules = o.plan.chartId === "S11" ? o.plan.rules : [];
  const nodes: ViewSpec["nodes"] = [];
  const gaps: string[] = [];

  // Conditions as nodes
  for (const c of conditions.slice(0, 10)) {
    const evidenceIds = c.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Condition "${c.label}" was omitted because it lacks current evidence.`);
      continue;
    }
    nodes.push({
      id: `n:dt:${c.id}`, entityRefs: [], label: c.label, kind: "condition", file: "", claimIds: [], evidenceIds,
      tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: o.diag?.provider === "stub" ? "INFERENCE" : "FACT", unresolvedCalls: 0,
      role: "condition", pos: { x: 0, y: 0 }
    });
  }

  const edges: ViewSpec["edges"] = [];
  for (const r of rules.slice(0, 20)) {
    const evidenceIds = r.evidenceIds.filter((id) => valid.has(id));
    if (!evidenceIds.length) {
      gaps.push(`Rule was omitted because it lacks current evidence.`);
      continue;
    }
    // Create a cell node for each rule
    nodes.push({
      id: `n:dt:${r.id}`, entityRefs: [], label: `Rule ${rules.indexOf(r) + 1}`, kind: "rule", file: "", claimIds: [], evidenceIds,
      tier: "RELEVANT", displayMode: r.isCovered ? "FACT" : "HYPOTHESIS", unresolvedCalls: 0,
      role: "rule", notes: Object.entries(r.values).map(([k, v]) => `${k}=${v}`),
      pos: { x: 0, y: 0 }
    });
  }

  if (!conditions.length && !rules.length) gaps.push("The chart creator found no decision table elements in the available evidence.");

  const chartType = CHART_REGISTRY.S11.name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from indexed decision table elements.").text}`,
    question: o.question, level: 5, nodes, edges, groups: [],
    legend: [{ label: "Code fact", displayMode: "FACT", description: "Decision table elements link to current indexed source evidence." }, ...legendEntriesForChartId("S11")],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: "S11" }, params: { chartType, chartLayout: o.plan.layout, chartId: "S11" },
  };

  const diagnostics: ChartDiagnostics = {
    chartId: "S11", contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length, omittedNodes: (conditions.length + rules.length) - nodes.length, acceptedEdges: edges.length,
    omittedEdges: 0, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

type PlanObject = Record<string, unknown>;
type ProjectedNode = { id: string; label: string; kind: string; entityRefs: string[]; evidenceIds: string[]; notes: string[]; inferred: boolean };
type ProjectedEdge = { from: string; to: string; kind: string; label?: string; evidenceIds: string[] };

function planObject(value: unknown): PlanObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PlanObject : null;
}

function planEvidence(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    const obj = planObject(v);
    if (!obj) return;
    for (const [key, child] of Object.entries(obj)) {
      if ((key === "evidenceIds" || key.endsWith("EvidenceIds")) && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string") found.add(id);
      } else if (child && typeof child === "object") walk(child);
    }
  };
  walk(value);
  return [...found];
}

function planNotes(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, prefix = "") => {
    if (Array.isArray(v)) { for (const item of v) walk(item, prefix); return; }
    const obj = planObject(v);
    if (obj) {
      for (const [key, child] of Object.entries(obj)) {
        if (["id", "entityId", "evidenceIds", "outcomeEvidenceIds", "from", "to", "fromTable", "toTable", "operationId", "scenarioId", "stateId", "eventId", "nextStateId", "parentId", "layerId", "componentIds"].includes(key) || key.endsWith("EvidenceIds")) continue;
        walk(child, key.replace(/([A-Z])/g, " $1").toLowerCase());
      }
    } else if (typeof v === "string" && v.trim()) {
      out.add(`${prefix ? `${prefix}: ` : ""}${v.trim()}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.add(`${prefix ? `${prefix}: ` : ""}${v}`);
    }
  };
  walk(value);
  return [...out].slice(0, 16);
}

/** Normalize typed chart-specific plan fields into the interactive evidence-linked canvas model. */
function projectTypedChart(plan: ChartPlanV2, bundle: EvidenceBundle, offline: boolean): { nodes: ProjectedNode[]; edges: ProjectedEdge[] } {
  const raw = plan as unknown as PlanObject;
  const list = (key: string): PlanObject[] => Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(planObject).filter((x): x is PlanObject => !!x) : [];
  const nodes = new Map<string, ProjectedNode>();
  const edges: ProjectedEdge[] = [];
  const currentEvidence = new Set(bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => e.id));
  const evidenceForEntities = (ids: Set<string>) => [...new Set([
    ...bundle.relationships.filter((r) => ids.has(r.from) || ids.has(r.to)).flatMap((r) => r.evidence.map((e) => e.id)),
    ...bundle.facts.filter((f) => ids.has(f.subject)).flatMap((f) => f.evidence.map((e) => e.id)),
  ].filter((id) => currentEvidence.has(id)))].slice(0, 20);
  const sourceMatches = (label: string) => {
    const normalized = label.trim().toLocaleLowerCase();
    const exact = bundle.entities.filter((e) => e.kind !== "file" && (e.name.toLocaleLowerCase() === normalized || e.name.split(".").at(-1)?.toLocaleLowerCase() === normalized));
    if (exact.length) return exact;
    // Offline package and layer plans group indexed entities by their source directory.
    if (["S17", "S22", "S23"].includes(plan.chartId)) {
      return bundle.entities.filter((e) => e.kind !== "file" && (e.file === label || e.file.startsWith(`${label.replace(/\/$/, "")}/`) || e.file.split("/").includes(label)));
    }
    return [];
  };
  const addNode = (item: PlanObject, idValue?: unknown, labelValue?: unknown, evidenceOverride?: string[]) => {
    const id = typeof idValue === "string" ? idValue : typeof item.id === "string" ? item.id : undefined;
    const label = typeof labelValue === "string" ? labelValue : typeof item.label === "string" ? item.label : typeof item.name === "string" ? item.name : typeof item.className === "string" ? item.className : undefined;
    if (!id || !label) return;
    let evidenceIds = [...new Set(evidenceOverride ?? planEvidence(item))].filter((id) => currentEvidence.has(id));
    const matched = sourceMatches(label);
    // Identity is linked only when the match is unambiguous (or a deliberate package grouping).
    const entityRefs = matched.length === 1 || ["S17", "S22", "S23"].includes(plan.chartId) ? matched.map((e) => e.entityId) : [];
    let inferred = offline;
    if (!evidenceIds.length) {
      evidenceIds = evidenceForEntities(new Set(matched.map((e) => e.entityId)));
      inferred ||= evidenceIds.length > 0;
    }
    const kind = typeof item.kind === "string" ? item.kind : "element";
    nodes.set(id, { id, label: label.slice(0, 200), kind, entityRefs, evidenceIds, notes: [...planNotes(item), ...(inferred ? ["Offline classification is inferred from matching indexed source; the source does not establish the chart role by itself."] : [])], inferred });
  };
  const addNodes = (key: string, labelKey?: string, idPrefix = "") => {
    for (const item of list(key)) addNode(item, typeof item.id === "string" ? item.id : `${idPrefix}${String(item[labelKey ?? "label"] ?? "")}`, item[labelKey ?? "label"] ?? item.name ?? item.className);
  };

  switch (plan.chartId) {
    case "S12": addNodes("steps"); break;
    case "S13": case "S27": addNodes("elements"); break;
    case "S14": {
      const cells = list("cells");
      const evidenceFor = (key: string, id: unknown) => cells.filter((c) => c[key] === id).flatMap(planEvidence);
      for (const x of list("operations")) addNode(x, x.id, x.label, evidenceFor("operationId", x.id).concat(planEvidence(x)));
      for (const x of list("scenarios")) addNode(x, x.id, x.label, evidenceFor("scenarioId", x.id).concat(planEvidence(x)));
      break;
    }
    case "S15": addNodes("components"); break;
    case "S17": addNodes("packages"); break;
    case "S18": addNodes("participants"); break;
    case "S28": {
      addNodes("participants");
      for (const fragment of list("fragments")) {
        const label = [fragment.kind, fragment.condition].filter((x): x is string => typeof x === "string" && !!x).join(": ");
        addNode(fragment, fragment.id, label || fragment.kind);
      }
      break;
    }
    case "S19": addNodes("frames"); break;
    case "S20": for (const x of list("cards")) addNode(x, `card:${String(x.className ?? "")}`, x.className); break;
    case "S21": addNodes("functions"); break;
    case "S22": { addNodes("layers"); addNodes("components"); break; }
    case "S23": addNodes("modules"); break;
    case "S24": {
      const cells = list("cells");
      const evidenceFor = (key: string, id: unknown) => cells.filter((c) => c[key] === id).flatMap(planEvidence);
      for (const x of list("states")) addNode(x, x.id, x.label, evidenceFor("stateId", x.id).concat(evidenceFor("nextStateId", x.id), planEvidence(x)));
      for (const x of list("events")) addNode(x, x.id, x.label, evidenceFor("eventId", x.id).concat(planEvidence(x)));
      break;
    }
    case "S25": addNodes("failures"); break;
    case "S26": addNodes("metrics", "name"); break;
    default: throw new Error(`No structured chart projection registered for ${plan.chartId}`);
  }

  // All typed links have the same endpoints/evidence contract even when their labels differ.
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const item = planObject(entry);
      if (!item || typeof item.from !== "string" || typeof item.to !== "string") continue;
      const evidenceIds = planEvidence(item);
      const detail = [...new Set([typeof item.label === "string" ? item.label : "", ...planNotes(item)])].filter(Boolean).join(" · ");
      edges.push({ from: item.from, to: item.to, kind: typeof item.kind === "string" ? item.kind : key, ...(detail ? { label: detail.slice(0, 200) } : {}), evidenceIds });
    }
  }
  const nodeIds = new Set(nodes.keys());
  for (const cell of list("cells")) {
    const from = typeof cell.operationId === "string" ? cell.operationId : typeof cell.stateId === "string" ? cell.stateId : undefined;
    const to = typeof cell.scenarioId === "string" ? cell.scenarioId : typeof cell.nextStateId === "string" ? cell.nextStateId : undefined;
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    const event = list("events").find((e) => e.id === cell.eventId);
    const evidenceIds = planEvidence(cell);
    if (typeof cell.stateId === "string" && typeof cell.eventId === "string" && event && nodeIds.has(cell.eventId) && typeof cell.nextStateId === "string") {
      edges.push({ from: cell.stateId, to: cell.eventId, kind: "event", label: "event", evidenceIds });
      const label = [cell.guard, cell.isForbidden === true ? "forbidden" : "next state"].filter((x): x is string => typeof x === "string" && !!x).join(" · ");
      edges.push({ from: cell.eventId, to: cell.nextStateId, kind: "transition", ...(label ? { label } : {}), evidenceIds });
      continue;
    }
    const label = [event?.label, cell.outcome, cell.guard, cell.mechanism, cell.isForbidden === true ? "forbidden" : undefined].filter((x): x is string => typeof x === "string" && !!x).join(" · ");
    edges.push({ from, to, kind: "cell", ...(label ? { label } : {}), evidenceIds });
  }
  if (plan.chartId === "S20") {
    const byClass = new Map(list("cards").map((x) => [String(x.className ?? ""), `card:${String(x.className ?? "")}`]));
    for (const card of list("cards")) for (const collaborator of Array.isArray(card.collaborators) ? card.collaborators : []) {
      const c = planObject(collaborator), from = byClass.get(String(card.className ?? "")), to = c && byClass.get(String(c.className ?? ""));
      if (from && to) edges.push({ from, to, kind: "collaborates", label: "collaborates", evidenceIds: planEvidence(c) });
    }
  }
  if (plan.chartId === "S22") {
    for (const component of list("components")) if (typeof component.id === "string" && typeof component.layerId === "string") edges.push({ from: component.layerId, to: component.id, kind: "contains", label: "member of layer", evidenceIds: planEvidence(component) });
  }
  if (plan.chartId === "S21") {
    for (const fn of list("functions")) if (typeof fn.id === "string" && typeof fn.parentId === "string" && nodeIds.has(fn.parentId)) edges.push({ from: fn.parentId, to: fn.id, kind: "contains", label: "owned by", evidenceIds: planEvidence(fn) });
  }
  if (plan.chartId === "S15") {
    for (const cycle of list("cycles")) for (const id of Array.isArray(cycle.componentIds) ? cycle.componentIds : []) {
      const node = nodes.get(String(id));
      if (node) {
        node.evidenceIds = [...new Set([...node.evidenceIds, ...planEvidence(cycle)])];
        node.notes = [...node.notes, "participates in a dependency cycle"];
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export function compileStructuredChartV2(o: { plan: ChartPlanV2; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; run?: ModelRunRef; diag?: ChartCompileDiag }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  const projection = projectTypedChart(o.plan, o.bundle, o.diag?.provider === "stub" || o.run?.provider === "stub");
  const validEvidence = new Map(o.bundle.evidence.filter((e) => e.state === "CURRENT").map((e) => [e.id, e]));
  const gaps: string[] = [];
  const nodeMap = new Map<string, string>();
  const nodes: ViewSpec["nodes"] = [];
  for (const spec of projection.nodes.slice(0, 80)) {
    const evidenceIds = spec.evidenceIds.filter((id) => validEvidence.has(id));
    if (!evidenceIds.length) { gaps.push(`"${spec.label}" was omitted because its typed chart element has no current evidence.`); continue; }
    const id = `n:typed:${o.plan.chartId}:${spec.id}`;
    nodeMap.set(spec.id, id);
    nodes.push({ id, entityRefs: spec.entityRefs, label: spec.label, kind: spec.kind, file: validEvidence.get(evidenceIds[0])?.sourceId ?? "", claimIds: [], evidenceIds: [...new Set(evidenceIds)], tier: nodes.length ? "RELEVANT" : "CRITICAL", displayMode: spec.inferred ? "INFERENCE" : "FACT", unresolvedCalls: 0, role: spec.kind, notes: spec.notes.slice(0, 12), pos: { x: 0, y: nodes.length * 110 } });
  }
  const edges: ViewSpec["edges"] = [];
  for (const spec of projection.edges.slice(0, 160)) {
    const fromNodeId = nodeMap.get(spec.from), toNodeId = nodeMap.get(spec.to);
    if (!fromNodeId || !toNodeId) { gaps.push("A typed chart connection was omitted because one endpoint is missing."); continue; }
    const evidenceIds = [...new Set(spec.evidenceIds.filter((id) => validEvidence.has(id)))];
    if (!evidenceIds.length) { gaps.push("A typed chart connection was omitted because it has no current evidence."); continue; }
    edges.push({ id: `ge:typed:${o.plan.chartId}:${edges.length}`, fromNodeId, toNodeId, kind: spec.kind, ...(spec.label ? { label: spec.label } : {}), evidenceIds, displayMode: o.diag?.provider === "stub" ? "INFERENCE" : "FACT" });
  }
  if (!projection.nodes.length) gaps.push("The chart plan contains no chart-specific elements; the offline model may not support this notation.");
  else if (!nodes.length) gaps.push("The chart plan's elements could not be grounded in current evidence.");
  else if (!edges.length) gaps.push("Elements are shown, but no evidence-backed connections were available for this notation.");
  const chartType = CHART_REGISTRY[o.plan.chartId].name;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;
  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart",
    caption: `${chartType} · ${modelText(o.plan.caption, "Arranged from typed chart evidence.").text}`,
    question: o.question, level: 5, nodes, edges, groups: [],
    legend: [{ label: "Chart element", displayMode: "FACT", description: "Element is included with current evidence from the selected chart plan." }, ...legendEntriesForChartId(o.plan.chartId)],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} from its typed chart plan.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: o.plan.chartId }, params: { chartType, chartLayout: o.plan.layout, chartId: o.plan.chartId },
  };
  if (o.plan.chartId === "S28") {
    const plan = o.plan;
    const participantIds = [...new Set(plan.participants.map(p => nodeMap.get(p.id)).filter((id): id is string => !!id))];
    const participantSet = new Set(participantIds);
    const fragments = plan.fragments.flatMap(f => {
      const evidenceIds = [...new Set(f.evidenceIds.filter(id => validEvidence.has(id)))];
      if (!evidenceIds.length) { gaps.push(`Fragment ${f.id} was omitted because it has no current evidence.`); return []; }
      return [{ ...f, evidenceIds }];
    });
    const fragmentIds = new Set(fragments.map(f => f.id));
    const messages: NonNullable<ViewSpec["sequence"]>["messages"] = [];
    const sequenceEdges: ViewSpec["edges"] = [];
    for (const [index, m] of plan.messages.entries()) {
      const fromNodeId = nodeMap.get(m.from), toNodeId = nodeMap.get(m.to);
      const evidenceIds = [...new Set(m.evidenceIds.filter(id => validEvidence.has(id)))];
      if (!fromNodeId || !toNodeId || !participantSet.has(fromNodeId) || !participantSet.has(toNodeId) || !evidenceIds.length) {
        gaps.push(`Message ${m.order} was omitted because its endpoints or current evidence are missing.`); continue;
      }
      const edgeId = `ge:sequence:${index}`;
      sequenceEdges.push({ id: edgeId, fromNodeId, toNodeId, kind: m.kind, label: m.label, evidenceIds, displayMode: "INFERENCE" });
      if (m.fragmentId && !fragmentIds.has(m.fragmentId)) gaps.push(`Message ${m.order} references an unavailable fragment; it is shown without that frame.`);
      messages.push({ edgeId, order: m.order, kind: m.kind, ...(m.fragmentId && fragmentIds.has(m.fragmentId) ? { fragmentId: m.fragmentId } : {}) });
    }
    if (new Set(messages.map(m => m.order)).size !== messages.length) gaps.push("Duplicate message order numbers are shown in stable plan order; their relative order is ambiguous.");
    view.nodes = nodes.filter(n => participantSet.has(n.id)).map((n,index) => ({ ...n, role: "participant", pos: { x: 140 + index * 260, y: 40 } }));
    view.edges = sequenceEdges;
    view.sequence = { schemaVersion: "sequence.v1", ordering: "inferred-static", participantIds, messages, fragments };
    gaps.push("Message order and control fragments are inferred from the static plan; current source evidence does not prove runtime timing or parallel execution.");
  }
  const diagnostics: ChartDiagnostics = {
    chartId: o.plan.chartId, contractVersion: "chart.v2", provider: o.diag?.provider ?? o.run?.provider ?? "", model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false, schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length, suppliedRelationships: o.bundle.relationships.length, suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: view.nodes.length, omittedNodes: projection.nodes.length - view.nodes.length, acceptedEdges: view.edges.length,
    omittedEdges: projection.edges.length - edges.length, gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };
  return { view, claims: [], diagnostics };
}

// ── Remaining typed chart handlers ───────────────────────────────────────────────────────

export function compileLegacyChartPlan(o: { plan: ChartPlan | ChartPlanV2; bundle: EvidenceBundle; rev: RevisionRow; question: string; route: ViewRoute; chartId?: string; run?: ModelRunRef; diag?: ChartCompileDiag }): { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics } {
  if ("contractVersion" in o.plan && o.plan.contractVersion === "chart.v2") {
    const chartId = o.chartId ?? o.plan.chartId;
    if (chartId && CHART_REGISTRY[chartId as ChartId]?.compiler === "standard") {
      // Standard charts and the explicit generic chart share the base nodes/edges contract.
      const basePlan: ChartPlan = {
        chartType: CHART_REGISTRY[chartId as ChartId].name,
        layout: o.plan.layout,
        caption: o.plan.caption,
        nodes: o.plan.nodes as ChartPlan["nodes"],
        edges: o.plan.edges as ChartPlan["edges"],
      };
      return compileLegacyChartPlan({ ...o, plan: basePlan, chartId });
    }
    if (o.plan.chartId === "S3") return compileStateMachineV2({ ...o, plan: o.plan });
    if (o.plan.chartId === "S4" || o.plan.chartId === "S9") return compileErDiagramV2({ ...o, plan: o.plan });
    if (o.plan.chartId === "S7") return compileBpmnV2({ ...o, plan: o.plan });
    if (o.plan.chartId === "S8") return compileEventStormingV2({ ...o, plan: o.plan });
    if (o.plan.chartId === "S10") return compileDfdV2({ ...o, plan: o.plan });
    if (o.plan.chartId === "S11") return compileDecisionTableV2({ ...o, plan: o.plan });
    if (o.plan.chartId === "S16") return compileClassDiagramV2({ ...o, plan: o.plan });
    if (chartId && CHART_REGISTRY[chartId as ChartId]?.compiler === "projected" && o.plan.chartId === chartId) return compileStructuredChartV2({ ...o, plan: o.plan });
    throw new Error(`No compiler registered for selected chart ${chartId ?? o.plan.chartId}`);
  }
  const plan = o.plan as ChartPlan;
  const entities = new Map(o.bundle.entities.filter((e) => e.kind !== "file" || o.chartId === "S1").map((e) => [e.entityId, e]));
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
  for (const spec of plan.nodes) {
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
    nodes.push({ id, entityRefs: [entity.entityId], label: entity.kind === "file" ? entity.file : entity.name, kind: entity.kind, file: entity.file, claimIds: [], evidenceIds, tier: nodes.length === 0 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role, ...(lane ? { lane } : {}), pos: { x: spec.column * 210, y: (spec.row + (lane ? laneNames.indexOf(lane) * 2 : 0)) * 110 } });
  }
  const edges: ViewSpec["edges"] = [];
  for (const spec of plan.edges) {
    const rel = relationships.get(spec.relationshipId);
    if (!rel || rel.from !== spec.from || rel.to !== spec.to || !byEntity.has(rel.from) || !byEntity.has(rel.to)) { gaps.push("A generated chart connection that did not match an indexed relationship was omitted."); continue; }
    const valid = new Set(rel.evidence.map((e) => e.id));
    const evidenceIds = spec.evidenceIds.filter((id) => valid.has(id) && evidence.has(id));
    if (evidenceIds.length === 0) { gaps.push("A generated chart connection without supporting current evidence was omitted."); continue; }
    edges.push({ id: `ge:${rel.id}`, fromNodeId: byEntity.get(rel.from)!, toNodeId: byEntity.get(rel.to)!, kind: rel.kind, relationshipId: rel.id, label: spec.label || rel.label, evidenceIds, displayMode: "FACT" });
  }
  if (plan.nodes.length > 0 && nodes.length === 0) gaps.push("The requested chart could not be grounded in this revision's indexed evidence.");
  if (plan.nodes.length === 0) gaps.push("The chart creator found no useful code elements in the available evidence.");
  const chartType = o.chartId && o.chartId in CHART_REGISTRY ? CHART_REGISTRY[o.chartId as ChartId].name : modelText(plan.chartType, "custom").text;
  const caption = `${chartType} chart · ${modelText(plan.caption, "Arranged from indexed code relationships.").text}`;
  const viewId = `view:generated:${createHash("sha256").update(`${o.bundle.id}|${o.question}`).digest("hex").slice(0, 12)}`;

  const chartId = o.chartId ?? "generic";
  const chartSpecificLegend = legendEntriesForChartId(chartId);

  const view: ViewSpec = {
    id: viewId, version: 1, revision: o.rev.id, taskId: `task:${viewId}`, formId: "GeneratedChart", caption,
    question: o.question, level: 5, nodes, edges,
    groups: plan.layout === "lanes" || plan.layout === "timeline" ? laneNames.map((name): ViewSpec["groups"][number] => ({ id: `g:lane:${name}`, label: name, kind: "lane", childNodeIds: nodes.filter((n) => n.lane === name).map((n) => n.id), level: 1, evidenceIds: [...new Set(nodes.filter((n) => n.lane === name).flatMap((n) => n.evidenceIds))], displayMode: "INFERENCE" })) : [],
    legend: [
      { label: "Code fact", displayMode: "FACT", description: "Element or connection is linked to current indexed evidence; click to inspect it." },
      { label: "Generated layout", displayMode: "INFERENCE", description: "The chart type and arrangement were proposed by the chart creator." },
      ...chartSpecificLegend,
    ],
    cameraPolicy: { behavior: "PRESERVE" }, gaps, formReason: `Generated ${chartType} layout from indexed code evidence.`, route: o.route,
    meta: { kind: "generated-chart", field: chartType, subject: chartId },
    params: { chartType, chartLayout: plan.layout, chartId },
  };

  const diagnostics: ChartDiagnostics = {
    chartId,
    contractVersion: chartId === "generic" ? "chart.v1" : "chart.v2",
    provider: o.diag?.provider ?? o.run?.provider ?? "",
    model: o.diag?.model ?? o.run?.model ?? "",
    cacheHit: o.diag?.cacheHit ?? false,
    schemaValidationPassed: o.diag?.schemaValidationPassed ?? true,
    suppliedEntities: o.bundle.entities.length,
    suppliedRelationships: o.bundle.relationships.length,
    suppliedEvidence: o.bundle.evidence.length,
    acceptedNodes: nodes.length,
    omittedNodes: plan.nodes.length - nodes.length,
    gaps,
    ...(o.diag?.fallbackReason ? { fallbackReason: o.diag.fallbackReason } : {}),
  };

  return { view, claims: [], diagnostics };
}
