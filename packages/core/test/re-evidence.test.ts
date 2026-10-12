// C33 — reverse-engineering evidence. Dispatches through the same operation table the HTTP gateway
// serves (opsFor), with the store seeded directly: the worker binary is not built in this environment
// and nothing here indexes. Under test: fog inventory over seeded imports_external facts, bundle
// import/authentication (including a tampered bundle refusal), list, export round-trip.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubProvider } from "@cie/model";
import type { AnalysisBatch, Entity, EvidenceRef, Fact, SourceSpan } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient, defaultWorkerPath, type ArtifactProbeReport } from "../src/worker.ts";
import { opsFor } from "../src/server.ts";
import { recordsFromProbe } from "../src/re-evidence.ts";
import {
  bundleDigest,
  claimClassOf,
  createReEvidenceBundle,
  evidenceId,
  parseReEvidenceBundle,
  serializeReEvidenceBundle,
  type ReEvidenceIdentity,
  type ReEvidenceRecord,
} from "@cie/evidence";

const REV = "rev-re-test-1";
const RUN_DIR = mkdtempSync(join(tmpdir(), "cie-re-test-"));
process.on("exit", () => {
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const FILES: Record<string, string> = {
  "src/app.ts": "import { pad } from 'left-pad';\nexport function app() {\n  return pad('x');\n}\n",
};

function spanOf(sourceId: string, startByte: number, endByteExclusive: number): SourceSpan {
  return { sourceId, contentHash: createHash("sha256").update(FILES[sourceId] ?? "").digest("hex"), revision: REV, startByte, endByteExclusive };
}

function evidenceRef(id: string, sourceId: string): EvidenceRef {
  return { id, sourceId, location: { kind: "CodeLocation", span: spanOf(sourceId, 0, 30) }, class: "STATIC_PARSED", observedAt: "2026-10-12T00:00:00Z", accessScopeId: "local", state: "CURRENT" };
}

function seedStore() {
  const repoRoot = mkdtempSync(join(RUN_DIR, "repo-"));
  for (const [f, text] of Object.entries(FILES)) {
    mkdirSync(join(repoRoot, join(f, "..")), { recursive: true });
    writeFileSync(join(repoRoot, f), text);
  }
  const store = new Store(":memory:");
  const entities: Entity[] = [
    { entityId: "file:src/app.ts", kind: "file", name: "app.ts", file: "src/app.ts", spans: [spanOf("src/app.ts", 0, FILES["src/app.ts"].length)], symbolHash: `sym-app` },
  ];
  const facts: Fact[] = [
    {
      id: "fact:external-import:src/app.ts:left-pad",
      subject: "file:src/app.ts",
      predicate: "imports_external",
      object: { kind: "ScalarValue", value: "left-pad" },
      evidence: [evidenceRef("e:imp-left-pad", "src/app.ts")],
      resolution: "PARSED",
    },
  ];
  const batch: AnalysisBatch = {
    revision: REV, gitHead: null, repoRoot, entities, relationships: [], facts, diagnostics: [], analyzerVersion: "re-test",
    manifest: Object.fromEntries(Object.keys(FILES).map((f) => [f, `d-${f}`])),
  };
  store.putBatch(batch);
  let worker: WorkerClient;
  try {
    worker = new WorkerClient();
  } catch {
    worker = new WorkerClient("/bin/cat");
  }
  const svc = new Service(store, worker, new StubProvider());
  return { svc, store, repoRoot };
}

const CTX = {
  requestId: "req-re-1",
  idempotencyKey: "idem-re-1",
  actor: { principalId: "local", tenantId: "local", sessionId: "session-re-1" },
  deadlineMs: Date.now() + 10_000,
  traceId: "trace-re-1",
};

function record(overrides: Partial<ReEvidenceIdentity> = {}): ReEvidenceRecord {
  const identity: ReEvidenceIdentity = {
    subject: { path: "node_modules/left-pad/index.js", sha256: "a".repeat(64), format: "javascript-package" },
    provider: { id: "re-test-tool", name: "RE Test Tool", version: "1.0" },
    predicate: "contains_function",
    confidence: "observed",
    authority: "shipped-artifact",
    limitations: ["test fixture"],
    locations: [{ kind: "artifactPath", value: "node_modules/left-pad/index.js" }],
    ...overrides,
  };
  return { ...identity, id: evidenceId(identity), revision: REV, state: "CURRENT", observedAt: "2026-10-12T00:00:00Z" };
}

test("C33: fog inventory lists the unresolved external module, without evidence at first", () => {
  const { svc } = seedStore();
  const r = opsFor(svc)["C33/fogInventory"]!.run(CTX, { revision: REV }) as Promise<any>;
  return r.then((result) => {
    assert.equal(result.ok, true);
    const row = result.value.rows.find((x: any) => x.module === "left-pad");
    assert.ok(row, "left-pad appears in the fog inventory");
    assert.equal(row.references, 1);
    assert.equal(row.hasEvidence, false);
    assert.match(result.value.note, /heuristic/);
  });
});

test("C33: importing an authenticated bundle stores its records and links the fog row by the stated heuristic", async () => {
  const { svc } = seedStore();
  const ops = opsFor(svc);
  const bundle = createReEvidenceBundle({ revision: REV, records: [record()], unknowns: [] });
  const imported = await ops["C33/importBundle"]!.run(CTX, { revision: REV, bundleText: serializeReEvidenceBundle(bundle) }) as any;
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.value.importedRecords, 1);

  const fog = await ops["C33/fogInventory"]!.run(CTX, { revision: REV }) as any;
  assert.equal(fog.value.rows.find((x: any) => x.module === "left-pad").hasEvidence, true);

  const list = await ops["C33/listEvidence"]!.run(CTX, { revision: REV }) as any;
  assert.equal(list.value.records.length, 1);
  assert.equal(list.value.records[0].claimClass, "FACT", "observed confidence is FACT-eligible");

  const exported = await ops["C33/exportBundle"]!.run(CTX, { revision: REV }) as any;
  assert.equal(exported.ok, true);
  const parsed = JSON.parse(exported.value.serialized);
  assert.equal(exported.value.bundleDigest, bundleDigest(parsed));
  assert.equal(parsed.records[0].id, bundle.records[0]!.id);
});

test("C33: a tampered bundle is refused and nothing is stored", async () => {
  const { svc, store } = seedStore();
  const ops = opsFor(svc);
  const bundle = createReEvidenceBundle({ revision: REV, records: [record()], unknowns: [] });
  const tampered = { ...JSON.parse(serializeReEvidenceBundle(bundle)) };
  tampered.records[0].confidence = "inferred";
  const refused = await ops["C33/importBundle"]!.run(CTX, { revision: REV, bundleText: JSON.stringify(tampered) }) as any;
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "INVALID_SCHEMA");
  assert.match(refused.error.message, /content/);
  const count = (store.db.prepare("select count(*) c from re_records").get() as any).c;
  assert.equal(count, 0, "nothing from the refused bundle was stored");
});

test("C33: a bundle bound to another revision is refused; an unknown revision is refused", async () => {
  const { svc } = seedStore();
  const ops = opsFor(svc);
  const stranger = createReEvidenceBundle({ revision: "rev-other", records: [{ ...record(), revision: "rev-other" }], unknowns: [] });
  const wrongRev = await ops["C33/importBundle"]!.run(CTX, { revision: REV, bundleText: serializeReEvidenceBundle(stranger) }) as any;
  assert.equal(wrongRev.ok, false);
  assert.match(wrongRev.error.message, /binds to revision rev-other/);

  const goodBundle = createReEvidenceBundle({ revision: "rev-does-not-exist", records: [{ ...record(), revision: "rev-does-not-exist" }], unknowns: [] });
  const unknownRev = await ops["C33/importBundle"]!.run(CTX, { revision: "rev-does-not-exist", bundleText: serializeReEvidenceBundle(goodBundle) }) as any;
  assert.equal(unknownRev.ok, false);
  assert.match(unknownRev.error.message, /unknown revision/);
});

test("C33: importing the same bundle twice is a no-op, not a duplicate", async () => {
  const { svc, store } = seedStore();
  const ops = opsFor(svc);
  const bundle = createReEvidenceBundle({ revision: REV, records: [record()], unknowns: [] });
  const text = serializeReEvidenceBundle(bundle);
  await ops["C33/importBundle"]!.run(CTX, { revision: REV, bundleText: text }) as any;
  await ops["C33/importBundle"]!.run(CTX, { revision: REV, bundleText: text }) as any;
  const count = (store.db.prepare("select count(*) c from re_records").get() as any).c;
  assert.equal(count, 1, "content-addressed ids make re-import idempotent");
});

// ---- Artifact probe: pointing the panel at a jar / .so / .exe and letting it do its magic. ----

const probeReport: ArtifactProbeReport = {
  path: "vendor/left-pad/left-pad-1.2.3.jar",
  sizeBytes: 2048,
  sha256: "b".repeat(64),
  format: "jar",
  formatDetail: "java archive (zip with class files)",
  claims: [
    { predicate: "is a jar file (java archive)", confidence: "observed", authority: "shipped-artifact", limitations: [], locations: [{ kind: "fileOffset", value: "0x0" }] },
    { predicate: "manifest Implementation-Version is \"1.2.3\"", confidence: "observed", authority: "shipped-artifact", limitations: ["self-reported by the artifact; a label is not a proof of provenance"], locations: [{ kind: "artifactPath", value: "META-INF/MANIFEST.MF" }] },
    { predicate: "class files were compiled for Java 8 (class-file major 52)", confidence: "derived", authority: "shipped-artifact", limitations: ["sampled up to 512 entries"], locations: [] },
    // An exact repeat of the first claim: same observation, same content address — one record, not two.
    { predicate: "is a jar file (java archive)", confidence: "observed", authority: "shipped-artifact", limitations: [], locations: [{ kind: "fileOffset", value: "0x0" }] },
  ],
  unresolved: [
    { question: "Which upstream project produced vendor/left-pad/left-pad-1.2.3.jar?", reason: "no pom.properties and no identifying manifest attributes are present" },
  ],
  notes: [],
};

test("C33 probe: claims become authenticated evidence records and questions become unknowns", () => {
  const { records, unknowns } = recordsFromProbe(probeReport, REV);
  assert.equal(records.length, 3, "identical claims collapse to one content address");
  // The round-trip every stored bundle must survive: recompute ids and digest from content.
  const bundle = createReEvidenceBundle({ revision: REV, records, unknowns });
  const parsed = parseReEvidenceBundle(serializeReEvidenceBundle(bundle));
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.digest, bundle.digest);
  const derived = parsed.records.find((r) => r.confidence === "derived");
  assert.ok(derived, "the derived claim is present");
  assert.equal(claimClassOf(derived!), "INFERENCE", "derived confidence maps to inference, not fact");
  assert.equal(parsed.unknowns.length, 1);
  assert.equal(parsed.unknowns[0]!.status, "open");
  assert.match(parsed.unknowns[0]!.reason!, /pom\.properties/);
  assert.equal(parsed.records[0]!.subject.path, "vendor/left-pad/left-pad-1.2.3.jar", "the subject is the probed artifact");
  assert.equal(parsed.records[0]!.subject.sha256, "b".repeat(64));
});

test("C33 probe: a path outside the repository is refused before any file is read", async () => {
  const { svc } = seedStore();
  const ops = opsFor(svc);
  const refused = await ops["C33/analyzeArtifact"]!.run(CTX, { revision: REV, path: "../../../etc/passwd" }) as any;
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /does not resolve inside/);
  const absolute = await ops["C33/analyzeArtifact"]!.run(CTX, { revision: REV, path: "/etc/passwd" }) as any;
  assert.equal(absolute.ok, false);
});

/** Minimal structurally-correct zip with stored entries — the same bytes the Rust tests build. */
function zipBuild(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, "utf8");
    const lho = locals.reduce((s, b) => s + b.length, 0);
    const head = Buffer.alloc(30);
    head.write("PK\x03\x04", 0, "latin1");
    head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(0, 8); // version, flags, method=stored
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0, 12); // time, date
    head.writeUInt32LE(0, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nb.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, nb, data);
    const c = Buffer.alloc(46);
    c.write("PK\x01\x02", 0, "latin1");
    c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0, 14);
    c.writeUInt32LE(0, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nb.length, 28);
    c.writeUInt32LE(lho, 42);
    central.push(Buffer.concat([c, nb]));
  }
  const dirOffset = locals.reduce((s, b) => s + b.length, 0);
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\x05\x06", 0, "latin1");
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(dirOffset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

test("C33 probe: analyzeArtifact on a real jar stores its evidence, links the fog row, and re-runs idempotently", { skip: !existsSync(defaultWorkerPath()) }, async () => {
  const { svc, repoRoot } = seedStore();
  const ops = opsFor(svc);
  const jar = zipBuild([
    ["META-INF/MANIFEST.MF", Buffer.from("Manifest-Version: 1.0\r\nImplementation-Title: left-pad\r\nImplementation-Version: 1.2.3\r\n", "utf8")],
  ]);
  mkdirSync(join(repoRoot, "vendor", "left-pad"), { recursive: true });
  writeFileSync(join(repoRoot, "vendor", "left-pad", "left-pad-1.2.3.jar"), jar);

  const analyzed = await ops["C33/analyzeArtifact"]!.run(CTX, { revision: REV, path: "vendor/left-pad/left-pad-1.2.3.jar" }) as any;
  assert.equal(analyzed.ok, true, JSON.stringify(analyzed));
  assert.equal(analyzed.value.format, "jar");
  assert.match(analyzed.value.formatDetail, /java archive/);
  assert.equal(analyzed.value.sha256.length, 64);
  assert.ok(analyzed.value.claims.some((c: any) => /Implementation-Version is "1\.2\.3"/.test(c.predicate)), JSON.stringify(analyzed.value.claims));
  assert.ok(analyzed.value.bundleDigest.startsWith("pf-canon-v1/"));

  // The probe's subject path names the fog module, so the stated heuristic links them.
  const fog = await ops["C33/fogInventory"]!.run(CTX, { revision: REV }) as any;
  assert.equal(fog.value.rows.find((x: any) => x.module === "left-pad").hasEvidence, true);

  // Re-running the probe re-derives the same content addresses: no duplicates.
  const again = await ops["C33/analyzeArtifact"]!.run(CTX, { revision: REV, path: "vendor/left-pad/left-pad-1.2.3.jar" }) as any;
  assert.equal(again.ok, true);
  const list = await ops["C33/listEvidence"]!.run(CTX, { revision: REV }) as any;
  const ids = new Set(list.value.records.map((r: any) => r.id));
  assert.equal(list.value.records.length, ids.size, "content-addressed ids keep a re-probe idempotent");
  assert.ok(list.value.unknowns.length >= 1, "the probe's unanswerable question is recorded as a residual unknown");
});
