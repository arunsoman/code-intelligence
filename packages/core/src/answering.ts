// Free-text answering: ask/investigate/converse and the chart/explain machinery behind them.
import { summarizeValidation } from "./answer-validation.ts";
import { parseCompoundQuestion, planCompoundQuestion, evaluateCompoundQuestion, compoundAnswer } from "./compound-query.ts";
import { validateSnapshotReuse } from "./snapshot-reuse.ts";
import { retrieveFromSnapshot } from "./retrieval.ts";
import { ConversationActions, ConversationConflict } from "./conversation-actions.ts";
import { boundAnswerContext } from "./answer-visual.ts";
import { bindSelectedChart, responsePortfolio } from "./response-portfolio.ts";
import type { AnswerInvestigation, AnswerValidationSummary, ResponseManifest } from "@cie/schema";
import { diagnostic, bundleDiagnostics, withDiagnostics } from "./diagnostics.ts";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BudgetController, inferSourceOverview, OllamaProvider, hasModel, listInstalledModels, runModel, StubProvider, type GatewayFailure, type GatewayResult } from "@cie/model";
import { SCHEMA_SOURCE_OVERVIEW, type SourceOverviewOutput } from "@cie/schema";
import { matchName, readText, routerFor, validateProviderGuide, type ChartOption, type Intent as ChatIntent, type ProviderGuideResponse, type RouterModel } from "./llm-router.ts";
import { INTENT_CONFIDENCE_THRESHOLD } from "../../schema/src/intents.ts";
import { modelFailureNotice } from "./model-failure.ts";
import { validateChatPlan } from "./chat-plan.ts";
import { executeChatPlan } from "./chat-execution.ts";
import { runChatAgent } from "./chat-agent.ts";
import { buildAnswerView, claimsFromContainer, claimsFromLocate, renderEnumeration, renderLocation, renderProof } from "./claim.ts";
import { verifyClaims } from "./verifier.ts";
import type { AnswerClaim, AnswerClaimVerification } from "@cie/schema";
import { chartCodeForQuestion, CHART_REGISTRY, CHAT_QUESTION_MAX_CHARS, SCHEMA_CHALLENGE, SCHEMA_EXPLANATION, SCHEMA_HYPOTHESES, SCHEMA_NAME_ARCH, SCHEMA_NAME_CONCEPT, SCHEMA_REPRESENTATION } from "@cie/schema";
import { applyVerdict, gateClaim, modelText, wilson, withChallenge } from "./claims.ts";
import { buildFailureGraph, buildInvariantGraph } from "./forms/causal.ts";
import { buildHypothesis } from "./forms/hypothesis.ts";
import type { ModelRunRef, PrAnalysisView } from "@cie/schema";
import { conceptRequirement, navigateHierarchy, overviewSeeds } from "./overview.ts";
import { projectProfile } from "./profile.ts";
import { detectSecret, EGRESS_FIELDS, payloadHash, scrubBundle } from "./policy.ts";
import { bundleFor, queryTerms, retrieveAround, retrieveForQuestion } from "./retrieval.ts";
import { resolveReferent, planQuery, type QueryPlan } from "./query-router.ts";
import { resolveMentions } from "./mentions.ts";
import { ZOOM_LEVELS, zoomLevelOf, choicesFor, sideZoomChoices } from "./zoom-map.ts";
import { revisionIndex, scoreEntity, WEIGHTS } from "./salience.ts";
import { DeltaBaseError, type RevisionRow, type Store } from "./store.ts";
import { entityAt, fingerprint, locateFrames, looksLikeTrace, parseTrace } from "./trace.ts";
import { compileView } from "./viewspec.ts";
import { viewMessage, withAnswer } from "./answer.ts";
import { catalog, ensureEdgeClaims, visualByForm, type CatalogEntry } from "./visuals.ts";
import { cachedChartPlan, chartCreatorRequest, chartPlanCacheKey, compileChartPlan, rememberChartPlan, validateChartIdNotChanged, type ChartCompileDiag } from "./chart-creator.ts";
import { fileHistory, headOf, isGitRepo } from "./gitinfo.ts";
import { policyFor } from "./access.ts";
import { redactBuilt } from "./redact.ts";
import { HashEmbedder, semanticScores, type Embedder } from "./embeddings.ts";
import type { ApiResult, CallContext, ChallengeOutput, Claim, ConverseResult, EvidenceBundle, EvidenceRef, ExplainResult, ExplanationOutput, ChartOutput, ChartOutputV2, ChartId, RepresentationOutput, ViewRoute, ViewSpec } from "@cie/schema";
import { actor, chunkTokenBudget, fail, ok, storageFailure } from "./service.ts";
import type { Service } from "./service.ts";

/** Every explicitly named chart resolves through the shared chart registry. */
const explicitChartCode = chartCodeForQuestion;

function matchingChartPlan(plan: ChartOutput | ChartOutputV2 | null, chartCode?: string): ChartOutput | ChartOutputV2 | null {
  if (!plan || !chartCode) return plan;
  return "contractVersion" in plan && plan.contractVersion === "chart.v2" && plan.chartId === chartCode ? plan : null;
}

/**
 * The full four-part contract for a deterministic, zero-model answer: a clear answer, a "Proof:" section, an
 * initial chart built straight from the verified claims (`buildAnswerView`), and — via the view's
 * `answerEntityRefs` param — the alternate-visuals manifest `Answering.converse` attaches automatically to any
 * `kind: "view"` result (see its `manifestFor` call). A degenerate case with nothing verified still answers and
 * proves, just without a chart to build one from.
 */
function deterministicResult(ctx: CallContext, store: Store, revision: string, question: string, systemName: string, answerText: string, claims: AnswerClaim[], verifications: AnswerClaimVerification[]): ApiResult<ConverseResult> {
  const message = [answerText, renderProof(claims, verifications)].join("\n\n");
  const completeness = verifications.length && verifications.every((v) => v.status === "VERIFIED") ? "COMPLETE" as const : "PARTIAL" as const;
  const built = buildAnswerView(store, revision, question, systemName, claims, verifications);
  if (!built) return ok(ctx, { kind: "message", message }, { revision, warnings: [], completeness });
  built.view.answer = message;
  return ok(ctx, { kind: "view", view: built.view, claims: built.claims, message }, { revision, warnings: [], completeness });
}

/**
 * Re-anchors a saved investigation onto a new revision using the stable identities C08 already computes on every
 * ingest (registry.ts): an inspected id whose structural form (`kind:file#qualifiedName`) is unchanged carries over
 * directly; one that moved or was renamed is re-resolved through its canonical id. An id that cannot be resolved
 * (deleted, or an ambiguous split into several candidates) is dropped on its own — degrading that one piece of
 * evidence rather than refusing to resume the whole investigation, the way a bare revision-equality check used to.
 */
function remapCheckpointAcrossRevision(svc: Service, checkpoint: AnswerInvestigation, toRevision: string): { checkpoint: AnswerInvestigation; dropped: number } {
  if (checkpoint.revision === toRevision) return { checkpoint, dropped: 0 };
  const idMap = new Map<string, string>();
  for (const id of checkpoint.inspectedIds) {
    if (svc.store.entitiesById(toRevision, [id]).length) { idMap.set(id, id); continue; }
    const canon = svc.registry.canonOf(checkpoint.revision, id);
    const resolved = canon ? svc.registry.entityIn(toRevision, canon) : [];
    if (resolved.length === 1) idMap.set(id, resolved[0]);
  }
  const remapRecord = <T>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).flatMap(([id, v]) => idMap.has(id) ? [[idMap.get(id)!, v]] : []));
  // The replayed tool-call history (chat-agent.ts's resume path pushes `observations` back into the conversation
  // verbatim) embeds old ids as literal text — `[kind:old/file.ts#Name]` markers and raw `read_code` arguments — so
  // those must be rewritten too, or the model would see a transcript naming ids that `env.seen` no longer recognizes.
  const renamed = [...idMap].filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
  const remapText = (text: string): string => renamed.reduce((s, [from, to]) => s.split(from).join(to), text);
  const observations = checkpoint.observations.map((o) => ({ ...o, content: remapText(o.content), arguments: renamed.length ? JSON.parse(remapText(JSON.stringify(o.arguments))) : o.arguments }));
  const supportedFindings = checkpoint.supportedFindings?.map((f) => ({ ...f, entityIds: f.entityIds.map((id) => idMap.get(id) ?? id) }));
  return {
    checkpoint: { ...checkpoint, revision: toRevision, inspectedIds: [...new Set(idMap.values())], sourceReads: remapRecord(checkpoint.sourceReads), sourceHashes: remapRecord(checkpoint.sourceHashes), observations, supportedFindings },
    dropped: checkpoint.inspectedIds.length - idMap.size,
  };
}

export class Answering {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  private chosenRoute(form: string, kind?: "failure" | "invariant"): ViewRoute {
    const v = visualByForm(form);
    const f = (v?.formId ?? form) as ViewRoute["form"];
    return { source: "chosen", confidence: "high", form: f, ...(f === "CausalGraph" ? { kind: kind ?? "failure" } : {}), name: f === "CausalGraph" ? (kind === "invariant" ? "Wrong-value map" : "Failure-space map") : v?.name ?? f, because: "You chose this view.", alternatives: [] };
  }

  /** What kind of view the question wants, from the router model; without one, the general map, said plainly. */
  private async readQuestion(question: string): Promise<ViewRoute> {
    const { intent } = await readText(this.svc.router, question, { hasView: false, selectionCount: 0, looksLikeTrace: false }, true);
    return (intent as { type: "ask"; route: ViewRoute }).route; // with forms only, the reading is always a view
  }

  /** Every question gets both: the picture, and the written answer composed from the same view (after access redaction, so it never says more). */
  async ask(ctx: CallContext, req: Parameters<Answering["askView"]>[1]): Promise<ApiResult<{ view: ViewSpec; claims: Claim[]; manifest?: ResponseManifest }>> {
    return withDiagnostics({ requestId: ctx.requestId, traceId: ctx.traceId }, async () => {
      if (req.answerContext !== undefined && (typeof req.answerContext !== "string" || req.answerContext.length > 6000))
        return fail(ctx, { code: "INVALID_SCHEMA", message: "answerContext must be a string of at most 6000 characters", retryable: false });
      const result = await this.askInternal(ctx, req);
      if (!result.ok) return result;
      if(req.snapshotId){
        const finalRev=this.store.revision(result.value.view.revision),checkpoint=this.store.evidenceSnapshot(req.snapshotId);
        if(!finalRev||!checkpoint)return fail(ctx,{code:"NOT_FOUND",message:"This source or evidence snapshot is no longer available.",retryable:false});
        const issue=validateSnapshotReuse(this.store,checkpoint,finalRev,req.question.trim(),policyFor(this.store,finalRev.repoRoot),ev=>this.svc.resolveEvidence(finalRev,ev));
        if(issue)return fail(ctx,{code:issue==="access"?"FORBIDDEN":"STALE_REVISION",message:"Source or access changed while this chart was generated. Re-index and ask again.",retryable:false});
      }
      result.value.view = bindSelectedChart(result.value.view, req.chartCode);
      result.value.view.params = { ...result.value.view.params, scope: req.scope ?? (req.overview ? "repository" : "subject"), ...(req.subject ? { subject: req.subject } : {}) };
      return { ...result, value: { ...result.value, manifest: this.manifestFor([result.value.view], req.question.trim(), { scope: req.scope ?? (req.overview ? "repository" : "subject"), subject: req.subject, seeds: req.seeds }, req.answerContext) } };
    });
  }

  private async askInternal(ctx: CallContext, req: Parameters<Answering["askView"]>[1]): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const askStarted = performance.now();
    diagnostic("ask.start", { requestId: ctx.requestId, question: req.question, revision: req.revision, overview: !!req.overview, chartCode: req.chartCode, form: req.form, subject: req.subject, seeds: req.seeds, pins: req.pins });
    try {
      const r = await this.askView(ctx, req);
      if (r.ok) withAnswer(r.value);
      diagnostic("ask.complete", { requestId: ctx.requestId, elapsedMs: performance.now() - askStarted, ok: r.ok, ...(r.ok ? { form: r.value.view.formId, nodes: r.value.view.nodes.length, edges: r.value.view.edges.length, gaps: r.value.view.gaps, answer: r.value.view.answer, warnings: r.metadata.warnings } : { error: r.error }) });
      return r;
    } catch (error) {
      diagnostic("ask.exception", { requestId: ctx.requestId, elapsedMs: performance.now() - askStarted, error }, "error");
      const requestedChart = req.chartCode ?? chartCodeForQuestion(req.question ?? "");
      if (!requestedChart || !Object.hasOwn(CHART_REGISTRY, requestedChart)) return fail(ctx, storageFailure(error));
      const chartCode = requestedChart as ChartId;
      const chart = CHART_REGISTRY[chartCode];
      const revision = req.revision ?? "unknown";
      const viewId = `view:chart-error:${ctx.requestId}`;
      const route = req.route ?? this.chosenRoute("GeneratedChart");
      process.stderr.write(`[chart] ${JSON.stringify({ stage: "request-failed", requestId: ctx.requestId, chartId: chartCode, error: error instanceof Error ? error.message : String(error) })}\n`);
      const view: ViewSpec = {
        id: viewId, version: 1, revision, taskId: `task:${viewId}`, formId: "GeneratedChart",
        caption: `${chart.name} · chart generation failed`, question: req.question, level: 5,
        nodes: [], edges: [], groups: [], legend: [], cameraPolicy: { behavior: "PRESERVE" },
        gaps: ["Chart generation failed before it produced a diagram. Diagnostic details were written to the server log for this request."],
        formReason: `The requested ${chart.name.toLowerCase()} could not be compiled.`, route,
        meta: { kind: "generated-chart", field: chart.name, subject: chartCode },
        params: { chartType: chart.name, chartId: chartCode },
      };
      withAnswer({ view, claims: [] });
      return ok(ctx, { view, claims: [] }, { revision, completeness: "PARTIAL", warnings: ["Chart generation failed; see the server log for its request ID."] });
    }
  }

  private async answerFromEvidence(ctx: CallContext, rev: RevisionRow, question: string, bundle: EvidenceBundle) {
    const { result, note } = await this.svc.callModel<SourceOverviewOutput>(ctx, rev, {
      purpose: "SOURCE_OVERVIEW", schemaId: SCHEMA_SOURCE_OVERVIEW, question, bundle,
      instructions: bundle.investigation ? "Explain the bound subject first. Investigation gaps are limitations of the analysis, never proof of repository absence. Do not assert only, always, never, no implementation, or impossibility of a complete diagram from a bounded static investigation." : undefined,
    });
    const fallback = () => inferSourceOverview(bundle);
    let output = result.ok ? result.value : fallback();
    const current = new Map(bundle.evidence.filter((ev) => ev.state === "CURRENT").map((ev) => [ev.id, ev]));
    const entityIds = new Set(bundle.entities.map((entity) => entity.entityId));
    const unsafeScopeClaim = (text: string) => /\b(only|always|never)\b|\b(?:no|none|cannot|can.t)\b.*\b(?:relationship|implementation|call.flow|diagram|function)\b|\b(?:diagram|call.flow)\b.*\b(?:cannot|can.t)\b/i.test(text);
    const accept = (candidate: SourceOverviewOutput) => candidate.statements.filter((statement) =>
      (!bundle.investigation || !unsafeScopeClaim(statement.text)) && statement.entityIds.every((id) => entityIds.has(id)) &&
      statement.evidenceIds.every((id) => current.has(id)) && statement.entityIds.every((id) =>
        bundle.facts.some((fact) => fact.predicate !== "concept_guidance" && fact.subject === id && fact.evidence.some((ev) => statement.evidenceIds.includes(ev.id))) ||
        bundle.relationships.some((rel) => (rel.from === id || rel.to === id) && rel.evidence.some((ev) => statement.evidenceIds.includes(ev.id)))));
    const rejectedCount = output.statements.length - accept(output).length;
    diagnostic("source-summary.rejected", { requestId: ctx.requestId, rejectedCount, investigation: bundle.investigation?.outcome });
    let accepted = accept(output);
    let usedModel = result.ok && accepted.length > 0;
    const roots = bundle.investigation?.binding.roots ?? [];
    if (!accepted.length || (roots.length && !accepted.some(statement => statement.entityIds.some(id => roots.includes(id))))) { output = fallback(); accepted = accept(output); usedModel = false; }
    const concepts = bundle.facts.filter((f) => f.predicate === "concept_guidance");
    const citedSubjects = new Set(accepted.flatMap((s) => s.entityIds));
    const covered = concepts.filter((f) => ((f.object.value as { members: string[] }).members).some((id) => citedSubjects.has(id)));
    diagnostic("source-summary.concept_coverage", { requestId: ctx.requestId, suppliedConcepts: concepts.length, coveredConcepts: covered.length,
      omittedConceptIds: concepts.filter((f) => !covered.includes(f)).map((f) => f.id) });
    diagnostic("source-summary.accepted", { requestId: ctx.requestId, usedModel, statementCount: accepted.length });
    const claims = accepted.map((statement) => gateClaim({ assertion: statement.text, claimClass: "source-answer",
      evidenceIds: statement.evidenceIds, subjects: statement.entityIds,
      rationaleSummary: "Inferred from production source excerpts and static call relationships; documentation was excluded.",
    }, bundle, { ...(usedModel && result.ok ? { run: result.run } : {}), store: this.store }));
    this.svc.persist(claims);
    const limits = output.limits.filter(text => !bundle.investigation || !unsafeScopeClaim(text));
    const paragraphs = accepted.map((statement, index) => {
      const ev = current.get(statement.evidenceIds[0]!);
      const source = ev ? this.svc.resolveEvidence(rev, ev) : null;
      const citation = source?.state === "CURRENT" ? ` (${source.file}:${source.startLine})` : "";
      return `${index ? "• " : ""}${statement.text}${citation}`;
    });
    return {
      text: paragraphs.length ? `Inferred from the source code:\n\n${paragraphs.join("\n\n")}${limits.length ? `\n\n${limits[0]}` : ""}` :
        undefined,
      claims, warnings: [...(note ? [note] : []), ...bundle.unresolved, ...(!usedModel ? ["Source answering used the offline fallback."] : [])],
    };
  }

  private async askView(ctx: CallContext, req: { question: string; answerContext?: string; snapshotId?: string; route?: ViewRoute; revision?: string; pins?: string[]; seeds?: string[]; overview?: boolean; level?: number; form?: string; kind?: "failure" | "invariant"; subject?: string; lens?: string; chartCode?: string; scope?: "repository" | "subject" }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const question = (req.question ?? "").trim();
    if (!question || question.length > 1000) return fail(ctx, { code: "INVALID_SCHEMA", message: "question must be 1–1000 characters", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; ingest a repository first", retryable: false });
    {
      const message = conceptRequirement(this.store, rev.id);
      if (message) {
        diagnostic("answer.concepts_required", { requestId: ctx.requestId, revision: rev.id });
        return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message, retryable: false });
      }
    }
    const access = policyFor(this.store, rev.repoRoot);
    if(this.store.isRevoked(rev.repoRoot))return fail(ctx,{code:"FORBIDDEN",message:"Access to this source was withdrawn.",retryable:false});
    let reused: import("@cie/schema").EvidenceSnapshot | undefined;
    if(req.snapshotId !== undefined){
      if(typeof req.snapshotId !== "string" || !/^snapshot:[a-f0-9]{64}$/.test(req.snapshotId))return fail(ctx,{code:"INVALID_SCHEMA",message:"Invalid evidence snapshot identifier.",retryable:false});
      reused=this.store.evidenceSnapshot(req.snapshotId) ?? undefined;
      if(!reused)return fail(ctx,{code:"NOT_FOUND",message:"This evidence snapshot is unavailable. Ask the question again to collect fresh evidence.",retryable:false});
      const issue=validateSnapshotReuse(this.store,reused,rev,question,access,ev=>this.svc.resolveEvidence(rev,ev));
      if(issue)return fail(ctx,{code:issue==="access"?"FORBIDDEN":issue==="question"?"INVALID_SCHEMA":"STALE_REVISION",message:issue==="access"?"Access changed since this evidence was collected. Ask again to collect permitted evidence.":issue==="question"?"This snapshot belongs to a different question.":"This evidence snapshot no longer matches the requested revision or current source. Re-index and ask again.",retryable:false});
    }
    const compound = planCompoundQuestion(question, (reused?.bundle.entities ?? this.store.entities(rev.id)).filter(e=>!access.denied(e.file)));
    if(compound && compound.status!=="ready")return fail(ctx,{code:"INSUFFICIENT_EVIDENCE",message:`${compound.status==="ambiguous"?"Choose an exact operand":"Name an indexed operand"} before comparing: ${[compound.left,compound.right].filter(o=>!o.entityIds.length).map(o=>o.label+(o.candidates.length?" — "+o.candidates.join(", "):" — unresolved")).join("; ")}. Repeat the question with an exact entity ID.`,retryable:false});
    if(compound && req.form && req.form!=="GeneratedChart")return fail(ctx,{code:"NOT_IMPLEMENTED",message:"This compound comparison supports generated static charts. The requested specialized view needs a separate analysis.",retryable:false});
    if(compound)req={...req,seeds:[...compound.left.entityIds,...compound.right.entityIds],subject:undefined,scope:"subject",overview:false,form:"GeneratedChart",chartCode:req.chartCode??"S21"};
    const chartDefinition = req.chartCode ? CHART_REGISTRY[req.chartCode as ChartId] : undefined;
    if (req.chartCode && !chartDefinition) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: `unknown chart id "${req.chartCode}"`, retryable: false });
    }
    if(compound && chartDefinition && chartDefinition.form!=="GeneratedChart")return fail(ctx,{code:"NOT_IMPLEMENTED",message:"This compound comparison supports static generated charts. Choose its call graph or another generated chart tab.",retryable:false});
    // A requested chart owns the route unless a caller explicitly selected a visual form.
    // This keeps a query-intent chart code from being re-routed by a second model call.
    let route = req.form ? this.chosenRoute(req.form, req.kind) : req.route ?? (chartDefinition ? this.chosenRoute(chartDefinition.form) : await this.readQuestion(question));
    if (route.form === "GeneratedChart" && req.chartCode) {
      if (chartDefinition!.compiler === "missing") {
        return fail(ctx, { code: "NOT_IMPLEMENTED", message: `${chartDefinition!.name} has no chart compiler yet`, retryable: false });
      }
    }
    diagnostic("ask.route", { requestId: ctx.requestId, revision: rev.id, route, chartCode: req.chartCode, overview: !!req.overview, requiredKinds: chartDefinition?.requiredKinds, requiredAcrossRepository: chartDefinition?.requiredAcrossRepository });
    if(reused && route.form!=="GeneratedChart" && route.form!=="SemanticMap")return fail(ctx,{code:"NOT_IMPLEMENTED",message:"This specialized view requires its own analysis and cannot reuse a static evidence snapshot.",retryable:false});
    const visual = route.source === "chosen" && route.form === "SemanticMap" ? null : visualByForm(route.form);
    if (visual?.build) {
      this.store.audit(actor(ctx), "ask", rev.id, { form: visual.formId, chars: question.length, route: route.source });
      const built = ensureEdgeClaims(this.store, rev, visual.build(this.store, rev, question, req.subject));
      built.view.route = route;
      this.svc.persist(built.claims);
      redactBuilt(this.store, rev, built);
      return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
    }
    const choice = route.form === "CausalGraph" ? { form: "CausalGraph" as const, kind: route.kind ?? "failure", reason: route.kind === "invariant" ? "The question is about a value becoming incorrect, so I mapped every writer of that state." : "The question is about what can make something fail, so I mapped failure sites reachable from the operation." }
      : { form: "SemanticMap" as const, kind: undefined, reason: "The question is about how something works, so I composed a map of the relevant code, grouped by responsibility." };
    this.store.audit(actor(ctx), "ask", rev.id, { form: choice.form + (choice.kind ? `:${choice.kind}` : ""), chars: question.length, route: route.source });

    if (choice.form === "CausalGraph") {
      const built = choice.kind === "invariant" ? buildInvariantGraph(this.store, rev, question) : buildFailureGraph(this.store, rev, question);
      built.view.formReason = choice.reason;
      built.view.route = route;
      // The native causal analysis can be empty when static indexing found no matching
      // throw/write path. In that case, use the bounded chart planner to arrange only
      // entities and relationships already present in this revision. The compiled
      // ViewSpec remains interactive, and the validated plan is persisted by evidence
      // bundle + question so a repeat does not call the model again.
      if (built.view.nodes.length === 0) {
        const fallbackOptions = { overview: req.overview, lens: req.lens, pins: new Set(req.pins ?? []), extraSeeds: [...(req.pins ?? []), ...(req.overview ? overviewSeeds(this.store, rev.id) : req.seeds ?? [])], access: policyFor(this.store, rev.repoRoot) };
        const modelBundle = retrieveForQuestion(this.store, rev.id, question, { ...fallbackOptions, tokenBudget: req.overview ? undefined : chunkTokenBudget() }).bundle;
        if (modelBundle.entities.length > 0) {
          const cacheKey = chartPlanCacheKey(modelBundle, question, req.chartCode, req.answerContext);
          let plan = matchingChartPlan(this.store.generatedChartPlan(cacheKey, modelBundle.id, question) ?? cachedChartPlan(modelBundle, question, req.chartCode, req.answerContext), req.chartCode);
          const warnings: string[] = [];
          let cacheHit = !!plan;
          let run: ModelRunRef | undefined;
          const diag: ChartCompileDiag = { cacheHit, schemaValidationPassed: true };
          if (!plan) {
            const generated = await this.svc.callModel<ChartOutput>(ctx, rev, chartCreatorRequest(question, modelBundle, req.chartCode, req.answerContext));
            if (generated.note) warnings.push(generated.note);
            if (generated.result.ok) {
              plan = generated.result.value;
              run = generated.result.run;
              diag.provider = generated.result.run.provider;
              diag.model = generated.result.run.model;
              if (req.chartCode) {
                const idCheck = validateChartIdNotChanged(plan as unknown as ChartOutputV2, req.chartCode);
                if (!idCheck.ok) {
                  warnings.push(idCheck.warning!);
                  process.stderr.write(`[chart] ${idCheck.warning}\n`);
                  plan = null;
                  diag.schemaValidationPassed = false;
                  diag.fallbackReason = "chart-id-mismatch";
                }
              }
              if (plan) {
                rememberChartPlan(modelBundle, question, plan, req.answerContext);
                this.store.saveGeneratedChartPlan(cacheKey, modelBundle.id, question, plan);
              }
            } else {
              warnings.push(modelFailureNotice(generated.result.error, generated.provider));
              diag.schemaValidationPassed = generated.result.error.code !== "INVALID_SCHEMA";
              diag.fallbackReason = generated.result.error.code;
              process.stderr.write(`[chart] ${JSON.stringify({ chartId: req.chartCode ?? "generic", provider: generated.provider.name, model: generated.provider.model, schemaValidationPassed: diag.schemaValidationPassed, error: generated.result.error.code })}\n`);
            }
          }
          if (plan && (plan.nodes.length > 0 || ((plan as unknown as { chartId?: string; classes?: unknown[] }).chartId === "S16" && ((plan as unknown as { classes?: unknown[] }).classes?.length ?? 0) > 0))) {
            const chartRoute = { ...route, form: "GeneratedChart" as const, name: "Evidence-grounded chart" };
            const chart = compileChartPlan({ plan, bundle: modelBundle, rev, question, route: chartRoute, chartId: req.chartCode, run, diag });
            chart.view.formReason = `The native causal analysis found no statically supported path. This chart arranges indexed code elements and relationships; it does not establish runtime payment or top-up outcomes. ${choice.reason}`;
            chart.view.gaps.unshift(...built.view.gaps);
            this.svc.persist(chart.claims);
            redactBuilt(this.store, rev, chart);
            return ok(ctx, chart, { revision: rev.id, warnings, completeness: chart.view.gaps.length ? "PARTIAL" : "COMPLETE" });
          }
          built.view.gaps.push("No evidence-grounded chart could be assembled from the indexed code relationships.");
        }
      }
      this.svc.persist(built.claims);
      redactBuilt(this.store, rev, built);
      return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
    }

    // Hybrid retrieval: exact names, semantic closeness, concept cards and the graph, over only what this caller may see, cut to the model's budget.
    const semantic = reused || req.overview || req.scope === "repository" ? undefined : await semanticScores(this.store, rev.id, question, this.svc.embedder).catch(() => undefined);
    const retrievalOptions = { subject: req.subject, subjectSeeds: req.seeds ?? [], scope: req.scope ?? (req.overview ? "repository" as const : "subject" as const), forModel: true, resolveEvidence: (ev: EvidenceRef) => this.svc.resolveEvidence(rev, ev), overview: req.overview, lens: req.lens, pins: new Set(req.pins ?? []), extraSeeds: [...(req.pins ?? []), ...(req.overview ? overviewSeeds(this.store, rev.id) : req.seeds ?? [])], semantic, access: policyFor(this.store, rev.repoRoot), requireKinds: chartDefinition?.requiredKinds, requireAcrossRepositoryKinds: chartDefinition?.requiredAcrossRepository };
    const collected = reused ? retrieveFromSnapshot(reused, {tokenBudget:chunkTokenBudget(),requireKinds:[...(chartDefinition?.requiredKinds??[]),...(chartDefinition?.requiredAcrossRepository??[])]})
      : retrieveForQuestion(this.store, rev.id, question, { ...retrievalOptions, tokenBudget: chunkTokenBudget() });
    const compoundResult=compound ? evaluateCompoundQuestion(collected.snapshot,compound) : undefined;
    const retrieval=compoundResult ? retrieveFromSnapshot(collected.snapshot,{tokenBudget:chunkTokenBudget(),requireKinds:[...(chartDefinition?.requiredKinds??[]),...(chartDefinition?.requiredAcrossRepository??[])],
      subjectIds:[...compound!.left.entityIds,...compound!.right.entityIds],protectedIds:compoundResult.rows.filter(r=>r.result==="present").flatMap(r=>[...(r.paths?.left?.entityIds??[]),...(r.paths?.right?.entityIds??[])]),resultIds:compoundResult.rows.filter(r=>r.result==="present").flatMap(r=>[r.entityId,...(r.paths?.left?.entityIds??[]),...(r.paths?.right?.entityIds??[])])}) : collected;
    const { snapshot, bundle, tiers, scored, hidden, inaccessible, truncation } = retrieval;
    if((reused||compoundResult) && bundle.tokenEstimate>chunkTokenBudget())return fail(ctx,{code:"BUDGET_EXCEEDED",message:"The bound evidence exceeds the prompt budget. Narrow the operands or question before generating this view.",retryable:false});
    const modelBundle = bundle;
    if (req.chartCode === "S16") {
      const counts = (entities: { kind: string }[]) => Object.fromEntries(["class", "interface", "enum", "field", "method"].map((kind) => [kind, entities.filter((e) => e.kind === kind).length]));
      const indexed = this.store.entities(rev.id);
      const signatureFacts = modelBundle.facts.filter((f) => f.predicate === "signature").length;
      process.stderr.write(`[uml] ${JSON.stringify({ stage: "retrieval", requestId: ctx.requestId, revision: rev.id, indexed: counts(indexed), bundle: counts(modelBundle.entities), signatureFacts, relationships: modelBundle.relationships.length, evidence: modelBundle.evidence.length, tokenEstimate: modelBundle.tokenEstimate, budget: chunkTokenBudget(), omittedMembers: hidden.filter((h) => h.reason.includes("class-member bundle")).length, truncation: !!truncation })}\n`);
    }
    if (req.chartCode === "S23") {
      const indexed = this.store.entities(rev.id);
      const byKind = (items: { kind: string }[]) => Object.fromEntries([...new Set(items.map((e) => e.kind))].sort().map((kind) => [kind, items.filter((e) => e.kind === kind).length]));
      const relationKinds = Object.fromEntries([...new Set(modelBundle.relationships.map((r) => r.kind))].sort().map((kind) => [kind, modelBundle.relationships.filter((r) => r.kind === kind).length]));
      process.stderr.write(`[chart] ${JSON.stringify({ stage: "retrieval", requestId: ctx.requestId, chartId: "S23", revision: rev.id, indexedFiles: indexed.filter((e) => e.kind === "file").length, bundleFiles: modelBundle.entities.filter((e) => e.kind === "file").length, indexedKinds: byKind(indexed), bundleKinds: byKind(modelBundle.entities), relationKinds, evidence: modelBundle.evidence.length, tokenEstimate: modelBundle.tokenEstimate, budget: chunkTokenBudget(), truncation: !!truncation })}\n`);
    }
    const diagnostics = rev.diagnostics.filter((d) => d.code === "PARSE_ERRORS").map((d) => d.message);
    let representation: RepresentationOutput | undefined, run;
    const warnings: string[] = [];
    if (route.form === "GeneratedChart") {
      // Answer the question from the same evidence independently of whether its diagram is renderable.
      const evidenceAnswer = compoundResult ? {text:compoundAnswer(compoundResult),claims:[],warnings:[]} : await this.answerFromEvidence(ctx, rev, question, modelBundle);
      warnings.push(...evidenceAnswer.warnings);
      const cacheKey = chartPlanCacheKey(modelBundle, question, req.chartCode, req.answerContext);
      let plan = matchingChartPlan(this.store.generatedChartPlan(cacheKey, modelBundle.id, question) ?? cachedChartPlan(modelBundle, question, req.chartCode, req.answerContext), req.chartCode);
      diagnostic("chart.cache", { requestId: ctx.requestId, chartId: req.chartCode, cacheKey, hit: !!plan, bundleId: modelBundle.id });
      let chartRun: ModelRunRef | undefined;
      const chartDiag: ChartCompileDiag = { cacheHit: !!plan, schemaValidationPassed: true };
      if (!plan && bundle.entities.length > 0) {
        const generated = await this.svc.callModel<ChartOutput>(ctx, rev, chartCreatorRequest(question, modelBundle, req.chartCode, req.answerContext));
        if (generated.note) warnings.push(generated.note);
        if (generated.result.ok) {
          plan = generated.result.value;
          chartRun = generated.result.run;
          chartDiag.provider = generated.result.run.provider;
          chartDiag.model = generated.result.run.model;
          if (req.chartCode) {
            const idCheck = validateChartIdNotChanged(plan as unknown as ChartOutputV2, req.chartCode);
            if (!idCheck.ok) {
              warnings.push(idCheck.warning!);
              process.stderr.write(`[chart] ${idCheck.warning}\n`);
              plan = null;
              chartDiag.schemaValidationPassed = false;
              chartDiag.fallbackReason = "chart-id-mismatch";
            }
          }
          if (plan) {
            rememberChartPlan(modelBundle, question, plan, req.answerContext);
            this.store.saveGeneratedChartPlan(cacheKey, modelBundle.id, question, plan);
          }
        } else {
          warnings.push(modelFailureNotice(generated.result.error, generated.provider));
          chartDiag.schemaValidationPassed = generated.result.error.code !== "INVALID_SCHEMA";
          chartDiag.fallbackReason = generated.result.error.code;
        }
      }
      // Keep the explicitly requested chart selected when generation fails or retrieval has
      // no entities. The offline provider returns a typed plan and caption, so this exposes
      // the evidence gap without inventing chart contents or switching to another view.
      if (!plan && req.chartCode) {
        const offlineStarted = performance.now();
        diagnostic("model.dispatch", { requestId: ctx.requestId, purpose: "CHART", chartId: req.chartCode, provider: this.svc.offline.name, model: this.svc.offline.model, hosted: false, reason: bundle.entities.length ? "chart generation failed or was rejected" : "retrieval returned no entities", bundle: bundleDiagnostics(modelBundle) });
        const empty = await runModel<ChartOutput>(this.svc.offline, chartCreatorRequest(question, modelBundle, req.chartCode, req.answerContext), {
          deadlineMs: Math.max(1000, ctx.deadlineMs - Date.now()),
        });
        diagnostic("model.complete", { requestId: ctx.requestId, purpose: "CHART", chartId: req.chartCode, elapsedMs: performance.now() - offlineStarted, provider: this.svc.offline.name, model: this.svc.offline.model, ok: empty.ok, ...(empty.ok ? { run: empty.run, outputKeys: Object.keys(empty.value) } : { error: empty.error }) }, empty.ok ? "debug" : "warn");
        if (empty.ok) {
          plan = empty.value;
          chartRun = empty.run;
          chartDiag.provider = empty.run.provider;
          chartDiag.model = empty.run.model;
          chartDiag.schemaValidationPassed = true;
        } else {
          warnings.push(modelFailureNotice(empty.error, this.svc.offline));
          chartDiag.schemaValidationPassed = empty.error.code !== "INVALID_SCHEMA";
          chartDiag.fallbackReason = empty.error.code;
        }
      }
      if (plan) {
        if (req.chartCode === "S16") {
          const classPlan = plan as ChartOutputV2;
          const classes = classPlan.chartId === "S16" ? classPlan.classes : [];
          process.stderr.write(`[uml] ${JSON.stringify({ stage: "plan", requestId: ctx.requestId, chartId: classPlan.chartId, classes: classes.length, attributes: classes.reduce((n, c) => n + c.attributes.length, 0), operations: classes.reduce((n, c) => n + c.operations.length, 0), attributeEvidence: classes.reduce((n, c) => n + c.attributes.filter((x) => x.evidenceIds.length).length, 0), operationEvidence: classes.reduce((n, c) => n + c.operations.filter((x) => x.evidenceIds.length).length, 0), cacheHit: chartDiag.cacheHit, provider: chartDiag.provider, model: chartDiag.model })}\n`);
        }
        diagnostic("chart.plan", { requestId: ctx.requestId, chartId: req.chartCode, plan, diagnostics: chartDiag });
        const built = compileChartPlan({ plan, bundle: modelBundle, rev, question, route, chartId: req.chartCode, run: chartRun, diag: chartDiag });
        if (evidenceAnswer.text) built.view.answer = evidenceAnswer.text;
        built.claims.push(...evidenceAnswer.claims);
        if (!built.view.nodes.length && evidenceAnswer.text) built.view.gaps.push("The evidence supports the written explanation, but does not support the requested diagram.");
        if (truncation) built.view.gaps.push(`The evidence was cut to fit the model's budget (${truncation.before} → ${truncation.after} estimated tokens): ${truncation.dropped.length} element(s) were dropped after reducing detail.`);
        if (bundle.investigation && bundle.investigation.outcome !== "supported") built.view.gaps.push(...bundle.investigation.gaps.map(g => g.message));
        built.view.compoundQuery = compoundResult;
        if(compoundResult)built.view.gaps.push(...compoundResult.limitations);
        built.view.evidenceProjection = bundle.projection;
        built.view.evidenceCoverage = snapshot.coverage;
        built.view.findings = [...snapshot.findings, ...evidenceAnswer.claims.map(claim => ({
          id: `finding:answer:${createHash("sha256").update(JSON.stringify([rev.id, claim.draft.assertion, claim.draft.evidenceIds])).digest("hex")}`,
          kind: "source-answer" as const, subjectIds: claim.draft.subjects ?? [], evidenceIds: claim.draft.evidenceIds,
          assertion: claim.draft.assertion, validation: "citation-checked" as const,
        }))];
        built.view.evidenceInvestigation = bundle.investigation;
        built.view.params = { ...built.view.params, overview: retrievalOptions.scope === "repository", ...(req.subject ? { subject: req.subject } : {}), scope: retrievalOptions.scope };
        diagnostic("chart.compiled", { requestId: ctx.requestId, chartId: req.chartCode, diagnostics: built.diagnostics, nodes: built.view.nodes.length, edges: built.view.edges.length, gaps: built.view.gaps });
        if (req.chartCode === "S16") process.stderr.write(`[uml] ${JSON.stringify({ stage: "compiled", requestId: ctx.requestId, nodes: built.view.nodes.length, nodesWithMembers: built.view.nodes.filter((n) => (n.notes?.length ?? 0) > 0).length, renderedMembers: built.view.nodes.reduce((n, node) => n + (node.notes?.length ?? 0), 0), edges: built.view.edges.length, gaps: built.view.gaps.length })}\n`);
        // Structured chart diagnostics (spec §3.4): counts and gaps only — never source contents, secrets or prompts.
        process.stderr.write(`[chart] ${JSON.stringify(built.diagnostics)}\n`);
        this.svc.persist(built.claims);
        redactBuilt(this.store, rev, built);
        return ok(ctx, built, { revision: rev.id, warnings, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
      }
      route = { ...route, source: "default", confidence: "low", form: "SemanticMap", name: "Architecture map", because: "The generated chart was unavailable, so I fell back to the standard architecture map.", alternatives: [] };
    }
    if (bundle.entities.length > 0) {
      const { result, note, provider } = await this.svc.callModel<RepresentationOutput>(ctx, rev, { purpose: "REPRESENT", schemaId: SCHEMA_REPRESENTATION, question, bundle: modelBundle });
      if (note) warnings.push(note);
      if (result.ok) { representation = result.value; run = result.run; }
      else { warnings.push(modelFailureNotice(result.error, provider)); diagnostics.push(`model output unavailable: ${result.error.code}`); }
    }
    const { view, claims } = compileView({ question, bundle, tiers, scored, representation, run, diagnostics, store: this.store, systemName: rev.repoRoot.split("/").filter(Boolean).pop() });
    // "The question is about how something works" is only true when the wording said so. A default or a guess is described
    // by the reading itself (route.because), so the two never disagree.
    view.formReason = route.source !== "default" ? choice.reason : undefined;
    view.route = route;
    if (req.overview) { view.params = { ...view.params, overview: true }; view.gaps.push("Overview samples code across languages and source modules; it is not a complete file listing."); }
    if (req.level !== undefined) view.level = req.level;
    view.hidden = hidden;
    if (inaccessible) view.gaps.push(`${inaccessible} match(es) are in code you do not have access to and were left out.`);
    if (truncation) view.gaps.push(`The evidence was cut to fit the model's budget (${truncation.before} → ${truncation.after} estimated tokens): ${truncation.dropped.length} element(s) were dropped, lowest-ranked first. "Why isn't X shown?" lists them.`);
    view.compoundQuery = compoundResult;
    if(compoundResult){view.answer=compoundAnswer(compoundResult);view.gaps.push(...compoundResult.limitations);}
    view.evidenceProjection = bundle.projection;
    view.evidenceCoverage = snapshot.coverage;
    view.findings = snapshot.findings;
    view.evidenceInvestigation = bundle.investigation;
    if (bundle.investigation && bundle.investigation.outcome !== "supported") view.gaps.push(...bundle.investigation.gaps.map(g => g.message));
    this.svc.persist(claims);
    const mapBuilt = redactBuilt(this.store, rev, { view, claims });
    return ok(ctx, { view: mapBuilt.view, claims: mapBuilt.claims }, { revision: rev.id, warnings, completeness: mapBuilt.view.gaps.length ? "PARTIAL" : "COMPLETE" });
  }

  async investigate(ctx: CallContext, req: { trace: string; revision?: string; ignored?: string[] }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; ingest a repository first", retryable: false });
    if (!req.trace || req.trace.length > 100_000) return fail(ctx, { code: "INVALID_SCHEMA", message: "trace must be 1–100000 characters", retryable: false });
    const built = buildHypothesis(this.store, rev, { trace: req.trace, ignored: req.ignored });
    if ("error" in built) return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: built.error, retryable: false });
    this.svc.persist(built.claims);
    this.store.audit(actor(ctx), "investigate", rev.id, { suspects: built.view.nodes.filter((n) => n.role === "suspect").length });
    redactBuilt(this.store, rev, built);
    return ok(ctx, withAnswer(built), { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
  }

  /** The catalogue of visuals, with whether each can be shown for the current repository and why not. */
  visuals(ctx: CallContext, req: { revision?: string }): ApiResult<CatalogEntry[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return ok(ctx, catalog(this.store, rev, !!rev && isGitRepo(rev.repoRoot)), rev ? { revision: rev.id } : {});
  }

  private manifestFor(views: ViewSpec[], question: string, context?: { scope: "subject" | "repository"; subject?: string; seeds?: string[] }, answerContext?: string): ResponseManifest {
    const rev = this.store.revision(views[0]!.revision);
    return responsePortfolio({ views, question, context, answerContext: boundAnswerContext(answerContext), evidenceKinds: this.store.entityKindCounts(views[0]!.revision), catalog: catalog(this.store, rev, !!rev && isGitRepo(rev.repoRoot)) });
  }

  /** Rank supported chat chart options against the question and the answer that was just shown. */
  async recommendCharts(ctx: CallContext, req: { question?: string; response?: string; revision?: string; options?: ChartOption[] }): Promise<ApiResult<{ codes: string[]; source: "llm" | "unavailable"; model: string | null; reason?: string }>> {
    const question = typeof req?.question === "string" ? req.question.trim().slice(0, 1600) : "";
    const response = typeof req?.response === "string" ? req.response.trim().slice(0, 6000) : "";
    const options = Array.isArray(req?.options) ? req.options.slice(0, 40) : [];
    if (!question || !response || options.length < 3 || options.some((o) => !o || !/^[SV]\d+$/.test(o.code) || !o.name || !o.description || !o.form || [o.name, o.description, o.form, o.example ?? ""].some((v) => typeof v !== "string" || v.length > 500) || (o.needs !== undefined && (!Array.isArray(o.needs) || o.needs.length > 12 || o.needs.some((n) => typeof n !== "string" || n.length > 80)))) || new Set(options.map((o) => o.code)).size !== options.length) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: "chart recommendations need a question, response and at least three unique supported chart options", retryable: false });
    }
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    const router = this.svc.router;
    const log = (details: Record<string, unknown>) => { try { this.store.audit(actor(ctx), "chart.recommendation", rev?.id ?? "unbound", { requestId: ctx.requestId, promptVersion: "chart-options-v3-all-catalog", optionCount: options.length, optionCodes: options.map((o) => o.code), optionNames: options.map((o) => o.name), questionChars: question.length, responseChars: response.length, ...details }); } catch { /* diagnostics must not block rendering */ } };
    if (!router?.recommendCharts) {
      log({ model: router?.name ?? null, outcome: "router-unavailable" });
      return ok(ctx, { codes: [], source: "unavailable", model: router?.name ?? null, reason: "router-unavailable" }, rev ? { revision: rev.id } : {});
    }
    if ((router as RouterModel & { hosted?: boolean }).hosted) {
      if (!rev) {
        log({ model: router.name, hosted: true, outcome: "no-revision" });
        return ok(ctx, { codes: [], source: "unavailable", model: router.name, reason: "no-revision" });
      }
      let allowed = false;
      try { allowed = this.store.allowHosted(rev.repoRoot) === true; } catch { /* fail closed */ }
      if (!allowed) {
        try { this.store.audit(actor(ctx), "egress.denied", rev.repoRoot, { purpose: "chart-recommendations", destination: router.name }); } catch { /* denial stands */ }
        log({ model: router.name, hosted: true, outcome: "hosted-not-approved" });
        return ok(ctx, { codes: [], source: "unavailable", model: router.name, reason: "hosted-not-approved" }, { revision: rev.id, warnings: ["Chart recommendations were not sent to the hosted model because hosted access is not approved for this repository."] });
      }
      const payloadHash = createHash("sha256").update(JSON.stringify({ question, response, options })).digest("hex");
      try { this.store.audit(actor(ctx), "egress.approved", rev.repoRoot, { purpose: "chart-recommendations", destination: router.name, payloadHash }); }
      catch {
        log({ model: router.name, hosted: true, outcome: "egress-audit-failed" });
        return ok(ctx, { codes: [], source: "unavailable", model: router.name, reason: "egress-audit-failed" }, { revision: rev.id, warnings: ["Chart recommendations were not sent because the hosted-model egress audit could not be recorded."] });
      }
    }
    try {
      const result = await router.recommendCharts({ question, response, options });
      const allowed = new Set(options.map((o) => o.code));
      const selected = [...new Set(result.codes.filter((code) => allowed.has(code)))].slice(0, options.length);
      log({ model: router.name, hosted: !!(router as RouterModel & { hosted?: boolean }).hosted, outcome: result.outcome, httpStatus: result.httpStatus, selectedCodes: selected, selectedCount: selected.length, rejectedCodes: result.rejectedCodes ?? 0 });
      return ok(ctx, selected.length ? { codes: selected, source: "llm", model: router.name } : { codes: [], source: "unavailable", model: router.name, reason: result.outcome }, rev ? { revision: rev.id } : {});
    } catch {
      log({ model: router.name, outcome: "service-error" });
      return ok(ctx, { codes: [], source: "unavailable", model: router.name, reason: "service-error" }, rev ? { revision: rev.id } : {});
    }
  }

  /** Rebuild the current view with whatever changed underneath it (an override, a new exception), keeping its identity. */
  async refreshView(ctx: CallContext, req: { view: ViewSpec }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const v = req.view;
    if (!v) return fail(ctx, { code: "INVALID_SCHEMA", message: "no view", retryable: false });
    const rev = this.store.revision(v.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const pins = [...this.store.overrides(rev.repoRoot)].filter(([, mode]) => mode === "pin").map(([entityId]) => entityId);
    const r = v.investigation
      ? await this.investigate(ctx, { trace: v.investigation.trace, revision: v.revision, ignored: v.investigation.ignored })
      : await this.ask(ctx, { question: v.question, revision: v.revision, form: v.formId, ...(typeof v.params?.chartId === "string" ? { chartCode: v.params.chartId } : {}), scope: v.params?.scope === "repository" ? "repository" : "subject", overview: v.params?.overview === true, subject: typeof v.params?.subject === "string" ? v.params.subject : undefined, pins });
    if (r.ok) r.value.view.version = v.version + 1;
    return r;
  }

  /** "ignore X" / "restore X" on an investigation: rebuild with the new exclusion set; the view version advances. */
  steer(ctx: CallContext, req: { view: ViewSpec; action: "IGNORE" | "RESTORE"; entityId: string }): ApiResult<{ view: ViewSpec; claims: Claim[] }> {
    const inv = req.view?.investigation;
    if (req.view?.formId !== "HypothesisGraph" || !inv) return fail(ctx, { code: "INVALID_SCHEMA", message: "only an investigation can be steered", retryable: false });
    const rev = this.store.revision(req.view.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const ignored = new Set(inv.ignored);
    if (req.action === "IGNORE") ignored.add(req.entityId); else ignored.delete(req.entityId);
    const built = buildHypothesis(this.store, rev, { trace: inv.trace, ignored: [...ignored] });
    if ("error" in built) return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: built.error, retryable: false });
    built.view.version = req.view.version + 1;
    this.svc.persist(built.claims);
    this.store.audit(actor(ctx), `steer.${req.action.toLowerCase()}`, req.entityId, { version: built.view.version });
    redactBuilt(this.store, rev, built);
    return ok(ctx, withAnswer(built), { revision: rev.id });
  }

  // ---------------------------------------------------------------- explanations
  async explain(ctx: CallContext, req: { revision: string; entityIds: string[]; question?: string }): Promise<ApiResult<ExplainResult>> {
    const rev = this.store.revision(req.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const selected = [...new Set(req.entityIds ?? [])].slice(0, 20);
    if (selected.length === 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "select at least one element", retryable: false });
    const found = this.store.entitiesById(rev.id, selected);
    if (found.length !== selected.length) return fail(ctx, { code: "NOT_FOUND", message: "selection references unknown entities", retryable: false });
    const acc = policyFor(this.store, rev.repoRoot);
    // A selection inside code this caller cannot see is refused without saying what it was.
    if (found.some((e) => acc.denied(e.file))) return fail(ctx, { code: "FORBIDDEN", message: "one or more selected elements are not accessible to you", retryable: false });

    const bundle = retrieveAround(this.store, rev.id, selected, 3, 120, acc);
    const question = req.question?.trim() || "Why are these connected?";
    const { result, note } = await this.svc.callModel<ExplanationOutput>(ctx, rev, { purpose: "EXPLAIN", schemaId: SCHEMA_EXPLANATION, question, bundle, selected });
    if (!result.ok) return fail(ctx, result.error);

    let claims = result.value.claims.map((c) => gateClaim({ ...c, structure: c.pathEntityIds && c.pathEntityIds.length > 1 ? { kind: "path", entityIds: c.pathEntityIds } : undefined }, bundle, { run: result.run, store: this.store }));
    // Adversarial pass by the model for the claims that survived grounding (bounded; the stub has nothing to add).
    if (this.svc.model.name !== "stub") {
      claims = await Promise.all(claims.map(async (c, i) => {
        if (i >= 3 || c.displayMode === "HIDDEN") return c;
        const ch = await this.svc.callModel<ChallengeOutput>(ctx, rev, { purpose: "CHALLENGE", schemaId: SCHEMA_CHALLENGE, question, bundle, selected, claim: { assertion: c.draft.assertion, evidenceIds: c.draft.evidenceIds } });
        if (!ch.result.ok) return c;
        return withChallenge(c, bundle, ch.result.value.objections, this.store);
      }));
    }
    this.svc.persist(claims);
    const shown = claims.filter((c) => c.displayMode !== "HIDDEN");
    const rejected = claims.length - shown.length;
    const evidence = this.svc.resolveMany(rev, bundle.evidence, [...new Set(shown.flatMap((c) => c.draft.evidenceIds))]);
    const said = modelText(result.value.summary, `The model's summary was withheld: it claimed certainty or carried a link, which only evidence and the gates may do.`);
    const summary = rejected ? `${said.text} (${rejected} claim(s) withheld: they failed a gate.)` : said.text;
    this.store.audit(actor(ctx), "explain", rev.id, { selected: selected.length, claims: claims.length, withheld: rejected });
    return ok(ctx, { summary, claims, evidence, selected }, { revision: rev.id, completeness: rejected ? "PARTIAL" : "COMPLETE", warnings: note ? [note] : [] });
  }
  /** "Why are you showing this?": the salience factors and evidence behind a node, in plain terms. */
  whyShown(ctx: CallContext, req: { view: ViewSpec; nodeId: string }): ApiResult<ExplainResult> {
    const rev = this.store.revision(req.view?.revision);
    const node = req.view?.nodes.find((n) => n.id === req.nodeId);
    if (!rev || !node) return fail(ctx, { code: "NOT_FOUND", message: "no such element in this view", retryable: false });
    const lines: string[] = [];
    if (node.rank) lines.push(`Ranked #${node.rank} among suspects (score ${node.score?.toFixed(2)}).`);
    else if (node.score !== undefined) lines.push(`Relevance ${node.score.toFixed(2)} → tier ${node.tier}.`);
    for (const f of (node.factors ?? []).filter((x) => x.normalizedScore > 0).sort((a, b) => b.normalizedScore - a.normalizedScore)) lines.push(`${f.factor.replace(/_/g, " ").toLowerCase()}: ${f.reason} (${f.normalizedScore.toFixed(2)}).`);
    if (node.role === "failure-site" || node.role === "writer" || node.role === "state") lines.push(...(node.notes ?? []));
    if (lines.length === 0) lines.push(node.role ? `It plays the role “${node.role}” in this ${req.view.formId}.` : "It is a direct neighbour of a matched element.");
    const factorEv = (node.factors ?? []).flatMap((f) => f.evidenceIds);
    const evidenceIds = [...new Set([...node.evidenceIds, ...factorEv])].slice(0, 8);
    const claim = gateClaim({ assertion: `“${node.label}” is shown because: ${lines.slice(0, 3).join(" ")}`, claimClass: "why-shown", evidenceIds, rationaleSummary: "Explains the salience factors that placed this element in the view." }, bundleFor(this.store, rev.id, node.entityRefs), { store: this.store, trusted: true });
    this.svc.persist([claim]);
    return ok(ctx, { summary: lines.join("\n"), claims: [claim], evidence: this.svc.resolveMany(rev, [], evidenceIds), selected: node.entityRefs }, { revision: rev.id });
  }

  /** "Why isn't X shown?": names the reason, using the retrieval record or by scoring X against the question. */
  whyHidden(ctx: CallContext, req: { view: ViewSpec; query: string }): ApiResult<ExplainResult> {
    const rev = this.store.revision(req.view?.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const q = req.query.trim().toLowerCase();
    if (!q) return fail(ctx, { code: "INVALID_SCHEMA", message: "say what you expected to see", retryable: false });
    const shownIds = new Set(req.view.nodes.flatMap((n) => n.entityRefs));
    const matches = this.store.entities(rev.id).filter((e) => e.kind !== "file" && (e.name.toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q)));
    if (matches.length === 0) return ok(ctx, { summary: `Nothing in this repository is named like “${req.query}”, so it can't be shown. Static analysis only sees what is in the code.`, claims: [], evidence: [], selected: [] }, { revision: rev.id });
    const lines: string[] = [];
    for (const e of matches.slice(0, 4)) {
      if (shownIds.has(e.entityId)) { lines.push(`${e.name} is shown (it is in the view).`); continue; }
      const rec = req.view.hidden?.find((h) => h.entityId === e.entityId);
      if (req.view.ignored?.includes(e.entityId)) { lines.push(`${e.name}: you asked to ignore it.`); continue; }
      if (rec) { lines.push(`${e.name}: ${rec.reason}.`); continue; }
      const terms = (req.view.question.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((t) => t.length > 2);
      const s = scoreEntity(e, { store: this.store, revision: rev.id, terms, weights: WEIGHTS.map });
      const top = s.factors.filter((f) => f.normalizedScore > 0).map((f) => f.reason);
      lines.push(`${e.name}: relevance ${s.score.toFixed(2)} for this question — ${top.length ? top.join("; ") : "it does not match the question's terms and is not next to a shown element"}.`);
    }
    return ok(ctx, { summary: lines.join("\n"), claims: [], evidence: [], selected: matches.map((m) => m.entityId) }, { revision: rev.id });
  }

  /** "Why do you suspect X?": the ranking factors behind a suspect, with citations. */
  whySuspect(ctx: CallContext, req: { view: ViewSpec; target: string }): ApiResult<ExplainResult> {
    const t = req.target.trim().toLowerCase();
    const suspects = (req.view?.nodes ?? []).filter((n) => n.role === "suspect");
    const node = t ? suspects.find((n) => n.label.toLowerCase().includes(t)) : suspects[0];
    if (!node) return fail(ctx, { code: "NOT_FOUND", message: t ? `no suspect named like “${req.target}”` : "no suspects in this view", retryable: false });
    return this.whyShown(ctx, { view: req.view, nodeId: node.id });
  }
  /** Classifies user input into one of the 34 closed intents. */
  private async classifyIntent(ctx: CallContext, text: string, view: ViewSpec | null, selected: any[], sessionId?: string, requestedRevision?: string): Promise<{ intent: ChatIntent; label: string | null; because: string }> {
    const revision = requestedRevision ?? view?.revision ?? this.store.latestRevision()?.id;
    const session = this.svc.sessionManager.getSession(ctx, sessionId, revision);

    // Current-view actions and pasted traces belong to the existing map interaction
    // route. Keep them out of the repository-query classifier.
    const viewAction = /\b(pin|unpin|boost|demote|ignore|restore|why (?:is|are) .{1,100} hidden|why (?:are|is) .{1,100} showing|why does .{1,100} appear|what connects|connected)\b/i.test(text);
    const zoomAction = /^(?:zoom in|zoom out|go back|go up|show me the overall system again|reset to the top-level architecture)\b/i.test(text.trim());
    if (looksLikeTrace(text) || (view && viewAction) || zoomAction) {
      return readText(this.svc.router, text, {
        hasView: !!view,
        viewForm: view?.formId,
        selectionCount: selected.length,
        looksLikeTrace: looksLikeTrace(text),
      });
    }

    if (!this.svc.router || !this.svc.router.classify) {
      // Fallback to basic readText if classifier is unavailable
      return readText(this.svc.router, text, {
        hasView: !!view,
        viewForm: view?.formId,
        selectionCount: selected.length,
        looksLikeTrace: looksLikeTrace(text)
      });
    }

    const classificationStarted = performance.now();
    const navigation = revision ? navigateHierarchy(this.store, revision, text) : undefined;
    const repoRoot = revision ? this.store.revision(revision)?.repoRoot : undefined;
    const shareHierarchy = !/(:|-)cloud$/.test(this.svc.router.name) || !!(repoRoot && this.store.allowHosted(repoRoot));
    const classification = await this.svc.router.classify({
      question: text,
      intentMenu: "Closed list of 34 intents",
      ...(navigation ? { hierarchyContext: { level: navigation.level, conceptIds: shareHierarchy ? navigation.conceptIds : [],
        nodes: shareHierarchy ? navigation.nodes.filter((n) => !detectSecret(JSON.stringify(n))) : [] } } : {}),
      referents: session.referentLedger.map(r => ({
        label: r.label,
        kind: r.kind,
        level: r.level,
        source: r.source
      })),
    });

    diagnostic("intent.classified", { requestId: ctx.requestId, revision, router: this.svc.router.name, elapsedMs: performance.now() - classificationStarted, classification, referentCount: session.referentLedger.length });
    if (!classification) {
      // Classification is an optional enhancement; retain the established route when
      // the provider is offline, rejects the schema, or times out.
      return readText(this.svc.router, text, {
        hasView: !!view,
        viewForm: view?.formId,
        selectionCount: selected.length,
        looksLikeTrace: looksLikeTrace(text),
      });
    }

    if (classification.confidence < INTENT_CONFIDENCE_THRESHOLD || classification.intent_id === "new_intent") {
      return {
        intent: {
          type: "newIntent",
          detected: classification?.intent ?? "unknown",
          confidence: classification?.confidence ?? 0,
          reason: classification && classification.intent_id === "new_intent" ? classification.reason : "Low confidence in intent classification",
          origin: classification && classification.intent_id === "new_intent" && /ambiguous/i.test(classification.reason) ? "ambiguous-referent" : "unsupported-query"
        },
        label: null,
        because: "The system could not confidently map this request to a known intent.",
      };
    }

    const intentId = classification.intent_id;
    const target = classification.target;
    // Commit topic changes only after a grounded result succeeds.
    if (intentId === 32) {
      return { intent: { type: "zoom", direction: "out" }, label: null, because: "Return to the previous higher-level context." };
    }
    if (intentId === 33) {
      return { intent: { type: "overview" }, label: null, because: "Reset to the top-level architecture." };
    }
    return {
      intent: { type: "query", intentId, confidence: classification.confidence, ...(target ? { target } : {}) },
      label: null,
      because: `Matched intent ${intentId}: ${classification.intent}`,
    };
  }
  /** Chart focus contains source IDs only; labels and access are resolved again on the server. */
  focusConversation(ctx: CallContext, req: { sessionId: string; revision: string; chartCode?: string; form: string; entityIds?: string[] }): ApiResult<{seq:number}> {
    if(typeof req.sessionId !== "string" || !req.sessionId || typeof req.revision !== "string" || typeof req.form !== "string" || req.sessionId.length>120 || !Array.isArray(req.entityIds) || req.entityIds.length>80 || req.entityIds.some(id=>typeof id!=="string")) return fail(ctx,{code:"INVALID_SCHEMA",message:"Invalid chart context.",retryable:false});
    const rev=this.store.revision(req.revision);
    if(!rev) return fail(ctx,{code:"STALE_REVISION",message:"Chart revision is no longer available.",retryable:false});
    if(this.store.db.prepare("select 1 from conversation_actions where tenant_id=? and principal_id=? and session_id=? and state='pending'").get(ctx.actor.tenantId,ctx.actor.principalId,req.sessionId)) return fail(ctx,{code:"VERSION_CONFLICT",message:"Finish the current turn before changing conversation focus.",retryable:true});
    const descriptor=req.chartCode && Object.hasOwn(CHART_REGISTRY,req.chartCode) ? CHART_REGISTRY[req.chartCode as ChartId] : undefined;
    if(req.chartCode && (!descriptor || descriptor.form!==req.form)) return fail(ctx,{code:"INVALID_SCHEMA",message:"Chart context does not match its registered form.",retryable:false});
    const policy=policyFor(this.store,rev.repoRoot);
    const entities=this.store.entitiesById(rev.id,req.entityIds).filter(entity=>!policy.denied(entity.file));
    const session=this.svc.sessionManager.getSession(ctx,req.sessionId,rev.id);
    session.updateChart({revision:rev.id,chartCode:descriptor?.id,level:descriptor && ZOOM_LEVELS.some(row => (row.chartIds as readonly string[]).includes(descriptor.id)) ? zoomLevelOf(descriptor.id) : session.context.level,entities});
    return ok(ctx,{seq:session.session.seq},{revision:rev.id});
  }

  /** Read the caller's persisted conversation turns for restoring the chat panel. */
  conversation(ctx: CallContext, req: { sessionId: string }): ApiResult<{ sessionId: string; turns: { seq: number; role: "user" | "assistant"; text: string; at: string; validation?: AnswerValidationSummary }[] }> {
    const sessionId = typeof req.sessionId === "string" ? req.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 120) return fail(ctx, { code: "INVALID_SCHEMA", message: "a valid sessionId is required", retryable: false });
    const session = this.svc.sessionManager.getSession(ctx, sessionId);
    return ok(ctx, { sessionId, turns: session.turns.filter((turn) => turn.state === "complete").map(({ seq, role, text, at, validation }) => ({ seq, role, text, at, ...(validation ? { validation } : {}) })) });
  }
  /** Session-scoped entry point: persist the turn envelope before routing, then store its answer. */
  async converse(ctx: CallContext, req: { text: string; sessionId?: string; view?: ViewSpec | null; selection?: string[]; revision?: string; pins?: string[]; history?: { role: "user" | "assistant"; text: string }[] }): Promise<ApiResult<ConverseResult>> {
    return withDiagnostics({ requestId: ctx.requestId, traceId: ctx.traceId }, async () => {
      const started = performance.now();
      diagnostic("conversation.start", { question: req.text, revision: req.revision, sessionId: req.sessionId, historyTurns: req.history?.length ?? 0, currentView: req.view?.id });
      try {
        const result = await this.converseSession(ctx, req);
        if (result.ok && (result.value.kind === "view" || result.value.kind === "analysis")) {
          const views = result.value.kind === "view" ? [result.value.view] : result.value.results.flatMap((r) => r.view ? [r.view] : []);
          if (views.length) {
            const seeds = views.flatMap(v => typeof v.params?.answerEntityRefs === "string" ? v.params.answerEntityRefs.split("\n").filter(Boolean) : []);
            result.value.manifest = this.manifestFor(views, result.value.kind === "analysis" ? result.value.validation?.question ?? req.text : req.text, seeds.length ? { scope: "subject", seeds } : undefined, result.value.message);
          }
        }
        diagnostic("conversation.complete", { elapsedMs: performance.now() - started, ok: result.ok, ...(result.ok ? { kind: result.value.kind, message: result.value.message, metadata: result.metadata } : { error: result.error }) });
        return result;
      } catch (error) {
        diagnostic("conversation.exception", { elapsedMs: performance.now() - started, error }, "error");
        throw error;
      }
    });
  }

  private async converseSession(ctx: CallContext, req: { text: string; sessionId?: string; view?: ViewSpec | null; selection?: string[]; revision?: string; pins?: string[]; history?: { role: "user" | "assistant"; text: string }[] }): Promise<ApiResult<ConverseResult>> {
    const sessionId = req.sessionId?.trim() || ctx.actor.sessionId || ctx.idempotencyKey || ctx.requestId;
    if (!req.text?.trim() || req.text.length > 100_000 || sessionId.length > 120) return fail(ctx, {code:"INVALID_SCHEMA",message:"A bounded session ID and nonempty message are required.",retryable:false});
    if(ctx.deadlineMs <= Date.now()) return fail(ctx,{code:"DEADLINE_EXCEEDED",message:"This turn expired before it started.",retryable:true});
    const actions = new ConversationActions(this.store);
    let actionId: string;
    try {
      const revision = this.store.revision(req.revision ?? req.view?.revision ?? this.store.latestRevision()?.id ?? "");
      const action = actions.begin(ctx,sessionId,{req,access:{revision:revision?.id??null,denied:revision?this.store.deniedPrefixes(revision.repoRoot):[]}});
      if (action.replay) return action.replay as ApiResult<ConverseResult>;
      actionId=action.actionId;
    } catch(error) {
      if(error instanceof ConversationConflict) return fail(ctx,{code:"VERSION_CONFLICT",message:error.message,retryable:error.retryable});
      throw error;
    }
    try {
    this.svc.sessionManager.forget(ctx,sessionId);
    this.svc.sessionManager.bindTurn(ctx);
    const session = this.svc.sessionManager.getSession(ctx, sessionId, req.revision ?? req.view?.revision);
    const normalized = (req.text ?? "").trim();
    if (normalized && normalized.length <= 100_000) session.appendTurn("user", normalized, undefined, "pending");
    const result = await this.converseInternal(ctx, { ...req, sessionId });
    if (!result.ok) { actions.abort(ctx,sessionId,actionId); this.svc.sessionManager.forget(ctx,sessionId); return result; }
    actions.finish(ctx,sessionId,actionId,result,() => {
      session.completePending();
      const answer = result.value.message;
      const chartCode = result.value.kind === "view" && typeof result.value.view.params?.chartId === "string" ? result.value.view.params.chartId : undefined;
      session.appendTurn("assistant", answer, chartCode, "complete", result.value.kind === "analysis" && result.value.validation ? summarizeValidation(result.value.validation) : undefined);
      const activeView = result.value.kind === "view" ? result.value.view
        : result.value.kind === "analysis" ? result.value.results.findLast((x) => x.view)?.view
        : undefined;
      if (activeView) {
        const revision = this.store.revision(activeView.revision);
        const mentions = revision ? resolveMentions(this.store, activeView.revision, normalized, policyFor(this.store, revision.repoRoot)) : { resolved: [], unresolved: [] };
        const uniqueMention = mentions.resolved.length === 1 && mentions.resolved[0]!.matches.length === 1 ? mentions.resolved[0]!.matches[0] : undefined;
        if (uniqueMention) session.transitionContext(uniqueMention.name, 0);
        session.updateView(activeView, uniqueMention?.name);
      }
    });
    return result;
    } catch(error) {
      actions.abort(ctx,sessionId,actionId); this.svc.sessionManager.forget(ctx,sessionId);
      if(error instanceof ConversationConflict) return fail(ctx,{code:"VERSION_CONFLICT",message:error.message,retryable:error.retryable});
      throw error;
    }
  }

  /** One text box: new question, trace → investigation, steering, "why …", or resume. Selection chips are referents. */
  private async converseInternal(ctx: CallContext, req: { text: string; sessionId?: string; view?: ViewSpec | null; selection?: string[]; revision?: string; pins?: string[]; history?: { role: "user" | "assistant"; text: string }[] }): Promise<ApiResult<ConverseResult>> {
    const text = (req.text ?? "").trim();
    if (!text) return fail(ctx, { code: "INVALID_SCHEMA", message: "say something", retryable: false });
    if (text.length > 100_000) return fail(ctx, { code: "INVALID_SCHEMA", message: "message is too long", retryable: false });
    const view = req.view ?? null;
    const revision = req.revision ?? view?.revision;
    const indexed = revision ? this.store.revision(revision) : this.store.latestRevision();
    // Deterministic enumerate answering: "how many X / what X / list X" questions whose subject resolves to an
    // indexed container (file, class, interface, enum) are answered from one relationship lookup, each member
    // verified against the live index — no model call, no tool-calling budget. Falls through untouched otherwise.
    if (indexed && /\b(how many|what are|which|list)\b/i.test(text)) {
      const access = policyFor(this.store, indexed.repoRoot);
      const mentions = resolveMentions(this.store, indexed.id, text, access);
      const container = mentions.resolved.flatMap((m) => m.matches).find((m) => ["file", "class", "interface", "enum"].includes(m.kind));
      if (container) {
        const claims = claimsFromContainer(this.store, indexed.id, container.entityId);
        if (claims.length) {
          const verifications = verifyClaims(this.store, claims);
          const answerText = renderEnumeration(container.name, claims, verifications, (id) => this.store.entitiesById(indexed.id, [id])[0]?.kind);
          return deterministicResult(ctx, this.store, indexed.id, text, indexed.repoRoot.split("/").filter(Boolean).pop() ?? "repository", answerText, claims, verifications);
        }
      }
    }
    // Deterministic locate answering: "where is X defined/located/implemented" questions whose subject resolves to
    // exactly one indexed entity are answered from that entity's own span — no model call.
    if (indexed && /\bwhere (is|are|does)\b/i.test(text)) {
      const access = policyFor(this.store, indexed.repoRoot);
      const mentions = resolveMentions(this.store, indexed.id, text, access);
      const matches = mentions.resolved.flatMap((m) => m.matches);
      if (matches.length === 1) {
        const claims = claimsFromLocate(this.store, indexed.id, matches[0].entityId);
        if (claims.length) {
          const verifications = verifyClaims(this.store, claims);
          const answerText = renderLocation(matches[0], verifications);
          return deterministicResult(ctx, this.store, indexed.id, text, indexed.repoRoot.split("/").filter(Boolean).pop() ?? "repository", answerText, claims, verifications);
        }
      }
    }
    const resumeMatch = /^continue investigation ([a-zA-Z0-9:_-]{1,120})$/i.exec(text);
    if (resumeMatch) {
      const sessionId = req.sessionId?.trim() || ctx.actor.sessionId || ctx.idempotencyKey || ctx.requestId;
      const saved = this.store.db.prepare(`select response_json from conversation_actions where tenant_id=? and principal_id=? and session_id=? and state='complete' and json_extract(response_json,'$.value.validation.investigation.id')=? limit 1`)
        .get(ctx.actor.tenantId, ctx.actor.principalId, sessionId, resumeMatch[1]) as { response_json: string } | undefined;
      const checkpoint = saved ? (JSON.parse(saved.response_json) as { value: { validation?: { investigation?: AnswerInvestigation } } }).value.validation?.investigation : undefined;
      if (!checkpoint) return fail(ctx, { code: "NOT_FOUND", message: "This saved investigation is not available in this conversation.", retryable: false });
      if (!indexed) return fail(ctx, { code: "STALE_REVISION", message: "The indexed revision changed; ask the original question again to collect fresh evidence.", retryable: false });
      const { checkpoint: resumeCheckpoint, dropped } = remapCheckpointAcrossRevision(this.svc, checkpoint, indexed.id);
      if (!resumeCheckpoint.inspectedIds.length) return fail(ctx, { code: "STALE_REVISION", message: "None of the previously inspected elements survived re-indexing; start a fresh investigation.", retryable: false });
      const access = policyFor(this.store, indexed.repoRoot);
      const entities = this.store.entitiesById(indexed.id, resumeCheckpoint.inspectedIds);
      if (entities.length !== resumeCheckpoint.inspectedIds.length) return fail(ctx, { code: "STALE_REVISION", message: "An inspected element is no longer indexed; start a fresh investigation.", retryable: false });
      if (entities.some(e => access.denied(e.file))) return fail(ctx, { code: "FORBIDDEN", message: "Source access changed; start a fresh investigation with permitted evidence.", retryable: false });
      for (const [id, expected] of Object.entries(resumeCheckpoint.sourceHashes)) {
        const entity = entities.find(e => e.entityId === id), source = entity?.spans[0]?.sourceId;
        if (!source) return fail(ctx, { code: "STALE_REVISION", message: "An inspected source is no longer available; re-index and ask again.", retryable: false });
        try {
          const path = realpathSync(resolve(indexed.repoRoot, source)), rel = relative(realpathSync(indexed.repoRoot), path);
          if (access.denied(rel)) return fail(ctx, { code: "FORBIDDEN", message: "Source access changed; start a fresh investigation with permitted evidence.", retryable: false });
          if (rel.startsWith("..") || isAbsolute(rel) || createHash("sha256").update(readFileSync(path)).digest("hex") !== expected) throw new Error("stale source");
        } catch { return fail(ctx, { code: "STALE_REVISION", message: "Inspected source changed; re-index and ask the original question again.", retryable: false }); }
      }
      if (!this.svc.router?.converse) return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: "A tool-calling model is required to continue this investigation.", retryable: true });
      const answered = await runChatAgent(this.svc, ctx, indexed, this.svc.router, { text: resumeCheckpoint.question, history: [], resume: resumeCheckpoint, pins: req.pins });
      if (answered?.ok && dropped) return { ...answered, metadata: { ...answered.metadata, warnings: [...answered.metadata.warnings, `${dropped} previously inspected element(s) did not survive re-indexing and were dropped from this resumed investigation.`] } };
      return answered ?? fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: "The model could not continue this investigation.", retryable: true });
    }
    if (indexed) {
      const required = conceptRequirement(this.store, indexed.id);
      if (required) return ok(ctx, { kind: "message", message: required }, { revision: indexed.id });
      const hierarchy = navigateHierarchy(this.store, indexed.id, text, req.pins);
      diagnostic("conversation.hierarchy", { requestId: ctx.requestId, revision: indexed.id, hierarchyLevel: hierarchy.level,
        seeds: hierarchy.seeds, conceptIds: hierarchy.conceptIds, nodes: hierarchy.nodes });
    }
    if(indexed && parseCompoundQuestion(text)){
      const result=await this.ask(ctx,{question:text,revision:indexed.id,chartCode:explicitChartCode(text)??"S21",pins:req.pins});
      return result.ok ? ok(ctx,{kind:"view",view:result.value.view,claims:result.value.claims,manifest:result.value.manifest,message:result.value.view.answer??""},result.metadata) : result;
    }
    const chartCode = explicitChartCode(text);
    if (chartCode === "S16") process.stderr.write(`[uml] ${JSON.stringify({ stage: "dispatch", requestId: ctx.requestId, route: "chart", chartId: chartCode })}\n`);
    // Resolve referents (it, this, that) using the session's referent ledger.
    const session = this.svc.sessionManager.getSession(ctx, req.sessionId, revision);
    const resolvedReferent = resolveReferent(text, session.referentLedger, view, req.selection);
    if (resolvedReferent && resolvedReferent !== "ambiguous") {
      session.updateFocus(resolvedReferent);
    }


    const nodeById = new Map((view?.nodes ?? []).map((n) => [n.id, n]));
    const selected = (req.selection ?? []).map((id) => nodeById.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
    const referentCount = selected.length || (req.pins?.length ?? 0);

    let plannerWarning: string | undefined;
    const chartName = chartCode ? CHART_REGISTRY[chartCode as ChartId].name : "Generated chart";
    const chartRoute = chartCode ? {
      ...this.chosenRoute(CHART_REGISTRY[chartCode as ChartId].form), source: "similarity" as const, confidence: "high" as const,
      name: chartName, because: `The question explicitly asks for a ${chartName.toLowerCase()}.`,
    } : undefined;
    const reading = chartRoute
      ? { intent: { type: "ask" as const, route: chartRoute }, label: "GeneratedChart", because: chartRoute.because }
      : await this.classifyIntent(ctx, text, view, selected, req.sessionId, revision);
    const intent = reading.intent;
    diagnostic("conversation.route", { requestId: ctx.requestId, revision, question: text, explicitChartCode: chartCode, reading, selected: selected.map((n) => n.id), pins: req.pins, resolvedReferent });

    const entityIds = selected.flatMap((n) => n.entityRefs);
    // A steering turn adjusts the current view, so it does not repeat why that kind of view was chosen.
    const asView = (r: ApiResult<{ view: ViewSpec; claims: Claim[] }>, lead: string, steering = false): ApiResult<ConverseResult> => {
      if (!r.ok) return r as ApiResult<never>;
      const { message, thinking } = viewMessage(r.value.view, lead, steering);
      return ok(ctx, { kind: "view", view: r.value.view, claims: r.value.claims, message, ...(thinking ? { thinking } : {}) }, { ...r.metadata, warnings: [...r.metadata.warnings, ...(plannerWarning ? [plannerWarning] : [])] });
    };
    const asExplain = (r: ApiResult<ExplainResult>, lead = ""): ApiResult<ConverseResult> =>
      r.ok ? ok(ctx, { kind: "explanation", explanation: r.value, message: `${lead}${r.value.summary}`.trim() }, r.metadata) : (r as ApiResult<never>);
    const needsView = () => fail<ConverseResult>(ctx, { code: "INVALID_SCHEMA", message: "Ask a question first, then I can talk about what's on the map.", retryable: false });

    // The conversational agent runs on the legacy single-view route, and also as the fallback when
    // classification couldn't confidently map the question to one of the fixed intents: confidence
    // should only decide which specialized chart renders, never whether an answer is attempted at all.
    // A classified query reaches its selected chart branch below and cannot be replaced by an agent-built map.
    if ((intent.type === "ask" || intent.type === "newIntent") && !chartCode && (this.svc.router?.converse || this.svc.router?.plan) && !looksLikeTrace(text)) {
      const rev = revision ? this.store.revision(revision) : this.store.latestRevision();
      if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
      const history = session.turns.filter((turn) => turn.seq > session.context.openedAtSeq && (turn.role === "user" || turn.role === "assistant")).slice(0, -1).slice(-6).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 1500) }));
      const files = [...new Set(selected.map((n) => n.file).filter(Boolean))];
      const subject = files.length === 1 ? files[0] : typeof view?.params?.chatSubject === "string" ? view.params.chatSubject : view?.formId === "TestConfidence" && typeof view.params?.subject === "string" ? view.params.subject : undefined;
      // The chat agent and the legacy planner both only ever see the first CHAT_QUESTION_MAX_CHARS of the question
      // (the 100,000-char ceiling above is a separate, much larger request-validation limit). That truncation used to
      // be silent; it is now reported back as an explicit warning whenever it actually happens.
      const truncated = text.length > CHAT_QUESTION_MAX_CHARS;
      const truncationWarning = `The question was truncated to the first ${CHAT_QUESTION_MAX_CHARS} characters before being answered.`;
      if (this.svc.router.converse) {
        const answered = await runChatAgent(this.svc, ctx, rev, this.svc.router, { text: text.slice(0, CHAT_QUESTION_MAX_CHARS), history, subject, pins: req.pins });
        if (answered) return truncated && answered.ok ? { ...answered, metadata: { ...answered.metadata, warnings: [...answered.metadata.warnings, truncationWarning] } } : answered;
      } else if (this.svc.router?.plan) {
        try {
          const plan = validateChatPlan(await this.svc.router.plan({ text: text.slice(0, CHAT_QUESTION_MAX_CHARS), history, subject }));
          if (plan?.steps.length) {
            const executed = await executeChatPlan(this.svc, ctx, rev, plan, subject, req.pins);
            return truncated && executed.ok ? { ...executed, metadata: { ...executed.metadata, warnings: [...executed.metadata.warnings, truncationWarning] } } : executed;
          }
          if (!plan) plannerWarning = "The multi-step planner did not return a valid plan; only the single-question route was attempted.";
        } catch { plannerWarning = "The multi-step planner did not return a valid plan; only the single-question route was attempted."; }
      }
    }

    const overview = async (lead: string, question = text): Promise<ApiResult<ConverseResult>> => {
        const rev = revision ? this.store.revision(revision) : this.store.latestRevision();
        if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
        const r = await this.ask(ctx, { question: question || "Give me an overview of the whole project", revision: rev.id, overview: true, form: "SemanticMap", level: 1 });
        const profile = projectProfile(this.store, rev.id);
        if (r.ok) r.value.view.formReason = "Representative code across languages and source modules, grouped by responsibility. Zoom in for detail.";
        // The profile paragraph is inserted into the answer exactly once; it is not also repeated into gaps or the lead
        // (gaps is for genuine limitations, and the lead is this turn's own short notice, kept separate per viewMessage).
        if (r.ok) r.value.view.answer = redactBuilt(this.store, rev, { view: { ...r.value.view, answer: [r.value.view.answer, profile.text].filter(Boolean).join("\n\n") }, claims: [] }).view.answer;
        return asView(r, lead);
    };
    switch (intent.type) {
      case "query": {
        const rev = revision ? this.store.revision(revision) : this.store.latestRevision();
        if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
        const mentions = resolveMentions(this.store, rev.id, text, policyFor(this.store, rev.repoRoot));
        const plan = planQuery(intent.intentId, intent.target, text, mentions);
        if (!plan) return ok(ctx, { kind: "message", message: `I couldn't resolve the requested subject${intent.target ? ` “${intent.target}”` : ""} in the indexed repository.` });
        diagnostic("query.plan", { requestId: ctx.requestId, revision: rev.id, plan, overview: plan.scope === "repository", mentions });
        session.setSubject(plan.subject);
        const r = await this.ask(ctx, { question: plan.question, revision: rev.id, pins: req.pins, scope: plan.scope, overview: plan.scope === "repository", seeds: plan.seeds, ...(plan.subject ? { subject: plan.subject } : {}), ...(plan.chartCode ? { chartCode: plan.chartCode } : {}), ...(plan.form ? { form: plan.form } : {}) });
        return asView(r, "");
      }
      case "newIntent":
        return ok(ctx, { kind: "message", message: `${intent.detected}: ${intent.reason}` });
      case "mapCommand": {
        const legacy = await readText(this.svc.router, text, { hasView: !!view, viewForm: view?.formId, selectionCount: referentCount, looksLikeTrace: false });
        if (legacy.intent.type === "ask") return asView(await this.ask(ctx, { question: text, revision, pins: req.pins, route: legacy.intent.route }), "");
        return ok(ctx, { kind: "message", message: `Map command “${intent.label}” could not be applied to the current view.` });
      }
      case "investigate": return asView(await this.investigate(ctx, { trace: text, revision }), "Investigating the exception you pasted.");
      case "overview": return overview("You asked about the project as a whole.");
      case "ask": {
        if (indexed && !chartCode && !req.pins?.length && navigateHierarchy(this.store, indexed.id, text).level === "repository" && !/\b(project|repository|repo|system|codebase|architecture|overview)\b/i.test(text)) {
          const terms = queryTerms(text), access = policyFor(this.store, indexed.repoRoot);
          const matches = this.store.entities(indexed.id).some((e) => !access.denied(e.file) && terms.some((term) => `${e.name} ${e.file}`.toLowerCase().includes(term)));
          if (!matches) return overview("No element of the code matches those words, so here is the project as a whole instead. Name a feature, module or function for something specific.");
        }
        const r = await this.ask(ctx, { question: text, revision, pins: req.pins, route: intent.route, ...(chartCode ? { chartCode } : {}) });
        // Nothing matched any word in the question: say so, and show the project instead of an empty map.
        if (!chartCode && r.ok && r.value.view.nodes.length === 0 && !(req.pins?.length)) return overview("No element of the code matches those words, so here is the project as a whole instead. Name a feature, module or function for something specific.");
        return asView(r, "");
      }
      case "resume": {
        const list = this.svc.listWorkspaces(ctx);
        const hit = list.ok ? matchName(intent.name, list.value) : null;
        if (!hit) return ok(ctx, { kind: "message", message: intent.name ? `I couldn't find a saved investigation matching “${intent.name}”.` : "There are no saved investigations yet." });
        return ok(ctx, { kind: "resume", workspaceId: hit.id, message: `Resuming “${hit.name}”…` });
      }
      case "zoom": {
        if (!view) return needsView();
        const session = this.svc.sessionManager.getSession(ctx, req.sessionId, revision);
        const zoomResult = session.zoom(intent.direction, view);

        return ok(ctx, {
          kind: "zoom",
          direction: intent.direction,
          message: zoomResult.message,
          breadcrumbs: zoomResult.breadcrumbs
        });
      }

      case "whyShown": {
        if (!view) return needsView();
        return asExplain(this.whyShown(ctx, { view, nodeId: selected[0].id }), `About “${selected[0].label}”: `);
      }
      case "whyHidden": return view ? asExplain(this.whyHidden(ctx, { view, query: intent.target })) : needsView();
      case "whySuspect": return view ? asExplain(this.whySuspect(ctx, { view, target: intent.target || selected[0]?.label || "" })) : needsView();
      case "pin": case "unpin": case "boost": case "demote": {
        if (!view || !revision) return needsView();
        const want = intent.target.toLowerCase();
        const pool = selected.length && !want ? selected.map((n) => ({ id: n.entityRefs[0], label: n.label })) : this.store.entities(revision).filter((e) => e.kind !== "file" && e.kind !== "test" && (e.name.toLowerCase() === want || e.name.toLowerCase().endsWith("." + want) || e.name.toLowerCase().includes(want))).map((e) => ({ id: e.entityId, label: e.name }));
        const exact = pool.find((p) => p.label.toLowerCase() === want || p.label.toLowerCase().endsWith("." + want)) ?? pool[0];
        // "reset password flow" is a question, not a command, when no element is named like that.
        if (!exact) return asView(await this.ask(ctx, { question: text, revision, pins: req.pins }), "");
        const mode = intent.type === "unpin" ? null : intent.type;
        const set = this.svc.setOverride(ctx, { revision, entityId: exact.id, mode });
        if (!set.ok) return set as ApiResult<never>;
        const refreshed = await this.refreshView(ctx, { view });
        const verb = { pin: `Pinned ${exact.label}: it will always be shown.`, unpin: `Reset ${exact.label} to its computed relevance.`, boost: `Boosted ${exact.label}: it ranks higher.`, demote: `Demoted ${exact.label}: it ranks lower.` }[intent.type];
        return asView(refreshed, verb, true);
      }
      case "ignore": case "restore": {
        if (!view) return needsView();
        const want = intent.target.toLowerCase();
        const pool = intent.type === "ignore" ? view.nodes.filter((n) => n.role === "suspect") : (view.ignored ?? []).map((id) => ({ entityRefs: [id], label: id.replace(/^.*#/, ""), id }));
        const hit = pool.find((n) => n.label.toLowerCase().includes(want) || n.entityRefs[0]?.toLowerCase().includes(want));
        if (!hit) return ok(ctx, { kind: "message", message: `I couldn't find “${intent.target}” among the ${intent.type === "ignore" ? "suspects" : "ignored items"}.` });
        const r = this.steer(ctx, { view, action: intent.type === "ignore" ? "IGNORE" : "RESTORE", entityId: hit.entityRefs[0] });
        return asView(r, intent.type === "ignore" ? `Ignoring ${hit.label}; re-ranked the remaining suspects.` : `Restored ${hit.label}.`, true);
      }
      case "connected": {
        if (!revision) return needsView();
        const ids = entityIds.length ? entityIds : (req.pins ?? []);
        if (ids.length === 0) return ok(ctx, { kind: "message", message: "Select the elements you mean on the map first; then I can say how they relate." });
        return asExplain(await this.explain(ctx, { revision, entityIds: ids, question: text }));
      }
    }
  }
}
