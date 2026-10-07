// Task 3.R (continued) — reviewer feedback on the published draft PR, and what must be re-checked after a revision (PF-051, AT-23, AT-30, AT-40).
//   * Feedback text is DATA. It is classified by fixed rules, stored as a redacted excerpt, and never executed or followed.
//   * One record per external event id: replays and out-of-order delivery change nothing. Feedback that targets an older head is
//     kept and marked, never silently applied to the current one; feedback on a head this request never published is flagged.
//   * A POLICY-class comment needs an authority decision; it is routed, not auto-applied. Preferences never force revalidation.
//   * scopeRevalidation orders the re-checks by what changed. Eligibility is still computeEligibility() on the NEW binding, so a
//     check that is not re-run remains a NOT_RUN gap there: scoping speeds up feedback, it never lets old evidence count.
import { execFileSync } from "node:child_process";
import { classifyGhFailure, GhError, type GhRunner } from "../gh-forge.ts";
import { redactText } from "./redact.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, CoverageRecord, FeatureRecord, Id, Outcome, ReviewFeedback, RevalidationPlan, ValidationKind } from "./types.ts";
import { defaultValidationPlan, validationHash } from "./validation.ts";

export type ReviewEvent = { eventId: string; pullRequestId: string; kind: "REVIEW" | "COMMENT" | "INLINE"; author: string; body: string; headHash: string; createdAt: string; path?: string };
/** Where review events come from. Production reads them with `gh`; tests script them. */
export interface ReviewSource { events(repository: string, prNumber: number): Promise<ReviewEvent[]> }

export class GhReviewSource implements ReviewSource {
  private readonly run: GhRunner;
  constructor(run?: GhRunner) {
    this.run = run ?? ((args) => { try { return { status: 0, stdout: execFileSync("gh", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; } catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string; message?: string }; return { status: x.status ?? 1, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message ?? "") }; } });
  }
  private api(path: string): any[] { const r = this.run(["api", "-X", "GET", path, "-f", "per_page=100"]); if (r.status !== 0) throw classifyGhFailure(r.status, r.stderr); try { const j = JSON.parse(r.stdout || "[]"); return Array.isArray(j) ? j : []; } catch { throw new GhError("UNREACHABLE", "gh returned output that is not JSON"); } }
  async events(repository: string, n: number): Promise<ReviewEvent[]> {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new GhError("NOT_FOUND", "not an owner/name repository");
    const pr = `${n}`;
    return [
      ...this.api(`repos/${repository}/pulls/${n}/reviews`).map((x): ReviewEvent => ({ eventId: `review:${x.id}`, pullRequestId: pr, kind: "REVIEW", author: String(x.user?.login ?? ""), body: String(x.body ?? ""), headHash: String(x.commit_id ?? ""), createdAt: String(x.submitted_at ?? "") })),
      ...this.api(`repos/${repository}/pulls/${n}/comments`).map((x): ReviewEvent => ({ eventId: `inline:${x.id}`, pullRequestId: pr, kind: "INLINE", author: String(x.user?.login ?? ""), body: String(x.body ?? ""), headHash: String(x.commit_id ?? ""), createdAt: String(x.created_at ?? ""), path: x.path ? String(x.path) : undefined })),
    ];
  }
}

// ------------------------------------------------------------------------------------------------ classification

const RULES: { cls: ReviewFeedback["classification"]; re: RegExp }[] = [
  { cls: "POLICY", re: /\b(security|permission|access control|authori[sz]|tenant|compliance|licen[cs]e|secret|credential|pii|gdpr|policy)\b/i },
  { cls: "REQUIREMENT", re: /\b(must (also )?support|should also|needs? to (also )?(support|handle|include)|please add|missing (support|feature|requirement)|new requirement|in addition|we (also )?need)\b/i },
  { cls: "CORRECTION", re: /\b(bug|wrong|incorrect|broken|fails?|failing|crash(es)?|typo|off[- ]by[- ]one|regression|does ?n[o']t work|should (return|be)|expected)\b/i },
  { cls: "PREFERENCE", re: /\b(nit|nitpick|prefer|style|naming|rename|maybe|consider|optional|minor|cosmetic|formatting)\b/i },
];
export function classifyFeedback(body: string): { classification: ReviewFeedback["classification"]; routing: string; requiresAuthority?: string } {
  const hit = RULES.find((r) => r.re.test(body));
  const classification = hit?.cls ?? "PREFERENCE"; // unmatched text is a comment, not a demand
  const routing = { POLICY: "needs an authority decision before anything changes", REQUIREMENT: "changes the contract: record a decision and revise it, then rebuild", CORRECTION: "fix within the current contract, then revalidate the affected checks", PREFERENCE: "optional; no revalidation unless it is applied" }[classification];
  return { classification, routing, ...(classification === "POLICY" ? { requiresAuthority: "policy" } : {}) };
}

const excerptOf = (b: string): string => redactText(b.replace(/\s+/g, " ").trim()).slice(0, 280);

export interface ReviewDeps { fs: SqliteFeatureStore; source: ReviewSource; now?: () => string }

export async function ingestReviewFeedback(d: ReviewDeps, actor: Id, i: { requestId: Id; pullRequestId: string; externalEventId: string; headHash: string }): Promise<Outcome<ReviewFeedback>> {
  const rec = d.fs.getRequest(i.requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (typeof i.externalEventId !== "string" || !i.externalEventId) throw new FeatureError("INVALID_SCHEMA", "externalEventId is required");
  const published = d.fs.listCandidates(rec.requestId).filter((c) => c.publication?.kind === "DRAFT_PR");
  const pubs = published.map((c) => c.publication!);
  const pr = pubs.find((p) => String(p.prNumber) === String(i.pullRequestId).replace(/^#/, ""));
  if (!pr || !pr.repository) throw new FeatureError("NOT_FOUND", "this request has no such draft pull request");
  const seen = rec.reviewFeedback?.find((f) => f.externalEventId === i.externalEventId);
  if (seen) return { status: "COMPLETE", value: seen, evidenceIds: [], diagnostics: ["already ingested"] };
  const events = await d.source.events(pr.repository, pr.prNumber!);
  const ev = events.find((e) => e.eventId === i.externalEventId);
  if (!ev) throw new FeatureError("NOT_FOUND", "the forge has no such review event");
  const headNow = pubs.at(-1)?.commit ?? pr.commit; // the commit most recently pushed for this request
  const known = new Set(pubs.map((p) => p.commit));
  const head = ev.headHash || i.headHash;
  const onCurrentHead = !!headNow && head === headNow;
  const status: NonNullable<ReviewFeedback["status"]> = onCurrentHead ? "OPEN" : known.has(head) ? "ON_OLDER_HEAD" : "UNKNOWN_HEAD";
  const c = classifyFeedback(ev.body);
  const fb: ReviewFeedback = {
    schemaVersion: 1, id: `feedback:${validationHash("pf.ReviewFeedbackId", { r: rec.requestId, e: ev.eventId }).split(":").pop()!.slice(0, 20)}`, classification: c.classification, headHash: head,
    externalEventId: ev.eventId, pullRequestId: String(pr.prNumber), author: ev.author.slice(0, 60), excerpt: excerptOf(ev.body), path: ev.path, onCurrentHead, status, routing: c.routing, requiresAuthority: c.requiresAuthority,
    receivedAt: (d.now ?? (() => new Date().toISOString()))(),
  };
  // Re-read under the compare-and-swap: two events ingested at once must both land.
  for (let attempt = 0; ; attempt++) {
    const cur = d.fs.getRequest(rec.requestId)!;
    if (cur.reviewFeedback?.some((f) => f.externalEventId === fb.externalEventId)) break;
    try {
      d.fs.updateRequest(cur.requestId, cur.version, { ...cur, reviewFeedback: [...(cur.reviewFeedback ?? []), fb], workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } },
        eventFor(cur, "ReviewFeedbackIngested", actor, { after: undefined, rationale: `${fb.classification} on ${status === "OPEN" ? "the current head" : status === "ON_OLDER_HEAD" ? "an older head" : "an unknown head"}` }));
      break;
    } catch (e) { if (!(e instanceof FeatureError && e.code === "VERSION_CONFLICT") || attempt > 4) throw e; }
  }
  const notes = [...(status === "OPEN" ? [] : [status === "ON_OLDER_HEAD" ? "this comment was made on an older head; check that it still applies" : "this comment targets a head this request never published"]), ...(c.requiresAuthority ? ["needs an authority decision"] : [])];
  return { status: status === "OPEN" ? "COMPLETE" : "PARTIAL", value: fb, evidenceIds: [], diagnostics: notes };
}

// ------------------------------------------------------------------------------------------------ scoped revalidation

const isDoc = (p: string) => /\.(md|mdx|txt)$|(^|\/)docs?\//i.test(p);
const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
const isUi = (p: string) => /\.(tsx|jsx|html|css|vue|svelte)$/.test(p);
const isDep = (p: string) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p);

/** Files whose resulting content differs between two candidates (so a file changed in neither, or changed identically in both, is not "new"). */
export function changedBetween(oldC: CandidateRecord, newC: CandidateRecord): string[] {
  const a = oldC.contents ?? {}, b = newC.contents ?? {}, out = new Set<string>();
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) if ((p in a ? a[p] : undefined) !== (p in b ? b[p] : undefined)) out.add(p);
  return [...out].sort();
}

export function scopeRevalidation(d: { fs: SqliteFeatureStore }, actor: Id, i: { oldBinding: string; newBinding: string; feedbackIds: Id[]; coverage: CoverageRecord[] }): Outcome<RevalidationPlan> {
  const oldC = d.fs.getCandidateByBinding(i.oldBinding), newC = d.fs.getCandidateByBinding(i.newBinding);
  if (!oldC || !newC || oldC.requestId !== newC.requestId) throw new FeatureError("NOT_FOUND", "both bindings must name candidates of the same request");
  const rec = d.fs.getRequest(newC.requestId)!;
  if (rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", "no such candidate");
  if (!Array.isArray(i.feedbackIds) || !Array.isArray(i.coverage)) throw new FeatureError("INVALID_SCHEMA", "feedbackIds and coverage are lists");
  const changed = changedBetween(oldC, newC);
  const rerun = new Set<ValidationKind>(["SECURITY"]); // the secret scan always runs on whatever left
  const broader: string[] = [];
  const feedback = (rec.reviewFeedback ?? []).filter((f) => i.feedbackIds.includes(f.id));
  const missing = i.feedbackIds.filter((id) => !feedback.some((f) => f.id === id));
  if (missing.length) throw new FeatureError("NOT_FOUND", `no such feedback: ${missing.join(", ")}`);
  const code = changed.filter((p) => !isDoc(p) && !isTest(p));
  if (code.length) { rerun.add("BUILD"); rerun.add("UNIT"); }
  if (changed.some(isTest)) rerun.add("UNIT");
  if (changed.some(isUi)) rerun.add("BROWSER");
  if (changed.some(isDep)) { rerun.add("DEPENDENCY"); rerun.add("BUILD"); rerun.add("UNIT"); broader.push("a dependency manifest changed: the whole dependency and build surface is re-checked"); }
  const plan = rec.validationPlan ?? defaultValidationPlan(rec, newC);
  if (plan.performanceApplicable && code.length) rerun.add("PERFORMANCE");
  if (code.length && newC.mutations.some((m) => /(^|\/)(auth|access|tenant|permission)/i.test(m.newPath ?? m.oldPath ?? ""))) { rerun.add("INTEGRATION"); broader.push("the change touches access or tenancy code"); }
  if (oldC.binding.candidateOracleHash !== newC.binding.candidateOracleHash) { for (const k of ["BUILD", "UNIT", "INTEGRATION"] as const) rerun.add(k); broader.push("the oracle changed between the two candidates: everything that depends on it is re-checked"); }
  if (feedback.some((f) => f.classification === "POLICY")) { rerun.add("SECURITY"); rerun.add("DEPENDENCY"); broader.push("policy feedback: security and dependency gates are re-run"); }
  if (feedback.some((f) => f.classification === "REQUIREMENT")) { rerun.add("UNIT"); rerun.add("INTEGRATION"); broader.push("a requirement changed: acceptance checks are re-run"); }
  // Unknown coverage means impact analysis cannot narrow the test run (plan P3): run the whole suite.
  const unknown = !plan.coverageKnown || i.coverage.some((c) => c.state !== "COMPLETE_WITHIN_SCOPE");
  if (unknown && rerun.has("UNIT")) broader.push("test coverage is unknown or partial: the full suite runs, not a selection");
  if (!changed.length) broader.push("the two candidates have identical content: nothing changed to scope by");
  // Prior evidence is shown for triage only. It was made on another binding, so computeEligibility will not count it.
  const prior = d.fs.listEvidence(oldC.id).filter((e) => !e.verdict && !rerun.has(e.kind)).map((e) => e.id);
  return { status: "COMPLETE", value: { schemaVersion: 1, id: validationHash("pf.RevalidationPlan", { o: i.oldBinding, n: i.newBinding, f: [...i.feedbackIds].sort() }), rerun: [...rerun].sort(), reuse: prior, broaderBecause: [...new Set(broader)] }, evidenceIds: prior, diagnostics: ["old evidence is for triage only; the new binding needs its own run before it can be verified", ...(changed.length ? [`${changed.length} file(s) differ between the candidates`] : [])] };
}
export type { FeatureRecord };
