// A process the crash-resume test starts and (with CIE_FAILPOINT) kills mid-publication. It runs the whole F07 flow
// against a file-backed store and a file-backed forge, so what a real SIGKILL leaves behind — a pushed branch, or a
// created PR whose receipt was never recorded — is what the resuming process actually finds.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../src/store.ts";
import { Service } from "../../src/service.ts";
import { WorkerClient } from "../../src/worker.ts";
import { StubProvider } from "@cie/model";
import { Tasks } from "../../src/execution.ts";
import { fileForge } from "./file-forge.ts";

const [mode, dbPath, repoPath, forgePath, clonesDir, ctxFlag] = process.argv.slice(2);
const store = new Store(dbPath);
const worker = new WorkerClient();
const svc = new Service(store, worker, new StubProvider());
const ctx = (key: string) => ({ requestId: key, idempotencyKey: key, actor: { principalId: "child", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 300_000, traceId: key });

if (mode === "publish" || mode === "resume") {
  const tasks = new Tasks({ store, clonesDir: clonesDir! });
  const ingested = await svc.ingestRepository(ctx("ingest"), { repoPath: repoPath! });
  if (!ingested.ok) throw new Error(`ingest failed: ${ingested.error.message}`);
  const spec = {
    title: "Discount boundary", description: "discountFor must return 0 at exactly the 100 boundary", kind: "FIX_DEFECT" as const,
    repositoryId: "fixtures/discount", baseRef: "HEAD",
    acceptance: [{ id: "a1", text: "discountFor(100) is 0", oracle: { kind: "TEST" as const, testId: "boundary", file: "tests/discount.test.ts" } }],
    constraints: { allowedPaths: ["src"], forbiddenPaths: [], maxFilesChanged: 5, maxDiffLines: 200, allowNewDependencies: false as const },
    authorisedOperations: ["READ", "EDIT", "RUN_TESTS_ISOLATED", "CREATE_BRANCH", "PUBLISH_DRAFT"] as ["READ", "EDIT", "RUN_TESTS_ISOLATED", "CREATE_BRANCH", "PUBLISH_DRAFT"],
    budgets: { modelTokens: 5_000, runWallMs: 60_000, investigationSteps: 8 },
  };
  const view = tasks.submitTask("alice", { spec });
  if (mode === "publish") {
    tasks.confirmIntent("alice", { taskId: view.taskId, specHash: view.specHash, expectedVersion: view.version });
    const plan = tasks.draftPlan("alice", { taskId: view.taskId });
    const baseText = readFileSync(join(repoPath!, "src", "discount.ts"), "utf8");
    const source = createHash("sha256").update(readFileSync(join(repoPath!, "src", "discount.ts"))).digest("hex");
    const expected = "return total > 100 ? 0 : 10;";
    const start = baseText.indexOf(expected);
    if (start < 0) throw new Error("the fixture's defect line moved");
    const prepared = tasks.prepareChange("alice", {
      taskId: view.taskId, planVersion: plan.planVersion, origin: "MODEL",
      editOperations: [{ op: "REPLACE_SPAN", file: "src/discount.ts", baseHash: source, start, end: start + expected.length, expected, newText: "return total >= 100 ? 0 : 10;", why: "the boundary is inclusive" }],
    });
    const verdict = tasks.validatePatch("alice", { taskId: view.taskId, candidateIndex: prepared.candidateIndex });
    if (verdict.state !== "PASSED_DEFINED_GATES") throw new Error(`unexpected verdict ${verdict.state}`);
    tasks.approveCandidate("bob", { taskId: view.taskId, candidateIndex: prepared.candidateIndex, expectedVersion: tasks.getTask(view.taskId).version, explanation: "ok" });
    const grant = tasks.createGrant("bob", { taskId: view.taskId, candidateIndex: prepared.candidateIndex, repository: "fixtures/discount", baseBranch: "main", branchName: "cie/crash" });
    mkdirSync(clonesDir!, { recursive: true });
    writeFileSync(join(clonesDir!, "..", "flow.json"), JSON.stringify({ taskId: view.taskId, candidateIndex: prepared.candidateIndex, grantId: grant.grantId }));
    await tasks.publishDraftPR("bob", { taskId: view.taskId, candidateIndex: prepared.candidateIndex, repositoryId: "fixtures/discount", baseBranch: "main", branchName: "cie/crash", grantId: grant.grantId }, fileForge(forgePath!));
  } else {
    // Resume: re-drive only the publication step from the record the killed process left behind.
    const flow = JSON.parse(execFileSync("cat", [join(clonesDir!, "..", "flow.json")], { encoding: "utf8" })) as { taskId: string; candidateIndex: number; grantId: string };
    const out = await tasks.publishDraftPR("bob", { taskId: flow.taskId, candidateIndex: flow.candidateIndex, repositoryId: "fixtures/discount", baseBranch: "main", branchName: "cie/crash", grantId: flow.grantId }, fileForge(forgePath!));
    console.log(JSON.stringify({ prNumber: out.prNumber, alreadyPublished: out.alreadyPublished, state: tasks.getTask(flow.taskId).state }));
  }
}
store.db.close();
void ctxFlag;
