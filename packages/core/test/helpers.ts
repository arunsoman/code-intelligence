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

export async function setup(model: ModelProvider = new StubProvider(), repo = FIXTURE) {
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, model);
  svc.router = new ScriptedRouter();
  const r = await svc.ingestRepository(ctx(), { repoPath: repo });
  if (!r.ok) throw new Error(r.error.message);
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
