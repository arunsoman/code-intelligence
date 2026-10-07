// Task 1.C — submitFeature and discoverFeatureContext (PF-001, PF-002, PF-004, PF-043; AT-01, AT-33).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Store } from "../store.ts";
import { assertSafeExclusions, contentRoot, entriesFromDirectory, rawHash } from "./canon.ts";
import { loadFeatureConfig, trackingFor, type FeatureConfig } from "./config.ts";
import { discover } from "./discovery.ts";
import { FeatureError } from "./errors.ts";
import { eventFor, transition } from "./lifecycle.ts";
import { redactedPreview } from "./redact.ts";
import type { SqliteFeatureStore } from "./store.ts";
import { classifyTier, type ChangedPath, type TierResult } from "./tiers.ts";
import type { FeatureRecord, FeatureRequest, Id, Outcome, OutcomeMode, RepositoryAssessment, Snapshot, SourceRef } from "./types.ts";

export interface IntakeDeps { fs: SqliteFeatureStore; store: Store; config?: (repoRoot: string) => FeatureConfig }
const cfgOf = (d: IntakeDeps, root: string): FeatureConfig => { try { return (d.config ?? loadFeatureConfig)(root); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `feature configuration is invalid: ${(e as Error).message}`); } };

const MAX_PROMPT = 50_000, MAX_REFS = 50;
const MODES: readonly OutcomeMode[] = ["PLAN", "BUILD_PREVIEW", "CREATE_DRAFT_PR"];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

/** Directory names left out of the content root (build output, VCS internals and this tool's own state, which changes on every operation). Source and configuration are never excluded; the authority policy is hashed separately into the contract. */
export const CONTENT_ROOT_EXCLUDE = [".git", "node_modules", "dist", "target", "coverage", ".cache", ".cie"] as const;

const blobCache = new Map<string, string>();
/** Snapshot of the repository as it is now: indexed revision, git head and a pf-canon-v1 content root (hashes cached by path/size/mtime, plan S9). */
export function snapshotOf(store: Store, repoRoot: string): Snapshot {
  const rev = store.latestRevision(repoRoot);
  if (!rev) throw new FeatureError("NOT_FOUND", "that repository is not indexed (or access to it was withdrawn); index it first");
  assertSafeExclusions([...CONTENT_ROOT_EXCLUDE]);
  const root = realpathSync(repoRoot);
  const entries = entriesFromDirectory(root, { exclude: CONTENT_ROOT_EXCLUDE, known: (rel, size, mtime) => blobCache.get(`${root}\0${rel}\0${size}\0${mtime}`) });
  // remember hashes for next time (entriesFromDirectory hashed what was not known)
  for (const e of entries) if (e.kind === "file" && e.hash) { try { const st = lstatSync(join(root, e.path)); blobCache.set(`${root}\0${e.path}\0${st.size}\0${st.mtimeMs}`, e.hash); } catch { /* changed under us */ } }
  if (blobCache.size > 200_000) blobCache.clear();
  let head = rev.gitHead;
  try { head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || head; } catch { /* not a git repository */ }
  return {
    repositoryId: repoRoot, commitHash: head ?? rev.id, contentRootHash: contentRoot(entries), indexGeneration: store.revisionsOf(repoRoot).length,
    toolchainHash: rawHash(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })),
  };
}

const hasRemote = (root: string): boolean => { try { return execFileSync("git", ["-C", root, "remote"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0; } catch { return false; } };

/** Outcome mode: the requested one, unless publication is impossible (no git remote), in which case it is lowered AND the reason is returned. */
export function resolveOutcomeMode(repoRoot: string, requested: OutcomeMode): { mode: OutcomeMode; downgradedBecause?: string } {
  if (requested === "CREATE_DRAFT_PR" && !hasRemote(repoRoot)) return { mode: "BUILD_PREVIEW", downgradedBecause: "this repository has no git remote, so a draft pull request cannot be created; a build preview is produced instead" };
  return { mode: requested };
}

function checkRefs(repoRoot: string, refs: SourceRef[]): string[] {
  if (!Array.isArray(refs) || refs.length > MAX_REFS) throw new FeatureError("INVALID_SCHEMA", `at most ${MAX_REFS} input references`);
  const warnings: string[] = []; const seen = new Set<string>();
  for (const r of refs) {
    if (!r || typeof r.artifactId !== "string" || !r.artifactId || typeof r.locator !== "string" || typeof r.version !== "string" || !/^[0-9a-f]{64}$/.test(r.contentHash ?? "")) throw new FeatureError("INVALID_SCHEMA", "an input reference needs artifactId, version, locator and a 64-hex contentHash");
    const k = `${r.artifactId}\0${r.version}\0${r.locator}`; if (seen.has(k)) throw new FeatureError("INVALID_SCHEMA", `duplicate input reference ${r.artifactId}`); seen.add(k);
    if (r.locator.startsWith("repo:")) {
      const rel = r.locator.slice(5);
      if (!rel || isAbsolute(rel) || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) throw new FeatureError("INVALID_SCHEMA", `unsafe repository path in reference ${r.artifactId}`);
      const abs = resolve(repoRoot, rel); const root = realpathSync(repoRoot);
      let real: string; try { real = realpathSync(abs); } catch { throw new FeatureError("NOT_FOUND", `referenced file ${rel} does not exist`); }
      if (real !== root && !real.startsWith(root + sep)) throw new FeatureError("FORBIDDEN", `reference ${rel} resolves outside the repository`);
      if (rawHash(readFileSync(real)) !== r.contentHash) throw new FeatureError("STALE_REVISION", `${rel} has changed since it was referenced`);
    } else warnings.push(`reference ${r.artifactId} points outside the repository and was recorded as given (its content cannot be verified here)`);
  }
  return warnings;
}

export interface SubmitInput { inputRefs: SourceRef[]; text: string; repositoryId: Id; mode: OutcomeMode; budget?: { modelTokens: number; wallMs: number }; idempotencyKey: string; /** The release this request is being built toward, if any (release-scope.ts's Release). */ releaseId?: Id }

export function submitFeature(d: IntakeDeps, actor: Id, i: SubmitInput): FeatureRequest {
  if (typeof i.text !== "string") throw new FeatureError("INVALID_SCHEMA", "the request text must be a string");
  const text = i.text.replace(CONTROL, "").trim();
  if (!text) throw new FeatureError("INVALID_SCHEMA", "describe the feature you want");
  if (text.length > MAX_PROMPT) throw new FeatureError("INVALID_SCHEMA", `the request is longer than ${MAX_PROMPT} characters; summarise it and attach the detail as a file`);
  if (!MODES.includes(i.mode)) throw new FeatureError("INVALID_SCHEMA", `mode must be one of ${MODES.join(", ")}`);
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  if (i.budget && (!(i.budget.modelTokens > 0) || !(i.budget.wallMs > 0))) throw new FeatureError("INVALID_SCHEMA", "budgets must be positive");
  const requestId = `req:${createHash("sha256").update(`${actor}\0${i.idempotencyKey}`).digest("hex").slice(0, 24)}`;
  const prior = d.fs.getRequest(requestId);
  if (prior) {
    if (prior.promptRef.contentHash !== rawHash(text) || prior.repositoryId !== i.repositoryId) throw new FeatureError("IDEMPOTENCY_CONFLICT", "this idempotency key was already used for a different request");
    return { schemaVersion: 1, id: requestId, requestId, state: prior.state, replayed: true, mode: prior.mode };
  }
  const rev = d.store.latestRevision(i.repositoryId);
  if (!rev) throw new FeatureError("NOT_FOUND", "that repository is not indexed (or access to it was withdrawn); index it first");
  const warnings = checkRefs(i.repositoryId, i.inputRefs ?? []);
  const cfg = cfgOf(d, i.repositoryId);
  const { mode, downgradedBecause } = resolveOutcomeMode(i.repositoryId, i.mode);
  if (downgradedBecause) warnings.push(downgradedBecause);
  const tracking = trackingFor(cfg, mode);
  const snapshot = snapshotOf(d.store, i.repositoryId);
  const now = new Date().toISOString();
  const contentHash = rawHash(text);
  const rec: FeatureRecord = {
    schemaVersion: 1, requestId, repositoryId: i.repositoryId, mode, state: "RECEIVED",
    promptRef: { artifactId: `prompt:${contentHash.slice(0, 16)}`, contentHash, redactedPreview: redactedPreview(text), text },
    inputRefs: i.inputRefs ?? [], source: snapshot, contractVersion: 0, tasks: [], blockers: [],
    // MANDATORY tracking blocks mutation (candidate creation, publication) until an issue is bound; it never blocks reading or planning (S13).
    issue: { repository: "", syncState: tracking === "MANDATORY" ? "TRACKING_BLOCKED" : tracking === "OFFLINE_UNSYNCED" ? "UNSYNCED" : "UNBOUND", lastSyncedSequence: 0, projectionRevision: 0 },
    workspace: { requestId, stage: "DESCRIBE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: i.releaseId }, version: 0, createdBy: actor, createdAt: now, updatedAt: now, budget: i.budget,
  };
  const { record, replayed } = d.fs.createRequest(rec, eventFor(rec, "FeatureSubmitted", actor, { rationale: `mode ${mode}${downgradedBecause ? " (lowered from " + i.mode + ")" : ""}; tracking ${tracking}`, after: contentHash }), i.idempotencyKey);
  return { schemaVersion: 1, id: record.requestId, requestId: record.requestId, state: record.state, replayed, mode: record.mode, warnings: warnings.length ? warnings : undefined };
}

export interface DiscoverInput { requestId: Id; snapshot: Snapshot; retrievalBudget: { tokens: number; files: number } }

export function discoverFeatureContext(d: IntakeDeps, actor: Id, i: DiscoverInput): Outcome<RepositoryAssessment> {
  const rec = d.fs.getRequest(i.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (rec.createdBy !== actor) throw new FeatureError("FORBIDDEN", "only the requester can run discovery for this request");
  if (!(i.retrievalBudget?.files > 0) || !(i.retrievalBudget?.tokens > 0)) throw new FeatureError("INVALID_SCHEMA", "retrievalBudget needs positive files and tokens");
  if (i.snapshot.repositoryId !== rec.repositoryId) throw new FeatureError("INVALID_SCHEMA", "the snapshot is for a different repository");
  const current = snapshotOf(d.store, rec.repositoryId);
  if (current.contentRootHash !== i.snapshot.contentRootHash) return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since this snapshot was taken; take a new snapshot and run discovery again"] };
  const cfg = cfgOf(d, rec.repositoryId);
  let cur = rec;
  if (cur.state === "RECEIVED" || cur.state === "CONTRACTING") cur = transition(d.fs, cur.requestId, cur.version, "DISCOVERING", actor, "discovery started");
  else if (cur.state !== "DISCOVERING") throw new FeatureError("ILLEGAL_TRANSITION", `discovery cannot run while the request is ${cur.state}`);
  const assessment = discover({ store: d.store, repoRoot: rec.repositoryId, snapshot: current, supportedStacks: cfg.supportedStacks, requestText: rec.promptRef.text ?? rec.promptRef.redactedPreview, budget: { files: i.retrievalBudget.files, tokens: i.retrievalBudget.tokens } });
  const failed = assessment.coverage.every((c) => c.state === "FAILED");
  const partial = assessment.coverage.some((c) => c.state !== "COMPLETE_WITHIN_SCOPE");
  const buildable = assessment.supportMatrix.some((s) => s.supported);
  // A mode that builds needs a supported stack; a plan does not. The reason is a blocker the person can read, not a silent downgrade.
  const blockers = cur.blockers.filter((b) => b.id !== "dep:unsupported-stack");
  if (!buildable && cur.mode !== "PLAN" && !failed) blockers.push({ id: "dep:unsupported-stack", kind: "DEPENDENCY", requirementIds: [], text: `Building is not supported for this repository: ${assessment.supportMatrix.map((s) => `${s.stack} (${s.reason ?? "unsupported"})`).join("; ")}. A plan can still be produced.` });
  const next: FeatureRecord = { ...cur, assessment, source: current, tier: cur.tier, blockers, workspace: { ...cur.workspace, blockers: blockers.map((b) => b.id), workspaceVersion: cur.workspace.workspaceVersion + 1 } };
  const saved = d.fs.updateRequest(cur.requestId, cur.version, next, eventFor(cur, "StateChanged", actor, { result: failed ? "FAILED" : "OK", rationale: `discovery ${failed ? "failed" : partial ? "finished with gaps" : "finished"}: ${assessment.coverage.filter((c) => c.found === "FOUND").length}/${assessment.coverage.length} domains had findings`, after: assessment.id }));
  if (failed) return { status: "FAILED", value: assessment, evidenceIds: [assessment.id], diagnostics: assessment.coverage[0]!.unresolved };
  transition(d.fs, saved.requestId, saved.version, "CONTRACTING", actor, "discovery complete");
  return { status: partial ? "PARTIAL" : "COMPLETE", value: assessment, evidenceIds: [assessment.id], diagnostics: [...new Set(assessment.coverage.flatMap((c) => c.unresolved))] };
}

/** Tier of a planned or actual change set (plan §2.4), recorded on the request so every later gate reads the same answer. */
export function classifyPlan(d: IntakeDeps, actor: Id, requestId: Id, changes: readonly ChangedPath[]): TierResult {
  const rec = d.fs.getRequest(requestId); if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  const result = classifyTier(changes);
  if (rec.tier !== result.tier) d.fs.updateRequest(requestId, rec.version, { ...rec, tier: result.tier }, eventFor(rec, "StateChanged", actor, { rationale: `tier ${rec.tier ?? "unset"} → ${result.tier}: ${result.reasons[0] ?? ""}` }));
  return result;
}
