// Gateway handlers for task 3.R. The forge and the review source are injectable: production uses `gh`; tests use a scripted GitHub.
import { dirname, join, resolve } from "node:path";
import { GhDraftForge } from "../gh-forge.ts";
import type { DraftForge } from "../defect-workflow.ts";
import type { Service } from "../service.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import { publishFeaturePR } from "./publish.ts";
import { GhReviewSource, ingestReviewFeedback, scopeRevalidation, type ReviewSource } from "./review-feedback.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";

export interface PublishHooks { forge?: DraftForge; reviews?: ReviewSource; cloneRoot?: string; now?: () => string }
const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };

export function publishHandlers(svc: Service, fs: SqliteFeatureStore, hooks: PublishHooks = {}): Handlers {
  let forge = hooks.forge, reviews = hooks.reviews;
  const cloneRoot = hooks.cloneRoot ?? join(dirname(svc.store.path === ":memory:" ? join(process.cwd(), ".cie") : resolve(svc.store.path)), "clones");
  const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  return {
    "C30/publishFeaturePR": (c, b) => guardedAsync(c, async () => {
      const x = obj(b);
      return publishFeaturePR({ fs, store: svc.store, forge: (forge ??= new GhDraftForge()), cloneRoot, now: hooks.now }, who(c), { proposalId: x.proposalId, decisionId: x.decisionId, expectedHeadHash: x.expectedHeadHash, destination: x.destination, idempotencyKey: c.idempotencyKey });
    }),
    "C29/ingestReviewFeedback": (c, b) => guardedAsync(c, async () => { const x = obj(b); return ingestReviewFeedback({ fs, source: (reviews ??= new GhReviewSource()), now: hooks.now }, who(c), { requestId: x.requestId, pullRequestId: x.pullRequestId, externalEventId: x.externalEventId, headHash: x.headHash }); }),
    "C23/scopeRevalidation": (c, b) => guarded(c, () => { const x = obj(b); return scopeRevalidation({ fs }, who(c), { oldBinding: x.oldBinding, newBinding: x.newBinding, feedbackIds: x.feedbackIds ?? [], coverage: x.coverage ?? [] }); }),
  };
}
