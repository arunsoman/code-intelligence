// Trace export ingestion (post-MVP FR-13: trace/log adapters, no live daemon). The repository can
// carry an OpenTelemetry-style export under well-known paths (`traces/otlp.json`, `.traces/*.json`,
// `coverage/traces.json`); spans carry code attributes, durations and error status. Spans are
// attached to entities as OBSERVED facts; like coverage, these are files the project's own tooling
// produced earlier — nothing is polled or replayed live, and stale exports are flagged.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Entity, EvidenceRef, Fact } from "@cie/schema";
import type { RevisionRow, Store } from "./store.ts";
import { locateFrames, type Frame } from "./trace.ts";

const TRACE_PATHS = ["traces/otlp.json", ".traces/traces.json", "coverage/traces.json", "traces.json"];
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SPANS = 10_000;

export interface RawSpan { name: string; startMs: number; endMs: number; error: boolean; file?: string; line?: number; fn?: string }
export interface SpanStat { op: string; count: number; errors: number; p50: number | null; p95: number | null }
export interface SpanSummary { found: string[]; spans: number; errors: number; p50: number | null; p95: number | null; staleness: string[] }

const msOf = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; // OTLP JSON exports big ns timestamps as strings
  if (!Number.isFinite(n)) return null;
  return n > 1e14 ? n / 1e6 : n; // UnixNano → ms when the magnitude says so
};

/** Accept the OTLP wire shape (`resourceSpans`→`scopeSpans`→`spans`) and flat `{spans:[...]}` exports. */
export function parseOtlpSpans(json: any): RawSpan[] {
  const spans: any[] = [];
  const visit = (x: any) => {
    if (!x || typeof x !== "object" || spans.length >= MAX_SPANS * 2) return;
    if (Array.isArray(x)) { for (const y of x) visit(y); return; }
    if (x.resourceSpans) { visit(x.resourceSpans); return; }
    if (x.scopeSpans) { visit(x.scopeSpans); return; }
    if (Array.isArray(x.spans)) { for (const y of x.spans) visit(y); return; }
    const start = msOf(x.startTimeUnixNano) ?? msOf(x.startTimeUnixMs) ?? msOf(x.startTime);
    const end = msOf(x.endTimeUnixNano) ?? msOf(x.endTimeUnixMs) ?? msOf(x.endTime);
    if (x.name !== undefined && start !== null && end !== null) spans.push(x);
  };
  visit(json);
  const attr = (s: any, names: string[]): string | undefined => {
    const a = s.attributes;
    if (Array.isArray(a)) {
      for (const want of names) { const hit = a.find((x: any) => x?.key === want); if (hit) { const v = hit?.value?.stringValue ?? hit?.value?.intValue; if (v !== undefined && v !== null) return String(v); } }
      return undefined;
    }
    for (const want of names) if (a?.[want] !== undefined) return String(a[want]);
    return undefined;
  };
  const out: RawSpan[] = [];
  for (const s of spans.slice(0, MAX_SPANS)) {
    const start = msOf(s.startTimeUnixNano) ?? msOf(s.startTimeUnixMs) ?? msOf(s.startTime)!;
    const end = msOf(s.endTimeUnixNano) ?? msOf(s.endTimeUnixMs) ?? msOf(s.endTime)!;
    const file = attr(s, ["code.filepath", "source.file", "code.file"])?.replace(/\\/g, "/");
    const line = Number(attr(s, ["code.lineno", "code.line", "source.line"]));
    const fn = attr(s, ["code.function", "code.function.name"]);
    const status = s.status?.code ?? s.status; // OTel: 1/UNSET ok, 2/ERROR error
    const code = typeof status === "number" ? status : Number(status);
    const error = code === 2 || String(status ?? "").toUpperCase() === "ERROR";
    out.push({ name: String(s.name ?? "span"), startMs: start, endMs: end, error, file: file && file !== "undefined" ? file : undefined, line: Number.isInteger(line) && line > 0 ? line : undefined, fn: fn && fn !== "undefined" ? fn : undefined });
  }
  return out;
}

/** Additional per-span files in a `.traces/` directory (bounded), e.g. `.traces/2026-09-29.json`. */
function tracesDir(root: string): string[] {
  const dir = join(root, ".traces");
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, 5).map((f) => `.traces/${f}`); } catch { return []; }
}

const mtimeOfSources = (root: string, files: string[]): number => {
  let t = 0;
  for (const f of files) { try { t = Math.max(t, statSync(resolve(root, f)).mtimeMs); } catch { /* ignore */ } }
  return t;
};

const pct = (durs: number[], p: number): number | null => {
  const s = [...durs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};

export function ingestTraceExports(store: Store, rev: RevisionRow, at = new Date().toISOString()): SpanSummary | null {
  const root = rev.repoRoot;
  const found: string[] = [];
  const staleness: string[] = [];
  let spans: RawSpan[] = [];
  for (const rel of [...TRACE_PATHS, ...tracesDir(root)]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).size > MAX_BYTES) { staleness.push(`${rel} is too large and was skipped`); continue; }
      const parsed = parseOtlpSpans(JSON.parse(readFileSync(abs, "utf8")));
      if (parsed.length) { spans = [...spans, ...parsed]; found.push(rel); }
      if (mtimeOfSources(root, store.entities(rev.id).filter((e) => e.kind === "file").map((e) => e.file)) > statSync(abs).mtimeMs + 1000) {
        staleness.push(`${rel} is older than the newest source file; trace data may be out of date`);
      }
    } catch { staleness.push(`${rel} could not be parsed`); }
  }
  if (!spans.length) return null;
  const entities = store.entities(rev.id);
  const window0 = Math.min(...spans.map((s) => s.startMs)), window1 = Math.max(...spans.map((s) => s.endMs));
  const bucket = new Map<string, { name: string; count: number; errors: number; durs: number[]; startMs: number; endMs: number }>();
  let unmapped = 0;
  for (const s of spans) {
    let f = s.file;
    if (f && isAbsolute(f)) { const rel = relative(root, f); if (!rel.startsWith("..") && !isAbsolute(rel)) f = rel; }
    const frame: Frame = { fn: s.fn, file: f ?? "", line: s.line ?? 1, col: 1, raw: s.name };
    const located = s.file ? locateFrames(store, rev, { errorClass: null, message: "", frames: [frame] }, entities) : [];
    const id = located[0]?.entityId ?? (s.fn
      ? entities.find((e) => ["function", "method"].includes(e.kind) && (e.name.toLowerCase() === s.fn!.toLowerCase() || e.name.split(".").pop()?.toLowerCase() === s.fn!.toLowerCase()))?.entityId ?? null
      : null);
    if (!id) { unmapped++; continue; }
    const b = bucket.get(id) ?? { name: s.name, count: 0, errors: 0, durs: [], startMs: window0, endMs: window1 };
    b.count++; if (s.error) b.errors++; b.durs.push(s.endMs - s.startMs); bucket.set(id, b);
  }
  const sha = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 16);
  const facts: Fact[] = [];
  for (const [id, b] of bucket) {
    const ev: EvidenceRef = { id: `ev:${sha(rev.id + "span" + id)}`, sourceId: found[0] ?? "traces", location: { kind: "DocumentLocation", documentId: found[0] ?? "traces", version: at, locator: `trace export: ${b.count} span(s) for ${id}` }, class: "TEST", observedAt: at, accessScopeId: "local", state: "CURRENT" };
    facts.push({
      id: `fact:span:${id}`, subject: id, predicate: "span", resolution: "OBSERVED",
      object: { kind: "ScalarValue", value: { op: b.name, count: b.count, errors: b.errors, p50: pct(b.durs, 50), p95: pct(b.durs, 95), from: new Date(b.startMs).toISOString(), until: new Date(b.endMs).toISOString() } },
      evidence: [ev],
    });
  }
  store.replaceFactsBySource(rev.id, "fact:span:", facts);
  if (unmapped) staleness.push(`${unmapped} span(s) did not name indexed code and were not drawn`);
  const allDurs = spans.map((s) => s.endMs - s.startMs);
  return { found, spans: spans.length, errors: spans.filter((s) => s.error).length, p50: pct(allDurs, 50), p95: pct(allDurs, 95), staleness };
}