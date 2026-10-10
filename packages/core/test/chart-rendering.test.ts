// Chart rendering requirements (docs/chart-rendering-requirements.md): contract tests for the
// typed chart.v2 pipeline — compilation, evidence validation, cache isolation and the honest
// offline stub. Deterministic: no model, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { ChartOutput, ChartOutputV2, SCHEMA_CHART, SCHEMA_CHART_V2, type ChartPlanBpmn, type ChartPlanC4Context, type ChartPlanCallGraph, type ChartPlanClassDiagram, type ChartPlanCommunication, type ChartPlanDiWiring, type ChartPlanDfd, type ChartPlanErDiagram, type ChartPlanEventStorming, type ChartPlanInteractionOverview, type ChartPlanLayeredArchitecture, type ChartPlanModuleGraph, type ChartPlanOutbox, type ChartPlanPackageDiagram, type ChartPlanSaga, type ChartPlanSequence, type ChartPlanStateMachine, type EvidenceBundle, type EvidenceRef, type ViewRoute } from "@cie/schema";
import { StubProvider } from "@cie/model";
import { cachedChartPlan, chartPlanCacheKey, compileChartPlan, rememberChartPlan, type ChartCompileDiag } from "../src/chart-creator.ts";
import type { RevisionRow } from "../src/store.ts";
import { Store } from "../src/store.ts";

// ── deterministic fixtures ───────────────────────────────────────────────────────────
let seq = 0;
const evRef = (state: EvidenceRef["state"] = "CURRENT", cls: EvidenceRef["class"] = "STATIC_RESOLVED"): EvidenceRef => ({
  id: `ev:${++seq}`, sourceId: "src", class: cls,
  location: { kind: "CodeLocation", span: { sourceId: "src", contentHash: "h", revision: "rev", startByte: 0, endByteExclusive: 10 } },
  observedAt: "2026-01-01T00:00:00Z", accessScopeId: "scope", state,
});

const makeBundle = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  id: "bundle", revision: "rev", evidence: [], entities: [], relationships: [], facts: [],
  coverage: [], unresolved: [], tokenEstimate: 120, ...over,
});

const rev: RevisionRow = { id: "rev", repoRoot: "/r", gitHead: null, createdAt: "t", analyzerVersion: "t", diagnostics: [], fileCount: 0 };

const route: ViewRoute = { source: "chosen", confidence: "high", form: "GeneratedChart", name: "Selected chart", because: "", alternatives: [] };

const compile = (plan: ChartOutputV2 | ChartOutput, b: EvidenceBundle, chartId?: string, diag?: ChartCompileDiag) =>
  compileChartPlan({ plan, bundle: b, rev, question: "show me", route, chartId, diag });

test("S3 state machine: evidenced states/transitions compile; fabricated and stale evidence are dropped as gaps", () => {
  const a = evRef(), b = evRef();
  const stale = evRef("STALE");
  const bundle = makeBundle({ evidence: [a, b, stale] });
  const plan: ChartPlanStateMachine = {
    contractVersion: "chart.v2", chartId: "S3", chartType: "BatchId lifecycle state machine", layout: "flow",
    caption: "lifecycle", nodes: [], edges: [],
    states: [
      { id: "pending", label: "pending", evidenceIds: [a.id], isInitial: true },
      { id: "reserved", label: "reserved", evidenceIds: [a.id] },
      { id: "ghost", label: "ghost", evidenceIds: ["ev:fabricated"] },
    ],
    transitions: [
      { from: "pending", to: "reserved", trigger: "reserve", guard: "balance ok", evidenceIds: [b.id] },
      { from: "reserved", to: "reserved", trigger: "reserve", evidenceIds: [b.id], isIdempotentReplay: true },
      { from: "pending", to: "ghost", trigger: "vanish", evidenceIds: [b.id] },
      { from: "reserved", to: "pending", trigger: "rewind", evidenceIds: [stale.id] },
    ],
  };
  const { view, claims, diagnostics } = compile(plan, bundle, "S3");
  assert.equal(diagnostics.chartId, "S3");
  assert.equal(diagnostics.contractVersion, "chart.v2");
  assert.equal(view.nodes.length, 2, "the state with fabricated evidence is omitted");
  assert.ok(view.nodes.every((n) => n.role === "state" && n.pos), "state role and explicit positions");
  const initial = view.nodes.find((n) => n.label === "pending")!;
  assert.equal(initial.badge, "start");
  const replay = view.edges.find((e) => e.label?.includes("replay"))!;
  assert.ok(replay, "the idempotent replay transition is drawn");
  assert.equal(replay.fromNodeId, replay.toNodeId, "replay is a self-transition");
  const guard = view.edges.find((e) => e.label?.includes("[balance ok]"))!;
  assert.ok(guard, "the guard is part of the transition label");
  assert.equal(view.edges.length, 2, "transition into the ghost state and the stale transition are omitted");
  assert.ok(view.gaps.some((g) => g.includes("fabricated") || g.includes("ghost")));
  assert.ok(view.gaps.some((g) => g.includes("stale") || g.includes("rewind")));
  assert.equal(diagnostics.acceptedEdges, 2);
  assert.equal(diagnostics.omittedEdges, 2);
  assert.ok(view.caption.startsWith("BatchId lifecycle state machine"), "the title names the selected chart type");
  assert.ok(view.legend.some((l) => l.label === "Chart: BatchId lifecycle state machine"));
  assert.equal(claims.length, 0, "statically evidenced transitions stay facts, not claims");
});

test("S3 state machine: a forbidden transition is drawn as a negative fact with its own kind", () => {
  const a = evRef(), b = evRef();
  const bundle = makeBundle({ evidence: [a, b] });
  const plan: ChartPlanStateMachine = {
    contractVersion: "chart.v2", chartId: "S3", chartType: "state machine", layout: "flow", caption: "", nodes: [], edges: [],
    states: [
      { id: "posted", label: "posted", evidenceIds: [a.id] },
      { id: "rolledBack", label: "rolled-back", evidenceIds: [a.id] },
    ],
    transitions: [{ from: "posted", to: "rolledBack", trigger: "rollback", evidenceIds: [b.id], isForbidden: true }],
  };
  const { view, diagnostics } = compile(plan, bundle, "S3");
  const edge = view.edges[0];
  assert.equal(edge.kind, "forbidden-transition");
  assert.equal(edge.displayMode, "FACT");
  assert.ok(edge.label!.includes("forbidden"));
  assert.equal(diagnostics.acceptedEdges, 1);
});

test("S9 ER diagram: declared relations stay facts, inferred ones become gated dashed claims, unsupported ones are dropped", () => {
  const ddl = evRef(), writer = evRef("CURRENT", "TEST");
  const bundle = makeBundle({ evidence: [ddl, writer] });
  const plan: ChartPlanErDiagram = {
    contractVersion: "chart.v2", chartId: "S9", chartType: "Entity-relationship diagram", layout: "network", caption: "", nodes: [], edges: [],
    tables: [
      { id: "accounts", name: "accounts", columns: [{ name: "id", isPrimaryKey: true, evidenceIds: [ddl.id] }], evidenceIds: [ddl.id] },
      { id: "ledger", name: "ledger_entries", columns: [
        { name: "id", isPrimaryKey: true, evidenceIds: [ddl.id] },
        { name: "account_id", isForeignKey: true, references: "accounts.id", evidenceIds: [ddl.id] },
        { name: "amount", isNullable: false, evidenceIds: [ddl.id] },
      ], evidenceIds: [ddl.id] },
      { id: "phantom", name: "phantom", columns: [], evidenceIds: ["ev:nope"] },
    ],
    relationships: [
      { fromTable: "ledger", toTable: "accounts", cardinality: "N:M", fkColumn: "account_id", isInferred: true, reason: "both tables reference the same account code paths", evidenceIds: [writer.id] },
      { fromTable: "ledger", toTable: "accounts", cardinality: "1:N", fkColumn: "account_id", isInferred: false, evidenceIds: [ddl.id] },
      { fromTable: "accounts", toTable: "ledger", cardinality: "1:1", isInferred: true, evidenceIds: [ddl.id] },
    ],
  };
  const { view, claims, diagnostics } = compile(plan, bundle, "S9");
  assert.equal(view.nodes.length, 2, "the phantom table is omitted");
  const ledger = view.nodes.find((n) => n.label === "ledger_entries")!;
  assert.ok(ledger.notes!.some((n) => n.includes("PK id")));
  assert.ok(ledger.notes!.some((n) => n.includes("FK account_id") && n.includes("accounts.id")));
  const declared = view.edges.find((e) => e.label === "1:N · fk:account_id")!;
  assert.ok(declared && declared.displayMode === "FACT" && !declared.claimId, "a schema-evidenced relation is a fact with no claim");
  const inferred = view.edges.find((e) => e.label?.includes("inferred"))!;
  assert.ok(inferred, "the inferred relation is drawn");
  assert.equal(inferred.displayMode, "INFERENCE");
  assert.ok(inferred.claimId, "an inferred relation carries its claim");
  assert.ok(claims.find((c) => c.draft.id === inferred.claimId)!.gates.length === 5, "the inference claim passed all five gates");
  assert.ok(view.gaps.some((g) => g.includes("no reason for the inference")), "an inferred relation without a reason is dropped");
  assert.equal(diagnostics.acceptedEdges, 2);
  assert.equal(diagnostics.omittedEdges, 1);
});

test("S7 BPMN: lanes become lane groups, message flows stay distinct, gateway conditions label the flows", () => {
  const a = evRef(), b = evRef(), lane = evRef();
  const bundle = makeBundle({ evidence: [a, b, lane] });
  const plan: ChartPlanBpmn = {
    contractVersion: "chart.v2", chartId: "S7", chartType: "BPMN process diagram", layout: "flow", caption: "", nodes: [], edges: [],
    elements: [
      { id: "s", kind: "startEvent" as const, label: "reserve requested", laneId: "payments", evidenceIds: [a.id] },
      { id: "g", kind: "xorGateway" as const, label: "balance?", laneId: "payments", evidenceIds: [a.id] },
      { id: "ok", kind: "endEvent" as const, label: "reserved", laneId: "payments", evidenceIds: [a.id] },
      { id: "fail", kind: "endEvent" as const, label: "insufficient funds", laneId: "ledger", evidenceIds: [a.id] },
      { id: "comp", kind: "compensation" as const, label: "cancelFast", laneId: "ledger", evidenceIds: [b.id] },
    ],
    flows: [
      { from: "s", to: "g", kind: "sequence" as const, evidenceIds: [b.id] },
      { from: "g", to: "ok", kind: "sequence" as const, condition: "sufficient", evidenceIds: [b.id] },
      { from: "g", to: "fail", kind: "sequence" as const, condition: "insufficient", evidenceIds: [b.id] },
      { from: "fail", to: "comp", kind: "message" as const, evidenceIds: [b.id] },
    ],
    lanes: [
      { id: "payments", label: "payments", evidenceIds: [lane.id] },
      { id: "ledger", label: "ledger", evidenceIds: [] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S7");
  assert.equal(view.groups.filter((g) => g.kind === "lane").length, 2, "both lanes are drawn");
  assert.ok(view.nodes.find((n) => n.role === "start-event"));
  assert.ok(view.nodes.find((n) => n.role === "gateway-xor"));
  assert.ok(view.nodes.find((n) => n.role === "compensation-task"));
  const cond = view.edges.find((e) => e.label === "insufficient")!;
  assert.ok(cond && cond.kind === "sequence-flow");
  const msg = view.edges.find((e) => e.kind === "message-flow")!;
  assert.ok(msg, "the message flow is a distinct kind");
  assert.equal(diagnostics.acceptedNodes, 5);
});

test("S8 event storming: bands become ordered lane groups and async flows are labeled", () => {
  const cmd = evRef(), rel = evRef();
  const bundle = makeBundle({ evidence: [cmd, rel] });
  const plan: ChartPlanEventStorming = {
    contractVersion: "chart.v2", chartId: "S8", chartType: "Event storming", layout: "lanes", caption: "", nodes: [], edges: [],
    elements: [
      { id: "c1", kind: "command" as const, label: "Reserve", band: "commands" as const, orderHint: 0, evidenceIds: [cmd.id] },
      { id: "e1", kind: "domainEvent" as const, label: "FundsReserved", band: "events" as const, orderHint: 0, evidenceIds: [rel.id] },
      { id: "rm1", kind: "readModel" as const, label: "BalanceView", band: "readModels" as const, orderHint: 0, evidenceIds: [rel.id] },
    ],
    flows: [
      { from: "c1", to: "e1", kind: "produces" as const, isAsync: true, evidenceIds: [rel.id] },
      { from: "e1", to: "rm1", kind: "consumes" as const, isAsync: true, evidenceIds: [rel.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S8");
  const bands = view.groups.filter((g) => g.kind === "lane");
  assert.deepEqual(bands.map((g) => g.label), ["commands", "events", "readModels"]);
  const produces = view.edges.find((e) => e.label === "produces · async")!;
  assert.ok(produces, "the async produce flow is labeled");
  assert.ok(view.nodes.find((n) => n.role === "command"));
  assert.ok(view.nodes.find((n) => n.role === "read-model"));
});

test("S10 DFD: distinct element roles and data-labeled flows", () => {
  const rw = evRef();
  const bundle = makeBundle({ evidence: [rw] });
  const plan: ChartPlanDfd = {
    contractVersion: "chart.v2", chartId: "S10", chartType: "Data flow diagram", layout: "flow", caption: "", nodes: [], edges: [],
    elements: [
      { id: "caller", kind: "externalEntity" as const, label: "API caller", evidenceIds: [rw.id] },
      { id: "reserve", kind: "process" as const, label: "reserve", level: 1, evidenceIds: [rw.id] },
      { id: "redis", kind: "dataStore" as const, label: "redis: balance", evidenceIds: [rw.id] },
    ],
    flows: [{ from: "reserve", to: "redis", label: "balance", kind: "persisted" as const, evidenceIds: [rw.id] }],
  };
  const { view } = compile(plan, bundle, "S10");
  assert.ok(view.nodes.find((n) => n.role === "external-entity"));
  assert.ok(view.nodes.find((n) => n.role === "process")!.badge === "L1");
  assert.ok(view.nodes.find((n) => n.role === "data-store"));
  const flow = view.edges[0];
  assert.equal(flow.label, "balance", "the flow names the data, not the function");
  assert.equal(flow.kind, "persisted-flow");
});



test("S12 saga: compensation edges return, irreversible steps flagged, missing compensation is a gap", () => {
  const fwd = evRef(), comp = evRef();
  const bundle = makeBundle({ evidence: [fwd, comp] });
  const plan: ChartPlanSaga = {
    contractVersion: "chart.v2", chartId: "S12", chartType: "Saga / compensation graph", layout: "flow", caption: "", nodes: [],
    steps: [
      { id: "reserve", label: "reserve", kind: "forward", evidenceIds: [fwd.id] },
      { id: "post", label: "post", kind: "forward", isIrreversible: true, evidenceIds: [fwd.id] },
      { id: "cancel", label: "cancelFast", kind: "compensation", evidenceIds: [comp.id] },
    ],
    edges: [
      { from: "reserve", to: "post", kind: "happyPath", evidenceIds: [fwd.id] },
      { from: "post", to: "cancel", kind: "compensation", triggerCondition: "db sync failed", evidenceIds: [comp.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S12");
  assert.ok(view.nodes.find((n) => n.label === "post")!.badge === "irreversible");
  const ret = view.edges.find((e) => e.kind === "compensation")!;
  assert.equal(ret.style, "return");
  assert.ok(ret.label === "db sync failed");
  assert.ok(view.gaps.some((g) => g.includes("no evidenced compensation") && g.includes("reserve")), "a forward step without compensation is a labeled gap");
});

test("S13 outbox: writer, store, poller and consumer are distinct roles; atomic writes say so", () => {
  const tx = evRef(), poll = evRef();
  const bundle = makeBundle({ evidence: [tx, poll] });
  const plan: ChartPlanOutbox = {
    contractVersion: "chart.v2", chartId: "S13", chartType: "Outbox pattern topology", layout: "flow", caption: "", nodes: [], edges: [],
    elements: [
      { id: "w", kind: "writer", label: "bookkeeping", evidenceIds: [tx.id] },
      { id: "o", kind: "outboxStore", label: "outbox", evidenceIds: [tx.id] },
      { id: "p", kind: "poller", label: "poller", evidenceIds: [poll.id] },
      { id: "c", kind: "consumer", label: "provider client", evidenceIds: [poll.id] },
    ],
    flows: [
      { from: "w", to: "o", kind: "transactionalWrite", isAtomic: true, evidenceIds: [tx.id] },
      { from: "p", to: "o", kind: "poll", evidenceIds: [poll.id] },
      { from: "p", to: "c", kind: "deliver", evidenceIds: [poll.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S13");
  for (const role of ["writer", "outbox-store", "poller", "consumer"]) assert.ok(view.nodes.find((n) => n.role === role), role);
  const atomic = view.edges.find((e) => e.label === "transactionalWrite · atomic")!;
  assert.ok(atomic, "the atomic write is labeled as such, backed by evidence");
});



test("S15 DI wiring: injection kinds label edges, unresolved bindings stay fog, cycles annotate components", () => {
  const ctor = evRef(), unresolved = evRef(), cycle = evRef();
  const bundle = makeBundle({ evidence: [ctor, unresolved, cycle] });
  const plan: ChartPlanDiWiring = {
    contractVersion: "chart.v2", chartId: "S15", chartType: "DI wiring diagram", layout: "flow", caption: "", nodes: [], edges: [],
    components: [
      { id: "iface", label: "LedgerWriter", kind: "interface", evidenceIds: [ctor.id] },
      { id: "impl", label: "LedgerWriterImpl", kind: "class", evidenceIds: [ctor.id] },
      { id: "svc", label: "ReserveService", kind: "class", evidenceIds: [ctor.id] },
    ],
    bindings: [
      { from: "impl", to: "iface", injectionKind: "factory", evidenceIds: [ctor.id] },
      { from: "iface", to: "svc", injectionKind: "constructor", qualifier: "ledger", scope: "singleton", evidenceIds: [ctor.id] },
      { from: "svc", to: "impl", injectionKind: "unknown", isUnresolved: true, evidenceIds: [unresolved.id] },
    ],
    cycles: [{ componentIds: ["svc", "impl", "svc"], evidenceIds: [cycle.id] }],
  };
  const { view } = compile(plan, bundle, "S15");
  const ctorEdge = view.edges.find((e) => e.label?.includes("constructor injection @ledger") && e.label.includes("singleton"))!;
  assert.ok(ctorEdge && ctorEdge.displayMode === "FACT");
  const unresolvedEdge = view.edges.find((e) => e.kind === "unresolved-binding")!;
  assert.ok(unresolvedEdge && unresolvedEdge.displayMode === "FOG" && unresolvedEdge.label!.startsWith("unresolved"));
  const svc = view.nodes.find((n) => n.label === "ReserveService")!;
  assert.ok(svc.notes!.some((n) => n.includes("injection cycle")));
  assert.ok(view.nodes.find((n) => n.role === "interface"));
});

test("diagnostics carry provider, model, cache hit and fallback reason; count gaps instead of source contents", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanStateMachine = {
    contractVersion: "chart.v2", chartId: "S3", chartType: "state machine", layout: "flow", caption: "", nodes: [], edges: [],
    states: [{ id: "s", label: "posted", evidenceIds: [a.id] }],
    transitions: [],
  };
  const diag: ChartCompileDiag = { provider: "stub", model: "deterministic-graph-v1", cacheHit: true, schemaValidationPassed: true, fallbackReason: undefined };
  const { diagnostics } = compile(plan, bundle, "S3", diag);
  assert.equal(diagnostics.provider, "stub");
  assert.equal(diagnostics.model, "deterministic-graph-v1");
  assert.equal(diagnostics.cacheHit, true);
  assert.equal(diagnostics.schemaValidationPassed, true);
  assert.equal(diagnostics.acceptedNodes, 1);
  assert.equal(diagnostics.omittedNodes, 0);
  const parsed = JSON.stringify(diagnostics);
  assert.ok(!parsed.includes("posted"), "diagnostics carry counts, not chart labels or source");
});

test("a plan whose model chartType disagrees with the selection is normalized and the warning is visible", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanStateMachine = {
    contractVersion: "chart.v2", chartId: "S3", chartType: "call-flow", layout: "flow", caption: "lifecycle", nodes: [], edges: [],
    states: [{ id: "s", label: "posted", evidenceIds: [a.id] }],
    transitions: [],
  };
  const { view } = compile(plan, bundle, "S3");
  assert.ok(view.caption.startsWith("BatchId lifecycle state machine"), "the title names the requested chart");
  assert.ok(view.gaps.some((g) => g.includes("call-flow") && g.includes("BatchId lifecycle state machine")));
});

// ── cache isolation (spec §3.1 and §5.1) ─────────────────────────────────────────────
test("chart plan cache: different chart ids never share a key, and a stored v2 plan survives the store round-trip", () => {
  const bundle = makeBundle();
  assert.notEqual(chartPlanCacheKey(bundle, "q", "S3"), chartPlanCacheKey(bundle, "q", "S9"), "different chart ids hash differently");
  assert.equal(chartPlanCacheKey(bundle, "q", "S3"), chartPlanCacheKey(bundle, "q", "S3"), "same id is stable");
  assert.notEqual(chartPlanCacheKey(bundle, "q"), chartPlanCacheKey(bundle, "q", "generic"), "v1 and v2 contracts differ");

  const s3: ChartPlanStateMachine = {
    contractVersion: "chart.v2", chartId: "S3", chartType: "state machine", layout: "flow", caption: "", nodes: [], edges: [],
    states: [{ id: "s", label: "pending", evidenceIds: ["ev:1"] }],
    transitions: [{ from: "s", to: "s", trigger: "reserve", evidenceIds: ["ev:1"] }],
  };
  rememberChartPlan(bundle, "q", s3);
  assert.deepEqual(cachedChartPlan(bundle, "q", "S3"), s3, "the S3 plan is returned for S3");
  assert.equal(cachedChartPlan(bundle, "q", "S9"), null, "the S3 plan is never served for S9");
  assert.equal(cachedChartPlan(bundle, "q"), null, "the S3 plan is never served for a v1 request");

  const store = new Store(":memory:");
  store.saveGeneratedChartPlan("k", "bundle", "q", s3);
  const round = store.generatedChartPlan("k", "bundle", "q");
  assert.ok(round && (round as { chartId?: string }).chartId === "S3", "a chart.v2 plan persists and keeps its chartId");
  assert.equal(store.generatedChartPlan("k", "bundle", "other"), null);
  store.db.prepare("update generated_chart_plans set plan_json = ? where cache_key = ?").run("{\"contractVersion\":\"chart.v2\",\"chartId\":\"S3\"}", "k");
  assert.equal(store.generatedChartPlan("k", "bundle", "q"), null, "malformed saved plans are rejected");
  store.db.close();
});

// ── offline stub honesty (spec §3.4 and §5.1) ────────────────────────────────────────
const ALL_CHART_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17", "S18", "S19", "S20", "S21", "S22", "S23", "S24", "S25", "S26", "S27", "S28", "generic"] as const;
const OFFLINE_DERIVED_IDS = ["S1", "S2", "S5", "S6", "generic", "S10", "S8", "S21"];

test("the offline stub answers every chart id with a schema-valid chart.v2 plan and never with call-flow", async () => {
  const stub = new StubProvider();
  const bundle = makeBundle();
  for (const chartId of ALL_CHART_IDS) {
    const raw = await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId });
    const parsed = ChartOutputV2.safeParse(raw);
    assert.ok(parsed.success, `${chartId}: stub output must validate against chart.v2 (${parsed.success ? "" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")})`);
    assert.equal(parsed.data.chartId, chartId, `${chartId}: the selected chart id is preserved`);
    assert.notEqual(parsed.data.chartType, "call-flow", `${chartId}: the offline result is not relabeled call-flow`);
    if (!OFFLINE_DERIVED_IDS.includes(chartId)) {
      assert.ok(parsed.data.caption.includes("offline model cannot derive"), `${chartId}: an unsupported type says so in its caption`);
    }
  }
});

test("the offline stub keeps chart.v1 call-flow behaviour when no chart type was selected", async () => {
  const stub = new StubProvider();
  const raw = await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART, question: "q", bundle: makeBundle() });
  const parsed = ChartOutput.parse(raw);
  assert.equal(parsed.chartType, "call-flow", "without a selected chart id the stub keeps its deterministic call-flow plan");
});

test("the offline stub derives an S10 DFD from read/write facts and an S8 board from async hand-offs, each citing evidence", async () => {
  const stub = new StubProvider();
  const a = evRef(), b = evRef();
  const entities = [
    { entityId: "f:reserve", kind: "function", name: "reserve", file: "src/r.ts", spans: [] },
    { entityId: "f:capture", kind: "function", name: "handleCapture", file: "src/c.ts", spans: [] },
  ];
  const bundle = makeBundle({
    evidence: [a, b],
    entities,
    facts: [
      { id: "f1", subject: "f:reserve", predicate: "writes", object: { kind: "field", value: "redis:balance" }, evidence: [a], resolution: "RESOLVED" },
      { id: "f2", subject: "f:reserve", predicate: "reads", object: { kind: "field", value: "redis:balance" }, evidence: [a], resolution: "RESOLVED" },
      { id: "f3", subject: "f:capture", predicate: "imports_external", object: { kind: "module", value: "@acme/provider" }, evidence: [b], resolution: "PARSED" },
    ],
    relationships: [
      { id: "r1", from: "f:reserve", to: "f:capture", kind: "async-flow", label: "payment.capture.requested", evidence: [b], resolution: "RESOLVED" },
    ],
  });
  const dfd = ChartOutputV2.parse(await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: "S10" }));
  if (dfd.chartId !== "S10") throw new Error("expected S10");
  assert.ok(dfd.elements.some((e) => e.kind === "process" && e.label === "reserve"));
  assert.ok(dfd.elements.some((e) => e.kind === "dataStore" && e.label === "redis:balance"));
  assert.ok(dfd.elements.some((e) => e.kind === "externalEntity" && e.label === "@acme/provider".split("/")[0]));
  const flow = dfd.flows[0];
  assert.ok(flow && flow.kind === "persisted" && flow.label === "redis:balance" && flow.evidenceIds.includes(a.id));
  const board = ChartOutputV2.parse(await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: "S8" }));
  if (board.chartId !== "S8") throw new Error("expected S8");
  const event = board.elements[0];
  assert.ok(event && event.kind === "domainEvent" && event.label === "payment.capture.requested" && event.evidenceIds.includes(b.id));
});

test("the offline S16 stub derives classes, members, heritage and associations from the bundle", async () => {
  const stub = new StubProvider();
  const declaration = evRef();
  const entities = [
    { entityId: "class:src/outbox.ts#OutboxService", kind: "class", name: "OutboxService", file: "src/outbox.ts", spans: [] },
    { entityId: "class:src/outbox.ts#BaseOutbox", kind: "class", name: "BaseOutbox", file: "src/outbox.ts", spans: [] },
    { entityId: "class:src/outbox.ts#OutboxEntry", kind: "class", name: "OutboxEntry", file: "src/outbox.ts", spans: [] },
    { entityId: "field:src/outbox.ts#BaseOutbox.entries", kind: "field", name: "BaseOutbox.entries", file: "src/outbox.ts", spans: [] },
    { entityId: "method:src/outbox.ts#OutboxService.markFailed", kind: "method", name: "OutboxService.markFailed", file: "src/outbox.ts", spans: [] },
  ];
  const bundle = makeBundle({
    evidence: [declaration], entities,
    relationships: [
      { id: "extends", from: entities[0]!.entityId, to: entities[1]!.entityId, kind: "extends", evidence: [declaration], resolution: "RESOLVED" },
      { id: "association", from: entities[1]!.entityId, to: entities[2]!.entityId, kind: "association", label: "0..*", evidence: [declaration], resolution: "RESOLVED" },
    ],
    facts: [{ id: "signature", subject: entities[4]!.entityId, predicate: "signature", object: { kind: "ScalarValue", value: "markFailed(entry: OutboxEntry): void" }, evidence: [declaration], resolution: "PARSED" }],
  });
  const plan = ChartOutputV2.parse(await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: "S16" }));
  if (plan.chartId !== "S16") throw new Error("expected S16");
  assert.ok(plan.classes.some((c) => c.name === "OutboxService"));
  assert.equal(plan.classes.find((c) => c.name === "BaseOutbox")?.attributes[0]?.text, "- entries");
  assert.ok(plan.classes.find((c) => c.name === "OutboxService")?.operations.some((o) => o.text.includes("markFailed(entry: OutboxEntry): void")));
  assert.ok(plan.relations.some((r) => r.kind === "inheritance"));
  assert.equal(plan.relations.find((r) => r.kind === "association")?.label, "0..*");
  const empty = ChartOutputV2.parse(await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle: makeBundle(), chartId: "S16" }));
  if (empty.chartId !== "S16") throw new Error("expected S16");
  assert.deepEqual(empty.classes, []);
});

test("the typed unsupported-offline result compiles to an honest empty view with the selected chart intact", async () => {
  const stub = new StubProvider();
  const bundle = makeBundle();
  const raw = await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: "S3" });
  const plan = ChartOutputV2.parse(raw);
  const { view, diagnostics } = compile(plan, bundle, "S3");
  assert.equal(view.nodes.length, 0);
  assert.equal(view.edges.length, 0);
  assert.ok(view.caption.includes("BatchId lifecycle state machine"));
  assert.ok(view.gaps.length > 0, "the empty chart says why");
  assert.equal(diagnostics.chartId, "S3");
});

// ── S16–S28: the remaining standard diagram types ────────────────────────────────────

test("S16 class diagram: kinds, members in notes, UML relation kinds; inferred without a reason is dropped", () => {
  const decl = evRef(), inferred = evRef();
  const bundle = makeBundle({ evidence: [decl, inferred] });
  const plan: ChartPlanClassDiagram = {
    contractVersion: "chart.v2", chartId: "S16", chartType: "UML class diagram", layout: "flow", caption: "", nodes: [], edges: [],
    classes: [
      { id: "engine", name: "BookkeepingEngine", kind: "interface", attributes: [], operations: [{ text: "reserve(req)", evidenceIds: [decl.id] }], evidenceIds: [decl.id] },
      { id: "impl", name: "BookkeepingEngineImpl", kind: "class", attributes: [{ text: "reserves: ReserveService", evidenceIds: [decl.id] }], operations: [], evidenceIds: [decl.id] },
      { id: "svc", name: "ReserveService", kind: "class", attributes: [], operations: [], evidenceIds: [decl.id] },
      { id: "ghost", name: "Ghost", kind: "class", attributes: [], operations: [], evidenceIds: ["ev:nope"] },
    ],
    relations: [
      { from: "impl", to: "engine", kind: "realization", isInferred: false, evidenceIds: [decl.id] },
      { from: "impl", to: "svc", kind: "association", label: "uses", isInferred: true, reason: "field type", evidenceIds: [inferred.id] },
      { from: "impl", to: "engine", kind: "aggregation", isInferred: true, evidenceIds: [decl.id] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S16");
  assert.equal(view.nodes.length, 3, "the class with fabricated evidence is omitted");
  assert.ok(view.nodes.find((n) => n.role === "interface" && n.label === "BookkeepingEngine"));
  const impl = view.nodes.find((n) => n.label === "BookkeepingEngineImpl")!;
  assert.ok(impl.notes!.some((n) => n.startsWith("- reserves")) , "attributes are listed as notes");
  const realization = view.edges.find((e) => e.kind === "realization")!;
  assert.ok(realization && realization.displayMode === "FACT");
  const assoc = view.edges.find((e) => e.kind === "association")!;
  assert.ok(assoc && assoc.label!.includes("inferred") && assoc.claimId, "the reasoned inference is drawn as a claim");
  assert.equal(diagnostics.acceptedEdges, 2);
  assert.ok(view.gaps.some((g) => g.includes("no reason for the inference")), "an inference without a reason is dropped");
});

test("S17 package diagram: members become notes and dependencies stay dashed evidence-backed edges", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanPackageDiagram = {
    contractVersion: "chart.v2", chartId: "S17", chartType: "UML package diagram", layout: "flow", caption: "", nodes: [], edges: [],
    packages: [
      { id: "api", name: "mls.bookkeeping.api", members: [{ text: "BookkeepingEngine", evidenceIds: [a.id] }], evidenceIds: [a.id] },
      { id: "infra", name: "mls.bookkeeping.infra", members: [], evidenceIds: [a.id] },
    ],
    dependencies: [
      { from: "api", to: "infra", evidenceIds: [a.id] },
      { from: "api", to: "ghost", evidenceIds: [a.id] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S17");
  assert.equal(view.nodes.length, 2);
  assert.ok(view.nodes.find((n) => n.role === "package" && n.notes!.includes("BookkeepingEngine")));
  assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].kind, "package-dependency");
  assert.equal(diagnostics.omittedEdges, 1);
});

test("S18 communication diagram: numbered messages, unique-order enforcement, kinds map to edge kinds", () => {
  const a = evRef(), b = evRef();
  const bundle = makeBundle({ evidence: [a, b] });
  const plan: ChartPlanCommunication = {
    contractVersion: "chart.v2", chartId: "S18", chartType: "UML communication diagram", layout: "network", caption: "", nodes: [], edges: [],
    participants: [
      { id: "caller", label: "Caller", evidenceIds: [a.id] },
      { id: "engine", label: "BookkeepingEngineImpl", evidenceIds: [a.id] },
      { id: "redis", label: "BalanceService", evidenceIds: [b.id] },
    ],
    messages: [
      { from: "caller", to: "engine", order: 1, label: "reserve", kind: "sync", evidenceIds: [a.id] },
      { from: "engine", to: "redis", order: 2, label: "tryReserveFast", kind: "sync", evidenceIds: [b.id] },
      { from: "redis", to: "engine", order: 2, label: "duplicate order", kind: "return", evidenceIds: [b.id] },
      { from: "engine", to: "ghost", order: 3, label: "vanish", kind: "async", evidenceIds: [b.id] },
      { from: "redis", to: "engine", order: 4, label: "balance ok", kind: "return", evidenceIds: [b.id] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S18");
  assert.equal(view.nodes.length, 3);
  assert.ok(view.nodes.every((n) => n.role === "participant" && n.pos));
  const first = view.edges.find((e) => e.label === "1: reserve")!;
  assert.ok(first && first.kind === "sync-message" && first.displayMode === "FACT");
  assert.ok(view.edges.find((e) => e.kind === "return-message"), "kinds are preserved as edge kinds");
  assert.equal(view.edges.length, 3, "the duplicate order and the ghost target are omitted");
  assert.ok(view.gaps.some((g) => g.includes("already used")));
  assert.equal(diagnostics.acceptedEdges, 3);
});

test("S19 interaction overview: frames, refs in notes, guards on flows", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanInteractionOverview = {
    contractVersion: "chart.v2", chartId: "S19", chartType: "UML interaction overview", layout: "flow", caption: "", nodes: [], edges: [],
    frames: [
      { id: "start", label: "start", kind: "initial", evidenceIds: [a.id] },
      { id: "reserveFrame", label: "reserve interaction", kind: "interaction", ref: "reserve sequence", evidenceIds: [a.id] },
      { id: "choose", label: "provider ok?", kind: "decision", evidenceIds: [a.id] },
      { id: "done", label: "done", kind: "final", evidenceIds: [a.id] },
    ],
    flows: [
      { from: "start", to: "reserveFrame", evidenceIds: [a.id] },
      { from: "reserveFrame", to: "choose", evidenceIds: [a.id] },
      { from: "choose", to: "done", guard: "provider OK", evidenceIds: [a.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S19");
  assert.equal(view.nodes.length, 4);
  assert.equal(view.nodes.find((n) => n.label === "start")!.badge, "start");
  const ref = view.nodes.find((n) => n.role === "interaction-ref")!;
  assert.ok(ref.notes!.some((n) => n.includes("reserve sequence")));
  const guarded = view.edges.find((e) => e.label === "provider OK")!;
  assert.ok(guarded, "the guard labels the flow");
});



test("S21 call graph: static call edges, unknown functions dropped, owner noted", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanCallGraph = {
    contractVersion: "chart.v2", chartId: "S21", chartType: "Call graph", layout: "flow", caption: "", nodes: [], edges: [],
    functions: [
      { id: "reserve", label: "reserve", kind: "method", parentId: "svc", evidenceIds: [a.id] },
      { id: "tryFast", label: "tryReserveFast", kind: "method", evidenceIds: [a.id] },
      { id: "svc", label: "ReserveService", kind: "function", evidenceIds: [a.id] },
    ],
    calls: [
      { from: "reserve", to: "tryFast", evidenceIds: [a.id] },
      { from: "reserve", to: "ghost", evidenceIds: [a.id] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S21");
  assert.equal(view.nodes.length, 3);
  const edge = view.edges.find((e) => e.kind === "call")!;
  assert.ok(edge && edge.displayMode === "FACT", "call edges are facts when statically evidenced");
  assert.ok(view.nodes.find((n) => n.role === "method" && n.notes!.some((x) => x.includes("Owner: ReserveService"))));
  assert.equal(diagnostics.acceptedEdges, 1);
  assert.ok(view.gaps.some((g) => g.includes("not part of the chart")));
});

test("S22 layered architecture: region groups per layer, ordered layout, async edges dashed", () => {
  const a = evRef(), b = evRef();
  const bundle = makeBundle({ evidence: [a, b] });
  const plan: ChartPlanLayeredArchitecture = {
    contractVersion: "chart.v2", chartId: "S22", chartType: "Layered architecture", layout: "lanes", caption: "", nodes: [],
    layers: [
      { id: "api", label: "API layer", order: 0, evidenceIds: [a.id] },
      { id: "infra", label: "Infrastructure layer", order: 1, evidenceIds: [a.id] },
      { id: "empty", label: "Ghost layer", order: 2, evidenceIds: [a.id] },
    ],
    components: [
      { id: "controller", label: "Bookkeeping API", layerId: "api", kind: "component", evidenceIds: [a.id] },
      { id: "redis", label: "Redis", layerId: "infra", kind: "store", evidenceIds: [b.id] },
      { id: "stray", label: "Stray", layerId: "nope", kind: "component", evidenceIds: [a.id] },
    ],
    edges: [{ from: "controller", to: "redis", kind: "async", evidenceIds: [a.id] }],
  };
  const { view, diagnostics } = compile(plan, bundle, "S22");
  assert.equal(view.nodes.length, 2, "the component with an unknown layer is omitted");
  const region = view.groups.find((g) => g.kind === "region" && g.label.includes("API layer"));
  assert.ok(region && region.childNodeIds.length === 1);
  const edge = view.edges[0];
  assert.equal(edge.kind, "async-flow");
  const api = view.nodes.find((n) => n.label === "Bookkeeping API")!;
  const redis = view.nodes.find((n) => n.label === "Redis")!;
  assert.ok(api.pos!.y < redis.pos!.y, "layers are ordered top to bottom");
  assert.equal(diagnostics.acceptedNodes, 2);
  assert.ok(view.gaps.some((g) => g.includes("Ghost layer")));
});

test("S23 module graph: dependency kinds label the edges and unknown modules are dropped", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanModuleGraph = {
    contractVersion: "chart.v2", chartId: "S23", chartType: "Dependency / module graph", layout: "flow", caption: "", nodes: [], edges: [],
    modules: [
      { id: "core", label: "packages/core", kind: "package", evidenceIds: [a.id] },
      { id: "schema", label: "packages/schema", kind: "package", evidenceIds: [a.id] },
    ],
    dependencies: [
      { from: "core", to: "schema", kind: "compileTime", evidenceIds: [a.id] },
      { from: "core", to: "phantom", kind: "test", evidenceIds: [a.id] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S23");
  assert.equal(view.nodes.length, 2);
  const dep = view.edges.find((e) => e.kind === "depends-on")!;
  assert.ok(dep && dep.label === "compileTime");
  assert.equal(diagnostics.omittedEdges, 1);
});







test("S27 C4 context: person/system/external roles, one-subject expectation, labelled relationships", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanC4Context = {
    contractVersion: "chart.v2", chartId: "S27", chartType: "C4 context diagram", layout: "flow", caption: "", nodes: [], edges: [],
    elements: [
      { id: "caller", label: "Caller", kind: "person", evidenceIds: [a.id] },
      { id: "book", label: "Bookkeeping", kind: "softwareSystem", evidenceIds: [a.id] },
      { id: "redis", label: "Redis", kind: "externalSystem", evidenceIds: [a.id] },
    ],
    relationships: [
      { from: "caller", to: "book", label: "reserve / post / rollback", evidenceIds: [a.id] },
      { from: "book", to: "redis", label: "fast balance", technology: "RESP", evidenceIds: [a.id] },
      { from: "book", to: "ghost", label: "vanish", evidenceIds: [a.id] },
    ],
  };
  const { view, diagnostics } = compile(plan, bundle, "S27");
  assert.ok(view.nodes.find((n) => n.role === "c4-person"));
  assert.ok(view.nodes.find((n) => n.role === "c4-system"));
  assert.ok(view.nodes.find((n) => n.role === "external-system"));
  const tech = view.edges.find((e) => e.kind === "context-relation" && e.label!.includes("RESP"))!;
  assert.ok(tech, "technology is part of the relationship label");
  assert.equal(diagnostics.omittedEdges, 1);
  assert.ok(!view.gaps.some((g) => g.includes("subject software system")), "exactly one subject, no warning");
});

test("S28 sequence diagram: lifelines, ordered message outline, fragments as regions, unique orders", () => {
  const a = evRef(), b = evRef();
  const bundle = makeBundle({ evidence: [a, b] });
  const plan: ChartPlanSequence = {
    contractVersion: "chart.v2", chartId: "S28", chartType: "UML sequence diagram", layout: "flow", caption: "", nodes: [], edges: [],
    participants: [
      { id: "t1", label: "Thread 1", evidenceIds: [a.id] },
      { id: "t2", label: "Thread 2", evidenceIds: [a.id] },
      { id: "redis", label: "Redis", evidenceIds: [b.id] },
    ],
    messages: [
      { from: "t1", to: "redis", order: 1, label: "tryReserveFast", kind: "sync", evidenceIds: [a.id] },
      { from: "t2", to: "redis", order: 2, label: "tryReserveFast", kind: "sync", fragmentId: "alt1", evidenceIds: [b.id] },
      { from: "redis", to: "t1", order: 2, label: "duplicate order", kind: "return", evidenceIds: [b.id] },
      { from: "redis", to: "t1", order: 3, label: "success", kind: "return", fragmentId: "nope", evidenceIds: [b.id] },
    ],
    fragments: [{ id: "alt1", kind: "alt", condition: "already reserved", evidenceIds: [b.id] }],
  };
  const { view, diagnostics } = compile(plan, bundle, "S28");
  assert.ok(view.nodes.find((n) => n.role === "lifeline" && n.label === "Redis"));
  const msgs = view.nodes.filter((n) => n.role === "message" || n.role === "async-message" || n.role === "return-message");
  assert.equal(msgs.length, 3, "the duplicate order is omitted");
  const numbers = msgs.map((m) => Number(m.label.split(".")[0])).sort((x, y) => x - y);
  assert.deepEqual(numbers, [1, 2, 3], "message nodes carry their order number");
  const first = view.nodes.find((n) => n.label === "1. tryReserveFast")!;
  const second = view.nodes.find((n) => n.label === "2. tryReserveFast")!;
  assert.ok(first.pos!.y < second.pos!.y, "messages are laid out in reading order");
  assert.ok(second.notes!.some((x) => x.includes("Fragment alt")), "fragment membership is in the notes");
  const region = view.groups.find((g) => g.label.startsWith("alt") && g.kind === "region");
  assert.ok(region && region.childNodeIds.length === 1);
  const order = view.edges.find((e) => e.kind === "reading-order")!;
  assert.ok(order && order.displayMode === "INFERENCE", "reading-order edges are layout, not claims");
  assert.equal(diagnostics.omittedEdges, 1, "the duplicate-order message is omitted");
  assert.ok(view.gaps.some((g) => g.includes("already used")));
  assert.ok(view.gaps.some((g) => g.includes("did not declare")), "the undeclared fragment reference is disclosed");
});

test("the offline stub derives an S21 call graph from resolved call relationships", async () => {
  const stub = new StubProvider();
  const a = evRef();
  const bundle = makeBundle({
    evidence: [a],
    entities: [
      { entityId: "f:reserve", kind: "method", name: "reserve", file: "src/r.ts", spans: [] },
      { entityId: "f:fast", kind: "method", name: "tryReserveFast", file: "src/b.ts", spans: [] },
    ],
    relationships: [
      { id: "r1", from: "f:reserve", to: "f:fast", kind: "calls", evidence: [a], resolution: "RESOLVED" },
    ],
  });
  const raw = await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: "S21" });
  const plan = ChartOutputV2.parse(raw);
  if (plan.chartId !== "S21") throw new Error("expected S21");
  assert.equal(plan.functions.length, 2);
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].from, "fn:0");
  assert.ok(plan.calls[0].evidenceIds.includes(a.id));
  const { view } = compile(plan, bundle, "S21");
  assert.equal(view.edges.filter((e) => e.kind === "call").length, 1);
  assert.ok(view.gaps.length === 0, "a fully evidenced call graph has no gaps");
});
