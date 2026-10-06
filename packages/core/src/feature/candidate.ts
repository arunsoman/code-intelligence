// Task 1.E — the feature candidate engine. A candidate is an exact list of edits applied to a scratch copy of the repository;
// nothing here ever writes to the user's working tree or runs generated code. It reuses F07's pure admission, exactness and
// oracle-weakening rules (execution.ts) and isolated-exec's copy/diff/hash, and adds what a feature needs and a bug fix does not:
// new files, renames, tests that are ADDED alongside the change, and dependency edits that need an explicit grant.
//
// Rules that are enforced here, not left to the caller:
//   * the candidate is bound to the exact base (live content root must still equal the request's snapshot) and to the contract hash
//   * adding a test is always allowed; editing or deleting an existing test is a property change and needs a policy grant, and is
//     recorded (PROPERTY_CHANGE_PENDING_REVIEW) with every weakened assertion
//   * lockfiles, CI configuration and dependency sections of package.json need an explicit security grant; secrets never
//   * mandatory issue tracking and unresolved questions block building (plan S13), a stale base blocks it (PF-021)
import { existsSync, readFileSync } from "node:fs";
import { EditOperationSchema, type EditOperation } from "@cie/schema";
import { admissionProblems, detectOracleWeakening, exactnessProblems, isProtectedPath, isTestPath, normalizeRel } from "../execution.ts";
import { applyTextEdits, makeScratch, removeScratch, safeJoin, sha256, walkFiles } from "../isolated-exec.ts";
import { MAX_BINARY_BYTES, copyTreeKeepLinks, diffTrees, passesThroughLink, readEntry, symlinkHash, symlinkProblem, FILE_MODES, type TreeDelta } from "./tree.ts";
import { policyFor } from "../access.ts";
import { unifiedDiff } from "../changes.ts";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../store.ts";
import { authorize, type AuthorityConfig } from "./authority.ts";
import { asSet, canonHash, contentRoot, defineSchema, entriesFromDirectory, type Canon } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { eventFor, transition } from "./lifecycle.ts";
import { snapshotOf } from "./intake.ts";
import { alreadySupported } from "./overlap.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateEntry, CandidateRecord, FileMutation, Hash, Id, Outcome, PatchBinding, Snapshot } from "./types.ts";

export type RenameEdit = { op: "RENAME_FILE"; from: string; to: string; baseHash: string; why: string };
/** Binary files, executable bits and symlinks (issue #91). Text edits keep their own operations; a binary file is deleted with DELETE_FILE. */
export type NonTextEdit =
  | { op: "CREATE_BINARY"; file: string; base64: string; mode?: "100644" | "100755"; why: string }
  | { op: "REPLACE_BINARY"; file: string; baseHash: string; base64: string; why: string }
  | { op: "SET_MODE"; file: string; baseHash?: string; mode: "100644" | "100755"; why: string }
  | { op: "CREATE_SYMLINK"; file: string; target: string; why: string }
  | { op: "RETARGET_SYMLINK"; file: string; baseTarget: string; target: string; why: string }
  | { op: "REMOVE_SYMLINK"; file: string; baseTarget: string; why: string };
export type FeatureEdit = (EditOperation | RenameEdit | NonTextEdit) & { requirementIds?: Id[]; taskIds?: Id[]; actionIds?: Id[] };
const NON_TEXT_OPS = ["CREATE_BINARY", "REPLACE_BINARY", "SET_MODE", "CREATE_SYMLINK", "RETARGET_SYMLINK", "REMOVE_SYMLINK"] as const;
const isNonText = (e: FeatureEdit): e is NonTextEdit & { requirementIds?: Id[]; taskIds?: Id[]; actionIds?: Id[] } => (NON_TEXT_OPS as readonly string[]).includes((e as { op: string }).op);
export interface CandidateScope {
  allowedPaths?: string[]; forbiddenPaths?: string[]; maxFilesChanged?: number; maxDiffLines?: number;
  /** Policy grant: edit or delete EXISTING tests (adding tests never needs it). */
  allowTestEdits?: boolean;
  /** Security grant: change package.json dependency sections or install scripts. */
  allowNewDependencies?: boolean;
  /** Security grant: exact protected paths (CI config, lockfiles) that may change. Secrets can never be listed. */
  allowProtected?: string[];
}
export interface CandidateDeps { fs: SqliteFeatureStore; store: Store; auth: AuthorityConfig }
export interface MaterializeInput { requestId: Id; snapshot: Snapshot; edits: FeatureEdit[]; scope?: CandidateScope; invocationIds?: Id[]; idempotencyKey: string }

const NEVER = [/(^|\/)\.git(\/|$)/, /(^|\/)\.env(\.|$)/, /(^|\/)secrets?\//, /(^|\/)secrets?\.(json|ya?ml|toml)$/, /(^|\/)id_(rsa|ed25519|ecdsa)/, /\.(pem|key|p12)$/];
const MAX_TOTAL_BYTES = 4 * 1024 * 1024, DEFAULT_MAX_FILES = 50, DEFAULT_MAX_DIFF = 5000;
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "overrides", "resolutions"] as const;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

const PatchBindingSchema = defineSchema<PatchBinding>("pf.PatchBinding", "1", (b) => ({
  repositoryId: b.repositoryId, baseCommitHash: b.baseCommitHash, baseContentHash: b.baseContentHash, candidateContentHash: b.candidateContentHash, diffHash: b.diffHash,
  contractHash: b.contractHash, originalOracleHash: b.originalOracleHash, candidateOracleHash: b.candidateOracleHash, propertyChangeReviewId: b.propertyChangeReviewId ?? "",
  runManifestIds: asSet(b.runManifestIds) as Canon, mutationInventoryHash: b.mutationInventoryHash, generationProvenanceHash: b.generationProvenanceHash,
}));
const MutationSchema = defineSchema<FileMutation[]>("pf.MutationInventory", "1", (ms) => asSet(ms.map((m): Canon => ({
  oldPath: m.oldPath ?? "", newPath: m.newPath ?? "", kind: m.kind, before: m.beforeHash ?? "", after: m.afterHash ?? "", attribution: m.attribution, supporting: !!m.supporting, entry: m.entryKind ?? "TEXT", beforeMode: m.beforeMode ?? "", afterMode: m.afterMode ?? "",
  requirementIds: asSet(m.requirementIds), taskIds: asSet(m.taskIds), actionIds: asSet(m.actionIds),
}))) as Canon);
const DiffSchema = defineSchema<TreeDelta[]>("pf.Diff", "1", (cs) => asSet(cs.map((c): Canon => ({ file: c.file, kind: c.kind, old: c.before?.hash ?? "", new: c.after?.hash ?? "", oldMode: c.before?.mode ?? "", newMode: c.after?.mode ?? "", oldKind: c.before?.kind ?? "", newKind: c.after?.kind ?? "" }))) as Canon);
const ProvenanceSchema = defineSchema<{ invocationIds: Id[]; editsHash: string }>("pf.GenerationProvenance", "1", (p) => ({ invocationIds: asSet(p.invocationIds), editsHash: p.editsHash }));

type Expanded = { op: EditOperation; meta: { requirementIds: Id[]; taskIds: Id[]; actionIds: Id[] }; rename?: { from: string; to: string } };

function parseEdits(raw: FeatureEdit[], baseRoot: string): Expanded[] {
  if (!Array.isArray(raw)) throw new FeatureError("INVALID_SCHEMA", "edits must be a list");
  if (raw.length > 500) throw new FeatureError("RESOURCE_LIMIT", "more than 500 edits in one candidate");
  const out: Expanded[] = [];
  raw.forEach((e, idx) => {
    if (isNonText(e)) return; // binary, mode and symlink edits are parsed by parseNonText
    const { requirementIds = [], taskIds = [], actionIds = [], ...op } = e as FeatureEdit & Record<string, unknown>;
    const meta = { requirementIds: [...requirementIds], taskIds: [...taskIds], actionIds: actionIds.length ? [...actionIds] : [`edit:${idx + 1}`] };
    if ((op as RenameEdit).op === "RENAME_FILE") {
      const r = op as RenameEdit;
      if (typeof r.from !== "string" || typeof r.to !== "string" || !r.why) throw new FeatureError("INVALID_SCHEMA", "a rename needs from, to and why");
      const from = normalizeRel(r.from), to = normalizeRel(r.to);
      if (from === to) throw new FeatureError("INVALID_SCHEMA", `rename of ${from} to itself`);
      let text: Buffer; try { text = readFileSync(safeJoin(baseRoot, from)); } catch { throw new FeatureError("NOT_FOUND", `${from} does not exist in the base tree`); }
      if (sha256(text) !== r.baseHash) throw new FeatureError("STALE_REVISION", `${from} has changed since the proposer read it (base hash mismatch)`);
      const content = text.toString("utf8");
      if (Buffer.from(content, "utf8").compare(text) !== 0) throw new FeatureError("INVALID_SCHEMA", `${from} is not valid UTF-8 text; binary files cannot be renamed here`);
      out.push({ op: { op: "DELETE_FILE", file: from, baseHash: r.baseHash, why: r.why }, meta, rename: { from, to } }, { op: { op: "CREATE_FILE", file: to, content, why: r.why }, meta, rename: { from, to } });
      return;
    }
    const parsed = EditOperationSchema.safeParse(op);
    if (!parsed.success) throw new FeatureError("INVALID_SCHEMA", `edit ${idx + 1} is not valid: ${parsed.error.issues[0]?.message ?? "unknown field"}`);
    out.push({ op: parsed.data, meta });
  });
  return out;
}

/** Everything admission rejects for a feature candidate, as readable reasons. Pure given the base tree. */
export function featureAdmission(expanded: Expanded[], scope: CandidateScope, baseRoot: string): string[] {
  const ops = expanded.map((e) => e.op);
  const problems: string[] = [];
  const allowProtected = new Set((scope.allowProtected ?? []).map(normalizeRel));
  for (const p of allowProtected) if (NEVER.some((re) => re.test(p))) problems.push(`${p} is a secret or VCS path and can never be granted`);
  for (const op of ops) {
    const rel = normalizeRel(op.file);
    if (NEVER.some((re) => re.test(rel))) { problems.push(`secrets and VCS paths are never edited: ${rel}`); continue; }
    const exists = existsSync(safeJoinSafe(baseRoot, rel));
    if (isTestPath(rel)) {
      if (op.op === "CREATE_FILE" && !exists) continue; // adding a test is always allowed
      if (!scope.allowTestEdits) problems.push(`${op.op === "DELETE_FILE" ? "deleting" : "editing"} the existing test ${rel} is a property change and needs a policy grant (allowTestEdits)`);
    } else if (isProtectedPath(rel) && !allowProtected.has(rel)) problems.push(`protected path (CI config, lockfile or tool config) needs an exact security grant: ${rel}`);
  }
  // One path, one operation: two creates of a path, or a delete together with another edit, have no defined result.
  const perFile = new Map<string, string[]>();
  for (const op of ops) perFile.set(normalizeRel(op.file), [...(perFile.get(normalizeRel(op.file)) ?? []), op.op]);
  for (const [f, kinds] of perFile) if (kinds.filter((k) => k === "CREATE_FILE").length > 1 || (kinds.includes("DELETE_FILE") && kinds.length > 1)) problems.push(`conflicting operations on ${f}: ${kinds.join(", ")}`);
  // F07's structural rules: containment, caps, overlapping spans. Tests and protected paths were decided above, so it runs permissive on those.
  problems.push(...admissionProblems(ops, {
    allowedPaths: scope.allowedPaths ?? [], forbiddenPaths: scope.forbiddenPaths ?? [], maxFilesChanged: scope.maxFilesChanged ?? DEFAULT_MAX_FILES,
    maxDiffLines: scope.maxDiffLines ?? DEFAULT_MAX_DIFF, allowTestEdits: true,
  }));
  problems.push(...exactnessProblems(baseRoot, ops.filter((o) => !(o.op === "CREATE_FILE" && expanded.some((e) => e.rename?.to === o.file)))));
  return [...new Set(problems)];
}

// ------------------------------------------------------------------------------------------------ binary, mode and symlink edits (#91)

type Meta3 = { requirementIds: Id[]; taskIds: Id[]; actionIds: Id[] };
export type NonTextExpanded = { op: NonTextEdit; meta: Meta3 };
function parseNonText(raw: FeatureEdit[]): NonTextExpanded[] {
  const out: NonTextExpanded[] = [];
  raw.forEach((e, idx) => {
    if (!isNonText(e)) return;
    const { requirementIds = [], taskIds = [], actionIds = [], ...op } = e as FeatureEdit & Record<string, unknown>;
    const o = op as unknown as NonTextEdit;
    if (typeof o.file !== "string" || !o.file || typeof o.why !== "string" || !o.why.trim()) throw new FeatureError("INVALID_SCHEMA", `edit ${idx + 1} (${o.op}) needs a file and a reason`);
    const allowed: Record<string, string[]> = { CREATE_BINARY: ["op", "file", "base64", "mode", "why"], REPLACE_BINARY: ["op", "file", "baseHash", "base64", "why"], SET_MODE: ["op", "file", "baseHash", "mode", "why"], CREATE_SYMLINK: ["op", "file", "target", "why"], RETARGET_SYMLINK: ["op", "file", "baseTarget", "target", "why"], REMOVE_SYMLINK: ["op", "file", "baseTarget", "why"] };
    for (const k of Object.keys(op)) if (!allowed[o.op]!.includes(k)) throw new FeatureError("INVALID_SCHEMA", `edit ${idx + 1} (${o.op}): unknown field ${k}`);
    out.push({ op: { ...o, file: normalizeRel(o.file) } as NonTextEdit, meta: { requirementIds: [...requirementIds], taskIds: [...taskIds], actionIds: actionIds.length ? [...actionIds] : [`edit:${idx + 1}`] } });
  });
  return out;
}
const b64 = (s: unknown): Buffer | null => (typeof s === "string" && s.length <= Math.ceil(MAX_BINARY_BYTES * 4 / 3) + 8 && /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0 ? Buffer.from(s, "base64") : null);

/** Everything admission rejects for binary, mode and symlink edits. Pure given the base tree. */
export function nonTextAdmission(extra: NonTextExpanded[], expanded: Expanded[], scope: CandidateScope, baseRoot: string): string[] {
  const problems: string[] = []; const allowProtected = new Set((scope.allowProtected ?? []).map(normalizeRel));
  const seen = new Map<string, string[]>();
  for (const e of expanded) seen.set(normalizeRel(e.op.file), [...(seen.get(normalizeRel(e.op.file)) ?? []), e.op.op]);
  for (const x of extra) seen.set(x.op.file, [...(seen.get(x.op.file) ?? []), x.op.op]);
  const extraPaths = new Set(extra.map((x) => x.op.file));
  for (const [f, kinds] of seen) { if (!extraPaths.has(f)) continue; const rest = kinds.filter((k) => k !== "SET_MODE"); if (kinds.filter((k) => k === "SET_MODE").length > 1 || !(rest.length <= 1 || rest.every((k) => k === "REPLACE_SPAN"))) problems.push(`conflicting operations on ${f}: ${kinds.join(", ")}`); }
  for (const { op } of extra) {
    const rel = op.file;
    if (NEVER.some((re) => re.test(rel))) { problems.push(`secrets and VCS paths are never edited: ${rel}`); continue; }
    let base: CandidateEntry | null = null; try { base = readEntry(baseRoot, rel); } catch { problems.push(`${rel} cannot be read in the base tree`); continue; }
    const creates = expanded.some((e) => normalizeRel(e.op.file) === rel && e.op.op === "CREATE_FILE") || extra.some((y) => y.op.file === rel && (y.op.op === "CREATE_BINARY" || y.op.op === "CREATE_SYMLINK"));
    if (isTestPath(rel)) { if (!(op.op === "CREATE_BINARY" || op.op === "CREATE_SYMLINK") && base && !scope.allowTestEdits) problems.push(`editing the existing test file ${rel} is a property change and needs a policy grant (allowTestEdits)`); }
    else if (isProtectedPath(rel) && !allowProtected.has(rel)) problems.push(`protected path (CI config, lockfile or tool config) needs an exact security grant: ${rel}`);
    if (passesThroughLink(baseRoot, rel)) problems.push(`${rel} is below a symlink`);
    switch (op.op) {
      case "CREATE_BINARY": { const bytes = b64(op.base64); if (!bytes) problems.push(`${rel}: base64 is invalid or larger than ${MAX_BINARY_BYTES} bytes`); else if (bytes.length > MAX_BINARY_BYTES) problems.push(`${rel}: ${bytes.length} bytes is more than the ${MAX_BINARY_BYTES}-byte binary limit`); if (base) problems.push(`${rel} already exists; use REPLACE_BINARY`); if (op.mode !== undefined && !(FILE_MODES as readonly string[]).includes(op.mode) ) problems.push(`${rel}: mode must be 100644 or 100755`); break; }
      case "REPLACE_BINARY": { const bytes = b64(op.base64); if (!bytes) problems.push(`${rel}: base64 is invalid or too large`); if (!base || base.kind === "SYMLINK") problems.push(`${rel} is not an existing file`); else if (base.hash !== op.baseHash) problems.push(`${rel} has changed since the proposer read it (base hash mismatch)`); break; }
      case "SET_MODE": { if (!(FILE_MODES as readonly string[]).includes(op.mode)) problems.push(`${rel}: mode must be 100644 or 100755 (a gitlink or link mode is never set this way)`); if (!base && !creates) problems.push(`${rel} does not exist`); else if (base && base.kind === "SYMLINK") problems.push(`${rel} is a symlink; it has no executable bit`); else if (base && op.baseHash !== undefined && base.hash !== op.baseHash) problems.push(`${rel} has changed since the proposer read it (base hash mismatch)`); else if (base && op.baseHash === undefined && !creates) problems.push(`${rel}: SET_MODE on an existing file needs its baseHash`); break; }
      case "CREATE_SYMLINK": { const why = symlinkProblem(rel, op.target); if (why) problems.push(`${rel}: ${why}`); if (base) problems.push(`${rel} already exists`); break; }
      case "RETARGET_SYMLINK": { const why = symlinkProblem(rel, op.target); if (why) problems.push(`${rel}: ${why}`); if (base?.kind !== "SYMLINK") problems.push(`${rel} is not an existing symlink`); else if (base.target !== op.baseTarget) problems.push(`${rel} points somewhere else than the proposer read (base target mismatch)`); break; }
      case "REMOVE_SYMLINK": { if (base?.kind !== "SYMLINK") problems.push(`${rel} is not an existing symlink`); else if (base.target !== op.baseTarget) problems.push(`${rel} points somewhere else than the proposer read (base target mismatch)`); break; }
    }
  }
  // the file cap counts every path, text or not
  const total = new Set([...expanded.map((e) => normalizeRel(e.op.file)), ...extra.map((x) => x.op.file)]).size; const cap = scope.maxFilesChanged ?? DEFAULT_MAX_FILES;
  if (extra.length && total > cap) problems.push(`the candidate changes ${total} files; the limit is ${cap}`);
  return [...new Set(problems)];
}

function applyNonText(dir: string, extra: NonTextExpanded[]): void {
  for (const { op } of extra) {
    const abs = safeJoin(dir, op.file); mkdirSync(dirname(abs), { recursive: true });
    switch (op.op) {
      case "CREATE_BINARY": writeFileSync(abs, Buffer.from(op.base64, "base64")); chmodSync(abs, op.mode === "100755" ? 0o755 : 0o644); break;
      case "REPLACE_BINARY": { const mode = readEntry(dir, op.file)?.mode; rmSync(abs, { force: true }); writeFileSync(abs, Buffer.from(op.base64, "base64")); chmodSync(abs, mode === "100755" ? 0o755 : 0o644); break; }
      case "SET_MODE": chmodSync(abs, op.mode === "100755" ? 0o755 : 0o644); break;
      case "CREATE_SYMLINK": symlinkSync(op.target, abs); break;
      case "RETARGET_SYMLINK": rmSync(abs, { force: true }); symlinkSync(op.target, abs); break;
      case "REMOVE_SYMLINK": rmSync(abs, { force: true }); break;
    }
  }
}
const safeJoinSafe = (root: string, rel: string): string => { try { return safeJoin(root, rel); } catch { return root + "/\0invalid"; } };

/** Dependency-section and install-script changes between two package.json texts. */
export function dependencyChanges(before: string | null, after: string | null): string[] {
  const parse = (t: string | null): Record<string, any> => { if (t === null) return {}; try { return JSON.parse(t); } catch { return { __invalid: true }; } };
  const a = parse(before), b = parse(after), out: string[] = [];
  if (b.__invalid) out.push("package.json is no longer valid JSON");
  for (const s of DEP_SECTIONS) if (JSON.stringify(a[s] ?? null) !== JSON.stringify(b[s] ?? null)) out.push(`package.json ${s} changed`);
  for (const s of INSTALL_SCRIPTS) if ((a.scripts?.[s] ?? null) !== (b.scripts?.[s] ?? null)) out.push(`package.json scripts.${s} changed`);
  return out;
}

const textFiles = (root: string, pred: (rel: string) => boolean): Map<string, string> => {
  const m = new Map<string, string>();
  for (const rel of walkFiles(root, pred)) { try { m.set(rel, readFileSync(safeJoin(root, rel), "utf8")); } catch { /* unreadable: not an oracle we can compare */ } }
  return m;
};
const isCode = (rel: string) => /\.[cm]?[jt]sx?$/.test(rel);
const oracleHash = (files: string[], read: (rel: string) => string | null): Hash => sha256(JSON.stringify(files.map((f) => [f, read(f) === null ? null : sha256(read(f)!)])));

/** Build the candidate in a scratch copy. Throws FeatureError for anything that must not become a candidate. */
export function materializeCandidate(d: CandidateDeps, actor: Id, i: MaterializeInput): { candidate: CandidateRecord; replayed: boolean } {
  const rec = d.fs.getRequest(i.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (rec.createdBy !== actor) throw new FeatureError("FORBIDDEN", "only the requester can build candidates for this request");
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  if (rec.mode === "PLAN") throw new FeatureError("FORBIDDEN", "this request was made in PLAN mode; it produces a plan, not a candidate");
  if (rec.state !== "CONTRACTING" && rec.state !== "IMPLEMENTING" && rec.state !== "VALIDATING" && rec.state !== "REVIEW_READY") throw new FeatureError("ILLEGAL_TRANSITION", `a candidate cannot be built while the request is ${rec.state}`);
  if (!rec.contract) throw new FeatureError("BLOCKED", "there is no contract yet; a candidate is always bound to one (requirements are normalised in task 2.I)");
  const supported = alreadySupported(rec);
  if (supported) throw new FeatureError("FORBIDDEN", `this request is already supported by ${supported.entryPoint || "an existing capability"} (verified); nothing needs to change. Open the existing feature, report a discrepancy, or change its behaviour instead`);
  if (rec.blockers.length) throw new FeatureError("BLOCKED", `${rec.blockers.length} open item(s) must be resolved first: ${rec.blockers.map((b) => b.id).join(", ")}`);
  if (rec.issue.syncState === "TRACKING_BLOCKED") throw new FeatureError("BLOCKED", "issue tracking is mandatory for this request and no issue is bound yet; bind one before anything is built");

  const live = snapshotOf(d.store, rec.repositoryId);
  if (i.snapshot.contentRootHash !== live.contentRootHash) throw new FeatureError("STALE_REVISION", "the repository changed since this snapshot was taken");
  if (rec.source.contentRootHash !== live.contentRootHash) throw new FeatureError("STALE_REVISION", "the repository changed since the request was analysed; run discovery again so the contract matches the code");

  const scope = i.scope ?? {};
  for (const [flag, on, auth] of [["allowTestEdits", scope.allowTestEdits, "policy"], ["allowNewDependencies", scope.allowNewDependencies, "security"], ["allowProtected", (scope.allowProtected ?? []).length > 0, "security"]] as const) {
    if (!on) continue;
    const v = authorize(d.auth, actor, auth, rec.createdBy);
    if (!v.allowed) throw new FeatureError("FORBIDDEN", `${flag} needs ${auth} authority: ${v.reason}`);
  }

  const baseDir = makeScratch("pf-base-"), candDir = makeScratch("pf-cand-");
  try {
    try { copyTreeKeepLinks(rec.repositoryId, baseDir); copyTreeKeepLinks(rec.repositoryId, candDir); } catch (e) { throw new FeatureError("FORBIDDEN", `the repository cannot be copied safely: ${(e as Error).message}`); }
    if (!Array.isArray(i.edits) || !i.edits.length) throw new FeatureError("INVALID_SCHEMA", "a candidate needs at least one edit");
    const expanded = parseEdits(i.edits, baseDir), extra = parseNonText(i.edits);
    const problems = [...featureAdmission(expanded, scope, baseDir).filter((p) => !(extra.length && /returned no operations/.test(p))), ...nonTextAdmission(extra, expanded, scope, baseDir)];
    if (problems.length) throw new FeatureError("FORBIDDEN", `the candidate was rejected: ${problems.join("; ")}`);

    // ---- apply
    const spans = expanded.filter((e) => e.op.op === "REPLACE_SPAN").map((e) => e.op as Extract<EditOperation, { op: "REPLACE_SPAN" }>);
    try {
      applyTextEdits(candDir, spans.map((o) => ({ file: normalizeRel(o.file), start: o.start, end: o.end, expected: o.expected, newText: o.newText })));
      for (const e of expanded) {
        const rel = normalizeRel(e.op.file);
        if (e.op.op === "DELETE_FILE") rmSync(safeJoin(candDir, rel), { force: true });
      }
      for (const e of expanded) {
        const rel = normalizeRel(e.op.file);
        if (e.op.op === "CREATE_FILE") { const p = safeJoin(candDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, e.op.content); }
      }
      applyNonText(candDir, extra);
    } catch (e) {
      if (e instanceof FeatureError) throw e;
      const code = (e as { code?: string }).code;
      throw new FeatureError(code === "STALE_REVISION" ? "STALE_REVISION" : "FORBIDDEN", `the edits could not be applied: ${(e as Error).message}`);
    }

    // ---- what changed, from the trees themselves (content, mode and kind all count)
    const deltas = diffTrees(baseDir, candDir);
    if (!deltas.length) throw new FeatureError("INVALID_SCHEMA", "the candidate changes no file: there is nothing to validate or publish");
    const ctxPolicy = policyFor(d.store, rec.repositoryId);
    if (deltas.some((c) => ctxPolicy.denied(c.file))) throw new FeatureError("FORBIDDEN", "the candidate touches a path you do not have access to");

    const contents: Record<string, string | null> = {}, baseContents: Record<string, string | null> = {}, entries: Record<string, CandidateEntry | null> = {}, baseEntries: Record<string, CandidateEntry | null> = {};
    let bytes = 0;
    const side = (e: CandidateEntry | null, root: string, file: string, text: Record<string, string | null>, ents: Record<string, CandidateEntry | null>) => {
      ents[file] = e ? (e.kind === "TEXT" ? { kind: e.kind, mode: e.mode, hash: e.hash, size: e.size } : e) : null;
      if (e) bytes += e.size;
      if (e?.kind === "TEXT") text[file] = readFileSync(safeJoin(root, file), "utf8");
      if (e?.kind === "BINARY" && e.size > MAX_BINARY_BYTES) throw new FeatureError("RESOURCE_LIMIT", `${file} is ${e.size} bytes; the binary limit is ${MAX_BINARY_BYTES}`);
    };
    for (const c of deltas) {
      const before = c.kind === "ADDED" ? null : readEntry(baseDir, c.file), after = c.kind === "DELETED" ? null : readEntry(candDir, c.file);
      side(before, baseDir, c.file, baseContents, baseEntries); side(after, candDir, c.file, contents, entries);
      if (before === null) baseContents[c.file] = null; // added: nothing in the base
      if (after === null && before?.kind === "TEXT") contents[c.file] = null; // a deleted text file keeps its null marker
    }
    if (bytes > MAX_TOTAL_BYTES) throw new FeatureError("RESOURCE_LIMIT", `the candidate changes ${bytes} bytes; the limit is ${MAX_TOTAL_BYTES}`);
    const depProblems = deltas.filter((c) => /(^|\/)package\.json$/.test(c.file)).flatMap((c) => dependencyChanges(baseContents[c.file] ?? null, contents[c.file] ?? null));
    if (depProblems.length && !scope.allowNewDependencies) throw new FeatureError("FORBIDDEN", `the candidate was rejected: ${depProblems.join("; ")} (needs a security grant: allowNewDependencies)`);

    const attrib: Attrib[] = [...expanded.map((e) => ({ paths: e.rename ? [e.rename.from, e.rename.to] : [normalizeRel(e.op.file)], meta: e.meta })), ...extra.map((x) => ({ paths: [x.op.file], meta: x.meta }))];
    const mutations = inventory(deltas, attrib, entries, baseEntries);
    const notes: string[] = [];
    const touched = new Set(attrib.flatMap((a) => a.paths));
    for (const f of touched) if (!deltas.some((c) => c.file === f)) notes.push(`${f} was named by an edit but ended up unchanged`);

    // ---- oracle: the tests that exist in the base, and what the candidate did to them
    const baseTests = textFiles(baseDir, (rel) => isTestPath(rel) && isCode(rel)), candTests = textFiles(candDir, (rel) => isTestPath(rel) && isCode(rel));
    // A repair is a later candidate of the same request: tests the EARLIER candidate added or changed are oracle too, so weakening them
    // (to make a failing check pass) is a property change exactly like weakening a test that was already in the repository.
    const prior = d.fs.listCandidates(rec.requestId).filter((c) => c.contents).at(-1);
    const priorTests = new Map<string, string>(Object.entries(prior?.contents ?? {}).filter((e): e is [string, string] => e[1] !== null && isTestPath(e[0]) && isCode(e[0])));
    const repairChanges = prior ? detectOracleWeakening(priorTests, candTests).map((c) => ({ ...c, kind: `REPAIR_${c.kind}`, detail: `${c.detail} (compared with the previous candidate)` })) : [];
    const oracleChanges = [...detectOracleWeakening(baseTests, candTests), ...repairChanges];
    const oracleFiles = [...new Set((rec.contract.acceptance ?? []).flatMap((a) => a.oracleSourceRefs.filter((r) => r.locator.startsWith("repo:")).map((r) => normalizeRel(r.locator.slice(5)))))].filter((f) => baseTests.has(f)).sort();
    const oracleFilesAll = oracleFiles.length ? oracleFiles : [...baseTests.keys()].sort();
    const readOr = (root: string) => (rel: string) => { try { return readFileSync(safeJoin(root, rel), "utf8"); } catch { return null; } };
    const originalOracleHash = oracleHash(oracleFilesAll, readOr(baseDir)), candidateOracleHash = oracleHash(oracleFilesAll, readOr(candDir));
    const oracleState: CandidateRecord["oracleState"] = !baseTests.size ? "NO_ORACLE" : oracleChanges.length || originalOracleHash !== candidateOracleHash ? "PROPERTY_CHANGE_PENDING_REVIEW" : "ORIGINAL_PRESERVED";

    // ---- binding
    const rootOf = (dir: string) => contentRoot(entriesFromDirectory(dir, { exclude: [] }));
    const editsHash = sha256(JSON.stringify(i.edits));
    const binding: PatchBinding = {
      repositoryId: rec.repositoryId, baseCommitHash: live.commitHash, baseContentHash: rootOf(baseDir), candidateContentHash: rootOf(candDir), diffHash: canonHash(DiffSchema, deltas),
      contractHash: rec.contract.hash, originalOracleHash, candidateOracleHash, runManifestIds: [], mutationInventoryHash: canonHash(MutationSchema, mutations),
      generationProvenanceHash: canonHash(ProvenanceSchema, { invocationIds: [...new Set(i.invocationIds ?? [])], editsHash }),
    };
    const bindingHash = canonHash(PatchBindingSchema, binding);
    const existing = d.fs.listCandidates(rec.requestId).find((c) => c.bindingHash === bindingHash);
    if (existing?.status === "MATERIALIZED") return { candidate: existing, replayed: true };

    // The same edits built again after another candidate replaced them (or after the base moved and came back) revive that record
    // rather than creating a second one with the same binding.
    const candidate: CandidateRecord = {
      schemaVersion: 1, id: `cand:${bindingHash.split(":").pop()!.slice(0, 24)}`, requestId: rec.requestId, ordinal: existing?.ordinal ?? d.fs.nextOrdinal(rec.requestId), binding, bindingHash,
      mutations, invocationIds: [...new Set(i.invocationIds ?? [])], status: "MATERIALIZED", createdAt: new Date().toISOString(),
      contents, baseContents, entries, baseEntries, baseSnapshotRoot: live.contentRootHash, oracleState, oracleChanges, notes: [...notes, ...depProblems],
    };
    // Earlier candidates of this request are superseded, then the new one is saved with its event.
    for (const c of d.fs.listCandidates(rec.requestId)) if (c.id !== `cand:${bindingHash.split(":").pop()!.slice(0, 24)}` && (c.status === "MATERIALIZED" || c.status === "PLANNED")) d.fs.putCandidate({ ...c, status: "SUPERSEDED" });
    d.fs.putCandidate(candidate, eventFor(rec, "CandidateCreated", actor, { after: bindingHash, requirementIds: [...new Set(mutations.flatMap((m) => m.requirementIds))],
      rationale: `${mutations.length} file(s): ${count(mutations, "ADDED")} added, ${count(mutations, "MODIFIED")} modified, ${count(mutations, "DELETED")} deleted, ${count(mutations, "RENAMED")} renamed; oracle ${oracleState}` }));
    let cur = d.fs.getRequest(rec.requestId)!;
    if (cur.state === "CONTRACTING") cur = transition(d.fs, cur.requestId, cur.version, "IMPLEMENTING", actor, "candidate built");
    d.fs.updateRequest(cur.requestId, cur.version, { ...cur, workspace: { ...cur.workspace, candidateHash: bindingHash, workspaceVersion: cur.workspace.workspaceVersion + 1 } });
    return { candidate, replayed: false };
  } finally { removeScratch(baseDir); removeScratch(candDir); }
}
const count = (ms: FileMutation[], k: FileMutation["kind"]) => ms.filter((m) => m.kind === k).length;

export type Attrib = { paths: string[]; meta: Meta3 };
/** One FileMutation per changed path, from the tree diff. Delete+add of an identical blob (same bytes, mode and kind) is a rename; attribution comes from the edits that touched it. */
export function inventory(deltas: TreeDelta[], attrib: Attrib[], entries: Record<string, CandidateEntry | null> = {}, baseEntries: Record<string, CandidateEntry | null> = {}): FileMutation[] {
  const deleted = deltas.filter((c) => c.kind === "DELETED"), added = deltas.filter((c) => c.kind === "ADDED");
  const same = (x?: { hash: string; mode: string; kind: string }, y?: { hash: string; mode: string; kind: string }) => !!x && !!y && x.hash === y.hash && x.mode === y.mode && x.kind === y.kind;
  const pairs = new Map<string, string>(); const used = new Set<string>();
  for (const del of deleted) { const to = added.find((a) => !used.has(a.file) && same(a.after, del.before)); if (to) { used.add(to.file); pairs.set(del.file, to.file); } }
  const editsFor = (paths: string[]) => attrib.filter((e) => e.paths.some((p) => paths.includes(p)));
  const attribution = (es: Attrib[]): FileMutation["attribution"] => !es.length || es.every((e) => !e.meta.requirementIds.length) ? "UNATTRIBUTED" : es.every((e) => e.meta.requirementIds.length) ? "COMPLETE" : "PARTIAL";
  const supporting = (p: string) => isTestPath(p) || /\.(md|mdx|txt)$|(^|\/)docs?\//i.test(p);
  const out: FileMutation[] = [];
  for (const c of deltas) {
    if (c.kind === "ADDED" && [...pairs.values()].includes(c.file)) continue;
    const to = c.kind === "DELETED" ? pairs.get(c.file) : undefined;
    const paths = to ? [c.file, to] : [c.file], es = editsFor(paths);
    const after = c.kind === "DELETED" ? undefined : entries[c.file] ?? undefined, before = c.kind === "ADDED" ? undefined : baseEntries[c.file] ?? undefined;
    const kind = (to ? entries[to] : after)?.kind ?? before?.kind ?? "TEXT";
    const modes = (before && before.mode !== "100644") || (after && after.mode !== "100644") || (before && after && before.mode !== after.mode);
    out.push({
      oldPath: c.kind === "ADDED" ? undefined : c.file, newPath: to ?? (c.kind === "DELETED" ? undefined : c.file), kind: to ? "RENAMED" : c.kind,
      beforeHash: c.before?.hash, afterHash: to ? c.before?.hash : c.after?.hash,
      ...(kind !== "TEXT" ? { entryKind: kind } : {}), ...(before && before.kind !== kind ? { beforeKind: before.kind } : {}),
      ...(modes ? { beforeMode: before?.mode, afterMode: (to ? entries[to] : after)?.mode } : {}),
      requirementIds: [...new Set(es.flatMap((e) => e.meta.requirementIds))].sort(), taskIds: [...new Set(es.flatMap((e) => e.meta.taskIds))].sort(), actionIds: [...new Set(es.flatMap((e) => e.meta.actionIds))].sort(),
      attribution: attribution(es), supporting: supporting(to ?? c.file) || undefined,
    });
  }
  return out.sort((a, b) => (a.newPath ?? a.oldPath!).localeCompare(b.newPath ?? b.oldPath!));
}

// ------------------------------------------------------------------------------------------------ staleness

/** Any change to the repository after a candidate was built makes it stale (PF-021). Returns the candidates that were marked. */
export function refreshStaleness(d: CandidateDeps, actor: Id, requestId: Id): Id[] {
  const rec = d.fs.getRequest(requestId); if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  const live = snapshotOf(d.store, rec.repositoryId); const marked: Id[] = [];
  for (const c of d.fs.listCandidates(requestId)) {
    if ((c.status === "MATERIALIZED" || c.status === "PLANNED") && c.baseSnapshotRoot && c.baseSnapshotRoot !== live.contentRootHash) {
      d.fs.putCandidate({ ...c, status: "STALE" }, eventFor(rec, "VerificationInvalidated", actor, { before: c.bindingHash, result: "BLOCKED", rationale: "the repository changed after this candidate was built" })); marked.push(c.id);
    }
  }
  return marked;
}

// ------------------------------------------------------------------------------------------------ reading

export type Representation = "CANDIDATE" | "BASELINE" | "UNIFIED_DIFF" | "SPLIT_DIFF";
const MAX_READ_CHARS = 200_000;

function diffText(path: string, a: string | null, b: string | null): string {
  if (a === null && b !== null) { const l = b.split("\n"); return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${l.length} @@\n${l.map((x) => "+" + x).join("\n")}\n`; }
  if (b === null && a !== null) { const l = a.split("\n"); return `--- a/${path}\n+++ /dev/null\n@@ -1,${l.length} +0,0 @@\n${l.map((x) => "-" + x).join("\n")}\n`; }
  return unifiedDiff(path, a ?? "", b ?? "");
}
function splitDiff(a: string | null, b: string | null): string {
  const al = (a ?? "").split("\n"), bl = (b ?? "").split("\n");
  let pre = 0; while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
  let sa = al.length, sb = bl.length; while (sa > pre && sb > pre && al[sa - 1] === bl[sb - 1]) { sa--; sb--; }
  const rows: { left: string | null; right: string | null; change: "same" | "changed" }[] = [];
  for (let k = 0; k < pre; k++) rows.push({ left: al[k]!, right: bl[k]!, change: "same" });
  for (let k = 0; k < Math.max(sa - pre, sb - pre); k++) rows.push({ left: pre + k < sa ? al[pre + k]! : null, right: pre + k < sb ? bl[pre + k]! : null, change: "changed" });
  for (let k = 0; k < al.length - sa; k++) rows.push({ left: al[sa + k]!, right: bl[sb + k]!, change: "same" });
  return JSON.stringify(rows);
}

/** A binary file or a link is never shown as text: the reader gets its kind, mode, size and hash, and the bytes only through an explicit download. */
function describeNonText(cand: CandidateRecord, rel: string, i: { representation: string; download?: boolean }, entry: CandidateEntry | null, base: CandidateEntry | null): Outcome<{ sourceArtifactRef: Id; content: string; complete: boolean; startLine?: number; totalLines?: number; binary?: boolean; encoding?: string }> {
  const e = i.representation === "BASELINE" ? base : entry;
  if (!e) throw new FeatureError("NOT_FOUND", i.representation === "BASELINE" ? `${rel} does not exist in the base` : `${rel} is deleted in this candidate`);
  const ref = `${cand.bindingHash}:${rel}:${i.representation}`;
  if (e.kind === "SYMLINK") return { status: "COMPLETE", value: { sourceArtifactRef: ref, content: `symlink ${rel} -> ${e.target}\nmode ${e.mode}`, complete: true, startLine: 1, totalLines: 2, binary: false }, evidenceIds: [cand.id], diagnostics: [] };
  const summary = `binary file ${rel}\n${e.size} bytes · mode ${e.mode} · sha-256 ${e.hash}${base && entry ? `\nbefore: ${base.kind === "SYMLINK" ? "symlink" : `${base.size} bytes · mode ${base.mode} · ${base.hash}`}` : ""}`;
  if (i.download && (i.representation === "CANDIDATE" || i.representation === "BASELINE")) return { status: "COMPLETE", value: { sourceArtifactRef: ref, content: e.base64 ?? "", complete: true, binary: true, encoding: "base64" }, evidenceIds: [cand.id], diagnostics: [] };
  return { status: "PARTIAL", value: { sourceArtifactRef: ref, content: summary, complete: false, startLine: 1, totalLines: summary.split("\n").length, binary: true }, evidenceIds: [cand.id], diagnostics: ["a binary file is not shown as text; download it to see its bytes"] };
}

export function readCandidateFile(d: CandidateDeps, i: { candidateHash: Hash; path: string; range?: [number, number]; representation: Representation; download?: boolean }): Outcome<{ sourceArtifactRef: Id; content: string; complete: boolean; startLine?: number; nextLine?: number; totalLines?: number }> {
  const cand = d.fs.getCandidateByBinding(i.candidateHash);
  if (!cand) throw new FeatureError("NOT_FOUND", "no such candidate");
  if (!["CANDIDATE", "BASELINE", "UNIFIED_DIFF", "SPLIT_DIFF"].includes(i.representation)) throw new FeatureError("INVALID_SCHEMA", "unknown file representation");
  const rec = d.fs.getRequest(cand.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", "the candidate's request no longer exists");
  if (typeof i.path !== "string" || !i.path || i.path.includes("\0")) throw new FeatureError("INVALID_SCHEMA", "a path is required");
  const rel = normalizeRel(i.path);
  if (i.path.startsWith("/") || i.path.split(/[\\/]/).includes("..")) throw new FeatureError("INVALID_SCHEMA", "the path must be inside the repository");
  if (policyFor(d.store, rec.repositoryId).denied(rel)) throw new FeatureError("NOT_FOUND", "no such file in this candidate");
  const contents = cand.contents ?? {}, baseContents = cand.baseContents ?? {};
  const entry = (cand.entries ?? {})[rel], baseEntry = (cand.baseEntries ?? {})[rel];
  const nonText = (entry && entry.kind !== "TEXT") || (baseEntry && baseEntry.kind !== "TEXT");
  const changed = rel in contents || rel in (cand.entries ?? {});
  if (nonText) return describeNonText(cand, rel, i, entry ?? null, baseEntry ?? null);
  let candidateText: string | null, baseText: string | null;
  if (changed) { candidateText = contents[rel] ?? null; baseText = baseContents[rel] ?? null; }
  else {
    // An unchanged file is the same in the base and the candidate; read it from the repository only while the base still stands.
    if (cand.status === "STALE" || (cand.baseSnapshotRoot && cand.baseSnapshotRoot !== snapshotOf(d.store, rec.repositoryId).contentRootHash)) throw new FeatureError("STALE_REVISION", "the repository changed since this candidate was built, so an unchanged file can no longer be shown as part of it");
    try { candidateText = baseText = readFileSync(safeJoin(rec.repositoryId, rel), "utf8"); } catch { throw new FeatureError("NOT_FOUND", "no such file in this candidate"); }
    if (/(^|\/)\.env(\.|$)/.test(rel)) throw new FeatureError("NOT_FOUND", "no such file in this candidate");
  }
  if (candidateText === null && i.representation === "CANDIDATE") throw new FeatureError("NOT_FOUND", `${rel} is deleted in this candidate`);
  if (baseText === null && i.representation === "BASELINE") throw new FeatureError("NOT_FOUND", `${rel} does not exist in the base`);
  let content = i.representation === "CANDIDATE" ? candidateText! : i.representation === "BASELINE" ? baseText! : i.representation === "UNIFIED_DIFF" ? diffText(rel, baseText, candidateText) : splitDiff(baseText, candidateText);
  const lines: unknown[] = i.representation === "SPLIT_DIFF" ? JSON.parse(content) : content.split("\n");
  const [from, to] = i.download ? [1, lines.length] : i.range ?? [1, 400];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new FeatureError("INVALID_SCHEMA", "range is [firstLine, lastLine], 1-based and ordered");
  let complete = from === 1 && to >= lines.length;
  const page = lines.slice(from - 1, to);
  content = i.representation === "SPLIT_DIFF" ? JSON.stringify(page) : page.join("\n");
  if (i.download && content.length > MAX_TOTAL_BYTES) throw new FeatureError("RESOURCE_LIMIT", "authorized file download exceeds the 4 MiB limit");
  if (!i.download && content.length > MAX_READ_CHARS) {
    if (i.representation === "SPLIT_DIFF") throw new FeatureError("RESOURCE_LIMIT", "split diff page is too large; request a narrower range");
    content = content.slice(0, MAX_READ_CHARS); complete = false;
  }
  return { status: complete ? "COMPLETE" : "PARTIAL", value: { sourceArtifactRef: `${cand.bindingHash}:${rel}:${i.representation}`, content, complete, startLine: from, totalLines: lines.length, ...(to < lines.length ? { nextLine: to + 1 } : {}) }, evidenceIds: [cand.id], diagnostics: complete ? [] : ["partial file view; load another page or download the authorized full file"] };
}
