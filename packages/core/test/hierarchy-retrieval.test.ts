import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArchConcept, ConceptHierarchyView, SemanticConcept } from "@cie/schema";
import { HierarchyIndex } from "../src/hierarchy-retrieval.ts";

const node = (id: string, kind: ArchConcept["kind"], name: string, parent: string | null, children: string[], member?: string): ArchConcept =>
  ({ id, revision: "r", kind, name, path: name, parent, memberEntityIds: member ? [member] : [], children });
const concept = (id: string, kind: string, members: string[], label: string | null = null): SemanticConcept => ({
  id, revision: "r", kind, label, namedBy: label ? "MODEL" : null, members, evidenceIds: [], canonicalMotifHash: "h", compositionRule: null, features: {}, soundness: { tier: "supported", basis: "b" }, source: "MOTIF",
});

/** Functions given as `file#Class.method`, each with one concept (optionally named), under a package called `pkgName`. */
function viewOf(fns: { file: string; name: string; label?: string }[], pkgName = "payments"): ConceptHierarchyView {
  const arch: ArchConcept[] = [node("repo", "repo", "repo", null, ["pkg"]), node("pkg", "package", pkgName, "repo", [])];
  const concepts: SemanticConcept[] = [], links: ConceptHierarchyView["links"] = [];
  const mods = new Map<string, string>();
  fns.forEach((f, i) => {
    let mid = mods.get(f.file);
    if (!mid) { mid = `m${mods.size}`; mods.set(f.file, mid); arch.push(node(mid, "module", f.file.split("/").pop()!, "pkg", [])); arch.find((n) => n.id === "pkg")!.children.push(mid); }
    const entityId = `function:${f.file}#${f.name}`, fid = `f${i}`, method = f.name.split(".").pop()!;
    arch.push(node(fid, "function", method, mid, [], entityId));
    arch.find((n) => n.id === mid)!.children.push(fid);
    const c = concept(`c${i}`, "guarded-write", [entityId], f.label ?? null);
    concepts.push(c);
    for (const a of [fid, mid, "pkg", "repo"]) links.push({ conceptId: c.id, archNodeId: a });
  });
  return { revision: "r", version: 1, versions: [], concepts, invariants: [], arch, surfaces: [], entryPoints: [], crossPackage: [], links, stats: null };
}

const FNS = [
  { file: "src/customer/customer.service.ts", name: "CustomerService.addMerchant" },
  { file: "src/customer/customer.service.ts", name: "CustomerService.getMerchantList" },
  { file: "src/customer/customer.service.ts", name: "CustomerService.listAgents" },
  { file: "src/topup/topup.service.ts", name: "TopupService.createTopup" },
  { file: "src/topup/topup.service.ts", name: "TopupService.cancelTopup" },
  { file: "src/topup/topup.service.ts", name: "TopupService.refreshBalance" },
  { file: "src/auth/auth.controller.ts", name: "AuthController.login" },
  { file: "src/auth/auth.controller.ts", name: "AuthController.logout" },
];
const ids = (r: { ranked: { entityId: string }[] }, n = 99) => r.ranked.slice(0, n).map((x) => x.entityId.split("#")[1]);

test("a question's own words find the functions named for them, best match first", () => {
  const idx = new HierarchyIndex(viewOf(FNS));
  const r = idx.rank("how do we add a merchant", { mode: "flat" });
  assert.deepEqual(r.terms.includes("merchant"), true);
  assert.equal(ids(r, 1)[0], "CustomerService.addMerchant", "name and class words both match: " + ids(r).join(", "));
  assert.ok(ids(r).includes("CustomerService.getMerchantList"), "other merchant functions follow");
  assert.ok(!ids(r).includes("AuthController.logout"), "an unrelated function is not returned at all");
  assert.deepEqual(r.groups, [], "flat mode names no groups");
});

test("two-stage: the group the question names is chosen, and its members come before other weak matches", () => {
  const idx = new HierarchyIndex(viewOf(FNS));
  const two = idx.rank("what happens when a topup is cancelled", { mode: "two-stage" });
  assert.deepEqual(two.groups, ["Topup"], "stage 1 picked the Topup group by its label");
  const top = ids(two, 3);
  for (const f of ["TopupService.createTopup", "TopupService.cancelTopup", "TopupService.refreshBalance"]) assert.ok(top.includes(f), `${f} in ${top}`);
  assert.equal(ids(two, 1)[0], "TopupService.cancelTopup", "the function that matches the words itself still leads its group");
  assert.ok(two.ranked.find((x) => x.entityId.endsWith("refreshBalance"))!.why.includes("in a matching group"), "and it says why a function with no word of its own was included");
  const flat = idx.rank("what happens when a topup is cancelled", { mode: "flat" });
  assert.ok(ids(flat).includes("TopupService.refreshBalance"), "here flat search reaches the whole group too: its class and file names already carry the word 'topup'");
});

test("two-stage never loses a function that flat search finds, and only reorders: its group word comes from the same identifiers flat already reads", () => {
  const idx = new HierarchyIndex(viewOf([
    { file: "src/agent/agent.ts", name: "Agent.addAgent" }, { file: "src/agent/agent.ts", name: "Agent.editAgent" },
    { file: "src/sub/sub-agent.ts", name: "SubAgent.addSubAgent" }, { file: "src/sub/sub-agent.ts", name: "SubAgent.editSubAgent" },
    { file: "src/auth/auth.ts", name: "Auth.login" }, { file: "src/topup/topup.ts", name: "Topup.createTopup" },
  ]));
  for (const q of ["how are agents edited", "create a topup", "login", "subagent edit", "what does the auth module do"]) {
    const flat = new Set(ids(idx.rank(q, { mode: "flat" }))), two = new Set(ids(idx.rank(q, { mode: "two-stage" })));
    for (const f of flat) assert.ok(two.has(f), `${f} found by flat search but not by two-stage for "${q}"`);
    for (const f of two) if (!flat.has(f)) assert.ok(idx.rank(q, { mode: "two-stage" }).ranked.find((r) => r.entityId.endsWith("#" + f))!.why.includes("in a matching group"), `${f} appears only because of its group`);
  }
});

test("concept names written by a model are searchable, so a question can use the domain's words rather than the code's", () => {
  const v = viewOf([...FNS, { file: "src/ledger/x.ts", name: "Poster.apply", label: "withdraw funds from the wallet" }]);
  const r = new HierarchyIndex(v).rank("withdraw money from a wallet", { mode: "flat" });
  assert.equal(ids(r, 1)[0], "Poster.apply", ids(r).join(", "));
  assert.match(r.ranked[0].why.join(), /in concept/);
});

test("a question with no usable words, or an empty hierarchy, returns nothing rather than everything", () => {
  const idx = new HierarchyIndex(viewOf(FNS));
  assert.deepEqual(idx.rank("what is the and how"), { terms: [], groups: [], ranked: [] });
  assert.deepEqual(idx.rank("zzzzqqq nothingmatches").ranked, []);
  const empty = new HierarchyIndex({ ...viewOf(FNS), arch: [], concepts: [], links: [] });
  assert.deepEqual(empty.rank("topup").ranked, []);
});

test("ranking is deterministic, lists each function once, and a group and its parent are not both chosen", () => {
  const idx = new HierarchyIndex(viewOf(FNS));
  const a = idx.rank("customer merchant topup login", { mode: "two-stage", groups: 5 });
  const b = new HierarchyIndex(viewOf([...FNS].reverse())).rank("customer merchant topup login", { mode: "two-stage", groups: 5 });
  assert.deepEqual(a.ranked.map((r) => r.entityId).sort(), b.ranked.map((r) => r.entityId).sort());
  assert.deepEqual(ids(a), ids(b), "same code, same order, whatever order it was listed in");
  assert.equal(new Set(a.ranked.map((r) => r.entityId)).size, a.ranked.length);
  assert.ok(a.groups.length <= 5);
});
