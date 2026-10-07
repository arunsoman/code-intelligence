// LLM naming (plan §0.7): the model NAMES concepts; it never asserts anything about them. Consequences
// this file is built around:
//   - naming requests go to the model gateway for budget and egress control, but the result is a label,
//     never a claim: this file imports nothing from claims.ts and writes nothing to claims or verdicts.
//   - labels are cached; the cache key is conceptId + canonicalMotifHash + modelVersion + promptVersion,
//     so the same shape under the same model is never re-asked.
//   - traversal is post-order: part concepts (compositionRule null) are named before the concepts
//     composed from them, so a transfer is named knowing what its sides are called.
//   - any failure falls back to a mechanical label marked FALLBACK; the run never blocks on the model.
import type { ArchConcept, SemanticConcept } from "@cie/schema";
import type { Store } from "../store.ts";
import { conceptConfig } from "./config.ts";
import type { NamingRequest } from "./types.ts";

export interface NamingAdapter {
  /** What the cache key names as the model: provider/model string. */
  modelVersion: string;
  /** One naming request. Returns names, or null when the model is unavailable. */
  name(req: { purpose: "NAME_CONCEPT" | "NAME_ARCH"; question: string; items: NamingRequest[] }): Promise<{ conceptId: string; name: string }[] | null>;
}

export interface NamingResult {
  concepts: SemanticConcept[];
  arch: ArchConcept[];
  named: number;
  fallback: number;
  cacheHits: number;
}

const mechanicalLabel = (kind: string, members: { name: string }[], variable: string | null): string => {
  const base = members[0]?.name ?? "code";
  const withVar = variable && !kind.includes(variable) ? ` of ${variable}` : "";
  return `${kind} (${base}${withVar})`.slice(0, 60);
};

export async function nameConcepts(
  store: Store,
  opts: {
    concepts: SemanticConcept[];
    arch: ArchConcept[];
    adapter: NamingAdapter;
    /** Variable each concept's decisive motif bound, for label quality only. */
    variables?: Map<string, string>;
  },
): Promise<NamingResult> {
  const cfg = conceptConfig();
  const promptVersion = cfg.namingPromptVersion.value;
  const cacheKey = (id: string, hash: string) => `${id}|${hash}|${opts.adapter.modelVersion}|${promptVersion}`;
  const out: SemanticConcept[] = [];
  const archOut: ArchConcept[] = [];
  let named = 0, fallback = 0, cacheHits = 0;

  // Post-order: plain concepts first, composed after (their names may reference the parts).
  const rank = (c: SemanticConcept) => (c.compositionRule ? 1 : 0);
  const ordered = [...opts.concepts].sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  const pending: { concept: SemanticConcept; cacheKey: string }[] = [];
  for (const c of ordered) {
    const key = cacheKey(c.id, c.canonicalMotifHash);
    const hit = store.namingCacheGet(key);
    if (hit) { cacheHits++; out.push({ ...c, label: hit.label, namedBy: hit.namedBy }); continue; }
    pending.push({ concept: c, cacheKey: key });
  }

  const batchSize = cfg.namingBatchSize.value;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const withMembers: NamingRequest[] = batch.map(({ concept }) => ({
      conceptId: concept.id, kind: concept.kind, features: concept.features, compositionRule: concept.compositionRule,
      members: concept.members.map((m) => ({ entityId: m, name: opts.variables?.get(m) ?? m.split("#").pop() ?? m, file: "" })),
    }));
    let names: { conceptId: string; name: string }[] | null = null;
    try { names = await opts.adapter.name({ purpose: "NAME_CONCEPT", question: JSON.stringify({ concepts: withMembers }), items: withMembers }); }
    catch { names = null; }
    const got = new Map((names ?? []).map((n) => [n.conceptId, n.name]));
    for (const { concept, cacheKey: key } of batch) {
      const model = got.get(concept.id);
      const members = withMembers.find((w) => w.conceptId === concept.id)?.members ?? [];
      const label = model && model.trim() ? model.trim().slice(0, 60) : mechanicalLabel(concept.kind, members, null);
      const namedBy = model && model.trim() ? "MODEL" : "FALLBACK";
      if (namedBy === "MODEL") named++; else fallback++;
      store.namingCachePut(key, label, namedBy);
      out.push({ ...concept, label, namedBy });
    }
  }

  // Architecture names: the model names packages (few, stable) once each through the cache; every
  // other node keeps its mechanical name. The cache is checked first, so a fully cached run calls
  // the model not at all.
  const done = new Set<string>();
  const pendingPkgs: { node: ArchConcept; key: string }[] = [];
  for (const p of opts.arch) {
    if (p.kind !== "package") continue;
    const key = cacheKey(p.id, `arch|${p.path}`);
    const hit = store.namingCacheGet(key);
    if (hit) { cacheHits++; archOut.push({ ...p, name: hit.label }); done.add(p.id); continue; }
    pendingPkgs.push({ node: p, key });
  }
  if (pendingPkgs.length) {
    let names: { conceptId: string; name: string }[] | null = null;
    try {
      names = await opts.adapter.name({
        purpose: "NAME_ARCH",
        question: JSON.stringify({ packages: pendingPkgs.map(({ node }) => ({ conceptId: node.id, path: node.path, modules: node.memberEntityIds.length })) }),
        items: pendingPkgs.map(({ node }) => ({ conceptId: node.id, kind: node.kind, features: { modules: node.memberEntityIds.length }, compositionRule: null, members: [{ entityId: node.id, name: node.name, file: node.path }] })),
      });
    } catch { names = null; }
    const got = new Map((names ?? []).map((n) => [n.conceptId, n.name]));
    for (const { node: p, key } of pendingPkgs) {
      const model = got.get(p.id);
      const label = model && model.trim() ? model.trim().slice(0, 60) : p.name;
      const namedBy = model && model.trim() ? "MODEL" : "FALLBACK";
      if (namedBy === "MODEL") named++; else fallback++;
      store.namingCachePut(key, label, namedBy);
      archOut.push({ ...p, name: label });
      done.add(p.id);
    }
  }
  for (const p of opts.arch) if (!done.has(p.id)) archOut.push(p);

  const order = new Map([...out.map((c) => c.id), ...opts.concepts.map((c) => c.id)].map((id, i) => [id, i]));
  out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { concepts: out, arch: archOut, named, fallback, cacheHits };
}
