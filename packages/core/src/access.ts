// What a caller may see (C03 slice, used by C09 queries and C10 retrieval). Two controls, both stored with the data so
// they hold for every code path:
//   - denied paths: files under a denied prefix are invisible to retrieval, graph queries and evidence resolution
//   - revoked sources: a repository whose permission was withdrawn is treated as not indexed, and its derived data is purged
// Denied things are never named in a response: a caller learns "N were left out", not what they were.
import type { Store } from "./store.ts";

export interface AccessPolicy {
  /** True if the file (repo-relative path) may not be shown. */
  denied(file: string): boolean;
  /** True if the entity id (file:..., function:path#name, test:..., ...) belongs to a denied file. */
  deniedEntity(entityId: string, fileOf?: (id: string) => string | undefined): boolean;
  readonly prefixes: string[];
}

export const OPEN: AccessPolicy = { denied: () => false, deniedEntity: () => false, prefixes: [] };

export function policyFor(store: Store, repoRoot: string | null | undefined): AccessPolicy {
  if (!repoRoot) return OPEN;
  const prefixes = store.deniedPrefixes(repoRoot);
  if (!prefixes.length) return OPEN;
  const norm = (f: string) => f.replace(/^\.?\//, "");
  const denied = (file: string) => { const f = norm(file); return prefixes.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : p + "/")); };
  // Entity ids carry their file: `function:src/a.ts#name`, `file:src/a.ts`, `class:src/a.ts#X`, `test:src/a.test.ts#t`.
  const fileInId = (id: string) => /^[a-z]+:([^#]+)/.exec(id)?.[1];
  return { denied, deniedEntity: (id, fileOf) => { const f = fileOf?.(id) ?? fileInId(id); return !!f && denied(f); }, prefixes };
}
