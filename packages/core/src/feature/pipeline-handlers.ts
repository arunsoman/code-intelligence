// Gateway operations for the Wave 4 driver:
//   C02/runFeaturePipeline   a durable runner-lane job running runFeaturePipeline; cancellable until the first external write
//   C02/featureSetupCheck    what is ready and what is missing on this machine and repository, with the fix for each
// Production defaults: the container runner when Docker and its image are present (else the local runner, whose omissions come back in the
// evidence), the model adapter for generation, and the gate drivers. Every one can be replaced through hooks, which is how tests run it.
import { createHash } from "node:crypto";
import { GhDraftForge } from "../gh-forge.ts";
import { PRIORITY } from "../jobs.ts";
import type { Service } from "../service.ts";
import { authorityPolicyHash, loadAuthority, type AuthorityConfig } from "./authority.ts";
import { loadFeatureConfig } from "./config.ts";
import { DockerRunner, dockerAvailable } from "./docker-runner.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import { adapterEdits, runFeaturePipeline, type PipelineDeps, type PipelineInput, type PipelineResult, type ValidationDeclaration } from "./pipeline.ts";
import { LocalRunner } from "./runner.ts";
import type { Handlers } from "./routes.ts";
import { gateDriverFor, type GateHooks } from "./security-handlers.ts";
import { setupCheck, type SetupProbes } from "./setup-check.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { PublishHooks } from "./publish-handlers.ts";
import type { Runner } from "./types.ts";

export interface PipelineHooks {
  runner?: () => Runner; generateEdits?: PipelineDeps["generateEdits"]; adapter?: PipelineDeps["adapter"]; proposer?: PipelineDeps["proposer"];
  gates?: GateHooks; publish?: PublishHooks; probes?: SetupProbes;
}

const MODES = ["PLAN", "BUILD_PREVIEW", "CREATE_DRAFT_PR"] as const;
const obj = (b: unknown, what = "the request body"): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", `${what} must be an object`); return b as Record<string, any>; };
const only = (o: Record<string, unknown>, keys: string[], what: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) throw new FeatureError("INVALID_SCHEMA", `${what}: unknown field ${k}`); };

/** Declarations are the caller's statements about where validation ran. Anything not recognised is refused, not ignored. */
export function parseDeclaration(v: unknown): ValidationDeclaration | undefined {
  if (v === undefined) return undefined; const o = obj(v, "validation"); only(o, ["fidelity", "dependencies", "environmentLabel", "testData", "performanceApplicable", "wallMs"], "validation");
  const out: ValidationDeclaration = {};
  if (o.fidelity !== undefined) { if (!["REPRESENTATIVE", "PARTIAL", "UNKNOWN"].includes(o.fidelity)) throw new FeatureError("INVALID_SCHEMA", "validation.fidelity must be REPRESENTATIVE, PARTIAL or UNKNOWN"); out.fidelity = o.fidelity; }
  if (o.dependencies !== undefined) { if (!["AVAILABLE", "MISSING", "UNKNOWN"].includes(o.dependencies)) throw new FeatureError("INVALID_SCHEMA", "validation.dependencies must be AVAILABLE, MISSING or UNKNOWN"); out.dependencies = o.dependencies; }
  if (o.environmentLabel !== undefined) { if (typeof o.environmentLabel !== "string" || !o.environmentLabel.trim() || o.environmentLabel.length > 120) throw new FeatureError("INVALID_SCHEMA", "validation.environmentLabel is 1-120 characters"); out.environmentLabel = o.environmentLabel; }
  if (o.testData !== undefined) { const t = obj(o.testData, "validation.testData"); only(t, ["kind", "authorizationRef"], "validation.testData"); if (!["SYNTHETIC", "AUTHORIZED_REDACTED"].includes(t.kind)) throw new FeatureError("INVALID_SCHEMA", "validation.testData.kind must be SYNTHETIC or AUTHORIZED_REDACTED"); if (t.kind === "AUTHORIZED_REDACTED" && (typeof t.authorizationRef !== "string" || !t.authorizationRef)) throw new FeatureError("INVALID_SCHEMA", "redacted real data needs an authorizationRef"); out.testData = { kind: t.kind, ...(t.authorizationRef ? { authorizationRef: String(t.authorizationRef) } : {}) }; }
  if (o.performanceApplicable !== undefined) { if (typeof o.performanceApplicable !== "boolean") throw new FeatureError("INVALID_SCHEMA", "validation.performanceApplicable is true or false"); out.performanceApplicable = o.performanceApplicable; }
  if (o.wallMs !== undefined) { if (!Number.isSafeInteger(o.wallMs) || o.wallMs < 1000 || o.wallMs > 1_800_000) throw new FeatureError("INVALID_SCHEMA", "validation.wallMs is 1000-1800000"); out.wallMs = o.wallMs; }
  return out;
}

export function parsePipelineBody(b: unknown): PipelineInput {
  const x = obj(b); only(x, ["repositoryId", "text", "mode", "answers", "confirm", "releasePlan", "validation", "exportFormat", "publishTo", "budget"], "the request");
  if (typeof x.repositoryId !== "string" || !x.repositoryId) throw new FeatureError("INVALID_SCHEMA", "repositoryId is required");
  if (typeof x.text !== "string" || !x.text.trim()) throw new FeatureError("INVALID_SCHEMA", "describe the feature you want");
  if (!MODES.includes(x.mode)) throw new FeatureError("INVALID_SCHEMA", `mode must be one of ${MODES.join(", ")}`);
  const input: PipelineInput = { repositoryId: x.repositoryId, text: x.text, mode: x.mode, idempotencyKey: "" };
  if (x.answers !== undefined) { const a = obj(x.answers, "answers"); for (const [k, v] of Object.entries(a)) if (typeof v !== "string" || !v.trim() || v.length > 20_000) throw new FeatureError("INVALID_SCHEMA", `the answer for ${k} must be 1-20000 characters`); input.answers = a as Record<string, string>; }
  if (x.confirm !== undefined) { const c = obj(x.confirm, "confirm"); only(c, ["criteria", "rationale"], "confirm"); if (c.criteria !== "ALL" && !(Array.isArray(c.criteria) && c.criteria.length && c.criteria.every((i: unknown) => typeof i === "string"))) throw new FeatureError("INVALID_SCHEMA", 'confirm.criteria is "ALL" or a list of criterion ids'); if (typeof c.rationale !== "string" || !c.rationale.trim()) throw new FeatureError("INVALID_SCHEMA", "confirm.rationale is required"); input.confirm = { criteria: c.criteria, rationale: c.rationale }; }
  if (x.releasePlan !== undefined) { const r = obj(x.releasePlan, "releasePlan"); only(r, ["applicability", "rationale", "flagStrategy", "deploymentOrder", "observationWindow", "stopCriteria", "operator", "killSwitch", "revertRunbook", "dataRecoveryLimits"], "releasePlan"); if (!["APPLICABLE", "NOT_APPLICABLE"].includes(r.applicability)) throw new FeatureError("INVALID_SCHEMA", "releasePlan.applicability is APPLICABLE or NOT_APPLICABLE"); input.releasePlan = r as never; }
  const v = parseDeclaration(x.validation); if (v) input.validation = v;
  if (x.exportFormat !== undefined && x.exportFormat !== null && !["UNIFIED_DIFF", "GIT_PATCH", "BUNDLE"].includes(x.exportFormat)) throw new FeatureError("INVALID_SCHEMA", "exportFormat is UNIFIED_DIFF, GIT_PATCH, BUNDLE or null");
  if (x.exportFormat !== undefined) input.exportFormat = x.exportFormat;
  if (x.publishTo !== undefined) { if (typeof x.publishTo !== "string") throw new FeatureError("INVALID_SCHEMA", 'publishTo is "owner/name:branch"'); input.publishTo = x.publishTo; }
  if (x.budget !== undefined) { const bg = obj(x.budget, "budget"); only(bg, ["files", "tokens"], "budget"); for (const k of ["files", "tokens"]) if (bg[k] !== undefined && (!Number.isSafeInteger(bg[k]) || bg[k] < 1)) throw new FeatureError("INVALID_SCHEMA", `budget.${k} must be a positive integer`); input.budget = bg; }
  return input;
}

/** What leaves the gateway: ids, hashes, file kinds and the decision. Candidate file contents and prompt text are not part of it. */
export function summarize(r: PipelineResult, isolation: string) {
  return { requestId: r.requestId, stop: r.stop, reason: r.reason, isolation, steps: r.steps, questions: r.questions, unusedAnswers: r.unusedAnswers, exportId: r.exportId,
    candidate: r.candidate ? { id: r.candidate.id, bindingHash: r.candidate.bindingHash, oracleState: r.candidate.oracleState, files: r.candidate.mutations.map((m) => ({ path: m.newPath ?? m.oldPath, kind: m.kind })) } : undefined,
    decision: r.decision ? { eligibility: r.decision.eligibility, status: r.decision.status, reasons: r.decision.reasons, id: r.decision.id } : undefined,
    publication: r.publication ? { prNumber: r.publication.prNumber, url: r.publication.remoteRef, eligibility: r.publication.eligibility, commit: r.publication.commit } : undefined };
}

export function pipelineHandlers(svc: Service, fs: SqliteFeatureStore, hooks: PipelineHooks = {}): Handlers {
  const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  const authOf = (repo: string): AuthorityConfig => { try { return loadAuthority(repo, loadFeatureConfig(repo).authorityFile); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `authority or feature configuration is invalid: ${(e as Error).message}`); } };
  return {
    "C02/runFeaturePipeline": (c, b) => guarded(c, () => {
      const input = parsePipelineBody(b); input.idempotencyKey = c.idempotencyKey;
      if (!c.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
      if (!svc.store.latestRevision(input.repositoryId)) throw new FeatureError("NOT_FOUND", "that repository is not indexed (or access to it was withdrawn); index it first");
      const auth = authOf(input.repositoryId);
      const work = createHash("sha256").update(JSON.stringify([input, c.actor.principalId])).digest("hex");
      const job = svc.jobs.enqueue(c, { kind: "feature-build", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `pipeline:${input.repositoryId}:${c.idempotencyKey}`, params: { repositoryId: input.repositoryId, analysisId: c.idempotencyKey, headHash: work },
        run: async (ctx, control) => {
          const abort = new AbortController(); const stop = control.onCancel(() => abort.abort());
          try { return await guardedAsync(ctx, async () => {
            const runner = hooks.runner?.() ?? (dockerAvailable() ? new DockerRunner({ fence: () => control.holdsFence?.() ?? true }) : new LocalRunner({ fence: () => control.holdsFence?.() ?? true }));
            const deps: PipelineDeps = { fs, store: svc.store, auth, runner, adapter: hooks.adapter, proposer: hooks.proposer, runCheck: gateDriverFor(hooks.gates ?? {}, fs), signal: abort.signal,
              generateEdits: hooks.generateEdits ?? adapterEdits({ fs, adapter: hooks.adapter, auth }, who(c), authorityPolicyHash(auth)),
              publish: hooks.publish?.forge || hooks.publish?.cloneRoot ? { forge: hooks.publish.forge ?? new GhDraftForge(), cloneRoot: hooks.publish.cloneRoot ?? "" } : undefined,
              onStep: (s) => { control.checkpoint(); control.progress({ phase: s.step.toLowerCase(), message: `${s.step}: ${s.detail}` }); }, beforePublish: () => { control.checkpoint(); control.commit(); } };
            const result = await runFeaturePipeline(deps, who(c), input);
            control.checkpoint(); control.commit();
            return summarize(result, runner.isolation);
          }); } finally { stop(); }
        } });
      return { jobId: job.id };
    }),
    "C02/featureSetupCheck": (c, b) => guardedAsync(c, async () => { const x = obj(b); if (typeof x.repositoryId !== "string" || !x.repositoryId) throw new FeatureError("INVALID_SCHEMA", "repositoryId is required"); return setupCheck(svc.store, x.repositoryId, hooks.probes); }),
  };
}
