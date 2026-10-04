// C24 causality phase-1 engine (design §4, §12–§15). Durable, bounded, honest: each mutation is one transaction over
// the §15 tables; failures are typed and stated; missing evidence becomes gap nodes; claims never promote themselves.
// Reuse: the phase-0 reconciler and order queries are the contract for contradiction handling (RC11/RC03/RC04); the
// v1 Runtime attribution tiers are preserved (§12: attribute never upgrades an uncertain join).
import { createHash } from "node:crypto";
import type { ApiError, EdgeKind, GraphLayer } from "@cie/schema";
import { normalizeEvent, deliveryKey, type RuntimeEventInput, type NormalizedEvent } from "./normalize.ts";
import { buildProposals, layerOf, type RelationCertificateInput, type AdapterCapabilityInput, type AdapterProposal, type WaitRelationInput, type CoverageCertificateInput } from "./builder.ts";
import { ORDERING_KINDS, orderRelation, type OrderingCertificate } from "./ordering.ts";
import { accountDurations, type AccountedInterval } from "./path-accounting.ts";
import type { Store } from "../store.ts";
import { failpoint } from "../failpoint.ts";

export interface CausalityScopeInput { tenantId: string; revisionSet: string[]; deploymentIds?: string[]; operationIds?: string[]; incidentWindow: { from: number; to: number } }
export interface SourceWatermarkRecord { sourceId: string; sourceEpoch: string; acceptedSequence: string | null; eventTimeWatermark: number | null; allowedLatenessMs: number; finalForWindow: boolean }
export interface EdgeRecord { id: string; version: number; fromEventId: string; toEventId: string; kind: EdgeKind; layer: GraphLayer; state: "ACCEPTED" | "QUARANTINED" | "INVALIDATED"; ruleId: string; evidenceIds: string[]; limitations: string[]; scopeHash: string }
export interface AttributionRecord { eventId: string; revision: string | null; exact: boolean; entityId: string | null; method: "ARTIFACT_EXACT" | "CANDIDATE" | "UNATTRIBUTED"; reasons: string[] }
export interface GapRecord { id: string; kind: "MISSING_EVENT" | "SAMPLED_REGION" | "UNATTRIBUTED_CODE" | "CLOCK_UNKNOWN" | "ACCESS_RESTRICTED" | "ADAPTER_UNSUPPORTED" | "RETENTION_EXPIRED"; adjacentEventIds: string[]; missingPredicate: string; material: boolean; safeExplanation: string }
export interface CauseClaimRecord { claimId: string; snapshotId: string; snapshotVersion: number; level: "EXECUTION_RELATION" | "MECHANISM_CANDIDATE" | "MECHANISM_SUPPORTED" | "INTERVENTION_SUPPORTED"; state: "CURRENT" | "STALE" | "RESTRICTED"; limitations: string[]; populationScope: { revisionSet: string[]; workload?: string; sharedDependencies?: string[]; spillover?: string } }
export interface MechanismEvidenceRecord { id: string; snapshotId: string; snapshotVersion: number; symptomEventIds: string[]; mechanismKind: string; executionEdgeIds: string[]; waitEdgeIds: string[]; candidateClaimIds: string[]; counterEvidenceIds: string[]; materialGapIds: string[]; ownerTasks: string[]; escapeConditions: string[] }
export interface Snapshot {
  id: string; version: number; scopeHash: string; scope: CausalityScopeInput;
  eventIds: string[]; edges: EdgeRecord[]; gaps: GapRecord[]; waitRelations: (WaitRelationInput & { layer: "WAIT" })[];
  coverageIds: string[]; watermarks: SourceWatermarkRecord[]; consistency: "CONSISTENT" | "PARTIAL" | "CONTRADICTORY";
  attributions: AttributionRecord[]; timeQuality: { contradictoryEvents: number; unknownEvents: number; monotonicOnlyEvents: number };
  updateSeq: number; lateEventIds: string[]; invalidatedEdgeIds: string[];
}
export interface AdapterRegistration { adapterId: string; version: string; trusted: boolean; edgeKinds: EdgeKind[] }
export interface CriticalPathReport {
  snapshotId: string; version: number; operationId: string;
  segments: { eventIds: string[]; kind: "EXECUTING" | "WAITING" | "DOWNSTREAM" | "RUNNABLE" | "UNEXPLAINED"; lowerDurationMs: number | null; upperDurationMs: number | null; evidenceIds: string[] }[];
  observedDurationMs: number | null; coveredDurationMs: number | null; unresolvedDurationMs: number | null;
  gateReportId: string; limitations: string[];
}

const LIMITS = { maxEventsPerBatch: 5000, maxEventsPerSource: 50_000, maxEventsPerSlice: 10_000, maxEdgesPerSlice: 30_000, maxDepth: 64, latenessMs: 10 * 60_000 };
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const err = (code: ApiError["code"], message: string, retryable = false) => ({ ok: false as const, error: { code, message, retryable } as ApiError });
const ok = <T,>(value: T) => ({ ok: true as const, value });

export class CausalityEngine {
  readonly store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number = Date.now) { this.store = store; this.now = now; }

  // ------------------------------------------------------------ adapters (privileged; never on the public catalogue, design §12)
  registerAdapter(cap: AdapterCapabilityInput): AdapterRegistration {
    this.store.db.prepare("insert or replace into c24_runtime_sources values (?,0,?,?,?,0,?)")
      .run(cap.adapterId, cap.trusted ? "AUTHENTICATED_ADAPTER" : "IMPORTED_UNVERIFIED", "cap:" + sha(JSON.stringify(cap)), "null", JSON.stringify(cap));
    return { adapterId: cap.adapterId, version: cap.version, trusted: cap.trusted, edgeKinds: cap.edgeKinds };
  }
  adapters(): AdapterCapabilityInput[] {
    return (this.store.db.prepare("select json from c24_runtime_sources").all() as { json: string }[]).map((r) => JSON.parse(r.json) as AdapterCapabilityInput).filter((c) => c?.adapterId);
  }
  registered(sourceId: string): AdapterCapabilityInput | null { return this.adapters().find((a) => a.adapterId === sourceId) ?? null; }

  // ------------------------------------------------------------ intake (privileged)
  ingestEvents(req: {
    batch: RuntimeEventInput[]; watermark: SourceWatermarkRecord; expectedSourceVersion: number;
    relationCertificates?: RelationCertificateInput[]; coverageCertificates?: CoverageCertificateInput[];
    waitRelations?: WaitRelationInput[]; proposals?: AdapterProposal[];
  }) {
    if (req.batch.length > LIMITS.maxEventsPerBatch) return err("RESOURCE_LIMIT", `at most ${LIMITS.maxEventsPerBatch} events per batch; the raw volume stays in the telemetry backend (RC21)`, true);
    const cap = this.registered(req.watermark.sourceId);
    const authenticated = cap?.trusted === true;
    return this.store.tx(() => {
      const db = this.store.db;
      const src = db.prepare("select version, watermark from c24_runtime_sources where id = ?").get(req.watermark.sourceId) as { version: number; watermark: string } | undefined;
      if (src && src.version !== req.expectedSourceVersion) return err("VERSION_CONFLICT", `source ${req.watermark.sourceId} is at version ${src.version}, not ${req.expectedSourceVersion}`, true);
      failpoint("c24-after-source-cursor");
      const wm: SourceWatermarkRecord = { sourceEpoch: req.watermark.sourceEpoch ?? "1", allowedLatenessMs: req.watermark.allowedLatenessMs ?? LIMITS.latenessMs, finalForWindow: req.watermark.finalForWindow === true, sourceId: req.watermark.sourceId, acceptedSequence: req.watermark.acceptedSequence ?? null, eventTimeWatermark: req.watermark.eventTimeWatermark ?? null };
      const tenantId = req.batch[0]?.tenantId ?? "t";
      const ins = db.prepare("insert or ignore into c24_event_refs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      let accepted = 0, duplicates = 0, rejectedUntrusted = 0;
      for (const raw of req.batch) {
        const n = normalizeEvent(raw, authenticated, { tenantId, now: this.now() });
        // A record whose attributes claim another tenant is rejected outright, never stored (RC20: no authority grant, no topology disclosure).
        if (n.problems.some((p) => /claim tenant/.test(p))) { rejectedUntrusted++; continue; }
        const r = ins.run(n.id, 0, n.tenantId, n.sourceId, n.sourceEpoch, n.dedupHash, n.kind, n.time.domain, n.time.epoch, n.traceId ?? null, n.operationId ?? null, n.attemptId ?? null, n.time.observed ?? null, JSON.stringify(n));
        if (r.changes === 0) duplicates++; else accepted++;
      }
      if (Number((db.prepare("select count(*) as n from c24_event_refs where source = ?").get(req.watermark.sourceId) as any).n) > LIMITS.maxEventsPerSource) return err("RESOURCE_LIMIT", `source ${req.watermark.sourceId} exceeds its retained-event budget; compact before sending more (RC21)`, true);
      // Certificates, wait relations: validated at reconstruction against capabilities; stored here.
      for (const c of req.relationCertificates ?? []) db.prepare("insert or replace into c24_relation_certs values (?,?,?,?)").run(c.id, c.adapterId, c.kind, JSON.stringify(c));
      for (const c of req.coverageCertificates ?? []) db.prepare("insert or replace into c24_coverage values (?,?,?,?,?,?,?,?,?)").run(c.id, c.sourceId, c.sourceEpoch ?? "1", c.window.from, c.window.to, c.predicateSchemaId, c.queryHash, c.exhaustiveForPredicate ? 1 : 0, JSON.stringify(c));
      for (const w of req.waitRelations ?? []) db.prepare("insert or replace into c24_wait_relations values (?,?,?,?,?)").run(w.id, "", w.task, w.resource, JSON.stringify(w));
      // Persist adapter-submitted proposals so any later reconstruction re-validates the same set deterministically (RC11).
      if (req.proposals?.length) {
        db.prepare("insert or replace into c24_updates values ('proposals', coalesce((select max(seq) from c24_updates where snapshot_id = 'proposals'),0) + 1, 'ADAPTER_PROPOSALS', ?)").run(JSON.stringify(req.proposals));
      }
      db.prepare("update c24_runtime_sources set watermark = ?, version = version + 1 where id = ?").run(JSON.stringify(wm), req.watermark.sourceId);
      failpoint("c24-after-intake-commit");
      return ok({ receipt: { sourceId: req.watermark.sourceId, accepted, duplicates, rejectedUntrusted, atomic: true }, watermark: wm });
    });
  }

  // ------------------------------------------------------------ reconstruction (design §13)
  reconstruct(scope: CausalityScopeInput, opts: { maxEvents?: number } = {}) {
    const maxEvents = Math.min(opts.maxEvents ?? LIMITS.maxEventsPerSlice, LIMITS.maxEventsPerSlice);
    return this.store.tx(() => {
      const db = this.store.db;
      const { rows: events, truncated, revokedSources } = this.eventsInScope(scope, { limit: maxEvents });
      if (truncated) return err("RESOURCE_LIMIT", `the authorized window holds more than ${maxEvents} events; raise the limit per request or narrow the window (RC21)`, true);
      const restrictedGaps = revokedSources.flatMap((sourceId) => [{
        id: `gap:access-restricted:${sha(sourceId)}`, kind: "ACCESS_RESTRICTED" as const, adjacentEventIds: [], missingPredicate: `all events from source ${sourceId}`, material: true,
        safeExplanation: `source ${sourceId} revoked access; previously-visible events are excluded, and stale views show restricted rather than stale trusted conclusions (RC23)`,
      }]);
      const certs = (db.prepare("select json from c24_relation_certs").all() as { json: string }[]).map((r) => JSON.parse(r.json) as RelationCertificateInput);
      const adapters = this.adapters();
      const waitInputs = (db.prepare("select id, task, resource, json from c24_wait_relations").all() as any[]).map((w) => ({ id: w.id, task: w.task, resource: w.resource, ...(w.json ? JSON.parse(w.json) : {}), ownerTaskIds: w.json ? JSON.parse(w.json).ownerTaskIds ?? [] : [], escapeConditions: w.json ? JSON.parse(w.json).escapeConditions ?? [] : [] }));
      const proposals = (db.prepare("select json from c24_updates where snapshot_id = 'proposals'").all() as { json: string }[]).flatMap((r) => JSON.parse(r.json) as AdapterProposal[]);
      const out = buildProposals(events, certs, adapters, waitInputs, proposals, { scopeHash: "" });
      const invalidated = new Set((db.prepare("select derived from c24_derivations where kind = 'invalidated' and derived like 'ed:%'").all() as any[]).map((r) => r.derived as string));
      const untrustworthy = new Set((db.prepare("select derived from c24_derivations where kind = 'invalidated' and derived not like 'ed:%'").all() as any[]).map((r) => r.derived as string));
      const scopeHash = sha(JSON.stringify(scope));
      // The builder's edge list is the single source: accepted, cycle-quarantined AND identity-quarantined (each carrying its reason).
      const edges: EdgeRecord[] = out.edges.map((e) => ({ id: e.id, version: 1, fromEventId: e.fromEventId, toEventId: e.toEventId, kind: e.kind, layer: e.layer, state: invalidated.has(e.id) ? "INVALIDATED" : e.state, ruleId: e.ruleId, evidenceIds: e.evidenceIds, limitations: e.state === "QUARANTINED" ? e.limitations : [], scopeHash }));
      const attributions = events.map((e) => this.resolveAttributionOf(e, scope));
      // Watermarks and late arrivals (RC24): a finalized window that receives later events bumps the version and invalidates the affected edges.
      const watermarks: SourceWatermarkRecord[] = (db.prepare("select id, watermark from c24_runtime_sources where watermark is not null and watermark != 'null'").all() as { id: string; watermark: string }[]).map((r) => ({ ...(JSON.parse(r.watermark) as SourceWatermarkRecord), sourceId: r.id }));
      const lateEventIds = events.filter((e) => watermarks.some((w) => w.sourceId === e.sourceId && w.finalForWindow && w.eventTimeWatermark !== null && e.time.observed !== null && (e.time.observed as number) > (w.eventTimeWatermark as number))).map((e) => e.id);
      if (lateEventIds.length) {
        const affectedTraces = new Set(events.filter((e) => lateEventIds.includes(e.id)).map((e) => e.traceId).filter(Boolean) as string[]);
        for (const e of edges) if (e.state === "ACCEPTED" && ORDERING_KINDS.has(e.kind) && eventsIdsTouchTraces(e, events, affectedTraces)) { e.state = "INVALIDATED"; e.limitations.push("a late event arrived after the window was finalized; the affected relation is invalidated pending re-derivation (RC24)"); }
      }
      const invalidatedEdgeIds = edges.filter((e) => e.state === "INVALIDATED").map((e) => e.id);
      // Wall-clock contradictions on accepted relations are disclosed, not repaired (RC01): the relation stays, the chronology is flagged.
      const byEventId = new Map(events.map((e) => [e.id, e] as [string, NormalizedEvent]));
      for (const e of edges) {
        if (e.state !== "ACCEPTED" || !ORDERING_KINDS.has(e.kind)) continue;
        const f = byEventId.get(e.fromEventId), t = byEventId.get(e.toEventId);
        if (!f || !t) continue;
        const fo = f.time.observed, toc = t.time.observed;
        if (fo !== null && toc !== null && fo > toc) { e.limitations.push("trusted relation retained; wall-clock times conflict with it and are flagged, not repaired (RC01)"); }
      }
      const contradictionEdges = edges.filter((e) => e.limitations.some((l) => /RC01/.test(l))).length;
      // Consistency (design §11): contradictory when ordering components were quarantined; partial when gaps, time contradictions or imperfect quality exist.
      const cycleQuarantines = edges.filter((e) => e.state === "QUARANTINED" && e.limitations.some((l) => /competing|cycle/i.test(l))).length;
      const consistency = cycleQuarantines > 0 ? "CONTRADICTORY" : (out.gaps.length > 0 || truncated || lateEventIds.length || contradictionEdges > 0 || events.some((e) => e.time.quality !== "BOUNDED")) ? "PARTIAL" : "CONSISTENT";
      const timeQuality = { contradictoryEvents: events.filter((e) => e.time.quality === "CONTRADICTORY").length, unknownEvents: events.filter((e) => e.time.quality === "UNKNOWN").length, monotonicOnlyEvents: events.filter((e) => e.time.quality === "LOCAL_MONOTONIC_ONLY").length };
      const id = "snap:" + sha(scopeHash).slice(0, 16);
      const prior = db.prepare("select version from c24_snapshots where id = ? order by version desc limit 1").get(id) as { version: number } | undefined;
      const version = (prior?.version ?? 0) + 1;
      const updateSeq = Number((db.prepare("select coalesce(max(seq),0) as m from c24_updates where snapshot_id = ?").get(id) as any).m) + 1;
      void untrustworthy;
      const consistencyFinal = consistency === "CONSISTENT" && restrictedGaps.length ? "PARTIAL" : consistency;
      const snapshot: Snapshot = {
        id, version, scopeHash, scope, eventIds: events.map((e) => e.id), edges, gaps: [...(out.gaps as Snapshot["gaps"]), ...restrictedGaps], waitRelations: out.waitRelations,
        coverageIds: (db.prepare("select id from c24_coverage").all() as any[]).map((r) => r.id as string),
        watermarks, consistency: consistencyFinal, attributions, timeQuality, updateSeq, lateEventIds, invalidatedEdgeIds,
      };
      failpoint("c24-before-projection-commit");
      this.commitSnapshot(snapshot);
      failpoint("c24-after-projection-commit");
      return ok({ snapshot: this.snapshot(id) ?? snapshot, eventCount: events.length, edgeCount: edges.length });
    });
  }

  private commitSnapshot(s: Snapshot) {
    const db = this.store.db;
    db.prepare("insert or replace into c24_snapshots values (?,?,0,?,?,?)").run(s.id, s.version, s.scopeHash, s.updateSeq, JSON.stringify(s));
    for (const e of s.edges) {
      db.prepare("insert or replace into c24_edge_versions values (?,?,?,?,?,?,?,?,?)").run(e.id, e.version, s.id, e.fromEventId, e.toEventId, e.kind, e.layer, e.state, JSON.stringify(e));
      // Derivation lineage: events → edges, so a later correction/revocation knows exactly what to invalidate (RC17).
      for (const endpoint of new Set([e.fromEventId, e.toEventId])) db.prepare("insert or replace into c24_derivations values (?,?,?,'edge',?)").run(endpoint, e.id, e.version, "{}");
    }
    for (const w of s.waitRelations) db.prepare("insert or replace into c24_wait_relations values (?,?,?,?,?)").run(w.id, s.id, w.task, w.resource, JSON.stringify(w));
    db.prepare("insert into c24_updates values (?,?,?,?)").run(s.id, s.updateSeq, "SNAPSHOT_VERSION", JSON.stringify({ version: s.version, consistency: s.consistency, lateEventIds: s.lateEventIds.length }));
  }

  snapshot(id: string): Snapshot | null {
    const r = this.store.db.prepare("select json from c24_snapshots where id = ? order by version desc limit 1").get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as Snapshot : null;
  }

  // ------------------------------------------------------------ scoped reads
  querySlice(snapshotId: string, req: { knownVersion?: number; roots?: string[]; layers?: GraphLayer[]; depth?: number; limits?: { maxEvents?: number; maxEdges?: number }; continuation?: string }) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    if (req.knownVersion !== undefined && req.knownVersion !== s.version) return err("VERSION_CONFLICT", `snapshot is at version ${s.version}, not ${req.knownVersion}`, true);
    const events = this.eventsByIds(s.eventIds, s.scope.tenantId).filter((e) => e.trust !== "UNTRUSTED_CONTEXT");
    const depth = Math.min(req.depth ?? LIMITS.maxDepth, LIMITS.maxDepth);
    const maxEvents = Math.min(req.limits?.maxEvents ?? 2000, LIMITS.maxEventsPerSlice), maxEdges = Math.min(req.limits?.maxEdges ?? maxEvents * 3, LIMITS.maxEdgesPerSlice);
    const allowedLayers = new Set(req.layers ?? ["EXECUTION_ORDER", "CONTEXT", "WAIT", "ASSOCIATION", "EXPLANATION"]);
    const outgoing = new Map<string, EdgeRecord[]>();
    for (const e of s.edges) if (e.state !== "INVALIDATED" && allowedLayers.has(e.layer)) { if (!outgoing.has(e.fromEventId)) outgoing.set(e.fromEventId, []); outgoing.get(e.fromEventId)!.push(e); }
    const layerRestricted = req.layers !== undefined;
    const inSubgraph = (id: string) => s.edges.some((e) => e.state !== "INVALIDATED" && allowedLayers.has(e.layer) && (e.fromEventId === id || e.toEventId === id));
    const seeds = req.roots
      ? events.filter((e) => req.roots!.includes(e.id)).slice(0, maxEvents)
      : layerRestricted
        ? events.filter((e) => inSubgraph(e.id)).slice(0, maxEvents) // an explicitly requested subgraph carries only its own vertices (RC13)
        : events.slice(0, maxEvents);
    const seen = new Set<string>(seeds.map((e) => e.id));
    const collected: NormalizedEvent[] = [...seeds]; const edges: EdgeRecord[] = [];
    let frontier = seeds.map((e) => e.id);
    for (let d = 0; d < depth && frontier.length && collected.length < maxEvents && edges.length < maxEdges; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const e of outgoing.get(id) ?? []) {
        edges.push(e);
        if (!seen.has(e.toEventId)) { seen.add(e.toEventId); const ev = events.find((x) => x.id === e.toEventId); if (ev) collected.push(ev); next.push(e.toEventId); }
      }
      frontier = next;
    }
    const truncated = collected.length >= maxEvents || edges.length >= maxEdges;
    void frontier;
    return ok({
      snapshotId, version: s.version, events: collected, edges: edges.slice(0, maxEdges),
      attributions: s.attributions.filter((a) => seen.has(a.eventId)),
      gaps: s.gaps.filter((g) => g.adjacentEventIds.some((id2) => seen.has(id2)) || (g.adjacentEventIds.length === 0 && seen.size > 0)),
      waitRelations: s.waitRelations.filter((w) => [...seen].some((id2) => w.task && this.eventsByIds([snapshotId], s.scope.tenantId).some(() => true) || true)).slice(0, 64),
      truncated, continuation: truncated ? `after:${collected.at(-1)?.id ?? ""}` : null,
    });
  }

  traceAncestors(snapshotId: string, eventId: string, maxEvents = 1000) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const events = this.eventsByIds(s.eventIds, s.scope.tenantId);
    const byTo = new Map<string, EdgeRecord[]>();
    for (const e of s.edges) if (e.state === "ACCEPTED" && ORDERING_KINDS.has(e.kind)) { if (!byTo.has(e.toEventId)) byTo.set(e.toEventId, []); byTo.get(e.toEventId)!.push(e); }
    const seen = new Set([eventId]); const collected: NormalizedEvent[] = []; const used: EdgeRecord[] = [];
    let frontier = [eventId]; let boundHit = false;
    for (let d = 0; d < LIMITS.maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const ev = events.find((x) => x.id === id); if (ev) collected.push(ev);
        for (const e of byTo.get(id) ?? []) { used.push(e); if (!seen.has(e.fromEventId)) { seen.add(e.fromEventId); next.push(e.fromEventId); } }
      }
      frontier = next; boundHit = frontier.length > 0;
      if (collected.length >= maxEvents) { boundHit = true; break; }
    }
    return ok({ snapshotId, version: s.version, events: collected.slice(0, maxEvents), edges: used.slice(0, maxEvents * 3), gaps: s.gaps.filter((g) => g.adjacentEventIds.some((id2) => seen.has(id2))), boundaryUnknown: boundHit });
  }

  explainRelation(snapshotId: string, edgeId: string) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const edge = s.edges.find((e) => e.id === edgeId);
    if (!edge) return err("NOT_FOUND", "no such edge in this snapshot");
    const certs = edge.evidenceIds.map((id) => this.store.db.prepare("select json from c24_relation_certs where id = ?").get(id) as { json: string } | undefined).filter((r): r is { json: string } => !!r).map((r) => JSON.parse(r.json) as RelationCertificateInput);
    const competing = edge.state === "QUARANTINED" ? s.edges.filter((e) => e.state === "QUARANTINED" && e.id !== edge.id && e.limitations.some((l) => /competing/i.test(l))) : [];
    return ok({ edge, certificates: certs, derivationPath: [edge.ruleId], limitations: [...edge.limitations, ...certs.flatMap((c) => c.valid === false ? ["certificate marked invalid"] : [])], quarantinedAlternatives: competing.map((c) => c.id), invalidated: edge.state === "INVALIDATED" });
  }

  checkOrder(snapshotId: string, fromEventId: string, toEventId: string) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const events = this.eventsByIds(s.eventIds, s.scope.tenantId);
    const from = events.find((e) => e.id === fromEventId), to = events.find((e) => e.id === toEventId);
    if (!from || !to) return err("NOT_FOUND", "endpoint events are not part of this snapshot");
    // Concurrency certification (design §6/§7): only a coverage certificate exhaustive for the relevant predicate, applied
    // when both events carry a logical clock in the same domain/epoch. Stamps alone never create the certificate (RC03).
    const covCerts = (this.store.db.prepare("select json from c24_coverage").all() as { json: string }[]).map((r) => JSON.parse(r.json) as CoverageCertificateInput);
    const pairCovered = covCerts.filter((c) => c.exhaustiveForPredicate && from.time.observed !== null && to.time.observed !== null && c.window.from <= Math.min(from.time.observed, to.time.observed) && c.window.to >= Math.max(from.time.observed, to.time.observed));
    const sameDomain = from.time.domain === to.time.domain && from.time.epoch === to.time.epoch;
    const certificate: OrderingCertificate | null = pairCovered.length && sameDomain ? { id: pairCovered[0].id, domain: sameDomain ? from.time.domain : "mixed", epoch: from.time.epoch, coversEventIds: [from.id, to.id], valid: true } : null;
    const orderingEdges = s.edges.filter((e) => e.state === "ACCEPTED" && ORDERING_KINDS.has(e.kind));
    const r = orderRelation(orderingEdges, from.id, to.id, certificate);
    const timeContradictions: string[] = [];
    for (const e of orderingEdges) {
      if (!((e.fromEventId === from.id && e.toEventId === to.id) || (e.fromEventId === to.id && e.toEventId === from.id))) continue;
      const fo = from.time.observed, toc = to.time.observed;
      if (fo !== null && toc !== null) {
        const forward = e.fromEventId === from.id;
        if ((forward && fo > toc) || (!forward && toc > fo)) timeContradictions.push("a trusted ordering relation conflicts with wall-clock times; the relation is retained and the chronology flagged, not repaired (RC01)");
      }
    }
    return ok({ fromEventId: from.id, toEventId: to.id, relation: r.relation, supportingEdgeIds: orderingEdges.filter((e) => (e.fromEventId === from.id && e.toEventId === to.id) || (e.fromEventId === to.id && e.toEventId === from.id)).map((e) => e.id), coverageIds: pairCovered.map((c) => c.id), timeContradictions, limitations: r.limitations });
  }

  criticalPath(snapshotId: string, operationId: string): { ok: true; value: CriticalPathReport } | { ok: false; error: ApiError } {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const events = this.eventsByIds(s.eventIds, s.scope.tenantId).filter((e) => e.operationId === operationId || e.attributes?.op === operationId || e.traceId === operationId);
    if (!events.length) return err("NOT_FOUND", `no events for operation ${operationId}`);
    const unknown = events.filter((e) => e.time.quality === "UNKNOWN" || (e.time.earliest === null && e.time.latest === null && e.time.observed === null));
    if (unknown.length && events.length === unknown.length) return ok(this.unresolvedPathReport(s, operationId, "cross-host time bounds unknown; no precise latency decomposition is claimed (RC10)"));
    const observed = events.map((e) => e.time).filter((t) => t.observed !== null).map((t) => t.observed as number);
    if (!observed.length) return ok(this.unresolvedPathReport(s, operationId, "no usable time observations in the operation window"));
    // Segments: executing work (op spans), waiting time (wait relations on the operation's tasks), downstream waits (send/receive edges).
    const covered: AccountedInterval[] = observed.map((t) => ({ fromMs: t, toMs: t + 1, covered: true }));
    const segments: CriticalPathReport["segments"] = [];
    for (const e of events) if (e.time.observed !== null) {
      const dur = typeof e.attributes?.durationMs === "number" ? Math.max(0, e.attributes.durationMs) : 1;
      segments.push({ eventIds: [e.id], kind: e.kind === "SEND" || e.kind === "ENQUEUE" ? "DOWNSTREAM" : "EXECUTING", lowerDurationMs: e.time.observed, upperDurationMs: (e.time.observed as number) + dur, evidenceIds: [] });
    }
    for (const w of s.waitRelations) {
      const evs = events.filter((e) => e.taskId === w.task && e.time.observed !== null);
      for (const e of evs) { const dur = typeof e.attributes?.durationMs === "number" ? Math.max(0, e.attributes.durationMs) : 1; segments.push({ eventIds: [e.id], kind: "WAITING", lowerDurationMs: e.time.observed as number, upperDurationMs: (e.time.observed as number) + dur, evidenceIds: [w.id] }); }
    }
    // The observation window derives from the declared segments' ends (not just the observed points), so a span
    // extending past the last event is not silently clipped (RC15: union [0,100]∪[10,20]∪[90,100] = 100).
    const segBounds = segments.flatMap((seg) => [seg.lowerDurationMs, seg.upperDurationMs]).filter((v): v is number => typeof v === "number");
    const window = { fromMs: Math.min(...observed), toMs: Math.max(...segBounds, Math.max(...observed)) };
    const a = accountDurations(segments.filter((seg) => seg.lowerDurationMs !== null && seg.upperDurationMs !== null).map((seg) => ({ fromMs: seg.lowerDurationMs as number, toMs: seg.upperDurationMs as number, covered: seg.kind !== "UNEXPLAINED" })), window);
    return ok({ snapshotId: s.id, version: s.version, operationId, segments, observedDurationMs: window.toMs - window.fromMs, coveredDurationMs: a.coveredMs, unresolvedDurationMs: a.unresolvedMs, gateReportId: "gate:c24-critical-path", limitations: ["nested and overlapping durations are unioned, never summed (RC15)", "uncovered time is unexplained, not assigned to a known service (design §9)", ...unknown.map((e) => `event ${e.id} has unusable time bounds`)] });
  }
  private unresolvedPathReport(s: Snapshot, operationId: string, why: string): CriticalPathReport {
    return { snapshotId: s.id, version: s.version, operationId, segments: [], observedDurationMs: null, coveredDurationMs: null, unresolvedDurationMs: null, gateReportId: "gate:c24-critical-path", limitations: [why, ...s.gaps.filter((g) => g.kind === "CLOCK_UNKNOWN" || g.kind === "SAMPLED_REGION").map((g) => g.safeExplanation)] };
  }

  getCoverage(snapshotId: string) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const certs = this.coverageCerts().filter((c) => s.coverageIds.includes(c.id));
    // A non-exhaustive certificate cannot be exhaustive over its own window: the query's under-evidence is a
    // material gap (RC14), phrased as absence-not-exoneration, never as a coverage percentage.
    const certGaps = certs
      .filter((c) => c.exhaustiveForPredicate !== true)
      .map((c) => ({ id: `gap:coverage-unevidenced:${c.id}`, kind: "MISSING_EVENT" as const, adjacentEventIds: [], missingPredicate: `coverage query ${c.predicateSchemaId} over [${c.window.from}, ${c.window.to}] ran without exhaustive evidence`, material: true, safeExplanation: "absence of records is not proof of absence of involvement (RC14)" }));
    return ok({
      snapshotId, version: s.version, certificates: certs, gaps: [...s.gaps, ...certGaps], sampling: [...new Set(certs.map((c) => c.sampling))],
      // Never an invented global coverage percentage (design §12).
      disclosure: ["absence of records is not proof of absence of involvement", ...certs.filter((c) => !c.exhaustiveForPredicate).map((c) => `certificate ${c.id} is not exhaustive for its predicate`), ...(s.timeQuality.unknownEvents ? [`${s.timeQuality.unknownEvents} events carry UNKNOWN time quality`] : [])],
    });
  }
  private coverageCerts(): CoverageCertificateInput[] {
    return (this.store.db.prepare("select json from c24_coverage").all() as { json: string }[]).map((r) => JSON.parse(r.json) as CoverageCertificateInput);
  }

  /** RC12: wait-layer analysis. Cycles among tasks waiting on owned resources are deadlock candidates analyzed with their
   *  escape conditions; they are wait-layer findings and are never quarantined as ordering contradictions. */
  analyzeWaits(snapshotId: string) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const waits = s.waitRelations;
    const edges = new Map<string, string[]>(waits.map((w) => [w.task, w.ownerTaskIds ?? []]));
    const leg = new Map<string, { resource: string; escape: string[] }>(waits.map((w) => [w.task, { resource: w.resource, escape: w.escapeConditions ?? [] }]));
    const cycles: { tasks: string[]; resources: string[]; escapeConditions: string[] }[] = [];
    const seenAt = new Map<string, number>();
    for (const start of edges.keys()) {
      const path: string[] = [];
      const dfs = (t: string): boolean => {
        if (path.includes(t)) {
          let cyc = path.slice(path.indexOf(t));
          // Canonical rotation: the same cycle seen from a different start task is one candidate, not two.
          for (let i = 1; i < cyc.length; i++) if (cyc[i] < cyc[0]) cyc = cyc.slice(i).concat(cyc.slice(0, i));
          const key = "cyc:" + cyc.join(">");
          if (!seenAt.has(key)) { seenAt.set(key, 1);
            cycles.push({ tasks: cyc, resources: cyc.map((x) => leg.get(x)?.resource ?? "?"), escapeConditions: [...new Set(cyc.flatMap((x) => leg.get(x)?.escape ?? []))] });
          }
          return true;
        }
        path.push(t);
        let hit = false;
        for (const o of edges.get(t) ?? []) if (leg.has(o)) hit = dfs(o) || hit;
        path.pop();
        return hit;
      };
      dfs(start);
    }
    return ok({ snapshotId: s.id, version: s.version, cycles, layers: { wait: waits.map((w) => w.id) }, note: "wait cycles are liveness/deadlock findings, never ordering contradictions (design §6)" });
  }

  // ------------------------------------------------------------ mechanism evidence and claims (C22/C26 consumption; C16/C18 gates)
  buildMechanismEvidence(snapshotId: string, symptomEventIds: string[], mechanismKinds?: string[]): { ok: true; value: MechanismEvidenceRecord[] } | { ok: false; error: ApiError } {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    return ok(this.mechanismEvidenceList(s, symptomEventIds, mechanismKinds));
  }
  private mechanismEvidenceList(s: Snapshot, symptomEventIds: string[], kinds?: string[]): MechanismEvidenceRecord[] {
    const wants = (k: string) => !kinds || kinds.includes(k);
    const accepted = s.edges.filter((e) => e.state === "ACCEPTED");
    const gaps = s.gaps.filter((g) => g.material).map((g) => g.id);
    const out: MechanismEvidenceRecord[] = [];
    if (wants("LOCK_WAIT")) {
      for (const w of s.waitRelations) out.push({ id: `mev:${w.id}`, snapshotId: s.id, snapshotVersion: s.version, symptomEventIds, mechanismKind: "LOCK_WAIT", executionEdgeIds: accepted.filter((e) => ["SPAWN", "COMPLETE_JOIN", "PROGRAM_ORDER"].includes(e.kind)).slice(0, 8).map((e) => e.id), waitEdgeIds: [w.id], candidateClaimIds: [], counterEvidenceIds: [], materialGapIds: gaps.slice(0, 6), ownerTasks: w.ownerTaskIds ?? [], escapeConditions: w.escapeConditions ?? [] });
    }
    if (wants("DOWNSTREAM_WAIT")) {
      for (const e of accepted.filter((e) => e.kind === "SEND_RECEIVE" && (!symptomEventIds.length || e.fromEventId === symptomEventIds[0]))) out.push({ id: `mev:${e.id}`, snapshotId: s.id, snapshotVersion: s.version, symptomEventIds, mechanismKind: "DOWNSTREAM_WAIT", executionEdgeIds: [e.id], waitEdgeIds: [], candidateClaimIds: [], counterEvidenceIds: [], materialGapIds: gaps.slice(0, 6), ownerTasks: [], escapeConditions: [] });
    }
    if (wants("QUEUE_DELAY")) {
      const byId = new Map(this.eventsByIds(s.eventIds, s.scope.tenantId).map((e) => [e.id, e]));
      for (const e of accepted.filter((e) => e.kind === "SEND_RECEIVE")) {
        const f = byId.get(e.fromEventId);
        if (f?.kind === "ENQUEUE") out.push({ id: `mev:queue:${e.id}`, snapshotId: s.id, snapshotVersion: s.version, symptomEventIds, mechanismKind: "QUEUE_DELAY", executionEdgeIds: [e.id], waitEdgeIds: [], candidateClaimIds: [], counterEvidenceIds: [], materialGapIds: gaps.slice(0, 6), ownerTasks: [], escapeConditions: ["enqueue, broker residency, dispatch and processing are separate intervals (design §7)"] });
      }
    }
    if (!out.length) out.push({ id: `mev:unknown:${sha(s.id + symptomEventIds.join(","))}`.slice(0, 64), snapshotId: s.id, snapshotVersion: s.version, symptomEventIds, mechanismKind: "UNKNOWN", executionEdgeIds: [], waitEdgeIds: [], candidateClaimIds: [], counterEvidenceIds: [], materialGapIds: gaps, ownerTasks: [], escapeConditions: [] });
    return out;
  }

  proposeCausalClaim(snapshotId: string, req: { assertion: string; level: CauseClaimRecord["level"]; mechanismEvidenceId?: string; edgeId?: string; workload?: string }) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    let evidenceIds: string[] = [];
    if (req.level === "EXECUTION_RELATION") {
      const edge = s.edges.find((e) => e.id === req.edgeId && e.state === "ACCEPTED" && ORDERING_KINDS.has(e.kind));
      if (!edge) return err("FORBIDDEN", "an execution-relation claim needs an accepted execution-order edge");
      evidenceIds = edge.evidenceIds;
    } else if (req.level === "MECHANISM_CANDIDATE") {
      const mev = this.mechanismById(s, req.mechanismEvidenceId);
      if (!mev) return err("FORBIDDEN", "a mechanism candidate needs assembled mechanism evidence (buildMechanismEvidence)");
      evidenceIds = [...mev.executionEdgeIds, ...mev.waitEdgeIds, ...mev.symptomEventIds];
    } else if (req.level === "MECHANISM_SUPPORTED") {
      const mev = this.mechanismById(s, req.mechanismEvidenceId);
      // The corrected baseline rule: execution evidence alone never supports a mechanism; support needs ownership/wait evidence.
      if (!mev) return err("FORBIDDEN", "mechanism support needs assembled mechanism evidence");
      if (mev.mechanismKind === "UNKNOWN" || !mev.waitEdgeIds.length) return err("FORBIDDEN", "execution evidence alone never supports a mechanism; support needs owner/wait evidence (RC26/RC27 discipline)");
      evidenceIds = [...mev.waitEdgeIds, ...mev.executionEdgeIds, ...mev.symptomEventIds];
    } else if (req.level === "INTERVENTION_SUPPORTED") {
      return err("FORBIDDEN", "intervention support enters only through linkInterventionEvidence with a scoped C27 report (RC27/RC28)");
    }
    const record: CauseClaimRecord = {
      claimId: "c24claim:" + sha(s.id + "|" + req.level + "|" + req.assertion + "|" + evidenceIds.join(".")),
      snapshotId: s.id, snapshotVersion: s.version, level: req.level, state: "CURRENT", limitations: [],
      populationScope: { revisionSet: s.scope.revisionSet, workload: req.workload },
    };
    this.store.db.prepare("insert or replace into c24_derivations values (?,?,1,'claim',?)").run(req.assertion, record.claimId, JSON.stringify(record));
    if (req.level === "EXECUTION_RELATION" && req.edgeId) {
      // The claim-edge derivation key is the EDGE id: corrections propagate event → edge → claim (RC17).
      this.store.db.prepare("insert or replace into c24_derivations values (?,?,1,'claim-edge',?)").run(req.edgeId, record.claimId, "{}");
    }
    for (const evidenceId of evidenceIds) if (["ed:", "ev:", "e:", "wr:"].some((p) => evidenceId.startsWith(p))) {
      // Distinguish claim-source edges (for correction propagation) from mere reference ids (RC17).
      if (evidenceId.startsWith("ed:") || evidenceId.startsWith("wr:")) this.store.db.prepare("insert or replace into c24_derivations values (?,?,1,'claim-edge',?)").run(evidenceId, record.claimId, "{}");
    }
    return ok(record);
  }
  private mechanismById(s: Snapshot, id?: string): MechanismEvidenceRecord | null {
    if (!id) return null;
    for (const mev of this.mechanismEvidenceList(s, [], undefined)) if (mev.id === id) return mev;
    return this.cachedMechanisms.get(id) ?? null;
  }
  private cachedMechanisms = new Map<string, MechanismEvidenceRecord>();

  /** Cache for claim-level lookups when the caller built evidence in the same flow (buildMechanismEvidence → propose). */
  keepMechanisms(records: MechanismEvidenceRecord[]) { for (const m of records) this.cachedMechanisms.set(m.id, m); return this.cachedMechanisms.size; }

  claimRef(claimId: string): CauseClaimRecord | null {
    const r = this.store.db.prepare("select json from c24_derivations where derived = ? and kind = 'claim' order by rowid desc limit 1").get(claimId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as CauseClaimRecord : null;
  }

  linkInterventionEvidence(req: { claimId: string; expectedClaimVersion: number; experimentReport: { reportId: string; design: "PAIRED" | "RANDOMIZED_INTERLEAVED" | "BEFORE_AFTER_RELEASE"; workload: string; revision: string; sharedDependencies?: string[]; spillover?: string }; targetScope: { revisionSet: string[]; workload: string } }) {
    const claim = this.claimRef(req.claimId);
    if (!claim) return err("NOT_FOUND", "no such claim");
    if (req.expectedClaimVersion !== 1) return err("VERSION_CONFLICT", `the claim reference is at version ${req.expectedClaimVersion === 0 ? 1 : req.expectedClaimVersion === 1 ? 1 : 1}; this gate rejects stale edits`, true);
    // RC28: a confounded before/after comparison remains observational; it cannot back an intervention claim.
    if (req.experimentReport.design === "BEFORE_AFTER_RELEASE") return err("FORBIDDEN", "a confounded before/after deployment comparison stays observational and cannot promote a claim (RC28)");
    // RC27: the experiment's workload/revision must match the claimed scope exactly.
    if (!req.targetScope.revisionSet.includes(req.experimentReport.revision) || req.targetScope.workload !== req.experimentReport.workload) return err("FORBIDDEN", `the experiment ran ${req.experimentReport.workload} on ${req.experimentReport.revision}, which does not match the claimed scope (${req.targetScope.workload} on [${req.targetScope.revisionSet.join(", ")}]) (RC27)`);
    this.store.db.prepare("insert or replace into c24_experiment_reports values (?,?,?)").run(req.experimentReport.reportId, 1, JSON.stringify(req.experimentReport));
    const shared = req.experimentReport.sharedDependencies ?? [];
    const limitations = [
      ...(shared.length ? [`shared dependencies limit request-level independence: ${shared.join(", ")}; whole-instance/block allocation or washout policy must be stated (RC19)`] : []),
      req.experimentReport.spillover ?? "spillover scope not measured; the claim applies to the tested population only (RC19)",
    ];
    const updated: CauseClaimRecord = { ...claim, level: "INTERVENTION_SUPPORTED", state: "CURRENT", limitations };
    this.store.db.prepare("insert or replace into c24_derivations values (?,?,1,'claim',?)").run("intervention:" + req.experimentReport.reportId, claim.claimId, JSON.stringify(updated));
    return ok(updated);
  }

  // ------------------------------------------------------------ corrections, revocation, freshness (RC17/RC23/RC24)
  applyCorrection(req: { correctedEvent: RuntimeEventInput; supersedesEventId: string }) {
    return this.store.tx(() => {
      const db = this.store.db;
      const original = this.eventById2(req.supersedesEventId);
      if (!original) return err("NOT_FOUND", "no such event to correct");
      const n = normalizeEvent({ ...req.correctedEvent, correctionOfEventId: req.supersedesEventId }, this.registered(req.correctedEvent.sourceId)?.trusted === true, { tenantId: original.tenantId, now: this.now() });
      const existing = db.prepare("select version from c24_event_refs where id = ? and source_epoch = ?").get(req.correctedEvent.id, n.sourceEpoch) as { version: number } | undefined;
      const version = (existing?.version ?? 0) + 1;
      db.prepare("insert or replace into c24_event_refs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(n.id, version, n.tenantId, n.sourceId, n.sourceEpoch, n.dedupHash, n.kind, n.time.domain, n.time.epoch, n.traceId ?? null, n.operationId ?? null, n.attemptId ?? null, n.time.observed ?? null, JSON.stringify(n));
      // Atomic with the correction: dependent edges invalidated, dependent claims marked stale (RC17).
      const deps = (db.prepare("select derived from c24_derivations where source_key = ? and kind = 'edge'").all(req.supersedesEventId) as any[]).map((r) => r.derived as string);
      const invalidated: string[] = []; const claimsStale: string[] = [];
      for (const edgeId of deps) {
        const row = db.prepare("select json from c24_edge_versions where id = ? order by version desc limit 1").get(edgeId) as { json: string } | undefined;
        if (!row) continue;
        const rec = JSON.parse(row.json) as EdgeRecord;
        db.prepare("insert or replace into c24_edge_versions values (?,?,?,?,?,?,?,?,?)").run(rec.id, rec.version + 1, rec.scopeHash, rec.fromEventId, rec.toEventId, rec.kind, rec.layer, "INVALIDATED", JSON.stringify({ ...rec, version: rec.version + 1, state: "INVALIDATED", limitations: [...rec.limitations, "source event corrected; derived relation invalidated before any refresh (RC17)"] }));
        invalidated.push(rec.id);
        // Propagation chain: event → invalidated edge → claims derived from that edge (claim-edge keys are edge ids).
        for (const claimId of (db.prepare("select derived from c24_derivations where source_key = ? and kind = 'claim-edge'").all(edgeId) as any[]).map((r) => r.derived as string)) {
          const crow = db.prepare("select json from c24_derivations where derived = ? and kind = 'claim' order by rowid desc limit 1").get(claimId) as { json: string } | undefined;
          if (crow) {
            const c = JSON.parse(crow.json) as CauseClaimRecord;
            db.prepare("insert or replace into c24_derivations values (?,?,1,'claim',?)").run(claimId + ":stale", c.claimId, JSON.stringify({ ...c, state: "STALE", limitations: [...c.limitations, "an underlying source event was corrected; the claim is stale until re-derived from a refreshed snapshot (RC17)"] }));
            claimsStale.push(claimId);
          }
        }
      }
      db.prepare("insert or replace into c24_derivations values (?,?,?,'invalidated','{}')").run(req.supersedesEventId, n.id + ":v" + version, version);
      return ok({ receipt: { corrected: n.id, version, invalidatedEdges: invalidated, claimsStale, atomic: true } });
    });
  }

  invalidateSource(sourceId: string, req: { reason: string }) {
    return this.store.tx(() => {
      const db = this.store.db;
      const ids = (db.prepare("select id from c24_event_refs where source = ?").all(sourceId) as any[]).map((r) => r.id as string);
      const idSet = new Set(ids);
      const edges = (db.prepare("select json from c24_edge_versions").all() as { json: string }[]).map((r) => JSON.parse(r.json) as EdgeRecord);
      const invalidated: string[] = [];
      for (const e of edges) {
        if (e.state === "INVALIDATED") continue;
        const touch = e.evidenceIds.some((id) => idSet.has(id));
        if (!touch) continue;
        db.prepare("insert or replace into c24_edge_versions values (?,?,?,?,?,?,?,?,?)").run(e.id, e.version + 1, e.scopeHash, e.fromEventId, e.toEventId, e.kind, e.layer, "INVALIDATED", JSON.stringify({ ...e, version: e.version + 1, state: "INVALIDATED", limitations: [...e.limitations, `source ${sourceId} revoked: ${req.reason}`] }));
        invalidated.push(e.id);
      }
      db.prepare("update c24_runtime_sources set revoked = 1 where id = ?").run(sourceId);
      return ok({ receipt: { sourceId, revoked: true, reason: req.reason, affectedEvents: ids.length, invalidatedEdges: invalidated, // Raw volumes only ever lived in the external backend (design §15): nothing historic can be reconstructed locally.
        noHistoricPayloadRecovery: true } });
    });
  }

  readUpdates(snapshotId: string, afterSequence: number, limit = 100) {
    const rows = (this.store.db.prepare("select seq, event, json from c24_updates where snapshot_id = ? and seq > ? order by seq limit ?").all(snapshotId, afterSequence, limit) as any[]);
    const max = Number((this.store.db.prepare("select coalesce(max(seq),0) as m from c24_updates where snapshot_id = ?").get(snapshotId) as any).m);
    return ok({ snapshotId, updates: rows, nextSequence: rows.length ? rows[rows.length - 1].seq : afterSequence, replayRequired: rows.length === 0 && afterSequence < max });
  }

  /** RC25: evidence/timeline playback. The label is playback; executable replay is a C27 adapter concern, never implied. */
  replayPlayback(snapshotId: string, cursorMs: number) {
    const s = this.snapshot(snapshotId);
    if (!s) return err("NOT_FOUND", "no such snapshot");
    const events = this.eventsByIds(s.eventIds, s.scope.tenantId).filter((e) => e.time.observed !== null && (e.time.observed as number) <= cursorMs);
    return ok({ label: "PLAYBACK", kind: "evidence-playback", snapshotId, version: s.version, cursorMs, events, noExecutableReplayPromise: true });
  }

  // ------------------------------------------------------------ attribution v2 (§8)
  registerArtifact(artifact: { id: string; revision: string; mappings: { file: string; line?: number; fn?: string; entityId: string }[]; sourceMapVersion?: string }) {
    this.store.db.prepare("insert or replace into c24_artifacts values (?,?,?,?)").run(artifact.id, 1, artifact.revision, JSON.stringify(artifact));
    return { artifactId: artifact.id, revision: artifact.revision, mappings: artifact.mappings.length };
  }

  resolveAttribution(eventId: string, revisionSet: string[]) {
    const e = this.eventById2(eventId);
    if (!e) return err("NOT_FOUND", "no such event");
    return ok(this.resolveAttributionOf(e, { tenantId: e.tenantId, revisionSet, incidentWindow: { from: 0, to: Number.MAX_SAFE_INTEGER } }));
  }

  private resolveAttributionOf(e: NormalizedEvent, scope: CausalityScopeInput): AttributionRecord {
    if (e.trust === "UNTRUSTED_CONTEXT") return { eventId: e.id, revision: null, exact: false, entityId: null, method: "UNATTRIBUTED", reasons: ["untrusted context is not attributed to code (RC20)"] };
    const marker = this.store.db.prepare("select revision from rt_markers where source = ? and deployment = ?").get(e.sourceId, e.deploymentId ?? "") as { revision: string } | undefined;
    const claimed = typeof e.attributes?.revision === "string" ? e.attributes.revision : null;
    const ranRevision = marker?.revision ?? claimed ?? null;
    if (!ranRevision) return { eventId: e.id, revision: null, exact: false, entityId: null, method: "UNATTRIBUTED", reasons: ["no deployment marker and no build identity on the event; which code ran is not known (RC09)"] };
    const reasons: string[] = [];
    if (marker && claimed && marker.revision !== claimed) reasons.push(`the marker says ${marker.revision}; the event's own claim is noted but the marker is authoritative`);
    const build = typeof e.attributes?.build === "string" ? e.attributes.build : (e.buildId ?? null);
    const artifacts = (this.store.db.prepare("select json from c24_artifacts where revision = ?").all(ranRevision) as { json: string }[]).map((r) => JSON.parse(r.json) as { id: string; revision: string; mappings: { file: string; line?: number; fn?: string; entityId: string }[] });
    const artifact = artifacts.find((a) => a && (!build || a.id === build));
    const file = typeof e.attributes?.file === "string" ? e.attributes.file : null;
    const fn = typeof e.attributes?.fn === "string" ? e.attributes.fn : null;
    if (artifact && file) {
      const line = typeof e.attributes?.line === "number" ? e.attributes.line : undefined;
      const candidates = artifact.mappings.filter((m) => m.file === file && (m.line === undefined || line === undefined || m.line === line));
      if (candidates.length === 1) return { eventId: e.id, revision: ranRevision, exact: true, entityId: candidates[0].entityId, method: "ARTIFACT_EXACT", reasons: [...reasons, scope.revisionSet.length && !scope.revisionSet.includes(ranRevision) ? `attribution targets ${ranRevision} inside the deployment revision set, not the analyzed revision (rolling deployments, RC09)` : "the artifact's source map exactness is used as-is"] };
      if (candidates.length > 1) return { eventId: e.id, revision: ranRevision, exact: false, entityId: candidates[0].entityId, method: "CANDIDATE", reasons: [...reasons, `inlined/optimized frames map to ${candidates.length} source locations; alternatives retained`] };
    }
    if (fn && ranRevision) {
      const names = this.store.entities(ranRevision).filter((x) => x.name === fn || x.name.split(".").pop() === fn).map((x) => x.entityId);
      if (names.length === 1) return { eventId: e.id, revision: ranRevision, exact: false, entityId: names[0], method: "CANDIDATE", reasons: [...reasons, "a function-name match is a candidate, never exact (design §8)"] };
    }
    return { eventId: e.id, revision: ranRevision, exact: false, entityId: null, method: "UNATTRIBUTED", reasons: [...reasons, "no artifact mapping ties this event to code; it stays fog"] };
  }

  private eventById2(eventId: string): NormalizedEvent | null {
    const r = this.store.db.prepare("select json from c24_event_refs where id = ? limit 1").get(eventId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as NormalizedEvent : null;
  }

  private eventsInScope(scope: CausalityScopeInput, opts: { limit: number }): { rows: NormalizedEvent[]; truncated: boolean; revokedSources: string[] } {
    const revokedSources: string[] = (this.store.db.prepare("select id from c24_runtime_sources where revoked = 1").all() as { id: string }[]).map((r) => r.id);
    const rows: NormalizedEvent[] = [];
    let truncated = false;
    for (const r of this.store.db.prepare("select json from c24_event_refs where tenant = ? order by id").all(scope.tenantId) as { json: string }[]) {
      const e = JSON.parse(r.json) as NormalizedEvent;
      if (e.trust === "UNTRUSTED_CONTEXT") continue;
      if (revokedSources.includes(e.sourceId)) continue;
      const inWindow = e.time.observed === null || (e.time.observed >= scope.incidentWindow.from - LIMITS.latenessMs && e.time.observed <= scope.incidentWindow.to + LIMITS.latenessMs);
      if (!inWindow) continue;
      if (rows.length >= opts.limit) { truncated = true; break; }
      rows.push(e);
    }
    return { rows, truncated, revokedSources };
  }

  private eventsByIds(ids: string[], tenantId: string): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const id of ids) {
      const r = this.store.db.prepare("select json from c24_event_refs where id = ? and tenant = ? order by version desc limit 1").get(id, tenantId) as { json: string } | undefined;
      if (r) out.push(JSON.parse(r.json) as NormalizedEvent);
    }
    return out;
  }
}

function eventsIdsTouchTraces(edge: EdgeRecord, events: NormalizedEvent[], traces: Set<string>): boolean {
  return [edge.fromEventId, edge.toEventId].some((id) => { const e = events.find((x) => x.id === id); return e?.traceId && traces.has(e.traceId); });
}