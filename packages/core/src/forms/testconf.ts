// V12 Test-Confidence Map: which behaviours are protected by which tests, and how strongly. Coverage is line and
// branch coverage from the project's own report; flakiness history and mutation resistance are not
// available and are listed as gaps.
import type { Claim, MatrixAxis, MatrixCell, ViewNode } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { entryPoints } from "./analysis.ts";
import { baseView, claimOf, containsEvidence, emptyForm, flowGraph, observation, reach, short } from "./common.ts";
import { testFactsFor } from "../testartifacts.ts";

const PROPERTIES: { key: string; test: RegExp; guard: RegExp; label: string }[] = [
  { key: "idempotency", test: /idempot|duplicate|twice|replay/i, guard: /idempot|claim.?key|duplicate/i, label: "idempotency" },
  { key: "retries", test: /retr(y|ies)|timeout|backoff/i, guard: /retr|timeout|backoff/i, label: "retry and timeout handling" },
  { key: "authorization", test: /auth|permission|forbidden|unauthori/i, guard: /auth|permission|guard/i, label: "authorization" },
  { key: "fraud limits", test: /fraud|limit|large amount/i, guard: /fraud|limit/i, label: "fraud limits" },
];

export function buildTestConfidence(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "TestConfidence" as const, question, kind: "testconf", caption: "", reason: "You asked how well behaviour is protected, so each operation is shown with the tests that reach it and how well its code is covered." };
  const flow = flowGraph(store, rev.id);
  let ops = entryPoints(flow).filter((e) => e.kind === "entry").map((e) => e.id);
  if (subject) ops = ops.filter((id) => short(id).toLowerCase().includes(subject.toLowerCase()));
  if (ops.length === 0) return emptyForm(o, "I found no operation to assess.");
  const tests = store.entities(rev.id).filter((e) => e.kind === "test");
  const calls = new Map<string, string[]>();
  for (const r of store.relationshipsAmong(rev.id, "calls")) calls.set(r.from, [...(calls.get(r.from) ?? []), r.to]);
  const testReach = new Map<string, Set<string>>();
  for (const t of tests) { const seen = new Set<string>(); let f = [t.entityId]; for (let h = 0; h < 4; h++) { const n: string[] = []; for (const id of f) for (const to of calls.get(id) ?? []) if (!seen.has(to)) { seen.add(to); n.push(to); } f = n; } testReach.set(t.entityId, seen); }
  const resultOf = (tid: string) => (store.factsFor(rev.id, tid).find((f) => f.predicate === "test_result")?.object as unknown as { value?: { status?: string } } | undefined)?.value?.status ?? "unknown";
  const hasCov = store.factsByPredicate(rev.id, "coverage").length > 0;

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const shownTests = new Map<string, string>();
  const rank = ops.map((id) => ({ id, reach: reach([id], flow.out, (r) => r.to, 8, 80) })).sort((a, b) => b.reach.size - a.reach.size).slice(0, 5);
  let row = 0;
  // The same assessment as a grid: behaviours down the side; the tests that reach them and the properties a test should assert across the top.
  const mRows: MatrixAxis[] = [], mCells: MatrixCell[] = [];
  const mTests = new Map<string, MatrixAxis>(), mProps = new Map<string, MatrixAxis>();
  const opFns = new Map<string, string[]>();
  for (const { id: op, reach: info } of rank) {
    const fns = [...info.keys()].filter((id) => flow.entities.get(id)!.kind !== "file");
    const prot = (id: string) => tests.filter((t) => testReach.get(t.entityId)!.has(id) || t.entityId === id);
    const conf = (id: string) => { const c = testFactsFor(store, rev.id, id).coverage; const n = prot(id).length; return c ? (n ? c.percent / 100 : Math.min(c.percent / 100, 0.3)) : n ? 0.6 : 0; };
    const overall = fns.reduce((s, id) => s + conf(id), 0) / Math.max(1, fns.length);
    const protectingTests = tests.filter((t) => fns.some((f) => testReach.get(t.entityId)!.has(f)));
    const failing = protectingTests.filter((t) => resultOf(t.entityId) === "failed");
    const bid = `n:beh:${op}`, e = flow.entities.get(op)!;
    const y0 = row * 150;
    opFns.set(op, fns);
    mRows.push({ id: `row:${op}`, label: e.name, sub: `${protectingTests.length} test(s) reach it · ${Math.round(overall * 100)}% confidence`, role: "behavior", entityRefs: [op], evidenceIds: containsEvidence(store, rev.id, op), heat: { value: 1 - overall, label: `${Math.round(overall * 100)}% confidence${failing.length ? `; ${failing.length} reaching test(s) failing` : ""}` } });
    v.nodes.push({ id: bid, entityRefs: [op], label: e.name, kind: "behavior", file: e.file, claimIds: [], evidenceIds: containsEvidence(store, rev.id, op), tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: "behavior", pos: { x: 0, y: y0 }, heat: { value: 1 - overall, label: `${Math.round(overall * 100)}% confidence` }, badge: `${protectingTests.length} test(s)`, notes: [`${fns.length} function(s) on this behaviour; ${protectingTests.length} test(s) reach it${failing.length ? `, ${failing.length} failing` : ""}.`] });
    // The weakest links first: unprotected or poorly covered code.
    fns.sort((a, b) => conf(a) - conf(b) || a.localeCompare(b)).slice(0, 7).forEach((id, i) => {
      if (id === op) return;
      const fe = flow.entities.get(id)!, cov = testFactsFor(store, rev.id, id).coverage, ts = prot(id);
      const branchVal = (cov as { branches?: { percent: number; covered: number; total: number } } | null)?.branches;
      const branchText = branchVal ? `, ${branchVal.covered}/${branchVal.total} branch arms` : "";
      v.nodes.push({ id: `n:${op}:${id}`, entityRefs: [id], label: fe.name, kind: fe.kind, file: fe.file, claimIds: [], evidenceIds: [...(cov?.evidenceIds ?? []), ...containsEvidence(store, rev.id, id)].slice(0, 6), tier: conf(id) < 0.5 ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "protected", pos: { x: 320, y: y0 + (i - 3) * 46 }, heat: { value: 1 - conf(id), label: cov ? `${cov.percent}% lines${branchText} covered, ${ts.length} test(s)` : `${ts.length} test(s), no coverage data` }, notes: [cov ? `${cov.covered}/${cov.lines} lines covered${branchText}.` : "No coverage report for this code.", ts.length ? `Reached by ${ts.slice(0, 3).map((t) => `“${t.name}”`).join(", ")}.` : "No test reaches it."] });
      v.edges.push({ id: `e:${op}:${id}`, fromNodeId: bid, toNodeId: `n:${op}:${id}`, kind: "includes", evidenceIds: containsEvidence(store, rev.id, id), displayMode: "FACT" });
    });
    for (const t of protectingTests.slice(0, 4)) {
      if (!shownTests.has(t.entityId)) { shownTests.set(t.entityId, `n:test:${t.entityId}`); const st = resultOf(t.entityId); const ev = store.factsFor(rev.id, t.entityId).find((f) => f.predicate === "test_result")?.evidence.map((x) => x.id) ?? containsEvidence(store, rev.id, t.entityId); v.nodes.push({ id: `n:test:${t.entityId}`, entityRefs: [t.entityId], label: t.name, kind: "test", file: t.file, claimIds: [], evidenceIds: ev, tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "test", pos: { x: -330, y: shownTests.size * 70 - 40 }, badge: st, heat: st === "failed" ? { value: 1, label: "failing" } : undefined, notes: [`Result: ${st}.`] }); }
      v.edges.push({ id: `e:t:${t.entityId}:${op}`, fromNodeId: shownTests.get(t.entityId)!, toNodeId: bid, kind: "protects", evidenceIds: containsEvidence(store, rev.id, t.entityId), displayMode: "FACT" });
    }
    // Semantic coverage: does any test assert a property the behaviour relies on?
    const names = fns.map((id) => flow.entities.get(id)!.name).join(" ");
    const testText = tests.map((t) => `${t.name} ${t.file}`).join(" ");
    PROPERTIES.filter((p) => p.guard.test(names)).forEach((p, k) => {
      const asserted = p.test.test(testText);
      if (!mProps.has(p.key)) mProps.set(p.key, { id: `col:prop:${p.key}`, label: p.label, sub: "a test should assert this", role: "property", entityRefs: [], evidenceIds: [] });
      if (asserted) {
        const named = tests.filter((t) => p.test.test(`${t.name} ${t.file}`)).slice(0, 3);
        const evOk = observation(store, rev.id, `sem:${op}:${p.key}:ok`, "TEST", "", `Test name or file mentions ${p.label}: ${named.map((t) => t.name).join(", ")}; checked ${tests.length} test(s).`);
        const cOk = claimOf(store, rev.id, { assertion: `A test appears to assert ${p.label} for ${e.name}: ${named.map((t) => t.name).join(", ")}.`, claimClass: "semantic-coverage-asserted", evidenceIds: [evOk.id], rationaleSummary: "Judged from test names and files only; a name that mentions it does not prove the assertion is there." });
        claims.push(cOk);
        mCells.push({ row: `row:${op}`, col: `col:prop:${p.key}`, state: "asserted", displayMode: cOk.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE", claimId: cOk.draft.id, evidenceIds: [evOk.id], note: cOk.draft.assertion });
        return;
      }
      const ev = observation(store, rev.id, `sem:${op}:${p.key}`, "TEST", "", `No test name or file mentions ${p.label}; checked ${tests.length} test(s).`);
      const c = claimOf(store, rev.id, { assertion: `${e.name} relies on ${p.label}, but no test appears to assert it.`, claimClass: "semantic-coverage-gap", evidenceIds: [ev.id], rationaleSummary: "Judged from test names and files only; a test may assert it without naming it." });
      claims.push(c);
      mCells.push({ row: `row:${op}`, col: `col:prop:${p.key}`, state: "gap", displayMode: "HYPOTHESIS", claimId: c.draft.id, evidenceIds: [ev.id], note: c.draft.assertion });
      v.nodes.push({ id: `n:gap:${op}:${p.key}`, entityRefs: [op], label: `untested: ${p.label}`, kind: "gap", file: "", claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds: [ev.id], tier: "CRITICAL", displayMode: "HYPOTHESIS", unresolvedCalls: 0, role: "gap", pos: { x: -100, y: y0 - 56 + k * 38 }, badge: "semantic gap", heat: { value: 0.8, label: "no test asserts it" }, notes: [c.draft.assertion] });
      v.edges.push({ id: `e:gap:${op}:${p.key}`, fromNodeId: `n:gap:${op}:${p.key}`, toNodeId: bid, kind: "missing for", claimId: c.draft.id, evidenceIds: [ev.id], displayMode: "HYPOTHESIS" });
    });
    row++;
  }
  // Test columns: every test shown in the graph, with how much of each behaviour's code it reaches.
  for (const [tid] of shownTests) {
    const t = tests.find((x) => x.entityId === tid)!;
    const st = resultOf(tid), tev = store.factsFor(rev.id, tid).find((f) => f.predicate === "test_result")?.evidence.map((x) => x.id) ?? containsEvidence(store, rev.id, tid);
    mTests.set(tid, { id: `col:test:${tid}`, label: t.name, sub: `${t.file.split("/").slice(-2).join("/")} · ${st === "unknown" ? "no result recorded" : st}`, role: "test", entityRefs: [tid], evidenceIds: tev.slice(0, 4) });
    for (const [op, fns] of opFns) {
      const hit = fns.filter((f) => testReach.get(tid)!.has(f) || tid === f).length;
      if (!hit) continue;
      mCells.push({ row: `row:${op}`, col: `col:test:${tid}`, state: st === "failed" ? "failing" : "protects", strength: hit / Math.max(1, fns.length), displayMode: "FACT", evidenceIds: containsEvidence(store, rev.id, tid), note: `${t.name} reaches ${hit} of the ${fns.length} function(s) under ${short(op)} by following parsed calls${st === "failed" ? "; it is currently failing" : st === "unknown" ? "; no result is recorded for it" : ""}.` });
    }
  }
  if (mRows.length && (mTests.size || mProps.size)) {
    v.matrix = {
      rowTitle: "Behaviour", colTitle: "Test, or property a test should assert",
      rows: mRows, cols: [...mTests.values(), ...mProps.values()], cells: mCells,
      states: {
        protects: { label: "reached by this test", glyph: "●", description: "The test calls into this behaviour's code through parsed calls (static, up to four calls deep). The fill is the share of the behaviour's functions it reaches; reaching code is not asserting its behaviour." },
        failing: { label: "reached by a failing test", glyph: "✗", description: "As above, and the recorded result for this test is a failure." },
        asserted: { label: "a test appears to assert it", glyph: "✓", description: "A test name or file mentions this property Judged from names: it does not prove the assertion is there." },
        gap: { label: "no test asserts it", glyph: "?", description: "The behaviour relies on this property and no test name or file mentions it A test may assert it without naming it." },
      },
      emptyMeaning: "No relation found: the test does not reach this behaviour's code through parsed calls.",
    };
  }
  v.caption = `${rank.length} behaviour(s) assessed against ${tests.length} test(s). Warmer means less protected; the weakest code under each behaviour is listed first.`;
  v.meta = { kind: "testconf", subject: subject ?? "" };
  v.params = subject ? { subject } : {};
  if (!hasCov) v.gaps.push("No coverage report was found, so protection is judged by whether any test reaches the code, which is a weak signal.");
  v.gaps.push("Line and branch coverage are read from the project's own report (lcov BRDA, Istanbul branchMap); flakiness history, assertion depth and mutation resistance are not measured.");
  if (tests.length === 0) v.gaps.push("No tests were found in this repository.");
  return { view: v, claims };
}
