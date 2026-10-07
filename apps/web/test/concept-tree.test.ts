import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArchConcept, ConceptHierarchyView, SemanticConcept } from "@cie/schema";
import {
  DEFAULT_LAYOUT, GENERIC_WORDS, PAGE, ZOOMS, buildDomainTree, buildMeaningTree, buildStructureTree, clip, conceptsOfEntity, defaultExpanded, familyOf, layoutTree, joinAffixes, matchesFor, splitIdentifier, stemWord, visibleTree, zoomToFit, type TreeNode,
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

// ---------------------------------------------------------------- domain view

/** A small service-shaped repository: files, classes and methods, each function carrying one concept so none is dropped. */
const repo = (spec: [file: string, fns: string[]][], pkgName = "payments"): ConceptHierarchyView => {
  const arch: ArchConcept[] = [arch_("repo", "repo", "repo", null, ["pkg"]), arch_("pkg", "package", pkgName, "repo", [])];
  const cs: SemanticConcept[] = [], links: ConceptHierarchyView["links"] = [];
  spec.forEach(([file, names], i) => {
    const mid = `m${i}`;
    arch.push(arch_(mid, "module", file.split("/").pop()!, "pkg", []));
    arch.find((n) => n.id === "pkg")!.children.push(mid);
    names.forEach((full, j) => {
      const dot = full.lastIndexOf("."), method = dot > 0 ? full.slice(dot + 1) : full;
      const fid = `f${i}_${j}`, entityId = `function:${file}#${full}`;
      arch.push({ ...arch_(fid, "function", method, mid, [], entityId) });
      arch.find((n) => n.id === mid)!.children.push(fid);
      const c = concept(`c${i}_${j}`, j % 2 ? "guarded-write" : "collect-and-return", [entityId]);
      cs.push(c);
      for (const a of [fid, mid, "pkg", "repo"]) links.push({ conceptId: c.id, archNodeId: a });
    });
  });
  return view({ arch, concepts: cs, links });
};
const arch_ = arch; // the fixture helper above is named `arch`; this keeps the call sites readable
const labels = (n: TreeNode): string[] => n.children.map((c) => c.label);
const find = (n: TreeNode, label: string): TreeNode | undefined => flat(n).find((x) => x.label === label);

test("words are split out of identifiers, singularised, and the code's own plumbing words are not domains", () => {
  assert.deepEqual(splitIdentifier("SubAccountControllerService"), ["sub", "account", "controller", "service"]);
  assert.deepEqual(splitIdentifier("parseXMLHttpRequest"), ["parse", "xml", "http", "request"], "an acronym keeps its letters and the next word starts at the next capital");
  assert.deepEqual(splitIdentifier("x_1_ab"), [], "fragments under three letters and numbers are not words");
  assert.deepEqual(["merchants", "categories", "addresses", "status", "analysis", "address", "balances"].map(stemWord), ["merchant", "category", "address", "status", "analysis", "address", "balance"]);
  for (const w of ["service", "controller", "get", "handler", "util", "dto"]) assert.ok(GENERIC_WORDS.has(w), w);
  for (const w of ["merchant", "ledger", "payment", "customer"]) assert.ok(!GENERIC_WORDS.has(w), `${w} is a domain word`);
});

test("domain view: the vocabulary of the file and class groups first; the words of the methods split a big group further", () => {
  const v = repo([
    ["src/customer/customer.service.ts", ["CustomerService.addMerchant", "CustomerService.getMerchantList", "CustomerService.removeMerchant", "CustomerService.listAgents", "CustomerService.addAgent", "CustomerService.dropAgent"]],
    ["src/topup/topup.service.ts", ["TopupService.createTopup", "TopupService.getTopupTotal", "TopupService.cancelTopup"]],
    ["src/auth/auth.controller.ts", ["AuthController.login", "AuthController.logout"]],
  ]);
  const root = buildDomainTree(v)!;
  assert.deepEqual([root.kind, root.label, root.sub], ["root", "Domains", "11 functions"]);
  const top = labels(root);
  for (const d of ["Customer", "Topup"]) assert.ok(top.includes(d), `${d} in ${top}`);
  assert.ok(!top.some((n) => ["Service", "Controller", "Get", "Add"].includes(n)), "no domain is a plumbing word: " + top);
  const customer = find(root, "Customer")!;
  assert.equal(customer.kind, "domain");
  assert.ok(customer.children.some((c) => c.kind === "function" && c.label === "addMerchant"), "a small group lists its code directly");
  assert.match(customer.sub, /^\d+ functions? · mainly payments$/, "and says where it mostly lives, using the package's name");

  const finer = buildDomainTree(v, { splitAbove: 4 })!;
  const under = find(find(finer, "Customer")!, "Merchant");
  assert.ok(under && under.kind === "domain", "over the limit, the method words become sub-domains: " + labels(find(finer, "Customer")!));
  assert.ok(under!.children.map((c) => c.label).includes("addMerchant"), "with the code underneath");
  assert.ok(labels(find(finer, "Customer")!).includes("Agent"));
});

test("domain view: every function appears exactly once, and the result does not depend on the order the code was listed", () => {
  const spec: [string, string[]][] = [
    ["src/customer/customer.service.ts", ["CustomerService.addMerchant", "CustomerService.getMerchantList", "CustomerService.listCustomers", "CustomerService.countCustomers"]],
    ["src/topup/topup.service.ts", ["TopupService.createTopup", "TopupService.getTopupTotal", "TopupService.cancelTopup"]],
    ["src/misc/zzz.ts", ["lonely"]],
  ];
  const a = buildDomainTree(repo(spec))!;
  const leaves = flat(a).filter((n) => n.kind === "function").map((n) => n.entityId);
  const all = spec.flatMap(([f, ns]) => ns.map((n) => `function:${f}#${n}`));
  assert.deepEqual([...leaves].sort(), [...all].sort(), "none lost, none twice");
  const shuffled = buildDomainTree(repo([...spec].reverse().map(([f, ns]) => [f, [...ns].reverse()] as [string, string[]])))!;
  const shape = (n: TreeNode): unknown => [n.label, n.kind, n.children.map(shape)];
  assert.deepEqual(shape(shuffled), shape(a), "same code, same tree");
});

test("domain view: a compound like submerchant is filed under merchant, and a word that fits no group goes under Other", () => {
  const v = repo([
    ["src/merchant/merchant.ts", ["Merchant.addMerchant", "Merchant.editMerchant", "Merchant.dropMerchant"]],
    ["src/submerchant/submerchant.ts", ["Submerchant.addSubmerchant", "Submerchant.editSubmerchant"]],
    ["src/odd/thing.ts", ["thingOne"]],
  ]);
  const root = buildDomainTree(v)!;
  const merchant = labels(root).indexOf("Merchant") >= 0 ? find(root, "Merchant")! : undefined;
  assert.ok(merchant, labels(root).join());
  assert.ok(!labels(root).includes("Submerchant"), "not a top-level domain of its own");
  assert.ok(labels(merchant).includes("Submerchant"), "nested under its parent: " + labels(merchant));
  const other = find(root, "Other")!;
  assert.ok(other && other.children.some((c) => c.label === "thingOne"), "a function with no shared word is still listed");
  assert.equal(labels(root).at(-1), "Other", "Other is always last");
  assert.ok(!find(buildDomainTree(repo([["src/address/address.ts", ["Address.a1x", "Address.b2x"]]]))!, "Dress"), "address is never filed under dress");
});

test("domain view: a big group is split by its next most distinctive word, and a word in a quarter of all code is not a domain", () => {
  const many: [string, string[]][] = [];
  for (const area of ["alpha", "beta", "gamma", "delta"]) many.push([`src/${area}/${area}.ts`, Array.from({ length: 11 }, (_, i) => `Customer${area[0].toUpperCase() + area.slice(1)}.${i % 2 ? "loadPayment" : "loadRefund"}${area}${i}`)]);
  const v = repo(many);
  const root = buildDomainTree(v, { minCluster: 3, splitAbove: 8 })!;
  const flatKinds = flat(root).filter((n) => n.kind === "domain").map((n) => n.label.toLowerCase());
  assert.ok(!flatKinds.includes("customer"), "'customer' is in every function, so it separates nothing: " + flatKinds);
  for (const area of ["alpha", "beta", "gamma", "delta"]) assert.ok(flatKinds.includes(area), `${area} in ${flatKinds}`);
  const alpha = find(root, "Alpha")!;
  assert.ok(flat(alpha).filter((n) => n.kind === "function").length === 11);
  const deep = buildDomainTree(v, { minCluster: 3, splitAbove: 4 })!;
  assert.ok(flat(deep).some((n) => n.kind === "domain" && n.id.split(">").length >= 2), "a group over the limit is split again");
});

test("domain view: concepts are counted once at every level, and code with no concept is shown only on request", () => {
  const spec: [string, string[]][] = [["src/customer/customer.ts", ["Customer.addMerchant", "Customer.getMerchantList", "Customer.dropMerchant"]], ["src/ledger/ledger.ts", ["Ledger.postEntry", "Ledger.voidEntry"]]];
  const v = repo(spec);
  const root = buildDomainTree(v)!;
  assert.equal(root.count, 5, "five functions, one concept each");
  for (const d of root.children.filter((c) => c.kind === "domain")) assert.equal(d.count, flat(d).filter((n) => n.kind === "function").length, d.label);
  const noConcepts = view({ arch: v.arch, concepts: [], links: [] });
  assert.equal(buildDomainTree(noConcepts), null, "nothing with a concept, nothing drawn");
  const all = buildDomainTree(noConcepts, { onlyWithConcepts: false })!;
  assert.equal(flat(all).filter((n) => n.kind === "function").length, 5);
  assert.ok(flat(all).filter((n) => n.kind === "function").every((n) => n.sub.endsWith("no concept")));
});

test("domain view: it can be drawn and searched like the other trees", () => {
  const v = repo([["src/customer/customer.ts", ["Customer.addMerchant", "Customer.getMerchantList", "Customer.dropMerchant"]], ["src/ledger/ledger.ts", ["Ledger.postEntry", "Ledger.voidEntry"]]]);
  const root = buildDomainTree(v)!;
  const lay = layoutTree(visibleTree(root, defaultExpanded(root, 2)));
  assert.ok(lay.nodes.length > 3 && lay.links.length === lay.nodes.length - 1);
  assert.ok(matchesFor(root, "voidEntry").matches.size >= 1);
  assert.ok(matchesFor(root, "merchant").matches.size >= 1, "by the domain word");
});

test("domain view: a prefix like sub joins the word it modifies, so SubAgent files under Agent and 'sub' is never a domain", () => {
  assert.deepEqual(joinAffixes(["sub", "account", "controller"]), ["subaccount", "controller"]);
  assert.deepEqual(joinAffixes(["sub", "id"]), ["sub", "id"], "a prefix before a very short word is left alone");
  assert.deepEqual(joinAffixes(["subtotal"]), ["subtotal"]);
  const v = repo([
    ["src/agent/agent.ts", ["Agent.addAgent", "Agent.editAgent", "Agent.dropAgent"]],
    ["src/sub/sub-agent.ts", ["SubAgent.addSubAgent", "SubAgent.editSubAgent"]],
  ]);
  const root = buildDomainTree(v)!;
  assert.ok(!labels(root).includes("Sub"), "'sub' on its own is not a domain: " + labels(root));
  const agent = find(root, "Agent")!;
  assert.ok(agent && labels(agent).includes("Subagent"), "the compound is nested under its parent: " + labels(root) + " / " + (agent ? labels(agent) : ""));
});

test("domain view: words that describe the code rather than the product (select, recursive, parameter, status) are not domains", () => {
  for (const w of ["select", "recursive", "parameter", "status", "sub"]) assert.ok(GENERIC_WORDS.has(w), w);
});
