// Task 2.O — the GitHub issue trail (PF-054, PF-056, PF-080; AT-43, AT-44, AT-46, AT-47, AT-48; plan S13, P7, P8).
//
// What leaves this machine is decided here, by code, not by a model:
//   * the projection is built from an ALLOWLIST of fields (ids, enums, counts). No requirement text, no model output, no event rationale.
//   * a private-repository destination additionally gets the redacted prompt preview; a public or unknown one gets nothing of the prompt.
//   * the finished text is guarded: if it still looks like a secret, or contains a stretch of the prompt it should not carry, the write is
//     REFUSED (fail closed), never sent altered.
// The trail never claims more than it has: SYNCED only when no milestone is waiting in the outbox; DIVERGED when a person edited the
// managed block (it is then left alone); CIE closes only issues it opened, and only for a cancelled request.
import { asSet, canonHash, defineSchema, rawHash, type Canon } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { GhError, type IssueForge, type RemoteIssue } from "./issue-forge.ts";
import { eventFor } from "./lifecycle.ts";
import { redactText } from "./redact.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { EventRecord, EventType, FeatureRecord, Id, IssueBinding, IssueBindingReceipt, IssueSyncReceipt } from "./types.ts";

/** Milestone-level events only (spec §35.3). Everything else is marked SKIPPED and never leaves the machine. */
export const MILESTONES: readonly EventType[] = ["FeatureSubmitted", "ContractVersionCreated", "RequirementFindingRaised", "DecisionRecorded", "CandidateCreated", "ValidationCompleted", "PerformanceAssessed",
  "VerificationInvalidated", "PublicationRequested", "PublicationReconciled", "PatchExported", "PatchApplied", "Cancelled", "ModelIdentityChanged", "REVIEW_APPLIED", "PR_UPDATED"];
export interface ProjectionPolicy { minIntervalMs: number; maxEventsPerComment: number; milestones: readonly EventType[]; labelCandidates: readonly string[]; baseBackoffMs: number; maxBackoffMs: number }
export const DEFAULT_PROJECTION_POLICY: ProjectionPolicy = { minIntervalMs: 10_000, maxEventsPerComment: 20, milestones: MILESTONES, labelCandidates: ["enhancement", "feature", "cie"], baseBackoffMs: 60_000, maxBackoffMs: 3_600_000 };
const PolicySchema = defineSchema<ProjectionPolicy>("pf.IssueProjectionPolicy", "1", (p) => ({ minIntervalMs: p.minIntervalMs, maxEventsPerComment: p.maxEventsPerComment, milestones: asSet([...p.milestones]) as Canon, labelCandidates: asSet([...p.labelCandidates]) as Canon, baseBackoffMs: p.baseBackoffMs, maxBackoffMs: p.maxBackoffMs }));
export const projectionPolicyHash = (p: ProjectionPolicy = DEFAULT_PROJECTION_POLICY): string => canonHash(PolicySchema, p);

export type Visibility = "PRIVATE" | "PUBLIC_OR_UNKNOWN";
export const markerFor = (requestId: Id): string => `<!-- cie-request:${requestId} -->`;
const BEGIN = "<!-- cie:begin -->", END = "<!-- cie:end -->";
const STATUS_WORDS: Record<string, string> = { MATERIALIZED: "drafted and saved", PLANNED: "planned", STALE: "stale, rebuild needed", SUPERSEDED: "replaced by a newer draft" };
const safe = (s: string, max = 60): string => s.replace(/[^\w:.#/ -]/g, "").slice(0, max);

export interface Projection { title: string; body: string; block: string; blockHash: string; labels: string[]; visibility: Visibility; hash: string; policyHash: string }

export function buildProjection(fs: SqliteFeatureStore, rec: FeatureRecord, o: { visibility: Visibility; availableLabels: readonly string[]; policy?: ProjectionPolicy; includeMarker?: boolean }): Projection {
  const policy = o.policy ?? DEFAULT_PROJECTION_POLICY;
  const cand = rec.workspace.candidateHash ? fs.getCandidateByBinding(rec.workspace.candidateHash) : null;
  const lines = [
    `**CIE feature request** \`${safe(rec.requestId, 40)}\``, `- Mode: ${rec.mode}`, `- State: ${rec.state}`, `- Tier: ${rec.tier ?? "not yet classified"}`, `- Contract version: ${rec.contractVersion}`,
    `- Requirements: ${rec.contract?.requirements.length ?? 0} · Acceptance criteria: ${rec.contract?.acceptance.length ?? 0} · Open questions: ${rec.blockers.filter((b) => b.kind === "QUESTION").length}`,
    `- Candidate: ${cand ? STATUS_WORDS[cand.status] ?? cand.status.toLowerCase() : "none yet"}`,
    "_This issue records progress only. It does not say the work is verified._",
  ];
  const preview = o.visibility === "PRIVATE" ? rec.promptRef.redactedPreview : "";
  const block = [BEGIN, ...(preview ? [`> ${preview}`] : []), ...lines, END].join("\n");
  const body = `${o.includeMarker === false ? "" : markerFor(rec.requestId) + "\n"}${block}`;
  const title = preview ? `[CIE] ${preview.slice(0, 80)}` : `[CIE] feature request ${safe(rec.requestId.replace(/^req:/, "")).slice(0, 12)}`;
  const labels = policy.labelCandidates.filter((l) => o.availableLabels.includes(l)).slice(0, 3);
  const blockHash = rawHash(block);
  return { title, body, block, blockHash, labels, visibility: o.visibility, hash: rawHash(`${title}\0${body}\0${labels.join(",")}`), policyHash: projectionPolicyHash(policy) };
}

const WINDOW = 24;
function windows(text: string): Set<string> {
  const t = text.replace(/\s+/g, " ").trim(), out = new Set<string>();
  for (let i = 0; i + WINDOW <= t.length; i += 6) out.add(t.slice(i, i + WINDOW));
  return out;
}
/** Fail closed: refuse to send text that still looks like a secret or carries a stretch of the private prompt it should not. */
export function guardOutgoing(rec: FeatureRecord, text: string, visibility: Visibility): string {
  if (redactText(text) !== text) throw new FeatureError("FORBIDDEN", "the outgoing text still contains something that looks like a secret or personal data; nothing was sent");
  const prompt = rec.promptRef.text;
  if (prompt) {
    const allowed = visibility === "PRIVATE" ? windows(rec.promptRef.redactedPreview) : new Set<string>();
    const flat = text.replace(/\s+/g, " ");
    for (const w of windows(prompt)) if (!allowed.has(w) && flat.includes(w)) throw new FeatureError("FORBIDDEN", "the outgoing text contains part of the private prompt; nothing was sent");
  }
  return text;
}

export interface TrailDeps { fs: SqliteFeatureStore; forge: IssueForge; policy?: ProjectionPolicy; now?: () => number }
const nowOf = (d: TrailDeps) => (d.now ?? Date.now)();
const iso = (ms: number) => new Date(ms).toISOString();
const pol = (d: TrailDeps) => d.policy ?? DEFAULT_PROJECTION_POLICY;

function ghFail(e: unknown): never {
  if (e instanceof GhError) throw new FeatureError(e.state === "NOT_FOUND" ? "NOT_FOUND" : e.state === "REFUSED" ? "FORBIDDEN" : "PROVIDER_UNAVAILABLE", `GitHub: ${e.message}`);
  throw e;
}
const parseRepo = (r: unknown): string => { if (typeof r !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(r)) throw new FeatureError("INVALID_SCHEMA", "repositoryId must be owner/name"); return r; };
function parseIssueNumber(v: unknown, repo: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  const m = typeof v === "string" ? /^(?:([\w.-]+\/[\w.-]+))?#?(\d{1,9})$/.exec(v.trim()) : null;
  if (!m) throw new FeatureError("INVALID_SCHEMA", "existingIssueId must be a number, #number or owner/name#number");
  if (m[1] && m[1] !== repo) throw new FeatureError("INVALID_SCHEMA", "the issue belongs to a different repository than the destination");
  return Number(m[2]);
}
function owned(d: TrailDeps, actor: Id, requestId: Id): FeatureRecord {
  const rec = d.fs.getRequest(requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  return rec;
}
const blockOf = (body: string): string | null => { const a = body.indexOf(BEGIN), b = body.indexOf(END); return a >= 0 && b > a ? body.slice(a, b + END.length) : null; };

/** SYNCED only when nothing is waiting; DIVERGED stays until a person clears it. */
export function trailState(fs: SqliteFeatureStore, rec: FeatureRecord, milestones: readonly EventType[] = MILESTONES): IssueBinding["syncState"] {
  if (rec.issue.syncState === "DIVERGED") return "DIVERGED";
  if (!rec.issue.number) return rec.issue.syncState === "UNBOUND" || rec.issue.syncState === "TRACKING_BLOCKED" ? rec.issue.syncState : "UNSYNCED";
  return fs.pendingSync(5000).some((e) => e.requestId === rec.requestId && milestones.includes(e.type)) ? "UNSYNCED" : "SYNCED";
}

function saveIssue(d: TrailDeps, requestId: Id, actor: Id, patch: Partial<IssueBinding>, rationale: string, result: "OK" | "FAILED" | "BLOCKED" = "OK"): FeatureRecord {
  for (let attempt = 0; ; attempt++) {
    const cur = d.fs.getRequest(requestId)!;
    try {
      const issue = { ...cur.issue, ...patch };
      const next = d.fs.updateRequest(requestId, cur.version, { ...cur, issue, workspace: { ...cur.workspace, issueRef: issue.number ? `${issue.repository}#${issue.number}` : cur.workspace.issueRef, workspaceVersion: cur.workspace.workspaceVersion + 1 } },
        eventFor(cur, "StateChanged", actor, { result, rationale, producer: "C30" }));
      return next;
    } catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
}

async function visibilityOf(d: TrailDeps, repo: string): Promise<Visibility> {
  try { return (await d.forge.repoInfo(repo)).private ? "PRIVATE" : "PUBLIC_OR_UNKNOWN"; } catch (e) { return ghFail(e); }
}

export interface PreviewInput { requestId: Id; repositoryId: string }
export async function previewIssueProjection(d: TrailDeps, actor: Id, i: PreviewInput): Promise<Projection> {
  const rec = owned(d, actor, i.requestId); const repo = parseRepo(i.repositoryId);
  const visibility = await visibilityOf(d, repo);
  let labels: string[]; try { labels = await d.forge.labels(repo); } catch (e) { return ghFail(e); }
  const p = buildProjection(d.fs, rec, { visibility, availableLabels: labels, policy: pol(d) });
  guardOutgoing(rec, `${p.title}\n${p.body}`, visibility);
  return p;
}

export interface BindInput { requestId: Id; repositoryId: string; existingIssueId?: string | number; projectionHash: string; expectedVersion: number; idempotencyKey: string }
export async function bindRequestIssue(d: TrailDeps, actor: Id, i: BindInput): Promise<IssueBindingReceipt> {
  const rec = owned(d, actor, i.requestId); const repo = parseRepo(i.repositoryId);
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  if (["CANCELLED", "FAILED"].includes(rec.state)) throw new FeatureError("ILLEGAL_TRANSITION", `the request is ${rec.state}; it cannot be bound to an issue`);
  if (rec.issue.number) {
    if (rec.issue.repository === repo && (i.existingIssueId === undefined || parseIssueNumber(i.existingIssueId, repo) === rec.issue.number)) return { schemaVersion: 1, id: `issue:${rec.requestId}`, issue: rec.issue, created: false, labelsApplied: rec.issue.labels ?? [], warnings: ["already bound; nothing was changed"] };
    throw new FeatureError("FORBIDDEN", `this request is already bound to ${rec.issue.repository}#${rec.issue.number}; a binding is not moved`);
  }
  if (i.expectedVersion !== rec.workspace.workspaceVersion) throw new FeatureError("VERSION_CONFLICT", `the request changed (version ${rec.workspace.workspaceVersion}, expected ${i.expectedVersion})`, rec.workspace.workspaceVersion);
  const existingNumber = parseIssueNumber(i.existingIssueId, repo);
  const visibility = await visibilityOf(d, repo);
  let labels: string[]; try { labels = await d.forge.labels(repo); } catch (e) { return ghFail(e); }
  const proj = buildProjection(d.fs, rec, { visibility, availableLabels: labels, policy: pol(d), includeMarker: existingNumber === undefined });
  const full = buildProjection(d.fs, rec, { visibility, availableLabels: labels, policy: pol(d) });
  if (i.projectionHash !== full.hash) throw new FeatureError("STALE_REVISION", "what would be sent has changed since you reviewed it; preview it again");
  const warnings: string[] = []; let issue: RemoteIssue; let created = false; let createdByCie = false;
  try {
    if (existingNumber !== undefined) {
      issue = await d.forge.getIssue(repo, existingNumber);
      if (issue.isPullRequest) throw new FeatureError("INVALID_SCHEMA", `#${existingNumber} is a pull request, not an issue`);
      if (issue.locked) throw new FeatureError("FORBIDDEN", `#${existingNumber} is locked; CIE cannot comment on it`);
      if (issue.state === "closed") warnings.push(`#${existingNumber} is closed; progress will still be posted as comments`);
      const text = `${markerFor(rec.requestId)}\n${proj.block}\n_Tracking started by CIE. Progress is posted as comments; this issue's text is left to you._`;
      guardOutgoing(rec, text, visibility);
      const seen = (await d.forge.recentComments(repo, issue.number)).some((c) => c.body.includes(markerFor(rec.requestId)));
      if (!seen) await d.forge.createComment(repo, issue.number, text);
    } else {
      // find-before-create: a previous attempt that timed out may already have opened the issue
      const prior = await d.forge.findIssue(repo, markerFor(rec.requestId));
      if (prior) { issue = prior; createdByCie = true; warnings.push("an issue for this request already existed and was adopted"); }
      else {
        guardOutgoing(rec, `${full.title}\n${full.body}`, visibility);
        issue = await d.forge.createIssue(repo, { title: full.title, body: full.body, labels: full.labels }); created = true; createdByCie = true;
      }
    }
  } catch (e) {
    if (e instanceof FeatureError) { saveIssueFailure(d, rec, actor, e.message); throw e; }
    try { ghFail(e); } catch (fe) { saveIssueFailure(d, rec, actor, (fe as Error).message); throw fe; }
    throw e;
  }
  const next = saveIssue(d, rec.requestId, actor, { repository: repo, number: issue.number, nodeId: issue.nodeId, syncState: "UNSYNCED", projectionRevision: rec.issue.projectionRevision + 1, createdByCie, visibility, projectionHash: createdByCie ? full.blockHash : undefined, labels: createdByCie ? full.labels : [], lastSyncAt: iso(nowOf(d)), failures: 0, retryAfter: undefined },
    `issue bound: ${repo}#${issue.number} (${visibility}; ${created ? "created" : createdByCie ? "adopted" : "existing issue"})`);
  const state = trailState(d.fs, next, pol(d).milestones);
  const final = state === next.issue.syncState ? next : saveIssue(d, rec.requestId, actor, { syncState: state }, `tracking ${state}`);
  return { schemaVersion: 1, id: `issue:${rec.requestId}`, issue: final.issue, created, labelsApplied: createdByCie ? full.labels : [], ...(warnings.length ? { warnings } : {}) };
}
function saveIssueFailure(d: TrailDeps, rec: FeatureRecord, actor: Id, message: string): void {
  try { d.fs.appendEvent(eventFor(rec, "StateChanged", actor, { result: "BLOCKED", producer: "C30", rationale: `issue binding failed: ${message.slice(0, 160)}; tracking is not claimed` })); } catch { /* the request moved on; the failure is still thrown to the caller */ }
}

export interface SyncInput { requestId: Id; throughSequence: number; projectionPolicyHash: string }
const idsOf = (e: EventRecord): string => { const ids = [...e.requirementIds, ...e.decisionIds].map((x) => safe(x, 40)).filter(Boolean); return ids.length ? ` [${ids.join(", ")}]` : ""; };

export async function syncRequestMilestones(d: TrailDeps, actor: Id, i: SyncInput): Promise<IssueSyncReceipt> {
  let rec = owned(d, actor, i.requestId); const policy = pol(d);
  if (!rec.issue.number) throw new FeatureError("BLOCKED", "no issue is bound to this request, so there is no trail to update; bind one first");
  if (i.projectionPolicyHash !== projectionPolicyHash(policy)) throw new FeatureError("STALE_REVISION", "the projection policy changed; preview again");
  if (!Number.isSafeInteger(i.throughSequence) || i.throughSequence < 0) throw new FeatureError("INVALID_SCHEMA", "throughSequence must be a non-negative integer");
  const repo = rec.issue.repository, number = rec.issue.number;
  const receipt = (over: Partial<IssueSyncReceipt> = {}): IssueSyncReceipt => ({ schemaVersion: 1, id: `sync:${rec.requestId}:${i.throughSequence}`, throughSequence: rec.issue.lastSyncedSequence, remoteIds: [], state: rec.issue.syncState, ...over });
  const now = nowOf(d);
  if (rec.issue.retryAfter && Date.parse(rec.issue.retryAfter) > now) return receipt({ sent: 0, deferredUntil: rec.issue.retryAfter, warnings: ["GitHub asked CIE to slow down; the events stay in the outbox"] });

  const pending = d.fs.pendingSync(5000).filter((e) => e.requestId === rec.requestId && e.sequence <= i.throughSequence).sort((a, b) => a.sequence - b.sequence);
  let skipped = 0;
  for (const e of pending.filter((x) => !policy.milestones.includes(x.type))) { d.fs.markSynced(e.eventId, { state: "SKIPPED", attempts: e.sync.attempts }); skipped++; }
  const batchAll = pending.filter((e) => policy.milestones.includes(e.type));
  const settle = (extra: Partial<IssueSyncReceipt> = {}): IssueSyncReceipt => {
    rec = d.fs.getRequest(rec.requestId)!;
    const waiting = d.fs.pendingSync(5000).filter((e) => e.requestId === rec.requestId).sort((a, b) => a.sequence - b.sequence)[0];
    const last = Math.max(rec.issue.lastSyncedSequence, Math.min(i.throughSequence, waiting ? waiting.sequence - 1 : i.throughSequence));
    const state = trailState(d.fs, rec, policy.milestones);
    if (last !== rec.issue.lastSyncedSequence || state !== rec.issue.syncState) rec = saveIssue(d, rec.requestId, actor, { lastSyncedSequence: last, syncState: state }, `issue trail ${state}; through event ${last}`);
    return receipt({ throughSequence: rec.issue.lastSyncedSequence, state: rec.issue.syncState, skipped, ...extra });
  };
  if (!batchAll.length) return settle({ sent: 0 });
  if (rec.issue.lastSyncAt && now - Date.parse(rec.issue.lastSyncAt) < policy.minIntervalMs) return settle({ sent: 0, deferredUntil: iso(Date.parse(rec.issue.lastSyncAt) + policy.minIntervalMs), warnings: [`at most one comment per ${policy.minIntervalMs / 1000} s: ${batchAll.length} milestone(s) are coalesced into the next one`] });

  const batch = batchAll.slice(0, policy.maxEventsPerComment); const from = batch[0]!.sequence, to = batch.at(-1)!.sequence;
  const marker = `<!-- cie-sync:${rec.requestId}:${from}-${to} -->`;
  const warnings: string[] = []; const remoteIds: string[] = [];
  try {
    // divergence: a person edited the managed block of an issue CIE opened. Leave their edit alone and say so.
    let remote: RemoteIssue | null = null;
    if (rec.issue.createdByCie) {
      remote = await d.forge.getIssue(repo, number);
      const block = blockOf(remote.body);
      if (rec.issue.syncState !== "DIVERGED" && (!block || rawHash(block) !== rec.issue.projectionHash)) { rec = saveIssue(d, rec.requestId, actor, { syncState: "DIVERGED" }, "the CIE-managed block of the issue was edited outside CIE; it is left alone", "BLOCKED"); warnings.push("the managed block was edited by a person and is no longer updated"); }
    }
    const lines = batch.map((e) => `- #${e.sequence} **${e.type}** — ${e.result} (${e.at})${idsOf(e)}`);
    const notice = rec.issue.syncState === "DIVERGED" ? "\n_The managed block of this issue was edited outside CIE, so CIE no longer rewrites it; progress continues here as comments._" : "";
    const text = `**CIE progress** (events ${from}–${to})\n${lines.join("\n")}${notice}\n${marker}`;
    guardOutgoing(rec, text, rec.issue.visibility ?? "PUBLIC_OR_UNKNOWN");
    const existing = (await d.forge.recentComments(repo, number)).find((c) => c.body.includes(marker));
    const comment = existing ?? await d.forge.createComment(repo, number, text); // reconcile: a comment that landed before a timeout is adopted, not duplicated
    remoteIds.push(`comment:${comment.id}`);
    for (const e of batch) d.fs.markSynced(e.eventId, { state: "SENT", remoteId: `comment:${comment.id}`, attempts: e.sync.attempts + 1 });
    let patch: Partial<IssueBinding> = { lastSyncAt: iso(now), failures: 0, retryAfter: undefined };
    if (rec.issue.createdByCie && rec.issue.syncState !== "DIVERGED" && remote) {
      const fresh = buildProjection(d.fs, d.fs.getRequest(rec.requestId)!, { visibility: rec.issue.visibility ?? "PUBLIC_OR_UNKNOWN", availableLabels: rec.issue.labels ?? [], policy });
      if (fresh.blockHash !== rec.issue.projectionHash) { await d.forge.updateIssue(repo, number, { body: `${markerFor(rec.requestId)}\n${guardOutgoing(rec, fresh.block, rec.issue.visibility ?? "PUBLIC_OR_UNKNOWN")}` }); patch = { ...patch, projectionHash: fresh.blockHash, projectionRevision: rec.issue.projectionRevision + 1 }; }
    }
    // closure: CIE closes only an issue it opened, and only for a cancelled request; it never closes a person's issue
    const cur = d.fs.getRequest(rec.requestId)!;
    if (cur.state === "CANCELLED" && rec.issue.createdByCie && batchAll.length === batch.length && batch.some((e) => e.type === "Cancelled")) {
      const live = remote ?? await d.forge.getIssue(repo, number);
      if (live.state === "open") { await d.forge.updateIssue(repo, number, { state: "closed", stateReason: "not_planned" }); warnings.push("the issue was closed as not planned because the request was cancelled"); }
    }
    saveIssue(d, rec.requestId, actor, patch, `issue trail: ${batch.length} milestone(s) posted`);
    return settle({ sent: batch.length, remoteIds, ...(warnings.length ? { warnings } : {}) });
  } catch (e) {
    if (e instanceof FeatureError) { rec = d.fs.getRequest(rec.requestId)!; throw e; }
    const failures = (rec.issue.failures ?? 0) + 1;
    const rate = e instanceof GhError && e.state === "RATE_LIMITED";
    const backoff = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (failures - 1));
    for (const ev of batch) d.fs.markSynced(ev.eventId, { state: "FAILED", attempts: ev.sync.attempts + 1 });
    rec = saveIssue(d, rec.requestId, actor, { failures, retryAfter: iso(now + backoff), syncState: "UNSYNCED" }, `issue trail failed (${e instanceof GhError ? e.state : "error"}); retry after ${iso(now + backoff)}`, "FAILED");
    if (rate) return settle({ sent: 0, deferredUntil: rec.issue.retryAfter, warnings: [`GitHub rate limit: retrying after ${rec.issue.retryAfter}; the milestones stay in the outbox`] });
    return ghFail(e);
  }
}
