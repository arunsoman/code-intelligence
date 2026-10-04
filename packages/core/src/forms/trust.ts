// V8 Trust-Boundary and Privilege Map, and V15 Policy Enforcement Map. Both rest on the same finding: where execution
// enters, what refuses it on the way (a guard: code that can throw a refusal), and what state it can reach.
// Guards are proposed from throw sites, so they are inferences; "unprotected" is a hypothesis shown with its counter-argument.
import type { Claim, EvidenceRef, MatrixAxis, MatrixCell, ViewGroup, ViewNode } from "@cie/schema";
import { commentsAround } from "../gitinfo.ts";
import { queryTerms } from "../retrieval.ts";
import type { RevisionRow, Store } from "../store.ts";
import { appliedGuardEdges, entryPoints, guards, routes, sinks, type RoutePath } from "./analysis.ts";
import { baseView, claimOf, containsEvidence, emptyForm, flowGraph, hash, readSource, short } from "./common.ts";

const POLICY_WORDS = /\b(must|never|only|require[sd]?|limit|policy|kyc|retention|rate|allowed|forbidden|not allowed|deliberately)\b/i;

function setup(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const flow = flowGraph(store, rev.id);
  const entries = entryPoints(flow);
  const g = guards(store, rev.id, flow);
  const s = sinks(store, rev.id);
  const terms = subject ? [subject.toLowerCase()] : queryTerms(question);
  const named = [...s.keys()].filter((id) => terms.some((t) => short(id).toLowerCase().includes(t) || [...s.get(id)!.fields].some((f) => f.toLowerCase() === t)));
  const sinkIds = new Set(named.length ? named : subject ? [] : s.keys());
  const rs = routes(flow, entries, sinkIds, new Set(g.keys()));
  return { flow, entries, g, s, sinkIds, rs };
}
type Sinks = ReturnType<typeof sinks>;
/** The path's call sites, plus the statement that changes the state at its end (the only evidence a one-function route has). */
const routeEvidence = (r: RoutePath, s: Sinks) => [...new Set([...r.rels.flatMap((x) => x.evidence.map((e) => e.id)), ...(s.get(r.sink)?.evidenceIds ?? [])])];

export function buildTrust(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "TrustBoundary" as const, question, kind: "trust", caption: "", reason: "You asked about trust and enforcement, so this shows the walls between outside and inside, the gates that can refuse a request, and the protected state behind them." };
  const { flow, g, s, rs } = setup(store, rev, question, subject);
  if (rs.length === 0) return emptyForm(o, subject ? `No entry point can reach “${subject}”.` : "I found no entry point that reaches code that changes state, so there is no boundary to draw.");
  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const nodeId = (id: string) => `n:${id}`;
  const depth = new Map<string, number>();
  for (const r of rs) r.ids.forEach((id, i) => depth.set(id, Math.min(depth.get(id) ?? 99, i)));
  const applied = rs.flatMap((r) => appliedGuardEdges(flow, r.ids, r.gates));
  const used = new Set([...rs.flatMap((r) => r.ids), ...applied.map((a) => a.guard)]);
  const zoneOf = (id: string) => g.has(id) && !rs.some((r) => r.entry.id === id) ? "gate" : rs.some((r) => r.entry.id === id) ? "outside" : g.has(id) ? "gate" : s.has(id) && rs.some((r) => r.sink === id) ? "data" : "inside";
  const colX = { outside: -520, gate: -170, inside: 120, data: 470 } as const;
  const rowCount = { outside: 0, gate: 0, inside: 0, data: 0 };
  for (const id of [...used].sort()) {
    const e = flow.entities.get(id)!, z = zoneOf(id), gd = g.get(id);
    const node: ViewNode = { id: nodeId(id), entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: containsEvidence(store, rev.id, id), tier: z === "data" || z === "gate" ? "CRITICAL" : "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: z === "outside" ? "entry" : z === "gate" ? "gate" : z === "data" ? "sink" : "step", lane: z, pos: { x: colX[z], y: (rowCount[z]++) * 78 }, badge: z === "outside" ? "entry point" : z === "gate" ? "gate" : z === "data" ? "changes state" : undefined, notes: [] };
    if (gd) {
      const c = claimOf(store, rev.id, { assertion: `${e.name} enforces a check: ${gd.reason}.`, claimClass: "enforcement-point", evidenceIds: gd.evidenceIds, subjects: [id], rationaleSummary: "Proposed from the throw sites; enforcement through configuration or a framework is not visible." });
      claims.push(c); node.ownClaimId = c.draft.id; node.claimIds = [c.draft.id]; node.evidenceIds = gd.evidenceIds; node.displayMode = c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE"; node.notes!.push(gd.reason);
    }
    if (z === "data") node.notes!.push(`Changes ${[...s.get(id)!.fields].join(", ")}${s.get(id)!.inTx ? " inside a transaction" : " outside a transaction"}.`);
    v.nodes.push(node);
  }
  // Rails: the real call edges along each route.
  const seenEdge = new Set<string>();
  for (const r of rs) for (const rel of r.rels) if (!seenEdge.has(rel.id)) {
    seenEdge.add(rel.id);
    v.edges.push({ id: `e:${rel.id}`, fromNodeId: nodeId(rel.from), toNodeId: nodeId(rel.to), kind: rel.kind, relationshipId: rel.id, evidenceIds: rel.evidence.map((x) => x.id), displayMode: rel.kind === "async-flow" ? "HYPOTHESIS" : "FACT", label: rel.label });
  }
  // Gates applied as a check before the next step: the function that calls the check is joined to it.
  for (const a of applied) if (!seenEdge.has(a.rel.id)) { seenEdge.add(a.rel.id); v.edges.push({ id: `e:${a.rel.id}`, fromNodeId: nodeId(a.rel.from), toNodeId: nodeId(a.guard), kind: "checks", relationshipId: a.rel.id, evidenceIds: a.rel.evidence.map((x) => x.id), displayMode: "FACT", label: "checks" }); }
  // Unprotected routes: hypotheses that must show their counter-argument before they alarm.
  let open = 0;
  for (const r of rs.filter((x) => x.gates.length === 0).slice(0, 12)) {
    const c = claimOf(store, rev.id, { assertion: r.ids.length === 1 ? `${short(r.entry.id)} is an entry point that changes state itself, with no detected gate before it.` : `${short(r.entry.id)} reaches ${short(r.sink)} without passing any detected gate.`, claimClass: "unprotected-path", evidenceIds: routeEvidence(r, s), rationaleSummary: "No code that can refuse the request was found on the shortest path.", structure: { kind: "path", entityIds: r.ids } });
    claims.push(c); open++;
    const hid = `n:open:${hash(r.entry.id, r.sink)}`;
    const mid = r.ids.length > 2 ? r.ids[Math.floor(r.ids.length / 2)] : r.ids[0];
    const midNode = v.nodes.find((n) => n.id === nodeId(mid))!;
    v.nodes.push({ id: hid, entityRefs: [r.entry.id, r.sink], label: "no gate on this path", kind: "hazard", file: "", claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds: routeEvidence(r, s), tier: "CRITICAL", displayMode: "HYPOTHESIS", unresolvedCalls: 0, role: "unprotected", pos: { x: midNode.pos!.x + 40, y: midNode.pos!.y - 56 }, notes: [c.draft.assertion] });
    v.edges.push({ id: `e:${hid}`, fromNodeId: hid, toNodeId: nodeId(r.sink), kind: "can reach", claimId: c.draft.id, evidenceIds: routeEvidence(r, s), displayMode: "HYPOTHESIS" });
  }
  const zones: [keyof typeof colX, string][] = [["outside", "outside: where requests arrive"], ["gate", "the wall: enforcement"], ["inside", "inside"], ["data", "protected state"]];
  v.groups = zones.map(([z, label]): ViewGroup => ({ id: `g:region:${z}`, label, kind: "region", childNodeIds: v.nodes.filter((n) => n.lane === z).map((n) => n.id), level: 1, evidenceIds: [], displayMode: "FACT" })).filter((x) => x.childNodeIds.length);
  const gates = [...used].filter((id) => g.has(id)).length;
  v.caption = `${rs.map((r) => r.entry.id).filter((x, i, a) => a.indexOf(x) === i).length} entry point(s) reach ${rs.map((r) => r.sink).filter((x, i, a) => a.indexOf(x) === i).length} state-changing function(s); ${gates} gate(s) found, ${open} route(s) with no detected gate.`;
  v.meta = { kind: "trust", subject: subject ?? "" };
  v.params = subject ? { subject } : {};
  v.gaps.push("Gates are proposed from code that can throw a refusal; authentication done by a framework, proxy or configuration is invisible, so an “unprotected” route may be protected elsewhere.");
  v.gaps.push("Real traffic identities are not available, so the overlay of who actually calls what is not drawn.");
  return { view: v, claims };
}

export function buildPolicy(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "PolicyMap" as const, question, kind: "policy", caption: "", reason: "You asked about policies, so this shows each rule, where code enforces it, which flows it governs, and the routes that get around it." };
  const { flow, entries, g, s, rs } = setup(store, rev, question, subject);
  // Group guards into policies by the refusal they raise.
  const policies = new Map<string, { name: string; guardIds: string[]; evidence: string[] }>();
  for (const gd of g.values()) for (const err of gd.errors) { const p = policies.get(err) ?? { name: err, guardIds: [], evidence: [] }; p.guardIds.push(gd.id); p.evidence.push(...gd.evidenceIds); policies.set(err, p); }
  // Convention-only policies: stated in a comment, with no code that can refuse.
  const conv: { id: string; text: string; ev: EvidenceRef }[] = [];
  for (const e of flow.entities.values()) {
    if (conv.length >= 12 || !/^(function|method)$/.test(e.kind) || g.has(e.entityId) || !e.spans[0]) continue;
    const src = readSource(rev, e.file); if (!src) continue;
    for (const cm of commentsAround(src, e.spans[0].startByte, e.spans[0].endByteExclusive)) {
      if (!POLICY_WORDS.test(cm.text) || cm.kind === "remark") continue;
      const ev: EvidenceRef = { id: "ev:" + hash(rev.id, "policycomment", e.file, String(cm.startByte)), sourceId: e.file, location: { kind: "CodeLocation", span: { sourceId: e.file, contentHash: e.spans[0].contentHash, revision: rev.id, startByte: cm.startByte, endByteExclusive: cm.endByte } }, class: "STATIC_PARSED", observedAt: new Date().toISOString(), accessScopeId: "local", state: "CURRENT" };
      store.putEvidence(rev.id, ev); conv.push({ id: e.entityId, text: cm.text, ev }); break;
    }
  }
  if (policies.size === 0 && conv.length === 0) return emptyForm(o, "I found no code that refuses a request and no comment stating a rule, so there is no policy to map.");

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const nodeId = (id: string) => `n:${id}`;
  const all = [...policies.values()];
  let escapes = 0, row = 0;
  const escapeRoutes = new Map<string, { r: RoutePath; skipped: string[]; fields: Set<string> }>();
  const entryRow = new Map<string, number>(), sinkRow = new Map<string, number>();
  // The same routes and rules as a grid: one row per route, one column per rule, a cell where the relation is known.
  const mRows = new Map<string, MatrixAxis>(), mCols: MatrixAxis[] = [], mCells: MatrixCell[] = [];
  const colOfPolicy = new Map<string, string>();
  const rowOfRoute = (r: RoutePath, fields: Iterable<string>) => {
    const id = `row:${r.entry.id}>${r.sink}`;
    if (!mRows.has(id)) mRows.set(id, { id, label: r.entry.id === r.sink ? short(r.entry.id) : `${short(r.entry.id)} → ${short(r.sink)}`, sub: `changes ${[...fields].join(", ") || "state"}`, role: "route", entityRefs: [...new Set([r.entry.id, r.sink])], evidenceIds: routeEvidence(r, s).slice(0, 6) });
    return id;
  };
  const ensure = (id: string, kind: "entry" | "sink") => {
    if (v.nodes.some((n) => n.id === nodeId(id))) return;
    const e = flow.entities.get(id)!, m = kind === "entry" ? entryRow : sinkRow;
    m.set(id, m.size);
    v.nodes.push({ id: nodeId(id), entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: containsEvidence(store, rev.id, id), tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: kind, pos: { x: kind === "entry" ? -460 : 460, y: m.get(id)! * 70 }, badge: kind === "entry" ? "entry point" : "changes state", notes: kind === "sink" ? [`Changes ${[...(s.get(id)?.fields ?? [])].join(", ")}.`] : [] });
  };
  const allSinks = new Set(s.keys());
  const allRoutes = routes(flow, entries, allSinks, new Set(g.keys()));
  for (const p of all) {
    const gset = new Set(p.guardIds);
    const governed = allRoutes.filter((r) => r.gates.some((x) => gset.has(x)));
    // The state this rule protects: whatever its governed routes change. Anything else that changes the same state without the check is a way around it.
    const governedFields = new Set(governed.flatMap((r) => [...(s.get(r.sink)?.fields ?? [])]));
    const escape = allRoutes.filter((r) => !r.gates.some((x) => gset.has(x)) && [...(s.get(r.sink)?.fields ?? [])].some((f) => governedFields.has(f)));
    const pid = `n:policy:${p.name}`;
    const gnodes = [...new Set(p.guardIds)];
    const ev = [...new Set(p.evidence)];
    const c = claimOf(store, rev.id, { assertion: `The rule “${p.name}” is enforced by ${gnodes.map(short).join(", ")} and governs ${governed.length} flow(s).`, claimClass: "policy-enforced", evidenceIds: ev, subjects: gnodes, rationaleSummary: "Enforcement is proposed from the throw sites of these functions." });
    claims.push(c);
    v.nodes.push({ id: pid, entityRefs: gnodes, label: p.name.replace(/Error$/, ""), kind: "policy", file: "", claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds: ev, tier: "CRITICAL", displayMode: c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE", unresolvedCalls: 0, role: "policy", pos: { x: 0, y: row * 140 }, badge: "enforced in code", notes: [c.draft.assertion] });
    row++;
    colOfPolicy.set(p.name, pid);
    mCols.push({ id: pid, label: p.name.replace(/Error$/, ""), sub: `enforced by ${gnodes.map(short).join(", ")}`, role: "rule", entityRefs: gnodes, evidenceIds: ev.slice(0, 6), claimId: c.draft.id });
    for (const r of governed.slice(0, 8)) { ensure(r.entry.id, "entry"); ensure(r.sink, "sink");
      mCells.push({ row: rowOfRoute(r, s.get(r.sink)?.fields ?? []), col: pid, state: "enforced", displayMode: c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE", claimId: c.draft.id, evidenceIds: [...routeEvidence(r, s).slice(0, 4), ...ev.slice(0, 3)], note: `${short(r.entry.id)} reaches ${short(r.sink)} through a check that can raise “${p.name}”.` });
      v.edges.push({ id: `e:rail:${p.name}:${r.entry.id}:${r.sink}`, fromNodeId: nodeId(r.entry.id), toNodeId: pid, kind: "governed by", evidenceIds: routeEvidence(r, s).slice(0, 6), displayMode: "FACT" }, { id: `e:rail2:${p.name}:${r.entry.id}:${r.sink}`, fromNodeId: pid, toNodeId: nodeId(r.sink), kind: "guards", evidenceIds: ev.slice(0, 4), displayMode: "FACT" });
    }
    for (const r of escape) {
      const k = `${r.entry.id}>${r.sink}`;
      const cur = escapeRoutes.get(k) ?? { r, skipped: [], fields: new Set<string>() };
      cur.skipped.push(p.name); for (const f of s.get(r.sink)?.fields ?? []) if (governedFields.has(f)) cur.fields.add(f);
      escapeRoutes.set(k, cur);
    }
  }
  // One entry per way around, naming every check it skips, rather than one per (route, rule).
  for (const { r, skipped, fields } of [...escapeRoutes.values()].slice(0, 12)) {
    escapes++;
    const rules = skipped.map((x) => x.replace(/Error$/, ""));
    const ec = claimOf(store, rev.id, { assertion: r.ids.length === 1 ? `${short(r.entry.id)} changes ${[...fields].join(", ")} directly, without ${rules.join(", ")} — checks that other routes to the same state pass.` : `${short(r.entry.id)} reaches ${short(r.sink)}, which changes ${[...fields].join(", ")}, without passing ${rules.join(", ")} — checks that other routes to the same state pass.`, claimClass: "policy-escape", evidenceIds: routeEvidence(r, s), rationaleSummary: "The shortest path found avoids the enforcing functions.", structure: { kind: "path", entityIds: r.ids } });
    claims.push(ec); ensure(r.entry.id, "entry"); ensure(r.sink, "sink");
    { const rid = rowOfRoute(r, fields);
      for (const name of skipped) { const col = colOfPolicy.get(name); if (col) mCells.push({ row: rid, col, state: "bypassed", displayMode: "HYPOTHESIS", claimId: ec.draft.id, evidenceIds: routeEvidence(r, s).slice(0, 6), note: ec.draft.assertion }); } }
    if (r.entry.id !== r.sink) v.edges.push({ id: `e:esc:${r.entry.id}:${r.sink}`, fromNodeId: nodeId(r.entry.id), toNodeId: nodeId(r.sink), kind: "escape route", claimId: ec.draft.id, evidenceIds: routeEvidence(r, s), displayMode: "HYPOTHESIS", label: `skips ${rules.length} check(s)` });
    else { const n = v.nodes.find((x) => x.id === nodeId(r.sink)); if (n) { n.displayMode = "HYPOTHESIS"; n.claimIds = [...n.claimIds, ec.draft.id]; n.badge = `skips ${rules.length} check(s)`; n.notes = [...(n.notes ?? []), ec.draft.assertion]; } }
    (v.consequences ??= []).push({ id: `c:${ec.draft.id}`, text: ec.draft.assertion, kind: "escape route", displayMode: ec.displayMode === "HIDDEN" ? "HIDDEN" : "HYPOTHESIS", claimId: ec.draft.id, evidenceIds: routeEvidence(r, s).slice(0, 6), entityIds: r.ids });
  }
  for (const cv of conv) {
    const c = claimOf(store, rev.id, { assertion: `${short(cv.id)} is meant to honour a rule (“${cv.text}”) but nothing in its code can refuse a request: it holds by convention only.`, claimClass: "policy-convention", evidenceIds: [cv.ev.id], subjects: [cv.id], rationaleSummary: "A comment states the rule; no code enforces it." });
    claims.push(c);
    v.nodes.push({ id: `n:conv:${hash(cv.id, cv.text)}`, entityRefs: [cv.id], label: cv.text.slice(0, 56), kind: "policy", file: flow.entities.get(cv.id)!.file, claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds: [cv.ev.id], tier: "RELEVANT", displayMode: "HYPOTHESIS", unresolvedCalls: 0, role: "policy", ghost: true, pos: { x: 0, y: row * 140 }, badge: "by convention", notes: [c.draft.assertion] });
    row++;
    { const colId = `n:conv:${hash(cv.id, cv.text)}`;
      mCols.push({ id: colId, label: cv.text.slice(0, 56), sub: "held by convention", role: "convention", entityRefs: [cv.id], evidenceIds: [cv.ev.id], claimId: c.draft.id });
      for (const [rid, ax] of mRows) if (ax.entityRefs.includes(cv.id)) mCells.push({ row: rid, col: colId, state: "convention", displayMode: "HYPOTHESIS", claimId: c.draft.id, evidenceIds: [cv.ev.id], note: c.draft.assertion }); }
    (v.consequences ??= []).push({ id: `c:${c.draft.id}`, text: c.draft.assertion, kind: "convention only", displayMode: c.displayMode === "HIDDEN" ? "HIDDEN" : "HYPOTHESIS", claimId: c.draft.id, evidenceIds: [cv.ev.id], entityIds: [cv.id] });
  }
  if (mRows.size && mCols.length) {
    // Rows with the most ways around come first; the heat says how many of the rules a route skips.
    const rows = [...mRows.values()].map((ax) => {
      const mine = mCells.filter((c) => c.row === ax.id), skipped = mine.filter((c) => c.state === "bypassed").length, held = mine.filter((c) => c.state === "enforced").length;
      return { ...ax, ...(skipped ? { heat: { value: skipped / Math.max(1, skipped + held), label: `skips ${skipped} of ${skipped + held} rule(s) it could pass` } } : {}), _k: skipped };
    }).sort((a, b) => b._k - a._k || a.label.localeCompare(b.label)).map(({ _k, ...ax }) => ax);
    v.matrix = {
      rowTitle: "Route (entry point → state it changes)", colTitle: "Rule",
      rows, cols: mCols, cells: mCells,
      states: {
        enforced: { label: "enforced", glyph: "✓", description: "The route passes through code that can refuse it under this rule. Proposed from where the code throws: not proof." },
        bypassed: { label: "can get around", glyph: "✕", description: "Another route to the same state does pass this rule, and this one's shortest path does not. It shows that a way around exists, not that anyone uses it." },
        convention: { label: "by convention", glyph: "◌", description: "A comment states the rule; nothing in the code can refuse a request." },
      },
      emptyMeaning: "No relation found: the route does not reach state this rule governs, or the rule is not enforced on a path through it.",
    };
  }
  v.caption = `${all.length} rule(s) enforced in code, ${conv.length} held only by convention, ${escapes} route(s) that get around a rule. In the matrix ✓ is enforced, ✕ is a way around and ○ is convention only; in the graph solid diamonds are enforced and hollow ones rely on convention.`;
  v.meta = { kind: "policy", subject: subject ?? "" };
  v.params = subject ? { subject } : {};
  v.gaps.push("A rule is recognised by the refusal its code can raise; rules enforced in configuration, a database constraint, or another service are not found.");
  v.gaps.push("Escape routes use the shortest call path found; a longer path through the check is not considered.");
  void entries;
  return { view: v, claims };
}
