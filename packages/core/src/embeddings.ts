// C10 semantic side of hybrid retrieval. An `Embedder` turns text into vectors; the index stores one vector per entity
// per revision, beside the data it describes (so it is deleted, backed up and tenant-scoped with it).
//
// The default embedder is local and deterministic: feature-hashed word and character-n-gram vectors. That is honest
// about what it is. It finds names and phrases that share sub-words ("authenticate" ~ "authentication", "charged" ~ "charge",
// "FraudRejectedError" ~ "fraud rejected"). It does not know that "billing" and "charge" are synonyms; a language-model
// embedder (OllamaEmbedder, same interface) is for that, and is only used when configured.
import type { Entity } from "@cie/schema";
import type { Store } from "./store.ts";

export interface Embedder { readonly name: string; readonly dim: number; embed(texts: string[]): Promise<Float32Array[]> | Float32Array[] }

const DIM = 384;
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/** camelCase / snake_case / paths → lower-case words. */
export function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}
const STOP = new Set(["src", "ts", "tsx", "js", "rs", "function", "method", "class", "lib", "index", "the", "and", "for", "are", "this", "that", "with", "from", "how", "does", "what", "why", "show", "can", "could", "would", "all", "about", "who", "which", "is", "do", "of", "in", "to", "an", "it", "my", "me", "when", "where", "happens"]);

export class HashEmbedder implements Embedder {
  readonly name = "local-hashed-ngrams"; readonly dim = DIM;
  embed(texts: string[]): Float32Array[] {
    return texts.map((t) => {
      const v = new Float32Array(DIM);
      const add = (feat: string, w: number) => { const h = fnv(feat); v[h % DIM] += ((h >>> 16) & 1 ? 1 : -1) * w; };
      const ws = words(t).filter((w) => !STOP.has(w));
      for (const w of ws) {
        add("w:" + w, 1.0);
        const padded = `^${w}$`;
        for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= padded.length; i++) add(`c${n}:${padded.slice(i, i + n)}`, n === 3 ? 0.3 : n === 4 ? 0.6 : 0.8);
      }
      for (let i = 0; i + 1 < ws.length; i++) add(`b:${ws[i]}_${ws[i + 1]}`, 0.6);
      let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < DIM; i++) v[i] /= norm;
      return v;
    });
  }
}

/** A language-model embedder through a local Ollama daemon (/api/embed). Same interface; used only when configured. */
export class OllamaEmbedder implements Embedder {
  readonly name: string; dim = 0; private baseUrl: string; private model: string;
  constructor(opts: { baseUrl?: string; model?: string } = {}) { this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, ""); this.model = opts.model ?? "nomic-embed-text"; this.name = `ollama/${this.model}`; }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.model, input: texts }) });
    if (!res.ok) throw new Error(`embedding request failed (${res.status})`);
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new Error("embedding reply had the wrong shape");
    return body.embeddings.map((e) => { const v = Float32Array.from(e); this.dim = v.length; let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; });
  }
}

export const cosine = (a: Float32Array, b: Float32Array) => { if (a.length !== b.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** The text an entity is known by: its name, where it lives, what it throws and writes, and what concept cards say about it. */
export function entityText(store: Store, rev: string, e: Entity, cardText: Map<string, string>): string {
  const facts = store.factsFor(rev, e.entityId).filter((f) => ["throws", "writes", "publishes", "subscribes"].includes(f.predicate)).map((f) => `${f.predicate} ${String((f.object as any).value ?? "")}`);
  return [e.name, e.name, e.name, e.file.replace(/\.[a-z0-9]+$/, ""), ...facts, cardText.get(e.entityId) ?? ""].join(" ");
}

/** One vector per symbol, stored. Built once per revision and embedder; a different embedder gets its own index. */
export async function ensureIndex(store: Store, rev: string, embedder: Embedder): Promise<number> {
  const tag = `__model:${embedder.name}`;
  const have = store.embeddings(rev);
  if (have.some((r) => r.entityId === tag)) return have.length - 1;
  const cards = new Map<string, string>();
  for (const c of store.concepts(rev)) for (const m of c.members) cards.set(m, `${cards.get(m) ?? ""} ${c.title} ${c.summary}`);
  const ents = store.entities(rev).filter((e) => ["function", "method", "class", "interface", "type"].includes(e.kind));
  const vecs = await embedder.embed(ents.map((e) => entityText(store, rev, e, cards)));
  const marker = new Float32Array(embedder.dim || vecs[0]?.length || 1);
  store.tx(() => { store.db.prepare("delete from embeddings where revision = ?").run(rev); });
  store.putEmbeddings(rev, [...ents.map((e, i) => ({ entityId: e.entityId, vec: vecs[i] })), { entityId: tag, vec: marker }]);
  return ents.length;
}

export interface Semantic { id: string; value: number; reason: string }
/** Entities closest to the question, above a similarity floor. `value` is on 0..1 and feeds the same TASK_MATCH factor as exact name hits. */
export async function semanticScores(store: Store, rev: string, question: string, embedder: Embedder, opts: { floor?: number; top?: number } = {}): Promise<Map<string, Semantic>> {
  await ensureIndex(store, rev, embedder);
  const [q] = await embedder.embed([question]);
  const names = new Map(store.entities(rev).map((e) => [e.entityId, e.name]));
  const scored = store.embeddings(rev).filter((r) => !r.entityId.startsWith("__model:")).map((r) => ({ id: r.entityId, sim: cosine(q, r.vec) })).filter((x) => x.sim >= (opts.floor ?? 0.2)).sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id)).slice(0, opts.top ?? 25);
  return new Map(scored.map((x) => [x.id, { id: x.id, value: Math.min(1, x.sim * 1.6), reason: `semantically close to the question (similarity ${x.sim.toFixed(2)}, ${embedder.name}): ${names.get(x.id) ?? x.id}` }]));
}
