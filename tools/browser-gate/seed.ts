// Seeds a throwaway database for the live-browser gate: a demo repository, its index, and two prompt-to-feature requests with a candidate each.
// `local-user` is the principal the dev server authenticates as; `someone-else` owns a request the browser must never be able to open.
import { Store } from "../../packages/core/src/store.ts";
import { Service } from "../../packages/core/src/service.ts";
import { WorkerClient } from "../../packages/core/src/worker.ts";
import { StubProvider } from "@cie/model";
import { ctx, demoRepo } from "../../packages/core/test/helpers.ts";
import { SqliteFeatureStore } from "../../packages/core/src/feature/store.ts";
import { authorityPolicyHash } from "../../packages/core/src/feature/authority.ts";
import { materializeCandidate } from "../../packages/core/src/feature/candidate.ts";
import { loadFeatureConfig } from "../../packages/core/src/feature/config.ts";
import { contractHashOf, contractIdOf } from "../../packages/core/src/feature/decisions.ts";
import { discoverFeatureContext, submitFeature } from "../../packages/core/src/feature/intake.ts";
import type { FeatureContract } from "../../packages/core/src/feature/types.ts";

export async function seed(dbPath: string): Promise<{ repo: string; mine: string; theirs: string; candidateHash: string }> {
  const repo = demoRepo(), worker = new WorkerClient(), store = new Store(dbPath);
  const svc = new Service(store, worker, new StubProvider());
  const ing = await svc.ingestRepository(ctx(), { repoPath: repo }); if (!ing.ok) throw new Error(ing.error.message);
  const fs = new SqliteFeatureStore(store), intake = { fs, store, config: loadFeatureConfig };
  const make = (actor: string, key: string, text: string, file: string) => {
    const rid = submitFeature(intake, actor, { inputRefs: [], text, repositoryId: repo, mode: "BUILD_PREVIEW", idempotencyKey: key }).requestId;
    discoverFeatureContext(intake, actor, { requestId: rid, snapshot: fs.getRequest(rid)!.source, retrievalBudget: { tokens: 1000, files: 1000 } });
    let rec = fs.getRequest(rid)!;
    const draft = { schemaVersion: 1 as const, id: contractIdOf(rid), version: 0, requestId: rid, snapshot: rec.source, requirements: [], acceptance: [], assumptions: [], obligationIds: [], authorityPolicyHash: authorityPolicyHash({ bindings: [] }) };
    const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) }; rec = fs.updateRequest(rid, rec.version, { ...rec, contract });
    const cand = materializeCandidate({ fs, store, auth: { bindings: [] } }, actor, { requestId: rid, snapshot: rec.source, edits: [{ op: "CREATE_FILE", file, content: `export const ${key.replace(/\W/g, "_")} = 1;\n`, why: "new", requirementIds: ["r1"] }], idempotencyKey: `m-${key}` }).candidate;
    return { rid, hash: cand.bindingHash };
  };
  const mine = make("local-user", "mine", "Add CSV export of transactions", "src/export/csv.ts"), theirs = make("someone-else", "theirs", "Someone else's private feature", "src/private/secret.ts");
  store.db.close(); worker.close();
  return { repo, mine: mine.rid, theirs: theirs.rid, candidateHash: mine.hash };
}
