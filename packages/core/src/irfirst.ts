// IR-first model contexts: the model reads *stored structure*, not source re-parses. Three pull
// primitives (plan: "IR-first, source-on-demand" — dlta UC validation §questions):
//   - renderIrs     — deterministic pseudocode projections of stored IR dumps (worker irRender)
//   - similarOf     — cosine over the stored structural vectors (irVec), rename-stable
//   - conceptIrView — a concept card: name + member IRs, the unit the model is grounded in
// Like the parse/fold/motif batches, the heavy lifting (rendering) is a one-shot worker call; this
// module is a thin router and throws when the worker is missing — no TypeScript re-implementation.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defaultWorkerPath } from "./worker.ts";
import type { Store } from "./store.ts";

export interface RenderedIr {
  entityId: string;
  name: string;
  file: string;
  /** Pseudocode (with the legend header), or null when the dump was absent/unparsable. */
  render: string | null;
}

/** One batched render in the Rust worker; throws on failure (no TS fallback, like the fold). */
export function renderIrs(entries: { entityId: string; name?: string; file?: string; irDump: string }[], maxLines?: number): RenderedIr[] {
  if (entries.length === 0) return [];
  const input = `${tmpdir()}/cie-irrender-${process.pid}-${randomUUID()}.json`;
  writeFileSync(input, JSON.stringify({ maxLines, entities: entries.map((e) => ({ entityId: e.entityId, irDump: e.irDump })) }));
  const r = spawnSync(defaultWorkerPath(), ["irRender", input], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  let parsed: { results?: { entityId: string; render: string | null }[]; error?: { code: string; message: string } } | null = null;
  try { parsed = r.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch { /* fall through to the error below */ }
  if (parsed?.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  if (!parsed?.results || !Array.isArray(parsed.results)) {
    throw new Error(`worker irRender failed (exit ${r.status}${r.stderr ? `: ${String(r.stderr).slice(0, 200)}` : ""})`);
  }
  return entries.map((e) => {
    const found = parsed!.results!.find((x) => x.entityId === e.entityId);
    return { entityId: e.entityId, name: e.name ?? e.entityId, file: e.file ?? "", render: found?.render ?? null };
  });
}

/** Cosine over stored sparse vectors, flattened `[dim0, val0, dim1, val1, …]` (values ×100). */
export function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a?.length || !b?.length) return 0;
  let dot = 0, na = 0, nb = 0;
  const B = new Map<number, number>();
  for (let i = 0; i + 1 < b.length; i += 2) B.set(b[i], b[i + 1]);
  for (let i = 0; i + 1 < a.length; i += 2) {
    const va = a[i + 1], vb = B.get(a[i]);
    dot += va * (vb ?? 0);
    na += va * va;
  }
  for (const v of B.values()) nb += v * v;
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm > 0 ? dot / norm : 0;
}

export interface Similar {
  entityId: string; name: string; file: string; kind: string; similarity: number;
}

/** Structurally nearest stored symbols by irVec cosine — "code shaped like this", across renames. */
export function similarOf(store: Store, revision: string, entityId: string, topK = 8): Similar[] {
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) throw new Error("topK must be an integer in 1..50");
  const vecs = store.irVecs(revision);
  const self = vecs.get(entityId);
  if (!self && !store.entitiesById(revision, [entityId]).length) {
    throw new Error(`no such code element in this revision: ${entityId}`);
  }
  if (!self) return []; // the element exists but nothing was indexed as structure yet — an honest empty
  const out: Similar[] = [];
  for (const [id, { vec, kind, name, file }] of vecs) {
    if (id === entityId) continue;
    const s = cosine(self.vec, vec);
    if (s <= 0) continue;
    out.push({ entityId: id, name, file, kind, similarity: Math.round(s * 1000) / 1000 });
  }
  out.sort((a, b) => b.similarity - a.similarity || (a.entityId < b.entityId ? -1 : 1));
  return out.slice(0, topK);
}

export interface ConceptIrView {
  conceptId: string;
  name: string | null;
  kind: string;
  /** Every member; entries beyond the render budget carry their header without an IR body. */
  members: RenderedIr[];
  renderedCount: number;
}

/** A concept card with its members' rendered IR — the IR-first unit a conversation is grounded in. */
export function conceptIrView(
  store: Store, revision: string, conceptId: string,
  opts: { maxMembers?: number; maxLines?: number } = {},
): ConceptIrView | null {
  const maxMembers = opts.maxMembers ?? 12;
  const cluster = store.conceptClusters(revision).find((c) => c.conceptId === conceptId);
  if (!cluster) return null;
  const shown = cluster.memberEntityIds.slice(0, maxMembers);
  const ents = store.entitiesById(revision, shown);
  const byId = new Map(ents.map((e) => [e.entityId, e]));
  const renderable = shown.filter((id) => (byId.get(id)?.irDump ?? "").length > 0);
  const rendered = new Map(renderIrs(renderable.map((id) => ({
    entityId: id, name: byId.get(id)!.name, file: byId.get(id)!.file, irDump: byId.get(id)!.irDump!,
  })), opts.maxLines).map((r) => [r.entityId, r]));
  const memberOf = (id: string): RenderedIr => {
    const e = byId.get(id);
    const r = rendered.get(id);
    return r ?? { entityId: id, name: e?.name ?? id, file: e?.file ?? "", render: null };
  };
  return {
    conceptId: cluster.conceptId, name: cluster.name, kind: cluster.kind,
    members: cluster.memberEntityIds.map(memberOf), renderedCount: rendered.size,
  };
}