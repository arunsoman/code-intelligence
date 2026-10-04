// Indexes a repository twice, dying (SIGKILL) in the middle of the second commit, as a crash would.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StubProvider } from "@cie/model";
import { Service } from "../../src/service.ts";
import { Store } from "../../src/store.ts";
import { WorkerClient } from "../../src/worker.ts";

const [dbPath, repo] = process.argv.slice(2);
const svc = new Service(new Store(dbPath), new WorkerClient(), new StubProvider());
const c = (k: string) => ({ requestId: k, idempotencyKey: k, actor: { principalId: "child", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 60_000, traceId: k });
const first = await svc.ingestRepository(c("1"), { repoPath: repo });
if (!first.ok) throw new Error("first index failed");
console.log(JSON.stringify({ first: first.value.id }));
const f = join(repo, "src/auth/token.ts");
writeFileSync(f, readFileSync(f, "utf8").replace("process.env.JWT_SECRET ?? \"dev\");\n}", "process.env.JWT_SECRET ?? \"dev\", { expiresIn: 60 });\n}"));
process.env.CIE_FAILPOINT = "index.commit";
await svc.ingestRepository(c("2"), { repoPath: repo });
console.log("not reached");
