// Axis A: the architectural tree (plan §1). repo → package → module → class → function, with module =
// one source file and NO directory levels between package and module. A package is the workspace
// prefix (packages/<name>, apps/<name>, extensions/<name>) when the path has one, else the first path
// segment; files outside every package hang directly under "(root)". The tree must reproduce this
// repository's own layout when built over it (review checklist §8).
//
// Export surfaces come from the TypeScript compiler over the real files; they feed the anchoring rule
// (an export-surface change forces a rename). Entry points are name-based and deliberately shallow.
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import type { ArchConcept, EntryPoint, ExportSurface } from "@cie/schema";
import type { Store } from "../store.ts";
import { conceptConfig } from "./config.ts";
import type { ArchNodeDraft } from "./types.ts";

export interface ArchBuildResult {
  nodes: ArchConcept[];
  surfaces: ExportSurface[];
  entryPoints: EntryPoint[];
  /** Modules past the surface budget; their export surfaces are missing, not empty. */
  gaps: string[];
}

const PACKAGE_PREFIX = /^(packages|apps|extensions)\//;

export function packageOf(file: string): string {
  if (PACKAGE_PREFIX.test(file)) return file.split("/").slice(0, 2).join("/");
  const top = file.split("/")[0];
  return file.includes("/") ? top : "(root)";
}

export function buildArchitecturalTree(store: Store, revision: string, repoRoot: string): ArchBuildResult {
  const entities = store.entities(revision).filter((e) => e.kind !== "file");
  const files = [...new Set(entities.map((e) => e.file))].sort();
  const repoName = basename(repoRoot);
  const nodes: ArchNodeDraft[] = [];
  const repoId = "arch:repo";
  nodes.push({ id: repoId, kind: "repo", name: repoName, path: "", parent: null, memberEntityIds: entities.map((e) => e.entityId), children: [] });

  const byPackage = new Map<string, string[]>();
  for (const f of files) byPackage.set(packageOf(f), [...(byPackage.get(packageOf(f)) ?? []), f]);
  const packageIds = new Map<string, string>();
  for (const pkg of [...byPackage.keys()].sort()) {
    const id = `arch:pkg:${pkg}`;
    packageIds.set(pkg, id);
    nodes.push({ id, kind: "package", name: pkg === "(root)" ? "(root)" : pkg.split("/").pop()!, path: pkg, parent: repoId, memberEntityIds: [], children: [] });
    nodes.find((n) => n.id === repoId)!.children.push(id);
  }

  const surfaceBudget = conceptConfig().exportSurfaceMaxFiles.value;
  const surfaces: ExportSurface[] = [];
  const gaps: string[] = [];
  const classIds = new Map<string, string>();
  for (const f of files) {
    const pkg = packageOf(f);
    const modId = `arch:mod:${f}`;
    nodes.push({ id: modId, kind: "module", name: basename(f), path: f, parent: packageIds.get(pkg)!, memberEntityIds: [], children: [] });
    const p = nodes.find((n) => n.id === packageIds.get(pkg))!;
    p.children.push(modId);
    // class-like entities of this file, then methods, then the rest
    const mine = entities.filter((e) => e.file === f);
    for (const cls of mine.filter((e) => e.kind === "class" || e.kind === "interface")) {
      const cid = `arch:cls:${f}#${cls.name}`;
      classIds.set(cls.name, cid);
      nodes.push({ id: cid, kind: "class", name: cls.name, path: `${f}#${cls.name}`, parent: modId, memberEntityIds: [cls.entityId], children: [] });
      nodes.find((n) => n.id === modId)!.children.push(cid);
    }
    for (const e of mine) {
      if (e.kind === "class" || e.kind === "interface") continue;
      const owner = e.kind === "method" && e.name.includes(".") ? classIds.get(e.name.split(".")[0]) : undefined;
      const parentId = owner ?? modId;
      nodes.push({ id: `arch:fn:${e.entityId}`, kind: "function", name: e.name, path: e.entityId, parent: parentId, memberEntityIds: [e.entityId], children: [] });
      nodes.find((n) => n.id === parentId)!.children.push(`arch:fn:${e.entityId}`);
      if (e.kind === "method" && !e.name.includes(".")) nodes.find((n) => n.id === modId)!.memberEntityIds.push(e.entityId);
    }
    // export surface, within budget
    if (surfaces.length < surfaceBudget) {
      const sf = exportSurfaceOf(repoRoot, f);
      if (sf) surfaces.push(sf);
      else gaps.push(f);
    } else gaps.push(f);
  }

  const entryPoints: EntryPoint[] = [];
  for (const e of entities) {
    if (/^(main|server|start|index)$/.test(e.name)) {
      entryPoints.push({ entityId: e.entityId, kind: "symbol", file: e.file, detail: "the symbol's name matches an entry convention" });
      if (entryPoints.length >= 50) break;
    }
  }

  return {
    nodes: nodes.map((n) => ({ id: n.id, revision, kind: n.kind, name: n.name, path: n.path, parent: n.parent, memberEntityIds: n.memberEntityIds, children: n.children })),
    surfaces,
    entryPoints,
    gaps: [...new Set(gaps)],
  };
}

/** Exported declaration names and kinds of one module; null when the file is unreadable. */
export function exportSurfaceOf(repoRoot: string, file: string): ExportSurface | null {
  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return null;
  let text: string;
  try { text = readFileSync(abs, "utf8"); } catch { return null; }
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const exports: ExportSurface["exports"] = [];
  const exported = (n: ts.Node): boolean => (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        const name = ts.isIdentifier(d.name) ? d.name.text : "(binding)";
        const kind = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? "function" : "value";
        exports.push({ name, kind });
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && exported(st) && st.name) {
      exports.push({ name: st.name.text, kind: ts.isFunctionDeclaration(st) ? "function" : "class" });
    } else if (ts.isInterfaceDeclaration(st) && exported(st) && st.name) {
      exports.push({ name: st.name.text, kind: "interface" });
    } else if (ts.isTypeAliasDeclaration(st) && exported(st) && st.name) {
      exports.push({ name: st.name.text, kind: "type" });
    } else if (ts.isExportDeclaration(st)) {
      for (const el of st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : []) exports.push({ name: el.name.text, kind: "reexport" });
    }
  }
  return { moduleId: `arch:mod:${file}`, modulePath: file, exports: exports.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Module paths that contain the given file's directory chain (for gap reporting only). */
export const moduleDir = (file: string) => dirname(file);
