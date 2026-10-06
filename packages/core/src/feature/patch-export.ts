// Task 3.Q — a candidate leaves as text someone else applies (PF-077), and can be dry-run and applied to an isolated copy of a
// destination (PF-078). Nothing here writes to a destination working tree.
//   * An export is bound to the exact candidate and to a PublicationDecision recomputed now from the recorded evidence. A decision
//     that no longer matches (evidence, contract or candidate moved) is STALE_REVISION; a BLOCK or STALE decision exports nothing.
//   * A review-only (incomplete) export is allowed but is labelled and can never carry the word "verified".
//   * Unsafe paths, VCS metadata, submodule (gitlink) files and non-text bytes are refused before a patch is produced.
//   * checkPatchDestination is a dry run on hashes (no write); applyPatchCandidate writes only into a new scratch directory
//     on an exact base, and the result is compared with the candidate's own content hash.
import { declarationGaps } from "./declarations.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeScratch, removeScratch, safeJoin, sha256 } from "../isolated-exec.ts";
import { MAX_BINARY_BYTES, applyCandidateToDir, changedPaths, copyTreeKeepLinks, passesThroughLink, readEntry, symlinkProblem } from "./tree.ts";
import { policyFor } from "../access.ts";
import type { Store } from "../store.ts";
import { canonHash, contentRoot, defineSchema, entriesFromDirectory } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import { snapshotOf } from "./intake.ts";
import { unevaluatedModels } from "./builder-eval.ts";
import type { SqliteFeatureStore } from "./store.ts";
import { computeEligibility, defaultValidationPlan, validationHash } from "./validation.ts";
import type {
  ApplicationAssessment, ApplicationReceipt, CandidateRecord, FeatureRecord, FileMutation, Id, Outcome, PatchExport, PublicationDecision, Snapshot,
} from "./types.ts";

export const EXPORT_FORMATS = ["UNIFIED_DIFF", "GIT_PATCH", "BUNDLE"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** The purposes a decision may have been computed for; the caller names the decision, the exporter recomputes and compares. */
export const EXPORT_PURPOSES = ["EXPORT_PATCH", "REVIEW"] as const;
export const EXPORT_POLICY = { formats: [...EXPORT_FORMATS], maxPatchBytes: 4 * 1024 * 1024, textOnly: true, incompleteLabel: "REVIEW ONLY — VALIDATION INCOMPLETE" } as const;
export const exportPolicyHash = (): string => validationHash("pf.ExportPolicy", EXPORT_POLICY);

/** Permission can be withdrawn after a candidate was approved (AT-11): every path that leaves the system is re-checked at the moment it leaves, and the refusal does not name the path. */
export function assertStillAccessible(store: Store, request: FeatureRecord, c: CandidateRecord): void {
  const policy = policyFor(store, request.repositoryId);
  if (c.mutations.some((m) => [m.oldPath, m.newPath].some((p) => !!p && policy.denied(p)))) throw new FeatureError("FORBIDDEN", "access to part of this candidate was withdrawn, so it can no longer be exported, published or applied");
}

export interface ExportDeps { fs: SqliteFeatureStore; store: Store; now?: () => string }

// ------------------------------------------------------------------------------------------------ the patch text

type Doc = { lines: string[]; eol: boolean };
const docOf = (t: string | null): Doc => { if (!t) return { lines: [], eol: true }; const eol = t.endsWith("\n"); const body = eol ? t.slice(0, -1) : t; return { lines: body.split("\n"), eol }; };

/** One file's hunk in git-apply form: a single hunk spanning the changed region with three lines of context. */
export function gitFilePatch(path: string, before: string | null, after: string | null, oldPath = path): string {
  if (before === after) return oldPath !== path && before !== null ? `diff --git a/${oldPath} b/${path}\nsimilarity index 100%\nrename from ${oldPath}\nrename to ${path}\n` : "";
  const a = docOf(before), b = docOf(after);
  const head = [`diff --git a/${oldPath} b/${path}`];
  if (before === null) head.push("new file mode 100644"); else if (after === null) head.push("deleted file mode 100644");
  if (oldPath !== path && before !== null && after !== null) head.push(`rename from ${oldPath}`, `rename to ${path}`);
  head.push(`--- ${before === null ? "/dev/null" : `a/${oldPath}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`);
  // Compare line by line, with the final newline treated as part of the last line, so a change of ending is a real change.
  const key = (d: Doc, i: number) => d.lines[i] + (i === d.lines.length - 1 && !d.eol ? "\0" : "");
  let pre = 0; while (pre < a.lines.length && pre < b.lines.length && key(a, pre) === key(b, pre)) pre++;
  let sa = a.lines.length, sb = b.lines.length; while (sa > pre && sb > pre && key(a, sa - 1) === key(b, sb - 1)) { sa--; sb--; }
  const ctx = 3, from = Math.max(0, pre - ctx), toA = Math.min(a.lines.length, sa + ctx), toB = Math.min(b.lines.length, sb + ctx);
  const out: string[] = [];
  const push = (mark: string, d: Doc, i: number) => { out.push(mark + d.lines[i]); if (i === d.lines.length - 1 && !d.eol) out.push("\\ No newline at end of file"); };
  for (let i = from; i < pre; i++) push(" ", a, i);
  for (let i = pre; i < sa; i++) push("-", a, i);
  for (let i = pre; i < sb; i++) push("+", b, i);
  for (let i = sa; i < toA; i++) push(" ", a, i);
  const startA = a.lines.length ? from + 1 : 0, startB = b.lines.length ? from + 1 : 0;
  return `${head.join("\n")}\n@@ -${startA},${toA - from} +${startB},${toB - from} @@\n${out.join("\n")}\n`;
}

const UNSAFE_SEGMENT = /^(\.git|\.gitmodules|\.gitattributes)$/i;
export function unsafePath(p: string): string | undefined {
  if (!p || p.includes("\0") || /[\x00-\x1f\x7f]/.test(p)) return "a control character in the path";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) return "an absolute or backslash path";
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "")) return "a path that leaves the repository or is not normalised";
  if (segs.some((s) => UNSAFE_SEGMENT.test(s))) return "version-control metadata";
  return undefined;
}

/** Everything that stops a candidate being written out as a patch, as readable reasons. Empty means the candidate may be exported. */
export function exportBlocks(c: CandidateRecord): string[] {
  const out: string[] = [];
  const contents = c.contents, base = c.baseContents;
  if (!contents || !base) return ["the candidate does not carry its file contents, so no exact patch can be produced"];
  const paths = new Set<string>();
  for (const m of c.mutations) for (const p of [m.oldPath, m.newPath]) if (p) paths.add(p);
  const lower = new Map<string, string>();
  for (const p of paths) {
    const bad = unsafePath(p); if (bad) out.push(`${JSON.stringify(p)}: ${bad}`);
    const k = p.toLowerCase(); if (lower.has(k) && lower.get(k) !== p) out.push(`${p} and ${lower.get(k)} differ only by case; a case-insensitive destination would merge them`); lower.set(k, p);
    for (const t of [contents[p], base[p]]) if (typeof t === "string" && t.includes("\0")) out.push(`${p}: contains NUL bytes; only text files are exported`);
    if (!(p in contents) && !(p in base) && !(p in (c.entries ?? {})) && !(p in (c.baseEntries ?? {}))) out.push(`${p}: named by the inventory but absent from the candidate's contents`);
  }
  for (const [p, e] of Object.entries(c.entries ?? {})) {
    if (!e) continue;
    if ((e.mode as string) === "160000") out.push(`${p}: a submodule (gitlink) entry is never exported`);
    if (e.kind === "SYMLINK") { const why = symlinkProblem(p, e.target ?? ""); if (why) out.push(`${p}: ${why}`); }
    if (e.kind === "BINARY" && (e.size > MAX_BINARY_BYTES || Buffer.from(e.base64 ?? "", "base64").length !== e.size)) out.push(`${p}: the binary payload does not match its recorded size or is over the limit`);
    if (e.kind === "TEXT" && typeof (c.contents ?? {})[p] !== "string") out.push(`${p}: a text entry without its text`);
  }
  for (const m of c.mutations) if (m.kind === "RENAMED" && (!m.oldPath || !m.newPath)) out.push("a rename without both paths");
  return [...new Set(out)];
}

const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", LANG: "C" };
const GIT_FLAGS = ["-c", "core.autocrlf=false", "-c", "core.fileMode=true", "-c", "core.symlinks=true", "-c", "core.quotepath=false", "-c", "user.name=CIE", "-c", "user.email=cie@localhost", "-c", "commit.gpgsign=false"];
function git(cwd: string, args: string[], input?: Buffer): { status: number | null; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", [...GIT_FLAGS, ...args], { cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024, timeout: 60_000, input });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? "") };
}

/** The base state of every path the candidate changes, written into `dir` (text, binary, symlink and mode as they were). */
function writeBaseState(dir: string, c: CandidateRecord): void {
  const text = c.baseContents ?? {}, ents = c.baseEntries ?? {};
  for (const p of changedPaths({ contents: c.baseContents, entries: c.baseEntries })) {
    const e = ents[p], t = text[p]; if (e === null || (e === undefined && typeof t !== "string")) continue;
    const abs = safeJoin(dir, p); mkdirSync(dirname(abs), { recursive: true });
    if (e?.kind === "SYMLINK") symlinkSync(e.target!, abs);
    else if (e?.kind === "BINARY") { writeFileSync(abs, Buffer.from(e.base64 ?? "", "base64")); chmodSync(abs, e.mode === "100755" ? 0o755 : 0o644); }
    else { writeFileSync(abs, t ?? ""); chmodSync(abs, (e?.mode ?? "100644") === "100755" ? 0o755 : 0o644); }
  }
}

/** Git's own `diff --binary` over the base state and the candidate state of the changed paths: the canonical patch (issue #91). */
export function gitPatchFor(c: CandidateRecord): string {
  const dir = makeScratch("pf-gitpatch-");
  try {
    if (git(dir, ["init", "-q", "-b", "main"]).status !== 0) throw new FeatureError("INVALID_SCHEMA", "git is not available to produce the patch");
    writeBaseState(dir, c); git(dir, ["add", "-A"]);
    const ci = git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "base"]); if (ci.status !== 0) throw new FeatureError("INVALID_SCHEMA", `git could not record the base state: ${ci.stderr.slice(0, 160)}`);
    for (const p of changedPaths({ contents: c.baseContents, entries: c.baseEntries })) rmSync(safeJoin(dir, p), { force: true });
    applyCandidateToDir(dir, c);
    git(dir, ["add", "-A"]);
    const d = git(dir, ["diff", "--cached", "--binary", "--full-index", "-M", "--no-ext-diff", "--no-textconv", "HEAD"]);
    if (d.status !== 0) throw new FeatureError("INVALID_SCHEMA", `git could not produce the patch: ${d.stderr.slice(0, 160)}`);
    return d.stdout.toString("utf8");
  } finally { removeScratch(dir); }
}
export const hasNonText = (c: Pick<CandidateRecord, "entries" | "mutations">): boolean => Object.values(c.entries ?? {}).some((e) => e && (e.kind !== "TEXT" || e.mode !== "100644")) || c.mutations.some((m) => m.entryKind || m.beforeKind || m.beforeMode || m.afterMode);

/** Patch text for the whole candidate. GIT_PATCH and BUNDLE come from Git itself; a plain unified diff is text-only and refuses anything else. */
export function buildPatch(c: CandidateRecord, format: ExportFormat): string {
  if (format !== "UNIFIED_DIFF") return gitPatchFor(c);
  if (hasNonText(c)) throw new FeatureError("INVALID_SCHEMA", "this candidate has binary, executable-bit or symlink changes, which a plain unified diff cannot carry; export it as GIT_PATCH");
  const contents = c.contents ?? {}, base = c.baseContents ?? {};
  const parts: string[] = [];
  for (const m of [...c.mutations].sort((x, y) => (x.newPath ?? x.oldPath!).localeCompare(y.newPath ?? y.oldPath!))) {
    // A plain unified diff has no rename syntax: it is a deletion and an addition.
    if (m.kind === "RENAMED") parts.push(gitFilePatch(m.oldPath!, base[m.oldPath!] ?? null, null), gitFilePatch(m.newPath!, null, contents[m.newPath!] ?? null));
    else { const p = (m.newPath ?? m.oldPath)!; parts.push(gitFilePatch(p, base[p] ?? null, contents[p] ?? null)); }
  }
  // Drop git's extended headers: this form is for `patch -p1` and for reading.
  return parts.join("").split("\n").filter((l) => !/^(diff --git |new file mode |deleted file mode |rename (from|to) |similarity index )/.test(l)).join("\n");
}

const ManifestSchema = defineSchema<Record<string, unknown>>("pf.PatchManifest", "1", (m) => m as never);
export type PatchManifest = {
  schemaVersion: 1; requestId: Id; candidateHash: string; baseContentHash: string; baseCommitHash: string; candidateContentHash: string; contractHash: string;
  decisionId: Id; eligibility: PublicationDecision["eligibility"]; reasons: string[]; format: ExportFormat; patchHash: string;
  files: { path: string; oldPath?: string; kind: FileMutation["kind"]; beforeHash?: string; afterHash?: string }[];
};

/** The decision the exporter is willing to rely on: recomputed now, never read from a caller's claim. */
export function currentDecision(d: ExportDeps, request: FeatureRecord, candidate: CandidateRecord, decisionId: string, purposes: readonly string[] = EXPORT_PURPOSES): PublicationDecision {
  const evidence = d.fs.listEvidence(candidate.id).filter((e) => !e.verdict);
  const plan = request.validationPlan ?? defaultValidationPlan(request, candidate); const decisions = d.fs.listDecisions(request.requestId);
  const tried = purposes.map((purpose) => computeEligibility({ request, candidate, plan, evidence, decisions, purpose, unevaluatedModels: unevaluatedModels(d.fs, request, candidate), externalGaps: declarationGaps(d.fs, request) }));
  const hit = tried.find((x) => x.id === decisionId);
  if (!hit) throw new FeatureError("STALE_REVISION", "that decision does not match the current candidate, contract and evidence; verify again before exporting");
  return hit;
}

export function exportFeaturePatch(d: ExportDeps, actor: Id, i: { candidateHash: string; decisionId: Id; format: string; exportPolicyHash: string }): Outcome<PatchExport> {
  const candidate = d.fs.getCandidateByBinding(i.candidateHash);
  if (!candidate) throw new FeatureError("NOT_FOUND", "no such candidate");
  const request = d.fs.getRequest(candidate.requestId);
  if (!request || request.createdBy !== actor) throw new FeatureError("NOT_FOUND", "no such candidate");
  assertStillAccessible(d.store, request, candidate);
  if (!(EXPORT_FORMATS as readonly string[]).includes(i.format)) throw new FeatureError("INVALID_SCHEMA", `format must be one of ${EXPORT_FORMATS.join(", ")}`);
  if (i.exportPolicyHash !== exportPolicyHash()) throw new FeatureError("STALE_REVISION", "the export policy changed; reload it before exporting");
  if (candidate.status !== "MATERIALIZED" || request.workspace.candidateHash !== candidate.bindingHash) throw new FeatureError("STALE_REVISION", "this candidate is stale or superseded and cannot be exported");
  const decision = currentDecision(d, request, candidate, i.decisionId);
  if (decision.status === "STALE") throw new FeatureError("STALE_REVISION", "the decision is stale");
  if (decision.eligibility === "BLOCKED") throw new FeatureError("BLOCKED", `a blocked candidate is not exported: ${decision.reasons.slice(0, 3).join("; ")}`);
  const blocks = exportBlocks(candidate);
  if (blocks.length) throw new FeatureError("FORBIDDEN", `the candidate cannot be written out as a patch: ${blocks.join("; ")}`);
  const format = i.format as ExportFormat;
  const patch = buildPatch(candidate, format);
  if (Buffer.byteLength(patch) > EXPORT_POLICY.maxPatchBytes) throw new FeatureError("RESOURCE_LIMIT", "the patch is larger than the export limit");
  const patchHash = sha256(patch);
  const manifest: PatchManifest = {
    schemaVersion: 1, requestId: request.requestId, candidateHash: candidate.bindingHash, baseContentHash: candidate.binding.baseContentHash, baseCommitHash: candidate.binding.baseCommitHash,
    candidateContentHash: candidate.binding.candidateContentHash, contractHash: candidate.binding.contractHash, decisionId: decision.id, eligibility: decision.eligibility,
    reasons: decision.reasons, format, patchHash,
    files: candidate.mutations.map((m) => ({ path: (m.newPath ?? m.oldPath)!, ...(m.oldPath && m.oldPath !== m.newPath ? { oldPath: m.oldPath } : {}), kind: m.kind, ...(m.beforeHash ? { beforeHash: m.beforeHash } : {}), ...(m.afterHash ? { afterHash: m.afterHash } : {}) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifestHash = canonHash(ManifestSchema, manifest as unknown as Record<string, unknown>);
  const id = `export:${sha256(`${candidate.bindingHash}|${decision.id}|${format}|${patchHash}`).slice(0, 24)}`;
  const label = decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? "VERIFIED WITHIN THE SCOPE OF THE RECORDED VALIDATION" : EXPORT_POLICY.incompleteLabel;
  const existing = candidate.exports?.find((e) => e.id === id);
  const record: PatchExport = existing ?? {
    id, requestId: request.requestId, patchArtifactHash: patchHash, manifestHash, candidateHash: candidate.bindingHash, baseHash: candidate.binding.baseContentHash, format,
    eligibility: decision.eligibility, patch: format === "BUNDLE" ? JSON.stringify({ manifest, patch }) : patch, manifest, decisionId: decision.id, reasons: decision.reasons, exportPolicyHash: exportPolicyHash(), label,
  };
  if (!existing) d.fs.putCandidate({ ...candidate, exports: [...(candidate.exports ?? []), record] }, eventFor(request, "PatchExported", actor, {
    after: patchHash, decisionIds: [], rationale: `${format} patch of ${candidate.mutations.length} file(s), ${decision.eligibility}`, result: "OK" }));
  return { status: decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? "COMPLETE" : "PARTIAL", value: record, evidenceIds: [], diagnostics: decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? [] : [label, ...decision.reasons] };
}

// ------------------------------------------------------------------------------------------------ destination

const rootOfDir = (dir: string) => contentRoot(entriesFromDirectory(dir, { exclude: [] }));
/** What is at `rel` in the destination: kind, mode and hash (a symlink is compared by target, never followed). */
const hereOf = (root: string, rel: string): { hash: string; mode: string; kind: string } | null => { try { const e = readEntry(root, rel); return e ? { hash: e.hash, mode: e.mode, kind: e.kind === "SYMLINK" ? "SYMLINK" : "FILE" } : null; } catch { return null; } };
const wasHere = (m: FileMutation) => ({ mode: m.beforeMode ?? "100644", kind: (m.beforeKind ?? m.entryKind) === "SYMLINK" ? "SYMLINK" : "FILE" });
const sameAsBefore = (h: ReturnType<typeof hereOf>, m: FileMutation): boolean => !!h && h.hash === m.beforeHash && h.mode === wasHere(m).mode && h.kind === wasHere(m).kind;
/** True when `rel` sits inside a nested git repository (a submodule or a vendored checkout), which a patch must not reach into. */
function insideNestedRepo(root: string, rel: string): boolean {
  const segs = rel.split("/").slice(0, -1); let cur = root;
  for (const s of segs) { cur = join(cur, s); if (existsSync(join(cur, ".git"))) return true; }
  return false;
}

function findExport(d: ExportDeps, actor: Id, exportId: Id): { request: FeatureRecord; candidate: CandidateRecord; exp: PatchExport } {
  for (const r of d.fs.listRequests(undefined, 1000)) {
    if (r.createdBy !== actor) continue;
    for (const c of d.fs.listCandidates(r.requestId)) { const exp = c.exports?.find((e) => e.id === exportId); if (exp) return { request: r, candidate: c, exp }; }
  }
  throw new FeatureError("NOT_FOUND", "no such export");
}

/** A dry run on hashes. Nothing is written; every reason an application would fail is listed. */
export function checkPatchDestination(d: ExportDeps, actor: Id, i: { exportId: Id; destinationSnapshot: Snapshot; dirtyState: string[] }): Outcome<ApplicationAssessment> {
  const { request, candidate, exp } = findExport(d, actor, i.exportId);
  assertStillAccessible(d.store, request, candidate);
  if (!Array.isArray(i.dirtyState) || i.dirtyState.some((p) => typeof p !== "string")) throw new FeatureError("INVALID_SCHEMA", "dirtyState is a list of paths");
  const dest = i.destinationSnapshot?.repositoryId;
  if (typeof dest !== "string" || !dest) throw new FeatureError("INVALID_SCHEMA", "a destination snapshot is required");
  const live = snapshotOf(d.store, dest); // throws NOT_FOUND unless the destination is indexed and readable by this caller
  // A snapshot without a content root means "assess the destination as it is now"; the assessment id binds the result to that root, and apply refuses any other.
  if (i.destinationSnapshot.contentRootHash && live.contentRootHash !== i.destinationSnapshot.contentRootHash) return { status: "STALE", evidenceIds: [], diagnostics: ["the destination changed since this snapshot was taken; take a new snapshot"] };
  const policy = policyFor(d.store, dest);
  const conflicts: string[] = [], blocked: string[] = [...exportBlocks(candidate)];
  const dirty = new Set(i.dirtyState);
  const touched: string[] = [];
  for (const m of candidate.mutations) {
    const paths = [m.oldPath, m.newPath].filter((p): p is string => !!p); touched.push(...paths);
    for (const p of paths) { if (policy.denied(p)) { blocked.push("a path in this patch is not accessible in the destination"); continue; } if (insideNestedRepo(dest, p)) blocked.push(`${p} is inside a nested repository (submodule)`); if (dirty.has(p)) conflicts.push(`${p} has uncommitted changes in the destination`); }
    if (m.kind === "ADDED") { const h = hereOf(dest, m.newPath!); if (h !== null && !(h.hash === m.afterHash && h.mode === (m.afterMode ?? "100644"))) conflicts.push(`${m.newPath} already exists with different content`); }
    else if (m.kind === "MODIFIED" || m.kind === "DELETED") { const p = m.oldPath!; const h = hereOf(dest, p); if (h === null) conflicts.push(`${p} does not exist in the destination`); else if (!sameAsBefore(h, m)) conflicts.push(`${p} differs from the file the patch was made against`); }
    else { const h = hereOf(dest, m.oldPath!); if (!sameAsBefore(h, m)) conflicts.push(`${m.oldPath} differs from the file the patch was made against`); if (hereOf(dest, m.newPath!) !== null) conflicts.push(`${m.newPath} already exists`); }
  }
  // Exact base: the destination's content equals what the candidate was built on, so the result must equal the candidate's own hash.
  const scratch = makeScratch("pf-dest-"); let baseExact = false;
  try { copyTreeKeepLinks(dest, scratch); baseExact = rootOfDir(scratch) === exp.baseHash; } catch (e) { blocked.push(`the destination cannot be copied safely: ${(e as Error).message}`); } finally { removeScratch(scratch); }
  const applies = !conflicts.length && !blocked.length;
  const id = validationHash("pf.ApplicationAssessment", { exportId: exp.id, root: live.contentRootHash, conflicts, blocked, dirty: [...dirty].sort(), baseExact });
  const value: ApplicationAssessment = { schemaVersion: 1, id, applies, conflicts: [...new Set(conflicts)], dirty: touched.filter((p) => dirty.has(p)), exportId: exp.id, baseExact, destinationRoot: live.contentRootHash, blocked: [...new Set(blocked)] };
  return { status: applies ? "COMPLETE" : "PARTIAL", value, evidenceIds: [], diagnostics: [...value.conflicts, ...(value.blocked ?? []), ...(applies && !baseExact ? ["the destination differs from the base elsewhere; apply needs an exact base"] : [])] };
}

/** The patch text of an export: a bundle wraps it with its manifest. */
export const patchTextOf = (e: PatchExport): string => { const raw = e.patch ?? ""; if (e.format !== "BUNDLE") return raw; try { return String((JSON.parse(raw) as { patch: string }).patch); } catch { throw new FeatureError("INVALID_SCHEMA", "the bundle is not valid"); } };

/** Apply into a NEW scratch copy of the destination. The destination itself is never written; the receipt names where the result is. */
export function applyPatchCandidate(d: ExportDeps, actor: Id, i: { exportId: Id; destinationSnapshot: Snapshot; assessmentId: Id; capabilities: string[]; dirtyState?: string[]; idempotencyKey: string }): ApplicationReceipt {
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  if (!Array.isArray(i.capabilities) || !i.capabilities.includes("APPLY_TO_ISOLATED_WORKTREE")) throw new FeatureError("FORBIDDEN", "the caller did not grant APPLY_TO_ISOLATED_WORKTREE");
  const { request, candidate, exp } = findExport(d, actor, i.exportId);
  const check = checkPatchDestination(d, actor, { exportId: i.exportId, destinationSnapshot: i.destinationSnapshot, dirtyState: i.dirtyState ?? [] });
  if (check.status === "STALE") throw new FeatureError("STALE_REVISION", "the destination changed since it was assessed");
  const a = check.value!;
  if (a.id !== i.assessmentId) throw new FeatureError("STALE_REVISION", "the assessment no longer matches the destination, the export or the dirty state; assess again");
  if (!a.applies) throw new FeatureError("BLOCKED", `the patch does not apply: ${[...a.conflicts, ...(a.blocked ?? [])].join("; ")}`);
  if (!a.baseExact) throw new FeatureError("BLOCKED", "the destination is not the exact base this candidate was built on; apply is only done on an exact base");
  if (candidate.status === "STALE" || candidate.status === "SUPERSEDED") throw new FeatureError("STALE_REVISION", "the candidate is no longer current");
  const dest = i.destinationSnapshot.repositoryId;
  const work = makeScratch("pf-applied-"); rmSync(work, { recursive: true, force: true });
  const applied: string[] = [], notApplied: string[] = [];
  try {
    copyTreeKeepLinks(dest, work);
    // Git is the apply engine: it refuses a path below a symlink, creates links and modes, and applies binary deltas. What it produced is then
    // compared with the candidate's own content hash, and nothing is kept unless they are equal.
    const patch = patchTextOf(exp);
    const ap = git(work, ["apply", "--binary", "--whitespace=nowarn", "-"], Buffer.from(patch, "utf8"));
    if (ap.status !== 0) throw new FeatureError("BLOCKED", `git could not apply the patch to a copy of the destination: ${ap.stderr.split("\n")[0]?.slice(0, 200) ?? ""}`);
    for (const m of candidate.mutations) applied.push((m.newPath ?? m.oldPath)!);
    const result = rootOfDir(work); const matches = result === candidate.binding.candidateContentHash;
    if (!matches) throw new FeatureError("BLOCKED", "the applied tree does not equal the candidate's content hash; nothing was kept");
    d.fs.putCandidate(candidate, eventFor(request, "PatchApplied", actor, { before: exp.baseHash, after: result, rationale: `applied ${applied.length} file(s) to an isolated copy; destination untouched`, result: "OK" }));
    return { schemaVersion: 1, id: `apply:${sha256(`${exp.id}|${i.idempotencyKey}`).slice(0, 24)}`, applied, notApplied, resultContentHash: result, worktree: work, exportId: exp.id, matchesCandidate: true };
  } catch (e) { rmSync(work, { recursive: true, force: true }); throw e; }
}
