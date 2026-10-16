import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StubProvider } from "@cie/model";
import type { CallContext, ModelProvider } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ScriptedRouter } from "./scripted-router.ts";

// Every temp directory a test creates lives under one per-run directory that is removed on exit, so test runs
// never accumulate copies of fixtures and git repositories in the system temp directory.
const RUN_DIR = mkdtempSync(join(tmpdir(), "cie-run-"));
process.env.TMPDIR = RUN_DIR;
process.on("exit", () => { try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

export const FIXTURE = resolve(import.meta.dirname, "../../../fixtures/sample-repo");

export const ctx = (idem: string = randomUUID()): CallContext => ({
  requestId: randomUUID(), idempotencyKey: idem, actor: { principalId: "t", tenantId: "t", sessionId: "t" },
  deadlineMs: Date.now() + 30_000, traceId: "t",
});

export function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cie-fx-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

export async function setup(model: ModelProvider = new StubProvider(), repo = FIXTURE, opts: { hierarchy?: boolean } = {}) {
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, model);
  svc.router = new ScriptedRouter();
  const r = await svc.ingestRepository(ctx(), { repoPath: repo });
  if (!r.ok) throw new Error(r.error.message);
  // Answers route through the concept hierarchy (`conceptRequirement`); build it for the ingested
  // revision so every test that asks a question exercises the real path. Tests that deliberately
  // assert the missing-hierarchy guidance pass `{ hierarchy: false }`.
  if (opts.hierarchy !== false) {
    // Naming is the only model-bound phase of the build; give it its own short test budget so a slow or
    // hung provider does not inherit the whole 30 s context deadline in every setup() (cancellation tests hang otherwise).
    const h = await svc.buildConceptHierarchy({ ...ctx(), deadlineMs: Date.now() + 6_000 }, { revision: r.value.id });
    if (!h.ok) throw new Error(`concept hierarchy failed: ${h.error.message}`);
  }
  return { svc, worker, revision: r.value.id };
}

import { execFileSync } from "node:child_process";
export const SCRIPT = resolve(import.meta.dirname, "../../../scripts_make_demo_repo.sh");
/** A git-backed copy of fixtures/payments-repo with a short history, in a fresh temp dir. */
export function demoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cie-demo-")) + "/payments-app";
  execFileSync("bash", [SCRIPT, dir], { stdio: "pipe" });
  return dir;
}
export const traceFor = (root: string) => `FraudRejectedError: acct-9 over limit
    at checkFraud (${root}/src/payments/fraud.ts:5:18)
    at charge (${root}/src/payments/payment-service.ts:10:3)
    at createPayment (${root}/src/api/payments-controller.ts:6:11)
    at Layer.handle (/usr/lib/node_modules/express/lib/router/layer.js:95:5)`;

// ---------------------------------------------------------------------------
// Deterministic view helpers (the ask rebuild's groundwork, used by fixture
// worlds): they reproduce exactly what the deleted ask flow did for the three
// forms the e2e suites relied on, with the offline (stub) model — no LLM.
import { retrieveForQuestion } from "../src/retrieval.ts";
import { compileView } from "../src/viewspec.ts";
import { SCHEMA_REPRESENTATION } from "@cie/schema";
import { ensureEdgeClaims, visualByForm, type Built } from "../src/visuals.ts";
import { buildFailureGraph } from "../src/forms/causal.ts";
import type { RevisionRow } from "../src/store.ts";

const persistBuilt = (svc: any, rev: RevisionRow, b: Built) => { (svc as any).persist(b.claims); return b; };

/** The ask flow's SemanticMap path (V1): retrieval → REPRESENT call → compileView → persist. */
export async function askMap(svc: any, revision: string, question: string): Promise<Built> {
  const rev = svc.store.revision(revision)!;
  const r = retrieveForQuestion(svc.store, revision, question, { forModel: true, scope: "subject", resolveEvidence: (ev: any) => svc.resolveEvidence(rev, ev) });
  const d = await svc.callModel({ ...ctx(), id: "map", requestId: "map" } as never, rev, { purpose: "REPRESENT", schemaId: SCHEMA_REPRESENTATION, question, bundle: r.bundle });
  const ok = (d.result as { ok: boolean }).ok === true;
  const built = ensureEdgeClaims(svc.store, rev, compileView({
    question, bundle: r.bundle, tiers: r.tiers, scored: r.scored,
    representation: ok ? (d.result as { value: never }).value : undefined,
    run: ok ? (d.result as { run: never }).run : undefined,
    diagnostics: [], store: svc.store as unknown as Store, systemName: rev.repoRoot.split("/").filter(Boolean).pop(),
  }));
  return persistBuilt(svc, rev, built);
}

/** Any V-series visual with a direct `build` (e.g. V4 TransactionJourney), then edge claims + persist. */
export async function askVisual(svc: any, revision: string, code: string, question: string, subject?: string): Promise<Built> {
  const rev = svc.store.revision(revision)!;
  const visual = visualByForm(code);
  if (!visual?.build) throw new Error(`visual ${code} has no direct build`);
  return persistBuilt(svc, rev, ensureEdgeClaims(svc.store, rev, visual.build(svc.store as unknown as Store, rev, question, subject) as Built));
}

/** The native causal failure graph (V3), then edge claims + persist. */
export async function askCausal(svc: any, revision: string, question: string): Promise<Built> {
  const rev = svc.store.revision(revision)!;
  return persistBuilt(svc, rev, ensureEdgeClaims(svc.store, rev, buildFailureGraph(svc.store as unknown as Store, rev, question) as Built));
}
