// C24 causality phase-1: relationship builder (design §6/§13). Adapters propose; the engine validates each proposal
// against identity and the adapter's declared capability, then hands the surviving EXECUTION_ORDER proposals to the
// phase-0 deterministic reconciler (cycles are quarantined whole, never first-edge-wins). Wait relations are separate
// typed records in the WAIT layer and are never quarantined as ordering contradictions. Missing evidence becomes gap
// nodes, and absence of evidence never proves absence of involvement.
import type { EdgeKind, EventKind, GraphLayer, SamplingState } from "@cie/schema";
import type { NormalizedEvent } from "./normalize.ts";
import { deliveryKey } from "./normalize.ts";
import { ORDERING_KINDS, reconcileProposedOrdering, type ProposedEdge, type Reconciliation } from "./ordering.ts";

export interface RelationCertificateInput { id: string; adapterId: string; kind: EdgeKind; /** Events this certificate matches (identity pairing, e.g. send+delivery). */ matchesEventIds: string[]; sourceNamespace?: string; valid?: boolean }
export interface AdapterCapabilityInput {
  adapterId: string; version: string; sourceNamespaces: string[]; edgeKinds: EdgeKind[];
  certifiesProgramOrder?: boolean; waitSemantics?: boolean; trusted: boolean;
}
export interface AdapterProposal { edgeId: string; fromEventId: string; toEventId: string; kind: EdgeKind; adapterId: string; evidenceIds: string[] }
export interface WaitRelationInput { id: string; task: string; resource: string; resourceEpoch?: string; ownerTaskIds?: string[]; escapeConditions?: string[]; observationEventIds?: string[]; completeness?: string }
export interface CoverageCertificateInput {
  id: string; sourceId: string; window: { from: number; to: number }; predicateSchemaId: string; queryHash: string;
  exhaustiveForPredicate: boolean; sampling: SamplingState; adapterId: string; adapterVersion: string;
  exclusions?: string[]; sourceEpoch?: string; retentionPolicyVersion?: number;
}

export interface ProposalEdge { id: string; fromEventId: string; toEventId: string; kind: EdgeKind; evidenceIds: string[]; ruleId: string; problems: string[] }

export interface ProposalOutcome {
  edges: { id: string; fromEventId: string; toEventId: string; kind: EdgeKind; layer: GraphLayer; state: "ACCEPTED" | "QUARANTINED"; ruleId: string; evidenceIds: string[]; limitations: string[] }[];
  reconciliation: Reconciliation;
  waitRelations: (WaitRelationInput & { layer: "WAIT" })[];
  gaps: { id: string; kind: "MISSING_EVENT" | "SAMPLED_REGION" | "UNATTRIBUTED_CODE" | "CLOCK_UNKNOWN" | "ACCESS_RESTRICTED" | "ADAPTER_UNSUPPORTED" | "RETENTION_EXPIRED"; adjacentEventIds: string[]; missingPredicate: string; material: boolean; safeExplanation: string }[];
}

const ORDER_KIND_FROM_EVENT: Partial<Record<EventKind, EdgeKind>> = { SEND: "SEND_RECEIVE", ENQUEUE: "SEND_RECEIVE", SPAWN: "SPAWN", TASK_COMPLETE: "COMPLETE_JOIN", READ_VERSION: "READS_FROM", WRITE_VERSION: "READS_FROM" };

/**
 * Build validated proposals from events, certificates and adapter capabilities, then reconcile.
 * Rules follow design §6's table: SEND/RECEIVE pairing needs authenticated identity agreement (message id + tenant);
 * COMPLETE_JOIN needs the completion actually awaited (attributes.awaited); SPAWN needs an explicit childTask, never a
 * timestamp guess; READS_FROM needs version identity; PROGRAM_ORDER comes only from strand-certifying adapters and only
 * inside one task's process epoch. Sampling events are CPU attribution and never ordering evidence (RC13).
 */
export function buildProposals(events: NormalizedEvent[], certs: RelationCertificateInput[], adapters: AdapterCapabilityInput[], waitInputs: WaitRelationInput[], submitted: AdapterProposal[], opts: { scopeHash: string }): ProposalOutcome {
  const byId = new Map(events.map((e) => [e.id, e]));
  const trusted = events.filter((e) => e.trust === "AUTHENTICATED_ADAPTER" || e.trust === "IMPORTED_UNVERIFIED");
  // Adapter authority per kind: a proposal is accepted for validation only from an adapter whose capability lists the kind.
  const kindOk = (adapterId: string, kind: EdgeKind) => adapters.some((a) => a.adapterId === adapterId && a.edgeKinds.includes(kind));
  const proposals: ProposalEdge[] = [];
  const limitationsOf: (extra: string[]) => string[] = (extra) => [...extra];

  // 1) Event-pair rules.
  const sends = trusted.filter((e) => e.kind === "SEND" || e.kind === "ENQUEUE");
  const receives = trusted.filter((e) => e.kind === "RECEIVE" || e.kind === "DEQUEUE");
  for (const s of sends) {
    const key = deliveryKey(s);
    if (!key) continue;
    for (const r of receives) if (deliveryKey(r) === key && r.id !== s.id) {
      // Per-message attempt lineage: each delivery is its own proposal; redelivery is never folded into one edge (RC06).
      proposals.push({ id: `ed:${s.id}->${r.id}`, fromEventId: s.id, toEventId: r.id, kind: "SEND_RECEIVE", evidenceIds: [s.id, r.id], ruleId: "rule:pair-delivery", problems: [] });
    }
  }
  for (const e of trusted) {
    if (e.kind === "TASK_COMPLETE" && e.attributes?.awaitedBy) { // scheduler adapter semantics: the completion names its join continuation
      const join = byId.get(String(e.attributes.awaitedBy));
      if (join?.kind === "JOIN") proposals.push({ id: `ed:${e.id}->${join.id}`, fromEventId: e.id, toEventId: join.id, kind: "COMPLETE_JOIN", evidenceIds: [e.id, join.id], ruleId: "rule:awaited-completion", problems: [] });
    }
    if (e.kind === "JOIN" && e.attributes?.awaited) { // or the join names the child task whose completion it awaited (design §7 fan-in)
      const completed = trusted.find((c) => c.kind === "TASK_COMPLETE" && c.taskId === String(e.attributes!.awaited) && c.processEpoch === e.processEpoch);
      if (completed) proposals.push({ id: `ed:${completed.id}->${e.id}`, fromEventId: completed.id, toEventId: e.id, kind: "COMPLETE_JOIN", evidenceIds: [completed.id, e.id], ruleId: "rule:awaited-completion", problems: [] });
    }
    if (e.kind === "SPAWN" && e.attributes?.childTask) {
      const child = trusted.find((c) => c.taskId === String(e.attributes!.childTask) && c.processEpoch === e.processEpoch && (c.kind === "TASK_RESUME" || c.kind === "OP_START"));
      if (child) proposals.push({ id: `ed:${e.id}->${child.id}`, fromEventId: e.id, toEventId: child.id, kind: "SPAWN", evidenceIds: [e.id, child.id], ruleId: "rule:explicit-spawn", problems: [] });
    }
    if (e.kind === "READ_VERSION" && e.attributes?.versionId) {
      const write = trusted.find((w) => (w.kind === "WRITE_VERSION" || w.kind === "TX_COMMIT") && w.attributes?.versionId === e.attributes!.versionId);
      if (write) proposals.push({ id: `ed:${write.id}->${e.id}`, fromEventId: write.id, toEventId: e.id, kind: "READS_FROM", evidenceIds: [write.id, e.id], ruleId: "rule:version-provenance", problems: [] });
    }
    if (e.kind === "RECEIVE" && e.attributes?.responseEventId) {
      const resp = byId.get(String(e.attributes.responseEventId));
      if (resp?.kind === "OP_END") proposals.push({ id: `ed:${e.id}->${resp.id}`, fromEventId: e.id, toEventId: resp.id, kind: "REQUEST_RESPONSE", evidenceIds: [e.id, resp.id], ruleId: "rule:request-response", problems: [] });
    }
  }
  // 2) Strand-certified program order: consecutive modeled events of one task in one process epoch, from an adapter that
  //    certifies strand order (a strand may be a task, not merely an OS thread, design §6).
  const strands = [...new Set(trusted.filter((e) => e.taskId).map((e) => `${e.taskId}|${e.processEpoch}`))];
  for (const strandKey of strands) {
    const [taskId] = strandKey.split("|");
    const seq = trusted.filter((e) => e.taskId === taskId && `${e.taskId}|${e.processEpoch}` === strandKey && e.sourceSequence !== null && e.sourceSequence !== undefined && !["SAMPLE"].includes(e.kind as EventKind)).sort((a, b) => String(a.sourceSequence).localeCompare(String(b.sourceSequence), "en", { numeric: true }));
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1], b = seq[i];
      const adapter = adapters.find((ad) => ad.certifiesProgramOrder && ad.sourceNamespaces.some((ns) => ns === (a.attributes?.sourceNamespace ?? a.sourceId)));
      if (!adapter) continue;
      const kind = ORDER_KIND_FROM_EVENT[a.kind as EventKind] ?? "PROGRAM_ORDER";
      proposals.push({ id: `ed:${a.id}->${b.id}`, fromEventId: a.id, toEventId: b.id, kind, evidenceIds: [a.id, b.id], ruleId: "rule:certified-strand", problems: [] });
    }
  }
  // 3) Adapter-submitted proposals (relation certificates + explicit proposals), validated against capability and identity.
  for (const c of certs) {
    if (c.valid === false || c.matchesEventIds.length < 2) continue;
    const pairEvents = c.matchesEventIds.map((id) => byId.get(id)).filter((e): e is NormalizedEvent => !!e);
    if (pairEvents.some((e) => e.trust === "UNTRUSTED_CONTEXT")) continue; // an unauthenticated collector cannot certify anything (RC20)
    if (c.kind === "RELEASE_ACQUIRE") {
      const [a, b] = pairEvents;
      // Same resource generation only: a lock id reused across process epochs must not pair; the mismatch quarantines with a reason (RC08).
      if (!a || !b) continue;
      if (a.attributes?.lock !== b.attributes?.lock || a.processEpoch !== b.processEpoch) proposals.push({ id: `ed:${c.id}`, fromEventId: a.id, toEventId: b.id, kind: "RELEASE_ACQUIRE", evidenceIds: [c.id, a.id, b.id], ruleId: "rule:lock-generation", problems: [a.processEpoch !== b.processEpoch ? `lock identity reused across process epochs (${a.processEpoch} vs ${b.processEpoch}); epochs prevent unrelated executions from merging` : "release/acquire mismatch on the lock resource"] });
      else proposals.push({ id: `ed:${a.id}->${b.id}`, fromEventId: a.id, toEventId: b.id, kind: "RELEASE_ACQUIRE", evidenceIds: [a.id, b.id], ruleId: "rule:lock-generation", problems: [] });
      continue;
    }
    const ordered = pairEvents[0];
    proposals.push({ id: `ed:${c.id}`, fromEventId: ordered.id, toEventId: pairEvents[1]?.id ?? ordered.id, kind: c.kind, evidenceIds: [c.id, ...c.matchesEventIds], ruleId: "rule:adapter-certificate:" + c.adapterId, problems: [] });
  }
  for (const p of submitted) {
    if (!kindOk(p.adapterId, p.kind)) proposals.push({ id: p.edgeId, fromEventId: p.fromEventId, toEventId: p.toEventId, kind: p.kind, evidenceIds: p.evidenceIds, ruleId: "rule:adapter-proposal:unauthorized", problems: [`adapter ${p.adapterId} does not declare ${p.kind} semantics`] });
    else proposals.push({ id: p.edgeId, fromEventId: p.fromEventId, toEventId: p.toEventId, kind: p.kind, evidenceIds: p.evidenceIds, ruleId: "rule:adapter-proposal:" + p.adapterId, problems: [] });
  }

  // 3b) Canonical dedupe: many rules/certificates can witness the same (from, to, kind) fact; one edge carries the merged evidence.
  const seenProposal = new Map<string, ProposalEdge>();
  for (const p of [...proposals].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${p.fromEventId}|${p.toEventId}|${p.kind}`;
    const existing = seenProposal.get(key);
    if (!existing) seenProposal.set(key, p);
    else { existing.evidenceIds = [...new Set([...existing.evidenceIds, ...p.evidenceIds])].sort(); existing.problems = [...new Set([...existing.problems, ...p.problems])]; }
  }
  const deduped = [...seenProposal.values()];

  // 4) Identity checks before reconciliation: proposals referencing unknown or untrusted endpoints are quarantined, not dropped.
  const valid: ProposedEdge[] = []; const quarantined: { p: ProposedEdge; why: string }[] = [];
  for (const p of deduped) {
    const f = byId.get(p.fromEventId), t = byId.get(p.toEventId);
    if (!f || !t || p.problems.length) { quarantined.push({ p, why: !f || !t ? "proposal references events outside the authorized scope" : p.problems.join("; ") }); continue; }
    if ([f, t].some((e) => e.trust === "UNTRUSTED_CONTEXT")) { quarantined.push({ p, why: "untrusted context takes no part in execution topology (RC20)" }); continue; }
    if (ORDERING_KINDS.has(p.kind) && f.tenantId !== t.tenantId) { quarantined.push({ p, why: "cross-tenant ordering claim" }); continue; }
    valid.push(p);
  }
  const reconciliation = reconcileProposedOrdering(valid);
  const edges: ProposalOutcome["edges"] = [
    ...reconciliation.accepted.map((e) => ({ ...e, layer: layerOf(e.kind), state: "ACCEPTED" as const, limitations: limitationsOf([]) })),
    ...reconciliation.quarantined.map((e) => ({ ...e, layer: layerOf(e.kind), state: "QUARANTINED" as const, limitations: e.conflictReport ?? [] })),
    ...quarantined.map(({ p, why }) => ({ ...p, layer: layerOf(p.kind), state: "QUARANTINED" as const, limitations: [why] })),
  ];

  // 5) Wait relations: separate typed records, cycle analyzable (RC12), never merged into the ordering graph.
  const waitRelations = waitInputs.filter((w) => trusted.some((e) => e.taskId === w.task)).map((w) => ({ ...w, layer: "WAIT" as const }));

  // 6) Gap nodes (design §7): missing referenced parents, sampled regions, unknown clocks, unattributed code.
  const spansKnown = new Set(trusted.map((e) => (e.spanId ?? null)).filter(Boolean) as string[]);
  const gaps: ProposalOutcome["gaps"] = [];
  for (const e of trusted) {
    if (e.parentSpanId && !spansKnown.has(e.parentSpanId)) gaps.push(gap("MISSING_EVENT", [e.id], `parent span ${e.parentSpanId} never arrived in the accepted stream`, true, "a missing parent is a gap, not an inferred root"));
    if (e.sampling !== undefined && e.sampling !== "NONE") gaps.push(gap("SAMPLED_REGION", [e.id], `source sampled (${e.sampling}); unsampled events may exist`, true, "sampling defines what absence can mean here"));
    if (e.time.quality === "UNKNOWN") gaps.push(gap("CLOCK_UNKNOWN", [e.id], "no usable clock quality for cross-host comparison", true, "time stays UNKNOWN rather than repaired"));
    if (e.attributes?.unmapped === true) gaps.push(gap("UNATTRIBUTED_CODE", [e.id], "work did not map to any source entity", true, "external/unknown nodes stay visible"));
  }
  for (const w of waitInputs) if (!byIdHasTask(byId, w.task)) gaps.push(gap("ADAPTER_UNSUPPORTED", [], `wait relation for task ${w.task} has no observing events`, true, "wait semantics need observing events"));
  return { edges, reconciliation, waitRelations, gaps };
}

const gap = (kind: ProposalOutcome["gaps"][number]["kind"], adjacent: string[], pred: string, material: boolean, explanation: string) => ({ id: "gap:" + kind.toLowerCase() + ":" + (adjacent[0] ?? "none") + ":" + pred.slice(0, 24), kind, adjacentEventIds: adjacent, missingPredicate: pred, material, safeExplanation: explanation });

function byIdHasTask(byId: Map<string, NormalizedEvent>, task: string): boolean { for (const e of byId.values()) if (e.taskId === task) return true; return false; }

export function layerOf(kind: EdgeKind): GraphLayer {
  if (ORDERING_KINDS.has(kind)) return "EXECUTION_ORDER";
  if (kind === "WAITS_FOR") return "WAIT";
  if (kind === "CORRELATES_WITH") return "ASSOCIATION";
  if (kind === "CAUSE_CANDIDATE" || kind === "INTERVENTION_SUPPORTS") return "EXPLANATION";
  return "CONTEXT";
}