import type { Store } from "./store.ts";
import { policyFor } from "./access.ts";
import { revisionIndex } from "./salience.ts";
import type { ArchConcept, Entity } from "@cie/schema";

/** Test helpers can be nested inside production files, especially Rust modules. */
export function productionEntities(entities: Entity[]): Entity[] {
  const testScopes = new Map<string, Entity["spans"]>();
  for (const e of entities) if (e.kind === "module" && /^(?:tests?|fixtures?|__tests__)$|(?:^|_)tests?(?:_|$)/i.test(e.name)) {
    testScopes.set(e.file, [...(testScopes.get(e.file) ?? []), ...e.spans]);
  }
  return entities.filter((e) => productionSource(e.file) && !e.spans.some((span) => (testScopes.get(e.file) ?? []).some((scope) =>
    scope.startByte <= span.startByte && scope.endByteExclusive >= span.endByteExclusive)));
}

export function navigateHierarchy(store: Store, revision: string, question: string, subjects: string[] = []) {
  const concepts = answerConcepts(store, revision);
  const rev = store.revision(revision);
  const access = policyFor(store, rev?.repoRoot);
  const entities = productionEntities(store.entities(revision)).filter((e) => !access.denied(e.file));
  const byId = new Map(entities.map((e) => [e.entityId, e]));
  const allNodes = store.archNodes(revision) as ArchConcept[];
  const allNodeById = new Map(allNodes.map((n) => [n.id, n]));
  const visibleNodes = new Set<string>();
  for (const node of allNodes.filter((n) => n.memberEntityIds.some((id) => byId.has(id)))) {
    let current: ArchConcept | undefined = node;
    while (current && !visibleNodes.has(current.id)) { visibleNodes.add(current.id); current = current.parent ? allNodeById.get(current.parent) : undefined; }
  }
  const nodes = allNodes.filter((n) => visibleNodes.has(n.id));
  const anchored = new Set([...concepts.flatMap((c) => c.members), ...nodes.flatMap((n) => n.memberEntityIds)]);
  const normalized = ` ${question.toLowerCase().replace(/[^a-z0-9_$./-]+/g, " ")} `;
  const ignored = new Set("what how why does this project repository repo system application code codebase main architecture style about show explain tell work works function method module package the and for".split(" "));
  const named = subjects.filter((id) => byId.has(id) && anchored.has(id));
  if (!named.length) for (const e of entities) {
    const name = e.name.split(/[.#]/).at(-1)!.toLowerCase();
    const explicit = ignored.has(name) && (question.includes(`\`${name}\``) || normalized.includes(` function ${name} `) || normalized.includes(` method ${name} `));
    if (name.length >= 3 && (!ignored.has(name) || explicit) && normalized.includes(` ${name} `) && anchored.has(e.entityId)) named.push(e.entityId);
  }
  const terms = question.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((w) => !ignored.has(w)) ?? [];
  const relevant = named.length ? concepts.filter((c) => c.members.some((id) => named.includes(id)))
    : concepts.filter((c) => terms.some((t) => `${c.title} ${c.summary}`.toLowerCase().includes(t)));
  const level = named.length ? (named.every((id) => byId.get(id)?.kind === "file") ? "module" : "function") : relevant.length ? "concept" : "repository";
  const seeds = [...new Set(named.length ? [...named, ...relevant.slice(0, 8).flatMap((c) => c.members)]
    : relevant.length ? relevant.slice(0, 8).flatMap((c) => c.members) : overviewSeeds(store, revision).filter((id) => anchored.has(id)))].slice(0, 30);
  const selectedNodes = nodes.filter((n) => level === "repository" ? n.kind === "repo" || n.kind === "package"
    : n.memberEntityIds.some((id) => seeds.includes(id)) && (level === "module" ? n.kind === "module" : n.kind === "function"));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = new Map<string, ArchConcept>();
  for (const node of selectedNodes) {
    let current: ArchConcept | undefined = node;
    while (current && !ancestors.has(current.id)) { ancestors.set(current.id, current); current = current.parent ? nodeById.get(current.parent) : undefined; }
  }
  return { level, seeds, conceptIds: (relevant.length ? relevant : concepts.filter((c) => c.members.some((id) => seeds.includes(id)))).slice(0, 12).map((c) => c.id),
    nodes: [...ancestors.values()].slice(0, 24).map((n) => ({ id: n.id, kind: n.kind, name: n.name, parent: n.parent })) };
}

/** Concepts are revision-bound guidance; their names are never independent proof. */
export function answerConcepts(store: Store, revision: string) {
  const rev = store.revision(revision);
  if (!rev) return [];
  const access = policyFor(store, rev.repoRoot);
  const entities = new Map(productionEntities(store.entities(revision)).map((e) => [e.entityId, e]));
  const hierarchy = store.semanticConcepts(revision).map((c) => ({ id: c.id as string, kind: c.kind as string, title: (c.label ?? c.kind) as string,
    summary: c.soundness?.basis ?? "Structural concept", members: c.members as string[], source: `hierarchy:${c.namedBy ?? "unnamed"}`, basis: c.soundness?.tier ?? "speculative" }));
  return hierarchy.filter((c) => c.members.length > 0 && c.members.every((id) => {
    const e = entities.get(id);
    return e && productionSource(e.file) && !access.denied(e.file);
  }));
}

export function conceptRequirement(store: Store, revision: string): string | undefined {
  const rev = store.revision(revision);
  if (!rev || answerConcepts(store, revision).length) return undefined;
  // A built hierarchy can legitimately have no visible concepts after an access restriction.
  // Let the access-filtered answer pipeline explain the absence rather than demand repeated rebuilds.
  if (store.deniedPrefixes(rev.repoRoot).length && store.semanticConceptVersions(rev.repoRoot).some(v => v.revision === revision)) return undefined;
  const earlierHierarchy = store.semanticConceptVersions(rev.repoRoot).find((v) => v.revision !== revision && v.concepts > 0);
  return `${earlierHierarchy ? `The concept hierarchy was already generated for this repository, but for an older indexed revision (${earlierHierarchy.revision}).` : "The concept hierarchy is required before answering repository questions, and no usable concepts exist for this indexed revision."} Click “Build concept hierarchy” for the current revision, then ask again.`;
}

export const productionSource = (file: string) => /\.(?:[cm]?[jt]sx?|rs|java|go|py|nir)$/.test(file) &&
  !/(^|\/)(tests?|__tests__|fixtures?|examples?|docs?|demo|benches|benchmarks|node_modules|target|dist|generated)(\/|$)|\.(test|spec)\./i.test(file);

export function sourceModule(file: string): string {
  const parts = file.split("/");
  return parts.slice(0, Math.min(parts.length - 1, ["src", "apps", "packages", "crates", "extensions"].includes(parts[0]!) ? 2 : 1)).join("/") || ".";
}

/** Sample languages and source modules before taking more symbols from a busy module.
 * Degree ranks symbols within a module, never an entire polyglot repository. */
export function overviewSeeds(store: Store, revision: string, limit = 30): string[] {
  const rev = store.revision(revision);
  if (!rev) return [];
  const access = policyFor(store, rev.repoRoot), idx = revisionIndex(store, revision);
  const symbols = productionEntities(store.entities(revision)).filter((e) => ["function", "method", "class", "interface"].includes(e.kind) && !access.denied(e.file) && !/(?:^|[.#])(?:test_|constructor)/.test(e.name));
  const conceptMembers = new Set(answerConcepts(store, revision).flatMap((c) => c.members));
  const score = (e: typeof symbols[number]) => Math.log2(1 + (idx.degree.get(e.entityId) ?? 0)) +
    (/(?:^|\/)(main|server|index|service|store|worker|app)\.[^.]+$/i.test(e.file) ? 3 : 0) + (conceptMembers.has(e.entityId) ? 3 : 0);
  symbols.sort((a, b) => score(b) - score(a) || a.entityId.localeCompare(b.entityId));
  const languages = new Map<string, Map<string, string[]>>();
  for (const e of symbols) {
    const ext = e.file.split(".").pop() ?? "";
    const lang = ["ts", "tsx", "mts", "cts"].includes(ext) ? "typescript" : ext;
    const module = sourceModule(e.file);
    const modules = languages.get(lang) ?? new Map<string, string[]>();
    languages.set(lang, modules);
    const ids = modules.get(module) ?? [];
    modules.set(module, ids); ids.push(e.entityId);
  }
  const queues = [...languages].sort(([a], [b]) => a.localeCompare(b)).map(([, modules]) => {
    const queues = [...modules].sort(([a], [b]) => a.localeCompare(b)).map(([, ids]) => [...ids]);
    const ids: string[] = [];
    while (queues.some((q) => q.length)) for (const q of queues) if (q.length) ids.push(q.shift()!);
    return ids;
  });
  const picked: string[] = [];
  const fileCounts = new Map<string, number>();
  const fileById = new Map(symbols.map((e) => [e.entityId, e.file]));
  while (picked.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && picked.length < limit) {
      const id = q.shift()!, file = fileById.get(id)!;
      if ((fileCounts.get(file) ?? 0) >= 2) continue;
      picked.push(id); fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  return picked;
}
