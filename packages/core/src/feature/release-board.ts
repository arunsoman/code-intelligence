// The Release Board's listing: every feature request scoped to a release, with enough of a summary to render a
// row (stage, issue, candidate status, whether a second person has already signed off). Not gated by owned() —
// like approval-handlers.ts, the whole point is that someone other than the request's author (QA) can see it.
// Nothing here is mutating; it only reads what Phase 5's store methods and the approvals table already hold.
import type { Service } from "../service.ts";
import { FeatureError, guarded } from "./errors.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";

const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };
const str = (v: unknown, what: string): string => { if (typeof v !== "string" || !v) throw new FeatureError("INVALID_SCHEMA", `${what} is required`); return v; };

export interface ReleaseBoardItem {
  requestId: string;
  stage: string;
  createdBy: string;
  issueRef?: string;
  candidateStatus?: string;
  secondApproved: boolean;
}

export function releaseBoardHandlers(_svc: Service, fs: SqliteFeatureStore): Handlers {
  return {
    "C02/listFeatureRequestsByRelease": (c, b) => guarded(c, (): ReleaseBoardItem[] => {
      const x = obj(b);
      const releaseId = str(x.releaseId, "releaseId");
      return fs.listRequestsByRelease(releaseId, typeof x.limit === "number" ? x.limit : 50).map((rec) => {
        const candidates = fs.listCandidates(rec.requestId);
        const latest = candidates[candidates.length - 1];
        const approvals = fs.decisionApprovals(rec.requestId);
        return {
          requestId: rec.requestId,
          stage: rec.workspace.stage,
          createdBy: rec.createdBy,
          issueRef: rec.issue.number ? `${rec.issue.repository}#${rec.issue.number}` : undefined,
          candidateStatus: latest?.status,
          secondApproved: !!latest && approvals.some((a) => a.bindingHash === latest.bindingHash && a.principal !== rec.createdBy),
        };
      });
    }),
  };
}
