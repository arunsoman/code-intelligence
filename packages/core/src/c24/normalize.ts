// C24 causality phase-1: event normalization, scoped identity and dedup (design §5–§6). Adapter records arrive in
// their source shape; anything that does not carry the required identity is normalized into what it honestly is — an
// untrusted-context record that takes no part in topology — never silently merged into a trusted stream.
import { createHash } from "node:crypto";
import type { EdgeKind, EventKind, SamplingState, TimeQuality } from "@cie/schema";

export interface EventTimeInput { observed?: number | null; earliest?: number | null; latest?: number | null; domain?: string; epoch?: string; quality?: TimeQuality }
export interface RuntimeEventInput {
  id: string; kind: EventKind; tenantId: string; sourceId: string; sourceEpoch: string;
  sourceSequence?: string | null; processEpoch?: string | null; taskId?: string | null; attemptId?: string | null;
  operationId?: string | null; traceId?: string | null; spanId?: string | null;
  time?: EventTimeInput; deploymentId?: string | null; buildId?: string | null;
  attributes?: Record<string, string | number | boolean | null | string[]> | null; sampling?: SamplingState; droppedEventCount?: number | null;
  correctionOfEventId?: string | null;
  /** Span parenting from trace context: a lookup key only. When this parent is unknown to the accepted stream, that is a gap, never an invented root (RC04/RC24). */
  parentSpanId?: string | null;
}

export interface NormalizedEvent extends RuntimeEventInput {
  trust: "AUTHENTICATED_ADAPTER" | "IMPORTED_UNVERIFIED" | "UNTRUSTED_CONTEXT";
  dedupHash: string;
  time: { observed: number | null; earliest: number | null; latest: number | null; domain: string; epoch: string; quality: TimeQuality };
  ingestionTime: number;
  problems: string[];
}

export const MAX_ATTRIBUTES = 32;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/**
 * Normalize one incoming record. Identity (design §6) is tenant + source namespace + process/collector epoch +
 * source sequence/record id: those are all required for a record to join the trusted stream. Trace ids are lookup
 * keys, never identity or authorization. `authenticatedSource` says whether a registered adapter covers this source;
 * a record whose own attributes claim another tenant is rejected to untrusted context (RC20).
 */
export function normalizeEvent(input: RuntimeEventInput, authenticatedSource: boolean, opts: { tenantId: string; now: number }): NormalizedEvent {
  const problems: string[] = [];
  const claimedTenant = typeof input.attributes?.claimedTenant === "string" ? input.attributes.claimedTenant : null;
  const forged = claimedTenant !== null && claimedTenant !== opts.tenantId;
  const malformed = !input.id || !input.kind || !input.sourceId || !input.sourceEpoch;
  let trust: NormalizedEvent["trust"];
  if (malformed || forged || !authenticatedSource) {
    trust = "UNTRUSTED_CONTEXT";
    if (malformed) problems.push("missing identity fields (id/kind/sourceId/sourceEpoch)");
    if (forged) problems.push(`attributes claim tenant ${claimedTenant}, which does not match the authorized tenant`);
    if (!authenticatedSource) problems.push("no authenticated adapter covers this source; the record stays untrusted context");
  } else trust = "AUTHENTICATED_ADAPTER";
  const attrs = input.attributes && Object.keys(input.attributes).length > MAX_ATTRIBUTES
    ? Object.fromEntries(Object.entries(input.attributes).slice(0, MAX_ATTRIBUTES))
    : input.attributes ?? null;
  if (input.attributes && attrs !== input.attributes) problems.push(`more than ${MAX_ATTRIBUTES} attribute keys; the rest are not persisted`);
  const t = input.time ?? {};
  const quality: TimeQuality = t.quality
    ?? (t.observed !== undefined && t.observed !== null ? "BOUNDED" : "UNKNOWN");
  const time = { observed: t.observed ?? null, earliest: t.earliest ?? null, latest: t.latest ?? null, domain: t.domain ?? "wall", epoch: t.epoch ?? "1", quality };
  if (quality === "UNKNOWN" && !problems.some((p) => /time/.test(p))) problems.push("no clock quality declared; cross-host time comparison stays UNKNOWN");
  return {
    ...input, tenantId: opts.tenantId, trust, dedupHash: sha(JSON.stringify([input.id, input.sourceId, input.sourceEpoch, input.kind, time, attrs ?? {}, input.taskId ?? null, input.attemptId ?? null, input.processEpoch ?? null])),
    time: { ...time },
    ingestionTime: opts.now, problems,
  };
}

/** Identity match for send/receive pairing (design §6): message identity + tenant + broker namespace; attempts stay separate. */
export function deliveryKey(e: NormalizedEvent): string | null {
  const msg = typeof e.attributes?.messageId === "string" ? e.attributes.messageId : null;
  if (!msg) return null;
  return `${e.tenantId}|${e.sourceId}|${msg}`;
}