import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArchConcept, ConceptHierarchyView, SemanticConcept } from "@cie/schema";
import {
  DEFAULT_LAYOUT, PAGE, ZOOMS, buildMeaningTree, buildStructureTree, clip, conceptsOfEntity, defaultExpanded, familyOf, layoutTree, matchesFor, visibleTree, zoomToFit, type TreeNode,
} from "../src/concept-tree.ts";

const arch = (id: string, kind: ArchConcept["kind"], name: string, parent: string | null, children: string[], member?: string): ArchConcept =>
  ({ id, revision: "r1", kind, name, path: name, parent, memberEntityIds: member ? [member] : [], children });
const concept = (id: string, kind: string, members: string[], over: Partial<SemanticConcept> = {}): SemanticConcept => ({
  id, revision: "r1", kind, label: null, namedBy: null, members, evidenceIds: [], canonicalMotifHash: "h", compositionRule: null, features: {}, soundness: { tier: "supported", basis: "b" }, source: "MOTIF", ...over,
});
const F = (file: string, name: string) => `function:${file}#${name}`;

// repo > package src > modules a.ts (debit, credit) and b.ts (sum) and c.ts (nothing)
const nodes: ArchConcept[] = [
  arch("repo", "repo", "demo", null, ["pkg"]),
  arch("pkg", "package", "src", "repo", ["ma", "mb", "mc"]),
  arch("ma", "module", "a.ts", "pkg", ["fd", "fc"]), arch("fd", "function", "debit", "ma", [], F("src/a.ts", "debit")), arch("fc", "function", "credit", "ma", [], F("src/a.ts", "credit")),
  arch("mb", "module", "b.ts", "pkg", ["fs"]), arch("fs", "function", "sum", "mb", [], F("src/b.ts", "sum")),
  arch("mc", "module", "c.ts", "pkg", ["fn"]), arch("fn", "function", "noop", "mc", [], F("src/c.ts", "noop")),
];
const concepts: SemanticConcept[] = [
  concept("c-debit", "debit-form", [F("src/a.ts", "debit")], { compositionRule: "guarded-write+op:sub", features: { "motif:guarded-write": 1, "op:sub": 1 } }),
  concept("c-credit", "credit-form", [F("src/a.ts", "credit")], { compositionRule: "guarded-write+op:add", features: { "motif:guarded-write": 1, "op:add": 1 } }),
  concept("c-transfer", "transfer-form", [F("src/a.ts", "debit"), F("src/a.ts", "credit")], { compositionRule: "complementary-pair", features: { "op:add": 1, "op:sub": 1 }, label: "Move money" }),
  concept("c-sum", "loop-accumulate", [F("src/b.ts", "sum")]),
];
const linksFor = (): ConceptHierarchyView["links"] => {
  const fnOf: Record<string, string> = { [F("src/a.ts", "debit")]: "fd", [F("src/a.ts", "credit")]: "fc", [F("src/b.ts", "sum")]: "fs" };
  const up: Record<string, string[]> = { fd: ["fd", "ma", "pkg", "repo"], fc: ["fc", "ma", "pkg", "repo"], fs: ["fs", "mb", "pkg", "repo"] };
  return concepts.flatMap((c) => [...new Set(c.members.map((m) => fnOf[m]))].flatMap((fn) => up[fn].map((archNodeId) => ({ conceptId: c.id, archNodeId }))));
};
const view = (over: Partial<ConceptHierarchyView> = {}): ConceptHierarchyView => ({
  revision: "r1", version: 1, versions: [], concepts, invariants: [], arch: nodes, surfaces: [], entryPoints: [], crossPackage: [], links: linksFor(), stats: null, ...over,
});
const flat = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(flat)];

test("a composed shape names the plain shape it specialises from its own record; a plain shape is its own family", () => {
  assert.deepEqual(familyOf(concepts[0]), { family: "guarded-write", variant: "debit-form" });
  assert.deepEqual(familyOf(concepts[2]), { family: "guarded-write", variant: "transfer-form" }, "no motif in its features, so the documented fallback applies");
  assert.deepEqual(familyOf(concepts[3]), { family: "loop-accumulate", variant: null });
  assert.deepEqual(familyOf(concept("x", "mystery-form", [], { compositionRule: "r", features: {} })), { family: "mystery-form", variant: "mystery-form" }, "an unknown composition is not given a parent it was never shown to have");
});

test("where it lives: containment down to the function, with concepts counted once at every level", () => {
  const root = buildStructureTree(view())!;
  assert.deepEqual([root.kind, root.label, root.count], ["repo", "demo", 4], "all four concepts, each counted once, though two of them touch two functions");
  const pkg = root.children[0];
  assert.deepEqual([pkg.kind, pkg.count], ["package", 4]);
  assert.deepEqual(pkg.children.map((m) => m.label), ["a.ts", "b.ts"], "the module with no concept is not drawn; the busiest comes first");
  const a = pkg.children[0];
  assert.equal(a.count, 3, "debit, credit and the transfer that spans both");
  assert.deepEqual(a.children.map((f) => [f.label, f.count, f.kind, f.entityId]), [["credit", 2, "function", F("src/a.ts", "credit")], ["debit", 2, "function", F("src/a.ts", "debit")]]);
  assert.equal(a.children[0].children.length, 0, "a function is the leaf: a piece of code");
  assert.deepEqual(a.badges.map((b) => b.kind).sort(), ["credit-form", "debit-form", "transfer-form"]);
});

test("where it lives: code with no concept can be shown on request, and a cycle or dangling id cannot hang the build", () => {
  const all = buildStructureTree(view(), { onlyWithConcepts: false })!;
  assert.ok(flat(all).some((n) => n.label === "noop" && n.count === 0 && n.sub === "no concept"));
  const looped = view({ arch: [arch("r", "repo", "r", null, ["r", "ghost"])], links: [] });
  assert.equal(buildStructureTree(looped)!.children.length, 0);
  assert.equal(buildStructureTree(view({ arch: [] })), null);
});

test("what it does: shape family, then the composed shape, then the concept, then the code", () => {
  const root = buildMeaningTree(view())!;
  assert.deepEqual([root.kind, root.count], ["root", 4]);
  assert.deepEqual(root.children.map((f) => [f.label, f.count]), [["guarded-write", 3], ["loop-accumulate", 1]]);
  const gw = root.children[0];
  assert.deepEqual(gw.children.map((v) => [v.kind, v.label, v.count]), [["variant", "credit-form", 1], ["variant", "debit-form", 1], ["variant", "transfer-form", 1]]);
  const transfer = gw.children.find((v) => v.label === "transfer-form")!.children[0];
  assert.deepEqual([transfer.kind, transfer.label], ["concept", "Move money"]);
  assert.deepEqual(transfer.children.map((f) => f.label), ["debit", "credit"], "a concept that spans two functions has two code leaves");
  const sum = root.children[1].children[0];
  assert.deepEqual([sum.kind, sum.label], ["concept", "unnamed loop-accumulate"], "a plain shape sits directly under its family, with no invented middle level");
});

test("every concept appears exactly once in the meaning tree, and every function with a concept is reachable in the structure tree", () => {
  const m = flat(buildMeaningTree(view())!);
  for (const c of concepts) assert.equal(m.filter((n) => n.kind === "concept" && n.conceptId === c.id).length, 1, c.id);
  const s = flat(buildStructureTree(view())!).filter((n) => n.kind === "function").map((n) => n.entityId);
  for (const e of [F("src/a.ts", "debit"), F("src/a.ts", "credit"), F("src/b.ts", "sum")]) assert.equal(s.filter((x) => x === e).length, 1, e);
  assert.equal(buildMeaningTree(view({ concepts: [] })), null);
});

test("what is drawn: closed shows the root alone, open shows children a page at a time, and a stub counts what is hidden", () => {
  const many: TreeNode = { id: "p", kind: "family", label: "p", sub: "", count: 0, badges: [], children: Array.from({ length: PAGE + 7 }, (_, i): TreeNode => ({ id: `c${i}`, kind: "concept", label: `c${i}`, sub: "", count: 1, badges: [], children: [{ id: `l${i}`, kind: "function", label: "f", sub: "", count: 0, badges: [], children: [] }] })) };
  const closed = visibleTree(many, new Set());
  assert.equal(closed.children.length, 0);
  assert.equal(closed.expandable, true);
  const open = visibleTree(many, new Set(["p"]));
  assert.equal(open.children.length, PAGE + 1);
  assert.deepEqual([open.children.at(-1)!.node.kind, open.children.at(-1)!.hidden, open.children.at(-1)!.moreFor], ["more", 7, "p"]);
  const paged = visibleTree(many, new Set(["p"]), new Map([["p", PAGE + 7]]));
  assert.equal(paged.children.length, PAGE + 7, "after paging, nothing is left hidden and the stub goes away");
  assert.equal(visibleTree(many, new Set(["p", "c0"])).children[0].children.length, 1, "a child opens on its own");
  assert.equal(visibleTree(many, new Set(["p", "l0"])).children[0].expanded, false, "a leaf never reports itself open");
});

test("the first picture is the top of the tree: only nodes above the depth are opened", () => {
  const root = buildStructureTree(view())!;
  assert.deepEqual([...defaultExpanded(root, 1)], ["repo"]);
  assert.deepEqual([...defaultExpanded(root, 2)].sort(), ["pkg", "repo"]);
  assert.deepEqual([...defaultExpanded(root, 0)], []);
});

test("search opens the way to each match without opening the match itself, and finds code by name, shape or file", () => {
  const root = buildStructureTree(view())!;
  const r = matchesFor(root, "credit");
  assert.ok(r.matches.has("fc"));
  assert.deepEqual([...r.open].sort(), ["ma", "pkg", "repo"], "the ancestors, so the match is visible");
  assert.ok(!r.open.has("fc"));
  assert.deepEqual(matchesFor(root, "").matches.size, 0);
  assert.equal(matchesFor(root, "zzz").matches.size, 0);
  const meaning = buildMeaningTree(view())!;
  assert.ok(matchesFor(meaning, "src/b.ts").matches.size > 0, "by file");
  assert.equal(matchesFor(meaning, "e", 3).matches.size, 3, "capped");
});

test("layout: parents sit between their children, columns follow depth, and no two nodes in a column overlap", () => {
  const v = visibleTree(buildStructureTree(view())!, new Set(["repo", "pkg", "ma", "mb"]));
  const lay = layoutTree(v);
  const at = new Map(lay.nodes.map((n) => [n.v.id, n]));
  const pkg = at.get("pkg")!;
  const kids = pkg.v.children.map((c) => at.get(c.id)!);
  assert.equal(pkg.y, (kids[0].y + kids[kids.length - 1].y) / 2, "centred on its first and last child");
  for (const n of lay.nodes) assert.equal(n.x, DEFAULT_LAYOUT.pad + n.v.depth * (DEFAULT_LAYOUT.nodeW + DEFAULT_LAYOUT.colGap));
  const cols = new Map<number, number[]>();
  for (const n of lay.nodes) cols.set(n.v.depth, [...(cols.get(n.v.depth) ?? []), n.y]);
  for (const ys of cols.values()) { const s = [...ys].sort((a, b) => a - b); for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] >= DEFAULT_LAYOUT.nodeH + DEFAULT_LAYOUT.rowGap - 1e-9, `rows ${s[i - 1]} and ${s[i]} overlap`); }
  assert.equal(lay.links.length, lay.nodes.length - 1, "one link per child");
  assert.ok(lay.nodes.every((n) => n.x + DEFAULT_LAYOUT.nodeW <= lay.width && n.y + DEFAULT_LAYOUT.nodeH <= lay.height), "everything is inside the canvas");
  assert.deepEqual(layoutTree(visibleTree(buildStructureTree(view())!, new Set())).nodes.length, 1, "a closed tree is one node");
});

test("layout holds for a wide, uneven tree: the no-overlap rule is not an accident of a small fixture", () => {
  const leaf = (id: string): TreeNode => ({ id, kind: "function", label: id, sub: "", count: 0, badges: [], children: [] });
  const branch = (id: string, kids: TreeNode[]): TreeNode => ({ id, kind: "concept", label: id, sub: "", count: 1, badges: [], children: kids });
  const root = branch("root", [branch("a", [leaf("a1")]), branch("b", [branch("b1", [leaf("b1x"), leaf("b1y"), leaf("b1z")]), leaf("b2")]), leaf("c"), branch("d", [leaf("d1")])]);
  const ids = new Set(flat(root).map((n) => n.id));
  const lay = layoutTree(visibleTree(root, ids));
  assert.equal(lay.nodes.length, ids.size);
  const cols = new Map<number, number[]>();
  for (const n of lay.nodes) cols.set(n.v.depth, [...(cols.get(n.v.depth) ?? []), n.y]);
  for (const ys of cols.values()) { const s = [...ys].sort((a, b) => a - b); for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] >= DEFAULT_LAYOUT.nodeH + DEFAULT_LAYOUT.rowGap - 1e-9); }
});

test("the concepts a piece of code takes part in, and label clipping", () => {
  assert.deepEqual(conceptsOfEntity(view(), F("src/a.ts", "debit")).map((c) => c.id).sort(), ["c-debit", "c-transfer"]);
  assert.deepEqual(conceptsOfEntity(view(), "function:nowhere#x"), []);
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("a-very-long-function-name", 10), "a-very-lo…");
});

test("fit picks the largest zoom that still shows the whole width, and never goes below the smallest", () => {
  assert.equal(ZOOMS[zoomToFit(400, 2000)], 1.5, "plenty of room: as large as allowed");
  assert.equal(ZOOMS[zoomToFit(1000, 1000)], 1, "an exact fit counts");
  assert.equal(ZOOMS[zoomToFit(1000, 900)], 0.8);
  assert.equal(zoomToFit(5000, 300), 0, "too wide even at the smallest zoom: the smallest, and the page scrolls");
});
