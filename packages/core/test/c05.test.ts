import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Indexer } from "../src/indexer.ts";
import type { Store } from "../src/store.ts";
import { ctx, setup } from "./helpers.ts";

const GOLDEN_REPO = resolve(import.meta.dirname, "../../../fixtures/golden-multilang");
const GOLDEN = join(GOLDEN_REPO, "golden/expected.txt");
const copy = () => { const d = mkdtempSync(join(tmpdir(), "cie-ml-")); cpSync(GOLDEN_REPO, d, { recursive: true }); rmSync(join(d, "golden"), { recursive: true, force: true }); return d; };
const edit = (dir: string, rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));
const reindex = async (svc: any, dir: string) => { const r = await svc.ingestRepository(ctx(), { repoPath: dir }); assert.ok(r.ok, JSON.stringify(r.error)); return r.value.id as string; };

/** The graph as stable text: what exists, what is linked and how sure the link is, and what is left unknown. */
function snapshot(store: Store, revision: string): string {
  const lines = [
    ...store.entities(revision).map((e) => `E ${e.entityId}`),
    ...store.allRelationships(revision).filter((r) => r.kind !== "contains").map((r) => `R ${r.kind} ${r.from} > ${r.to} ${r.resolution}`),
    ...store.allFacts(revision).filter((f) => ["calls", "imports", "imports_external"].includes(f.predicate)).map((f) => `F ${f.predicate} ${f.subject} ${JSON.stringify(f.object)} ${f.resolution}`),
  ];
  return lines.sort().join("\n") + "\n";
}

test("golden multi-language repository: a TypeScript and a Rust package index to exactly the reviewed graph, and the parser says which languages it reads and how far", async () => {
  const { svc, worker, revision } = await setup(undefined, GOLDEN_REPO);
  const got = snapshot(svc.store, revision);
  if (process.env.CIE_UPDATE_GOLDEN) writeFileSync(GOLDEN, got);
  assert.equal(got, readFileSync(GOLDEN, "utf8"), "the graph changed: review the diff, then regenerate with CIE_UPDATE_GOLDEN=1");
  const langs = await worker.languageCapabilities();
  assert.ok("typescript" in langs && "rust" in langs);
  assert.ok(langs.typescript.some((c) => /PARSED/.test(c)) && langs.typescript.some((c) => /RESOLVED/.test(c)));
  const files = svc.store.entities(revision).filter((e) => e.kind === "file").map((e) => e.file);
  assert.deepEqual(files.sort(), ["rust/src/lib.rs", "rust/src/util.rs", "ts/main.ts", "ts/shapes.ts", "ts/util.ts"]);
  // Every language contributes declarations of its own kinds.
  const kinds = new Set(svc.store.entities(revision).map((e) => e.kind));
  for (const k of ["class", "method", "function", "trait", "struct", "module"]) assert.ok(kinds.has(k), k);
  worker.close();
});

test("cross-file references: imports and calls across files resolve to the right declaration in each language, and an edit that breaks a reference removes the link rather than guessing another", async () => {
  const dir = copy();
  const { svc, worker, revision } = await setup(undefined, dir);
  const rel = (rev: string, kind: string, from: string, to: string) => svc.store.allRelationships(rev).find((r) => r.kind === kind && r.from === from && r.to === to);
  const tsCall = rel(revision, "calls", "function:ts/main.ts#run", "function:ts/util.ts#helper");
  assert.ok(tsCall && tsCall.resolution === "RESOLVED" && tsCall.evidence.length > 0, "namespace import: util.helper(...)");
  assert.ok(rel(revision, "calls", "function:ts/main.ts#run", "function:ts/shapes.ts#makeCircle")?.resolution === "RESOLVED", "named import");
  assert.ok(rel(revision, "calls", "method:ts/shapes.ts#Circle.area", "function:ts/util.ts#helper")?.resolution === "RESOLVED", "a method calling an imported function");
  assert.ok(rel(revision, "calls", "function:rust/src/lib.rs#run", "function:rust/src/util.rs#helper")?.resolution === "RESOLVED", "Rust: util::helper through a module");
  assert.ok(rel(revision, "calls", "method:rust/src/lib.rs#Dog.speak", "function:rust/src/util.rs#helper")?.resolution === "RESOLVED", "Rust: from an impl block");
  assert.ok(rel(revision, "imports", "file:rust/src/lib.rs", "file:rust/src/util.rs")?.resolution === "RESOLVED", "mod util; is the file it names");
  // The same name in the other language is a different thing: no edge between them.
  assert.ok(![...svc.store.allRelationships(revision)].some((r) => (r.from.includes("ts/") && r.to.includes("rust/")) || (r.from.includes("rust/") && r.to.includes("ts/"))), "TypeScript and Rust do not link by name");
  // Rename the TypeScript helper in util.ts only: the callers' references no longer resolve, and are not re-pointed at the Rust helper or anything else.
  edit(dir, "ts/util.ts", (s) => s.replace("export function helper", "export function helperRenamed"));
  const r2 = await reindex(svc, dir);
  assert.equal(rel(r2, "calls", "function:ts/main.ts#run", "function:ts/util.ts#helper"), undefined);
  assert.ok(![...svc.store.allRelationships(r2)].some((r) => r.kind === "calls" && r.to.endsWith("#helper") && r.from.startsWith("function:ts/")), "no guessed replacement");
  assert.ok(svc.store.allFacts(r2).some((f) => f.predicate === "calls" && f.subject === "function:ts/main.ts#run" && f.resolution === "UNRESOLVED"), "what no longer resolves is unknown, not absent");
  assert.ok(rel(r2, "calls", "function:rust/src/lib.rs#run", "function:rust/src/util.rs#helper"), "the Rust side is unaffected");
  worker.close();
});

test("dynamic dispatch: computed calls, calls through objects of unknown type, trait objects and external functions stay unknown, with a reason, and never become edges", async () => {
  const { svc, worker, revision } = await setup(undefined, GOLDEN_REPO);
  const unknown = svc.store.allFacts(revision).filter((f) => f.predicate === "calls" && f.resolution === "UNRESOLVED");
  const reasons = unknown.map((f) => `${f.subject.replace(/^[a-z]+:/, "")} ${(f.object as any).reason}`);
  assert.ok(reasons.some((r) => /ts\/main\.ts#run .*<computed>/.test(r)), "table[kind]() is computed");
  assert.ok(reasons.some((r) => /ts\/main\.ts#viaAny .*<computed>/.test(r)), "obj[name]() is computed");
  assert.ok(reasons.some((r) => /rust\/src\/lib\.rs#run .*animal\.speak/.test(r)), "a trait object's method is not resolved to one impl");
  assert.ok(reasons.some((r) => /ts\/main\.ts#run .*c\.area/.test(r)), "a method on a value whose type is not tracked");
  assert.ok(reasons.some((r) => /ts\/main\.ts#run .*external/.test(r)), "a function from another package");
  for (const f of unknown) assert.equal((f.object as any).kind, "UnknownValue", "unknown, not a guess");
  // None of them is an edge: relationships only say what was resolved.
  const edges = svc.store.allRelationships(revision).filter((r) => r.kind === "calls");
  assert.ok(edges.every((r) => r.resolution === "RESOLVED" && r.evidence.length > 0));
  assert.ok(!edges.some((r) => r.from === "function:rust/src/lib.rs#run" && r.to === "method:rust/src/lib.rs#Dog.speak"), "the trait object is not assumed to be Dog");
  assert.ok(!edges.some((r) => r.from === "function:ts/main.ts#run" && (r.to.endsWith("#onA") || r.to.endsWith("#onB"))), "the table's entries are not assumed callable from run");
  // A parsed fact stays parsed: an external import is recorded as imported, not as resolved to code in this repository.
  const ext = svc.store.allFacts(revision).find((f) => f.predicate === "imports_external")!;
  assert.deepEqual([(ext.object as any).value, ext.resolution], ["some-package", "PARSED"]);
  worker.close();
});

test("incremental vs clean-index equivalence: after edits in both languages, a deletion and an addition, the incrementally built graph equals one built from nothing", async () => {
  const dir = copy();
  const { svc, worker, revision } = await setup(undefined, dir);
  const ix = new Indexer(svc);
  edit(dir, "ts/shapes.ts", (s) => s.replace("* 3", "* 4"));
  edit(dir, "rust/src/util.rs", (s) => s + "\npub fn shout(s: &str) -> String { helper(s).to_uppercase() }\n");
  writeFileSync(join(dir, "ts/extra.ts"), 'import { helper } from "./util";\nexport function extra() { return helper(2); }\n');
  writeFileSync(join(dir, "ts/util.ts"), "export function helper(n: number): number {\n  return n + 2;\n}\n");
  const r2 = await reindex(svc, dir);
  assert.notEqual(r2, revision);
  const reuse = (svc.store.revision(r2)!.diagnostics ?? []).find((d) => d.code === "REUSED_CACHED_PARSES");
  assert.ok(reuse, "unchanged files were not parsed again");
  const parity = await ix.compareWithCleanIndex(r2);
  assert.ok(parity.equivalent, parity.differences.join("\n"));
  assert.equal(parity.incremental.entities, parity.clean.entities);
  rmSync(join(dir, "rust/src/util.rs"));
  edit(dir, "rust/src/lib.rs", (s) => s.replace("mod util;\n", "").replaceAll("util::helper(\"woof\")", "String::new()").replaceAll("util::helper(\"x\")", "String::new()"));
  const r3 = await reindex(svc, dir);
  const parity3 = await ix.compareWithCleanIndex(r3);
  assert.ok(parity3.equivalent, parity3.differences.join("\n"));
  worker.close();
});
