import { z } from "zod";

export const SemanticRefSchema = z.object({
  id: z.string().min(1), label: z.string(), kind: z.string(),
}).strict();
export type SemanticRef = z.infer<typeof SemanticRefSchema>;

export const ResponseViewSchema = z.object({
  id: z.string().min(1), code: z.string(), form: z.string(), label: z.string(),
  concern: z.string(), questionAnswered: z.string(),
  subject: z.string().optional(), seeds: z.array(z.string()),
  scope: z.enum(["repository", "subject"]),
  status: z.enum(["available", "queued", "generating", "ready", "partial", "unavailable", "failed", "stale"]),
  reason: z.string().optional(), primary: z.boolean(), relevant: z.boolean(),
  recommendation: z.object({score:z.number(),reasons:z.array(z.string()).max(8)}).strict().optional(),
  viewId: z.string().optional(),
}).strict();
export type ResponseView = z.infer<typeof ResponseViewSchema>;

export const ResponseManifestSchema = z.object({
  schemaVersion: z.literal("response.v1"), policyVersion: z.enum(["portfolio.v1", "portfolio.v2", "portfolio.v3", "portfolio.v4"]),
  responseId: z.string().min(1), revision: z.string().min(1), question: z.string(),
  plan: z.object({ intent: z.enum(["structure", "behavior", "data", "state", "reliability", "concurrency", "quality", "general"]), concerns: z.array(z.string()), primaryCode: z.string(), supportingCodes: z.array(z.string()).max(3), scope: z.enum(["subject", "repository"]), subject: z.string().optional(), classification: z.object({basis:z.enum(["keyword","primary-view","general"]),matches:z.array(z.object({concern:z.string(),terms:z.array(z.string()),firstIndex:z.number().int().nonnegative()}).strict()).max(8)}).strict().optional(), recommendations:z.array(z.object({code:z.string(),score:z.number(),reasons:z.array(z.string()).max(8)}).strict()).max(3).optional(), evidenceStatus: z.enum(["checked", "not-checked"]) }).strict().optional(),
  explorationAvailability: z.array(z.object({ code: z.string(), available: z.boolean(), reason: z.string().optional(), basis: z.literal("revision-preflight") }).strict()).max(60).optional(),
  interpretation: z.string(), subjectRefs: z.array(SemanticRefSchema),
  primaryViewId: z.string(), views: z.array(ResponseViewSchema).max(60),
  sections: z.array(z.object({ id: z.string(), label: z.string(), text: z.string(),
    entityRefs: z.array(z.string()), evidenceIds: z.array(z.string()),
  }).strict()), limitations: z.array(z.string()),
}).strict();
export type ResponseManifest = z.infer<typeof ResponseManifestSchema>;

export interface ExplorationAction {
  id: string; label: string; question: string; form: string; chartCode?: string;
  subject: string; seeds: string[]; revision: string; sourceViewId: string; sourceViewVersion: number;
}
