// Gateway handler for task 3.U (C17/evaluateBuilderVersion). Routes are trusted configuration; the egress policy comes from the repository's feature config.
import type { GenerationRouter } from "../llm-router.ts";
import { generationRoutesFor } from "../llm-router.ts";
import { PRIORITY } from "../jobs.ts";
import type { Service } from "../service.ts";
import { evaluateBuilderVersion } from "./builder-eval.ts";
import { loadFeatureConfig } from "./config.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";

export function builderHandlers(svc: Service, fs: SqliteFeatureStore, hooks: { routes?: readonly GenerationRouter[] } = {}): Handlers {
  const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  return {
    "C17/evaluateBuilderVersion": (c, b) => guarded(c, () => {
      const x = b as Record<string, any>; if (!x || typeof x !== "object") throw new FeatureError("INVALID_SCHEMA", "the request body must be an object");
      if (typeof x.repositoryId !== "string" || !x.repositoryId) throw new FeatureError("INVALID_SCHEMA", "repositoryId (whose feature configuration sets the egress policy) is required");
      let egress; try { egress = loadFeatureConfig(x.repositoryId).egress; } catch (e) { throw new FeatureError("INVALID_SCHEMA", `feature configuration is invalid: ${(e as Error).message}`); }
      const routes = hooks.routes ?? generationRoutesFor(svc.store.selectedModel(), process.env.CIE_OLLAMA_URL);
      const job = svc.jobs.enqueue(c, { kind: "feature-validate", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `builder-eval:${x.modelIdentityHash}`, params: { repositoryId: x.repositoryId, analysisId: String(x.modelIdentityHash), headHash: String(x.suiteHash) },
        run: async (ctx, control) => {
          const abort = new AbortController(); const stop = control.onCancel(() => abort.abort());
          try { return await guardedAsync(ctx, async () => { control.checkpoint(); const r = await evaluateBuilderVersion({ fs, routes, egress }, who(c), { modelIdentityHash: x.modelIdentityHash, suiteHash: x.suiteHash, budget: x.budget, signal: abort.signal }); control.checkpoint(); control.commit(); return r; }); } finally { stop(); }
        } });
      return { jobId: job.id };
    }),
  };
}
