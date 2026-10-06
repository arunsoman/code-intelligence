// Task 3.R — publishing a validated candidate as a DRAFT pull request, and updating that same PR after review (PF-035, PF-036, PF-051).
//   * Publication is bound to the exact candidate, to the content hash the caller expects, and to a PublicationDecision recomputed
//     now (never one a caller claims). Evidence moving, the contract changing or the base moving makes it STALE_REVISION.
//   * The only external effects are: a push of a `cie/` branch from CIE's own clone, and ONE create-draft call. There is no merge,
//     approval or workflow call anywhere in this module (the DraftForge interface has none).
//   * Find-before-create: a retry after a crash adopts the PR (and the pushed branch) that already exists. A branch that exists
//     with a head this request did not create is a conflict, never overwritten. A moved head is only replaced under a lease on
//     the head we pushed ourselves.
//   * The PR text is built from allowlisted fields. The prompt's wording is included only when the destination is the repository
//     of a PRIVATE issue binding; otherwise ids and counts only. The whole text passes the same fail-closed leak guard as the issue trail.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DraftForge } from "../defect-workflow.ts";
import { copyTree, makeScratch, removeScratch, safeJoin, sha256 } from "../isolated-exec.ts";
import type { Store } from "../store.ts";
import { contentRoot, entriesFromDirectory } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { snapshotOf } from "./intake.ts";
import { guardOutgoing } from "./issue-trail.ts";
import { eventFor, transition } from "./lifecycle.ts";
import { assertStillAccessible, currentDecision, exportBlocks } from "./patch-export.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, FeatureRecord, Id, PublicationDecision, PublicationReceipt } from "./types.ts";

export const PUBLISH_PURPOSES = ["PUBLISH_DRAFT_PR"] as const;
export interface PublishDeps { fs: SqliteFeatureStore; store: Store; forge: DraftForge; cloneRoot: string; now?: () => string }
export interface PublishInput { proposalId: Id; decisionId: Id; expectedHeadHash: string; destination: string; idempotencyKey: string }

const DEST = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}):([A-Za-z0-9][A-Za-z0-9_./-]{0,100})$/;
export function parseDestination(d: string): { repository: string; base: string } {
  const m = DEST.exec(d ?? "");
  if (!m || m[2]!.includes("..") || m[2]!.endsWith("/") || m[2]!.endsWith(".lock")) throw new FeatureError("INVALID_SCHEMA", 'destination must be "owner/name:baseBranch"');
  return { repository: m[1]!, base: m[2]! };
}
export const branchFor = (requestId: Id): string => `cie/feature-${requestId.replace(/[^A-Za-z0-9]/g, "").slice(-16).toLowerCase() || "request"}`;

const git = (root: string, args: string[], env?: Record<string, string>, timeout = 60_000): string => {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env }); }
  catch (e) { throw new FeatureError("INVALID_SCHEMA", `git ${args[0]} failed: ${String((e as Error).message).slice(0, 200)}`); }
};
const tryGit = (root: string, args: string[]): string | null => { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

const wordsOf = (c: CandidateRecord) => {
  const n = (k: string) => c.mutations.filter((m) => m.kind === k).length;
  return `${n("ADDED")} added, ${n("MODIFIED")} modified, ${n("DELETED")} deleted, ${n("RENAMED")} renamed`;
};

/** The pull request text, from allowlisted fields only. */
export function prBodyFor(d: PublishDeps, request: FeatureRecord, candidate: CandidateRecord, decision: PublicationDecision, o: { repository: string; baseNote?: string }): string {
  const verified = decision.eligibility === "VERIFIED_WITHIN_SCOPE";
  const evidence = d.fs.listEvidence(candidate.id).filter((e) => !e.verdict);
  const tally: Record<string, number> = {};
  for (const e of evidence) for (const r of e.results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  const privateDest = request.issue.visibility === "PRIVATE" && request.issue.repository === o.repository;
  const title = privateDest && request.promptRef.redactedPreview ? request.promptRef.redactedPreview.replace(/\s+/g, " ").slice(0, 80) : `feature request ${request.requestId.replace(/^req:/, "").slice(0, 12)}`;
  const lines = [
    `## Feature: ${title.replace(/[\r\n#]/g, " ")}`, "",
    verified ? "**Verified within the scope of the recorded validation.** That is not a claim that the change is bug-free." : "**REVIEW ONLY — VALIDATION INCOMPLETE.** Do not treat this change as verified.", "",
    `Request \`${request.requestId}\` · contract v${request.contractVersion} · candidate \`${candidate.bindingHash.split(":").pop()!.slice(0, 12)}\` · decision \`${decision.eligibility}\``, "",
    "### Change", `- ${candidate.mutations.length} file(s): ${wordsOf(candidate)}`, ...(o.baseNote ? [`- ${o.baseNote}`] : []), "",
    "### Validation", `- Results by status: ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none recorded"}`,
    ...(verified ? [] : ["- Open gaps:", ...decision.reasons.slice(0, 12).map((r) => `  - ${r.replace(/[\r\n]+/g, " ").slice(0, 160)}`), ...(decision.reasons.length > 12 ? [`  - …and ${decision.reasons.length - 12} more`] : [])]), "",
    "Generated by CIE; draft; not approved for merge.", "",
  ];
  return guardOutgoing(request, lines.join("\n"), privateDest ? "PRIVATE" : "PUBLIC_OR_UNKNOWN");
}

/** Steps the request's state forward to REVIEW_READY (the state machine has no skip edges), from wherever a revision left it. */
function toReviewReady(fs: SqliteFeatureStore, requestId: Id, actor: Id, note: string): FeatureRecord {
  let cur = fs.getRequest(requestId)!;
  const path: Record<string, string[]> = { PUBLISHED: ["IMPLEMENTING", "VALIDATING", "REVIEW_READY"], IMPLEMENTING: ["VALIDATING", "REVIEW_READY"], VALIDATING: ["REVIEW_READY"], REVIEW_READY: [] };
  for (const next of path[cur.state] ?? []) cur = transition(fs, requestId, cur.version, next as FeatureRecord["state"], actor, note);
  return cur;
}

export async function publishFeaturePR(d: PublishDeps, actor: Id, i: PublishInput): Promise<PublicationReceipt> {
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  const { repository, base } = parseDestination(i.destination);
  const candidate = d.fs.getCandidate(i.proposalId) ?? d.fs.getCandidateByBinding(i.proposalId);
  const request = candidate ? d.fs.getRequest(candidate.requestId) : null;
  if (!candidate || !request || request.createdBy !== actor) throw new FeatureError("NOT_FOUND", "no such candidate");
  // A retry with the same key returns what was recorded; it never creates a second PR.
  if (candidate.publication?.idempotencyKey === i.idempotencyKey) return candidate.publication;
  assertStillAccessible(d.store, request, candidate);
  if (request.mode !== "CREATE_DRAFT_PR") throw new FeatureError("FORBIDDEN", `this request was made in ${request.mode} mode; only CREATE_DRAFT_PR requests publish`);
  if (["CANCELLED", "FAILED"].includes(request.state)) throw new FeatureError("FORBIDDEN", `the request is ${request.state}`);
  if (request.issue.syncState === "TRACKING_BLOCKED") throw new FeatureError("BLOCKED", "issue tracking is mandatory for this request and no issue is bound yet");
  if (candidate.status !== "MATERIALIZED" || request.workspace.candidateHash !== candidate.bindingHash) throw new FeatureError("STALE_REVISION", "this candidate is stale or superseded");
  if (i.expectedHeadHash !== candidate.binding.candidateContentHash) throw new FeatureError("STALE_REVISION", "the head you expected is not this candidate's content");
  const decision = currentDecision(d, request, candidate, i.decisionId, PUBLISH_PURPOSES);
  if (decision.status === "STALE") throw new FeatureError("STALE_REVISION", "the decision is stale");
  if (decision.eligibility === "BLOCKED") throw new FeatureError("BLOCKED", `a blocked candidate is not published: ${decision.reasons.slice(0, 3).join("; ")}`);
  const blocks = exportBlocks(candidate);
  if (blocks.length) throw new FeatureError("FORBIDDEN", `the candidate cannot be written to a branch: ${blocks.join("; ")}`);
  const live = snapshotOf(d.store, request.repositoryId);
  if (candidate.baseSnapshotRoot && candidate.baseSnapshotRoot !== live.contentRootHash) throw new FeatureError("STALE_REVISION", "the repository changed after this candidate was built");

  const branch = branchFor(request.requestId);
  const ours = d.fs.listCandidates(request.requestId).some((c) => c.publication?.branch === branch);
  const remote = await d.forge.resolve(repository, base, branch);
  // Intent is recorded before any external write, so a crash leaves a visible, reconcilable record.
  let cur = toReviewReady(d.fs, request.requestId, actor, "publication requested");
  cur = d.fs.updateRequest(cur.requestId, cur.version, { ...cur, workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } },
    eventFor(cur, "PublicationRequested", actor, { after: candidate.binding.candidateContentHash, rationale: `draft PR to ${repository}:${base} from ${branch}` }));

  // ---- push: CIE's own clone, the candidate's recorded bytes, the content hash verified before anything leaves.
  mkdirSync(d.cloneRoot, { recursive: true });
  const cloneDir = join(d.cloneRoot, request.requestId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  if (!existsSync(join(cloneDir, ".git"))) git(dirname(cloneDir), ["clone", "--quiet", request.repositoryId, cloneDir]);
  git(cloneDir, ["fetch", "--quiet", "--all"]);
  const priorHead = (tryGit(cloneDir, ["rev-parse", "--verify", `refs/heads/${branch}`]) ?? "").trim();
  git(cloneDir, ["checkout", "--quiet", "--force", "-B", branch, priorHead && ours ? priorHead : candidate.binding.baseCommitHash]);
  // Start from the base tree every time, then write the candidate: files removed by the candidate must be gone.
  git(cloneDir, ["reset", "--quiet", "--hard", candidate.binding.baseCommitHash]); git(cloneDir, ["clean", "-fdq"]);
  for (const m of candidate.mutations) {
    if (m.oldPath && (m.kind === "DELETED" || m.kind === "RENAMED")) rmSync(safeJoin(cloneDir, m.oldPath), { force: true });
    if (m.newPath && m.kind !== "DELETED") { const p = safeJoin(cloneDir, m.newPath); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, candidate.contents?.[m.newPath] ?? ""); }
  }
  const scratch = makeScratch("pf-pub-");
  try { copyTree(cloneDir, scratch); if (contentRoot(entriesFromDirectory(scratch, { exclude: [] })) !== candidate.binding.candidateContentHash) throw new FeatureError("STALE_REVISION", "the clone's content does not equal the validated candidate (the base may include files that are not committed); nothing was pushed"); }
  finally { removeScratch(scratch); }
  git(cloneDir, ["add", "-A"]);
  if ((tryGit(cloneDir, ["status", "--porcelain"]) ?? "").trim()) {
    // Dates come from the candidate, so the same candidate always produces the same commit: a retry after a crash adopts the push it already made.
    const date = candidate.createdAt;
    git(cloneDir, ["-c", "user.name=CIE", "-c", "user.email=cie@localhost", "commit", "--quiet", "--no-verify", "-m",
      `CIE feature ${request.requestId}\n\nGenerated-by: CIE feature request ${request.requestId}\nbinding-hash: ${candidate.bindingHash}\ndecision: ${decision.eligibility}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
  const commit = git(cloneDir, ["rev-parse", "HEAD"]).trim();
  const remoteHead = remote.headHash;
  if (remoteHead && remoteHead === commit) { /* already there */ }
  else if (!remoteHead) git(cloneDir, ["push", "--quiet", "origin", branch]);
  else if (ours) git(cloneDir, ["push", "--quiet", `--force-with-lease=${branch}:${remoteHead}`, "origin", branch]);
  else throw new FeatureError("VERSION_CONFLICT", `the branch ${branch} already exists on ${repository} with a head this request did not create; it was not overwritten`);

  // ---- the draft PR: adopt an existing one, else create exactly one.
  const baseNote = remote.baseHash !== candidate.binding.baseCommitHash ? `Validated against base ${candidate.binding.baseCommitHash.slice(0, 10)}; ${base} is now at ${remote.baseHash.slice(0, 10)}.` : undefined;
  const body = prBodyFor(d, request, candidate, decision, { repository, baseNote });
  const ref = { id: `publication:${sha256(`${candidate.bindingHash}|${branch}`).slice(0, 24)}`, repository, baseBranch: base, headBranch: branch, baseHash: remote.baseHash, headHash: commit, proposalId: candidate.id, validationId: decision.id, authorizationId: decision.id, status: "PUBLISHING" as const, prNumber: null, prUrl: null };
  let receipt = await d.forge.find(ref as never);
  const updated = !!receipt;
  if (!receipt) receipt = await d.forge.createDraft(ref as never, body);
  if (!receipt.draft) throw new FeatureError("VERSION_CONFLICT", "the forge receipt is not a draft; CIE's authority ends at a draft");
  if (receipt.headHash !== commit) throw new FeatureError("STALE_REVISION", "the forge's pull request head is not the commit that was pushed");

  const pub: PublicationReceipt = {
    id: `pub:${sha256(`${candidate.bindingHash}|${receipt.number}|${commit}`).slice(0, 24)}`, kind: "DRAFT_PR", remoteRef: receipt.url, headHash: candidate.binding.candidateContentHash, decisionId: decision.id,
    at: (d.now ?? (() => new Date().toISOString()))(), repository, branch, prNumber: receipt.number, commit, eligibility: decision.eligibility, idempotencyKey: i.idempotencyKey, updated,
    notes: [...(baseNote ? [baseNote] : []), ...(decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? [] : ["review only: validation incomplete"])],
  };
  const fresh = d.fs.getCandidate(candidate.id)!;
  const now = d.fs.getRequest(request.requestId)!;
  d.fs.putCandidate({ ...fresh, publication: pub }, eventFor(now, updated ? "PR_UPDATED" : "PublicationReconciled", actor, { after: commit, rationale: `${updated ? "updated" : "created"} draft PR #${receipt.number} in ${repository}`, result: "OK" }));
  const after = d.fs.getRequest(request.requestId)!;
  transition(d.fs, after.requestId, after.version, "PUBLISHED", actor, `draft PR #${receipt.number}`);
  return pub;
}
