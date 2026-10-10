// Deterministic offline provider. It only reasons over the bundle it is given, so it works as a
// reference for what a real provider may cite: evidence ids that exist in `bundle.evidence`.
import type { ChallengeOutput, ChartOutput, ChartOutputV2, ChartPlanCallGraph, ChartPlanDfd, ChartPlanEventStorming, ChartPlanStateMachine, ChartPlanErDiagram, ChartPlanBpmn, ChartPlanDecisionTable, ChartPlanSaga, ChartPlanOutbox, ChartPlanIdempotencyMatrix, ChartPlanDiWiring, ChartPlanPackageDiagram, ChartPlanCommunication, ChartPlanInteractionOverview, ChartPlanCrcCards, ChartPlanLayeredArchitecture, ChartPlanModuleGraph, ChartPlanStateTransitionTable, ChartPlanFmeaMatrix, ChartPlanMetricsMap, ChartPlanC4Context, ChartPlanSequence, ChartPlanGeneric, EvidenceBundle, ExplanationOutput, Fact, HypothesesOutput, ModelProvider, ModelRequest, NameArchOutput, NameConceptOutput, RepresentationOutput, Relationship } from "@cie/schema";
import { CHART_NAMES } from "@cie/schema";
import { inferSourceOverview } from "./source-overview.ts";
import { z } from "zod";

const dirOf = (file: string) => {
  const parts = file.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "(root)";
};

const evIds = (r: Relationship) => r.evidence.map((e) => e.id);

const factEvIds = (f: Fact) => f.evidence.map((e) => e.id);

/** Evidence attached to an indexed symbol through its declaration or graph/fact rows. */
function evidenceForEntity(bundle: EvidenceBundle, entityId: string): string[] {
  return [...new Set([
    ...bundle.relationships.filter((r) => r.from === entityId || r.to === entityId).flatMap(evIds),
    ...bundle.facts.filter((f) => f.subject === entityId).flatMap(factEvIds),
  ])].filter((id) => bundle.evidence.some((e) => e.id === id && e.state === "CURRENT")).slice(0, 20);
}

function evidenceForName(bundle: EvidenceBundle, name: string): string[] {
  const normalized = name.trim().toLocaleLowerCase();
  const matches = bundle.entities.filter((e) => e.kind !== "file" && (e.name.toLocaleLowerCase() === normalized || e.name.split(".").at(-1)?.toLocaleLowerCase() === normalized));
  return [...new Set(matches.flatMap((e) => evidenceForEntity(bundle, e.entityId)))].slice(0, 20);
}

function evidenceForDirectory(bundle: EvidenceBundle, directory: string): string[] {
  const prefix = directory.replace(/\/$/, "");
  const ids = new Set(bundle.entities.filter((e) => e.kind !== "file" && (e.file === prefix || e.file.startsWith(`${prefix}/`))).map((e) => e.entityId));
  return [...new Set([...ids].flatMap((id) => evidenceForEntity(bundle, id)))].slice(0, 20);
}

function represent(req: ModelRequest): RepresentationOutput {
  const { bundle } = req;
  const symbols = bundle.entities.filter((e) => e.kind !== "file");
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const containsEv = new Map<string, string[]>();
  for (const r of bundle.relationships) if (r.kind === "contains") containsEv.set(r.to, evIds(r));

  const byDir = new Map<string, string[]>();
  for (const s of symbols) {
    const d = dirOf(s.file);
    byDir.set(d, [...(byDir.get(d) ?? []), s.entityId]);
  }
  const groups = [...byDir.entries()].map(([dir, members]) => ({
    label: dir,
    memberEntityIds: members,
    rationale: `Symbols declared under a "${dir}" directory.`,
    evidenceIds: members.flatMap((m) => containsEv.get(m) ?? []).slice(0, 50),
  }));

  // Two-hop call chains collapsed into inferred "reaches" edges. Each cites both underlying edges.
  const calls = bundle.relationships.filter((r) => r.kind === "calls");
  const out = new Map<string, Relationship[]>();
  for (const c of calls) out.set(c.from, [...(out.get(c.from) ?? []), c]);
  const direct = new Set(calls.map((c) => `${c.from}>${c.to}`));
  const inferredEdges: RepresentationOutput["inferredEdges"] = [];
  const seen = new Set<string>();
  for (const a of calls) {
    for (const b of out.get(a.to) ?? []) {
      const key = `${a.from}>${b.to}`;
      if (a.from === b.to || direct.has(key) || seen.has(key)) continue;
      seen.add(key);
      inferredEdges.push({
        from: a.from, to: b.to,
        rationale: `Reaches via ${nameOf.get(a.to) ?? a.to} (two resolved calls); not a direct call.`,
        evidenceIds: [...evIds(a), ...evIds(b)],
        viaEntityIds: [a.to],
      });
    }
  }
  return {
    caption: `${symbols.length} symbols in ${groups.length} groups relevant to "${req.question}". Solid edges are statically resolved; dashed edges are inferred.`,
    groups,
    inferredEdges: inferredEdges.slice(0, 100),
  };
}

/** The offline arrangement of indexed call relationships: deterministic, honest about what it is. */
function callFlowParts(req: ModelRequest) {
  const relations = req.bundle.relationships.filter((r) => r.kind === "calls").slice(0, 80);
  const entities = new Map(req.bundle.entities.filter((e) => e.kind !== "file").map((e) => [e.entityId, e]));
  const ids = [...new Set(relations.flatMap((r) => [r.from, r.to]))].filter((id) => entities.has(id)).slice(0, 40);
  const nodes = ids.map((entityId, i) => ({
    entityId,
    evidenceIds: [...new Set(relations.filter((r) => r.from === entityId || r.to === entityId).flatMap(evIds))].slice(0, 20),
    shape: "process" as const, column: i, row: 0,
  }));
  const have = new Set(ids);
  const edges = relations.filter((r) => have.has(r.from) && have.has(r.to)).map((r) => ({ from: r.from, to: r.to, relationshipId: r.id, label: r.label, evidenceIds: evIds(r) }));
  return { nodes, edges };
}

/** chart.v1: only used when no chart type was selected. */
function chart(req: ModelRequest): ChartOutput {
  const { nodes, edges } = callFlowParts(req);
  return {
    chartType: "call-flow",
    layout: "flow",
    caption: `Static call-flow chart with ${nodes.length} code elements.`,
    nodes,
    edges,
  };
}

const OFFLINE_LIMIT = "The offline model can only arrange statically indexed facts, so notation-specific details a hosted model could judge are left as gaps rather than invented.";

/** S10 offline: processes, stores and persisted flows derived from read/write facts, plus external
 *  dependencies. Every element cites the fact evidence it came from; no level-0/1 claim is made. */
function dfdOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const rw = bundle.facts.filter((f) => (f.predicate === "writes" || f.predicate === "reads") && String((f.object as { value?: unknown }).value ?? "").length > 0 && nameOf.has(f.subject)).slice(0, 60);
  const storeEv = new Map<string, Set<string>>();
  const procEv = new Map<string, Set<string>>();
  const flowEv = new Map<string, { data: string; ev: Set<string> }>();
  for (const f of rw) {
    const data = String((f.object as { value?: unknown }).value ?? "");
    const ev = factEvIds(f);
    if (!storeEv.has(data)) storeEv.set(data, new Set());
    for (const id of ev) storeEv.get(data)!.add(id);
    if (!procEv.has(f.subject)) procEv.set(f.subject, new Set());
    for (const id of ev) procEv.get(f.subject)!.add(id);
    const key = `${f.subject}>${data}`;
    if (!flowEv.has(key)) flowEv.set(key, { data, ev: new Set() });
    for (const id of ev) flowEv.get(key)!.ev.add(id);
  }
  const elements: ChartPlanDfd["elements"] = [];
  const external = bundle.facts.filter((f) => f.predicate === "imports_external").slice(0, 6);
  for (const f of external) {
    const name = String((f.object as { value?: unknown }).value ?? "").split("/")[0];
    if (!name) continue;
    elements.push({ id: `ext:${elements.length}`, kind: "externalEntity", label: name, evidenceIds: factEvIds(f).slice(0, 20) });
  }
  let i = 0;
  for (const [subject, ev] of [...procEv].slice(0, 20)) {
    elements.push({ id: `p:${i++}`, kind: "process", label: nameOf.get(subject) ?? subject, evidenceIds: [...ev].slice(0, 20) });
  }
  let j = 0;
  for (const [data, ev] of [...storeEv].slice(0, 12)) {
    elements.push({ id: `ds:${j++}`, kind: "dataStore", label: data, evidenceIds: [...ev].slice(0, 20) });
  }
  const procIndex = new Map([...procEv.keys()].slice(0, 20).map((subject, k) => [subject, `p:${k}`]));
  const storeIndex = new Map([...storeEv.keys()].slice(0, 12).map((data, k) => [data, `ds:${k}`]));
  const flows: ChartPlanDfd["flows"] = [];
  for (const [key, { data, ev }] of [...flowEv].slice(0, 60)) {
    const [subject] = key.split(">");
    const from = procIndex.get(subject!), to = storeIndex.get(data);
    if (!from || !to) continue;
    flows.push({ from, to, label: data, kind: "persisted", evidenceIds: [...ev].slice(0, 20) });
  }
  return {
    contractVersion: "chart.v2", chartId: "S10", chartType: CHART_NAMES.S10, layout: "flow",
    caption: `Offline data-flow sketch from indexed read/write facts: ${procEv.size} process(es), ${storeEv.size} store(s), ${flows.length} persisted flow(s). External dependencies are shown without flows, and no context/level-1 distinction is claimed. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], elements, flows,
  };
}

/** S8 offline: domain events from evidenced async hand-offs (topic labels). Commands, aggregates,
 *  policies and read models need judgment the offline model does not have, so they stay gaps. */
function eventStormingOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const handoffs = bundle.relationships.filter((r) => r.kind === "async-flow").slice(0, 40);
  const elements: ChartPlanEventStorming["elements"] = [];
  const seen = new Map<string, string>();
  for (const r of handoffs) {
    const label = r.label ?? "an unnamed event";
    if (!seen.has(label)) {
      const id = `ev:${seen.size}`;
      seen.set(label, id);
      elements.push({ id, kind: "domainEvent", label: label.slice(0, 200), band: "events", orderHint: seen.size - 1, evidenceIds: evIds(r).slice(0, 20) });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S8", chartType: CHART_NAMES.S8, layout: "lanes",
    caption: `Offline event board: ${elements.length} domain event(s) from evidenced asynchronous hand-offs. Commands, aggregates, policies and read models are not classified offline and are left as gaps. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], elements, flows: [],
  };
}

/** A typed "unsupported offline" result: the requested chart type is kept, every collection is
 *  empty, and the caption states the limitation. Never a call-flow substitute. */
function unsupportedOffline(chartId: "S3" | "S4" | "S7" | "S9" | "S11" | "S12" | "S13" | "S14" | "S15" | "S16" | "S17" | "S18" | "S19" | "S20" | "S22" | "S23" | "S24" | "S25" | "S26" | "S27" | "S28", layout: "flow" | "lanes" | "network"): ChartOutputV2 {
  const name = CHART_NAMES[chartId];
  const base = {
    contractVersion: "chart.v2" as const, chartType: name, layout,
    caption: `${name}: this chart needs notation-specific evidence the offline model cannot derive without inventing it. Re-run with a hosted model, or index more evidence (schemas, tests, configuration).`,
    nodes: [] as [], edges: [] as [],
  };
  switch (chartId) {
    case "S3": return { ...base, chartId: "S3", states: [], transitions: [] };
    case "S4": case "S9": return { ...base, chartId, tables: [], relationships: [] };
    case "S7": return { ...base, chartId: "S7", elements: [], flows: [], lanes: [] };
    case "S11": return { ...base, chartId: "S11", conditions: [], rules: [] };
    case "S12": return { ...base, chartId: "S12", steps: [], edges: [] };
    case "S13": return { ...base, chartId: "S13", elements: [], flows: [] };
    case "S14": return { ...base, chartId: "S14", operations: [], scenarios: [], cells: [] };
    case "S15": return { ...base, chartId: "S15", components: [], bindings: [], cycles: [] };
    case "S16": return { ...base, chartId: "S16", classes: [], relations: [] };
    case "S17": return { ...base, chartId: "S17", packages: [], dependencies: [] };
    case "S18": return { ...base, chartId: "S18", participants: [], messages: [] };
    case "S19": return { ...base, chartId: "S19", frames: [], flows: [] };
    case "S20": return { ...base, chartId: "S20", cards: [] };
    case "S22": return { ...base, chartId: "S22", layers: [], components: [], edges: [] };
    case "S23": return { ...base, chartId: "S23", modules: [], dependencies: [] };
    case "S24": return { ...base, chartId: "S24", states: [], events: [], cells: [] };
    case "S25": return { ...base, chartId: "S25", failures: [] };
    case "S26": return { ...base, chartId: "S26", metrics: [] };
    case "S27": return { ...base, chartId: "S27", elements: [], relationships: [] };
    case "S28": return { ...base, chartId: "S28", participants: [], messages: [], fragments: [] };
  }
}

/** S1 offline: a generic container/component diagram from call relationships. */
function s1Offline(req: ModelRequest): ChartOutputV2 {
  const { nodes, edges } = callFlowParts(req);
  return {
    contractVersion: "chart.v2", chartId: "S1", chartType: CHART_NAMES.S1, layout: "flow",
    caption: `Offline S1 (C4 container) diagram: ${nodes.length} node(s) from indexed call relationships. Container boundaries and technology choices are not derived offline. ${OFFLINE_LIMIT}`,
    nodes, edges,
  };
}

/** S2 offline: a generic sequence/swimlane diagram from call relationships. */
function s2Offline(req: ModelRequest): ChartOutputV2 {
  const { nodes, edges } = callFlowParts(req);
  return {
    contractVersion: "chart.v2", chartId: "S2", chartType: CHART_NAMES.S2, layout: "lanes",
    caption: `Offline S2 (sequence/swimlane) diagram: ${nodes.length} node(s) from indexed call relationships. Sequence ordering and swimlane lanes are not derived offline. ${OFFLINE_LIMIT}`,
    nodes, edges,
  };
}

/** S5 offline: a generic use case/relationship diagram. */
function s5Offline(req: ModelRequest): ChartOutputV2 {
  const { nodes, edges } = callFlowParts(req);
  return {
    contractVersion: "chart.v2", chartId: "S5", chartType: CHART_NAMES.S5, layout: "network",
    caption: `Offline S5 diagram: ${nodes.length} node(s) from indexed call relationships. ${OFFLINE_LIMIT}`,
    nodes, edges,
  };
}

/** S6 offline: a generic use case diagram. */
function s6Offline(req: ModelRequest): ChartOutputV2 {
  const { nodes, edges } = callFlowParts(req);
  return {
    contractVersion: "chart.v2", chartId: "S6", chartType: CHART_NAMES.S6, layout: "hierarchy",
    caption: `Offline S6 (use case) diagram: ${nodes.length} node(s) from indexed call relationships. ${OFFLINE_LIMIT}`,
    nodes, edges,
  };
}

/** S3 offline: a state machine from indexed call relationships. */
function s3Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const calls = bundle.relationships.filter((r) => r.kind === "calls").slice(0, 60);
  const stateNames = new Set<string>();
  for (const c of calls) { stateNames.add(nameOf.get(c.from) ?? c.from); stateNames.add(nameOf.get(c.to) ?? c.to); }
  const states: ChartPlanStateMachine["states"] = [...stateNames].slice(0, 30).map((name, i) => ({
    id: `s:${i}`, label: name.slice(0, 80), evidenceIds: evidenceForName(bundle, name),
  }));
  const index = new Map(states.map((s, i) => [s.label, `s:${i}`]));
  const transitions: ChartPlanStateMachine["transitions"] = calls.map((r, i) => {
    const from = index.get(nameOf.get(r.from) ?? "");
    const to = index.get(nameOf.get(r.to) ?? "");
    if (!from || !to) return null;
    return { from, to, trigger: r.label ?? "trigger", evidenceIds: evIds(r).slice(0, 20) };
  }).filter((t): t is ChartPlanStateMachine["transitions"][number] => t !== null).slice(0, 60);
  return {
    contractVersion: "chart.v2", chartId: "S3", chartType: CHART_NAMES.S3, layout: "flow",
    caption: `Offline S3 (state machine) diagram: ${states.length} state(s), ${transitions.length} transition(s) from indexed call relationships. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], states, transitions,
  };
}

/** Offline ER charts use JPA table, column, and relationship facts already indexed from the Java AST. */
function erOffline(req: ModelRequest, chartId: "S4" | "S9"): ChartOutputV2 {
  const { bundle } = req;
  const tableEntities = bundle.entities.filter((e) => e.kind === "table").slice(0, 40);
  const tableIds = new Set(tableEntities.map((e) => e.entityId));
  const factsFor = (subject: string, predicate: string) => bundle.facts.filter((f) => f.subject === subject && f.predicate === predicate);
  const factValue = (subject: string, predicate: string): Record<string, unknown> => {
    const v = factsFor(subject, predicate)[0]?.object as { value?: unknown } | undefined;
    return v?.value && typeof v.value === "object" ? v.value as Record<string, unknown> : {};
  };
  const evidenceFor = (subject: string, predicate: string) => factsFor(subject, predicate).flatMap((f) => f.evidence.map((e) => e.id));
  const tables: ChartPlanErDiagram["tables"] = [];
  for (const e of tableEntities) {
    const columns: ChartPlanErDiagram["tables"][number]["columns"] = [];
    const members = bundle.entities.filter((column) => column.kind === "column" && bundle.relationships.some((r) => r.kind === "contains" && r.from === e.entityId && r.to === column.entityId));
    for (const col of members.slice(0, 60)) {
      const value = factValue(col.entityId, "persisted_column");
      const columnEvidence = evidenceFor(col.entityId, "persisted_column");
      columns.push({
        name: typeof value.columnName === "string" ? value.columnName : col.name,
        ...(typeof value.javaType === "string" ? { type: value.javaType } : {}),
        ...(typeof value.isPrimaryKey === "boolean" ? { isPrimaryKey: value.isPrimaryKey } : {}),
        ...(typeof value.isForeignKey === "boolean" ? { isForeignKey: value.isForeignKey } : {}),
        ...(typeof value.isNullable === "boolean" ? { isNullable: value.isNullable } : {}),
        ...(typeof value.isUnique === "boolean" ? { isUnique: value.isUnique } : {}),
        evidenceIds: columnEvidence.slice(0, 20),
      });
    }
    const tableEvidence = [...new Set([...evidenceFor(e.entityId, "persisted_table"), ...columns.flatMap((c) => c.evidenceIds)])].slice(0, 20);
    tables.push({
      id: e.entityId, name: e.name.slice(0, 200),
      columns, evidenceIds: tableEvidence,
    });
  }
  const relationships: ChartPlanErDiagram["relationships"] = bundle.relationships.filter((r) => ["foreign_key", "persistence_association"].includes(r.kind) && tableIds.has(r.from) && tableIds.has(r.to)).slice(0, 80).map((r) => {
    const label = r.label ?? "";
    const cardinality = label.includes("N:M") ? "N:M" : label.includes("1:1") ? "1:1" : "1:N";
    const fkColumn = r.kind === "foreign_key" ? label.split("·").slice(1).join("·").trim() : undefined;
    return { fromTable: r.from, toTable: r.to, cardinality, ...(fkColumn ? { fkColumn } : {}), isInferred: false, evidenceIds: r.evidence.map((e) => e.id).slice(0, 20) };
  });
  return {
    contractVersion: "chart.v2", chartId, chartType: CHART_NAMES[chartId], layout: "network",
    caption: `Offline ${chartId} ER diagram: ${tables.length} JPA table(s), ${tables.reduce((n, t) => n + t.columns.length, 0)} column(s), and ${relationships.length} mapped relationship(s) from Java AST annotations. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], tables, relationships,
  };
}

function s4Offline(req: ModelRequest): ChartOutputV2 { return erOffline(req, "S4"); }

/** S7 offline: a BPMN process from indexed symbols. */
function s7Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const elements: ChartPlanBpmn["elements"] = [];
  const seen = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "function" || e.kind === "method") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      elements.push({ id: `e:${elements.length}`, kind: "task", label: name.slice(0, 80), evidenceIds: evidenceForEntity(bundle, e.entityId) });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S7", chartType: CHART_NAMES.S7, layout: "flow",
    caption: `Offline S7 (BPMN) diagram: ${elements.length} task(s) from indexed symbols. Lanes, gateways, and flows are not derived offline. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], elements, flows: [], lanes: [],
  };
}

/** S9 is repository-wide ER, using the same AST-derived persisted facts as S4. */
function s9Offline(req: ModelRequest): ChartOutputV2 { return erOffline(req, "S9"); }

/** S11 offline: a decision table from indexed symbols. */
function semanticEventValue(fact: Fact): Record<string, unknown> {
  const outer = fact.object as { value?: unknown };
  const first = outer?.value;
  if (!first || typeof first !== "object" || Array.isArray(first)) return {};
  const candidate = first as Record<string, unknown>;
  if (typeof candidate.kind === "string") return candidate;
  return candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value)
    ? candidate.value as Record<string, unknown>
    : {};
}

function s11Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const conditions: ChartPlanDecisionTable["conditions"] = [];
  const conditionIds = new Map<string, string>();
  for (const fact of bundle.facts) {
    if (fact.predicate !== "defect.semantic-event.v1") continue;
    const event = semanticEventValue(fact);
    if (event?.kind !== "BRANCH") continue;
    const rawCondition = typeof event.condition === "string" ? event.condition.trim() : "";
    if (!rawCondition || conditionIds.has(rawCondition)) continue;
    const id = `c:${conditions.length}`;
    conditionIds.set(rawCondition, id);
    conditions.push({ id, label: rawCondition.slice(0, 160), evidenceIds: factEvIds(fact).slice(0, 20) });
  }
  // Older analyzer records have no explicit branch condition. Recover only guards that
  // are attached to a statically parsed call, and cite that call's source evidence.
  for (const fact of bundle.facts) {
    if (fact.predicate !== "defect.semantic-event.v1") continue;
    const event = semanticEventValue(fact);
    if (!Array.isArray(event?.pathConditions)) continue;
    for (const candidate of event.pathConditions) {
      if (typeof candidate !== "string" || !candidate.trim() || conditionIds.has(candidate)) continue;
      const id = `c:${conditions.length}`;
      conditionIds.set(candidate, id);
      conditions.push({ id, label: candidate.trim().slice(0, 160), evidenceIds: factEvIds(fact).slice(0, 20) });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S11", chartType: CHART_NAMES.S11, layout: "flow",
    caption: `Offline S11 (decision table): ${conditions.length} distinct branch condition(s) from indexed AST facts. Rule coverage and branch outcomes are not claimed unless separately evidenced. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], conditions, rules: [],
  };
}

/** S12 offline: a saga from indexed symbols. */
function s12Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const steps: ChartPlanSaga["steps"] = [];
  const seen = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "function" || e.kind === "method") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      steps.push({ id: `s:${steps.length}`, label: name.slice(0, 80), kind: "forward", evidenceIds: evidenceForEntity(bundle, e.entityId) });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S12", chartType: CHART_NAMES.S12, layout: "flow",
    caption: `Offline S12 (saga) diagram: ${steps.length} step(s) from indexed symbols. Edges and compensation steps are not derived offline. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], steps,
  };
}

/** S13 offline: an outbox pattern from indexed symbols. */
function s13Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const elements: ChartPlanOutbox["elements"] = [];
  const seen = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "function" || e.kind === "method") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      elements.push({ id: `e:${elements.length}`, kind: "writer", label: name.slice(0, 80), evidenceIds: evidenceForEntity(bundle, e.entityId) });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S13", chartType: CHART_NAMES.S13, layout: "flow",
    caption: `Offline S13 (outbox) diagram: ${elements.length} element(s) from indexed symbols. Flows and pollers are not derived offline. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], elements, flows: [],
  };
}

/** S14 offline: an idempotency matrix from indexed symbols. */
function s14Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const operations: ChartPlanIdempotencyMatrix["operations"] = [];
  const scenarios: ChartPlanIdempotencyMatrix["scenarios"] = [{id:"replay",label:"Same key replay (unverified)"},{id:"concurrent",label:"Concurrent duplicate (unverified)"},{id:"different-key",label:"Different key repeat (unverified)"}];
  const seenOps = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "function" || e.kind === "method") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seenOps.has(name)) continue;
      seenOps.add(name);
      operations.push({ id: `op:${operations.length}`, label: name.slice(0, 80), evidenceIds: evidenceForEntity(bundle, e.entityId) });
      if(operations.length===40)break;
    }
  }
  const cells: ChartPlanIdempotencyMatrix["cells"] = [];
  for (let i = 0; i < operations.length; i++) {
    for (let j = 0; j < scenarios.length; j++) {
      cells.push({
        operationId: operations[i].id, scenarioId: scenarios[j].id,
        outcome: "unknown", evidenceIds: [],
      });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S14", chartType: CHART_NAMES.S14, layout: "flow",
    caption: `Offline S14 (idempotency matrix) diagram: ${operations.length} operation(s), ${scenarios.length} scenario(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], operations, scenarios, cells,
  };
}

/** S15 offline: DI wiring from indexed symbols. */
function s15Offline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const components: ChartPlanDiWiring["components"] = [];
  const componentIdByEntity = new Map<string, string>();
  const seen = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "class" || e.kind === "interface") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const id = `c:${components.length}`;
      componentIdByEntity.set(e.entityId, id);
      components.push({ id, label: name.slice(0, 80), kind: e.kind as "class" | "interface", evidenceIds: evidenceForEntity(bundle, e.entityId) });
    }
  }
  const bindings: ChartPlanDiWiring["bindings"] = bundle.relationships.filter((r) => r.kind === "injects" && componentIdByEntity.has(r.from) && componentIdByEntity.has(r.to)).slice(0, 120).map((r) => ({
    from: componentIdByEntity.get(r.from)!, to: componentIdByEntity.get(r.to)!, injectionKind: "unknown", ...(r.label ? { qualifier: r.label } : {}), evidenceIds: evIds(r).slice(0, 20),
  }));
  return {
    contractVersion: "chart.v2", chartId: "S15", chartType: CHART_NAMES.S15, layout: "flow",
    caption: `Offline S15 (DI wiring) diagram: ${components.length} component(s) from indexed symbols. Bindings and cycles are not derived offline. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], components, bindings, cycles: [],
  };
}

/** S17 offline: UML package diagram from indexed directory structure. */
function packageDiagramOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const byDir = new Map<string, { members: string[]; evIds: Set<string> }>();
  const packageForFile = (file: string) => {
    const parts = file.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/") || "(root)";
  };
  const packageForEntity = new Map<string, string>();
  for (const e of bundle.entities) {
    if (e.kind === "file") continue;
    const d = packageForFile(e.file);
    const existing = byDir.get(d) ?? { members: [], evIds: new Set<string>() };
    existing.members.push(e.entityId);
    packageForEntity.set(e.entityId, d);
    byDir.set(d, existing);
  }
  const packages: ChartPlanPackageDiagram["packages"] = [...byDir.entries()].slice(0, 40).map(([dir, data], i) => ({
    id: `pkg:${i}`, name: dir,
    members: data.members.slice(0, 30).map((m) => ({ text: nameOf.get(m) ?? m, evidenceIds: evidenceForEntity(bundle, m) })),
    evidenceIds: [...new Set([...data.evIds, ...evidenceForDirectory(bundle, dir)])].slice(0, 20),
  }));
  const packageId = new Map(packages.map((p) => [p.name, p.id]));
  const filePackage = new Map(bundle.entities.filter((e) => e.kind === "file").map((e) => [e.entityId, packageForFile(e.file)]));
  const depEvidence = new Map<string, Set<string>>();
  for (const relation of bundle.relationships) {
    if (relation.kind !== "imports") continue;
    const fromDir = filePackage.get(relation.from) ?? packageForEntity.get(relation.from);
    const toDir = filePackage.get(relation.to) ?? packageForEntity.get(relation.to);
    const from = fromDir ? packageId.get(fromDir) : undefined;
    const to = toDir ? packageId.get(toDir) : undefined;
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const evidence = depEvidence.get(key) ?? new Set<string>();
    for (const id of evIds(relation)) evidence.add(id);
    depEvidence.set(key, evidence);
  }
  const dependencies: ChartPlanPackageDiagram["dependencies"] = [...depEvidence].slice(0, 120).map(([key, ids]) => {
    const [from, to] = key.split(">");
    return { from: from!, to: to!, label: "imports", evidenceIds: [...ids].slice(0, 20) };
  });
  return {
    contractVersion: "chart.v2", chartId: "S17", chartType: CHART_NAMES.S17, layout: "flow",
    caption: `Offline S17 (package diagram): ${packages.length} source package(s), ${dependencies.length} cross-package import dependency(ies). Package boundaries use source directories; dependencies are indexed imports. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], packages, dependencies,
  };
}

/** S18 offline: UML communication diagram from indexed symbols. */
function communicationOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const calls = bundle.relationships.filter((r) => r.kind === "calls").slice(0, 40);
  const participants: ChartPlanCommunication["participants"] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    for (const participantId of [c.from, c.to]) {
      const participantName = nameOf.get(participantId) ?? participantId;
      if (!seen.has(participantName)) {
        seen.add(participantName);
        participants.push({ id: `p:${participants.length}`, label: participantName.slice(0, 80), evidenceIds: evidenceForEntity(bundle, participantId) });
      }
    }
  }
  const messages: ChartPlanCommunication["messages"] = calls.slice(0, 40).map((r, i) => ({
    from: participants.find(p => p.label === (nameOf.get(r.from) ?? r.from))?.id ?? `p:${i}`,
    to: participants.find(p => p.label === (nameOf.get(r.to) ?? r.to))?.id ?? `p:${i}`,
    order: i + 1,
    label: r.label ?? "call",
    kind: "sync" as const,
    evidenceIds: evIds(r).slice(0, 20),
  }));
  return {
    contractVersion: "chart.v2", chartId: "S18", chartType: CHART_NAMES.S18, layout: "network",
    caption: `Offline S18 (communication diagram): ${participants.length} participant(s), ${messages.length} message(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], participants, messages,
  };
}

/** S19 offline: UML interaction overview from indexed symbols. */
function interactionOverviewOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const frames: ChartPlanInteractionOverview["frames"] = [];
  const seen = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "function" || e.kind === "method") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      frames.push({ id: `f:${frames.length}`, label: name.slice(0, 80), kind: "interaction", evidenceIds: evidenceForEntity(bundle, e.entityId) });
    }
  }
  const frameByName = new Map(frames.map((f) => [f.label, f.id]));
  const flows: ChartPlanInteractionOverview["flows"] = bundle.relationships.filter((r) => r.kind === "calls").flatMap((r) => {
    const from = frameByName.get(nameOf.get(r.from) ?? ""), to = frameByName.get(nameOf.get(r.to) ?? "");
    return from && to ? [{ from, to, evidenceIds: evIds(r).slice(0, 20) }] : [];
  }).slice(0, 120);
  return {
    contractVersion: "chart.v2", chartId: "S19", chartType: CHART_NAMES.S19, layout: "flow",
    caption: `Offline S19 (interaction overview): ${frames.length} frame(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], frames, flows,
  };
}

/** S20 offline: CRC cards from indexed symbols. */
function crcCardsOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const cards: ChartPlanCrcCards["cards"] = [];
  const seen = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "class" || e.kind === "interface") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      if(cards.length===60) break;
      cards.push({
        className: name.slice(0, 200),
        responsibilities: [],
        collaborators: [],
        evidenceIds: evidenceForEntity(bundle, e.entityId),
      });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S20", chartType: CHART_NAMES.S20, layout: "flow",
    caption: `Offline S20 (CRC cards): ${cards.length} card(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], cards,
  };
}

/** S22 offline: layered architecture from indexed symbols. */
function layeredArchitectureOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const byDir = new Map<string, string[]>();
  for (const e of bundle.entities) {
    if (e.kind === "file") continue;
    const d = dirOf(e.file);
    byDir.set(d, [...(byDir.get(d) ?? []), e.entityId]);
  }
  const layers: ChartPlanLayeredArchitecture["layers"] = [...byDir.keys()].slice(0, 6).map((dir, i) => ({
    id: `layer:${i}`, label: dir.slice(0, 80),
    order: i,
    evidenceIds: evidenceForDirectory(bundle, dir),
  }));
  const layerIndex = new Map([...byDir.keys()].slice(0, 6).map((dir, i) => [dir, `layer:${i}`]));
  const components: ChartPlanLayeredArchitecture["components"] = [...byDir.entries()].filter(([dir]) => layerIndex.has(dir)).map(([dir], i) => ({
    id: `comp:${i}`, label: dir.slice(0, 80),
    layerId: layerIndex.get(dir)!,
    kind: "component",
    evidenceIds: evidenceForDirectory(bundle, dir),
  }));
  const edges: ChartPlanLayeredArchitecture["edges"] = [];
  return {
    contractVersion: "chart.v2", chartId: "S22", chartType: CHART_NAMES.S22, layout: "lanes",
    caption: `Offline S22 (layered architecture): ${layers.length} layer(s), ${components.length} component(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges, layers, components,
  };
}

/** S23 offline: dependency / module graph from indexed directory structure. */
function moduleGraphOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const byDir = new Map<string, { members: string[]; evIds: Set<string> }>();
  const moduleOf = new Map<string, string>();
  const modulePathOf = (file: string) => {
    const parts = file.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/") || "(root)";
  };
  for (const e of bundle.entities) {
    const d = modulePathOf(e.file);
    const existing = byDir.get(d) ?? { members: [], evIds: new Set<string>() };
    existing.members.push(e.entityId);
    moduleOf.set(e.entityId, d);
    byDir.set(d, existing);
  }
  const selectedDirs = [...byDir.entries()].slice(0, 80);
  const modules: ChartPlanModuleGraph["modules"] = selectedDirs.map(([dir, data], i) => ({
    id: `mod:${i}`, label: dir,
    kind: "module" as const,
    evidenceIds: [...new Set([...data.evIds, ...evidenceForDirectory(bundle, dir)])].slice(0, 20),
  }));
  const moduleIds = new Map(modules.map((m) => [m.label, m.id]));
  const isTestFile = (entityId: string) => /(^|\/)(test|tests|__tests__|spec)(\/|\.)/i.test(bundle.entities.find((e) => e.entityId === entityId)?.file ?? entityId);
  const dependenciesByKey = new Map<string, { from: string; to: string; kind: ChartPlanModuleGraph["dependencies"][number]["kind"]; label: string; evidenceIds: Set<string> }>();
  for (const relation of bundle.relationships) {
    if (!["imports", "calls", "async-flow"].includes(relation.kind)) continue;
    const fromModule = moduleIds.get(moduleOf.get(relation.from) ?? "");
    const toModule = moduleIds.get(moduleOf.get(relation.to) ?? "");
    if (!fromModule || !toModule || fromModule === toModule) continue;
    const kind: ChartPlanModuleGraph["dependencies"][number]["kind"] = relation.kind === "imports"
      ? (isTestFile(relation.from) ? "test" : "compileTime")
      : relation.kind === "async-flow" ? "runtime" : "runtime";
    const key = `${fromModule}>${toModule}:${kind}`;
    const row = dependenciesByKey.get(key) ?? { from: fromModule, to: toModule, kind, label: relation.kind, evidenceIds: new Set<string>() };
    for (const id of evIds(relation)) row.evidenceIds.add(id);
    dependenciesByKey.set(key, row);
  }
  const dependencies: ChartPlanModuleGraph["dependencies"] = [...dependenciesByKey.values()].slice(0, 160).map((d) => ({
    from: d.from, to: d.to, kind: d.kind, label: d.label, evidenceIds: [...d.evidenceIds].slice(0, 20),
  }));
  return {
    contractVersion: "chart.v2", chartId: "S23", chartType: CHART_NAMES.S23, layout: "flow",
    caption: `Offline S23 (module graph): ${modules.length} source-directory module(s), ${dependencies.length} cross-module compile-time, runtime, or test dependency(ies) from indexed imports and calls. Same-directory links are collapsed into their module. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], modules, dependencies,
  };
}

/** S24 offline: state transition table from indexed symbols. */
function stateTransitionTableOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const states: ChartPlanStateTransitionTable["states"] = [];
  const events: ChartPlanStateTransitionTable["events"] = [];
  const seenStates = new Set<string>();
  const seenEvents = new Set<string>();
  for (const e of bundle.entities) {
    if (e.kind === "function" || e.kind === "method") {
      const name = nameOf.get(e.entityId) ?? e.name;
      if (!seenStates.has(name)) {
        seenStates.add(name);
        states.push({ id: `st:${states.length}`, label: name.slice(0, 80), evidenceIds: evidenceForEntity(bundle, e.entityId) });
      }
    }
  }
  const cells: ChartPlanStateTransitionTable["cells"] = [];
  for (let i = 0; i < Math.min(states.length, 10); i++) {
    for (let j = 0; j < Math.min(events.length, 5); j++) {
      cells.push({
        stateId: states[i].id, eventId: events[j].id,
        nextStateId: states[Math.min(i + 1, states.length - 1)].id,
        evidenceIds: evidenceForName(bundle, states[i].label),
      });
    }
  }
  return {
    contractVersion: "chart.v2", chartId: "S24", chartType: CHART_NAMES.S24, layout: "flow",
    caption: `Offline S24 (state transition table): ${states.length} state(s), ${events.length} event(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], states, events, cells,
  };
}

/** S25 offline: FMEA / compensation matrix from indexed symbols. */
function fmeaOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const failures: ChartPlanFmeaMatrix["failures"] = bundle.facts.filter((f) => f.predicate === "throws").slice(0, 60).map((f, i) => {
    const errorClass = String((f.object as { value?: unknown }).value ?? "exception");
    const sourceName = nameOf.get(f.subject) ?? f.subject;
    const compensations = bundle.relationships.filter((r) => r.kind === "calls" && r.from === f.subject && /rollback|cancel|compensat|revert|release|cleanup/i.test(nameOf.get(r.to) ?? r.label ?? ""));
    const compensation = compensations.length ? {
      text: `Same function also calls ${compensations.map((r) => nameOf.get(r.to) ?? r.to).join(", ")}; the static index does not establish that this call handles this throw.`,
      evidenceIds: [...new Set(compensations.flatMap(evIds))].slice(0, 20),
    } : undefined;
    return { id: `f:${i}`, label: `${sourceName} throws ${errorClass}`.slice(0, 200), impact: { text: "impact is not established by the indexed throw site", evidenceIds: [] }, ...(compensation ? { compensation } : {}), evidenceIds: factEvIds(f).slice(0, 20) };
  });
  return {
    contractVersion: "chart.v2", chartId: "S25", chartType: CHART_NAMES.S25, layout: "flow",
    caption: `Offline S25 (FMEA): ${failures.length} indexed throw site(s). Impact remains unknown unless supported by separate evidence; same-function compensation calls are shown as candidates, not proven handlers. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], failures,
  };
}

/** S26 offline: metrics map from indexed symbols. */
function metricsOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const metrics: ChartPlanMetricsMap["metrics"] = bundle.facts.filter((f) => f.predicate === "metric_declaration" && typeof f.object.value === "string" && f.object.value.trim()).slice(0, 60).map((f, i) => {
    const name = String((f.object as { value?: unknown }).value ?? f.predicate);
    const kind = (f.object as { metricKind?: unknown }).metricKind;
    return { id: `m:${i}`, name: name.slice(0, 200), ...(typeof kind === "string" ? { meaning: `Declared through ${kind}; live emission and runtime values are not established.` } : {}), emitters: [{ label: bundle.entities.find((e) => e.entityId === f.subject)?.name ?? f.subject, evidenceIds: factEvIds(f).slice(0, 20) }], evidenceIds: factEvIds(f).slice(0, 20) };
  });
  return {
    contractVersion: "chart.v2", chartId: "S26", chartType: CHART_NAMES.S26, layout: "flow",
    caption: `Offline S26 (metrics): ${metrics.length} statically declared metric instrument(s). No live values are shown. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], metrics,
  };
}

/** S27 offline: C4 context diagram from indexed symbols. */
function c4ContextOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const externalImports = bundle.facts.filter((f) => f.predicate === "imports_external").slice(0, 40);
  const systemEvidence = [...new Set([
    ...externalImports.flatMap(factEvIds),
    ...bundle.relationships.filter((r) => r.kind === "calls" || r.kind === "imports").flatMap(evIds),
  ])].slice(0, 20);
  const elements: ChartPlanC4Context["elements"] = [{
    id: "system:repo", label: "Repository software", kind: "softwareSystem",
    description: "The indexed repository boundary; its deployed name and users are not declared in source evidence.",
    evidenceIds: systemEvidence,
  }];
  const relationships: ChartPlanC4Context["relationships"] = [];
  const seen = new Set<string>();
  for (const fact of externalImports) {
    const imported = String((fact.object as { value?: unknown }).value ?? "").trim();
    if (!imported) continue;
    // Only recognizable infrastructure/provider clients are shown as possible context
    // systems. A library import alone does not prove a deployed dependency.
    if (!/(^|\/)(redis|ioredis|mysql|mysql2|pg|postgres|mongodb|mongoose|kafka|amqplib|rabbitmq|stripe|paypal|aws-sdk|@aws-sdk)(\/|$)/i.test(imported)) continue;
    const label = imported.split("/").slice(0, 2).join("/");
    if (seen.has(label)) continue;
    seen.add(label);
    const id = `external:${seen.size}`;
    const evidenceIds = factEvIds(fact).slice(0, 20);
    elements.push({ id, label, kind: "externalSystem", description: "Possible external system inferred from an imported client; runtime connection is not established by this import alone.", evidenceIds });
    relationships.push({ from: "system:repo", to: id, label: `imports client for ${label}`, evidenceIds });
  }
  return {
    contractVersion: "chart.v2", chartId: "S27", chartType: CHART_NAMES.S27, layout: "flow",
    caption: `Offline S27 (C4 context): repository boundary plus ${seen.size} possible external system(s) grounded in infrastructure/provider client imports. Users, deployment names, and runtime connections remain gaps. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], elements, relationships,
  };
}

/** R1 offline: propose a bounded replay scenario; core's twin kernel produces the measured content deterministically. */
function raceOffline(req: ModelRequest): ChartOutputV2 {
  // The offline replay proposes the scenario; the twin kernel in core supplies the measured content deterministically.
  const subject = req.bundle.entities.find((e) => e.kind !== "file")?.name ?? "checkout";
  return {
    contractVersion: "chart.v2", chartId: "R1", chartType: CHART_NAMES.R1, layout: "timeline",
    caption: `Offline replay of the ${subject} flow on the pinned reference twin model. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [],
    subject, scenario: "timeout", arrivalRatePerSec: 80, durationSec: 30, timeoutMs: 14, faultProbability: 0.05, seed: "stub-r1",
  };
}

function sequenceOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const calls = bundle.relationships.filter((r) => r.kind === "calls").slice(0, 20);
  const participants: ChartPlanSequence["participants"] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    for (const participantId of [c.from, c.to]) {
      const participantName = nameOf.get(participantId) ?? participantId;
      if (!seen.has(participantName)) {
        seen.add(participantName);
        participants.push({ id: `p:${participants.length}`, label: participantName.slice(0, 80), evidenceIds: evidenceForEntity(bundle, participantId) });
      }
    }
  }
  const messages: ChartPlanSequence["messages"] = calls.slice(0, 20).map((r, i) => ({
    from: participants.find(p => p.label === (nameOf.get(r.from) ?? r.from))?.id ?? `p:${i}`,
    to: participants.find(p => p.label === (nameOf.get(r.to) ?? r.to))?.id ?? `p:${i}`,
    order: i + 1,
    label: r.label ?? "call",
    kind: "sync" as const,
    evidenceIds: evIds(r).slice(0, 20),
  }));
  const fragments: ChartPlanSequence["fragments"] = [];
  return {
    contractVersion: "chart.v2", chartId: "S28", chartType: CHART_NAMES.S28, layout: "flow",
    caption: `Offline S28 (sequence diagram): ${participants.length} participant(s), ${messages.length} message(s). ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], participants, messages, fragments,
  };
}

/** S21 offline: a static call graph from resolved call relationships. Notation-specific grouping
 *  (owner classes, modules) is only derived when the bundle carries it; no runtime claim is made. */
function callGraphOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const kindOf = new Map(bundle.entities.map((e) => [e.entityId, e.kind]));
  const calls = bundle.relationships.filter((r) => r.kind === "calls").slice(0, 80);
  const questionWords = new Set((req.question.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).map((x) => x.toLocaleLowerCase()));
  const explicitRoots = bundle.entities.filter((e) => ["function", "method"].includes(e.kind) && questionWords.has(e.name.split(".").at(-1)!.toLocaleLowerCase())).map((e) => e.entityId);
  const usedIds = [...new Set([...calls.flatMap((r) => [r.from, r.to]), ...explicitRoots])].filter((id) => nameOf.has(id)).slice(0, 40);
  const used = new Set(usedIds);
  const functions: ChartPlanCallGraph["functions"] = usedIds.map((id, i) => ({
    id: `fn:${i}`, label: nameOf.get(id) ?? id,
    kind: kindOf.get(id) === "method" ? "method" : "function",
    evidenceIds: [...new Set(calls.filter((r) => (r.from === id || r.to === id) && used.has(r.from) && used.has(r.to)).flatMap(evIds))].slice(0, 20),
  }));
  const index = new Map(usedIds.map((id, i) => [id, `fn:${i}`]));
  const callEdges: ChartPlanCallGraph["calls"] = calls
    .filter((r) => index.has(r.from) && index.has(r.to))
    .map((r) => ({ from: index.get(r.from)!, to: index.get(r.to)!, label: r.label, evidenceIds: evIds(r).slice(0, 20) }));
  return {
    contractVersion: "chart.v2", chartId: "S21", chartType: CHART_NAMES.S21, layout: "flow",
    caption: `Offline static call graph: ${functions.length} function(s), ${callEdges.length} resolved call edge(s). Every edge is static source evidence; no runtime frequency or ordering beyond source order is implied. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], functions, calls: callEdges,
  };
}

/** S16 offline: classes, members and statically resolved UML relations from the evidence bundle. */
function classDiagramOffline(req: ModelRequest): ChartOutputV2 {
  const { bundle } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const memberEv = new Map<string, string[]>();
  for (const r of bundle.relationships) for (const id of [r.from, r.to]) memberEv.set(id, [...(memberEv.get(id) ?? []), ...evIds(r)]);
  const ev = (id: string) => [...new Set(memberEv.get(id) ?? [])].slice(0, 20);
  const signatures = new Map(bundle.facts.filter((f) => f.predicate === "signature").map((f) => [f.subject, { text: String((f.object as { value?: unknown }).value ?? ""), evidenceIds: factEvIds(f) }]));
  const byPrefix = new Map<string, { attrs: { text: string; evidenceIds: string[] }[]; ops: { text: string; evidenceIds: string[] }[] }>();
  for (const e of bundle.entities) {
    if (e.kind !== "field" && e.kind !== "method") continue;
    const dot = e.name.lastIndexOf(".");
    if (dot < 0) continue;
    const cls = e.name.slice(0, dot), label = e.name.slice(dot + 1);
    const slot = byPrefix.get(cls) ?? { attrs: [], ops: [] };
    const signature = signatures.get(e.entityId);
    const ids = [...new Set([...ev(e.entityId), ...(signature?.evidenceIds ?? [])])].slice(0, 20);
    if (e.kind === "field" && slot.attrs.length < 30) slot.attrs.push({ text: `- ${label}`, evidenceIds: ids });
    else if (e.kind === "method" && slot.ops.length < 30) slot.ops.push({ text: `+ ${signature?.text || `${label}()`}`, evidenceIds: ids });
    byPrefix.set(cls, slot);
  }
  const classes = bundle.entities.filter((e) => e.kind === "class" || e.kind === "interface" || e.kind === "enum").slice(0, 60).map((e, i) => {
    const members = byPrefix.get(e.name) ?? { attrs: [], ops: [] };
    return {
      id: `cls:${i}`, name: e.name, kind: e.kind as "class" | "interface" | "enum",
      attributes: members.attrs, operations: members.ops,
      evidenceIds: [...new Set([...ev(e.entityId), ...members.attrs.flatMap((a) => a.evidenceIds), ...members.ops.flatMap((o) => o.evidenceIds)])].slice(0, 20),
    };
  });
  const index = new Map(classes.map((c) => [c.name, c.id]));
  const KIND: Record<string, "inheritance" | "realization" | "association"> = { extends: "inheritance", implements: "realization", association: "association" };
  const relations = bundle.relationships.flatMap((r) => {
    const kind = KIND[r.kind];
    if (!kind) return [];
    const from = index.get(nameOf.get(r.from) ?? ""), to = index.get(nameOf.get(r.to) ?? "");
    return from && to && from !== to ? [{ from, to, kind, ...(r.label ? { label: r.label } : {}), isInferred: false, evidenceIds: evIds(r).slice(0, 20) }] : [];
  }).slice(0, 120);
  return {
    contractVersion: "chart.v2", chartId: "S16", chartType: CHART_NAMES.S16, layout: "network",
    caption: `Offline UML class diagram: ${classes.length} class(es)/interface(s)/enum(s) and ${relations.length} statically resolved relation(s), drawn only from indexed symbols and declared types. ${OFFLINE_LIMIT}`,
    nodes: [], edges: [], classes, relations,
  };
}

/** chart.v2: the selected chartId decides what the stub may produce. */
function chartV2(req: ModelRequest, chartId: string): ChartOutputV2 {
  switch (chartId) {
    case "S1": return s1Offline(req);
    case "S2": return s2Offline(req) as ChartOutputV2;
    case "S3": return s3Offline(req) as ChartOutputV2;
    case "S4": return s4Offline(req) as ChartOutputV2;
    case "S5": return s5Offline(req) as ChartOutputV2;
    case "S6": return s6Offline(req) as ChartOutputV2;
    case "S7": return s7Offline(req) as ChartOutputV2;
    case "S8": return eventStormingOffline(req);
    case "S9": return s9Offline(req) as ChartOutputV2;
    case "S10": return dfdOffline(req) as ChartOutputV2;
    case "S11": return s11Offline(req) as ChartOutputV2;
    case "S12": return s12Offline(req) as ChartOutputV2;
    case "S13": return s13Offline(req) as ChartOutputV2;
    case "S14": return s14Offline(req) as ChartOutputV2;
    case "S15": return s15Offline(req) as ChartOutputV2;
    case "S16": return classDiagramOffline(req) as ChartOutputV2;
    case "S17": return packageDiagramOffline(req) as ChartOutputV2;
    case "S18": return communicationOffline(req) as ChartOutputV2;
    case "S19": return interactionOverviewOffline(req) as ChartOutputV2;
    case "S20": return crcCardsOffline(req) as ChartOutputV2;
    case "S21": return callGraphOffline(req) as ChartOutputV2;
    case "S22": return layeredArchitectureOffline(req) as ChartOutputV2;
    case "S23": return moduleGraphOffline(req) as ChartOutputV2;
    case "S24": return stateTransitionTableOffline(req) as ChartOutputV2;
    case "S25": return fmeaOffline(req) as ChartOutputV2;
    case "S26": return metricsOffline(req) as ChartOutputV2;
    case "S27": return c4ContextOffline(req) as ChartOutputV2;
    case "S28": return sequenceOffline(req) as ChartOutputV2;
    case "R1": return raceOffline(req) as ChartOutputV2;
    default: {
      // generic: the standard nodes/edges fields, honestly labeled.
      const { nodes, edges } = callFlowParts(req);
      const name = CHART_NAMES.generic;
      return {
        contractVersion: "chart.v2", chartId: "generic", chartType: name, layout: "flow",
        caption: `Offline arrangement of indexed call relationships for the generic chart; notation-specific boundaries and labels are not derived offline. ${OFFLINE_LIMIT}`,
        nodes, edges,
      };
    }
  }
}

function explain(req: ModelRequest): ExplanationOutput {
  const sel = req.selected ?? [];
  const byId = new Map(req.bundle.entities.map((e) => [e.entityId, e]));
  const adj = new Map<string, { to: string; rel: Relationship }[]>();
  for (const r of req.bundle.relationships) {
    if (r.kind === "contains") continue;
    adj.set(r.from, [...(adj.get(r.from) ?? []), { to: r.to, rel: r }]);
    adj.set(r.to, [...(adj.get(r.to) ?? []), { to: r.from, rel: r }]);
  }
  const name = (id: string) => byId.get(id)?.name ?? id;
  const claims: ExplanationOutput["claims"] = [];
  const disconnected: string[] = [];

  for (let i = 0; i < sel.length; i++) {
    for (let j = i + 1; j < sel.length; j++) {
      const path = shortestPath(adj, sel[i], sel[j], 4);
      if (!path) { disconnected.push(`${name(sel[i])} / ${name(sel[j])}`); continue; }
      const chain = [name(sel[i]), ...path.map((p, k) => {
        // Arrow follows the real edge direction, not the traversal direction.
        const prevId = k === 0 ? sel[i] : path[k - 1].to;
        const forward = p.rel.from === prevId;
        const arrow = p.rel.kind === "calls" ? (forward ? "calls" : "is called by") : forward ? "imports" : "is imported by";
        return `${arrow} ${name(p.to)}`;
      })].join(" ");
      claims.push({
        assertion: `${name(sel[i])} and ${name(sel[j])} are connected: ${chain}.`,
        claimClass: "structural-path",
        evidenceIds: path.flatMap((p) => evIds(p.rel)),
        counterEvidenceIds: [],
        rationaleSummary: `Shortest path of ${path.length} statically extracted edge(s) in the retrieved subgraph.`,
        pathEntityIds: [sel[i], ...path.map((p) => p.to)],
      });
    }
  }
  const summary = claims.length
    ? `Found ${claims.length} static connection(s) among the selection.` +
      (disconnected.length ? ` No static path within 4 hops for: ${disconnected.join("; ")}.` : "")
    : sel.length < 2
      ? "Select at least two elements to ask how they are connected."
      : `No static connection within 4 hops in the retrieved evidence (${disconnected.join("; ")}). They may still interact through dynamic calls or runtime behavior that static analysis cannot see.`;
  return { summary, claims };
}

function shortestPath(adj: Map<string, { to: string; rel: Relationship }[]>, a: string, b: string, max: number) {
  const prev = new Map<string, { from: string; to: string; rel: Relationship }>();
  const q: [string, number][] = [[a, 0]];
  const seen = new Set([a]);
  while (q.length) {
    const [cur, d] = q.shift()!;
    if (cur === b) {
      const path: { to: string; rel: Relationship }[] = [];
      for (let n = b; n !== a; ) { const p = prev.get(n)!; path.unshift({ to: n, rel: p.rel }); n = p.from; }
      return path;
    }
    if (d >= max) continue;
    for (const e of adj.get(cur) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: cur, to: e.to, rel: e.rel });
      q.push([e.to, d + 1]);
    }
  }
  return null;
}

const factValue = (f: { object: { [k: string]: unknown } }) => String(f.object.value ?? "");

/** Offline hypothesis seeding from structure: genuinely competing candidate explanations, each grounded in
 *  bundle facts/relationships, each with at least one prediction a registered read tool can settle. Every
 *  entity id and evidence id is copied from the bundle; a real gateway's output is validated the same way. */
function hypothesize(req: ModelRequest): HypothesesOutput {
  const { bundle, question } = req;
  const nameOf = new Map(bundle.entities.map((e) => [e.entityId, e.name]));
  const containsEv = new Map<string, string[]>();
  for (const r of bundle.relationships) if (r.kind === "contains") containsEv.set(r.to, evIds(r));
  const evOf = (id: string) => containsEv.get(id) ?? [];
  const out: HypothesesOutput["hypotheses"] = [];

  // H_a: the failure is an unhandled throw at a named site — the strongest kind of competing candidate.
  const throwsFacts = bundle.facts.filter((f) => f.predicate === "throws");
  for (const f of throwsFacts.slice(0, 2)) {
    out.push({
      statement: `${nameOf.get(f.subject) ?? f.subject} throws ${factValue(f) || "an error"}, and nothing in the visible call structure shows the caller handling it`,
      mechanism: [{ from: f.subject, to: f.subject, relation: "CAUSES_CANDIDATE", evidenceIds: [...evOf(f.subject), ...f.evidence.map((e) => e.id)].slice(0, 10) }],
      assumptions: ["the throw fires on the path the symptom travelled", "a caller of this code would surface the error"],
      predictions: [{
        description: `${nameOf.get(f.subject) ?? f.subject} has a throw statement`, tool: "source.entity", payload: { entityId: f.subject, predicate: "throws" },
        outcomeIfTrue: ["PRESENT"], outcomeIfFalse: ["ABSENT_WITH_COVERAGE"], essential: true,
      }],
      basisEvidenceIds: [...new Set([...evOf(f.subject), ...f.evidence.map((e) => e.id)])].slice(0, 10),
    });
  }

  // H_b: state is changed outside a transaction, so a failure part-way corrupts what the operation reads.
  const txWriters = new Set(bundle.facts.filter((f) => f.predicate === "uses_transaction").map((f) => f.subject));
  const bareWriter = bundle.facts.find((f) => f.predicate === "writes" && !txWriters.has(f.subject));
  if (bareWriter) {
    out.push({
      statement: `${nameOf.get(bareWriter.subject) ?? bareWriter.subject} changes ${factValue(bareWriter) || "state"} outside any transaction`,
      mechanism: [{ from: bareWriter.subject, to: bareWriter.subject, relation: "CONTRIBUTES_TO", evidenceIds: [...evOf(bareWriter.subject), ...bareWriter.evidence.map((e) => e.id)].slice(0, 10) }],
      assumptions: ["the failing operation reads the state this code writes"],
      predictions: [{
        description: `${nameOf.get(bareWriter.subject) ?? bareWriter.subject} uses no transaction`, tool: "source.entity", payload: { entityId: bareWriter.subject, predicate: "uses_transaction" },
        outcomeIfTrue: ["ABSENT_WITH_COVERAGE"], outcomeIfFalse: ["PRESENT"], essential: true,
      }, {
        description: `${nameOf.get(bareWriter.subject) ?? bareWriter.subject} writes state`, tool: "source.entity", payload: { entityId: bareWriter.subject, predicate: "writes" },
        outcomeIfTrue: ["PRESENT"], outcomeIfFalse: ["ABSENT_WITH_COVERAGE"], essential: false,
      }],
      basisEvidenceIds: [...new Set([...evOf(bareWriter.subject), ...bareWriter.evidence.map((e) => e.id)])].slice(0, 10),
    });
  }

  // H_c: a dynamic call hides where it really fails, so static analysis cannot see the faulty callee.
  const fog = bundle.facts.find((f) => f.resolution === "UNRESOLVED" && f.predicate === "calls");
  if (fog) {
    out.push({
      statement: `a dynamic call in ${nameOf.get(fog.subject) ?? fog.subject} reaches code static analysis cannot see`,
      mechanism: [{ from: fog.subject, to: fog.subject, relation: "CONTRIBUTES_TO", evidenceIds: [...evOf(fog.subject), ...fog.evidence.map((e) => e.id)].slice(0, 10) }],
      assumptions: ["the dynamic call executes during the incident"],
      predictions: [{
        description: `${nameOf.get(fog.subject) ?? fog.subject} has calls analysis could not resolve`, tool: "source.entity", payload: { entityId: fog.subject, predicate: "unresolved_calls" },
        outcomeIfTrue: ["PRESENT"], outcomeIfFalse: ["ABSENT_WITH_COVERAGE"], essential: true,
      }],
      basisEvidenceIds: [...new Set([...evOf(fog.subject), ...fog.evidence.map((e) => e.id)])].slice(0, 10),
    });
  }

  // H_d: an asynchronous hand-off swallows the failure; the original caller never sees it.
  const flow = bundle.relationships.find((r) => r.kind === "async-flow");
  if (flow) {
    out.push({
      statement: `the failure is swallowed by an asynchronous hand-off from ${nameOf.get(flow.from) ?? flow.from} to ${nameOf.get(flow.to) ?? flow.to}`,
      mechanism: [{ from: flow.from, to: flow.to, relation: "PRECEDES", evidenceIds: evIds(flow).slice(0, 10) }],
      assumptions: ["the hand-off is on the path the symptom travelled"],
      predictions: [{
        description: "an asynchronous call path exists between the two", tool: "graph.paths", payload: { from: flow.from, to: flow.to, maxDepth: 4 },
        outcomeIfTrue: ["PRESENT"], outcomeIfFalse: ["ABSENT_WITH_COVERAGE"], essential: true,
      }],
      basisEvidenceIds: evIds(flow).slice(0, 10),
    });
  }

  // Always at least one draft, grounded on whatever the bundle says about the question words, so the seed never arrives empty.
  if (!out.length) {
    const words = question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
    const anchor = bundle.entities.find((e) => e.kind !== "file" && words.some((w) => e.name.toLowerCase().includes(w)) && evOf(e.entityId).length);
    if (anchor) {
      out.push({
        statement: `the answer lies in how ${anchor.name} is organized; its callers and callees decide where the question resolves`,
        mechanism: [{ from: anchor.entityId, to: anchor.entityId, relation: "CONTRIBUTES_TO", evidenceIds: evOf(anchor.entityId).slice(0, 10) }],
        assumptions: ["the indexed relationships around this code are complete enough"],
        predictions: [{
          description: `${anchor.name} has at least one caller`, tool: "graph.dependents", payload: { entityId: anchor.entityId, depth: 2, minCount: 1 },
          outcomeIfTrue: ["PRESENT"], outcomeIfFalse: ["ABSENT_WITH_COVERAGE"], essential: false,
        }],
        basisEvidenceIds: evOf(anchor.entityId).slice(0, 10),
      });
    } else {
      const q = words.slice(0, 3).join(" ") || question.slice(0, 20);
      out.push({
        statement: `the answer lies in how code matching "${q}" is organized; retrieval can narrow it down`,
        mechanism: [], assumptions: ["the indexed relationships are complete enough to retrieve the relevant code"],
        predictions: [{ description: "retrieval finds entities matching the question", tool: "retrieve.evidence", payload: { query: q }, outcomeIfTrue: ["PRESENT"], outcomeIfFalse: [], essential: false }],
        basisEvidenceIds: [],
      });
    }
  }
  return { hypotheses: out.slice(0, 8) };
}

/** Offline naming is deliberately mechanical: kind plus the first member's own name. */
function nameConcepts(req: ModelRequest): NameConceptOutput | NameArchOutput {
  const parsed = JSON.parse(req.question) as { concepts?: { conceptId: string; kind: string; members?: { name: string }[] }[]; packages?: { conceptId: string; path: string }[] };
  if (parsed.packages) {
    return { names: parsed.packages.map((p) => ({ conceptId: p.conceptId, name: p.path.split("/").pop() ?? p.path, rationale: "the offline model uses the directory name" })) };
  }
  const concepts = parsed.concepts ?? [];
  return {
    names: concepts.map((c) => {
      const first = c.members?.[0]?.name ?? "code";
      return { conceptId: c.conceptId, name: `${c.kind} in ${first}`.slice(0, 60), rationale: "the offline model names the shape and its site" };
    }),
  };
}

export class StubProvider implements ModelProvider {
  readonly name = "stub";
  readonly model = "deterministic-graph-v1";
  readonly hosted = false;
  async generate(req: ModelRequest): Promise<unknown> {
    switch (req.purpose) {
      case "SOURCE_OVERVIEW": return inferSourceOverview(req.bundle);
      case "REPRESENT": return represent(req);
      case "EXPLAIN": return explain(req);
      // The deterministic adversarial checks run in core; the stub has no judgment of its own to add.
      case "CHALLENGE": return { objections: [] } satisfies ChallengeOutput;
      case "HYPOTHESIZE": return hypothesize(req);
      case "CHART": return req.chartId !== undefined ? chartV2(req, req.chartId) : chart(req);
      // Routing by judgment needs a language model; offline, the rule and similarity layers have already answered.
      case "ROUTE": return { form: null, confidence: 0, reason: "the offline model does not route" };
      // Naming is a transformation of what is already known, so the stub can do it deterministically.
      case "NAME_CONCEPT": case "NAME_ARCH": return nameConcepts(req);
    }
  }
}

export type { EvidenceBundle };
