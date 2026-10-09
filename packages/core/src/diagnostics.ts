// Temporary detailed diagnostics. JSONL records share async request context; never dump source bundles.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { detectSecret } from "./policy.ts";
import type { EvidenceBundle } from "@cie/schema";

type Level = "debug" | "info" | "warn" | "error";
const ranks = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };
const context = new AsyncLocalStorage<Record<string, unknown>>();
let sinkFailureReported = false;

export function withDiagnostics<T>(fields: Record<string, unknown>, run: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, run);
}

export function diagnosticsEnabled(level: Level = "debug"): boolean {
  const configured = process.env.CIE_LOG_LEVEL ?? "debug";
  return ranks[level] >= (ranks[configured as keyof typeof ranks] ?? ranks.debug);
}

/** Also used on error messages and model captions, which may echo inputs. */
export function sanitizeDiagnostic(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") {
    const masked = value.replace(/\b(?:bearer|basic)\s+\S+/gi, "[REDACTED authorization]")
      .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s,"';}]+/gi, "$1=[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
    if (detectSecret(masked)) return "[REDACTED secret-like string]";
    return masked.length > 8000 ? `${masked.slice(0, 8000)}… [truncated ${masked.length} characters]` : masked;
  }
  if (!value || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
  if (seen.has(value)) return "[circular]";
  if (depth >= 12) return "[depth limit]";
  seen.add(value);
  try {
    if (value instanceof Error) return sanitizeDiagnostic({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, seen, depth + 1);
    if (Array.isArray(value)) return value.map((v) => sanitizeDiagnostic(v, seen, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key,
      /^(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|idempotencyKey|source|snippet|source_excerpt|instructions|messages|body|headers)$/i.test(key)
        ? "[REDACTED]" : sanitizeDiagnostic(val, seen, depth + 1)]));
  } finally { seen.delete(value); }
}

export function diagnostic(event: string, fields: Record<string, unknown> = {}, level: Level = "debug"): void {
  if (!diagnosticsEnabled(level)) return;
  try {
    const configured = Number(process.env.CIE_LOG_MAX_BYTES ?? 10485760);
    const limit = Number.isFinite(configured) && configured >= 1024 ? configured : 10485760;
    const envelope = { ...context.getStore(), time: new Date().toISOString(), pid: process.pid, level, event };
    let line = JSON.stringify(sanitizeDiagnostic({ ...fields, ...envelope })) + "\n";
    if (Buffer.byteLength(line) > Math.min(limit, 262144)) {
      line = JSON.stringify(sanitizeDiagnostic({ ...envelope, detailsOmitted: "record exceeded size limit", originalBytes: Buffer.byteLength(line) })) + "\n";
    }
    if (process.env.CIE_LOG_STDERR !== "0") process.stderr.write(line);
    if (process.env.CIE_LOG_FILE === "off") return;
    const file = resolve(process.env.CIE_LOG_FILE || ".cie/logs/diagnostics.jsonl");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > limit) {
      for (let i = 2; i >= 0; i--) {
        const from = i ? `${file}.${i}` : file;
        if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
      }
    }
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // A full disk or invalid path must never change an API result.
    if (!sinkFailureReported) {
      sinkFailureReported = true;
      process.stderr.write('{"level":"warn","event":"diagnostics.write_failed"}\n');
    }
  }
}

export function bundleDiagnostics(bundle: EvidenceBundle) {
  const counts = (values: string[]) => values.reduce<Record<string, number>>((out, key) => { out[key] = (out[key] ?? 0) + 1; return out; }, {});
  return { id: bundle.id, revision: bundle.revision, tokenEstimate: bundle.tokenEstimate,
    entityCount: bundle.entities.length, entityKinds: counts(bundle.entities.map((e) => e.kind)),
    entities: bundle.entities.map((e) => ({ id: e.entityId, name: e.name, kind: e.kind, file: e.file })),
    relationshipCount: bundle.relationships.length, relationshipKinds: counts(bundle.relationships.map((r) => r.kind)),
    relationships: bundle.relationships.map((r) => ({ id: r.id, from: r.from, to: r.to, kind: r.kind, evidenceIds: r.evidence.map((e) => e.id) })),
    factCount: bundle.facts.length, factPredicates: counts(bundle.facts.map((f) => f.predicate)),
    evidenceCount: bundle.evidence.length, coverage: bundle.coverage, unresolved: bundle.unresolved };
}
