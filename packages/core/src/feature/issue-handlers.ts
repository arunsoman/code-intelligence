// Gateway handlers for task 2.O. The forge is injectable: production uses `gh` through GhIssueForge; tests use a scripted GitHub.
import type { Service } from "../service.ts";
import { FeatureError, guardedAsync } from "./errors.ts";
import { GhIssueForge, type IssueForge } from "./issue-forge.ts";
import { bindRequestIssue, previewIssueProjection, syncRequestMilestones, type ProjectionPolicy } from "./issue-trail.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord } from "./types.ts";

export interface IssueHooks { forge?: IssueForge; policy?: ProjectionPolicy; now?: () => number }

export function issueHandlers(_svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord, hooks: IssueHooks = {}): Handlers {
  let forge = hooks.forge; const deps = () => ({ fs, forge: (forge ??= new GhIssueForge()), policy: hooks.policy, now: hooks.now });
  const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };
  const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  return {
    "C30/previewIssueProjection": (c, b) => guardedAsync(c, async () => {
      const x = obj(b); owned(x.requestId, who(c));
      const p = await previewIssueProjection(deps(), who(c), { requestId: x.requestId, repositoryId: x.repositoryId });
      return { title: p.title, body: p.body, labels: p.labels, visibility: p.visibility, projectionHash: p.hash, projectionPolicyHash: p.policyHash };
    }),
    "C30/bindRequestIssue": (c, b) => guardedAsync(c, async () => {
      const x = obj(b); owned(x.requestId, who(c));
      return bindRequestIssue(deps(), who(c), { requestId: x.requestId, repositoryId: x.repositoryId, existingIssueId: x.existingIssueId, projectionHash: x.projectionHash, expectedVersion: x.expectedVersion, idempotencyKey: c.idempotencyKey });
    }),
    "C30/syncRequestMilestones": (c, b) => guardedAsync(c, async () => {
      const x = obj(b); owned(x.requestId, who(c));
      return syncRequestMilestones(deps(), who(c), { requestId: x.requestId, throughSequence: x.throughSequence, projectionPolicyHash: x.projectionPolicyHash });
    }),
  };
}
