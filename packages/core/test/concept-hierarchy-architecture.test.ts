// Axis A: the architectural tree. Review checkpoint §8: built over this repository itself, the tree
// must reproduce the real layout — packages/<name> are packages, every source file is a module, no
// directory levels in between.
import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { test } from "node:test";
import { buildArchitecturalTree, exportSurfaceOf, packageOf } from "../src/concept-hierarchy/architecture.ts";
import { linkAxes } from "../src/concept-hierarchy/cross-axis.ts";
import { Store } from "../src/store.ts";
import { makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

test("packageOf maps this repository's real paths onto workspace packages, and flat files onto (root)", () => {
  assert.equal(packageOf("packages/core/src/concept-hierarchy/pdg.ts"), "packages/core");
  assert.equal(packageOf("packages/model/src/ollama.ts"), "packages/model");
  assert.equal(packageOf("apps/web/src/app.ts"), "apps/web");
  assert.equal(packageOf("extensions/vscode/src/extension.ts"), "extensions/vscode");
  assert.equal(packageOf("src/one.ts"), "src");
  assert.equal(packageOf("README.md"), "(root)");
});

test("built over this repository itself, the tree reproduces the real layout", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const store = new Store(":memory:");
  // A hand-made batch with the real files of two packages: the tree is built from entity rows, exactly
  // as it would be after a real index.
  const entities = [
    ["packages/core/src/concept-hierarchy/pdg.ts", "function", "buildAllPdgs"],
    ["packages/core/src/concept-hierarchy/config.ts", "function", "conceptConfig"],
    ["packages/model/src/ollama.ts", "function", "resolveModel"],
    ["packages/core/src/store.ts", "class", "Store"],
    ["packages/core/src/store.ts", "method", "Store.putBatch"],
  ].map(([file, kind, name], i) => ({ entityId: `${kind}:${file}#${name}`, kind, name, file, spans: [] }));
  store.putBatch({ revision: "self", gitHead: null, repoRoot, entities, facts: [], relationships: [], diagnostics: [], analyzerVersion: "concept-test" });
  const t = buildArchitecturalTree(store, "self", repoRoot);

  const repo = t.nodes.find((n) => n.kind === "repo")!;
  assert.equal(repo.name, basename(repoRoot), "the repo node is named after the repository directory");
  const pkgs = t.nodes.filter((n) => n.kind === "package").map((n) => n.path).sort();
  assert.deepEqual(pkgs, ["packages/core", "packages/model"]);
  const mod = t.nodes.find((n) => n.id === "arch:mod:packages/core/src/concept-hierarchy/pdg.ts");
  assert.ok(mod, "every source file is a module");
  assert.equal(mod!.parent, "arch:pkg:packages/core");
  assert.equal(mod!.name, "pdg.ts");
  const storeCls = t.nodes.find((n) => n.kind === "class" && n.name === "Store");
  assert.ok(storeCls && storeCls.parent === "arch:mod:packages/core/src/store.ts");
  const putBatch = t.nodes.find((n) => n.kind === "function" && n.name === "Store.putBatch");
  assert.ok(putBatch && putBatch.parent === storeCls!.id, "methods hang under their class");
  const fn = t.nodes.find((n) => n.kind === "function" && n.name === "buildAllPdgs")!;
  assert.equal(fn.parent, "arch:mod:packages/core/src/concept-hierarchy/pdg.ts");
  // parent/children agree, all the way up to the repo node
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  for (const n of t.nodes) if (n.parent) assert.ok(byId.get(n.parent)!.children.includes(n.id), `${n.id} is a child of its parent`);
  assert.equal(t.nodes.find((n) => n.id === repo.id)!.children.length, 2);
});

test("export surfaces come from the compiler: names, kinds, sorted", () => {
  const repo = makeRepo({
    "packages/x/src/mod.ts": `export function alpha() {}\nexport const beta = 1;\nexport class Gamma {}\nexport interface Delta {}\nexport type Epsilon = string;\nconst hidden = 1;\n`,
  });
  const sf = exportSurfaceOf(repo, "packages/x/src/mod.ts");
  assert.ok(sf);
  assert.deepEqual(sf!.exports.map((e) => `${e.name}:${e.kind}`), ["alpha:function", "beta:value", "Delta:interface", "Epsilon:type", "Gamma:class"]);
  assert.equal(exportSurfaceOf(repo, "packages/x/src/nope.ts"), null);
});

test("entry points are name-based and shallow", () => {
  const repo = makeRepo({ "src/server.ts": `export function main() {}\nexport function helper() {}\n` });
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, { "src/server.ts": `export function main() {}\nexport function helper() {}\n` });
  const t = buildArchitecturalTree(store, "rev", repo);
  assert.ok(t.entryPoints.some((e) => e.entityId.endsWith("#main")), JSON.stringify(t.entryPoints));
  assert.ok(!t.entryPoints.some((e) => e.entityId.endsWith("#helper")));
});

test("cross-axis: members resolve to function nodes and ancestors; spanning two packages is a cross-package concept", () => {
  const repoRoot = makeRepo({ "a/x.ts": "", "b/y.ts": "" });
  const store = new Store(":memory:");
  const entities = [
    { entityId: "function:a/x.ts#ax", kind: "function", name: "ax", file: "a/x.ts", spans: [] },
    { entityId: "function:b/y.ts#by", kind: "function", name: "by", file: "b/y.ts", spans: [] },
  ];
  store.putBatch({ revision: "rev", gitHead: null, repoRoot, entities, facts: [], relationships: [], diagnostics: [], analyzerVersion: "concept-test" });
  const t = buildArchitecturalTree(store, "rev", repoRoot);
  void repoRoot;
  const concept = {
    id: "sc:test", revision: "rev", kind: "transfer-form", label: null, namedBy: null,
    members: ["function:a/x.ts#ax", "function:b/y.ts#by"], evidenceIds: [],
    canonicalMotifHash: "h", compositionRule: "complementary-pair", features: {},
    soundness: { tier: "supported" as const, basis: "b" }, source: "COMPOSITION" as const,
  };
  const { links, crossPackage } = linkAxes([concept], t.nodes, "rev");
  assert.ok(links.some((l) => l.archNodeId === "arch:fn:function:a/x.ts#ax"));
  assert.ok(links.some((l) => l.archNodeId === "arch:mod:b/y.ts"));
  assert.equal(crossPackage.length, 1);
  assert.deepEqual(crossPackage[0].packages, ["a", "b"]);
});
