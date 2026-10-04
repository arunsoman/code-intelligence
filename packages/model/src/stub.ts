// Deterministic offline provider. It only reasons over the bundle it is given, so it works as a
// reference for what a real provider may cite: evidence ids that exist in `bundle.evidence`.
import type { ChallengeOutput, ConceptsOutput, EvidenceBundle, ExplanationOutput, HypothesesOutput, ModelProvider, ModelRequest, RepresentationOutput, Relationship } from "@cie/schema";

const dirOf = (file: string) => {
  const parts = file.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "(root)";
};

const evIds = (r: Relationship) => r.evidence.map((e) => e.id);

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

/** Offline concept extraction from structure: capabilities by directory, failure modes by error class,
 *  invariants by multiply-written fields, async workflows by topic. Every card cites the evidence it came from. */
function extract(req: ModelRequest): ConceptsOutput {
  const { bundle } = req;
  const symbols = bundle.entities.filter((e) => e.kind !== "file" && e.kind !== "test");
  const cards: ConceptsOutput["cards"] = [];
  const containsEv = new Map<string, string[]>();
  for (const r of bundle.relationships) if (r.kind === "contains") containsEv.set(r.to, evIds(r));

  const byDir = new Map<string, typeof symbols>();
  for (const s of symbols) byDir.set(dirOf(s.file), [...(byDir.get(dirOf(s.file)) ?? []), s]);
  for (const [dir, members] of byDir) {
    cards.push({
      kind: "capability", title: `${dir} module`, statedConfidence: "medium",
      summary: `Code under "${dir}": ${members.slice(0, 6).map((m) => m.name).join(", ")}${members.length > 6 ? ", …" : ""}.`,
      memberEntityIds: members.map((m) => m.entityId).slice(0, 60),
      evidenceIds: members.flatMap((m) => containsEv.get(m.entityId) ?? []).slice(0, 60),
    });
  }

  const throwsBy = new Map<string, typeof bundle.facts>();
  for (const f of bundle.facts) if (f.predicate === "throws") throwsBy.set(factValue(f), [...(throwsBy.get(factValue(f)) ?? []), f]);
  for (const [cls, fs] of throwsBy) {
    cards.push({
      kind: "failure-mode", title: `Failure: ${cls}`, statedConfidence: "high",
      summary: `${cls} is thrown in ${[...new Set(fs.map((f) => f.subject))].length} place(s); callers must handle or propagate it.`,
      memberEntityIds: [...new Set(fs.map((f) => f.subject))].slice(0, 60),
      evidenceIds: fs.flatMap((f) => f.evidence.map((e) => e.id)).slice(0, 60),
    });
  }

  const writesBy = new Map<string, typeof bundle.facts>();
  for (const f of bundle.facts) if (f.predicate === "writes") writesBy.set(factValue(f), [...(writesBy.get(factValue(f)) ?? []), f]);
  const txSubjects = new Set(bundle.facts.filter((f) => f.predicate === "uses_transaction").map((f) => f.subject));
  for (const [field, fs] of writesBy) {
    const writers = [...new Set(fs.map((f) => f.subject))];
    if (writers.length < 2) continue;
    const bare = writers.filter((w) => !txSubjects.has(w));
    cards.push({
      kind: "invariant", title: `Invariant: ${field} stays consistent`, statedConfidence: bare.length ? "medium" : "low",
      summary: `${field} is written by ${writers.length} functions${bare.length ? `; ${bare.length} write outside a transaction, so the invariant may be violated` : ", all inside transactions"}.`,
      memberEntityIds: writers.slice(0, 60), evidenceIds: fs.flatMap((f) => f.evidence.map((e) => e.id)).slice(0, 60),
    });
  }

  for (const r of bundle.relationships.filter((x) => x.kind === "async-flow")) {
    cards.push({
      kind: "workflow", title: `Async: ${r.label ?? "event"}`, statedConfidence: "medium",
      summary: `${r.from} hands work to ${r.to} asynchronously via ${r.label ?? "an event"}; failures here are not visible to the original caller.`,
      memberEntityIds: [r.from, r.to], evidenceIds: evIds(r),
    });
  }
  return { cards: cards.slice(0, 40) };
}

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

export class StubProvider implements ModelProvider {
  readonly name = "stub";
  readonly model = "deterministic-graph-v1";
  readonly hosted = false;
  async generate(req: ModelRequest): Promise<unknown> {
    switch (req.purpose) {
      case "REPRESENT": return represent(req);
      case "EXPLAIN": return explain(req);
      case "EXTRACT": return extract(req);
      // The deterministic adversarial checks run in core; the stub has no judgment of its own to add.
      case "CHALLENGE": return { objections: [] } satisfies ChallengeOutput;
      case "HYPOTHESIZE": return hypothesize(req);
      // Routing by judgment needs a language model; offline, the rule and similarity layers have already answered.
      case "ROUTE": return { form: null, confidence: 0, reason: "the offline model does not route" };
    }
  }
}

export type { EvidenceBundle };
