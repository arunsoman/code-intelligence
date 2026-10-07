// A release-scoped request's second-approver sign-off (see pipeline.ts's `secondApprover` check). Approving is
// deliberately NOT gated by owned() — the whole point is that someone other than the request's own author can
// act on it — but it is gated by release authority and bound to the current candidate's exact bindingHash, the
// same discipline F08 uses for campaign_approvals (an additive record, never a relaxation of who owns what).
import type { Service } from "../service.ts";
import { authorize, type AuthorityConfig } from "./authority.ts";
import { FeatureError, guarded } from "./errors.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";

const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };
const str = (v: unknown, what: string): string => { if (typeof v !== "string" || !v) throw new FeatureError("INVALID_SCHEMA", `${what} is required`); return v; };

export function approvalHandlers(_svc: Service, fs: SqliteFeatureStore, authOf: (root: string) => AuthorityConfig): Handlers {
  return {
    "C30/approveFeatureDecision": (c, b) => guarded(c, () => {
      const x = obj(b);
      const requestId = str(x.requestId, "requestId");
      const rec = fs.getRequest(requestId);
      if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
      if (!rec.workspace.releaseId) throw new FeatureError("INVALID_SCHEMA", "only a release-scoped request has a second-approver gate to satisfy");
      const actor = c.actor.principalId;
      if (actor === rec.createdBy) throw new FeatureError("FORBIDDEN", "a request's own author cannot be its second approver");
      const bound = authorize(authOf(rec.repositoryId), actor, "release", rec.createdBy);
      if (!bound.allowed) throw new FeatureError("FORBIDDEN", bound.reason);
      const candidates = fs.listCandidates(requestId);
      const candidate = candidates[candidates.length - 1];
      if (!candidate) throw new FeatureError("NOT_FOUND", "no candidate to approve yet");
      fs.recordDecisionApproval(requestId, actor, candidate.bindingHash, String(x.explanation ?? ""));
      return { ok: true, bindingHash: candidate.bindingHash, principal: actor };
    }),
    "C30/listDecisionApprovals": (c, b) => guarded(c, () => {
      const x = obj(b);
      const requestId = str(x.requestId, "requestId");
      if (!fs.getRequest(requestId)) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
      return fs.decisionApprovals(requestId);
    }),
  };
}
