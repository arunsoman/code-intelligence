// Shared end-to-end fixture: a demo repository, an indexed service, a discovered request with a contract, and one built candidate.
import { authorityPolicyHash, type AuthorityConfig } from "../src/feature/authority.ts";
import { materializeCandidate, type FeatureEdit } from "../src/feature/candidate.ts";
import { loadFeatureConfig } from "../src/feature/config.ts";
import { contractHashOf, contractIdOf } from "../src/feature/decisions.ts";
import { featureHandlers } from "../src/feature/handlers.ts";
import { discoverFeatureContext, submitFeature } from "../src/feature/intake.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import type { AcceptanceCriterion, FeatureContract, OutcomeMode } from "../src/feature/types.ts";
import { ctx as mkctx, demoRepo, setup } from "./helpers.ts";

export const none: AuthorityConfig = { bindings: [] };
export const createEdit = (file: string, content: string): FeatureEdit => ({ op: "CREATE_FILE", file, content, why: "new", requirementIds: ["r1"] });

export async function boot(o: { edits?: (repo: string) => FeatureEdit[]; prepare?: (repo: string) => void; mode?: OutcomeMode; acceptance?: AcceptanceCriterion[]; handlers?: Parameters<typeof featureHandlers>[1]; text?: string } = {}) {
  const repo = demoRepo(); o.prepare?.(repo);
  const { svc, worker } = await setup(undefined, repo);
  const fs = new SqliteFeatureStore(svc.store); const intake = { fs, store: svc.store, config: loadFeatureConfig };
  const rid = submitFeature(intake, "arun", { inputRefs: [], text: o.text ?? "Add export", repositoryId: repo, mode: o.mode ?? "BUILD_PREVIEW", idempotencyKey: "k" }).requestId;
  discoverFeatureContext(intake, "arun", { requestId: rid, snapshot: fs.getRequest(rid)!.source, retrievalBudget: { tokens: 1000, files: 1000 } });
  let rec = fs.getRequest(rid)!;
  const draft = { schemaVersion: 1 as const, id: contractIdOf(rid), version: 0, requestId: rid, snapshot: rec.source, requirements: [], acceptance: o.acceptance ?? [], assumptions: [], obligationIds: [], authorityPolicyHash: authorityPolicyHash(none) };
  const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) }; rec = fs.updateRequest(rid, rec.version, { ...rec, contract });
  const cand = o.edits ? materializeCandidate({ fs, store: svc.store, auth: none }, "arun", { requestId: rid, snapshot: rec.source, edits: o.edits(repo), idempotencyKey: "m" }).candidate : null;
  const as = (p: string, idem?: string) => { const c = mkctx(idem); return { ...c, actor: { ...c.actor, principalId: p } }; };
  const h = featureHandlers(svc, o.handlers) as Record<string, (c: any, b: any) => any>;
  return { svc, fs, repo, rid, cand: cand!, as, h, close: () => worker.close() };
}
