// Orchestration. Public operations return ApiResult (contracts §1). Every model call goes through callModel,
// which enforces the per-repository egress opt-in, scrubs secrets, and writes the audit trail.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runModel, StubProvider, type GatewayFailure, type GatewayResult } from "@cie/model";
import type {
  ApiError, ApiResult, CallContext, ChallengeOutput, ChangesSince, Claim, ConceptCard, ConceptStore, ConceptsOutput, ConverseResult, DirListing, EditorContext, EditorEvent, EvidenceRef, ExplainResult, ExplanationOutput,
  ModelProvider, ModelRequest, RepresentationOutput, ResolvedEvidence, SavedState, VerdictKind, ViewSpec,
} from "@cie/schema";
import { SCHEMA_CHALLENGE, SCHEMA_CONCEPTS, SCHEMA_EXPLANATION, SCHEMA_REPRESENTATION } from "@cie/schema";
import { applyVerdict, gateClaim, wilson, withChallenge } from "./claims.ts";
import { cardsFromOutput, chunkSymbols } from "./concepts.ts";
import { buildFailureGraph, buildInvariantGraph } from "./forms/causal.ts";
import { buildHypothesis } from "./forms/hypothesis.ts";
import { Journal, type CommitReceipt } from "./journal.ts";
import { EGRESS_FIELDS, payloadHash, scrubBundle } from "./policy.ts";
import { bundleFor, retrieveAround, retrieveForQuestion } from "./retrieval.ts";
import { chooseForm, matchName, routeIntent } from "./router.ts";
import { revisionIndex, scoreEntity, WEIGHTS } from "./salience.ts";
import type { RevisionRow, Store } from "./store.ts";
import { entityAt, fingerprint, locateFrames, looksLikeTrace, parseTrace } from "./trace.ts";
import { compileView } from "./viewspec.ts";
import { catalog, ensureEdgeClaims, matchVisual, visualByForm, type CatalogEntry } from "./visuals.ts";
import { isGitRepo } from "./gitinfo.ts";
import { ingestTestArtifacts, loadTestSummary, type TestSummary } from "./testartifacts.ts";
import type { WorkerClient } from "./worker.ts";
import { WorkerError } from "./worker.ts";

function safeIsDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

const meta = (ctx: CallContext, o: Partial<{ revision: string; resourceVersion: number; completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; warnings: string[] }> = {}) =>
  ({ requestId: ctx.requestId, completeness: "COMPLETE" as const, warnings: [] as string[], ...o });
const fail = <T>(ctx: CallContext, error: ApiError): ApiResult<T> => ({ ok: false, error, metadata: meta(ctx) });
const ok = <T>(ctx: CallContext, value: T, m: Parameters<typeof meta>[1] = {}): ApiResult<T> => ({ ok: true, value, metadata: meta(ctx, m) });
const actor = (ctx: CallContext) => ctx.actor.principalId;

export class Service {
  readonly journal: Journal;
  readonly store: Store;
  private worker: WorkerClient;
  private model: ModelProvider;
  private offline: ModelProvider;

  constructor(store: Store, worker: WorkerClient, model: ModelProvider, offline: ModelProvider = new StubProvider()) {
    this.store = store; this.worker = worker; this.model = model; this.offline = offline;
    this.journal = new Journal(store);
  }

  // ---------------------------------------------------------------- model gateway with egress control
  private async callModel<T>(ctx: CallContext, rev: RevisionRow, req: ModelRequest): Promise<{ result: GatewayResult<T> | GatewayFailure; provider: ModelProvider; note?: string }> {
    let provider = this.model, note: string | undefined, request = req;
    if (provider.hosted) {
      if (!this.store.allowHosted(rev.repoRoot)) {
        provider = this.offline;
        note = "Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.";
        this.store.audit(actor(ctx), "egress.denied", rev.repoRoot, { purpose: req.purpose, destination: `${this.model.name}/${this.model.model}` });
      } else {
        const scrub = scrubBundle(req.bundle);
        request = { ...req, bundle: scrub.bundle };
        this.store.audit(actor(ctx), "egress.approved", rev.repoRoot, {
          purpose: req.purpose, destination: `${provider.name}/${provider.model}`, payloadHash: payloadHash(scrub.bundle), fields: EGRESS_FIELDS, redactions: scrub.removed.length, minimized: scrub.minimized,
        });
        if (scrub.removed.length) note = `${scrub.removed.length} element(s) that looked like secrets were removed before sending.`;
        // History facts (authors, messages, commit ids) are dropped by the scrubber and reported only in the audit trail.
      }
    }
    const result = await runModel<T>(provider, request, { deadlineMs: Math.max(1000, ctx.deadlineMs - Date.now()) });
    return { result, provider, note };
  }

  private persist(claims: Claim[]) { for (const c of claims) this.store.putClaim(c); }

  // ---------------------------------------------------------------- repository
  async ingestRepository(ctx: CallContext, req: { repoPath: string }): Promise<ApiResult<RevisionRow>> {
    if (!req.repoPath || !isAbsolute(req.repoPath)) return fail(ctx, { code: "INVALID_SCHEMA", message: "repoPath must be an absolute path", retryable: false });
    try {
      const batch = await this.worker.index(req.repoPath);
      const row = this.store.putBatch(batch);
      this.store.audit(actor(ctx), "repo.ingest", row.repoRoot, { revision: row.id, files: row.fileCount });
      const tests = ingestTestArtifacts(this.store, row);
      const warnings = batch.diagnostics.map((d) => d.message);
      if (tests) warnings.push(`Loaded test artifacts (${tests.found.join(", ")}): ${tests.tests.passed} passed, ${tests.tests.failed} failed${tests.coverageLinePercent !== null ? `, ${tests.coverageLinePercent}% line coverage` : ""}.`, ...tests.staleness.map((x) => `Test data may be out of date: ${x}`));
      return ok(ctx, row, { revision: row.id, warnings, completeness: batch.diagnostics.length ? "PARTIAL" : "COMPLETE" });
    } catch (e) {
      return fail(ctx, e instanceof WorkerError ? e.api : { code: "STORAGE_FAILURE", message: (e as Error).message, retryable: true });
    }
  }

  /** Directory names only (never file contents) so the UI can offer a folder picker. Loopback-only gateway. */
  browseDirectory(ctx: CallContext, req: { path?: string }): ApiResult<DirListing> {
    const want = req.path?.trim() || homedir();
    if (!isAbsolute(want)) return fail(ctx, { code: "INVALID_SCHEMA", message: "path must be absolute", retryable: false });
    let path: string;
    try {
      path = realpathSync(want);
      if (!statSync(path).isDirectory()) return fail(ctx, { code: "INVALID_SCHEMA", message: "not a directory", retryable: false });
    } catch { return fail(ctx, { code: "NOT_FOUND", message: "directory not found", retryable: false }); }
    const MAX = 500;
    let names: import("node:fs").Dirent[];
    try { names = readdirSync(path, { withFileTypes: true }); } catch { return fail(ctx, { code: "FORBIDDEN", message: "cannot read directory", retryable: false }); }
    const dirs = names
      .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && safeIsDir(join(path, d.name)))) && !d.name.startsWith(".") && d.name !== "node_modules")
      .sort((a, b) => a.name.localeCompare(b.name));
    const entries = dirs.slice(0, MAX).map((d) => ({ name: d.name, path: join(path, d.name), isGitRepo: existsSync(join(path, d.name, ".git")) }));
    const parent = dirname(path);
    return ok(ctx, { path, parent: parent === path ? null : parent, entries, truncated: dirs.length > MAX });
  }

  /** C01: an IDE event. Only path + line numbers are accepted; they resolve to entity ids and nothing else is stored. */
  captureEditorEvent(ctx: CallContext, req: { event: EditorEvent }): ApiResult<{ accepted: boolean; stale?: boolean; entities: string[]; indexed: boolean }> {
    const e = req.event;
    const kinds = ["OPEN_FILE", "SELECTION", "DIFF", "BREAKPOINT"];
    if (!e || !kinds.includes(e.kind) || typeof e.file !== "string" || !isAbsolute(e.file) || !Number.isInteger(e.sequence) || !e.sessionId) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: "event needs sessionId, integer sequence, a known kind and an absolute file path", retryable: false });
    }
    // Stale or reordered events are dropped, never applied over newer ones.
    if (e.sequence <= this.store.lastClientSeq(e.sessionId)) return ok(ctx, { accepted: false, stale: true, entities: [], indexed: true });
    const root = e.file;
    const rev = this.store.allRevisionRoots().filter((r) => root === r.repoRoot || root.startsWith(r.repoRoot + "/")).sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
    if (!rev) { this.store.addContextEvent({ session: e.sessionId, clientSeq: e.sequence, kind: e.kind, revision: "", file: e.file, entities: [], lineStart: null, lineEnd: null }); return ok(ctx, { accepted: true, entities: [], indexed: false }); }
    const full = this.store.revision(rev.id)!;
    const rel = e.file.slice(full.repoRoot.length + 1);
    const lines = e.kind === "OPEN_FILE" ? [] : [e.startLine, e.endLine ?? e.startLine].filter((n): n is number => Number.isInteger(n) && n! > 0);
    const entities = [...new Set(lines.flatMap((l) => { const id = entityAt(this.store, full, rel, l); return id ? [id] : []; }))];
    this.store.addContextEvent({ session: e.sessionId, clientSeq: e.sequence, kind: e.kind, revision: full.id, file: rel, entities, lineStart: lines[0] ?? null, lineEnd: lines[1] ?? null });
    return ok(ctx, { accepted: true, entities, indexed: true }, { revision: full.id });
  }

  editorContext(ctx: CallContext, req: { revision?: string }): ApiResult<EditorContext> {
    const rev = req.revision ?? this.store.latestRevision()?.id;
    const events = this.store.recentContext(20).filter((e) => !rev || e.revision === rev || e.revision === "");
    const names = new Map(rev ? this.store.entities(rev).map((x) => [x.entityId, x.name]) : []);
    const focus: EditorContext["focus"] = [];
    for (const ev of events) if (ev.kind === "SELECTION" || ev.kind === "BREAKPOINT") for (const id of ev.entities) if (!focus.some((f) => f.entityId === id) && names.has(id)) focus.push({ entityId: id, label: names.get(id)! });
    return ok(ctx, { events: events.map(({ seq, kind, file, entities, lineStart, lineEnd, ts }) => ({ seq, kind: kind as EditorContext["events"][number]["kind"], file, entities, lineStart, lineEnd, ts })), focus: focus.slice(0, 6) });
  }

  /** C24: a running app (or you) reports an exception. Stored as an observation; grouped by fingerprint so a loop is one entry with a count. */
  reportException(ctx: CallContext, req: { trace?: string; error?: { name?: string; message?: string; stack?: string }; source?: string }): ApiResult<{ id: string; count: number; isNew: boolean; inRepo: boolean; errorClass: string | null }> {
    const fromError = (e: { name?: string; message?: string; stack?: string }) => {
      const head = `${e.name ?? "Error"}: ${e.message ?? ""}`.trimEnd();
      const stack = e.stack ?? "";
      // V8 stacks already begin with the heading; do not repeat it, but keep the message if the stack's own heading lost it.
      return stack.startsWith(e.name ?? "Error") ? (e.message === "" ? `${head}\n${stack.split("\n").slice(1).join("\n")}` : stack) : `${head}\n${stack}`;
    };
    const text = (req.trace ?? (req.error ? fromError(req.error) : "")).slice(0, 30_000);
    const parsed = parseTrace(text);
    if (parsed.frames.length === 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "no stack frames found in the report", retryable: false });
    const rev = this.store.latestRevision();
    const inRepo = !!rev && locateFrames(this.store, rev, parsed).some((f) => f.file);
    const r = this.store.addException({ id: `exc:${randomUUID()}`, fingerprint: fingerprint(parsed), errorClass: parsed.errorClass ?? "Error", message: parsed.message.slice(0, 300), trace: text, source: (req.source ?? "report").slice(0, 60) });
    this.store.audit(actor(ctx), "exception.report", r.id, { errorClass: parsed.errorClass, frames: parsed.frames.length, inRepo, source: req.source ?? "report" });
    return ok(ctx, { ...r, inRepo, errorClass: parsed.errorClass });
  }

  listExceptions(ctx: CallContext, req: { includeDismissed?: boolean }): ApiResult<ReturnType<Store["exceptions"]>> {
    return ok(ctx, this.store.exceptions(!!req.includeDismissed));
  }

  dismissException(ctx: CallContext, req: { id: string }): ApiResult<{ dismissed: boolean }> {
    const done = this.store.dismissException(req.id);
    if (done) this.store.audit(actor(ctx), "exception.dismiss", req.id);
    return done ? ok(ctx, { dismissed: true }) : fail(ctx, { code: "NOT_FOUND", message: "no such exception", retryable: false });
  }

  status(ctx: CallContext, req: { revision?: string }): ApiResult<{ revision: RevisionRow | null; provider: string; hosted: boolean; allowHosted: boolean; concepts: number; tests: TestSummary | null }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return ok(ctx, {
      revision: rev, provider: `${this.model.name}/${this.model.model}`, hosted: this.model.hosted,
      allowHosted: rev ? this.store.allowHosted(rev.repoRoot) : false, concepts: rev ? this.store.concepts(rev.id).length : 0,
      tests: rev ? loadTestSummary(this.store, rev.repoRoot) : null,
    }, rev ? { revision: rev.id } : {});
  }

  setEgress(ctx: CallContext, req: { repoRoot: string; allow: boolean }): ApiResult<{ repoRoot: string; allowHosted: boolean }> {
    if (!req.repoRoot || !this.store.latestRevision(req.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: "unknown repository; index it first", retryable: false });
    this.store.setAllowHosted(req.repoRoot, !!req.allow);
    this.store.audit(actor(ctx), req.allow ? "egress.policy.allow" : "egress.policy.deny", req.repoRoot, { destination: `${this.model.name}/${this.model.model}`, fields: EGRESS_FIELDS });
    return ok(ctx, { repoRoot: req.repoRoot, allowHosted: !!req.allow });
  }

  auditLog(ctx: CallContext, req: { limit?: number }): ApiResult<{ events: unknown[]; chain: { ok: boolean; brokenAt?: number } }> {
    return ok(ctx, { events: this.store.auditEvents(Math.min(req.limit ?? 100, 500)), chain: this.store.verifyAuditChain() });
  }

  // ---------------------------------------------------------------- concept cards
  async extractConcepts(ctx: CallContext, req: { revision?: string }): Promise<ApiResult<{ cards: ConceptCard[]; dropped: string[]; provider: string }>> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const all: ConceptCard[] = [], dropped: string[] = [], warnings: string[] = [];
    let providerName = `${this.model.name}/${this.model.model}`;
    for (const ids of chunkSymbols(this.store, rev.id)) {
      const bundle = bundleFor(this.store, rev.id, ids, ["concept extraction"]);
      const { result, provider, note } = await this.callModel<ConceptsOutput>(ctx, rev, { purpose: "EXTRACT", schemaId: SCHEMA_CONCEPTS, question: "Extract concept cards", bundle });
      if (note && !warnings.includes(note)) warnings.push(note);
      providerName = `${provider.name}/${provider.model}`;
      if (!result.ok) { warnings.push(`extraction failed for a chunk (${result.error.code})`); continue; }
      const out = cardsFromOutput(this.store, rev.id, result.value, bundle, providerName, result.run);
      this.persist(out.claims);
      all.push(...out.cards); dropped.push(...out.dropped);
    }
    // Same-titled cards from different chunks collapse to one.
    const unique = [...new Map(all.map((c) => [c.id, c])).values()];
    const version = this.store.replaceConcepts(rev.id, unique, providerName);
    this.store.audit(actor(ctx), "concepts.extract", rev.id, { cards: unique.length, dropped: dropped.length, provider: providerName, version });
    return ok(ctx, { cards: unique, dropped, provider: providerName }, { revision: rev.id, warnings, completeness: dropped.length ? "PARTIAL" : "COMPLETE" });
  }

  /** The concept store: cards with the claim behind each, the version history, and what changed since the previous version. */
  conceptStore(ctx: CallContext, req: { revision?: string; version?: number }): ApiResult<ConceptStore> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const versions = this.store.conceptVersions(rev.repoRoot);
    const current = versions[0]?.version ?? 0;
    const want = req.version ?? current;
    const snapshot = want === current ? this.store.concepts(rev.id, { includeRefuted: true }) : this.store.conceptVersion(rev.repoRoot, want) ?? [];
    const prior = want > 1 ? this.store.conceptVersion(rev.repoRoot, want - 1) : null;
    const key = (c: ConceptCard) => `${c.kind}|${c.title.toLowerCase()}`;
    const priorByKey = new Map((prior ?? []).map((c) => [key(c), c]));
    const nowKeys = new Set(snapshot.map(key));
    const changedMembers = (c: ConceptCard, p: ConceptCard) => c.members.length !== p.members.length || c.summary !== p.summary;
    const diff = prior ? {
      against: want - 1,
      added: snapshot.filter((c) => !priorByKey.has(key(c))).map((c) => c.title),
      removed: [...priorByKey.values()].filter((c) => !nowKeys.has(key(c))).map((c) => c.title),
      changed: snapshot.filter((c) => priorByKey.has(key(c)) && changedMembers(c, priorByKey.get(key(c))!)).map((c) => c.title),
    } : null;
    const claims = Object.fromEntries(this.store.getClaims(snapshot.map((c) => c.claimId)).map((c) => [c.draft.id, c]));
    return ok(ctx, { version: want, versions, cards: snapshot, claims, diff, statedConfidence: this.statedConfidenceReport(snapshot, claims) }, { revision: rev.id });
  }

  /** Does the model's own "high/medium/low" mean anything? Compare it with your verdicts, and abstain until there are enough. */
  statedConfidenceReport(cards: ConceptCard[], claims: Record<string, Claim>): ConceptStore["statedConfidence"] {
    const MIN = 5;
    return (["high", "medium", "low"] as const).map((level) => {
      let confirmed = 0, refuted = 0, unjudged = 0;
      for (const c of cards.filter((x) => x.statedConfidence === level)) {
        const v = claims[c.claimId]?.verdicts.filter((x) => x.verdict !== "DISPUTE").at(-1)?.verdict;
        if (v === "CONFIRM") confirmed++; else if (v === "REFUTE") refuted++; else unjudged++;
      }
      const n = confirmed + refuted;
      const band = n >= MIN ? wilson(confirmed, n) : null;
      return { level, cards: confirmed + refuted + unjudged, confirmed, refuted, unjudged, band: band ? { lower: band.lower, upper: band.upper, n } : null,
        note: n >= MIN ? `${confirmed}/${n} of the cards stated “${level}” were confirmed` : `${n}/${MIN} judged; the model's “${level}” is not calibrated yet` };
    });
  }

  listConcepts(ctx: CallContext, req: { revision?: string }): ApiResult<ConceptCard[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return rev ? ok(ctx, this.store.concepts(rev.id), { revision: rev.id }) : fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
  }

  // ---------------------------------------------------------------- views
  async ask(ctx: CallContext, req: { question: string; revision?: string; pins?: string[]; seeds?: string[]; level?: number; form?: string; subject?: string }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const question = (req.question ?? "").trim();
    if (!question || question.length > 1000) return fail(ctx, { code: "INVALID_SCHEMA", message: "question must be 1–1000 characters", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; ingest a repository first", retryable: false });
    // One of the specialised forms, named explicitly (gallery) or recognised from the question.
    const visual = (req.form ? visualByForm(req.form) : null) ?? matchVisual(question);
    if (visual?.build) {
      this.store.audit(actor(ctx), "ask", rev.id, { form: visual.formId, chars: question.length });
      const built = ensureEdgeClaims(this.store, rev, visual.build(this.store, rev, question, req.subject));
      this.persist(built.claims);
      return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
    }
    const choice = chooseForm(question);
    this.store.audit(actor(ctx), "ask", rev.id, { form: choice.form + (choice.kind ? `:${choice.kind}` : ""), chars: question.length });

    if (choice.form === "CausalGraph") {
      const built = choice.kind === "invariant" ? buildInvariantGraph(this.store, rev, question) : buildFailureGraph(this.store, rev, question);
      built.view.formReason = choice.reason;
      this.persist(built.claims);
      return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
    }

    const { bundle, tiers, scored, hidden } = retrieveForQuestion(this.store, rev.id, question, { pins: new Set(req.pins ?? []), extraSeeds: [...(req.pins ?? []), ...(req.seeds ?? [])] });
    const diagnostics = rev.diagnostics.filter((d) => d.code === "PARSE_ERRORS").map((d) => d.message);
    let representation: RepresentationOutput | undefined, run;
    const warnings: string[] = [];
    if (bundle.entities.length > 0) {
      const { result, note } = await this.callModel<RepresentationOutput>(ctx, rev, { purpose: "REPRESENT", schemaId: SCHEMA_REPRESENTATION, question, bundle });
      if (note) warnings.push(note);
      if (result.ok) { representation = result.value; run = result.run; }
      else { warnings.push(`model unavailable (${result.error.code}); showing deterministic facts only`); diagnostics.push(`model output unavailable: ${result.error.code}`); }
    }
    const { view, claims } = compileView({ question, bundle, tiers, scored, representation, run, diagnostics, store: this.store, systemName: rev.repoRoot.split("/").filter(Boolean).pop() });
    view.formReason = choice.reason;
    if (req.level !== undefined) view.level = req.level;
    view.hidden = hidden;
    this.persist(claims);
    return ok(ctx, { view, claims }, { revision: rev.id, warnings, completeness: view.gaps.length ? "PARTIAL" : "COMPLETE" });
  }

  async investigate(ctx: CallContext, req: { trace: string; revision?: string; ignored?: string[] }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; ingest a repository first", retryable: false });
    if (!req.trace || req.trace.length > 100_000) return fail(ctx, { code: "INVALID_SCHEMA", message: "trace must be 1–100000 characters", retryable: false });
    const built = buildHypothesis(this.store, rev, { trace: req.trace, ignored: req.ignored });
    if ("error" in built) return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: built.error, retryable: false });
    this.persist(built.claims);
    this.store.audit(actor(ctx), "investigate", rev.id, { suspects: built.view.nodes.filter((n) => n.role === "suspect").length });
    return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
  }

  /** The catalogue of visuals, with whether each can be shown for the current repository and why not. */
  visuals(ctx: CallContext, req: { revision?: string }): ApiResult<CatalogEntry[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return ok(ctx, catalog(this.store, rev, !!rev && isGitRepo(rev.repoRoot)), rev ? { revision: rev.id } : {});
  }

  /** Manual salience override, persistent per repository: pin = always shown, boost = ranked higher, demote = ranked lower. */
  setOverride(ctx: CallContext, req: { revision?: string; entityId: string; mode: "pin" | "boost" | "demote" | null }): ApiResult<{ entityId: string; mode: "pin" | "boost" | "demote" | null }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    if (![null, "pin", "boost", "demote"].includes(req.mode)) return fail(ctx, { code: "INVALID_SCHEMA", message: "mode must be pin, boost, demote or null", retryable: false });
    if (this.store.entitiesById(rev.id, [req.entityId]).length === 0) return fail(ctx, { code: "NOT_FOUND", message: "unknown element", retryable: false });
    this.store.setOverride(rev.repoRoot, req.entityId, req.mode);
    this.store.audit(actor(ctx), `override.${req.mode ?? "reset"}`, req.entityId, {});
    return ok(ctx, { entityId: req.entityId, mode: req.mode }, { revision: rev.id });
  }

  listOverrides(ctx: CallContext, req: { revision?: string }): ApiResult<{ entityId: string; mode: string }[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    return ok(ctx, [...this.store.overrides(rev.repoRoot)].map(([entityId, mode]) => ({ entityId, mode })));
  }

  /** Rebuild the current view with whatever changed underneath it (an override, a new exception), keeping its identity. */
  async refreshView(ctx: CallContext, req: { view: ViewSpec }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const v = req.view;
    if (!v) return fail(ctx, { code: "INVALID_SCHEMA", message: "no view", retryable: false });
    const r = v.investigation
      ? await this.investigate(ctx, { trace: v.investigation.trace, revision: v.revision, ignored: v.investigation.ignored })
      : await this.ask(ctx, { question: v.question, revision: v.revision, form: v.formId, subject: typeof v.params?.subject === "string" ? v.params.subject : undefined });
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
    this.persist(built.claims);
    this.store.audit(actor(ctx), `steer.${req.action.toLowerCase()}`, req.entityId, { version: built.view.version });
    return ok(ctx, built, { revision: rev.id });
  }

  // ---------------------------------------------------------------- explanations
  async explain(ctx: CallContext, req: { revision: string; entityIds: string[]; question?: string }): Promise<ApiResult<ExplainResult>> {
    const rev = this.store.revision(req.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const selected = [...new Set(req.entityIds ?? [])].slice(0, 20);
    if (selected.length === 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "select at least one element", retryable: false });
    if (this.store.entitiesById(rev.id, selected).length !== selected.length) return fail(ctx, { code: "NOT_FOUND", message: "selection references unknown entities", retryable: false });

    const bundle = retrieveAround(this.store, rev.id, selected);
    const question = req.question?.trim() || "Why are these connected?";
    const { result, note } = await this.callModel<ExplanationOutput>(ctx, rev, { purpose: "EXPLAIN", schemaId: SCHEMA_EXPLANATION, question, bundle, selected });
    if (!result.ok) return fail(ctx, result.error);

    let claims = result.value.claims.map((c) => gateClaim({ ...c, structure: c.pathEntityIds && c.pathEntityIds.length > 1 ? { kind: "path", entityIds: c.pathEntityIds } : undefined }, bundle, { run: result.run, store: this.store }));
    // Adversarial pass by the model for the claims that survived grounding (bounded; the stub has nothing to add).
    if (this.model.name !== "stub") {
      claims = await Promise.all(claims.map(async (c, i) => {
        if (i >= 3 || c.displayMode === "HIDDEN") return c;
        const ch = await this.callModel<ChallengeOutput>(ctx, rev, { purpose: "CHALLENGE", schemaId: SCHEMA_CHALLENGE, question, bundle, selected, claim: { assertion: c.draft.assertion, evidenceIds: c.draft.evidenceIds } });
        if (!ch.result.ok) return c;
        return withChallenge(c, bundle, ch.result.value.objections, this.store);
      }));
    }
    this.persist(claims);
    const shown = claims.filter((c) => c.displayMode !== "HIDDEN");
    const rejected = claims.length - shown.length;
    const evidence = this.resolveMany(rev, bundle.evidence, [...new Set(shown.flatMap((c) => c.draft.evidenceIds))]);
    const summary = rejected ? `${result.value.summary} (${rejected} claim(s) withheld: they failed a gate.)` : result.value.summary;
    this.store.audit(actor(ctx), "explain", rev.id, { selected: selected.length, claims: claims.length, withheld: rejected });
    return ok(ctx, { summary, claims, evidence, selected }, { revision: rev.id, completeness: rejected ? "PARTIAL" : "COMPLETE", warnings: note ? [note] : [] });
  }

  private resolveMany(rev: RevisionRow, pool: EvidenceRef[], ids: string[]): ResolvedEvidence[] {
    return ids.flatMap((id) => { const e = pool.find((x) => x.id === id) ?? this.store.evidence(rev.id, id); return e ? [this.resolveEvidence(rev, e)] : []; });
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
    this.persist([claim]);
    return ok(ctx, { summary: lines.join("\n"), claims: [claim], evidence: this.resolveMany(rev, [], evidenceIds), selected: node.entityRefs }, { revision: rev.id });
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

  evidenceFor(ctx: CallContext, req: { revision: string; evidenceId: string }): ApiResult<ResolvedEvidence> {
    const rev = this.store.revision(req.revision);
    const ev = rev && this.store.evidence(rev.id, req.evidenceId);
    if (!rev || !ev) return fail(ctx, { code: "EVIDENCE_MISSING", message: "no such evidence in this revision", retryable: false });
    return ok(ctx, this.resolveEvidence(rev, ev), { revision: rev.id });
  }

  /** Read a span from the repo root of `rev`, refusing paths outside it and hashing to detect drift. */
  resolveEvidence(rev: RevisionRow, ev: EvidenceRef): ResolvedEvidence {
    const loc = ev.location as { kind: string; locator?: string; span?: { sourceId: string; contentHash: string; startByte: number; endByteExclusive: number } };
    // Non-code evidence (git history, pasted traces) carries its own description and has no span to re-read.
    if (loc.kind !== "CodeLocation" || !loc.span) {
      return { id: ev.id, class: ev.class, file: ev.sourceId, startByte: 0, endByte: 0, startLine: 0, endLine: 0, snippet: loc.locator ?? "", state: ev.state };
    }
    const span = loc.span;
    const base = { id: ev.id, class: ev.class, file: span.sourceId, absPath: resolve(rev.repoRoot, span.sourceId), startByte: span.startByte, endByte: span.endByteExclusive, startLine: 0, endLine: 0, snippet: "" };
    const path = resolve(rev.repoRoot, span.sourceId);
    const rel = relative(rev.repoRoot, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return { ...base, state: "UNAVAILABLE" };
    let buf: Buffer;
    try { buf = readFileSync(path); } catch { return { ...base, state: "UNAVAILABLE" }; }
    const stale = createHash("sha256").update(buf).digest("hex") !== span.contentHash;
    // Offsets are bytes; slice on the byte buffer, then compute lines from the prefix.
    const startLine = buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
    const snippet = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    return { ...base, startLine, endLine: startLine + snippet.split("\n").length - 1, snippet: snippet.length > 4000 ? snippet.slice(0, 4000) + "\n…" : snippet, state: stale ? "STALE" : "CURRENT" };
  }

  // ---------------------------------------------------------------- verdicts
  verdict(ctx: CallContext, req: { claimId: string; verdict: VerdictKind; explanation: string; expectedVersion: number }): ApiResult<{ claim: Claim; affected: Claim[] }> {
    if (!["CONFIRM", "REFUTE", "DISPUTE"].includes(req.verdict)) return fail(ctx, { code: "INVALID_SCHEMA", message: "verdict must be CONFIRM, REFUTE or DISPUTE", retryable: false });
    const r = applyVerdict(this.store, { claimId: req.claimId, verdict: req.verdict, explanation: req.explanation ?? "", actorId: actor(ctx), expectedVersion: req.expectedVersion });
    if (!r.ok) return fail(ctx, r.error);
    return ok(ctx, { claim: r.claim, affected: r.affected }, { resourceVersion: r.claim.version });
  }

  claims(ctx: CallContext, req: { ids: string[] }): ApiResult<Claim[]> {
    return ok(ctx, this.store.getClaims((req.ids ?? []).slice(0, 500)));
  }

  // ---------------------------------------------------------------- workspaces (investigation memory)
  saveWorkspace(ctx: CallContext, req: { workspaceId?: string; name: string; expectedVersion: number; revision?: string; state: SavedState }): ApiResult<{ workspaceId: string; receipt: CommitReceipt; replayed: boolean }> {
    const name = (req.name ?? "").trim();
    if (!name || name.length > 120) return fail(ctx, { code: "INVALID_SCHEMA", message: "name must be 1–120 characters", retryable: false });
    const workspaceId = req.workspaceId ?? `ws:${randomUUID()}`;
    const r = this.journal.submit(ctx, { id: ctx.requestId, type: "UPDATE_WORKSPACE", subjectId: workspaceId, expectedVersion: req.expectedVersion ?? 0, payload: { name, revision: req.revision, state: req.state } });
    if (!r.ok) return fail(ctx, r.error);
    if (!r.replayed) this.store.audit(actor(ctx), "workspace.save", workspaceId, { version: r.receipt.resourceVersion });
    return ok(ctx, { workspaceId, receipt: r.receipt, replayed: r.replayed }, { resourceVersion: r.receipt.resourceVersion, revision: req.revision });
  }

  listWorkspaces(ctx: CallContext): ApiResult<{ id: string; name: string; version: number; revision: string | null; updatedAt: string }[]> {
    const rows = this.store.db.prepare("select id, name, version, revision, updated_at from workspaces order by updated_at desc").all() as any[];
    return ok(ctx, rows.map((r) => ({ id: r.id, name: r.name, version: r.version, revision: r.revision, updatedAt: r.updated_at })));
  }

  /** Resume: saved state plus staleness (evidence whose source changed) and the current state of every saved claim. */
  openWorkspace(ctx: CallContext, req: { workspaceId: string }): ApiResult<{ id: string; name: string; version: number; revision: string | null; state: SavedState; staleEvidence: string[]; staleFiles: string[]; revisionIndexed: boolean; claimStates: Claim[] }> {
    const row = this.store.db.prepare("select * from workspaces where id = ?").get(req.workspaceId) as any;
    if (!row) return fail(ctx, { code: "NOT_FOUND", message: "no such workspace", retryable: false });
    const state: SavedState = JSON.parse(row.json);
    const rev = row.revision ? this.store.revision(row.revision) : null;
    const ids = new Set<string>();
    for (const n of state.view?.nodes ?? []) n.evidenceIds.forEach((i) => ids.add(i));
    for (const e of state.view?.edges ?? []) e.evidenceIds.forEach((i) => ids.add(i));
    for (const c of [...state.claims, ...(state.explanation?.claims ?? [])]) c.draft.evidenceIds.forEach((i) => ids.add(i));
    const staleEvidence: string[] = [];
    const staleFiles = new Set<string>();
    if (rev) {
      for (const id of ids) {
        const ev = this.store.evidence(rev.id, id);
        if (!ev) continue;
        const res = this.resolveEvidence(rev, ev);
        if (res.state === "STALE" || res.state === "UNAVAILABLE") { staleEvidence.push(id); staleFiles.add(res.file); }
      }
    }
    const claimIds = [...new Set([...state.claims, ...(state.explanation?.claims ?? [])].map((c) => c.draft.id))];
    this.store.audit(actor(ctx), "workspace.open", row.id, { stale: staleEvidence.length });
    return ok(ctx, { id: row.id, name: row.name, version: row.version, revision: row.revision, state, staleEvidence, staleFiles: [...staleFiles].sort(), revisionIndexed: !!rev, claimStates: this.store.getClaims(claimIds) },
      { revision: row.revision ?? undefined, resourceVersion: row.version, completeness: staleEvidence.length ? "PARTIAL" : "COMPLETE", warnings: staleEvidence.length ? [`${staleEvidence.length} evidence span(s) changed since this was saved`] : [] });
  }

  /** "What changed since I left": re-index the repository and diff against the saved revision. */
  async changesSince(ctx: CallContext, req: { workspaceId: string }): Promise<ApiResult<ChangesSince>> {
    const row = this.store.db.prepare("select * from workspaces where id = ?").get(req.workspaceId) as any;
    const rev0 = row?.revision ? this.store.revision(row.revision) : null;
    if (!row || !rev0) return fail(ctx, { code: "NOT_FOUND", message: "no saved revision to compare against", retryable: false });
    if (!existsSync(rev0.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: `repository folder no longer exists: ${rev0.repoRoot}`, retryable: false });
    const ing = await this.ingestRepository(ctx, { repoPath: rev0.repoRoot });
    if (!ing.ok) return ing as ApiResult<never>;
    const rev1 = ing.value;
    const state: SavedState = JSON.parse(row.json);
    const fileHash = (rev: string) => new Map(this.store.entities(rev).filter((e) => e.kind === "file").map((e) => [e.file, e.spans[0]?.contentHash ?? ""]));
    const h0 = fileHash(rev0.id), h1 = fileHash(rev1.id);
    const files = {
      added: [...h1.keys()].filter((f) => !h0.has(f)).sort(), removed: [...h0.keys()].filter((f) => !h1.has(f)).sort(),
      changed: [...h1.keys()].filter((f) => h0.has(f) && h0.get(f) !== h1.get(f)).sort(),
    };
    const changedSet = new Set(files.changed);
    const e0 = new Map(this.store.entities(rev0.id).map((e) => [e.entityId, e]));
    const e1 = new Map(this.store.entities(rev1.id).map((e) => [e.entityId, e]));
    const affectedNodes: ChangesSince["affectedNodes"] = [];
    for (const n of state.view?.nodes ?? []) {
      for (const id of n.entityRefs) {
        const cur = e1.get(id);
        if (!cur) affectedNodes.push({ nodeId: n.id, label: n.label, change: "removed" });
        // A node is affected when its own source changed (symbol hash), not merely when its file did.
        else if (changedSet.has(cur.file) && cur.symbolHash !== e0.get(id)?.symbolHash) affectedNodes.push({ nodeId: n.id, label: n.label, change: "changed" });
      }
    }
    const hist = (rev: string) => new Map(this.store.factsByPredicate(rev, "history").map((f) => [f.subject.replace(/^file:/, ""), (f.object as any).value]));
    const c0 = hist(rev0.id), c1 = hist(rev1.id);
    const commits = [...c1].filter(([f, v]) => c0.get(f)?.lastCommit !== v.lastCommit).map(([file, v]) => ({ file, subject: v.lastSubject, author: v.lastAuthor, date: v.lastDate })).slice(0, 10);
    const changed = rev1.id !== rev0.id;
    const summary = !changed ? "Nothing in the repository has changed since you saved this investigation."
      : `Since you left: ${files.changed.length} file(s) changed, ${files.added.length} added, ${files.removed.length} removed; ${affectedNodes.length} element(s) of this investigation are affected.${commits.length ? ` Latest: “${commits[0].subject}” by ${commits[0].author}.` : ""}`;
    return ok(ctx, { fromRevision: rev0.id, toRevision: rev1.id, changed, files, affectedNodes, commits, summary }, { revision: rev1.id });
  }

  // ---------------------------------------------------------------- conversation
  /** One text box: new question, trace → investigation, steering, "why …", or resume. Selection chips are referents. */
  async converse(ctx: CallContext, req: { text: string; view?: ViewSpec | null; selection?: string[]; revision?: string; pins?: string[] }): Promise<ApiResult<ConverseResult>> {
    const text = (req.text ?? "").trim();
    if (!text) return fail(ctx, { code: "INVALID_SCHEMA", message: "say something", retryable: false });
    const view = req.view ?? null;
    const nodeById = new Map((view?.nodes ?? []).map((n) => [n.id, n]));
    const selected = (req.selection ?? []).map((id) => nodeById.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
    const referentCount = selected.length || (req.pins?.length ?? 0);
    const intent = routeIntent(text, { hasView: !!view || referentCount >= 2, viewForm: view?.formId, selectionCount: referentCount, looksLikeTrace: looksLikeTrace(text) });
    const entityIds = selected.flatMap((n) => n.entityRefs);
    const revision = view?.revision ?? req.revision;
    // A steering turn adjusts the current view, so it does not repeat why that kind of view was chosen.
    const asView = (r: ApiResult<{ view: ViewSpec; claims: Claim[] }>, lead: string, steering = false): ApiResult<ConverseResult> =>
      r.ok ? ok(ctx, { kind: "view", view: r.value.view, claims: r.value.claims, message: `${lead} ${steering ? "" : r.value.view.formReason ?? ""} ${r.value.view.caption}`.replace(/\s+/g, " ").trim() }, r.metadata) : (r as ApiResult<never>);
    const asExplain = (r: ApiResult<ExplainResult>, lead = ""): ApiResult<ConverseResult> =>
      r.ok ? ok(ctx, { kind: "explanation", explanation: r.value, message: `${lead}${r.value.summary}`.trim() }, r.metadata) : (r as ApiResult<never>);
    const needsView = () => fail<ConverseResult>(ctx, { code: "INVALID_SCHEMA", message: "Ask a question first, then I can talk about what's on the map.", retryable: false });

    switch (intent.type) {
      case "investigate": return asView(await this.investigate(ctx, { trace: text, revision }), "Investigating the exception you pasted.");
      case "overview": {
        const rev = revision ? this.store.revision(revision) : this.store.latestRevision();
        if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
        // The most connected code is what a newcomer should see first; the map starts zoomed out to the domains.
        const idx = revisionIndex(this.store, rev.id);
        const kinds = new Set(["function", "method", "class"]);
        const seeds = this.store.entities(rev.id).filter((e) => kinds.has(e.kind)).sort((a, b) => (idx.degree.get(b.entityId) ?? 0) - (idx.degree.get(a.entityId) ?? 0) || a.entityId.localeCompare(b.entityId)).slice(0, 30).map((e) => e.entityId);
        const r = await this.ask(ctx, { question: "Give me an overview of the whole project", revision: rev.id, seeds, level: 1 });
        if (r.ok) r.value.view.formReason = "You asked for the project overview, so this shows the most connected code in the repository, grouped by responsibility. Zoom in for detail.";
        return asView(r, "");
      }
      case "ask": return asView(await this.ask(ctx, { question: text, revision, pins: req.pins }), "");
      case "resume": {
        const list = this.listWorkspaces(ctx);
        const hit = list.ok ? matchName(intent.name, list.value) : null;
        if (!hit) return ok(ctx, { kind: "message", message: intent.name ? `I couldn't find a saved investigation matching “${intent.name}”.` : "There are no saved investigations yet." });
        return ok(ctx, { kind: "resume", workspaceId: hit.id, message: `Resuming “${hit.name}”…` });
      }
      case "zoom": return ok(ctx, { kind: "zoom", direction: intent.direction, message: intent.direction === "in" ? "Zooming in one level." : intent.direction === "out" ? "Zooming out one level." : "Showing the overview." });
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
        const set = this.setOverride(ctx, { revision, entityId: exact.id, mode });
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
