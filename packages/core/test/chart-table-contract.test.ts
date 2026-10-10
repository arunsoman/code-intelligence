// Native table contracts migrated from chart-rendering.test.ts. These assert the
// current semantic payload and citation boundaries, not the retired matrix shape.
import test from "node:test";
import assert from "node:assert/strict";
import type { ChartOutputV2, ChartPlanDecisionTable, ChartPlanIdempotencyMatrix, ChartPlanCrcCards, ChartPlanStateTransitionTable, ChartPlanFmeaMatrix, ChartPlanMetricsMap, EvidenceBundle, EvidenceRef, ViewRoute } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
import type { RevisionRow } from "../src/store.ts";
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

const compile = (plan: ChartOutputV2, bundle: EvidenceBundle, chartId?: string) =>
  compileChartPlan({ plan, bundle, rev, question: "show me", route, chartId });

test("S11 decision table: native rules retain cell citations and omit uncited rules", () => {
  const branch = evRef(), testEv = evRef("CURRENT", "TEST");
  const bundle = makeBundle({ evidence: [branch, testEv] });
  const plan: ChartPlanDecisionTable = {
    contractVersion: "chart.v2", chartId: "S11", chartType: "Decision table", layout: "flow", caption: "", nodes: [], edges: [],
    conditions: [
      { id: "exists", label: "state already exists", evidenceIds: [branch.id] },
      { id: "funds", label: "balance sufficient", evidenceIds: [branch.id] },
    ],
    rules: [
      { id: "replay", values: { exists: "true", funds: "any" }, outcome: "return existing reservation", outcomeEvidenceIds: [branch.id], evidenceIds: [branch.id], isCovered: true },
      { id: "success", values: { exists: "false", funds: "true" }, outcome: "reserve and persist", outcomeEvidenceIds: [testEv.id], evidenceIds: [testEv.id], isCovered: true },
      { id: "uncovered", values: { exists: "false", funds: "false" }, outcome: "throw", outcomeEvidenceIds: [], evidenceIds: [], isCovered: false },
    ],
  };
  const { view, claims } = compile(plan, bundle, "S11");
  assert.ok(view.table, "decision rules compile to the native typed table");
  const table = view.table!;
  assert.equal(table.rowTitle, "Rule");
  assert.equal(table.columns.length, 4, "two conditions, outcome and coverage interpretation");
  assert.equal(table.rows.length, 2, "uncited rules are omitted rather than borrowing condition citations");
  const replayOutcome = table.rows.find(r => r.id === "replay")!.cells.find(c => c.columnId === "outcome")!;
  assert.equal(replayOutcome.status, "interpreted");
  assert.ok(replayOutcome.text.includes("return existing reservation"));
  assert.deepEqual(replayOutcome.evidenceIds, [branch.id]);
  assert.ok(view.gaps.some(g => g.includes("Rule 3") && g.includes("current evidence")));
  const successOutcome = table.rows.find(r => r.id === "success")!.cells.find(c => c.columnId === "outcome")!;
  assert.equal(successOutcome.status, "interpreted", "test-only evidence remains an interpretation");
  assert.deepEqual(successOutcome.evidenceIds, [testEv.id]);
  assert.equal(claims.length, 0, "native static cells carry citations without invented fact claims");
  assert.ok(view.nodes.every(n => n.role === "table-row" && n.displayMode === "INFERENCE"));
});

test("S14 idempotency matrix: outcomes, mechanisms and unknowns in a matrix", () => {
  const key = evRef(), insertIgnore = evRef();
  const bundle = makeBundle({ evidence: [key, insertIgnore] });
  const plan: ChartPlanIdempotencyMatrix = {
    contractVersion: "chart.v2", chartId: "S14", chartType: "Idempotency matrix", layout: "flow", caption: "", nodes: [], edges: [],
    operations: [
      { id: "reserve", label: "reserve", evidenceIds: [key.id] },
      { id: "post", label: "post", evidenceIds: [insertIgnore.id] },
    ],
    scenarios: [
      { id: "dup", label: "same batchId replay" },
      { id: "concurrent", label: "concurrent duplicate" },
    ],
    cells: [
      { operationId: "reserve", scenarioId: "dup", outcome: "idempotent", mechanism: "state-exists check", keyScope: "batchId", evidenceIds: [key.id] },
      { operationId: "post", scenarioId: "dup", outcome: "noOp", mechanism: "INSERT IGNORE", evidenceIds: [insertIgnore.id] },
      { operationId: "reserve", scenarioId: "concurrent", outcome: "unknown", evidenceIds: [] },
    ],
  };
  const { view } = compile(plan, bundle, "S14");
  const table = view.table!;
  assert.equal(table.rowTitle, "Operation");
  assert.equal(table.columns.length, 2);
  const reserve = table.rows.find(r => r.id === "reserve")!;
  const idem = reserve.cells.find(c => c.columnId === "dup")!;
  assert.equal(idem.status, "interpreted");
  assert.ok(idem.text.includes("Idempotent?") && idem.text.includes("state-exists check") && idem.text.includes("batchId"));
  const unknown = reserve.cells.find(c => c.columnId === "concurrent")!;
  assert.equal(unknown.status, "unknown", "unknown behavior must not acquire a claim");
  assert.deepEqual(unknown.evidenceIds, []);
  assert.ok(table.rows.some(r => r.label === "reserve"));
});

test("S20 CRC cards: class rows preserve independently cited responsibilities and collaborators", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanCrcCards = {
    contractVersion: "chart.v2", chartId: "S20", chartType: "CRC cards", layout: "flow", caption: "", nodes: [], edges: [],
    cards: [
      { className: "ReserveService", responsibilities: [{ text: "orchestrate reserve flow", evidenceIds: [a.id] }], collaborators: [{ className: "BalanceService", evidenceIds: [a.id] }], evidenceIds: [a.id] },
      { className: "BalanceService", responsibilities: [], collaborators: [], evidenceIds: [a.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S20");
  const table = view.table!;
  assert.equal(table.rowTitle, "Class");
  assert.equal(table.rows.length, 2);
  assert.equal(table.columns.map(c => c.label).join(","), "Responsibilities,Collaborators");
  const reserve = table.rows.find(r => r.id === "ReserveService")!;
  assert.equal(reserve.cells[0].status, "interpreted");
  assert.ok(reserve.cells[0].text.includes("orchestrate reserve flow"));
  assert.deepEqual(reserve.cells[0].evidenceIds, [a.id]);
  assert.equal(reserve.cells[1].text, "BalanceService");
  const empty = table.rows.find(r => r.id === "BalanceService")!.cells[0];
  assert.equal(empty.status, "unknown", "empty is unknown, not proof of no responsibilities");
  assert.deepEqual(empty.evidenceIds, []);
  assert.ok(view.nodes.find(n => n.notes!.some(note => note.includes("BalanceService"))));
  assert.equal(view.edges.length, 0, "collaboration citations live in cells without synthetic graph edges");
});

test("S24 state transition table: forbidden interpretations retain valid targets and reject unknown references", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanStateTransitionTable = {
    contractVersion: "chart.v2", chartId: "S24", chartType: "State transition table", layout: "flow", caption: "", nodes: [], edges: [],
    states: [
      { id: "posted", label: "Posted", evidenceIds: [a.id] },
      { id: "rolledBack", label: "RolledBack", evidenceIds: [a.id] },
    ],
    events: [{ id: "rollback", label: "rollback", evidenceIds: [a.id] }],
    cells: [
      { stateId: "posted", eventId: "rollback", nextStateId: "rolledBack", isForbidden: true, evidenceIds: [a.id] },
      { stateId: "posted", eventId: "ghost", nextStateId: "posted", evidenceIds: [a.id] },
      { stateId: "posted", eventId: "rollback", nextStateId: "nowhere", evidenceIds: [a.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S24");
  const table = view.table!;
  assert.equal(table.rowTitle, "State");
  assert.equal(table.columns.length, 1, "only evidenced event declarations become columns");
  const forbidden = table.rows.find(r => r.id === "posted")!.cells[0];
  assert.equal(forbidden.status, "interpreted");
  assert.match(forbidden.text, /^FORBIDDEN\? · RolledBack/);
  assert.deepEqual(forbidden.evidenceIds, [a.id]);
  assert.ok(view.gaps.some(g => g.includes("missing state or event")));
  assert.ok(view.gaps.some(g => g.includes("unknown target")));
  assert.equal(table.rows.find(r => r.id === "rolledBack")!.cells[0].status, "unknown");
  assert.ok(table.rows.some(r => r.label === "Posted"));
});

test("S25 FMEA matrix: impact and compensation cells, missing compensation becomes a gap", () => {
  const a = evRef(), b = evRef();
  const bundle = makeBundle({ evidence: [a, b] });
  const plan: ChartPlanFmeaMatrix = {
    contractVersion: "chart.v2", chartId: "S25", chartType: "FMEA / compensation matrix", layout: "flow", caption: "", nodes: [], edges: [],
    failures: [
      { id: "dbsync", label: "DB sync fails", impact: { text: "inconsistent state", evidenceIds: [a.id] }, compensation: { text: "cancelFast", evidenceIds: [b.id] }, evidenceIds: [a.id] },
      { id: "stuck", label: "Provider call fails", impact: { text: "reservation stuck", evidenceIds: [a.id] }, evidenceIds: [a.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S25");
  const table = view.table!;
  assert.equal(table.rowTitle, "Failure");
  assert.equal(table.rows.length, 2);
  const comp = table.rows.find(r => r.id === "dbsync")!.cells.find(c => c.columnId === "compensation")!;
  assert.equal(comp.status, "interpreted");
  assert.ok(comp.text.includes("cancelFast"));
  assert.deepEqual(comp.evidenceIds, [b.id]);
  const missing = table.rows.find(r => r.id === "stuck")!.cells.find(c => c.columnId === "compensation")!;
  assert.equal(missing.status, "unknown");
  assert.deepEqual(missing.evidenceIds, []);
  assert.ok(view.gaps.some(g => g.includes("no current evidence-backed compensation")));
});

test("S26 metrics map: declared names with meaning and emitters; no live values", () => {
  const a = evRef();
  const bundle = makeBundle({ evidence: [a] });
  const plan: ChartPlanMetricsMap = {
    contractVersion: "chart.v2", chartId: "S26", chartType: "Metrics / telemetry map", layout: "flow", caption: "", nodes: [], edges: [],
    metrics: [
      { id: "fastOk", name: "reservation.fast.success", meaning: "successful Redis reserve", emitters: [{ label: "BalanceService.tryReserveFast", evidenceIds: [a.id] }], evidenceIds: [a.id] },
      { id: "ignored", name: "ledger.insert.ignored", emitters: [], evidenceIds: [a.id] },
    ],
  };
  const { view } = compile(plan, bundle, "S26");
  const table = view.table!;
  assert.equal(table.rowTitle, "Metric");
  assert.equal(table.rows.length, 2);
  const meaning = table.rows.find(r => r.id === "fastOk")!.cells.find(c => c.columnId === "meaning")!;
  assert.equal(meaning.status, "interpreted");
  assert.ok(meaning.text.includes("successful Redis reserve"));
  const noEmitter = table.rows.find(r => r.id === "ignored")!.cells.find(c => c.columnId === "emitters")!;
  assert.equal(noEmitter.status, "unknown");
  assert.deepEqual(noEmitter.evidenceIds, []);
  assert.ok(view.nodes.every(n => n.notes!.some(note => note.includes("no live values"))));
  assert.equal(view.edges.length, 0);
});
