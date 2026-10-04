// F05: trace-linked continuous profiling — the storage-bound analysis engine.
// The Rust worker parses profile files (pprof, V8 .cpuprofile, folded stacks — sniffed by magic) and aggregates them;
// this module persists those aggregates (never raw samples — §6.3), resolves profiles to revisions and code entities
// (the attribution ladder of §7.2), correlates profiles with traces at stated grades (§7.3), ranks hotspots with
// disclosed coverage (§7.4) and compares populations (§7.6).
// Honesty rules carried from the spec:
//   F05-A2  a build that does not match the viewed revision never claims a precise source line;
//   F05-A3  different metric kinds (CPU / WALL / allocation) are never summed, averaged or drawn on one axis;
//   F05-A4  dropped or missing samples are disclosed and never become zero ("not reported" is not zero);
//   F05-A6  a candidate cannot look faster because failed requests left the comparison.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  CompareProfilesResult, CorrelationGrade, CorrelationLink, DeltaRow, FlameTreeResult, HotspotResult, HotspotRow,
  ProfileCoverage, ProfileCorrelation, ProfileDiagnostic, ProfileMappingView, ProfilePopulation, ProfileUncertainty,
  SampleKind, SampleTypeView,
} from "@cie/schema";
import { policyFor } from "./access.ts";
import { computeExclusiveCosts, type TimedSpan } from "./defect-performance.ts";
import { observation } from "./forms/common.ts";
import { LIMITS as RT_LIMITS } from "./runtime.ts";
import type { ApiError } from "@cie/schema";
import type { RevisionRow, Store } from "./store.ts";
import { locateFrames, matchFrameFile, normalizeFramePath } from "./trace.ts";
import { metricItem, manifestHash, TemplateRegistry, builtinTemplates, verifyMetricPresentation, type MetricItem, type VerificationContext } from "./profiles-present.ts";
import type { ProfileFlamegraphResultRpc, ProfileHotspotResultRpc, WorkerClient } from "./worker.ts";

/** Bounds for everything this engine produces; mirrors the worker's parse caps (spec §13). */
export const PROFILE_LIMITS = {
  maxProfileBytes: 64 * 1024 * 1024,   // the same cap the worker enforces before parsing (zip-bomb guard)
  maxAggRows: 5_000,                   // persisted function aggregates per (artifact, sample type)
  hotspotsPageSize: 50,                // keyset-paged hotspot rows per answer
  minSamplesForRanking: 100,           // below this, rankings are shown but flagged "too few samples to rank"
  collectionRatioFloor: 0.9,           // below this the report says not everything expected was collected
  errorRateAbsolute: 0.01,             // candidate error rate may differ by at most one percentage point …
  errorRateRelative: 2.0,              // … or more than double — an improvement is not reportable (F05-A6)
  populationWindowMaxMs: 365 * 24 * 3600 * 1_000,
  mismatchShareTolerance: 0.1,        // a bound revision is MISMATCH when >10% of located sample value fails to verify (F05-A2)
  maxEndpoints: 25,                    // endpoint rows in one answer
  maxDeltaRows: 200,                   // compare rows in one answer (largest absolute delta first)
};

export class ProfileCheckError extends Error {
  readonly api: ApiError;
  constructor(code: ApiError["code"], message: string, retryable = false) {
    super(message);
    this.name = "ProfileCheckError";
    this.api = { code, message, retryable };
  }
}

const hashId = (kind: string, parts: unknown[]) => `${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
/** A non-negative finite float. Values that are not are refused at the door. */
const fin = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
const optNs = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

export type IngestState = "PARSED" | "AGGREGATED" | "LINKED" | "PARTIAL";
type ProfileViewSpecT = import("@cie/schema").ProfileViewSpec;

export interface ProfileIngestView {
  artifactHash: string; format: string; ingestState: IngestState;
  service: string | null; instance: string | null; runtimeName: string | null;
  startNs: number; endNs: number; periodNs: number | null; samplingRateHz: number | null;
  droppedSamples: number | "NOT_REPORTED"; truncated: number; labelsDropped: number;
  sampleTypes: SampleTypeView[]; mappings: ProfileMappingView[];
  revision: string | null; buildState: "MATCHED" | "MISMATCH" | "UNKNOWN";
  diagnostics: ProfileDiagnostic[]; bytes: number;
}

export interface EndpointStat { endpoint: string; count: number; errorCount: number; p50Ms: number | null; p95Ms: number | null }

type Row = Record<string, any>;

/**
 * The whole profile engine over one store. Traces arrive through the existing envelope path (`Runtime.ingest`); the
 * source id a trace is ingested under doubles as the *service* name profiles are labelled with, and the deployment
 * marker recorded under that source id is the authoritative build→revision join (spec §4, F05-A2).
 */
export class Profiles {
  readonly store: Store;
  readonly worker: WorkerClient;
  readonly templates: TemplateRegistry = new TemplateRegistry();
  private now: () => number;
  constructor(store: Store, worker: WorkerClient, now: () => number = () => Date.now()) {
    this.store = store; this.worker = worker; this.now = now;
    for (const t of builtinTemplates()) this.templates.register(t);
  }

  // ---------------------------------------------------------------- §17 rollout flags

  private flags(): { import: boolean; correlate: boolean; compare: boolean } {
    try {
      const r = (this.store.db.prepare("select import, correlate, compare from profile_flags where id = 1").get() ?? {}) as Row;
      return { import: !!r.import, correlate: !!r.correlate, compare: !!r.compare };
    } catch { return { import: true, correlate: true, compare: true }; }
  }
  private gated(name: "import" | "correlate" | "compare") {
    if (!this.flags()[name]) throw new ProfileCheckError("UNAUTHORIZED", `the "${name}" stage of profiling is disabled at this site; nothing was imported or changed`);
  }

  // ---------------------------------------------------------------- §7.1 import (WP-02)

  /**
   * Import one profile file. The worker parses and aggregates it; only declared sample types, mappings, aggregates and
   * one pruned tree persist. Keyed by the SHA-256 of the bytes as received: re-importing the same file is a no-op that
   * returns the stored view. `revisionHint` pins the build to an indexed revision for symbolization (F05-A2).
   */
  async ingestProfile(req: { path: string; serviceHint?: string; revisionHint?: string }): Promise<ProfileIngestView> {
    this.gated("import");
    if (!req.path || !/^([A-Za-z]:)?\//.test(req.path)) throw new ProfileCheckError("INVALID_SCHEMA", "ingestProfile needs an absolute file path");
    if (!existsSync(req.path)) throw new ProfileCheckError("NOT_FOUND", `profile file not found: ${req.path}`);
    const bytes = statSync(req.path).size;
    let parsed: Awaited<ReturnType<WorkerClient["ingestProfileFile"]>>;
    try {
      parsed = await this.worker.ingestProfileFile(req.path, req.serviceHint, 120_000);
    } catch (e) {
      const api = (e as { api?: ProfileDiagnostic[] }).api;
      if (Array.isArray(api)) {
        const code = (["NOT_FOUND", "INVALID_SCHEMA", "RESOURCE_LIMIT"] as const).find((c) => c === api[0]?.code) ?? "INVALID_SCHEMA";
        throw new ProfileCheckError(code, `${req.path}: ${api.map((d) => d.message).join("; ")}`);
      }
      throw e;
    }
    const artifactHash = parsed.artifactHash;
    const prior = this.store.db.prepare("select artifact_hash from profile_artifacts where artifact_hash = ?").get(artifactHash) as Row | undefined;
    if (prior) return await this.attributeArtifact(artifactHash, req.revisionHint);

    const service = parsed.service ?? req.serviceHint ?? null;
    const at = new Date(this.now()).toISOString();
    const truncated = fin(parsed.truncated);
    const diagnostics: ProfileDiagnostic[] = [...parsed.diagnostics, { code: "LABELS_NOT_IMPORTED", message: "sample labels are not imported at this boundary; span/trace-id correlation falls back to window overlap" }];
    // Some producers (modern V8, and pprof with a relative clock) emit timestamps relative to the profiler start rather
    // than the Unix epoch. Such a window can anchor no trace correlation by itself; the file is written when the run
    // ends, so its modification time is the one wall-clock fact available. Anchor there and say so (F05-A2/D8).
    const rawStartNs = fin(parsed.startNs), rawEndNs = fin(parsed.endNs);
    const wallWindow = rawStartNs > 0 && rawEndNs > rawStartNs && Math.floor(rawStartNs / 1e6) >= 1_000_000_000_000;
    let startNs = 0, endNs = 0;
    if (wallWindow) { startNs = Math.round(rawStartNs); endNs = Math.round(rawEndNs); }
    else if (rawStartNs > 0 && rawEndNs > rawStartNs) {
      const mtimeMs = statSync(req.path).mtimeMs;
      endNs = Math.round(mtimeMs * 1e6);
      startNs = Math.max(0, endNs - Math.round(rawEndNs - rawStartNs));
      diagnostics.push({ code: "PROFILE_CLOCK_ANCHORED_AT_MTIME", message: `the profile's own clock is relative to the profiler start; its window is anchored at the file's modification time (${new Date(mtimeMs).toISOString()})` });
    }
    const state: IngestState = truncated > 0 || diagnostics.some((d) => d.code !== "LABELS_NOT_IMPORTED") ? "PARTIAL" : "PARSED";
    const dropped = typeof parsed.droppedSamples === "number" ? Math.max(0, Math.trunc(parsed.droppedSamples)) : "NOT_REPORTED";
    this.store.db.prepare(`insert into profile_artifacts(
        artifact_hash, format, format_version, profiler, profiler_version, service, instance, runtime_name,
        start_ns, end_ns, period_ns, sampling_rate_hz, declared_overhead_percent, dropped_samples,
        truncated, stored_ref, bytes, ingest_state, diagnostics_json, labels_dropped, ingested_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      artifactHash, parsed.format, null, parsed.profiler ?? null, parsed.profilerVersion ?? null, service, parsed.instance ?? null, parsed.runtime ?? null,
      startNs, endNs, optNs(parsed.periodNs), (typeof parsed.samplingRateHz === "number" && Number.isFinite(parsed.samplingRateHz)) ? parsed.samplingRateHz : null, null,
      typeof dropped === "number" ? dropped : null, truncated, req.path, bytes, state, JSON.stringify(diagnostics), 0, at);
    parsed.sampleTypes.forEach((st, i) => {
      this.store.db.prepare("insert or replace into profile_sample_types values (?,?,?,?,?,?)").run(artifactHash, st.ordinal ?? i, st.kind, st.unit, st.rawType, st.rawUnit);
    });
    for (const m of parsed.mappings) {
      this.store.db.prepare(`insert or replace into profile_mappings values (?,?,?,?,?,?,?,?,?,?)`).run(
        artifactHash, m.mappingId, m.buildId ?? null, m.file ?? null, m.hasFunctions ? 1 : 0, m.hasFilenames ? 1 : 0, m.hasLineNumbers ? 1 : 0, m.hasInlineFrames ? 1 : 0, null, "UNKNOWN");
    }
    await this.persistAggregates(artifactHash);
    return await this.attributeArtifact(artifactHash, req.revisionHint);
  }

  /** Parse and aggregate through the worker, then persist per-function rows (self/total) and the pruned tree. */
  private async persistAggregates(artifactHash: string): Promise<void> {
    const a = this.artifact(artifactHash);
    const stypes = this.sampleTypesOf(artifactHash);
    for (const st of stypes) {
      const res: ProfileHotspotResultRpc = await this.worker.profileHotspots(a.stored_ref, { ordinal: st.ordinal, order: "SELF", limit: PROFILE_LIMITS.maxAggRows });
      const total = fin(res.population_value ?? res.populationValue);
      for (const r of res.rows) {
        const key = r.function_key ?? r.functionKey;
        if (!key) continue;
        this.store.db.prepare(`insert or replace into profile_function_agg(artifact_hash, sample_type_ordinal, function_key, name, file, line, self_value, total_value, sample_count, entity_id, attribution_method) values (?,?,?,?,?,?,?,?,?,?,?)`).run(
          artifactHash, st.ordinal, key, r.name, r.file || null, fin(r.line) || null, fin(r.self_value ?? (r as Row).selfValue),
          fin(r.total_value ?? (r as Row).totalValue), Math.max(0, Math.trunc(Number(r.sample_count ?? (r as Row).sampleCount ?? 0))),
          null, (r.attribution_method ?? (r as Row).attributionMethod ?? "UNATTRIBUTED"));
      }
      // The unattributed rest is its own aggregate row, so the denominator of every share includes it (§7.4.3).
      const located = [...this.store.db.prepare("select self_value from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ? and function_key != '__unattributed__'").all(artifactHash, st.ordinal) as Row[]].reduce((n, x) => n + fin(x.self_value), 0);
      if (total > located + 1e-9) {
        this.store.db.prepare(`insert or replace into profile_function_agg(artifact_hash, sample_type_ordinal, function_key, name, file, line, self_value, total_value, sample_count, entity_id, attribution_method) values (?,?,?,?,?,?,?,?,?,?,?)`).run(
          artifactHash, st.ordinal, "__unattributed__", "(runtime, native and unlocated frames)", null, null, total - located, 0, 0, null, "UNATTRIBUTED");
      } else {
        this.store.db.prepare("delete from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ? and function_key = '__unattributed__'").run(artifactHash, st.ordinal);
      }
      const flame: ProfileFlamegraphResultRpc = await this.worker.profileFlamegraph(a.stored_ref, { ordinal: st.ordinal });
      this.store.db.prepare("insert or replace into profile_tree values (?,?,?,?,?)").run(
        artifactHash, st.ordinal, JSON.stringify(flame), Number(flame.node_count ?? (flame as Row).nodeCount ?? 0), fin(flame.pruned_value ?? (flame as Row).prunedValue));
    }
    this.dbSet(artifactHash, { ingest_state: "AGGREGATED" });
  }

  private dbSet(artifactHash: string, fields: Partial<{ ingest_state: string }>) {
    const setters = Object.entries(fields).map(([k, _]) => `${k} = ?`).join(", ");
    this.store.db.prepare(`update profile_artifacts set ${setters} where artifact_hash = ?`).run(...Object.values(fields), artifactHash);
  }

  // ---------------------------------------------------------------- §7.2 build→revision resolution and the attribution ladder (WP-04)

  private artifact(hash: string): Row {
    const r = this.store.db.prepare("select * from profile_artifacts where artifact_hash = ?").get(hash) as Row | undefined;
    if (!r) throw new ProfileCheckError("NOT_FOUND", "no such profile artifact");
    return r;
  }

  sampleTypesOf(artifactHash: string): SampleTypeView[] {
    return (this.store.db.prepare("select * from profile_sample_types where artifact_hash = ? order by ordinal").all(artifactHash) as Row[]).map((r) => ({
      ordinal: r.ordinal, kind: r.kind as SampleKind, unit: r.unit, rawType: r.raw_type, rawUnit: r.raw_unit,
    }));
  }

  mappingsOf(artifactHash: string): ProfileMappingView[] {
    return (this.store.db.prepare("select * from profile_mappings where artifact_hash = ? order by mapping_id").all(artifactHash) as Row[]).map((r) => ({
      mappingId: r.mapping_id, buildId: r.build_id ?? undefined, file: r.file ?? undefined,
      hasFunctions: !!r.has_functions, hasFilenames: !!r.has_filenames, hasLineNumbers: !!r.has_line_numbers, hasInlineFrames: !!r.has_inline_frames,
      revision: r.revision ?? undefined, revisionState: r.revision_state,
    }));
  }

  /**
   * Resolve the build to a revision: an explicit hint is authoritative; otherwise the newest deployment marker recorded
   * for this service at or before the profile's end. A marker recorded after the profile window cannot say what ran
   * before it. Unresolved is a state, never a guess (§6.1).
   */
  resolveRevision(artifactHash: string, hint?: string): { revision: string | null; evidenceIds: string[]; source: "HINT" | "BINDING" | "MARKER" | "NONE" } {
    if (hint) {
      const rev = this.store.revision(hint);
      if (!rev) throw new ProfileCheckError("NOT_FOUND", `the revision hint names no known revision (${hint})`);
      return { revision: hint, evidenceIds: [], source: "HINT" };
    }
    const a = this.artifact(artifactHash);
    // A binding once resolved is remembered on the artifact's mapping row: later passes (a correlation, a view) do not
    // drift to whatever deployment marker happens to be newest, which would silently re-label an old profile.
    const bound = this.store.db.prepare("select revision from profile_mappings where artifact_hash = ? and revision is not null limit 1").get(artifactHash) as Row | undefined;
    if (bound?.revision) return { revision: String(bound.revision), evidenceIds: [], source: "BINDING" };
    if (!a.service) return { revision: null, evidenceIds: [], source: "NONE" };
    const endMs = Math.floor(Number(a.end_ns) / 1e6);
    const m = this.store.db.prepare("select revision, at from rt_markers where source = ? and at <= ? order by at desc limit 1").get(a.service, endMs) as Row | undefined;
    return m && m.revision ? { revision: m.revision, evidenceIds: [], source: "MARKER" } : { revision: null, evidenceIds: [], source: "NONE" };
  }

  /**
   * The attribution ladder (§7.2). Runs after ingest or whenever a hint changes: resolves the revision, verifies it
   * against the code at that revision, and stamps every aggregate row with its method and (exact only) its entity.
   *   MATCHED    — evidence of the revision exists and located frames verify against that revision's code;
   *   MISMATCH   — a revision was resolved/named but locate+name disagrees for every located frame;
   *   UNKNOWN    — no binding; entity mapping waits for one (names alone match nothing without a revision).
   */
  async attributeArtifact(artifactHash: string, revisionHint?: string): Promise<ProfileIngestView> {
    const a = this.artifact(artifactHash);
    if (a.ingest_state === "REJECTED") return this.viewOf(artifactHash);
    // Some formats (V8 cpuprofiles) carry no mapping records at all, but the build binding needs one home: if there is
    // none, record an implicit mapping row so the resolved revision and its state live where every consumer reads them.
    if (!this.store.db.prepare("select 1 from profile_mappings where artifact_hash = ? limit 1").get(artifactHash))
      this.store.db.prepare("insert or replace into profile_mappings values (?,?,?,?,?,?,?,?,?,?)").run(artifactHash, 0, null, null, 1, 1, 1, 0, null, "UNKNOWN");
    const res = this.resolveRevision(artifactHash, revisionHint);
    const rows = () => this.store.db.prepare("select function_key, name, file, line, self_value from profile_function_agg where artifact_hash = ? and function_key != '__unattributed__'").all(artifactHash) as Row[];
    let state: "MATCHED" | "MISMATCH" | "UNKNOWN" = "UNKNOWN";
    let locatable = 0, verified = 0, locatedValue = 0, verifiedValue = 0;
    if (res.revision) {
      const rev = this.store.revision(res.revision);
      if (!rev) throw new ProfileCheckError("NOT_FOUND", "the resolved revision is not accessible");
      const located = rows().filter((r) => r.file);
      for (const m of this.store.db.prepare("select mapping_id from profile_mappings where artifact_hash = ?").all(artifactHash) as Row[])
        this.store.db.prepare("update profile_mappings set revision = ?, revision_state = 'UNKNOWN' where artifact_hash = ? and mapping_id = ?").run(res.revision, artifactHash, m.mapping_id);
      const files = this.store.entities(res.revision).filter((e) => e.kind === "file").map((e) => e.file);
      const ents = this.store.entities(res.revision);
      const bufOf = new Map<string, Buffer | null>();
      for (const r of located) {
        const norm = normalizeFramePath(r.file);
        const rel = matchFrameFile(files, norm) ?? (norm && !norm.includes("node_modules") && relOf(rev, norm) ? relOf(rev, norm) : undefined);
        if (!rel) continue;
        locatable++;
        let buf = bufOf.get(rel);
        if (!bufOf.has(rel)) { try { buf = readFileSync(resolve(rev.repoRoot, rel)); } catch { buf = null; } bufOf.set(rel, buf); }
        const b = buf!;
        const off = byteOffset(b, Math.max(1, fin(r.line) || 1), 1);
        const inner = ents.filter((e) => e.file === rel && e.kind !== "file" && e.kind !== "test" && e.spans[0] && e.spans[0].startByte <= off && off < e.spans[0].endByteExclusive)
          .sort((x, y) => (x.spans[0].endByteExclusive - x.spans[0].startByte) - (y.spans[0].endByteExclusive - y.spans[0].startByte))[0];
        const matches = !!inner && (inner.name === r.name || inner.name.split(".").pop() === r.name.split(".").pop());
        const lineHit = !!inner && !matches; // the line lands in *a* function, but not this one
        const nameHit = !inner && r.name ? ents.filter((e) => ["function", "method"].includes(e.kind) && e.file === rel && (e.name === r.name || e.name.split(".").pop() === r.name)).length === 1 : false;
        const method = matches ? "CODE_LOCATION_EXACT" : nameHit ? "FUNCTION_NAME" : lineHit || inner ? "FUNCTION_NAME" : "FUNCTION_NAME";
        const entityId = matches ? inner!.entityId : nameHit ? ents.find((e) => ["function", "method"].includes(e.kind) && e.file === rel && (e.name === r.name || e.name.split(".").pop() === r.name))!.entityId : null;
        locatedValue += fin(r.self_value);
        if (matches) { verified++; verifiedValue += fin(r.self_value); }
        this.store.db.prepare("update profile_function_agg set entity_id = ?, attribution_method = ? where artifact_hash = ? and function_key = ?").run(entityId, method, artifactHash, r.function_key);
      }
      for (const r of rows()) if (!r.file) this.store.db.prepare("update profile_function_agg set attribution_method = 'UNATTRIBUTED' where artifact_hash = ? and function_key = ?").run(artifactHash, r.function_key);
      // MATCHED means the bound revision's code agrees with essentially all of the profile's located sample value; a
      // material disagreeing share (a renamed or moved hot function) is a MISMATCH, which closes every precise line
      // link for the rows that disagree while the agreeing rows keep theirs (F05-A2).
      state = located.length === 0 ? "UNKNOWN"
        : locatedValue <= 0 ? (verified > 0 ? "MATCHED" : "MISMATCH")
          : verifiedValue >= locatedValue * (1 - PROFILE_LIMITS.mismatchShareTolerance) && verifiedValue > 0 ? "MATCHED" : "MISMATCH";
      for (const m of this.store.db.prepare("select mapping_id from profile_mappings where artifact_hash = ?").all(artifactHash) as Row[])
        this.store.db.prepare("update profile_mappings set revision_state = ? where artifact_hash = ? and mapping_id = ?").run(state, artifactHash, m.mapping_id);
    } else {
      // Without a binding, a name still maps to code — but only the unique one, and never as a precise line (§7.2.3).
      for (const m of this.store.db.prepare("select mapping_id from profile_mappings where artifact_hash = ?").all(artifactHash) as Row[])
        this.store.db.prepare("update profile_mappings set revision = null, revision_state = 'UNKNOWN' where artifact_hash = ? and mapping_id = ?").run(artifactHash, m.mapping_id);
    }
    this.dbSet(artifactHash, { ingest_state: state === "UNKNOWN" ? "AGGREGATED" : "LINKED" });
    try { this.store.audit("profile", "profile.attribute", artifactHash, { state, revision: res.revision }); } catch { /* audit is best-effort */ }
    return this.viewOf(artifactHash);
  }

  private viewOf(hash: string): ProfileIngestView {
    const a = this.artifact(hash);
    const mappingState = (this.store.db.prepare("select revision_state from profile_mappings where artifact_hash = ? limit 1").get(hash) as Row | undefined)?.revision_state ?? "UNKNOWN";
    const revision = (this.store.db.prepare("select revision from profile_mappings where artifact_hash = ? and revision is not null limit 1").get(hash) as Row | undefined)?.revision ?? null;
    const dropped = a.dropped_samples === null || a.dropped_samples === undefined ? "NOT_REPORTED" as const : Number(a.dropped_samples);
    return {
      artifactHash: a.artifact_hash, format: a.format, ingestState: a.ingest_state,
      service: a.service ?? null, instance: a.instance ?? null, runtimeName: a.runtime_name ?? null,
      startNs: Number(a.start_ns), endNs: Number(a.end_ns), periodNs: a.period_ns ?? null,
      samplingRateHz: a.sampling_rate_hz ?? null,
      droppedSamples: dropped, truncated: Number(a.truncated), labelsDropped: Number(a.labels_dropped),
      sampleTypes: this.sampleTypesOf(hash), mappings: this.mappingsOf(hash),
      revision, buildState: mappingState as ProfileIngestView["buildState"],
      diagnostics: JSON.parse(a.diagnostics_json ?? "[]") as ProfileDiagnostic[], bytes: Number(a.bytes),
    };
  }

  listArtifacts(f: { traceSourceId?: string; limit?: number } = {}): ProfileIngestView[] {
    // A trace source narrows the list to the artifacts it has been linked to; without one the newest imports are shown.
    const limit = Math.max(1, Math.min(200, Math.trunc(f.limit ?? 200)));
    const hashes = f.traceSourceId
      ? (this.store.db.prepare("select distinct artifact_hash from profile_trace_links where trace_source = ?").all(f.traceSourceId) as Row[]).map((r) => String(r.artifact_hash))
      : null;
    const rows = (this.store.db.prepare(`select artifact_hash from profile_artifacts order by ingested_at desc limit ${limit}`).all() as Row[])
      .map((r) => String(r.artifact_hash)).filter((h) => !hashes || hashes.includes(h));
    return rows.map((h) => this.viewOf(h));
  }

  /** Persisted populations (the compare/citation anchor) without re-deriving anything raw. */
  listPopulations(f: { traceSourceId?: string; artifactHash?: string; limit?: number } = { }): { populationHash: string; artifactHash: string; window: { fromNs: number; toNs: number }; revision?: string; chunkIds: string[] }[] {
    // Populations are keyed by their chunk list, and a chunk id is `<artifactHash>#<ordinal>`; there is no separate
    // artifact column, so the artifact anchor is read back out of the chunks (and the trace source through the links).
    const wanted = f.artifactHash ? new Set([f.artifactHash]) : f.traceSourceId
      ? new Set((this.store.db.prepare("select distinct artifact_hash from profile_trace_links where trace_source = ?").all(f.traceSourceId) as Row[]).map((r) => String(r.artifact_hash)))
      : null;
    const limit = Math.max(1, Math.min(200, Math.trunc(f.limit ?? 50)));
    const rows = this.store.db.prepare(`select * from profile_populations order by created_at desc, population_hash limit ${limit}`).all() as Row[];
    return rows.map((r) => {
      const chunks = JSON.parse(String(r.chunk_ids_json ?? "[]")) as string[];
      return { populationHash: String(r.population_hash), artifactHash: chunks[0]?.split("#")[0] ?? "", window: { fromNs: Number(r.window_from_ns), toNs: Number(r.window_to_ns) }, revision: r.revision ?? undefined, chunkIds: chunks };
    }).filter((p) => !wanted || wanted.has(p.artifactHash));
  }

  // ---------------------------------------------------------------- §7.3 trace correlation (WP-06)

  /**
   * Correlate one profile artifact with one trace source. The grade ladder decides what may be claimed: span-labelled
   * samples (when the format carried span labels), endpoint labels, or window overlap only — and window overlap is
   * population evidence, never a statement about this request (§7.3). Nothing here invents a tighter grade.
   */
  correlate(req: { artifactHash: string; traceSourceId: string; timeWindowMs?: { from: number; to: number }; overrideRevisionMismatch?: { reason: string } }): ProfileCorrelation {
    this.gated("correlate");
    const a = this.artifact(req.artifactHash);
    const resolved = this.resolveRevision(req.artifactHash);
    if (req.overrideRevisionMismatch && !resolved.revision && req.overrideRevisionMismatch.reason.trim().length < 4)
      throw new ProfileCheckError("INVALID_SCHEMA", "an override needs a stated reason of at least four characters");
    const fromMs = req.timeWindowMs ? Math.floor(req.timeWindowMs.from) : Math.floor(Number(a.start_ns) / 1e6);
    const toMs = req.timeWindowMs ? Math.floor(req.timeWindowMs.to) : Math.floor(Number(a.end_ns) / 1e6);
    if (!req.timeWindowMs && !(Number(a.end_ns) > Number(a.start_ns))) throw new ProfileCheckError("INSUFFICIENT_EVIDENCE", "this profile carries no wall-clock window (its timestamps are relative to the profiler start); pass the trace window explicitly to correlate it");
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new ProfileCheckError("INVALID_SCHEMA", "a correlation needs a window with an end after its start");
    const spans = this.spansInWindow(req.traceSourceId, fromMs, toMs);
    const links: CorrelationLink[] = [];
    const reasons: string[] = [];
    // Service: a profile labelled with another service names a different population. Revision: the traces and the
    // profile must name the same one, or the strongest possible grade is still NONE (§7.3).
    const serviceMismatch = !!a.service && a.service !== req.traceSourceId;
    const traceRevision = this.revisionOfTrace(req.traceSourceId, fromMs, toMs);
    const revisionMismatch = !!resolved.revision && !!traceRevision && resolved.revision !== traceRevision;
    const allowed: CorrelationGrade = revisionMismatch && !req.overrideRevisionMismatch ? "NONE"
      : serviceMismatch ? "NONE" : "WINDOW_OVERLAP";
    if (allowed === "NONE") reasons.push(revisionMismatch ? `the profile ran ${resolved.revision}, the traces ran ${traceRevision}; different builds never share a link` : "the profile and the trace name different services");
    if (allowed === "WINDOW_OVERLAP" && overlapMs(Number(a.start_ns) / 1e6, Number(a.end_ns) / 1e6, fromMs, toMs) === null) reasons.push("the profile window and the trace window do not overlap");
    // Endpoint labels: the source's spans must name the endpoint and the profile must have declared it. At this
    // boundary no importer carries labels, so the honest grade for unlabelled profiles is WINDOW_OVERLAP or NONE.
    const endpointLabel = (this.store.db.prepare("select 1 from profile_labels where artifact_hash = ? and label in ('endpoint','route','operation') limit 1").get(req.artifactHash) as Row | undefined);
    const named = [...new Set(spans.rootSpans.map((s) => s.name))];
    if (endpointLabel && named.length === 1) {
      links.push({ grade: "ENDPOINT_LABELLED", reason: `samples carry an endpoint label and every span in the window is ${named[0]}`, overlapMs: overlapMs(Number(a.start_ns) / 1e6, Number(a.end_ns) / 1e6, fromMs, toMs) ?? undefined });
    } else if (allowed === "WINDOW_OVERLAP") {
      const om = overlapMs(Number(a.start_ns) / 1e6, Number(a.end_ns) / 1e6, fromMs, toMs);
      if (om !== null) {
        const skew = om < RT_LIMITS.skewMs ? "; clock skew is within the disclosure bound (UNCERTAIN_ALIGNMENT)" : "";
        links.push({ grade: "WINDOW_OVERLAP", overlapMs: om, reason: `same service and revision; the windows overlap${spans.rootSpans.length ? ` (${spans.rootSpans.length} request span(s))` : ""}${skew}${req.overrideRevisionMismatch ? ` (override: ${req.overrideRevisionMismatch.reason})` : ""}` });
      } else {
        links.push({ grade: "NONE", reason: "the profile window and the trace window do not overlap; no claim can be made" });
      }
    } else {
      links.push({ grade: "NONE", reason: reasons.join("; ") || "no overlap" });
    }
    const population = this.populationFor(req.artifactHash, req.traceSourceId, fromMs, toMs, resolved.revision ?? undefined, allowed);
    const best = (g: CorrelationGrade): number => ["NONE", "WINDOW_OVERLAP", "ENDPOINT_LABELLED", "SPAN_LABELLED"].indexOf(g);
    const grade = links.reduce<CorrelationGrade>((acc, l) => (best(l.grade) > best(acc) ? l.grade : acc), "NONE");
    const linkId = hashId("link", [req.artifactHash, req.traceSourceId, fromMs, toMs, grade]);
    this.store.db.prepare("insert or replace into profile_trace_links values (?,?,?,?,?,?,?,?,?,?)").run(
      linkId, req.artifactHash, 0, req.traceSourceId, links[0]?.traceId ?? null, links[0]?.spanId ?? null, grade, Math.max(0, Math.round(overlapMs(Number(a.start_ns) / 1e6, Number(a.end_ns) / 1e6, fromMs, toMs) ?? 0)), links[0]?.reason ?? "no link", new Date(this.now()).toISOString());
    this.dbSet(req.artifactHash, { ingest_state: allowed === "NONE" ? this.artifact(req.artifactHash).ingest_state : "LINKED" });
    const correlation: ProfileCorrelation = {
      correlationId: hashId("corr", [req.artifactHash, req.traceSourceId, fromMs, toMs]),
      links: links.map((l) => ({ ...l, traceId: undefined, spanId: undefined })),
      // (first boundary: one link row per window; span-id labels arrive with label import, WP-03)
      build: { buildId: this.mappingsOf(req.artifactHash)[0]?.buildId ?? undefined, revision: resolved.revision ?? undefined, state: (this.store.db.prepare("select revision_state from profile_mappings where artifact_hash = ? limit 1").get(req.artifactHash) as Row | undefined)?.revision_state ?? "UNKNOWN", evidenceIds: resolved.evidenceIds },
      populationHash: population.populationHash,
    };
    this.store.audit(req.traceSourceId, "profile.correlate", req.artifactHash, { grade, populationHash: population.populationHash });
    return correlation;
  }

  private revisionOfTrace(sourceId: string, fromMs: number, toMs: number): string | null {
    const m = this.store.db.prepare("select revision from rt_markers where source = ? and at <= ? order by at desc limit 1").get(sourceId, toMs) as Row | undefined;
    const env = this.store.db.prepare("select revision from rt_envelopes where source = ? and win_to >= ? and win_from <= ? and rejected = 0 and revision is not null limit 1").get(sourceId, fromMs, toMs) as Row | undefined;
    return (m?.revision ?? env?.revision ?? null) || null;
  }

  private spansInWindow(sourceId: string, fromMs: number, toMs: number): { rootSpans: { traceId: string; spanId: string; name: string; startMs: number; endMs: number; error: boolean }[]; all: { traceId: string; spanId: string; name: string; startMs: number; endMs: number; error: boolean; parentId: string | null }[] } {
    const rows = this.store.db.prepare(`select s.trace_id, s.span_id, s.parent_id, s.name, s.start_ms, s.end_ms, s.error from rt_spans s
       join rt_envelopes e on e.id = s.envelope
       where e.source = ? and e.rejected = 0 and not (s.flags like '%TIMESTAMP_IMPOSSIBLE%')
         and s.end_ms >= ? and s.start_ms <= ? order by s.start_ms, s.trace_id, s.seq limit 20000`).all(sourceId, fromMs, toMs) as Row[];
    const all = rows.map((r) => ({ traceId: r.trace_id, spanId: r.span_id, name: r.name, startMs: r.start_ms, endMs: r.end_ms, error: !!r.error, parentId: r.parent_id ?? null }));
    const ids = new Set(all.map((s) => s.spanId));
    return { all, rootSpans: all.filter((s) => !s.parentId || !ids.has(s.parentId)) };
  }

  /** §6.2: a population is the selection of chunks for one (service, window, revision, sample kind); hashed, immutable. */
  private populationFor(artifactHash: string, service: string, fromMs: number, toMs: number, revision: string | undefined, kindLike: CorrelationGrade | SampleKind): ProfilePopulation {
    const sampleTypes = this.sampleTypesOf(artifactHash);
    const kinds = [...new Set(sampleTypes.map((s) => s.kind))];
    const kindKind = (kinds as string[]).includes(kindLike) ? kindLike as SampleKind : kinds[0] ?? "OTHER";
    const stypes = sampleTypes.filter((s) => s.kind === kindKind);
    const windowFromNs = fromMs * 1e6, windowToNs = toMs * 1e6;
    const chunkIds = stypes.map((s) => `${artifactHash}#${s.ordinal}`);
    const specKey = { service, windowFromNs, windowToNs, revision, kind: kindKind, chunkIds };
    const hash = "pop:" + createHash("sha256").update(JSON.stringify(specKey)).digest("hex").slice(0, 32);
    const a = this.artifact(artifactHash);
    const agg = this.store.db.prepare("select coalesce(sum(sample_count),0) n from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ? and function_key != '__unattributed__'").get(artifactHash, stypes[0]?.ordinal ?? 0) as Row;
    const requestCount = this.spansInWindow(service, fromMs, toMs).rootSpans.length;
    const errorCount = this.spansInWindow(service, fromMs, toMs).rootSpans.filter((s) => s.error).length;
    const expected = a.period_ns ? Math.floor((windowToNs - windowFromNs) / Number(a.period_ns)) : null;
    const ratio = expected ? Number(agg.n) / expected : null;
    const pop: ProfilePopulation = {
      populationHash: hash, service, windowFromNs, windowToNs, revision, sampleTypeKind: kindKind,
      chunkIds, sampleCount: Math.max(0, Math.trunc(fin(agg.n))), expectedSamples: expected ?? undefined,
      collectionRatio: ratio ?? undefined, requestCount: requestCount || undefined, errorCount: errorCount || undefined,
    };
    this.store.db.prepare(`insert or replace into profile_populations values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash, service, windowFromNs, windowToNs, revision ?? null, kindKind, JSON.stringify(chunkIds),
      pop.sampleCount, expected ?? null, ratio ?? null, requestCount || null, errorCount || null, new Date(this.now()).toISOString());
    return pop;
  }

  populationOf(hash: string): ProfilePopulation | null {
    const r = this.store.db.prepare("select * from profile_populations where population_hash = ?").get(hash) as Row | undefined;
    if (!r) return null;
    return {
      populationHash: r.population_hash, service: r.service, windowFromNs: r.window_from_ns, windowToNs: r.window_to_ns,
      revision: r.revision ?? undefined, sampleTypeKind: r.sample_type_kind as SampleKind, chunkIds: JSON.parse(r.chunk_ids_json),
      sampleCount: r.sample_count, expectedSamples: r.expected_samples ?? undefined, collectionRatio: r.collection_ratio ?? undefined,
      requestCount: r.request_count ?? undefined, errorCount: r.error_count ?? undefined,
    };
  }

  // ---------------------------------------------------------------- §7.4 hotspots (WP-05)

  /**
   * Ranked hotspots for one population and one metric kind. The kind is either a property of the correlation's
   * population or an explicit ordinal of the artifact; kinds are never mixed (F05-A3). Rows come from the persisted
   * aggregates, access-filtered at read time (a revoked path collapses into an anonymous bucket, denominators unchanged).
   */
  queryHotspots(req: { artifactHash: string; ordinal?: number; order?: "SELF" | "TOTAL"; limit?: number; cursor?: string; correlationId?: string; viewRevision?: string }): HotspotResult {
    this.gated("correlate"); // hotspots rest on import; the correlate gate stands for the whole read side (§17)
    const a = this.artifact(req.artifactHash);
    const stypes = this.sampleTypesOf(req.artifactHash);
    const ordinal = req.ordinal !== undefined ? req.ordinal : 0;
    const st = stypes.find((x) => x.ordinal === ordinal);
    if (!st) throw new ProfileCheckError("INVALID_SCHEMA", `sample type ordinal ${ordinal} is not provided by this profile; provided kinds: ${stypes.map((s) => s.kind).join(", ") || "none"}`);
    const viewRevision = req.viewRevision ?? (this.store.db.prepare("select revision from profile_mappings where artifact_hash = ? and revision is not null limit 1").get(req.artifactHash) as Row | undefined)?.revision ?? null;
    const repoRoot = viewRevision ? this.store.revision(viewRevision)?.repoRoot ?? null : null;
    const access = policyFor(this.store, repoRoot);
    const all = this.store.db.prepare(`select * from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ?`).all(req.artifactHash, ordinal) as Row[];
    // Denominator: everything the profile counted, including the unattributed rest and (for denied paths) the withheld rest.
    // Frames carry the profiler's own path form (often an absolute file URL), so the policy is applied to the path made
    // relative to the revision's root — a denied prefix must match the repository's own layout (F05-D9/D11).
    const relOfRepo = (file: string | null | undefined): string => {
      if (!file) return "";
      const norm = normalizeFramePath(file);
      if (!repoRoot) return norm;
      const root = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
      return norm.startsWith(root) ? norm.slice(root.length) : norm.replace(/^[A-Za-z]:[\/]/, "");
    };
    let withheldValue = 0;
    for (const r of all) if (r.function_key !== "__unattributed__" && access.denied(relOfRepo(r.file))) withheldValue += fin(r.self_value);
    const populationValue = all.reduce((n, r) => n + fin(r.self_value), 0);
    const sampleCount = Math.max(0, Math.trunc(fin(all.reduce((n, r) => n + Number(r.sample_count ?? 0), 0))));
    const treeRow = this.store.db.prepare("select pruned_value from profile_tree where artifact_hash = ? and sample_type_ordinal = ?").get(req.artifactHash, ordinal) as Row | undefined;
    const pruned = fin(treeRow?.pruned_value);
    const unattributed = fin(all.find((r) => r.function_key === "__unattributed__")?.self_value);
    const order = req.order ?? "SELF";
    const sorted = all.filter((r) => r.function_key !== "__unattributed__").sort((x, y) => {
      const a1 = order === "TOTAL" ? fin(y.total_value) - fin(x.total_value) : fin(y.self_value) - fin(x.self_value);
      return a1 || String(x.function_key).localeCompare(String(y.function_key));
    });
    // Keyset page: the cursor carries (order value, function key) so a live re-rank can never skip or repeat a row.
    const pageSize = Math.max(1, req.limit ?? PROFILE_LIMITS.hotspotsPageSize);
    let cursorKey: { v: number; k: string } | null = null;
    if (req.cursor) { const dec = Buffer.from(req.cursor, "base64").toString("utf8").split("\u0001"); if (dec.length === 2 && Number.isFinite(Number(dec[0]))) cursorKey = { v: Number(dec[0]), k: dec[1] }; }
    const after = (r: Row) => !cursorKey || (fin(order === "TOTAL" ? r.total_value : r.self_value), fin(order === "TOTAL" ? fin(r.total_value) : fin(r.self_value)) < cursorKey.v || (fin(order === "TOTAL" ? r.total_value : r.self_value) === cursorKey.v && String(r.function_key).localeCompare(cursorKey.k) > 0));
    const shown: Row[] = [];
    for (const r of sorted) {
      if (!after(r)) continue;
      shown.push(r);
      if (shown.length >= pageSize) break;
    }
    const rows: HotspotRow[] = [];
    for (const r of shown) {
      if (r.file && access.denied(relOfRepo(r.file))) continue; // a denied path name is dropped from paging; its value stays in the totals
      const exact = r.attribution_method === "CODE_LOCATION_EXACT" && stateOf(this.store, req.artifactHash) === "MATCHED";
      const linkable = !!r.entity_id && exact && !!viewRevision;
      const interval = wilsonRow(Number(r.sample_count ?? 0), sampleCount);
      rows.push({
        rank: 0, functionKey: r.function_key, name: r.name, file: r.file ?? "", line: fin(r.line) || 0,
        selfValue: fin(r.self_value), totalValue: fin(r.total_value),
        selfShare: populationValue > 0 ? fin(r.self_value) / populationValue : 0,
        totalShare: populationValue > 0 ? fin(r.total_value) / populationValue : 0,
        sampleCount: Math.trunc(Number(r.sample_count ?? 0)),
        uncertaintyLow: interval[0], uncertaintyHigh: interval[1],
        entityId: linkable ? r.entity_id : undefined,
        attributionMethod: exact ? r.attribution_method : r.entity_id ? r.attribution_method || "FUNCTION_NAME" : "UNATTRIBUTED",
      });
    }
    // The withheld rest is disclosed as its own trailing row, so the table's shares still read against the same total (§10).
    const withheldShare = populationValue > 0 ? withheldValue / populationValue : 0;
    if (withheldValue > 0) rows.push({
      rank: 0, functionKey: "__withheld__", name: "(withheld)", file: "", line: 0,
      selfValue: withheldValue, totalValue: 0, selfShare: withheldShare, totalShare: 0, sampleCount: 0,
      uncertaintyLow: 0, uncertaintyHigh: 1, attributionMethod: "ACCESS_DENIED",
    });
    rows.forEach((r, i) => { r.rank = i + 1; });
    const nextCursor = shown.length < pageSize ? undefined : Buffer.from(`${fin(order === "TOTAL" ? shown[shown.length - 1].total_value : shown[shown.length - 1].self_value)}\u0001${shown[shown.length - 1].function_key}`, "utf8").toString("base64");
    const dropped = a.dropped_samples === null || a.dropped_samples === undefined ? "NOT_REPORTED" as const : Number(a.dropped_samples);
    const expected = a.period_ns ? Math.floor((Number(a.end_ns) - Number(a.start_ns)) / Number(a.period_ns)) : undefined;
    const collectionRatio = expected ? sampleCount / expected : undefined;
    const gradeLink = req.correlationId ? this.gradeFor(req.artifactHash, req.correlationId) : "NONE";
    const coverage: ProfileCoverage = {
      collectionRatio, droppedSamples: dropped, truncatedStacks: Number(a.truncated),
      unattributedShare: populationValue > 0 ? unattributed / populationValue : 0,
      prunedShare: populationValue > 0 ? pruned / populationValue : 0,
    };
    const uncertainty: ProfileUncertainty = { method: "WILSON_95_INDICATIVE", minSamplesForRanking: PROFILE_LIMITS.minSamplesForRanking, tooFewSamples: sampleCount < PROFILE_LIMITS.minSamplesForRanking };
    const population = this.populationFor(req.artifactHash, a.service ?? "unknown", Math.floor(Number(a.start_ns) / 1e6), Math.floor(Number(a.end_ns) / 1e6), viewRevision ?? undefined, st.kind);
    return {
      rows, unit: st.unit, sampleCount, populationValue,
      coverage, uncertainty, basis: "MEASURED_PROFILE", grade: gradeLink, populationHash: population.populationHash,
      nextCursor,
    };
  }


  private gradeFor(artifactHash: string, correlationId: string): CorrelationGrade {
    const row = this.store.db.prepare("select grade, max(grade) g from profile_trace_links where artifact_hash = ? group by grade").all(artifactHash) as Row[];
    void row;
    const corr = correlationId.split("|")[0];
    void corr;
    const best = (this.store.db.prepare("select grade from profile_trace_links where artifact_hash = ? order by created_at desc limit 1").get(artifactHash) as Row | undefined)?.grade;
    return (best as CorrelationGrade) ?? "NONE";
  }

  // ---------------------------------------------------------------- §7.5 flamegraph (bounded tree, a view of the table)

  async flamegraph(req: { artifactHash: string; ordinal?: number; viewRevision?: string }): Promise<FlameTreeResult> {
    const a = this.artifact(req.artifactHash);
    const ordinal = req.ordinal ?? 0;
    let row = this.store.db.prepare("select * from profile_tree where artifact_hash = ? and sample_type_ordinal = ?").get(req.artifactHash, ordinal) as Row | undefined;
    if (!row) { await this.persistAggregates(req.artifactHash); row = this.store.db.prepare("select * from profile_tree where artifact_hash = ? and sample_type_ordinal = ?").get(req.artifactHash, ordinal) as Row | undefined; }
    const tree = JSON.parse((row ?? this.store.db.prepare("select * from profile_tree where artifact_hash = ? and sample_type_ordinal = ?").get(req.artifactHash, ordinal))!.tree_json) as ProfileFlamegraphResultRpc;
    const st = this.sampleTypesOf(req.artifactHash).find((s) => s.ordinal === ordinal);
    const viewRevision = req.viewRevision ?? null;
    const access = policyFor(this.store, viewRevision ? this.store.revision(viewRevision)?.repoRoot ?? null : null);
    const redact = (n: ProfileFlamegraphResultRpc["tree"]): FlameTreeResult["tree"] => ({
      functionKey: n.function_key ?? n.functionKey ?? n.name,
      name: n.name, file: access.denied(n.file) ? "" : n.file, line: fin(n.line),
      selfValue: fin(n.self_value ?? n.selfValue), totalValue: fin(n.total_value ?? n.totalValue),
      otherValue: fin(n.other_value ?? n.otherValue), children: (n.children ?? []).map(redact),
    });
    const populationValue = (this.store.db.prepare("select coalesce(sum(self_value),0) v from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ?").get(req.artifactHash, ordinal) as Row).v;
    return {
      tree: redact(tree.tree), nodeCount: Number(tree.node_count ?? (tree as Row).nodeCount ?? 0),
      prunedValue: fin(tree.pruned_value ?? (tree as Row).prunedValue),
      prunedShare: populationValue > 0 ? fin(tree.pruned_value ?? (tree as Row).prunedValue) / populationValue : 0,
      unit: st?.unit ?? tree.unit, populationValue,
    };
  }

  // ---------------------------------------------------------------- §7.6 compare populations (WP-09, F05-A6)

  /**
   * Compare two populations. The gate that matters: the per-request error populations must match, or the comparison is
   * NOT_COMPARABLE — a candidate whose failed requests disappeared cannot look faster (F05-A6). This gate lives here,
   * in the service that knows the request populations, and no declaration of equivalence bypasses it.
   */
  compare(req: { baselinePopulationHash: string; candidatePopulationHash: string; normalise: "PER_REQUEST" | "ABSOLUTE"; declareEquivalent?: { reason: string } }): CompareProfilesResult {
    this.gated("compare");
    const b = this.populationOf(req.baselinePopulationHash), c = this.populationOf(req.candidatePopulationHash);
    if (!b || !c) throw new ProfileCheckError("NOT_FOUND", "both populations must already exist (correlate them first)");
    const verdictOf = (reasons: string[], rows: DeltaRow[], limitations: string[]): CompareProfilesResult =>
      ({ verdict: reasons.length ? "NOT_COMPARABLE" : rows.some((r) => Math.abs(r.shareChange) > 0.01) ? "DIFFERENCE_OBSERVED" : "NO_MATERIAL_DIFFERENCE", reasons, rows, populations: { baseline: b, candidate: c }, limitations });
    const reasons: string[] = [], limitations: string[] = [];
    if (b.sampleTypeKind !== c.sampleTypeKind) return verdictOf([`different metric kinds (${b.sampleTypeKind} versus ${c.sampleTypeKind}); CPU, wall and allocation are never compared as one number`], [], []);
    if (b.service !== c.service) return verdictOf(["different services; the populations do not describe the same system"], [], []);
    const bArtifact = b.chunkIds[0]?.split("#")[0] ?? "", cArtifact = c.chunkIds[0]?.split("#")[0] ?? "";
    if (bArtifact && cArtifact && bArtifact !== cArtifact) limitations.push("different profile artifacts; sampling periods may differ");
    if (!req.declareEquivalent) { /* same-revision/service checks above still hold */ } else {
      if (req.declareEquivalent.reason.trim().length < 4) throw new ProfileCheckError("INVALID_SCHEMA", "an equivalence declaration needs a stated reason of at least four characters");
      limitations.push(`equivalence declared by you: ${req.declareEquivalent.reason}`);
    }
    // The error-population gate (F05-A6). It reads the request/error counts the correlate recorded for each window.
    const bReq = b.requestCount ?? null, cReq = c.requestCount ?? null, bErr = b.errorCount ?? 0, cErr = c.errorCount ?? 0;
    if (bReq === null || cReq === null) return verdictOf(["no request population was recorded for one of the sides; per-request comparison is impossible without it"], [], ["run the correlate step with the trace source that served these windows"]);
    const bRate = bErr / bReq, cRate = cErr / cReq;
    const rateGap = Math.abs(cRate - bRate);
    if (rateGap > PROFILE_LIMITS.errorRateAbsolute || (Math.min(bRate, cRate) > 0 && Math.max(bRate, cRate) >= PROFILE_LIMITS.errorRateRelative * Math.min(bRate, cRate))) {
      return verdictOf([`error rates differ: baseline ${(bRate * 100).toFixed(1)}% of ${bReq} sampled requests, candidate ${(cRate * 100).toFixed(1)}% of ${cReq}; the same kind of population cannot be claimed while failed requests fell out of one side (F05-A6)`], [], limitations);
    }
    const rows = this.deltaRows(bArtifact, cArtifact, b, c, bReq, cReq, req.normalise);
    limitations.push("Single runs each: a difference observed once can suggest but never establish an effect; claims of effect need repeated paired runs.");
    if (b.collectionRatio !== undefined && c.collectionRatio !== undefined && Math.abs(b.collectionRatio - c.collectionRatio) > 0.2)
      limitations.push(`collection ratios differ (${Math.round(b.collectionRatio * 100)}% versus ${Math.round(c.collectionRatio * 100)}%); shares may be unevenly biased`);
    if (b.sampleCount < PROFILE_LIMITS.minSamplesForRanking || c.sampleCount < PROFILE_LIMITS.minSamplesForRanking)
      limitations.push(`one side has too few samples to rank (${b.sampleCount} and ${c.sampleCount} of at least ${PROFILE_LIMITS.minSamplesForRanking})`);
    return { verdict: rows.some((r) => Math.abs(r.shareChange) > 0.01) ? "DIFFERENCE_OBSERVED" : "NO_MATERIAL_DIFFERENCE", reasons, rows, populations: { baseline: b, candidate: c }, limitations };
  }

  private deltaRows(bArtifact: string, cArtifact: string, b: ProfilePopulation, c: ProfilePopulation, bReq: number, cReq: number, normalise: "PER_REQUEST" | "ABSOLUTE"): DeltaRow[] {
    const ordOf = (artifact: string, pop: ProfilePopulation): number => {
      const st = this.sampleTypesOf(artifact).find((s) => s.kind === pop.sampleTypeKind);
      return st?.ordinal ?? 0;
    };
    const agg = (artifact: string, ordinal: number) => new Map((this.store.db.prepare("select * from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ? and function_key not in ('__unattributed__','__withheld__')").all(artifact, ordinal) as Row[]).map((r) => [r.function_key, r]));
    const B = agg(bArtifact, ordOf(bArtifact, b)), C = agg(cArtifact, ordOf(cArtifact, c));
    const keys = [...new Set([...(B.keys()), ...(C.keys())])].sort();
    const out: DeltaRow[] = [];
    for (const key of keys) {
      const br = B.get(key), cr = C.get(key);
      const bval = fin(br?.self_value), cval = fin(cr?.self_value);
      const name = br?.name ?? cr?.name ?? key, file = br?.file ?? cr?.file ?? "";
      const norm = (v: number, req: number) => (normalise === "PER_REQUEST" && req > 0 ? v / req : v);
      const bShare = this.shareOf(b, key), cShare = this.shareOf(c, key);
      out.push({ functionKey: key, name, file, line: fin(br?.line) || fin(cr?.line) || 0,
        baselineValue: norm(bval, bReq), candidateValue: norm(cval, cReq),
        deltaPerRequest: norm(cval, cReq) - norm(bval, bReq), baselineShare: bShare, candidateShare: cShare, shareChange: cShare - bShare });
    }
    return out.sort((x, y) => Math.abs(y.deltaPerRequest) - Math.abs(x.deltaPerRequest)).slice(0, profileDeltaCap());
  }

  private shareOf(pop: ProfilePopulation, key: string): number {
    const artifact = pop.chunkIds[0]?.split("#")[0];
    if (!artifact) return 0;
    const st = this.sampleTypesOf(artifact).find((s) => s.kind === pop.sampleTypeKind);
    const total = (this.store.db.prepare("select coalesce(sum(self_value),0) v from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ?").get(artifact, st?.ordinal ?? 0) as Row).v;
    if (!(total > 0)) return 0;
    const row = this.store.db.prepare("select self_value from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ? and function_key = ?").get(artifact, st?.ordinal ?? 0, key) as Row | undefined;
    return fin(row?.self_value) / fin(total);
  }

  // ---------------------------------------------------------------- §7.7 orchestration: endpoints, exemplars, waterfalls (WP-11)

  /** Endpoint statistics from the recorded spans in a window: p50/p95, error rate and request counts of sampled traces. */
  endpointStats(req: { window: { from: number; to: number }; traceSourceId?: string; artifactHash?: string; viewRevision?: string }): { endpoints: EndpointStat[]; sampledTraces: number; disclosure: string[] } {
    const window = req.window, traceSourceId = req.traceSourceId;
    const ids = this.envelopesIn(window, traceSourceId);
    const disclosure = ["Counts describe sampled traces, not all traffic; the distribution is of what was recorded."];
    if (!ids.length) return { endpoints: [], sampledTraces: 0, disclosure };
    const byName = new Map<string, number[]>();
    const errs = new Map<string, number>();
    let roots = 0;
    for (const id of ids) {
      const spans = this.store.db.prepare("select * from rt_spans where envelope = ? and flags not like '%TIMESTAMP_IMPOSSIBLE%' order by start_ms, seq limit 5000").all(id) as Row[];
      const present = new Set(spans.map((s) => s.span_id));
      for (const s of spans) {
        if (s.parent_id && present.has(s.parent_id)) continue;
        roots++;
        const list = byName.get(s.name) ?? [];
        list.push(s.end_ms - s.start_ms);
        byName.set(s.name, list);
        errs.set(s.name, (errs.get(s.name) ?? 0) + (s.error ? 1 : 0));
      }
    }
    const endpoints = [...byName].map(([endpoint, durs]) => ({
      endpoint, count: durs.length, errorCount: errs.get(endpoint) ?? 0, p50Ms: pctile(durs, 50), p95Ms: pctile(durs, 95),
    })).sort((a, b) => (b.p50Ms ?? 0) - (a.p50Ms ?? 0)).slice(0, PROFILE_LIMITS.maxEndpoints);
    return { endpoints, sampledTraces: roots, disclosure };
  }

  private envelopesIn(window: { from: number; to: number }, sourceId?: string): string[] {
    return (this.store.db.prepare(`select id from rt_envelopes where win_to >= ? and win_from <= ? and rejected = 0 ${sourceId ? "and source = ? " : ""}order by win_from, id`).all(window.from, window.to, ...(sourceId ? [sourceId] : [])) as Row[]).map((r) => r.id);
  }

  /** Slow exemplars of one endpoint (the slowest two and one near the median — never only the slowest; §7.7.2). */
  pickExemplars(window: { from: number; to: number }, endpoint: string, traceSourceId: string): { traceId: string; durationMs: number }[] {
    const ids = this.envelopesIn(window, traceSourceId);
    const durations: { traceId: string; durationMs: number }[] = [];
    for (const id of ids) {
      const spans = this.store.db.prepare("select * from rt_spans where envelope = ? and flags not like '%TIMESTAMP_IMPOSSIBLE%' order by start_ms, seq limit 5000").all(id) as Row[];
      const present = new Set(spans.map((s) => s.span_id));
      for (const s of spans) {
        if (s.parent_id && present.has(s.parent_id)) continue;
        if (s.name !== endpoint) continue;
        durations.push({ traceId: s.trace_id, durationMs: s.end_ms - s.start_ms });
      }
    }
    const uniq = [...new Map(durations.map((d) => [d.traceId, d])).values()];
    const sorted = [...uniq].sort((a, b) => b.durationMs - a.durationMs).slice(0, 2);
    const medianOne = uniq.slice().sort((a, b) => a.durationMs - b.durationMs)[Math.floor((uniq.length - 1) / 2)];
    const out = [...sorted];
    if (medianOne && !out.some((d) => d.traceId === medianOne.traceId)) out.push(medianOne);
    return out.sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  }

  /**
   * The exemplar's waterfall: spans as bars with exclusive cost (union of children subtracted) and the longest chain
   * through the largest children marked as the critical path. Span categories are inferred from span names — labelled
   * as such in the narrative — and if most of the time is not CPU-shaped, the waterfall says so instead of guessing at causes.
   */
  waterfall(req: { window: { from: number; to: number }; traceSourceId: string; traceId?: string; endpoint?: string }): ProfileWaterfall2 {
    const exemplars = req.traceId ? [{ traceId: req.traceId, durationMs: 0 }] : (req.endpoint ? this.pickExemplars(req.window, req.endpoint, req.traceSourceId) : []);
    const traceId = req.traceId ?? exemplars[0]?.traceId;
    if (!traceId) throw new ProfileCheckError("INSUFFICIENT_EVIDENCE", "no recorded trace covers this window for that endpoint; nothing can be drawn");
    const envelopes = this.envelopesIn(req.window, req.traceSourceId);
    const seen = new Map<string, { spanId: string; parentId: string | null; name: string; startMs: number; endMs: number; error: number }>();
    void seen;
    for (const id of envelopes) {
      const rows = this.store.db.prepare("select * from rt_spans where envelope = ? and trace_id = ? and flags not like '%TIMESTAMP_IMPOSSIBLE%' order by start_ms, seq limit 2000").all(id, traceId) as Row[];
      for (const r of rows) if (!seen.has(r.span_id)) seen.set(r.span_id, { spanId: r.span_id, parentId: r.parent_id ?? null, name: r.name, startMs: r.start_ms, endMs: r.end_ms, error: r.error ? 1 : 0 });
    }
    const raw = [...seen.values()];
    if (!raw.length) throw new ProfileCheckError("NOT_FOUND", "that trace is not recorded in this window");
    const spans: TimedSpan[] = raw.map((r) => ({ id: r.spanId, parentId: raw.some((x) => x.spanId === r.parentId) ? r.parentId : null, entityId: null, startMs: r.startMs, endMs: r.endMs, revision: "", buildHash: "", workloadHash: "", clock: "wall", category: categoryOf(r.name) }));
    const costs = computeExclusiveCosts(spans);
    const byId = new Map(costs.spans.map((c) => [c.id, c]));
    const durOf = new Map(raw.map((r) => [r.spanId, r.endMs - r.startMs]));
    // Critical path: from the root, always through the longest child (inclusive); the longest chain of the request.
    const childrenOf = new Map<string | null, string[]>();
    for (const s of spans) childrenOf.set(s.parentId, [...(childrenOf.get(s.parentId) ?? []), s.id]);
    const longest = (ids: string[]) => [...ids].sort((a, b) => (durOf.get(b) ?? 0) - (durOf.get(a) ?? 0) || a.localeCompare(b))[0] ?? null;
    const path: string[] = [];
    let cur: string | null = longest(childrenOf.get(null) ?? []);
    while (cur) {
      path.push(cur);
      cur = longest(childrenOf.get(cur) ?? []);
    }
    const pathSet = new Set(path);
    const cpuTotal = spans.filter((s) => s.category === "CPU").reduce((n, s) => n + (byId.get(s.id)?.exclusiveMs ?? 0), 0);
    const rootInclusive = Math.max(...raw.map((r) => r.endMs - r.startMs), 1);
    const waitingNarrative = cpuTotal / rootInclusive < 0.5
      ? "Most of this request's time was not on this service's CPU: the long exclusive time sits in wait-shaped spans (I/O, locks, queues). Categories are inferred from span names."
      : null;
    const bySpanId = new Map(raw.map((r) => [r.spanId, r]));
    return {
      traceId,
      spans: spans.map((s) => { const r = bySpanId.get(s.id)!; const c = byId.get(s.id)!; return { spanId: s.id, parentId: s.parentId, name: r.name, startMs: s.startMs, durationMs: r.endMs - r.startMs, exclusiveMs: Math.max(0, c.exclusiveMs), category: s.category, onCriticalPath: pathSet.has(s.id), errors: r.error }; }),
      criticalPath: path, criticalPathDurationMs: path.reduce((n, id) => n + (durOf.get(id) ?? 0), 0), waitingNarrative,
      gaps: costs.gaps,
    };
  }

  // ---------------------------------------------------------------- §7.9 compile + bind (WP-07)

  /**
   * Compile a presentation view: the renderer's source of truth. Every metric item is bound to its template,
   * population, window and unit, and verified before it is allowed to be drawn (F05-A5); rejected items are returned
   * with their reasons so the panel can draw the explicit "unverified" placeholder instead.
   */
  async compileProfileView(req: { correlationId?: string; artifactHash?: string; kind: "HOTSPOT_TABLE" | "METRIC_TABLE" | "WATERFALL" | "TIMELINE" | "FLAMEGRAPH"; params?: { ordinal?: number; order?: "SELF" | "TOTAL"; limit?: number; cursor?: string; viewRevision?: string; traceSourceId?: string; traceId?: string; endpoint?: string; window?: { from: number; to: number } } }): Promise<{
    viewSpec: ProfileViewSpecT; presentationManifest: { manifestHash: string; items: MetricItem[]; checks: { itemId: string; verdict: "VERIFIED" | "REJECTED"; reasons: string[] }[] };
  }> {
    const artifacts = req.correlationId ? this.correlationArtifacts(req.correlationId) : req.artifactHash ? [req.artifactHash] : [];
    const hash = artifacts[0];
    if (!hash) throw new ProfileCheckError("INSUFFICIENT_EVIDENCE", "no profile population is known for this request; import a profile and correlate it first");
    const a = this.artifact(hash);
    const stypes = this.sampleTypesOf(hash);
    const base = { artifactHash: hash, revision: this.resolveRevision(hash).revision ?? undefined, revisionState: stateOf(this.store, hash), service: a.service, ingestState: a.ingest_state };
    const items: MetricItem[] = []; const unverified: { locator: string; reasons: string[] }[] = [];
    let viewSpec: ProfileViewSpecT;
    if (req.kind === "METRIC_TABLE") {
      const rows = stypes.map((st) => {
        const ordinal = st.ordinal;
        const agg = this.store.db.prepare("select coalesce(sum(self_value),0) v, coalesce(sum(sample_count),0) n from profile_function_agg where artifact_hash = ? and sample_type_ordinal = ?").get(hash, ordinal) as Row;
        return { ordinal, kind: st.kind, unit: st.unit, rawType: st.rawType, rawUnit: st.rawUnit, populationValue: fin(agg.v), sampleCount: Math.trunc(fin(agg.n)), present: true as const };
      });
      viewSpec = { kind: "METRIC_TABLE", title: `profile metrics — ${a.format}`, captions: ["Kinds are never summed or averaged together (F05-A3): each row is its own population."], ...base, metrics: rows, kindsPresent: [...new Set(stypes.map((s) => s.kind))] };
    } else if (req.kind === "WATERFALL") {
      if (!req.params?.window) throw new ProfileCheckError("INVALID_SCHEMA", "the waterfall needs the trace window it draws");
      const wf = this.waterfall({ window: req.params.window, traceSourceId: req.params.traceSourceId ?? a.service ?? "", traceId: req.params.traceId, endpoint: req.params.endpoint });
      viewSpec = { kind: "WATERFALL", title: `trace waterfall — ${wf.traceId.slice(0, 12)}`, captions: ["Bars show exclusive time shading; the critical path is the longest chain of the largest children."], ...base,
        waterfall: { traceId: wf.traceId, spans: wf.spans, criticalPath: wf.criticalPath, criticalPathDurationMs: wf.criticalPathDurationMs, waitingNarrative: wf.waitingNarrative } };
    } else if (req.kind === "TIMELINE") {
      const chunks = this.listArtifacts().filter((x) => !req.artifactHash || x.artifactHash === req.artifactHash).map((x) => ({ artifactHash: x.artifactHash, startNs: x.startNs, endNs: x.endNs, format: x.format, sampleCount: this.sampleCountOf(x.artifactHash), service: x.service }));
      viewSpec = { kind: "TIMELINE", title: "profile timeline", captions: ["Brush a window: the selection changes the population hash visibly; nothing is averaged across kinds."], ...base, timeline: { chunks, brushNote: "a brushed selection is a new population and says so with its hash" } };
    } else if (req.kind === "FLAMEGRAPH") {
      const st = req.params?.ordinal !== undefined ? this.sampleTypesOf(hash).find((s) => s.ordinal === req.params!.ordinal) : this.sampleTypesOf(hash)[0];
      const fl = await this.flamegraph({ artifactHash: hash, ordinal: st?.ordinal, viewRevision: req.params?.viewRevision });
      viewSpec = { kind: "FLAMEGRAPH", title: `flamegraph — ${st?.kind ?? "profile"}`, captions: [`A view of the hotspot table's totals; ${fl.prunedShare > 0 ? `${(fl.prunedShare * 100).toFixed(1)}% of samples live in frames too small to draw.` : "nothing was pruned."}`], ...base, flame: fl, kindOfMetric: st?.kind };
    } else {
      const res = this.queryHotspots({ artifactHash: hash, ordinal: req.params?.ordinal, order: req.params?.order, limit: req.params?.limit, cursor: req.params?.cursor, correlationId: req.correlationId, viewRevision: req.params?.viewRevision });
      viewSpec = { kind: "HOTSPOT_TABLE", title: `hotspots — ${res.unit}`, captions: [`Basis: measured profile samples; correlation grade ${res.grade}. Shares include unattributed frames; the table never sums kinds.`], ...base,
        rows: res.rows, populationHash: res.populationHash, buildWarning: stateOf(this.store, hash) === "MISMATCH" ? "This profile was collected from a build that does not match the viewed revision; function names are shown without source lines." : stateOf(this.store, hash) === "UNKNOWN" ? "The profile's build could not be resolved to a revision; source lines stay closed until a binding is known." : undefined };
      for (const r of res.rows) {
        if (r.functionKey === "__withheld__") continue;
        items.push(metricItem({
          locator: `hotspot:${hash}:${r.functionKey}`, templateId: "profile.hotspot.self", templateVersion: 1,
          value: r.selfShare, unit: "share", basis: "MEASURED_PROFILE",
          populationHash: res.populationHash, window: { fromNs: Math.floor(Number(a.start_ns)), toNs: Math.floor(Number(a.end_ns)) },
          sampleCount: res.sampleCount, populationValue: res.populationValue, artifactHash: hash,
          caveatIds: [`grade:${req.correlationId ? this.gradeFor(hash, req.correlationId) : "NONE"}`, `coverage:${JSON.stringify({ dropped: res.coverage.droppedSamples, truncated: res.coverage.truncatedStacks })}`],
        }));
      }
    }
    const manifest = { manifestHash: manifestHash(items), items, checks: [] as { itemId: string; verdict: "VERIFIED" | "REJECTED"; reasons: string[] }[] };
    manifest.checks = verifyMetricPresentation(manifest.items, this.verificationContext(base.revision ?? ""));
    return { viewSpec: viewSpec as ProfileViewSpecT, presentationManifest: manifest };
  }

  private sampleCountOf(artifactHash: string): number {
    return Math.trunc(fin((this.store.db.prepare("select coalesce(sum(sample_count),0) n from profile_function_agg where artifact_hash = ?").get(artifactHash) as Row).n));
  }

  private correlationArtifacts(correlationId: string): string[] {
    const row = this.store.db.prepare("select artifact_hash from profile_trace_links where link_id = ?").get(correlationId) as Row | undefined;
    return row ? [row.artifact_hash] : [];
  }

  verifyPresentation(items: MetricItem[], revision: string): { itemId: string; verdict: "VERIFIED" | "REJECTED"; reasons: string[] }[] {
    return verifyMetricPresentation(items, this.verificationContext(revision));
  }

  private verificationContext(revision: string): VerificationContext {
    return {
      templateOf: (id, v) => this.templates.of(id, v) ? { claimClass: this.templates.of(id, v)!.claimClass } : null,
      artifactExists: (h) => !!(h && this.store.db.prepare("select 1 from profile_artifacts where artifact_hash = ?").get(h)),
      unitOfArtifact: (h) => { try { return this.sampleTypesOf(h!).filter((s) => s.kind !== "OTHER").map((s) => s.unit)[0] ?? null; } catch { return null; } },
      populationOf: (h) => { const p = this.populationOf(h); return p ? { sampleCount: p.sampleCount, window: { fromNs: p.windowFromNs, toNs: p.windowToNs } } : null; },
      evidenceExists: (rev, id) => !!this.store.evidence(rev, id),
      revision,
    };
  }
}

// ---------------------------------------------------------------- module-level helpers (pure)

export interface ProfileWaterfall2 { traceId: string; spans: { spanId: string; parentId: string | null; name: string; startMs: number; durationMs: number; exclusiveMs: number; category: TimedSpan["category"]; onCriticalPath: boolean; errors: number }[]; criticalPath: string[]; criticalPathDurationMs: number; waitingNarrative: string | null; gaps: string[] }

/** Wilson 95% interval for s of n, exported for tests: what the ranked share rows show (indicative, likely too narrow). */
export function wilsonInterval(s: number, n: number, z = 1.96): [number, number] {
  if (!(n > 0) || !(s >= 0) || s > n) return [0, 1];
  const p = s / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const width = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, centre - width), Math.min(1, centre + width)];
}
const wilsonRow = (s: number, n: number): [number, number] => wilsonInterval(Math.max(0, s), Math.max(1, n));

const pctile = (xs: number[], p: number): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};

const overlapMs = (aFrom: number, aTo: number, bFrom: number, bTo: number): number | null => {
  const lo = Math.max(aFrom, bFrom), hi = Math.min(aTo, bTo);
  return hi > lo ? Math.floor(hi - lo) : null;
};

const profileDeltaCap = () => 200;

const categoryOf = (name: string): TimedSpan["category"] => {
  const n = name.toLowerCase();
  if (/db\.|sql|select |insert |update |redis|grpc|http|fetch|socket/i.test(n)) return "IO";
  if (/lock|mutex|fence|synchron/i.test(n)) return "LOCK";
  if (/queue|publish|consume|topic|event\./i.test(n)) return "QUEUE";
  if (/pool|worker|thread/i.test(n)) return "POOL";
  return "CPU";
};

const stateOf = (store: Store, hash: string): "MATCHED" | "MISMATCH" | "UNKNOWN" =>
  ((store.db.prepare("select revision_state from profile_mappings where artifact_hash = ? limit 1").get(hash) as Row | undefined)?.revision_state ?? "UNKNOWN");

const byteOffset = (buf: Buffer, line: number, col: number): number => {
  let off = 0, l = 1;
  while (l < line) { const nl = buf.indexOf(10, off); if (nl < 0) return buf.length; off = nl + 1; l++; }
  return Math.min(buf.length, off + Math.max(0, col - 1));
};

const relOf = (rev: RevisionRow, abs: string): string | undefined => {
  const p = resolve(rev.repoRoot, abs);
  const rel = relative(rev.repoRoot, p);
  return rel.startsWith("..") || !existsSync(p) ? undefined : rel.replace(/\\/g, "/");
};