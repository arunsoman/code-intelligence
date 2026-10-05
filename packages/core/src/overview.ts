import type { Store } from "./store.ts";
import { policyFor } from "./access.ts";
import { revisionIndex } from "./salience.ts";

/** Sample languages and source modules before taking more symbols from a busy module.
 * Degree ranks symbols within a module, never an entire polyglot repository. */
export function overviewSeeds(store: Store, revision: string, limit = 30): string[] {
  const rev = store.revision(revision);
  if (!rev) return [];
  const access = policyFor(store, rev.repoRoot), idx = revisionIndex(store, revision);
  const symbols = store.entities(revision).filter((e) => ["function", "method", "class", "interface"].includes(e.kind) && !access.denied(e.file));
  symbols.sort((a, b) => (idx.degree.get(b.entityId) ?? 0) - (idx.degree.get(a.entityId) ?? 0) || a.entityId.localeCompare(b.entityId));
  const languages = new Map<string, Map<string, string[]>>();
  for (const e of symbols) {
    const ext = e.file.split(".").pop() ?? "";
    const lang = ["ts", "tsx", "mts", "cts"].includes(ext) ? "typescript" : ext;
    const parts = e.file.split("/");
    const module = parts.slice(0, Math.min(parts.length - 1, ["src", "apps", "packages"].includes(parts[0]) ? 2 : 1)).join("/") || ".";
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
  while (picked.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && picked.length < limit) picked.push(q.shift()!);
  }
  return picked;
}
