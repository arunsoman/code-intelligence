import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { extractArtifacts } from "../src/artifacts.ts";
import { Indexer } from "../src/indexer.ts";
import type { Store } from "../src/store.ts";
import { ctx, setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/polyglot");
const GOLDEN = join(REPO, "golden/expected.txt");
const J = "java/src/main/java/com/acme";
const copy = () => { const d = mkdtempSync(join(tmpdir(), "cie-poly-")); cpSync(REPO, d, { recursive: true }); rmSync(join(d, "golden"), { recursive: true, force: true }); return d; };
const edit = (dir: string, rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));

function snapshot(store: Store, revision: string): string {
  return [
    ...store.entities(revision).filter((e) => e.kind !== "file").map((e) => `E ${e.entityId}`),
    ...store.allRelationships(revision).filter((r) => r.kind !== "contains").map((r) => `R ${r.kind} ${r.from} > ${r.to} ${r.resolution}`),
    ...store.allFacts(revision).filter((f) => ["calls", "imports", "imports_external", "throws", "writes", "uses_transaction"].includes(f.predicate)).map((f) => `F ${f.predicate} ${f.subject} ${JSON.stringify((f.object as any).value ?? (f.object as any).reason)} ${f.resolution}`),
  ].sort().join("\n") + "\n";
}
const rel = (store: Store, rev: string, kind: string, from: string, to: string) => store.allRelationships(rev).find((r) => r.kind === kind && r.from.endsWith(from) && r.to.endsWith(to));

test("Java (Spring Boot), Go and Python: a polyglot repository indexes to exactly the reviewed graph, and the parser says it reads them", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const got = snapshot(svc.store, revision);
  if (process.env.CIE_UPDATE_GOLDEN) writeFileSync(GOLDEN, got);
  assert.equal(got, readFileSync(GOLDEN, "utf8"), "the graph changed: review the diff, then regenerate with CIE_UPDATE_GOLDEN=1");
  const langs = await worker.languageCapabilities();
  for (const l of ["typescript", "rust", "java", "go", "python"]) assert.ok(l in langs, l);
  assert.ok(langs.java.some((c) => /Spring/.test(c)));
  const kinds = new Set(svc.store.entities(revision).map((e) => e.kind));
  for (const k of ["class", "interface", "method", "function", "struct", "test"]) assert.ok(kinds.has(k), k);
  const files = svc.store.entities(revision).filter((e) => e.kind === "file").map((e) => e.file.split(".").pop());
  assert.deepEqual([...new Set(files)].sort(), ["go", "java", "py"]);
  worker.close();
});

test("Spring Boot: calls through injected fields and parameters, same-package and cross-package references, @Transactional, @KafkaListener and a JUnit test are understood", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const S = svc.store;
  assert.equal(rel(S, revision, "calls", "PaymentController.create", "PaymentService.charge")?.resolution, "RESOLVED", "a call through a field of declared type");
  assert.equal(rel(S, revision, "calls", "PaymentController.create", "PaymentController.audit")?.resolution, "RESOLVED", "an implicit this call");
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "LedgerService.reserve")?.resolution, "RESOLVED", "across packages through an import");
  assert.ok(rel(S, revision, "imports", "PaymentService.java", "LedgerService.java"));
  const tx = S.factsByPredicate(revision, "uses_transaction").map((f) => f.subject).filter((x) => x.includes("/java/"));
  assert.deepEqual(tx, [`method:${J}/pay/PaymentService.java#PaymentService.charge`], "only the @Transactional method");
  assert.ok(S.factsByPredicate(revision, "throws").some((f) => (f.object as any).value === "FraudRejectedException" && f.subject.endsWith("PaymentService.charge")));
  const writes = S.factsByPredicate(revision, "writes").map((f) => `${f.subject.replace(/^.*#/, "")}:${(f.object as any).value}`);
  assert.ok(writes.includes("PaymentService.charge:charged") && writes.includes("LedgerService.reserve:balance"));
  // The Kafka producer and the @KafkaListener consumer are joined by the literal topic, as an inference-grade async link.
  const flow = S.allRelationships(revision).find((r) => r.kind === "async-flow" && r.from.endsWith("PaymentService.charge") && r.to.endsWith("CaptureListener.onCaptured"));
  assert.ok(flow && flow.resolution === "PARSED" && /payment\.captured/.test(flow.label ?? ""));
  // The test is a test symbol and reaches the code under test.
  assert.ok(S.entities(revision).some((e) => e.kind === "test" && e.entityId.endsWith("PaymentServiceTest.chargesAnAccount")));
  assert.equal(rel(S, revision, "calls", "PaymentServiceTest.chargesAnAccount", "PaymentService.charge")?.resolution, "RESOLVED", "main and test sources of one package see each other");
  // Dispatch through an interface-typed field resolves to the interface's declaration, never to one implementation.
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "PaymentGateway.authorize")?.resolution, "RESOLVED");
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "CardGateway.authorize"), undefined, "the implementation is not guessed");
  // What cannot be named stays unknown: a call on an external template.
  assert.ok(S.allFacts(revision).some((f) => f.predicate === "calls" && f.resolution === "UNRESOLVED" && f.subject.endsWith("PaymentService.charge") && /kafkaTemplate\.send/.test(String((f.object as any).reason))));
  worker.close();
});

test("Go: packages, methods on receivers, typed struct fields across packages, panics, tests, and calls through maps that stay unknown", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const S = svc.store;
  assert.equal(rel(S, revision, "calls", "Server.Handle", "Ledger.Reserve")?.resolution, "RESOLVED", "s.led.Reserve: struct field of an imported package's type");
  assert.equal(rel(S, revision, "calls", "Server.Handle", "ledger.go#Round")?.resolution, "RESOLVED", "ledger.Round through the import");
  assert.equal(rel(S, revision, "calls", "ledger.go#Round", "util.go#normalise")?.resolution, "RESOLVED", "a package-level function defined in another file of the package");
  assert.equal(rel(S, revision, "calls", "Ledger.Reserve", "Ledger.record")?.resolution, "RESOLVED", "a method call on the receiver");
  assert.equal(rel(S, revision, "calls", "main", "Server.Handle")?.resolution, "RESOLVED", "s := &Server{} gives s its type");
  assert.ok(S.factsByPredicate(revision, "throws").some((f) => (f.object as any).value === "panic" && f.subject.endsWith("Ledger.Reserve")));
  assert.ok(S.entities(revision).some((e) => e.kind === "test" && e.name === "TestReserve"));
  assert.equal(rel(S, revision, "calls", "TestReserve", "Ledger.Reserve")?.resolution, "RESOLVED");
  assert.ok(S.allFacts(revision).some((f) => f.predicate === "calls" && f.resolution === "UNRESOLVED" && /<computed>/.test(String((f.object as any).reason)) && f.subject.endsWith("#main")), "handlers[\"x\"]() is unknown");
  assert.deepEqual(S.factsByPredicate(revision, "imports_external").map((f) => (f.object as any).value).filter((v: string) => /^(fmt|sync|testing|net\/http)$/.test(v)).sort(), ["fmt", "net/http", "sync", "testing"], "standard-library imports are external, named without the language prefix");
  worker.close();
});

test("Python: relative, absolute and aliased imports, self methods, attributes typed by annotated parameters, decorators, raises, and getattr calls that stay unknown", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const S = svc.store;
  assert.ok(rel(S, revision, "imports", "service.py", "ledger.py"), "from .ledger import ...");
  assert.ok(rel(S, revision, "imports", "api.py", "service.py"));
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "round_amount")?.resolution, "RESOLVED", "a name imported from a relative module");
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "util.py#clean")?.resolution, "RESOLVED", "import app.util as util: absolute, aliased, source root not named");
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "Ledger.reserve")?.resolution, "RESOLVED", "self.ledger typed by the annotated __init__ parameter");
  assert.equal(rel(S, revision, "calls", "PaymentService.charge", "PaymentService._notify")?.resolution, "RESOLVED", "a self method");
  assert.equal(rel(S, revision, "calls", "create_payment", "PaymentService.charge")?.resolution, "RESOLVED", "an annotated parameter");
  assert.deepEqual(S.factsByPredicate(revision, "uses_transaction").map((f) => f.subject).filter((x) => x.includes("python/")).map((x) => x.replace(/^.*#/, "")), ["PaymentService.charge"], "@transaction.atomic");
  assert.ok(S.factsByPredicate(revision, "throws").some((f) => (f.object as any).value === "InsufficientFunds"));
  assert.ok(S.entities(revision).some((e) => e.kind === "test" && e.name === "test_charges_account"));
  assert.ok(S.allFacts(revision).some((f) => f.resolution === "UNRESOLVED" && f.subject.endsWith("#dynamic") && /<computed>/.test(String((f.object as any).reason))), "getattr(obj, name)() is unknown");
  // A Python publisher reaches the Java listener on the same topic: the join is by the literal string, whatever the language.
  assert.ok(S.allRelationships(revision).some((r) => r.kind === "async-flow" && r.from.endsWith("PaymentService._notify") && r.to.endsWith("CaptureListener.onCaptured")));
  worker.close();
});

test("routes in Spring, Flask and net/http are read as declarations and joined to their handlers; an unknown Go handler is absent, not guessed", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const set = extractArtifacts(svc.store, revision);
  const route = (n: string) => set.artifacts.find((a) => a.kind === "route" && a.name === n);
  assert.deepEqual([route("POST /api/payments")?.status, route("POST /api/payments")?.joins[0]?.replace(/^.*#/, "")], ["RESOLVED", "PaymentController.create"], "class-level @RequestMapping plus method-level @PostMapping");
  assert.equal(route("DELETE /api/accounts/{id}")?.joins[0]?.replace(/^.*#/, ""), "PaymentController.remove");
  assert.deepEqual([route("POST /payments")?.status, route("POST /payments")?.joins[0]?.replace(/^.*#/, "")], ["RESOLVED", "create_payment"], "Flask decorator");
  assert.equal(route("GET /health")?.joins[0]?.replace(/^.*#/, ""), "health");
  assert.deepEqual([route("ANY /charge")?.status, route("ANY /charge")?.joins[0]?.replace(/^.*#/, "")], ["RESOLVED", "chargeHandler"], "net/http");
  assert.equal(route("ANY /ghost")?.status, "ABSENT");
  assert.ok(set.diagnostics.some((d) => d.code === "ROUTE_HANDLER_ABSENT" && /missingHandler/.test(d.message)));
  worker.close();
});

test("incremental vs clean index across Java, Go and Python: edits, an addition and a deletion give the same graph as indexing from nothing", async () => {
  const dir = copy();
  const { svc, worker, revision } = await setup(undefined, dir);
  const ix = new Indexer(svc);
  edit(dir, `${J}/ledger/LedgerService.java`, (s) => s.replace("record(account);\n    }\n\n    public void release", "record(account);\n        record(account);\n    }\n\n    public void release"));
  edit(dir, "go/internal/ledger/util.go", (s) => s + "\nfunc double(x int) int { return normalise(x) * 2 }\n");
  writeFileSync(join(dir, "python/app/extra.py"), "from .util import clean\n\n\ndef tidy(v):\n    return clean(v)\n");
  rmSync(join(dir, `${J}/pay/CaptureListener.java`));
  const r2 = (await svc.ingestRepository(ctx(), { repoPath: dir }) as any).value.id as string;
  assert.notEqual(r2, revision);
  assert.ok((svc.store.revision(r2)!.diagnostics ?? []).some((d) => d.code === "REUSED_CACHED_PARSES"), "unchanged files were not parsed again");
  assert.ok(rel(svc.store, r2, "calls", "extra.py#tidy", "util.py#clean"));
  assert.ok(!svc.store.allRelationships(r2).some((r) => r.kind === "async-flow" && r.to.endsWith("onCaptured")), "the deleted listener's links are gone");
  const parity = await ix.compareWithCleanIndex(r2);
  assert.ok(parity.equivalent, parity.differences.join("\n"));
  worker.close();
});
