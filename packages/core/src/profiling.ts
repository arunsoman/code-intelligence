// F05 — Trace-linked continuous profiling (Node-side orchestration).
//
// The worker does the parse/aggregate math; this module stores artifacts, manages
// populations, and exposes the public ApiResult operations.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CallContext,
  ApiResult,
  IngestProfileResponse,
  ProfileCorrelation,
  HotspotResult,
  FlameTreeResult,
  CompareProfilesResult,
  ProfileDiagnostic,
  SampleKind,
} from "@cie/schema";
import type { WorkerClient } from "./worker.ts";

export interface ProfileFileRef { path: string; serviceHint?: string; buildHint?: { buildId?: string; revision?: string } }
export interface TraceWindowRef { service: string; instance?: string; fromNs: number; toNs: number; revision?: string; traceId?: string; spanId?: string; endpoint?: string }
export interface PopulationRef { service?: string; fromNs?: number; toNs?: number; revision?: string; sampleTypeKind?: SampleKind; ordinal?: number }

export interface IngestProfileInput { source: ProfileFileRef }
export interface QueryHotspotsInput { artifactHash?: string; path: string; ordinal?: number; order?: "SELF" | "TOTAL"; limit?: number; serviceHint?: string }
export interface BuildFlamegraphInput { artifactHash?: string; path: string; ordinal?: number; serviceHint?: string }
export interface CorrelateProfileInput { profileArtifactHash: string; path: string; trace: TraceWindowRef; buildHint?: { buildId?: string; revision?: string } }
export interface CompareProfilesInput { baselinePath: string; candidatePath: string; baseline: PopulationRef; candidate: PopulationRef; baselineTrace?: TraceWindowRef; candidateTrace?: TraceWindowRef; declareEquivalent?: { reason: string }; serviceHint?: string }

function snakeDiagnostics(d: unknown): ProfileDiagnostic[] {
  if (!Array.isArray(d)) return [];
  return d.map((x: any) => ({ code: String(x?.code ?? ""), message: String(x?.message ?? "") }));
}

function droppedFromWorker(v: unknown): number | "NOT_REPORTED" {
  if (v === null || v === undefined || v === "NOT_REPORTED") return "NOT_REPORTED";
  if (typeof v === "number") return v;
  return "NOT_REPORTED";
}

function kindFromWorker(v: string): SampleKind {
  switch (v) {
    case "CPU": return "CPU";
    case "WALL": return "WALL";
    case "ALLOC_SPACE": return "ALLOC_SPACE";
    case "ALLOC_OBJECTS": return "ALLOC_OBJECTS";
    case "INUSE_SPACE": return "INUSE_SPACE";
    case "INUSE_OBJECTS": return "INUSE_OBJECTS";
    case "LOCK_CONTENTION": return "LOCK_CONTENTION";
    default: return "OTHER";
  }
}

function adaptIngest(raw: any): IngestProfileResponse {
  return {
    artifactHash: String(raw?.artifact_hash ?? ""),
    format: String(raw?.format ?? ""),
    sampleTypes: (raw?.sampleTypes ?? []).map((st: any) => ({
      ordinal: Number(st?.ordinal ?? 0),
      kind: kindFromWorker(String(st?.kind ?? "OTHER")),
      unit: String(st?.unit ?? ""),
      rawType: String(st?.rawType ?? ""),
      rawUnit: String(st?.rawUnit ?? ""),
    })),
    periodNs: raw?.periodNs == null ? undefined : Number(raw.periodNs),
    mappings: (raw?.mappings ?? []).map((m: any) => ({
      mappingId: Number(m?.mappingId ?? 0),
      buildId: m?.buildId,
      file: m?.file,
      hasFunctions: Boolean(m?.hasFunctions),
      hasFilenames: Boolean(m?.hasFilenames),
      hasLineNumbers: Boolean(m?.hasLineNumbers),
      hasInlineFrames: Boolean(m?.hasInlineFrames),
      revision: m?.revision,
      revisionState: String(m?.revisionState ?? "UNKNOWN") as any,
    })),
    diagnostics: snakeDiagnostics(raw?.diagnostics),
    droppedSamples: droppedFromWorker(raw?.droppedSamples),
  };
}

const meta = (ctx: CallContext, o: Partial<{ revision: string; resourceVersion: number; completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; warnings: string[] }> = {}) =>
  ({ requestId: ctx.requestId, completeness: "COMPLETE" as const, warnings: [] as string[], ...o });
const ok = <T>(ctx: CallContext, value: T, m?: Parameters<typeof meta>[1]): ApiResult<T> => ({ ok: true, value, metadata: meta(ctx, m) });
const fail = <T>(ctx: CallContext, code: any, message: string): ApiResult<T> => ({ ok: false, error: { code, message, retryable: false }, metadata: meta(ctx) });

export class Profiling {
  private worker: WorkerClient;
  private store: unknown;
  constructor(worker: WorkerClient, store: unknown) {
    this.worker = worker;
    this.store = store;
  }

  async ingestProfile(ctx: CallContext, input: IngestProfileInput): Promise<ApiResult<IngestProfileResponse>> {
    const ref = input.source;
    if (!existsSync(ref.path)) return fail(ctx, "NOT_FOUND", `profile not found: ${ref.path}`);
    const res = await this.worker.request({
      op: "ingestProfile",
      id: ctx.requestId,
      params: { path: ref.path, serviceHint: ref.serviceHint },
    });
    if (!res.ok) return { ok: false, error: res.error ?? { code: "STORAGE_FAILURE", message: "worker returned error with no details", retryable: false }, metadata: meta(ctx) };
    const adapted = adaptIngest(res.result);
    return ok(ctx, adapted);
  }

  async queryHotspots(ctx: CallContext, input: QueryHotspotsInput): Promise<ApiResult<HotspotResult>> {
    if (!existsSync(input.path)) return fail(ctx, "NOT_FOUND", `profile not found: ${input.path}`);
    const res = await this.worker.request({
      op: "queryHotspots",
      id: ctx.requestId,
      params: { path: input.path, ordinal: input.ordinal ?? 0, order: input.order ?? "SELF", limit: input.limit ?? 50, serviceHint: input.serviceHint },
    });
    if (!res.ok) return { ok: false, error: res.error ?? { code: "STORAGE_FAILURE", message: "worker returned error with no details", retryable: false }, metadata: meta(ctx) };
    return ok(ctx, res.result as HotspotResult);
  }

  async buildFlamegraph(ctx: CallContext, input: BuildFlamegraphInput): Promise<ApiResult<FlameTreeResult>> {
    if (!existsSync(input.path)) return fail(ctx, "NOT_FOUND", `profile not found: ${input.path}`);
    const res = await this.worker.request({
      op: "buildFlamegraph",
      id: ctx.requestId,
      params: { path: input.path, ordinal: input.ordinal ?? 0, serviceHint: input.serviceHint },
    });
    if (!res.ok) return { ok: false, error: res.error ?? { code: "STORAGE_FAILURE", message: "worker returned error with no details", retryable: false }, metadata: meta(ctx) };
    return ok(ctx, res.result as FlameTreeResult);
  }

  async correlateProfile(ctx: CallContext, input: CorrelateProfileInput): Promise<ApiResult<ProfileCorrelation>> {
    if (!existsSync(input.path)) return fail(ctx, "NOT_FOUND", `profile not found: ${input.path}`);
    const res = await this.worker.request({
      op: "correlateProfile",
      id: ctx.requestId,
      params: {
        path: input.path,
        serviceHint: input.trace.service,
        buildId: input.buildHint?.buildId,
        revision: input.buildHint?.revision,
        service: input.trace.service,
        instance: input.trace.instance,
        fromNs: input.trace.fromNs,
        toNs: input.trace.toNs,
        traceId: input.trace.traceId,
        spanId: input.trace.spanId,
        endpoint: input.trace.endpoint,
      },
    });
    if (!res.ok) return { ok: false, error: res.error ?? { code: "STORAGE_FAILURE", message: "worker returned error with no details", retryable: false }, metadata: meta(ctx) };
    const raw = res.result as any;
    const corr: ProfileCorrelation = {
      correlationId: String(raw.correlationId),
      links: (raw.links ?? []).map((l: any) => ({
        traceId: l.traceId,
        spanId: l.spanId,
        grade: String(l.grade) as any,
        overlapMs: l.overlapMs,
        reason: String(l.reason),
      })),
      build: {
        buildId: raw.build?.buildId,
        revision: raw.build?.revision,
        state: String(raw.build?.state) as any,
        evidenceIds: raw.build?.evidenceIds ?? [],
      },
      populationHash: String(raw.populationHash),
    };
    return ok(ctx, corr);
  }

  async compareProfiles(ctx: CallContext, input: CompareProfilesInput): Promise<ApiResult<CompareProfilesResult>> {
    if (!existsSync(input.baselinePath)) return fail(ctx, "NOT_FOUND", `baseline profile not found: ${input.baselinePath}`);
    if (!existsSync(input.candidatePath)) return fail(ctx, "NOT_FOUND", `candidate profile not found: ${input.candidatePath}`);
    const res = await this.worker.request({
      op: "compareProfiles",
      id: ctx.requestId,
      params: {
        baselinePath: input.baselinePath,
        candidatePath: input.candidatePath,
        serviceHint: input.serviceHint,
        baseline: input.baseline,
        candidate: input.candidate,
        baselineTrace: input.baselineTrace,
        candidateTrace: input.candidateTrace,
        declareEquivalent: input.declareEquivalent,
      },
    });
    if (!res.ok) return { ok: false, error: res.error ?? { code: "STORAGE_FAILURE", message: "worker returned error with no details", retryable: false }, metadata: meta(ctx) };
    return ok(ctx, res.result as CompareProfilesResult);
  }
}
