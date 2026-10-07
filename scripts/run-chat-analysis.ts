// Exercise the same HTTP endpoint as the chatbox against a fresh repository index.
// Usage: node scripts/run-chat-analysis.ts [repository] [question] [output.json]
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createProvider } from "@cie/model";
import { Service } from "../packages/core/src/service.ts";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";
import { chooseRouter } from "../packages/core/src/llm-router.ts";
import { buildHandler } from "../packages/core/src/server.ts";

const repoPath = resolve(process.argv[2] ?? ".");
const text = process.argv[3] ?? "Explain this project, identify its riskiest module, and show me the tests covering it.";
const output = resolve(process.argv[4] ?? "/tmp/cie-chat-analysis-result.json");
const { provider } = await createProvider();
const { router } = await chooseRouter([]);
const worker = new WorkerClient(), store = new Store(":memory:");
const svc = new Service(store, worker, provider); svc.router = router;
const server = createServer(buildHandler(svc));
try {
  console.log(`Indexing ${repoPath}; router ${router?.name ?? "off"}; representation ${provider.name}/${provider.model}.`);
  const id = randomUUID();
  const indexed = await svc.ingestRepository({ requestId: id, idempotencyKey: id, traceId: id, actor: { principalId: "local-user", tenantId: "local", sessionId: "chat-analysis" }, deadlineMs: Date.now() + 180_000 }, { repoPath });
  if (!indexed.ok) throw new Error(indexed.error.message);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not start");
  console.log(`Asking: ${text}`);
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/components/C15/converse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, revision: indexed.value.id, history: [] }), signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  writeFileSync(output, JSON.stringify({ question: text, repoPath, router: router?.name, elapsedMs: Date.now() - started, result }, null, 2));
  console.log(JSON.stringify({ httpStatus: response.status, elapsedMs: Date.now() - started, kind: result.value?.kind, steps: result.value?.results?.map((r: any) => ({ tool: r.tool, status: r.status, subject: r.subject })), warnings: result.metadata?.warnings }, null, 2));
  console.log(result.value?.message ?? result.error?.message);
  console.log(`Full response: ${output}`);
  if (!response.ok || !result.ok || result.value?.kind !== "analysis" || result.value.results.some((r: any) => r.status !== "complete")) process.exitCode = 1;
} finally { server.close(); worker.close(); store.db.close(); }
