// F05 trace-linked continuous profiling, end-to-end against a REAL profile: `node --cpu-prof --cpu-prof-interval=100`
// collects a V8 .cpuprofile of a hot loop, the worker parses and aggregates it, the engine persists the population and
// links it to recorded runtime traces. One executable check per invariant:
//   A1 the full chain (endpoint → exemplar → population → hotspot → entity link), A2 build/revision mismatch never
//   claims a source line, A3 kinds are never mixed, A4 dropped/unreported samples are disclosed (null → "not
//   reported"), A5 lives in profile-pure.test.ts, A6 compare refuses populations with diverging error rates, D2 the
//   stored line is 1-based, D8 the wording stays about windows and populations, D9 denied files collapse into one
//   "(withheld)" row with denominators kept, and a deleted repository takes its profile links with it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { StubProvider } from "@cie/model";
import { Service } from "../src/service.ts";
import { WorkerClient } from "../src/worker.ts";
import { Store } from "../src/store.ts";
import { Profiles } from "../src/profiles-analysis.ts";
import { Runtime } from "../src/runtime.ts";
import { deleteRepository } from "../src/storage.ts";
import { ctx } from "./helpers.ts";

// A real hot file the indexer also parses: the CIE indexer supports .ts (not .js), and Node strips the types itself,
// so the same file is what runs and what gets indexed — the profile's frames and the revision's entities line up.
const HOT_TS = `function taxOf(n: number): number { let s = 0; for (let i = 0; i < n * 8; i++) s = (s + (i % 7)) | 0; return s; }
function shipping(n: number): number { let s = 0; for (let i = 0; i < n * 4; i++) s ^= i << (i % 3); return s; }
function secretLoad(n: number): number { let s = 0; for (let i = 0; i < n * 6; i++) s = (s * 31 + i) | 0; return s; }
const t = Date.now();
while (Date.now() - t < 500) { taxOf(260); shipping(130); secretLoad(190); }
`;

describe("profile flow (F05)", () => {
  const RUN_DIR = mkdtempSync(join(tmpdir(), "cie-f05-"));
  process.on("exit", () => { try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

  let svc: Service, store: Store, runtime: Runtime, profiles: Profiles, worker: WorkerClient;
  after(() => worker?.close());
  let repoDir = "", repoRoot = "", rev = "", rev2 = "", hotHash = "";
  let startMs = 0, hotPath = "", foldedPath = "";

  const cnt = (t: string) => (store.db.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n;

  test("full chain (A1 + D2): a real --cpu-prof run is ingested, correlated to a windowed trace, and hotspots link back to entities", { timeout: 120_000 }, async () => {
    repoDir = mkdtempSync(join(RUN_DIR, "repo-"));
    mkdirSync(join(repoDir, "src", "secrets"), { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "hot-profile", private: true }), { encoding: "utf8" });
    writeFileSync(join(repoDir, "src", "tax.ts"), HOT_TS, { encoding: "utf8" });
    writeFileSync(join(repoDir, "src", "secrets", "keys.ts"), "export const KEY = 'x';\n", { encoding: "utf8" });
    store = new Store(":memory:"); worker = new WorkerClient(); svc = new Service(store, worker, new StubProvider());
    store = svc.store; runtime = new Runtime(store); profiles = new Profiles(store, worker);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: repoDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoDir });
    const r0 = await svc.ingestRepository(ctx(), { repoPath: repoDir });
    assert.strictEqual(r0.ok, true);
    rev = r0.value!.id;
    repoRoot = store.revision(rev)!.repoRoot;
    // the hot file is the one the indexer parsed; node strips the types and runs it
    const name = `hot-${Date.now()}.cpuprofile`;
    hotPath = join(RUN_DIR, name);
    execFileSync(process.execPath, ["--cpu-prof", "--cpu-prof-dir", RUN_DIR, `--cpu-prof-name=${name}`, "--cpu-prof-interval=100", join(repoDir, "src", "tax.ts")], { stdio: "ignore", timeout: 60_000 });
    assert.strictEqual(existsSync(hotPath), true);
    // the profile's own clock is relative to the run; its window is anchored at the file's mtime, so traces must sit there
    startMs = Date.now();
    foldedPath = join(RUN_DIR, "folded.txt");
    writeFileSync(foldedPath, "runtime.main;taxOf 120\nruntime.main;shipping 60\nruntime.main;taxOf 30\n", { encoding: "utf8" });

    // record the runtime side FIRST, so ingestion can resolve the build: marker + one envelope inside the profile window
    runtime.recordMarker({ sourceId: "orders-api", deploymentId: "d1", revision: rev, at: startMs - 700 });
    const ing1 = runtime.ingest({
      id: "env:orders-1", sourceId: "orders-api", codeRevision: rev, window: { from: startMs - 900, to: startMs + 300 },
      backendHandle: "reported", signalKind: "trace",
      spans: [
        { traceId: "t1", spanId: "s0", name: "POST /checkout", startMs: startMs - 500, endMs: startMs - 300 },
        { traceId: "t1", spanId: "s1", parentId: "s0", name: "tax compute", startMs: startMs - 480, endMs: startMs - 400 },
      ],
    });
    assert.strictEqual(ing1.ok, true);

    // ingest: the worker parses; the engine persists aggregates and discloses the window
    const ing = await profiles.ingestProfile({ path: hotPath, serviceHint: "orders-api", revisionHint: rev });
    hotHash = ing.artifactHash;
    assert.ok(hotHash);
    assert.deepStrictEqual(ing.sampleTypes.map((s) => s.kind), ["CPU"]);
    assert.strictEqual(ing.droppedSamples, "NOT_REPORTED"); // NULL means "not reported" (A4)
    // modern V8's clock is relative to the run: the window is anchored at the file's mtime and the anchoring is disclosed
    assert.ok(ing.diagnostics.some((d) => d.code === "PROFILE_CLOCK_ANCHORED_AT_MTIME"));
    assert.ok(ing.startNs > 0 && ing.endNs > ing.startNs);
    assert.strictEqual(ing.buildState, "MATCHED"); // the caller declared the build with a hint

    const corr = profiles.correlate({ artifactHash: hotHash, traceSourceId: "orders-api" });
    assert.strictEqual(corr.links[0].grade, "WINDOW_OVERLAP");           // honest grade for this boundary
    assert.match(corr.links[0].reason, /overlap|window/i);      // window wording, not "this request" (D8)
    assert.doesNotMatch(corr.links[0].reason, /this request/);
    assert.ok(corr.populationHash.startsWith("pop:"));
    assert.ok((profiles.listPopulations({ traceSourceId: "orders-api" }).length) > (0));
    assert.strictEqual(corr.build.state, "MATCHED");
    assert.ok(["HINT", "BINDING"].includes(profiles.resolveRevision(hotHash).source)); // the declared binding is remembered

    const eps = profiles.endpointStats({ window: { from: startMs - 900, to: startMs + 300 } });
    assert.ok((eps.endpoints.length) > (0));
    assert.ok((eps.sampledTraces) > (0));

    const hot = profiles.queryHotspots({ artifactHash: hotHash, limit: 5000 });
    assert.ok((hot.rows.length) > (0));
    assert.strictEqual(hot.unit, "microseconds");
    assert.strictEqual(hot.basis, "MEASURED_PROFILE");
    const linked = hot.rows.filter((x) => x.functionKey !== "__unattributed__").find((x) => x.entityId && x.file.includes("tax.ts") && x.name === "taxOf");
    assert.ok(linked);                  // A1: the hotspot links back to the indexed entity
    assert.strictEqual(linked!.attributionMethod, "CODE_LOCATION_EXACT");
    assert.ok((linked!.line) > (0));      // D2: the stored line is 1-based
    // population arithmetic keeps the whole sample inside the table's denominators
    let counted = 0; for (const r of hot.rows) counted += r.selfValue;
    assert.ok(Math.abs(counted - (hot.populationValue)) <= (hot.populationValue * 0.02 + 1));
  });

  test("build mismatch (A2): when the binding says a different build, line links stay closed and the state is MISMATCH", { timeout: 60_000 }, async () => {
    writeFileSync(join(repoDir, "src", "tax.ts"), HOT_TS.replace("function taxOf(", "function taxOfLegacy(").replace("taxOf(260)", "taxOfLegacy(260)"), { encoding: "utf8" });
    const r2 = await svc.ingestRepository(ctx(), { repoPath: repoDir });
    assert.strictEqual(r2.ok, true);
    rev2 = r2.value!.id;
    // the marker claims the deployment at this time ran the NEW build; the profile's own functions disagree with it
    runtime.recordMarker({ sourceId: "orders-api", deploymentId: "d2", revision: rev2, at: startMs - 600 });
    // the caller declares the NEW build (the deployment marker agrees); the profile's own frames still name the old code
    const ing = await profiles.ingestProfile({ path: hotPath, serviceHint: "orders-api", revisionHint: rev2 });
    assert.strictEqual(ing.buildState, "MISMATCH");
    const hot = profiles.queryHotspots({ artifactHash: ing.artifactHash, limit: 5000 });
    const renamed = hot.rows.find((x) => x.name === "taxOf");
    assert.ok(renamed);                                                              // the hot function is still reported
    assert.notStrictEqual(renamed!.attributionMethod, "CODE_LOCATION_EXACT");        // but never with a precise line claim
    assert.ok(!renamed!.entityId);
    const unchanged = hot.rows.find((x) => x.name === "shipping");
    assert.ok(unchanged);                                                            // unrelated code did not change
    const m = store.db.prepare("select revision_state from profile_mappings where artifact_hash = ?").get(ing.artifactHash) as { revision_state: string };
    assert.strictEqual(m.revision_state, "MISMATCH");
  });

  test("kinds (A3): a CPU profile and folded stack counts are separate kinds with different units, never one number", { timeout: 60_000 }, async () => {
    const folded = await profiles.ingestProfile({ path: foldedPath });
    assert.deepStrictEqual(folded.sampleTypes.map((s) => s.kind), ["OTHER"]);
    assert.deepStrictEqual(folded.sampleTypes.map((s) => s.unit), ["samples"]);
    const a = store.db.prepare("select revision from profile_mappings where artifact_hash = ? and revision is not null limit 1").get(hotHash) as { revision?: string } | undefined;
    assert.ok(a?.revision);
    const hot = profiles.queryHotspots({ artifactHash: hotHash, ordinal: 0 });
    assert.strictEqual(hot.unit, "microseconds");
    void cnt; // counts are read through the store elsewhere
  });

  test("disclosure (A4): a sparse, unannotated profile reports its collection shortfall and NOT_REPORTED drops", { timeout: 60_000 }, async () => {
    const p = join(RUN_DIR, "sparse.cpuprofile");
    const t1 = (Date.now() - 2_000) * 1_000; // µs, a wall-clock window
    writeFileSync(p, JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
        { id: 2, callFrame: { functionName: "sparseFn", url: "file:///x/src/tax.ts", lineNumber: 39, columnNumber: 1 }, children: [] },
      ],
      startTime: t1, endTime: t1 + 1_000_000, timeDeltas: [100, 100, 100], samples: [2, 2, 2], sampleInterval: 100,
    }, null, 2), { encoding: "utf8" });
    const ing = await profiles.ingestProfile({ path: p });
    assert.strictEqual(ing.droppedSamples, "NOT_REPORTED");
    const hot = profiles.queryHotspots({ artifactHash: ing.artifactHash });
    assert.ok((hot.coverage.collectionRatio ?? 1) < (0.9));
  });

  test("access (D9/D11): denied files collapse into one (withheld) row, denominators unchanged, no names leak", { timeout: 60_000 }, async () => {
    const p = join(RUN_DIR, "secret.cpuprofile");
    const t1 = (Date.now() - 1_000) * 1_000; // µs, a wall-clock window
    writeFileSync(p, JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
        { id: 2, callFrame: { functionName: "loadSecrets", url: `file://${repoDir}/src/secrets/keys.ts`, lineNumber: 0, columnNumber: 1 }, children: [] },
        { id: 3, callFrame: { functionName: "taxOf", url: `file://${repoDir}/src/tax.ts`, lineNumber: 40, columnNumber: 1 }, children: [] },
      ],
      startTime: t1, endTime: t1 + 500_000, timeDeltas: [100, 100, 100, 100, 100], samples: [3, 2, 3, 2, 3], sampleInterval: 100,
    }, null, 2), { encoding: "utf8" });
    store.denyPath(repoRoot, "src/secrets");
    // this hand-written profile carries a wall-clock (epoch) window, so the deployment marker resolves the build
    const ing = await profiles.ingestProfile({ path: p, serviceHint: "orders-api" });
    assert.ok(["MARKER", "BINDING"].includes(profiles.resolveRevision(ing.artifactHash).source)); // bound by the deployment marker
    const hot = profiles.queryHotspots({ artifactHash: ing.artifactHash, viewRevision: rev });
    const wh = hot.rows.find((r) => r.functionKey === "__withheld__");
    assert.ok(wh);
    assert.ok((wh!.selfValue) > (0));
    assert.strictEqual(hot.rows.some((r) => r.file.includes("secrets")), false);   // names never leak (D11)
    let sum = 0; for (const r of hot.rows) sum += r.selfValue;
    assert.ok(Math.abs(sum - (hot.populationValue)) <= (hot.populationValue * 0.02 + 1)); // denominators keep the whole population
    store.denyPath(repoRoot, "src/secrets", false);
  });

  test("compare (A6): populations with a diverging error rate are refused; equal error populations compare on shares", { timeout: 60_000 }, async () => {
    // one clean and one erroring root span on the same source, in distinguishable windows. The hot artifact is bound
    // to rev2 (see A2), so these windows sit after the d2 deployment marker; the candidate carries no service, so its
    // own build is simply unresolved and the service/revision check passes.
    assert.ok(runtime.ingest({
      id: "env:orders-clean", sourceId: "orders-api", codeRevision: rev2, window: { from: startMs - 190, to: startMs + 300 },
      backendHandle: "reported", signalKind: "trace",
      spans: [{ traceId: "t2", spanId: "c0", name: "POST /checkout", startMs: startMs - 150, endMs: startMs - 140 }],
    }).ok);
    assert.ok(runtime.ingest({
      id: "env:orders-err", sourceId: "orders-api", codeRevision: rev2, window: { from: startMs - 400, to: startMs - 190 },
      backendHandle: "reported", signalKind: "trace",
      spans: [{ traceId: "t9", spanId: "r0", name: "POST /checkout", startMs: startMs - 350, endMs: startMs - 340, error: true }],
    }).ok);
    // a fresh candidate profile with a wall-clock window near now and no service label of its own
    const candPath = join(RUN_DIR, "cand.cpuprofile");
    const ct = (Date.now() - 2_000) * 1_000;
    writeFileSync(candPath, JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
        { id: 2, callFrame: { functionName: "taxOf", url: `file://${repoDir}/src/tax.ts`, lineNumber: 0, columnNumber: 1 }, children: [] },
      ],
      startTime: ct, endTime: ct + 3_000_000, timeDeltas: [100, 100, 100, 100, 100, 100, 100, 100], samples: [2, 2, 2, 2, 2, 2, 2, 2], sampleInterval: 100,
    }, null, 2), { encoding: "utf8" });
    const cand = await profiles.ingestProfile({ path: candPath });
    const corrA = profiles.correlate({ artifactHash: hotHash, traceSourceId: "orders-api", timeWindowMs: { from: startMs - 400, to: startMs - 190 } });
    const corrB = profiles.correlate({ artifactHash: cand.artifactHash, traceSourceId: "orders-api", timeWindowMs: { from: startMs - 190, to: startMs - 20 } });
    assert.strictEqual(corrA.links[0].grade, "WINDOW_OVERLAP");
    assert.strictEqual(corrB.links[0].grade, "WINDOW_OVERLAP");
    // baseline: one request, one error (rate 1.0); candidate: one clean request (rate 0.0) → refuse (A6)
    const refused = profiles.compare({ baselinePopulationHash: corrA.populationHash, candidatePopulationHash: corrB.populationHash, normalise: "PER_REQUEST" });
    assert.strictEqual(refused.verdict, "NOT_COMPARABLE");
    assert.match(refused.reasons.join(" "), /error rate/i);
    // same window for both artifacts on the same source: equal error populations, shares may be compared
    const corrC = profiles.correlate({ artifactHash: hotHash, traceSourceId: "orders-api", timeWindowMs: { from: startMs - 190, to: startMs - 20 } });
    const corrD = profiles.correlate({ artifactHash: cand.artifactHash, traceSourceId: "orders-api", timeWindowMs: { from: startMs - 190, to: startMs - 20 } });
    const okCmp = profiles.compare({ baselinePopulationHash: corrC.populationHash, candidatePopulationHash: corrD.populationHash, normalise: "PER_REQUEST" });
    assert.ok(["DIFFERENCE_OBSERVED", "NO_MATERIAL_DIFFERENCE"].includes(okCmp.verdict));
    assert.ok((okCmp.rows.length) > (0));
  });

  test("deleteRepository purges the profile tables: links, per-revision mappings, artifacts keyed to them", { timeout: 60_000 }, async () => {
    assert.ok((cnt("profile_trace_links")) > (0));
    const artifactsBefore = cnt("profile_artifacts");
    deleteRepository(store, repoRoot);
    assert.strictEqual(cnt("profile_trace_links"), 0);
    assert.ok((cnt("profile_artifacts")) < (artifactsBefore));
    const mapsForDeleted = (store.db.prepare(`select count(*) as n from profile_mappings where revision in (${[rev, rev2].map(() => "?").join(",")})`).get(rev, rev2) as { n: number }).n;
    assert.strictEqual(mapsForDeleted, 0);
  });
});
