// Loads the functions of a revision with their source text, so detectors work on exactly what was indexed and every finding
// can cite the bytes it came from. Evidence for a span is stored like any other code evidence and resolves through the same
// path (a changed file reads as STALE).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Entity, EvidenceRef } from "@cie/schema";
import { policyFor } from "../access.ts";
import type { RevisionRow, Store } from "../store.ts";
import { scanFunction, type Lang, type Scan } from "./source.ts";

export interface FindingSpan { file: string; startByte: number; endByte: number; line: number; text: string }
export interface Fn { entity: Entity; file: string; lang: Lang; src: string; start: number; end: number; scan: Scan; fileHash: string }
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Which scanner reads a file: TypeScript, Rust, Java, Go and Python are scanned; anything else is not. */
export const langOf = (file: string): Lang | null => /\.(ts|tsx|mts|cts)$/.test(file) ? "ts" : /\.(rs|nir)$/.test(file) ? "rust" : file.endsWith(".java") ? "java" : file.endsWith(".go") ? "go" : file.endsWith(".py") ? "python" : null;

/**
 * Lock identity is the written expression, which is only meaningful inside one scope: a Java class, a Go package (directory), a Python module.
 * Without a scope, `accounts` in one class and `accounts` in another language's module would be one lock. TypeScript and Rust keep the written
 * expression, as before (their locks are often shared through imports).
 */
function scopeLocks(scan: Scan, tag: string) {
  const q = (l: string) => `${l}@${tag}`; const qs = (a: string[]) => a.map(q);
  for (const a of scan.acquisitions) { a.lock = q(a.lock); a.heldBefore = qs(a.heldBefore); }
  for (const c of scan.calls) c.held = qs(c.held);
  for (const l of scan.loops) l.held = qs(l.held);
  for (const a of scan.awaits) a.held = qs(a.held);
  for (const r of scan.releases) r.lock = q(r.lock);
  scan.locksHeldAtEnd = qs(scan.locksHeldAtEnd);
}

export function loadFunctions(store: Store, rev: RevisionRow, only?: Set<string>): Map<string, Fn> {
  const access = policyFor(store, rev.repoRoot);
  const out = new Map<string, Fn>(); const cache = new Map<string, Buffer | null>(); const pyLocks = new Map<string, Set<string>>();
  for (const e of store.entities(rev.id)) {
    if (e.kind !== "function" && e.kind !== "method") continue;
    if (only && !only.has(e.entityId)) continue;
    if (access.denied(e.file)) continue;
    const lang = langOf(e.file); if (!lang) continue;
    // Test code is not what these detectors are about: a test that takes a lock or loops over a query is not a defect in the product.
    if ((lang === "java" || lang === "go" || lang === "python") && (/(^|\/)(tests?|__tests__)\//.test(e.file) || /(_test\.go|Test\.java|Tests\.java|IT\.java|test_\w+\.py|_test\.py)$/.test(e.file))) continue;
    const span = e.spans[0]; if (!span) continue;
    let buf = cache.get(e.file);
    if (buf === undefined) { try { buf = readFileSync(resolve(rev.repoRoot, e.file)); } catch { buf = null; } cache.set(e.file, buf); }
    if (!buf) continue;
    const src = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    let locks = pyLocks.get(e.file);
    if (locks === undefined) { locks = new Set(); if (lang === "python") for (const m of buf.toString("utf8").matchAll(/\b(?:self\.)?(\w+)\s*(?::[^=\n]+)?=\s*(?:\w+\.)*(?:R?Lock|Semaphore|BoundedSemaphore|Condition|Event)\s*\(/g)) locks.add(m[1]); pyLocks.set(e.file, locks); }
    out.set(e.entityId, { entity: e, file: e.file, lang, src, start: span.startByte, end: span.endByteExclusive, scan: scanFunction(src, lang, locks), fileHash: hash(buf) });
    if (lang === "java" || lang === "python") scopeLocks(out.get(e.entityId)!.scan, e.file.split("/").pop()!);
    else if (lang === "go") scopeLocks(out.get(e.entityId)!.scan, e.file.split("/").slice(-2, -1)[0] ?? "main");
  }
  return out;
}

/** Absolute byte offset of a position inside a function's text (the scanner works in characters; ASCII source makes them equal, otherwise it converts). */
export function absOffset(fn: Fn, rel: number): number { return fn.start + Buffer.byteLength(fn.src.slice(0, rel), "utf8"); }

export function spanOf(fn: Fn, rel: number, len: number): FindingSpan {
  const a = absOffset(fn, rel), b = absOffset(fn, Math.min(fn.src.length, rel + len));
  return { file: fn.file, startByte: a, endByte: b, line: fn.src.slice(0, rel).split("\n").length + 0, text: fn.src.slice(rel, rel + len).split("\n")[0].trim().slice(0, 160) };
}
/** Line in the file (not in the function) of a position in the function. */
export function fileLine(store: Store, rev: RevisionRow, fn: Fn, rel: number): number {
  try { const buf = readFileSync(resolve(rev.repoRoot, fn.file)); return buf.subarray(0, absOffset(fn, rel)).toString("utf8").split("\n").length; } catch { return 0; }
}

/** Code-location evidence for a span, stored for the revision so it can be opened and checked like any other evidence. */
export function spanEvidence(store: Store, rev: RevisionRow, fn: Fn, rel: number, len: number): EvidenceRef {
  const a = absOffset(fn, rel), b = absOffset(fn, Math.min(fn.src.length, rel + Math.max(1, len)));
  const id = "ev:" + hash(`${rev.id}|${fn.file}|${a}|${b}|defect`).slice(0, 16);
  const ev: EvidenceRef = {
    id, sourceId: fn.file, location: { kind: "CodeLocation", span: { sourceId: fn.file, contentHash: fn.fileHash, revision: rev.id, startByte: a, endByteExclusive: b } },
    class: "STATIC_PARSED", observedAt: new Date().toISOString(), accessScopeId: "local", state: "CURRENT",
  };
  store.putEvidence(rev.id, ev);
  return ev;
}
