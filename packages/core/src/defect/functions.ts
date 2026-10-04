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

export function loadFunctions(store: Store, rev: RevisionRow, only?: Set<string>): Map<string, Fn> {
  const access = policyFor(store, rev.repoRoot);
  const out = new Map<string, Fn>(); const cache = new Map<string, Buffer | null>();
  for (const e of store.entities(rev.id)) {
    if (e.kind !== "function" && e.kind !== "method") continue;
    if (only && !only.has(e.entityId)) continue;
    if (access.denied(e.file)) continue;
    // The detectors read TypeScript and Rust source. Java, Go and Python are indexed, but these detectors do not read them yet.
    if (!/\.(ts|tsx|mts|cts|rs|nir)$/.test(e.file)) continue;
    const span = e.spans[0]; if (!span) continue;
    let buf = cache.get(e.file);
    if (buf === undefined) { try { buf = readFileSync(resolve(rev.repoRoot, e.file)); } catch { buf = null; } cache.set(e.file, buf); }
    if (!buf) continue;
    const src = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    const lang: Lang = e.file.endsWith(".rs") ? "rust" : "ts";
    out.set(e.entityId, { entity: e, file: e.file, lang, src, start: span.startByte, end: span.endByteExclusive, scan: scanFunction(src, lang), fileHash: hash(buf) });
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
