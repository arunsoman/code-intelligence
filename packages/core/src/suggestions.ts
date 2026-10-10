// F16 — validated inline fix suggestions (§1–§17).
//
// A suggestion is a projection of an existing validated fix candidate (§5), never a new candidate type: the
// candidate id and validation hash travel with the posting so F02's verifyBinding semantics apply. The gate (§7.2)
// admits only single-file, single-hunk, non-test edits on paths classifyTier does not call T2, bound to the exact
// PR head; validation (§7.3) re-runs in a scratch copy under the isolation budget and records every check that
// ran and every check that could not. The rendered comment (§7.4) carries the validated replacement bytes
// byte-identical in a fence longer than any backtick run inside them, states which checks ran and which did not,
// and never pushes to the PR branch — the author applies it (§10.1). When the head moves the suggestion is
// superseded in place, old text kept as history (§11); application is observed on the next analysed head (§7.6)
// and never feeds ranking (F15 §7.2 rule 5).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Store } from "./store.ts";
import { classifyTier } from "./feature/tiers.ts";
import { isTestPath } from "./execution.ts";
import { redactText } from "./feature/redact.ts";
import { escapeForgeText } from "./impact-render.ts";
import { applyTextEdits, compareDiagnostics, copyTree, makeScratch, removeScratch, runTestsIn, type TextEdit } from "./isolated-exec.ts";
import { githubApiBase, ghAuthToken, githubRemote, type GhSlug } from "./gh.ts";

const nowIso = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** §7.2 D2: at most this many lines changed in a suggestible edit (uncalibrated). */
export const DEFAULT_MAX_LINES = 10;
/** §7.5: at most this many suggestions posted per PR, so a review stays one notification. */
export const DEFAULT_PER_PR_CAP = 3;
/** The comment budget: a suggestion is small by rule; the guard refuses rather than trims (§10.3). */
export const SUGGESTION_BUDGET_BYTES = 12_288;
/** §11: one posting per (finding, head, replacement) — the marker makes the comment findable for find-before-create. */
export const SUGGESTION_MARKER_PREFIX = "<!-- cie-suggestion:";
export const suggestionMarker = (id: string) => `${SUGGESTION_MARKER_PREFIX}${id} -->`;
export const MANDATORY_CHECKS = ["type-check", "finding re-analysis"];

// ---------------------------------------------------------------- data model (§6)

export type SuggestionState = "PREPARED" | "POSTED" | "SUPERSEDED" | "APPLIED" | "DISMISSED" | "FAILED";
export interface SuggestionCheck { name: string; outcome: "PASSED" | "FAILED" | "NOT_RUN"; detail: string }
export interface SuggestionRecord {
  id: string; analysisId: string; findingId: string; candidateId: string; validationHash: string;
  headHash: string; path: string; startLine: number; endLine: number;
  /** The bytes the anchor range is replaced with — stored so a crash after validation can re-post (§11). */
  expected: string; replacement: string; replacementHash: string;
  checks: SuggestionCheck[];
  state: SuggestionState; externalId?: string; idempotencyKey: string; postedAt?: string; observedAt?: string;
  createdBy: string; createdAt: string;
}

/** A fix candidate as the existing pipeline exposes it (§7.1): byte-exact edits bound to an exact base. */
export interface FixCandidate {
  id: string; findingId: string;
  /** The tree the candidate was validated against — must equal the PR head hash (gate rule 1). */
  baseHash: string;
  /** Byte-exact edits. A suggestible candidate has exactly one; more is a draft-PR shape (§7.2 rule 2). */
  edits: TextEdit[];
  /** Files the candidate creates, renames to, or deletes — any makes it ineligible (§7.2 rule 4). */
  creates?: string[]; renames?: { from: string; to: string }[]; deletes?: string[];
  /** Hash of the recorded validation the candidate carries (§5). */
  validationHash: string;
  /** The gate's ORACLE_PRESERVED condition: false means the edit weakens an existing test or assertion. */
  oraclePreserved: boolean;
  /** §7.3: re-run the detector that raised the finding on the patched file text. Absent → the check is NOT_RUN. */
  recheck?: (patched: { file: string; text: string }) => { findingGone: boolean; newFindings: string[] };
}
/** §7.1: where a candidate for a PR finding comes from. Returning null means "no validated fix is available". */
export interface CandidateProvider { candidateFor(findingId: string, headHash: string): Promise<FixCandidate | null> }

interface SuggestionRow {
  id: string; analysis_id: string; finding_id: string; candidate_id: string; validation_hash: string;
  head_hash: string; path: string; start_line: number; end_line: number;
  expected: string; replacement: string; replacement_hash: string; checks: string;
  state: string; external_id: string | null; idempotency_key: string; posted_at: string | null; observed_at: string | null;
  created_by: string; created_at: string;
}

const rowOf = (r: SuggestionRow): SuggestionRecord => ({
  id: r.id, analysisId: r.analysis_id, findingId: r.finding_id, candidateId: r.candidate_id, validationHash: r.validation_hash,
  headHash: r.head_hash, path: r.path, startLine: r.start_line, endLine: r.end_line,
  expected: r.expected, replacement: r.replacement, replacementHash: r.replacement_hash,
  checks: JSON.parse(r.checks) as SuggestionCheck[],
  state: r.state as SuggestionState, externalId: r.external_id ?? undefined, idempotencyKey: r.idempotency_key,
  postedAt: r.posted_at ?? undefined, observedAt: r.observed_at ?? undefined, createdBy: r.created_by, createdAt: r.created_at,
});

export type GateResult = { ok: true; startLine: number; endLine: number } | { ok: false; rule: number; reason: string };

/**
 * §7.2 — every rule names itself in the refusal (§12); failing any rule yields a stated reason, not silence.
 * ctx.readFile must return the head tree's bytes for a path (null when absent); ctx.deniedPrefixes drives the
 * count-only reply (§10.6); ctx.anchorAllowed is the per-forge diff-range check (rule 6, F19 — default admits).
 */
export function suggestionGate(c: FixCandidate, ctx: {
  headHash: string; readFile: (path: string) => string | null; deniedPrefixes: string[];
  maxLines?: number; anchorAllowed?: (path: string, startLine: number, endLine: number) => boolean;
}): GateResult {
  // 1. the candidate's base equals the PR head hash
  if (c.baseHash !== ctx.headHash) return { ok: false, rule: 1, reason: "the candidate's base does not equal the PR head; a candidate validated against another base is ineligible (§7.2 rule 1)" };
  const edits = c.edits ?? [];
  const structural = edits.length !== 1 || (c.creates?.length ?? 0) > 0 || (c.renames?.length ?? 0) > 0 || (c.deletes?.length ?? 0) > 0;
  // 2. one file, one contiguous replacement, at most maxLines lines changed
  if (structural) {
    const why = (c.creates?.length ?? 0) > 0 ? "it creates a file" : (c.deletes?.length ?? 0) > 0 ? "it deletes a file" : (c.renames?.length ?? 0) > 0 ? "it renames a file" : `it touches ${new Set(edits.map((e) => e.file)).size} file(s) in ${edits.length} hunk(s)`;
    return { ok: false, rule: 2, reason: `a suggestion must be one file and one contiguous replacement (§7.2 rule 2); ${why} — that shape stays a draft PR (F07)` };
  }
  const edit = edits[0]!;
  const maxLines = ctx.maxLines ?? DEFAULT_MAX_LINES;
  const changedLines = Math.max(edit.expected.split("\n").length, edit.newText.split("\n").length);
  if (changedLines > maxLines) return { ok: false, rule: 2, reason: `the edit changes ${changedLines} lines; the suggestion limit is ${maxLines} (uncalibrated, D2) — a larger fix stays a draft PR (F07)` };
  // 7. the path is not under a prefix the principal cannot see (counted, never named — §10.6)
  if (ctx.deniedPrefixes.some((p) => edit.file === p || edit.file.startsWith(p + "/")))
    return { ok: false, rule: 7, reason: "1 path is withheld by the access policy; it is counted, never suggested (§10.6)" };
  // 3. no high-impact path, no dependency, install-script, workflow or configuration change
  const tier = classifyTier([{ path: edit.file, kind: "MODIFIED" }]);
  if (tier.tier === "T2") return { ok: false, rule: 3, reason: `the path matches a high-impact pattern (${tier.reasons[0]}) — dependency, configuration and auth-adjacent edits are never suggested (§7.2 rule 3, §10.5)` };
  // 4. no file is created, renamed or deleted, and the head tree still holds the quoted bytes
  const headText = ctx.readFile(edit.file);
  if (headText === null) return { ok: false, rule: 4, reason: `the head tree no longer contains ${basename(edit.file)}; the candidate is stale` };
  // 5. the edit does not remove or weaken an existing test or assertion; test-file edits are ineligible in this release (D3)
  if (isTestPath(edit.file)) return { ok: false, rule: 5, reason: "edits to test files are ineligible in the first release (D3); a test change is a property change and needs its own review" };
  if (!c.oraclePreserved) return { ok: false, rule: 5, reason: "the candidate's recorded validation shows the original oracle is not preserved (ORACLE_PRESERVED failed); it may weaken an existing assertion (§7.2 rule 5)" };
  if (headText.slice(edit.start, edit.end) !== edit.expected)
    return { ok: false, rule: 4, reason: "the head tree no longer holds the quoted bytes at the recorded position; the candidate is stale (§14)" };
  const lineOf = (byte: number) => headText.slice(0, Math.min(byte, headText.length)).split("\n").length;
  const startLine = lineOf(edit.start), endLine = lineOf(Math.max(edit.start, edit.end - 1));
  // 6. the anchored range lies where the forge allows review comments on this PR (checked per forge, F19)
  if (ctx.anchorAllowed && !ctx.anchorAllowed(edit.file, startLine, endLine))
    return { ok: false, rule: 6, reason: `the anchor ${edit.file}:${startLine}-${endLine} lies outside the lines the forge allows review comments on for this PR (§7.2 rule 6)` };
  return { ok: true, startLine, endLine };
}

// ---------------------------------------------------------------- validation on the head tree (§7.3)

export interface SuggestionValidation { checks: SuggestionCheck[]; ok: boolean; validationHash: string }
/** The validation seam: tests substitute a fake; production uses validateOnHead. */
export type SuggestionValidator = (input: { repoRoot: string; candidate: FixCandidate; headHash: string }) => Promise<SuggestionValidation>;

export interface ValidationRunDeps { runTests?: typeof runTestsIn }
const checkName = { applied: "applied the edit (stale check)", typecheck: "type-check", tests: "tests", recheck: "finding re-analysis" } as const;

/**
 * §7.3 — run every check that can run in a scratch copy; any check that cannot run is recorded NOT_RUN with the
 * reason and shown under "Not checked" (§7.4). A FAILED check stops the suggestion; the record keeps every check.
 */
export function validateOnHead(deps: ValidationRunDeps = {}): SuggestionValidator {
  const runTests = deps.runTests ?? runTestsIn;
  return async ({ repoRoot, candidate }) => {
    const checks: SuggestionCheck[] = [];
    const edit = candidate.edits[0]!;
    const scratch = makeScratch("cie-suggest-"), base = makeScratch("cie-suggest-base-");
    try {
      let patchedText: string | null = null;
      try {
        copyTree(repoRoot, scratch); copyTree(repoRoot, base);
        applyTextEdits(scratch, [edit]); // refuses when the quoted bytes moved (STALE_REVISION)
        try { patchedText = readFileSync(join(scratch, edit.file), "utf8"); } catch { patchedText = null; }
        checks.push({ name: checkName.applied, outcome: "PASSED", detail: "the edit applied byte-exact in a scratch copy" });
      } catch (e) {
        const stale = (e as { code?: string }).code === "STALE_REVISION";
        checks.push({ name: checkName.applied, outcome: "FAILED", detail: stale ? "the quoted bytes are no longer at their recorded position (the head moved)" : `the scratch run could not apply the edit: ${String((e as Error).message ?? e).slice(0, 160)}` });
      }
      if (checks[0]?.outcome === "PASSED") {
        // type-check: no new diagnostics against the head baseline (positions dropped, so moved code is not a new error)
        try {
          const diff = compareDiagnostics(base, scratch);
          checks.push(diff.introduced.length
            ? { name: checkName.typecheck, outcome: "FAILED", detail: `${diff.introduced.length} new diagnostic(s): ${diff.introduced.slice(0, 3).join(" · ").slice(0, 240)}` }
            : { name: checkName.typecheck, outcome: "PASSED", detail: "no new diagnostics against the head baseline" });
        } catch (e) { checks.push({ name: checkName.typecheck, outcome: "NOT_RUN", detail: `the type-check could not run: ${String((e as Error).message ?? e).slice(0, 160)}` }); }
        // tests: the checkout's suite under the permission model, bounded
        try {
          const run = runTests(scratch, 120_000);
          checks.push(!run.ran
            ? { name: checkName.tests, outcome: "NOT_RUN", detail: `tests could not run: ${run.reason ?? run.output.slice(0, 120)}` }
            : run.failed > 0
              ? { name: checkName.tests, outcome: "FAILED", detail: `${run.passed} run, ${run.failed} failed` }
              : { name: checkName.tests, outcome: "PASSED", detail: `${run.passed} test(s) run, ${run.passed} passed` });
        } catch (e) { checks.push({ name: checkName.tests, outcome: "NOT_RUN", detail: `tests could not run: ${String((e as Error).message ?? e).slice(0, 160)}` }); }
        // finding re-analysis on the patched tree: the finding is gone and no new finding appears
        if (candidate.recheck) {
          try {
            const r = candidate.recheck({ file: edit.file, text: patchedText ?? "" });
            checks.push(!r.findingGone
              ? { name: checkName.recheck, outcome: "FAILED", detail: "the detector still reports the finding on the patched tree" }
              : r.newFindings.length
                ? { name: checkName.recheck, outcome: "FAILED", detail: `the detector reports ${r.newFindings.length} new finding(s) on the patched tree` }
                : { name: checkName.recheck, outcome: "PASSED", detail: "finding no longer present on re-analysis; no new findings introduced" });
          } catch (e) { checks.push({ name: checkName.recheck, outcome: "NOT_RUN", detail: `the detector could not re-run: ${String((e as Error).message ?? e).slice(0, 160)}` }); }
        } else checks.push({ name: checkName.recheck, outcome: "NOT_RUN", detail: "no detector is registered for this finding in this build" });
      } else {
        checks.push({ name: checkName.typecheck, outcome: "NOT_RUN", detail: "the edit did not apply; the dependent checks did not run" });
        checks.push({ name: checkName.tests, outcome: "NOT_RUN", detail: "the edit did not apply; the dependent checks did not run" });
        checks.push({ name: checkName.recheck, outcome: "NOT_RUN", detail: "the edit did not apply; the dependent checks did not run" });
      }
    } finally { removeScratch(scratch); removeScratch(base); }
    const ok = checks.every((c) => c.outcome === "PASSED");
    return { checks, ok, validationHash: sha(JSON.stringify(checks)) };
  };
}
// ---------------------------------------------------------------- rendering (§7.4) and the egress guard (§10.3)

/** The fence for the suggestion block: strictly longer than any backtick run inside the replacement (§7.4, §10.4). */
export function fenceFor(text: string): string {
  let run = 0, max = 0;
  for (const ch of text) { run = ch === "`" ? run + 1 : 0; if (run > max) max = run; }
  return "`".repeat(Math.max(3, max + 1));
}

export const SUGGESTION_FOOTER = "This is a suggestion; applying it is your decision. CIE never pushes to the PR branch.";
const NOT_CHECKED_FIXED = "behaviour under concurrency · tests outside the recorded set · production data";

/** §7.4 — the body is generated from the validated replacement bytes, never from model text. */
export function renderSuggestionBody(rec: Pick<SuggestionRecord, "id" | "findingId" | "headHash" | "path" | "startLine" | "endLine" | "replacement" | "checks">): string {
  const fence = fenceFor(rec.replacement);
  const passed = rec.checks.filter((c) => c.outcome === "PASSED");
  const notRun = rec.checks.filter((c) => c.outcome === "NOT_RUN");
  const ran = passed.map((c) => c.detail.endsWith(".") ? c.detail : c.detail + ".").join(" · ");
  const notChecked = [...notRun.map((c) => c.detail.replace(/^[^:]+:\s*/, "").replace(/\.$/, "")), NOT_CHECKED_FIXED];
  const out = [
    suggestionMarker(rec.id),
    `**Suggested change** — for finding ${escapeForgeText(rec.findingId)} (introduced by this PR) · bound to head ${rec.headHash.slice(0, 7)} · ${escapeForgeText(rec.path)}:${rec.startLine}-${rec.endLine}`,
    "",
    `${fence}suggestion`,
    rec.replacement.replace(/\n$/, ""),
    fence,
    "",
    `Validated within the scope of the recorded checks: ${ran}`,
    `Not checked: ${notChecked.join(" · ")}.`,
    SUGGESTION_FOOTER,
  ];
  return out.join("\n");
}

/** §11 — superseded in place: the old text stays visible, a line says the head moved on. */
export function renderSupersededBody(rec: SuggestionRecord, nowHead: string): string {
  return `${renderSuggestionBody(rec)}\n\n**Superseded** — the PR head moved to ${nowHead.slice(0, 7)}; this suggestion no longer applies. Kept as history.`;
}

/**
 * §10.3 — the fail-closed guard over the final text (G5: the leak guard is code-fence aware, not comment-shaped).
 * The text is refused, never altered. Rules: budget; the replacement bytes appear byte-identical inside a fence
 * longer than any backtick run; the fixed caveat is present; no secret-like content (redactText is identity);
 * template copy never claims "fixed".
 */
export function checkSuggestionBody(body: string, rec: Pick<SuggestionRecord, "replacement" | "replacementHash">): { ok: true } | { ok: false; reason: string } {
  if (Buffer.byteLength(body, "utf8") > SUGGESTION_BUDGET_BYTES) return { ok: false, reason: `the suggestion body is over the ${SUGGESTION_BUDGET_BYTES}-byte budget` };
  const fence = fenceFor(rec.replacement);
  const block = `${fence}suggestion\n${rec.replacement.replace(/\n$/, "")}\n${fence}`;
  if (!body.includes(block)) return { ok: false, reason: "the rendered body is not byte-identical to the validated replacement (§7.3)" };
  if (sha(rec.replacement) !== rec.replacementHash) return { ok: false, reason: "the replacement does not match its recorded hash; the validated bytes were not altered (F16-A4)" };
  if (!body.includes(SUGGESTION_FOOTER)) return { ok: false, reason: "the fixed caveat line is missing" };
  if (/\b(fixes|resolves)\b/i.test(body.split("\n").slice(0, 3).join(" "))) return { ok: false, reason: "the copy claims more than a suggestion (§12)" };
  if (redactText(body) !== body) return { ok: false, reason: "the final text still contains something that looks like a secret or personal data; nothing was sent (§10.3)" };
  return { ok: true };
}

// ---------------------------------------------------------------- review-comment transport (§8; per-forge in F19)

export interface ReviewCommentInput { path: string; startLine: number; endLine: number; body: string }
export interface ReviewCommentTransport {
  /** §10.2: the review event is fixed to COMMENT; any other event is refused by the transport itself (F16-A9). */
  submitReview(prNumber: number, headSha: string, comments: ReviewCommentInput[], event: "COMMENT"): Promise<{ id: string }>;
  updateReviewComment(commentId: string, body: string): Promise<{ id: string }>;
  findReviewComment(prNumber: number, marker: string): Promise<{ id: string; body: string } | null>;
  /** The PR's head right now, when the forge can say (stale-head guard, §11); null/undefined skips the check. */
  resolveHead?(prNumber: number): Promise<string | null>;
}
/** F16-A9: the transport refuses to submit anything but a COMMENT review, whatever the caller passes. */
export function assertCommentEvent(event: string): asserts event is "COMMENT" {
  if (event !== "COMMENT") throw new Error(`Refused: a CIE review never approves or requests changes; the only review event is COMMENT (§10.2), not ${event}`);
}

/** The GitHub REST review-comment side (G1). The token is read at call time (gh) and never stored (§10). */
export function githubReviewRestTransport(slug: GhSlug): ReviewCommentTransport {
  const api = (path: string) => `${githubApiBase(slug)}/repos/${slug.owner}/${slug.repo}${path}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const token = ghAuthToken(slug.host);
    let res: Response;
    try {
      res = await fetch(api(path), {
        method, headers: {
          ...(token.ok ? { authorization: `Bearer ${token.token}` } : {}),
          accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw new Error(`GitHub did not answer: ${String((e as Error).message ?? e).slice(0, 120)}`); }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* empty body */ }
    return { status: res.status, json };
  };
  const idOf = (json: unknown, fallback: string) => {
    const j = json as { id?: number; html_url?: string } | null;
    return { id: String(j?.id ?? fallback), ...(j?.html_url ? { url: j.html_url } : {}) };
  };
  return {
    submitReview: async (prNumber, headSha, comments, event) => {
      assertCommentEvent(event); // §10.2: never approve, never request changes
      const { status, json } = await call("POST", `/pulls/${prNumber}/reviews`, {
        commit_id: headSha, event,
        comments: comments.map((c) => ({
          path: c.path, body: c.body, side: "RIGHT", line: c.endLine,
          ...(c.startLine !== c.endLine ? { start_line: c.startLine, start_side: "RIGHT" } : {}),
        })),
      });
      if (status >= 400) throw new Error(`submitting the review answered ${status}`);
      return idOf(json, `review-${prNumber}-${sha(headSha + JSON.stringify(comments)).slice(0, 10)}`);
    },
    updateReviewComment: async (commentId, body) => {
      const { status, json } = await call("PATCH", `/pulls/comments/${commentId}`, { body });
      if (status >= 400) throw new Error(`updating the review comment answered ${status}`);
      return idOf(json, commentId);
    },
    findReviewComment: async (prNumber, marker) => {
      const { status, json } = await call("GET", `/pulls/${prNumber}/comments?per_page=100`);
      if (status >= 400) return null;
      const list = (Array.isArray(json) ? json : []) as { id: number; body?: string; html_url?: string }[];
      const hit = list.find((c) => (c.body ?? "").includes(marker));
      return hit ? { id: String(hit.id), body: hit.body ?? "" } : null;
    },
    resolveHead: async (prNumber) => {
      const { status, json } = await call("GET", `/pulls/${prNumber}`);
      if (status === 404) return null;
      if (status >= 400) throw new Error(`resolving the PR's head answered ${status}`);
      return (json as { head?: { sha?: string } } | null)?.head?.sha ?? null;
    },
  };
}
/** The transport a repository publishes suggestions through: from that repository's GitHub origin remote. */
export function githubReviewTransportFor(repoRoot: string): ReviewCommentTransport {
  const slug = githubRemote(repoRoot);
  return githubReviewRestTransport(slug ?? { host: "github.com", owner: "", repo: "" });
}


// ---------------------------------------------------------------- the engine: prepare, publish, observe

export interface SuggestionEngineOpts {
  /** §7.1: where candidates come from; null (the default) means "no validated fix is available" for every finding. */
  provider?: CandidateProvider | null;
  /** Full validation override (tests); production uses validateOnHead. */
  validate?: SuggestionValidator;
  /** Test-runner override for the default validator (tests). */
  runTests?: typeof runTestsIn;
  maxLines?: number;
  perPrCap?: number;
  now?: () => number;
}

export interface PrepareInput {
  analysisId: string; findingId: string; headHash: string; repoRoot: string; principalId: string;
  /** D4: only findings the PR introduced are suggestible. */
  introduced: boolean;
  /** §7.1: an explicit candidate (the pipeline's answer for the finding); null asks the provider. */
  candidate?: FixCandidate | null;
}
export type PrepareResult = { ok: true; record: SuggestionRecord; replayed: boolean } | { ok: false; reason: string };

export interface PublishInput {
  suggestionId: string; prNumber: number; repositoryId: string; principalId: string; grantId: string;
  transport: ReviewCommentTransport; idempotencyKey?: string;
  /** D8-style: a public forge destination may not receive text while the scope is narrower. */
  visibility?: "public" | "private";
  deniedPrefixes?: string[];
}
export type PublishResult =
  | { ok: true; record: SuggestionRecord; externalId: string; idempotent: boolean }
  | { ok: false; reason: string; code: "STALE" | "CAP" | "GUARD" | "FORBIDDEN" | "FAILED" };

interface GrantRow { id: string; repository_id: string; head_hash: string; decision_id: string | null; pending: number; principal_id: string; operation: string; expires_at: number; revoked: number; created_at: string }

/**
 * The suggestion engine over the store's `suggestions` table (§6). prepare runs the gate and the validation and
 * stores a PREPARED record (one per (finding, head, replacement) — §11); publish is grant-checked, refuses stale
 * heads, finds-before-creates by marker, caps per PR (§7.5) and guards the final text before anything leaves;
 * observe is a pure store transition for the next analysed head (§7.6, §11) that also produces the supersede
 * bodies the publisher writes back to the forge.
 */
export class SuggestionEngine {
  readonly store: Store;
  readonly provider: CandidateProvider | null;
  readonly validate: SuggestionValidator;
  readonly maxLines: number;
  readonly perPrCap: number;
  readonly now: () => number;

  constructor(store: Store, opts: SuggestionEngineOpts = {}) {
    this.store = store;
    this.provider = opts.provider ?? null;
    this.validate = opts.validate ?? validateOnHead({ runTests: opts.runTests });
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    this.perPrCap = opts.perPrCap ?? DEFAULT_PER_PR_CAP;
    this.now = opts.now ?? Date.now;
  }

  private row(id: string): SuggestionRow | null {
    return (this.store.db.prepare("select * from suggestions where id = ?").get(id) as SuggestionRow | undefined) ?? null;
  }
  record(id: string): SuggestionRecord | null { const r = this.row(id); return r ? rowOf(r) : null; }
  forAnalysis(analysisId: string): SuggestionRecord[] {
    return (this.store.db.prepare("select * from suggestions where analysis_id = ? order by created_at, id").all(analysisId) as unknown as SuggestionRow[]).map(rowOf);
  }
  private insert(rec: SuggestionRecord): void {
    this.store.db.prepare(`insert into suggestions values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rec.id, rec.analysisId, rec.findingId, rec.candidateId, rec.validationHash, rec.headHash, rec.path,
      rec.startLine, rec.endLine, rec.expected, rec.replacement, rec.replacementHash, JSON.stringify(rec.checks),
      rec.state, rec.externalId ?? null, rec.idempotencyKey, rec.postedAt ?? null, rec.observedAt ?? null, rec.createdBy, rec.createdAt);
  }
  private update(rec: SuggestionRecord): void {
    this.store.db.prepare(`update suggestions set state = ?, external_id = ?, posted_at = ?, observed_at = ?, checks = ? where id = ?`)
      .run(rec.state, rec.externalId ?? null, rec.postedAt ?? null, rec.observedAt ?? null, JSON.stringify(rec.checks), rec.id);
  }

  /** §11: the identity of one posting — the same (finding, head, replacement) re-prepares to the same record. */
  private identityKey(findingId: string, headHash: string, replacementHash: string): string {
    return sha(JSON.stringify([findingId, headHash, replacementHash]));
  }

  /** C28/prepareSuggestion (§8): gate → validate → store PREPARED. Read-only apart from the scratch run. */
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    if (!input.introduced) return { ok: false, reason: "the finding is not introduced by this PR; CIE does not suggest fixes for pre-existing findings (D4)" };
    const candidate = input.candidate !== undefined ? input.candidate : await this.provider?.candidateFor(input.findingId, input.headHash) ?? null;
    if (!candidate) return { ok: false, reason: "no validated fix is available for this finding (§7.1); CIE does not invent one" };
    if (candidate.findingId !== input.findingId) return { ok: false, reason: "the candidate belongs to a different finding" };
    const denied = this.store.deniedPrefixes(input.repoRoot);
    const gate = suggestionGate(candidate, {
      headHash: input.headHash, deniedPrefixes: denied, maxLines: this.maxLines,
      readFile: (path) => { try { return readFileSync(join(input.repoRoot, path), "utf8"); } catch { return null; } },
    });
    if (!gate.ok) return { ok: false, reason: `ineligible for a suggestion — ${gate.reason}` };
    const replacementHash = sha(candidate.edits[0]!.newText);
    const key = this.identityKey(input.findingId, input.headHash, replacementHash);
    const existing = this.store.db.prepare("select * from suggestions where finding_id = ? and head_hash = ? and replacement_hash = ?")
      .get(input.findingId, input.headHash, replacementHash) as SuggestionRow | undefined;
    if (existing) return { ok: true, record: rowOf(existing), replayed: true }; // §11: re-preparation is identity, not a second row
    const validation = await this.validate({ repoRoot: input.repoRoot, candidate, headHash: input.headHash });
    const edit = candidate.edits[0]!;
    const record: SuggestionRecord = {
      id: `sgg:${key.slice(0, 20)}`, analysisId: input.analysisId, findingId: input.findingId, candidateId: candidate.id,
      validationHash: sha(JSON.stringify([candidate.validationHash, validation.validationHash])),
      headHash: input.headHash, path: edit.file, startLine: gate.startLine, endLine: gate.endLine,
      expected: edit.expected, replacement: edit.newText, replacementHash,
      checks: validation.checks, state: "PREPARED", idempotencyKey: `sgp:${key.slice(0, 24)}`,
      createdBy: input.principalId, createdAt: new Date(this.now()).toISOString(),
    };
    this.insert(record);
    const mandatory = MANDATORY_CHECKS.every((name) => validation.checks.some((c) => c.name === name && c.outcome !== "NOT_RUN"));
    if (!validation.ok) {
      const failed = validation.checks.find((c) => c.outcome === "FAILED");
      if (failed) return { ok: false, reason: `validation did not pass — ${failed.name}: ${failed.detail}; nothing was posted (§7.3)` };
      if (!mandatory) return { ok: false, reason: `the mandatory checks did not all run (${MANDATORY_CHECKS.filter((name) => validation.checks.some((c) => c.name === name && c.outcome === "NOT_RUN")).join(", ")}) — nothing is postable (§13)` };
      return { ok: false, reason: "validation did not pass; nothing was posted (§7.3)" };
    }
    if (!mandatory) {
      const missing = MANDATORY_CHECKS.filter((name) => validation.checks.some((c) => c.name === name && c.outcome === "NOT_RUN"));
      return { ok: false, reason: `the mandatory checks did not all run (${missing.join(", ")}) — nothing is postable (§13)` };
    }
    return { ok: true, record, replayed: false };
  }

  /** The grant check the publisher runs itself, immediately before the external call (F02 §7.12 pattern). */
  private assertGrant(grantId: string, repositoryId: string, principalId: string): GrantRow {
    const g = this.store.db.prepare("select * from pr_grants where id = ?").get(grantId) as GrantRow | undefined;
    if (!g || g.revoked || Number(g.expires_at) < this.now() || g.operation !== "PUBLISH_SUGGESTION" || g.principal_id !== principalId || g.repository_id !== repositoryId)
      throw new Error("no live PUBLISH_SUGGESTION grant for this principal and repository");
    return g;
  }

  /** §13/A8: the record is postable only when it prepared clean and the mandatory checks ran. */
  postable(rec: SuggestionRecord): { ok: true } | { ok: false; reason: string } {
    const mandatory = MANDATORY_CHECKS.every((name) => rec.checks.some((c) => c.name === name && c.outcome !== "NOT_RUN"));
    if (!mandatory) return { ok: false, reason: `the mandatory checks did not all run (${MANDATORY_CHECKS.join(", ")}); nothing is posted (§13)` };
    if (rec.checks.some((c) => c.outcome === "FAILED")) return { ok: false, reason: "a recorded check failed; a suggestion is never posted from a failed validation (§7.3)" };
    return { ok: true };
  }

  /** C30/publishSuggestion (§8): mutating, grant-checked, find-before-create, capped per PR, guarded egress. */
  async publish(input: PublishInput): Promise<PublishResult> {
    const row = this.row(input.suggestionId);
    if (!row) return { ok: false, reason: "no such suggestion", code: "FORBIDDEN" };
    let rec = rowOf(row);
    if (rec.state === "POSTED") return { ok: true, record: rec, externalId: rec.externalId ?? "", idempotent: true }; // §11: a replay returns the same receipt
    if (rec.state !== "PREPARED") return { ok: false, reason: `a suggestion in state ${rec.state} is never posted (§9)`, code: "FORBIDDEN" };
    const canPost = this.postable(rec);
    if (!canPost.ok) { this.update({ ...rec, state: "FAILED" }); return { ok: false, reason: canPost.reason, code: "FAILED" }; }
    try {
      this.assertGrant(input.grantId, input.repositoryId, input.principalId);
      // D8: a public forge destination may not receive text while the analysis scope is narrower
      if (input.visibility === "public" && (input.deniedPrefixes ?? []).length)
        return { ok: false, reason: "the forge shows this repository publicly while the analysis scope is narrower; nothing is published", code: "FORBIDDEN" };
      // §11: a suggestion for a head that is no longer current is never posted
      const currentHead = await input.transport.resolveHead?.(input.prNumber) ?? null;
      if (currentHead && currentHead !== rec.headHash) {
        const superseded = this.applySupersede(rec, currentHead);
        await this.writeBackSuperseded(superseded, currentHead, input.transport).catch(() => undefined);
        return { ok: false, reason: `the PR's head moved after the suggestion was prepared (bound ${rec.headHash.slice(0, 7)}, now ${currentHead.slice(0, 7)}); it is superseded, not posted (§11)`, code: "STALE" };
      }
      // §7.5: the per-PR cap keeps the review one notification; the rest stay listed in one line
      const postedCount = Number((this.store.db.prepare("select count(*) n from suggestions where analysis_id = ? and state = 'POSTED'").get(rec.analysisId) as { n: number }).n);
      if (postedCount >= this.perPrCap) {
        const pending = this.forAnalysis(rec.analysisId).filter((r) => r.state === "PREPARED").length;
        return { ok: false, reason: `the per-PR cap of ${this.perPrCap} posted suggestion(s) holds; ${pending} further candidate(s) stay unposted (§7.5)`, code: "CAP" };
      }
      const body = renderSuggestionBody(rec);
      const guard = checkSuggestionBody(body, rec);
      if (!guard.ok) { // §10.3: refused, never altered
        rec = { ...rec, state: "FAILED" };
        this.update(rec);
        this.store.db.prepare("insert into check_publications values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(`pub:${rec.id}:${sha(guard.reason).slice(0, 8)}`, "", input.repositoryId, "github", rec.headHash, rec.idempotencyKey, "COMMENT", null, null, "FAILED", 1, guard.reason.slice(0, 400), nowIso());
        return { ok: false, reason: `Refused: ${guard.reason}`, code: "GUARD" };
      }
      // §11: find-before-create — a crash after a landed post adopts the comment instead of duplicating it
      const prior = await input.transport.findReviewComment(input.prNumber, suggestionMarker(rec.id));
      assertCommentEvent("COMMENT");
      const said = prior ? { id: prior.id } : await input.transport.submitReview(input.prNumber, rec.headHash, [{ path: rec.path, startLine: rec.startLine, endLine: rec.endLine, body }], "COMMENT");
      this.assertGrant(input.grantId, input.repositoryId, input.principalId); // second grant check, immediately after the external call
      rec = { ...rec, state: "POSTED", externalId: said.id, postedAt: nowIso() };
      this.update(rec);
      const receiptId = `pub:${rec.id}:${sha(rec.idempotencyKey).slice(0, 8)}`;
      const receipted = this.store.db.prepare("select 1 from check_publications where id = ?").get(receiptId);
      if (!receipted) // §11: a crash-replay adopts the landed comment and keeps the one receipt
        this.store.db.prepare("insert into check_publications values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(receiptId, "", input.repositoryId, "github", rec.headHash, rec.idempotencyKey, "COMMENT", said.id, null, "PUBLISHED", 0, null, nowIso());
      return { ok: true, record: rec, externalId: said.id, idempotent: !!prior };
    } catch (e) {
      rec = { ...rec, state: "FAILED" };
      this.update(rec);
      return { ok: false, reason: String((e as Error).message ?? e).slice(0, 300), code: "FAILED" };
    }
  }

  /** §7.6/§11: pure observation on the next analysed head; returns the bodies the forge must be updated with. */
  observe(input: { analysisId: string; repoRoot: string; headHash: string }): { records: SuggestionRecord[]; toUpdate: { record: SuggestionRecord; body: string }[] } {
    const toUpdate: { record: SuggestionRecord; body: string }[] = [];
    const records = this.forAnalysis(input.analysisId).map((rec) => {
      if (rec.state !== "POSTED" && rec.state !== "PREPARED") return rec;
      let text: string | null = null;
      try { text = readFileSync(join(input.repoRoot, rec.path), "utf8"); } catch { text = null; }
      // §7.6: applied when the head tree holds the replacement; a replacement that itself retains the
      // quoted bytes (a superset edit) is still an application — the presence of the new text is the signal
      const applied = text !== null && text.includes(rec.replacement)
        && (rec.replacement.includes(rec.expected) || !text.includes(rec.expected));
      if (rec.state === "POSTED") {
        if (applied) {
          const next = { ...rec, state: "APPLIED" as const, observedAt: nowIso() };
          this.update(next); return next; // §7.6: an observation; it never feeds ranking (F15 §7.2 rule 5)
        }
        if (input.headHash !== rec.headHash) {
          const next = this.applySupersede(rec, input.headHash);
          toUpdate.push({ record: next, body: renderSupersededBody(next, input.headHash) });
          return next;
        }
      } else if (rec.state === "PREPARED" && input.headHash !== rec.headHash) {
        const next = { ...rec, state: "SUPERSEDED" as const, observedAt: nowIso() }; // §9: never posted for a stale head
        this.update(next); return next;
      }
      return rec;
    });
    return { records, toUpdate };
  }
  private applySupersede(rec: SuggestionRecord, nowHead: string): SuggestionRecord {
    const next = { ...rec, state: "SUPERSEDED" as const, observedAt: nowIso() };
    this.update(next);
    return next;
  }
  /** §11: the superseded comment is updated in place, keeping the old text visible as history. */
  async writeBackSuperseded(rec: SuggestionRecord, nowHead: string, transport: ReviewCommentTransport): Promise<void> {
    if (!rec.externalId) return;
    await transport.updateReviewComment(rec.externalId, renderSupersededBody(rec, nowHead));
  }
}
