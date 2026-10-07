// Cross-axis linking (plan §1): members of a semantic concept resolve to function nodes of the
// architectural tree, up through classes and modules to packages. A concept whose members span more
// than one package becomes a cross-package concept — the only place the two axes meet on purpose.
import { createHash } from "node:crypto";
import type { ArchConcept, CrossPackageConcept, SemanticConcept } from "@cie/schema";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface CrossAxisResult {
  /** One row per (semantic concept, arch node) pair on the member path. */
  links: { conceptId: string; archNodeId: string; revision: string }[];
  crossPackage: CrossPackageConcept[];
}

export function linkAxes(semantic: SemanticConcept[], arch: ArchConcept[], revision: string): CrossAxisResult {
  const fnToPath = new Map<string, { fn: ArchConcept; ancestors: ArchConcept[] }>();
  const byId = new Map(arch.map((n) => [n.id, n]));
  for (const n of arch.filter((x) => x.kind === "function")) {
    const ancestors: ArchConcept[] = [];
    let cur = n.parent ? byId.get(n.parent) : undefined;
    while (cur) { ancestors.push(cur); cur = cur.parent ? byId.get(cur.parent) : undefined; }
    fnToPath.set(n.memberEntityIds[0], { fn: n, ancestors });
  }
  const links: CrossAxisResult["links"] = [];
  const crossPackage: CrossPackageConcept[] = [];
  for (const c of semantic) {
    const packages = new Set<string>();
    for (const m of c.members) {
      const path = fnToPath.get(m);
      if (!path) continue;
      links.push({ conceptId: c.id, archNodeId: path.fn.id, revision });
      for (const a of path.ancestors) links.push({ conceptId: c.id, archNodeId: a.id, revision });
      const pkg = path.ancestors.find((a) => a.kind === "package");
      if (pkg) packages.add(pkg.path);
    }
    if (packages.size > 1) {
      crossPackage.push({
        id: `xc:${sha([...c.members].sort().join("|")).slice(0, 12)}`,
        revision,
        label: c.label ?? c.kind,
        packages: [...packages].sort(),
        memberConceptIds: [c.id],
        evidenceIds: c.evidenceIds,
      });
    }
  }
  return { links, crossPackage };
}
