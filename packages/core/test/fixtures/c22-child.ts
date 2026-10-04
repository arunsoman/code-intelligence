// Runs an investigation in its own process so a test can kill it at a named failpoint (CIE_FAILPOINT) and then inspect what survived.
import { Service } from "../../src/service.ts";
import { Store } from "../../src/store.ts";
import { WorkerClient } from "../../src/worker.ts";
import { StubProvider } from "@cie/model";

const [dbPath, repoPath, mode] = process.argv.slice(2);
const ctx = (k: string) => ({ requestId: k, idempotencyKey: k, actor: { principalId: "child", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 120_000, traceId: k });
const worker = new WorkerClient();
const svc = new Service(new Store(dbPath), worker, new StubProvider());
if (mode === "run") {
  const ing = await svc.ingestRepository(ctx("ing"), { repoPath });
  if (!ing.ok) throw new Error("ingest failed");
  const trace = `FraudRejectedError: x\n    at checkFraud (${repoPath}/src/payments/fraud.ts:5:18)\n    at charge (${repoPath}/src/payments/payment-service.ts:10:3)\n    at createPayment (${repoPath}/src/api/payments-controller.ts:6:11)`;
  const s = svc.c22.create(ctx("create"), { workspaceId: "w", goal: { question: "why does createPayment fail", trace } });
  console.log(JSON.stringify({ id: s.id }));
  const adm = svc.c22.admitWave(ctx("adm"), { investigationId: s.id, expectedVersion: s.version });
  await svc.c22.runWave(s.id, adm.generation, 32);
}
worker.close();
