// F06 — Historical hotspots and change coupling.
//
// One paragraph: the repository's own git history is read in windows (rename-aware, streamed in
// pages, incremental over `prev..head`), commits are grouped into logical changes and classified
// (bulk/format/bot/revert pairs are excluded, always listed), files are followed through renames
// as lineages, and each lineage is scored from change frequency (time-decayed, percentile-
// normalised), code-health signals (AST metrics from the Rust worker), impact (dependents,
// incidents, coverage) and knowledge concentration; statistical co-change edges
// (support/confidence/lift) form a relation separate from the static graph. Everything is
// reproducible for a given boundary and policy hash, explains itself down to the commits (§7.10),
// and contributor identity is a keyed hash whose display names are returned only to authorised
// principals (F06-A6).
//
// Honesty rules this file keeps (each has a named test):
//  - a rename does not reset history (F06-A1): counting aggregates by lineage, not path;
//  - bulk formatting cannot dominate rankings without disclosure; switching a rule off is a
//    policy change that yields a comparable analysis (F06-A2);
//  - small-sample coupling states its support ("14 of 31") or is not reported (F06-A3);
//  - scores are reproducible: same boundary + policy → identical stored rows (F06-A4);
//  - every ranking opens into factors, counted changes and the excluded commits (F06-A5);
//  - contributor names are absent everywhere unless the policy and a grant allow them (F06-A6);
//  - co-change lives in its own table and its own operations, never in the static graph (§6.3);
//  - a heuristic is called a prioritisation heuristic (§12.2): never defect probability, never
//    per-person productivity.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ApiError, CallContext, CommitEvidence, CouplingEdgeView, ExcludedCommitView, ExplainCouplingView, ExplainHotspotView,
  ExclusionSummary, FactorExplanation, HealthSignal, HistoryBoundaryView, HistoryPolicy, HotspotReportView,
  HotspotScoreRow, RankSensitivity, RankStabilityView,
} from "@cie/schema";
import type { Store } from "./store.ts";
import type { WorkerClient } from "./worker.ts";
import { flowGraph } from "./forms/common.ts";
import { runtimeHotness } from "./hotness.ts";
import type { RevisionRow } from "./store.ts";

// ---------------------------------------------------------------------------
// small types, hashes, canonical JSON

export type ApiFail = { ok: false; error: ApiError; metadata: { requestId: string; completeness: "PARTIAL" | "COMPLETE"; warnings: string[] } };
export const failApi = (ctx: CallContext, code: ApiError["code"], message: string, retryable = false): ApiFail =>
  ({ ok: false, error: { code, message, retryable }, metadata: { requestId: ctx.requestId, completeness: "COMPLETE" as const, warnings: [] as string[] } });

export const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** Deterministic, key-order-insensitive JSON — what every reproducibility hash runs over. */
export const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.entries(v).filter(([, x]) => x !== undefined && x !== null).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`
  : JSON.stringify(v ?? null);

// ---------------------------------------------------------------------------
// bounds and defaults (§13 proposals)

export const FORMULA_VERSION = 1;
export const CAP_COMMITS = 20_000;
const READ_PAGE_COMMITS = 2_000;
const FORMAT_CANDIDATE_CAP = 100;
const COUPLING_PAIR_CAP = 2_000_000;
const MAX_EDGES_PER_FILE = 20;
const MAX_SCORE_ROWS_PAGE = 200;
const DEFAULT_SCORE_ROWS_PAGE = 50;
const MAX_EXPLAIN_COMMITS_PAGE = 50;
const MERGE_GROUP_COMMIT_LIMIT = 5_000;
const MERGE_GROUP_WALK_CAP = 4_000;
const MAX_HEALTH_FILES = 400;
const MONTH = 30 * 24 * 3600 * 1000;

export const FACTOR_IDS = ["change", "health", "impact", "coupling", "knowledge"] as const;
export type FactorId = (typeof FACTOR_IDS)[number];
export const FACTOR_LABELS: Record<FactorId, string> = {
  change: "Change frequency", health: "Code health debt", impact: "Impact",
  coupling: "Co-change fan-out", knowledge: "Knowledge concentration",
};
export const WEIGHT_PRESETS: Record<"default" | "refactor" | "security" | "incident", Record<FactorId, number>> = {
  default: { change: 0.3, health: 0.25, impact: 0.2, coupling: 0.15, knowledge: 0.1 },
  refactor: { change: 0.35, health: 0.3, impact: 0.05, coupling: 0.2, knowledge: 0.1 },
  security: { change: 0.2, health: 0.25, impact: 0.35, coupling: 0.1, knowledge: 0.1 },
  incident: { change: 0.25, health: 0.1, impact: 0.45, coupling: 0.1, knowledge: 0.1 },
};

export const DEFAULT_POLICY: HistoryPolicy = {
  window: { months: 12 },
  mergePolicy: "AUTO",
  rename: { enabled: true, similarityPercent: 50 },
  exclusions: { bulk: { files: 40, shareOfTracked: 0.2 }, format: true, botPatterns: ["bot@", "[bot]", "noreply@github.com", "renovate", "dependabot"], generated: true, revertPairs: true },
  decay: { halfLifeDays: 180 },
  coupling: { minSupport: 5, minConfidence: 0.3, maxFilesPerChange: 30, ubiquitousShare: 0.25 },
  health: { thresholds: { lengthLines: 80, complexity: 15, nesting: 4, params: 4, fileLines: 500 }, formulaVersion: FORMULA_VERSION },
  weights: { preset: "default" },
  contributors: "COUNTS_ONLY",
};

export const COMMIT_CLASSES = ["NORMAL", "BULK", "FORMAT", "RENAME_ONLY", "GENERATED_ONLY", "BOT", "MERGE", "REVERT", "REVERTED"] as const;
export type CommitClass = (typeof COMMIT_CLASSES)[number];
const COUNTED_FOR_FREQUENCY = new Set<CommitClass>(["NORMAL"]);
const COUNTED_FOR_COUPLING = COUNTED_FOR_FREQUENCY;

const GENERATED_GLOBS = /(^|\/)(generated|gens?|dist|build|out|target|vendor|third[_-]party)(\/|$)/i;
const GENERATED_SUFFIX = /\.(pb\.go|pb\.py|_pb2\.py|min\.js|min\.css)$/;
const GENERATED_PATHS = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|bun\.lockb|CHANGELOG(\.\w+)?)$/i;
const generatedPath = (p: string) => GENERATED_GLOBS.test("/" + p) || GENERATED_SUFFIX.test(p) || GENERATED_PATHS.test(p);

// ---------------------------------------------------------------------------
// git plumbing (gitinfo.ts's rules: no shell, bounded reads only)

const gitRun = (root: string, args: string[], max = 64 * 1024 * 1024, timeout = 20_000): string | null => {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout, maxBuffer: max, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
};

export interface HeadInfo { head: string; shallow: boolean; isRepo: boolean }
export const inspectHead = (root: string): HeadInfo => {
  const isRepo = gitRun(root, ["rev-parse", "--is-inside-work-tree"], 1024, 5_000)?.trim() === "true";
  if (!isRepo) return { head: "", shallow: false, isRepo: false };
  const head = gitRun(root, ["rev-parse", "HEAD"], 1024, 5_000)?.trim() ?? "";
  const shallow = gitRun(root, ["rev-parse", "--is-shallow-repository"], 1024, 5_000)?.trim() === "true";
  return { head, shallow, isRepo: true };
};
export const isAncestor = (root: string, older: string, newer: string): boolean =>
  !!older && !!newer && gitRun(root, ["merge-base", "--is-ancestor", older, newer], 1024, 5_000) !== null;
const commitCountBetween = (root: string, older: string, newer: string): number => {
  const out = gitRun(root, ["rev-list", "--count", `${older}..${newer}`], 1024, 10_000);
  const n = out === null ? 0 : Number(out.trim());
  return Number.isFinite(n) ? n : 0;
};

export interface RawFileChange { path: string; oldPath: string | null; status: "A" | "M" | "D" | "R" | "C" | "T"; similarity: number | null; insertions: number | null; deletions: number | null; generated: boolean }
export interface RawCommit {
  hash: string; email: string; committedAt: string; parents: string[]; subject: string;
  files: RawFileChange[]; insertions: number; deletions: number; binaryFiles: number;
  /** files.length, kept as a field because the classifier, coupling and reporting all read it. */
  filesChanged: number;
}

export interface WindowPlan {
  /** The window's commit ids, oldest first, capped at CAP_COMMITS (§7.1). */
  ids: string[]; cappedAt: number | null; shallow: boolean; head: string; until: string; since: string;
  firstParent: boolean; mergePolicyUsed: string;
  meta: Map<string, { parents: string[]; subject: string; email: string; committedAt: string }>;
}

export function planWindow(root: string, policy: HistoryPolicy): WindowPlan | { error: string } {
  const info = inspectHead(root);
  if (!info.isRepo) return { error: "this folder is not a Git repository, so history-based hotspots are unavailable" };
  const lastDate = gitRun(root, ["log", "-n1", "--format=%cI"], 1024);
  const untilRaw = policy.window.until ?? (lastDate ? lastDate.trim() : null);
  if (!untilRaw) return { error: "this repository has no commits yet" };
  const untilDate = new Date(untilRaw);
  if (Number.isNaN(untilDate.getTime())) return { error: `policy.window.until is not an ISO date: ${untilRaw}` };
  const sinceDate = policy.window.since ? new Date(policy.window.since) : new Date(untilDate.getTime() - (policy.window.months ?? 12) * MONTH);
  if (Number.isNaN(sinceDate.getTime())) return { error: `policy.window.since is not an ISO date: ${policy.window.since}` };
  if (sinceDate.getTime() > untilDate.getTime()) return { error: "the window's since date is after its until date" };
  const since = sinceDate.toISOString(), until = untilDate.toISOString();
  const metaRaw = gitRun(root, ["log", `--since=${since}`, `--until=${until}`, "--pretty=format:%H%x1f%ae%x1f%cI%x1f%s%x1f%P"]);
  if (metaRaw === null) return { error: "could not list the commits in the window" };
  const meta = new Map<string, { parents: string[]; subject: string; email: string; committedAt: string }>();
  let ids: string[] = [];
  let merges = 0, squash = 0;
  for (const line of metaRaw.split("\n")) {
    const [hash, email, committedAt, subject, parents = ""] = line.split("\x1f");
    if (!hash) continue;
    meta.set(hash, { parents: parents.trim().length ? parents.trim().split(" ") : [], subject: subject ?? "", email, committedAt });
    ids.push(hash);
  }
  let cappedAt: number | null = null;
  if (ids.length > CAP_COMMITS) { ids = ids.slice(ids.length - CAP_COMMITS); cappedAt = CAP_COMMITS; }
  // git log is newest-first; the pipeline walks oldest→newest so renames continue lineages (F06-A1).
  ids.reverse();
  for (const id of ids) {
    const m = meta.get(id);
    if (!m) continue;
    if (m.parents.length > 1) merges++;
    else if (/\(#\d+\)\s*$/.test(m.subject)) squash++;
  }
  let firstParent = false;
  let mergePolicyUsed: string = policy.mergePolicy === "AUTO" ? "ALL_NO_MERGE_DIFFS" : policy.mergePolicy;
  if (policy.mergePolicy === "AUTO") {
    const share = ids.length ? merges / ids.length : 0;
    if (share >= 0.15 && merges >= squash) { firstParent = true; mergePolicyUsed = "FIRST_PARENT"; }
    else if (merges === 0 && squash > 0) mergePolicyUsed = "SQUASH_ONLY";
  } else if (policy.mergePolicy === "FIRST_PARENT") firstParent = true;
  return { ids, cappedAt, shallow: info.shallow, head: info.head, until, since, firstParent, mergePolicyUsed, meta };
}

const resolveNumstatToken = (tok: string): string => {
  const t = tok.replace(/^"(.*)"$/, "$1");
  const braced = /^(.*)\{(.*)\s*=>\s*(.*)\}(.*)$/.exec(t);
  if (braced) return braced[1] + braced[3] + braced[4];
  const plain = /^(.*)\s+=>\s+(.*)$/.exec(t);
  return plain ? plain[2] : t;
};

/** The `-w` (ignore-whitespace) diff sum of a commit; 0 means formatting-only. Bounded, cached. */
const whitespaceChecker = (root: string) => {
  const cache = new Map<string, number | null>();
  let refused = false;
  return (hash: string): number | null => {
    if (refused || cache.size >= FORMAT_CANDIDATE_CAP) return null;
    if (cache.has(hash)) return cache.get(hash)!;
    const out = gitRun(root, ["diff-tree", "--numstat", "-r", "-w", "--no-commit-id", hash], 8 * 1024 * 1024);
    if (out === null) return null;
    let sum = 0;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [ins, del] = line.split("\t");
      sum += (ins === "-" || ins === undefined ? 0 : Number(ins) || 0) + (del === "-" || del === undefined ? 0 : Number(del) || 0);
    }
    cache.set(hash, sum);
    return sum;
  };
};

export const blameIgnoreSet = (root: string): Set<string> => {
  const out = new Set<string>();
  for (const rel of [".git-blame-ignore-revs", "blame-ignore-revs", ".github/blame-ignore-revs"]) {
    const raw = gitRun(root, ["show", `HEAD:${rel}`], 1024 * 1024) ?? (() => { try { return readFileSync(`${root}/${rel}`, "utf8"); } catch { return null; } })();
    if (raw === null) continue;
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([0-9a-fA-F]{40})/.exec(line);
      if (m) out.add(m[1].toLowerCase());
    }
    break;
  }
  return out;
};

export interface ReadResult { commits: RawCommit[]; deadlineHit: boolean; elapsedMs: number; gitError: string | null }

/**
 * The read (§7.1): pages of `--no-walk` ids (2,000 per invocation), each page's stdout parsed
 * incrementally; the deadline kills the current page and the rest (disclosed partial).
 * Under `--first-parent`, mainline merges carry their whole-feature (first-parent) diffs; under a
 * full list, merge commits produce no name-status rows at all — exactly the two policies' reads.
 */
export async function readCommits(root: string, ids: string[], opts: { firstParent: boolean; similarityPercent: number; deadlineMs: number }): Promise<ReadResult> {
  const started = Date.now();
  const commits: RawCommit[] = [];
  const seen = new Set<string>();
  let deadlineHit = false, gitError: string | null = null;
  // `--numstat` and `--name-status` are mutually exclusive in git's output; `--raw` and `--numstat`
  // together give both the status (with rename old paths) and the line counts in one pass.
  const fp = opts.firstParent ? ["-m", "--first-parent"] : [];
  const ren = opts.similarityPercent > 0 ? [`-M${Math.round(opts.similarityPercent)}%`, `--find-copies=${Math.round(opts.similarityPercent)}%`] : ["--no-renames"];
  for (let p = 0; p * READ_PAGE_COMMITS < ids.length; p++) {
    if (Date.now() - started > opts.deadlineMs) { deadlineHit = true; break; }
    const slice = ids.slice(p * READ_PAGE_COMMITS, (p + 1) * READ_PAGE_COMMITS);
    const child = spawn("git", ["-C", root, "log", "--no-walk=unsorted", "--no-color", "--raw", "--numstat", "--pretty=format:@@%H%x1f%ae%x1f%cI%x1f%s%x1f%P", ...fp, ...ren, ...slice], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { text += c; });
    const err = await new Promise<string | null>((done) => {
      const killer = setTimeout(() => { deadlineHit = true; try { child.kill("SIGKILL"); } catch { /* gone */ } done("deadline"); }, Math.max(50, opts.deadlineMs - (Date.now() - started)));
      child.on("error", (e: Error) => { clearTimeout(killer); done(String(e)); });
      child.on("close", (code) => { clearTimeout(killer); done(code === 0 ? null : (deadlineHit ? null : `git log exited with ${code}`)); });
    });
    if (err && err !== "deadline") { gitError = err; break; }
    parseLog(text, commits, seen);
  }
  return { commits, deadlineHit, elapsedMs: Date.now() - started, gitError };
}

function parseLog(text: string, out: RawCommit[], seen: Set<string>) {
  for (const block of text.split("\n@@")) {
    const first = block.startsWith("@@") ? block.slice(2) : block;
    if (!first.trim()) continue;
    const lines = first.split("\n");
    const [hash, email, committedAt, subject, parents = ""] = lines[0].replace(/\r$/, "").split("\x1f");
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const c: RawCommit = { hash, email: email ?? "", committedAt: committedAt ?? "", subject: subject ?? "", parents: (parents ?? "").trim().length ? (parents ?? "").trim().split(" ") : [], files: [], insertions: 0, deletions: 0, binaryFiles: 0, filesChanged: 0 };
    const nameStatus: RawFileChange[] = [];
    const nums: { ins: number | null; del: number | null; resolved: string }[] = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      if (line.startsWith(":")) {
        // `:100644 100644 <oldsha> <newsha> M\tpath` (or `R100\told\tnew`, `000000` for a create)
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const meta = line.slice(0, tab).split(" ");
        const token = meta[meta.length - 1] ?? "";
        const status = token[0] as RawFileChange["status"];
        if (!/^[A-Z]$/.test(status)) continue;
        const rest = line.slice(tab + 1).split("\t");
        const oldPath = status === "R" || status === "C" ? (rest[0] ?? null) : null;
        const path = status === "R" || status === "C" ? (rest[1] ?? "") : (rest[0] ?? "");
        const sim = token.length > 1 ? Number(token.slice(1)) : null;
        nameStatus.push({ path, oldPath, status, similarity: status === "R" ? (sim || 100) : status === "C" ? (sim || 100) : null, insertions: null, deletions: null, generated: generatedPath(path) });
      } else {
        const cols = line.split("\t");
        if (cols.length >= 3 && (cols[0] === "-" || /^\d+$/.test(cols[0])) && (cols[1] === "-" || /^\d+$/.test(cols[1]))) {
          const rawPath = cols.slice(2).join("\t");
          nums.push({ ins: cols[0] === "-" ? null : Number(cols[0]), del: cols[1] === "-" ? null : Number(cols[1]), resolved: resolveNumstatToken(rawPath) });
        }
      }
    }
    if (nums.length === nameStatus.length && nameStatus.length > 0) {
      // git emits the --name-status list and then the --numstat list for the same files, in order.
      for (let i = 0; i < nameStatus.length; i++) {
        nameStatus[i].insertions = nums[i]?.ins ?? null;
        nameStatus[i].deletions = nums[i]?.del ?? null;
      }
    } else {
      for (const f of nameStatus) {
        const n = nums.find((x) => x.resolved === f.path) ?? (f.oldPath ? nums.find((x) => x.resolved === f.oldPath) : undefined) ?? null;
        f.insertions = n?.ins ?? null;
        f.deletions = n?.del ?? null;
      }
    }
    for (const f of nameStatus) { c.insertions += f.insertions ?? 0; c.deletions += f.deletions ?? 0; if (f.insertions === null) c.binaryFiles++; }
    c.files = nameStatus;
    c.filesChanged = nameStatus.length;
    out.push(c);
  }
}

// ---------------------------------------------------------------------------
// policy normalisation and hashing

export class PolicyError extends Error {}

const num = (v: unknown, name: string, min: number, max: number, dflt: number): number => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new PolicyError(`${name} must be a number in [${min}, ${max}]`);
  return v;
};

export function normalizePolicy(input: unknown): HistoryPolicy {
  const src = (input ?? {}) as Record<string, unknown>;
  if (typeof src !== "object" || src === null) throw new PolicyError("policy must be an object");
  const win = (src.window ?? {}) as Record<string, unknown>;
  if (src.window !== undefined && typeof src.window !== "object") throw new PolicyError("policy.window must be an object");
  if (src.mergePolicy !== undefined && !["AUTO", "FIRST_PARENT", "ALL_NO_MERGE_DIFFS", "SQUASH_ONLY"].includes(src.mergePolicy as string)) throw new PolicyError("policy.mergePolicy must be AUTO, FIRST_PARENT, ALL_NO_MERGE_DIFFS or SQUASH_ONLY");
  const ren = (src.rename ?? {}) as Record<string, unknown>;
  const ex = (src.exclusions ?? {}) as Record<string, unknown>;
  const exBulk = { ...(DEFAULT_POLICY.exclusions.bulk), ...((ex.bulk ?? {}) as Record<string, unknown>) };
  const botPatterns = (ex.botPatterns as string[] | undefined) ?? DEFAULT_POLICY.exclusions.botPatterns;
  if (!Array.isArray(botPatterns) || botPatterns.length > 32 || botPatterns.some((p) => typeof p !== "string" || p.length > 120)) throw new PolicyError("policy.exclusions.botPatterns must be an array of short strings (≤ 32 entries)");
  const dec = (src.decay ?? {}) as Record<string, unknown>;
  const cou = { ...DEFAULT_POLICY.coupling, ...((src.coupling ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
  const wea = (src.weights ?? {}) as Record<string, unknown>;
  const preset = String(wea.preset ?? "default");
  if (!["default", "refactor", "security", "incident", "custom"].includes(preset)) throw new PolicyError(`policy.weights.preset must be default, refactor, security, incident or custom (got ${preset})`);
  const custom = (wea.custom ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(custom)) {
    if (!(FACTOR_IDS as readonly string[]).includes(k)) throw new PolicyError(`policy.weights.custom has unknown factor "${k}"; the factors are ${FACTOR_IDS.join(", ")}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 5) throw new PolicyError(`policy.weights.custom.${k} must be a number in [0, 5]`);
  }
  if (Object.keys(custom).length && preset !== "custom") throw new PolicyError(`a custom weight set requires preset "custom"`);
  const hea = (src.health ?? {}) as Record<string, unknown>;
  const thresholds: Record<string, number> = { ...DEFAULT_POLICY.health.thresholds };
  for (const [k, v] of Object.entries((hea.thresholds ?? {}) as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new PolicyError(`policy.health.thresholds.${k} must be a positive number`);
    thresholds[k] = v;
  }
  const contributors = (src.contributors ?? "COUNTS_ONLY") as HistoryPolicy["contributors"];
  if (!["HIDDEN", "COUNTS_ONLY", "NAMES_FOR_AUTHORISED"].includes(contributors)) throw new PolicyError("policy.contributors must be HIDDEN, COUNTS_ONLY or NAMES_FOR_AUTHORISED");
  return {
    window: { since: typeof win.since === "string" ? win.since : undefined, until: typeof win.until === "string" ? win.until : undefined, months: num(win.months as unknown as number, "policy.window.months", 0.5, 120, 12) },
    mergePolicy: (src.mergePolicy ?? "AUTO") as HistoryPolicy["mergePolicy"],
    rename: { enabled: ren.enabled !== false, similarityPercent: num(ren.similarityPercent as unknown as number, "policy.rename.similarityPercent", 1, 100, 50) },
    exclusions: {
      bulk: { files: num(exBulk.files as unknown as number, "policy.exclusions.bulk.files", 2, 10_000, DEFAULT_POLICY.exclusions.bulk.files), shareOfTracked: num(exBulk.shareOfTracked as unknown as number, "policy.exclusions.bulk.shareOfTracked", 0, 1, DEFAULT_POLICY.exclusions.bulk.shareOfTracked) },
      format: ex.format !== false,
      botPatterns: [...botPatterns],
      generated: ex.generated !== false,
      revertPairs: ex.revertPairs !== false,
    },
    decay: { halfLifeDays: num(dec.halfLifeDays as unknown as number, "policy.decay.halfLifeDays", 1, 3_650, DEFAULT_POLICY.decay.halfLifeDays) },
    coupling: {
      minSupport: num(cou.minSupport as unknown as number, "policy.coupling.minSupport", 1, 1000, DEFAULT_POLICY.coupling.minSupport),
      minConfidence: num(cou.minConfidence as unknown as number, "policy.coupling.minConfidence", 0, 1, DEFAULT_POLICY.coupling.minConfidence),
      maxFilesPerChange: num(cou.maxFilesPerChange as unknown as number, "policy.coupling.maxFilesPerChange", 2, 500, DEFAULT_POLICY.coupling.maxFilesPerChange),
      ubiquitousShare: num(cou.ubiquitousShare as unknown as number, "policy.coupling.ubiquitousShare", 0, 1, DEFAULT_POLICY.coupling.ubiquitousShare),
    },
    health: { thresholds, formulaVersion: FORMULA_VERSION },
    weights: { preset: preset as HistoryPolicy["weights"]["preset"], custom: Object.keys(custom).length ? Object.fromEntries(FACTOR_IDS.map((f) => [f, custom[f] as number ?? 0])) : undefined },
    contributors,
  };
}

/** Reproducibility (F06-A4): the hash over the effective policy and the formula version. */
export const policyHash = (policy: HistoryPolicy): string => sha256Hex(canonical({ formulaVersion: FORMULA_VERSION, policy }));
export const effectiveWeights = (policy: HistoryPolicy): Record<FactorId, number> =>
  policy.weights.custom ?? { ...(policy.weights.preset === "custom" ? WEIGHT_PRESETS.default : WEIGHT_PRESETS[policy.weights.preset]) };

// ---------------------------------------------------------------------------
// statistics and deterministic randomness

/** Percentile within the analysed population, ties at mid-rank (D9: an outlier cannot flatten the others). */
export function percentiles(values: number[]): Map<number, number> {
  const groups = new Map<number, number>();
  for (const v of values) groups.set(v, (groups.get(v) ?? 0) + 1);
  const distinct = [...groups.keys()].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let less = 0;
  for (const v of distinct) {
    const equal = groups.get(v)!;
    out.set(v, (less + equal / 2) / Math.max(1, values.length));
    less += equal;
  }
  return out;
}
export const percentileWithin = (values: number[], v: number): number => {
  let less = 0, eq = 0;
  for (const x of values) { if (x < v) less++; else if (x === v) eq++; }
  return (less + eq / 2) / Math.max(1, values.length);
};

/** Deterministic PRNG from a policy-derived seed (mulberry32); same seed → same trials (F06-D10). */
export class SeededRandom {
  private s: number;
  constructor(seedHex: string) { this.s = (parseInt(seedHex.slice(0, 8), 16) || 0x9e3779b9) >>> 0; }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// ---------------------------------------------------------------------------
// pure pipeline: classification, logical changes, lineages

const normTarget = (subject: string): string => (/^Revert\s+"(.+)/.exec(subject)?.[1] ?? subject);
const fileSetEq = (a: RawFileChange[], b: RawFileChange[]): boolean => {
  const pa = new Set(a.flatMap((f) => [f.path, f.oldPath ?? ""])), pb = new Set(b.flatMap((f) => [f.path, f.oldPath ?? ""]));
  return pa.size === pb.size && [...pa].every((x) => pb.has(x));
};

export interface ClassifyOutcome { clazz: CommitClass; reason: string; counted: boolean; rule: string | null }

/** One class per commit with a stated reason (§7.3). Order: merges → revert pair → bulk → format → rename-only → generated → bot. */
export function classifyCommit(c: RawCommit, o: {
  policy: HistoryPolicy; trackedPaths: number; medianFiles: number; blameIgnore: Set<string>;
  firstParent: boolean; revertTargets: Map<string, RawCommit>; whitespace: (hash: string) => number | null;
}): ClassifyOutcome {
  const p = o.policy;
  if (c.parents.length > 1 && !o.firstParent) return { clazz: "MERGE", reason: "a merge commit; this policy gives merges no file changes of their own", counted: false, rule: null };
  if (p.exclusions.revertPairs) {
    if (/^Revert\s+"/.test(c.subject)) {
      const inner = normTarget(c.subject);
      const target = inner !== c.subject ? o.revertTargets.get(inner) : undefined;
      if (target) return { clazz: "REVERT", reason: `reverts ${target.hash.slice(0, 10)} (${target.subject}); the pair is noise, not two units of churn`, counted: false, rule: "revert-pair" };
      return { clazz: "REVERT", reason: "the subject starts with Revert; no reverted commit was found to pair with, so it is excluded alone", counted: false, rule: "revert-pair" };
    }
    const target = o.revertTargets.get(c.subject);
    if (target && target.hash !== c.hash) return { clazz: "REVERTED", reason: `exactly undone by ${target.hash.slice(0, 10)} (a revert commit); the pair is excluded together`, counted: false, rule: "revert-pair" };
  }
  const med = o.medianFiles;
  const overShare = o.trackedPaths > 0 && c.filesChanged > p.exclusions.bulk.shareOfTracked * o.trackedPaths;
  if ((c.filesChanged > p.exclusions.bulk.files && overShare) || (med > 0 && c.filesChanged >= 5 * med))
    return { clazz: "BULK", reason: `touches ${c.filesChanged} files${overShare ? ` — more than ${Math.round(p.exclusions.bulk.shareOfTracked * 100)}% of the ${o.trackedPaths} tracked files in the window` : ""}${med > 0 && c.filesChanged >= 5 * med ? ` — at least 5× the median commit size (${med})` : ""}`, counted: false, rule: "bulk" };
  if (p.exclusions.format && o.blameIgnore.has(c.hash)) return { clazz: "FORMAT", reason: "listed in .git-blame-ignore-revs", counted: false, rule: "blame-ignore" };
  const afterW = o.whitespace(c.hash);
  if (p.exclusions.format && approxEqShare(c) && afterW !== null && afterW <= 0.02 * (c.insertions + c.deletions + 1))
    return { clazz: "FORMAT", reason: `whitespace/formatting only: a diff ignoring whitespace holds ${afterW} changed line(s) of ${c.insertions + c.deletions}`, counted: false, rule: "format" };
  if (c.filesChanged > 0 && c.files.every((f) => f.status === "R" && (f.similarity ?? 0) >= Math.max(95, p.rename.similarityPercent)))
    return { clazz: "RENAME_ONLY", reason: `all ${c.filesChanged} file(s) are renames at similarity ≥ ${Math.max(95, p.rename.similarityPercent)}%; counted for lineage, not for change frequency`, counted: false, rule: "rename-only" };
  if (p.exclusions.generated && c.filesChanged > 0 && c.files.every((f) => f.generated))
    return { clazz: "GENERATED_ONLY", reason: `every touched file is a generated or lockfile path, starting with ${c.files[0].path}${c.filesChanged > 1 ? ` (+${c.filesChanged - 1} more)` : ""}`, counted: false, rule: "generated" };
  const botHit = p.exclusions.botPatterns.find((pat) => c.email.toLowerCase().includes(pat.toLowerCase()));
  if (botHit) return { clazz: "BOT", reason: `the author matches the bot pattern "${botHit}"`, counted: false, rule: "bot" };
  if (/^chore\(deps\)/i.test(c.subject) || /^Bump \S+ from \S+ to \S+/.test(c.subject)) return { clazz: "BOT", reason: "a dependency-bump commit (chore(deps) / “Bump x from y to z”)", counted: false, rule: "bot" };
  return { clazz: "NORMAL", reason: "counted", counted: true, rule: null };
}

const approxEqShare = (c: RawCommit): boolean => {
  const fs = c.files.filter((f) => f.insertions !== null && f.deletions !== null);
  if (fs.length < 2 || c.binaryFiles > 0) return false;
  const okn = fs.filter((f) => Math.abs(f.insertions! - f.deletions!) <= 0.2 * Math.max(f.insertions!, f.deletions!, 1)).length;
  return okn >= 0.8 * fs.length;
};

/** Logical change ids (§7.2): `pr:<n>` forge groups, `merge:<hash>` merge groups, else the commit itself. */
export function logicalChanges(commits: RawCommit[]): Map<string, string> {
  const out = new Map<string, string>();
  const mergeGroup = new Map<string, string>();
  if (commits.length <= MERGE_GROUP_COMMIT_LIMIT) {
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    let reachBudget = 400_000;
    for (const m of commits) {
      if (m.parents.length < 2 || reachBudget <= 0) continue;
      const firstAncestors = ancestorsOf(m.parents[0] ?? "", byHash, MERGE_GROUP_WALK_CAP);
      const seen = new Set<string>();
      const stack: string[] = [];
      if (m.parents[1]) stack.push(m.parents[1]);
      while (stack.length && seen.size < MERGE_GROUP_WALK_CAP && reachBudget > 0) {
        reachBudget--;
        const id = stack.pop()!;
        if (seen.has(id) || firstAncestors.has(id)) continue;
        seen.add(id);
        const c = byHash.get(id);
        if (c) for (const p of c.parents) stack.push(p);
      }
      const gid = `merge:${m.hash}`;
      for (const id of seen) if (!mergeGroup.has(id)) mergeGroup.set(id, gid);
    }
  }
  for (const c of commits) {
    const pr = /\(#(\d+)\)\s*$/.exec(c.subject)?.[1];
    out.set(c.hash, pr ? `pr:${pr}` : mergeGroup.get(c.hash) ?? c.hash);
  }
  return out;
}
function ancestorsOf(start: string, byHash: Map<string, RawCommit>, cap: number): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length && seen.size < cap) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byHash.get(id);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return seen;
}

export interface LineageDetail { lineageId: string; paths: { path: string; validFrom: string; validTo: string | null }[]; renamedFrom: string[]; copiedFrom: string | null }

/** Lineages (§7.4): renames continue a lineage; copies (−C) start new ones, annotated with copiedFrom. */
export function buildLineages(order: string[], commits: RawCommit[]): LineageDetail[] {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const oldestFirst = order.filter((id) => byHash.has(id)).map((id) => byHash.get(id)!);
  const active = new Map<string, LineageDetail>();
  for (const c of oldestFirst) {
    for (const f of c.files) {
      if (f.status === "R" || f.status === "C") {
        const from = f.oldPath ?? f.path;
        const prev = from === f.path ? undefined : active.get(from);
        if (f.status === "R" && prev) {
          const lin: LineageDetail = {
            lineageId: prev.lineageId,
            paths: prev.paths.map((s) => (s.validTo ? s : { ...s, validTo: c.hash })).concat([{ path: f.path, validFrom: c.hash, validTo: null }]),
            renamedFrom: [...prev.renamedFrom, from].slice(-24), copiedFrom: prev.copiedFrom,
          };
          active.delete(from);
          active.set(f.path, lin);
        } else {
          const lin: LineageDetail = {
            lineageId: `lin:${sha16(`lin\u0000${f.path}\u0000${c.hash}`)}`,
            paths: [{ path: f.path, validFrom: c.hash, validTo: null }],
            renamedFrom: f.status === "C" && prev ? [...prev.renamedFrom, from].slice(-24) : [],
            copiedFrom: f.status === "C" ? from : null,
          };
          if (f.status === "C" && prev) active.set(from, prev); // a copy leaves the original in place
          active.set(f.path, lin);
        }
      } else if (f.status === "D") {
        const prev = active.get(f.path);
        if (prev) { prev.paths.at(-1)!.validTo = c.hash; active.delete(f.path); }
      } else if (!active.has(f.path)) {
        // M (or A of a path born before the window, or a rename git did not detect): a fresh lineage, honestly
        active.set(f.path, { lineageId: `lin:${sha16(`lin\u0000${f.path}\u0000${c.hash}`)}`, paths: [{ path: f.path, validFrom: c.hash, validTo: null }], renamedFrom: [], copiedFrom: null });
      }
    }
  }
  return [...active.values()];
}

// ---------------------------------------------------------------------------
// shared row types for the pipeline and stored tables

export interface HealthJson { signals: HealthSignal[]; debt: number; worstFunction?: { name: string; value: number }; lines: number; symbols: number; metricsVersion?: number }
export interface RunRow { run_id: string; repository_id: string; repo_root: string; head_commit: string; since_time: string | null; until_time: string; shallow: number; commit_count: number; boundary_hash: string; policy_hash: string; worker_version: string; state: string; created_at: string; note: string; policy_json: string; stats_json: string }
export interface ScoreRow { run_id: string; lineage_id: string; path: string; changes_raw: number; changes_decayed: number; logical_changes: number; distinct_contributors: number; health_json: string; impact_json: string; factors_json: string; score: number; rank: number; rank_raw: number; times_json: string; formula_version: number }
export interface EdgeRow { edge_id: string; run_id: string; a_lineage: string; b_lineage: string; support: number; count_a: number; count_b: number; total_changes: number; confidence_a_to_b: number; confidence_b_to_a: number; lift: number; jaccard: number; first_seen: string; last_seen: string; static_dependency: string }

export interface CouplingResult {
  edges: { a: string; b: string; support: number; countA: number; countB: number; firstSeen: string; lastSeen: string; confidenceAToB: number; confidenceBToA: number; lift: number; jaccard: number }[];
  belowFloorCount: number; belowFloorSamples: { a: string; b: string; support: number }[];
  ubiquitous: { path: string; share: number; logicalChanges: number; totalChanges: number }[];
  totalChanges: number;
  counts: Map<string, number>;
  pathOf: Map<string, string>;
  pairTruncated: boolean;
}

export interface FactorsRow { id: FactorId; label: string; raw: number | null; norm: number | null; weight: number; contribution: number; missing: boolean }
export interface ScoredRow {
  lineageId: string; path: string; renamedFrom: string[];
  raw: number; rawTimes: number[]; logical: number; emailSet: Set<string>;
  decayed: number; excludedRawTimes: number[]; excludedRules: Map<string, string>;
  health: HealthJson | null; dependents: number | null; incidents: number | null; coveragePercent: number | null;
  factors: FactorsRow[]; missing: string[]; contributionSum: number;
}

// ---------------------------------------------------------------------------
// the engine

export class HistoryEngine {
  private policyCache = new Map<string, HistoryPolicy>();
  private partialMetrics = false;
  private workerVersionSeen = "";
  private subjectCache = new Map<string, string>();
  private store: Store;
  private worker: WorkerClient;

  constructor(store: Store, worker: WorkerClient) {
    this.store = store;
    this.worker = worker;
  }
  private get db(): import("node:sqlite").DatabaseSync { return (this.store as unknown as { db: import("node:sqlite").DatabaseSync }).db; }

  // identity + registry
  repositoryIdFor(root: string): string {
    const r = resolve(root);
    const known = this.db.prepare("select repository_id from repositories where root = ?").get(r) as unknown as { repository_id: string } | undefined;
    return known?.repository_id ?? `repo:${sha16("path:" + r)}`;
  }
  rootFor(repositoryId: string): string | null {
    const known = this.db.prepare("select root from repositories where repository_id = ?").get(repositoryId) as { root: string } | undefined;
    if (known?.root) return known.root;
    const recorded = this.db.prepare("select repo_root from history_runs where repository_id = ? and repo_root <> '' order by created_at desc limit 1").get(repositoryId) as { repo_root: string } | undefined;
    if (recorded?.repo_root && existsSync(recorded.repo_root)) return recorded.repo_root;
    const roots = this.db.prepare("select distinct repo_root from revisions").all() as { repo_root: string }[];
    return roots.map((x) => x.repo_root).find((rp) => `repo:${sha16("path:" + resolve(rp))}` === repositoryId) ?? null;
  }
  latestRunFor(repositoryId: string): RunRow | null {
    return (this.db.prepare("select * from history_runs where repository_id = ? order by rowid desc limit 1").get(repositoryId) as RunRow | undefined) ?? null;
  }
  rememberPolicy(policy: HistoryPolicy): void { this.policyCache.set(policyHash(policy), policy); }
  runPolicy(policyHash: string): HistoryPolicy | null { return this.policyCache.get(policyHash) ?? null; }

  // Terrain F06 integration (§17): off by default; when on, terrain's churn/knowledge read this store.
  terrainV2(): boolean {
    const r = this.db.prepare("select v2 from history_flags where id = 1").get() as { v2: number } | undefined;
    return !!r?.v2;
  }
  setTerrainV2(on: boolean): void { this.db.prepare("insert or replace into history_flags(id, v2) values (1, ?)").run(on ? 1 : 0); }
  /** Per-path factor values from the latest usable run for this repository (or null). */
  terrainFactors(rev: { repoRoot: string } | null): { factors: Map<string, Record<FactorId, number>>; raw: Map<string, Record<string, string>>; run: RunRow } | null {
    if (!rev) return null;
    const run = this.latestRunFor(this.repositoryIdFor(rev.repoRoot));
    if (!run || !["COMPLETE", "STALE", "PARTIAL"].includes(run.state)) return null;
    const scores = this.db.prepare("select * from hotspot_scores where run_id = ?").all(run.run_id) as unknown as ScoreRow[];
    if (!scores.length) return null;
    const factors = new Map<string, Record<FactorId, number>>();
    const raw = new Map<string, Record<string, string>>();
    const denied = this.deniedCheck(rev.repoRoot);
    for (const s of scores) {
      if (denied(s.path)) continue;
      const fx = JSON.parse(s.factors_json) as FactorsRow[];
      const f = {} as Record<FactorId, number>;
      for (const x of fx) f[x.id] = x.missing || x.norm === null || !Number.isFinite(x.norm) ? 0.5 : x.norm;
      factors.set(s.path, f);
      const healthJson = JSON.parse(s.health_json) as { signals: HealthSignal[] };
      raw.set(s.path, {
        change: `${s.logical_changes} change(s) (decayed ${s.changes_decayed.toFixed(2)})`,
        health: healthJson.signals.some((x) => x.status === "ABOVE") ? `${healthJson.signals.filter((x) => x.status === "ABOVE").length} code-health signal(s) over threshold` : "within thresholds",
        impact: `${(JSON.parse(s.impact_json) as { dependents: number | "NOT_AVAILABLE" }).dependents} dependent(s)`,
        coupling: `${fx.find((x) => x.id === "coupling")?.raw ?? 0} co-change edge(s)`,
        knowledge: `${s.distinct_contributors} contributor(s)`,
      });
    }
    return { factors, raw, run };
  }

  // authorization (§10): keyed contributor identity; display names only behind the grant
  private authorKey(): Buffer {
    const r = this.db.prepare("select key from cursor_keys where id = 'history-author'").get() as { key: string } | undefined;
    if (r) return Buffer.from(r.key, "utf8");
    const key = createHmac("sha256", randomUUID()).update(randomUUID()).digest("hex");
    this.db.prepare("insert or ignore into cursor_keys values ('history-author',?)").run(key);
    return Buffer.from(key, "utf8");
  }
  private hmacAuthor(email: string): string { return createHmac("sha256", this.authorKey()).update(email.toLowerCase()).digest("hex").slice(0, 16); }
  grantContributorNames(principal: string, grant: boolean): void {
    if (grant) this.db.prepare("insert or replace into history_name_grants(principal, granted_at) values (?,?)").run(principal, new Date().toISOString());
    else this.db.prepare("delete from history_name_grants where principal = ?").run(principal);
  }
  namesGranted(principal: string): boolean { return !!this.db.prepare("select 1 from history_name_grants where principal = ?").get(principal); }
  private deniedCheck(root: string | null): (path: string) => boolean {
    if (!root) return () => false;
    const prefixes = this.store.deniedPrefixes(root);
    if (!prefixes.length) return () => false;
    return (file: string) => {
      const f = file.replace(/^\.?\//, "");
      return prefixes.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : p + "/"));
    };
  }

  // cursors: HMAC'd, bound to the run and its boundary (same key table as F01's cursors)
  private cursorKey(): Buffer {
    const r = this.db.prepare("select key from cursor_keys where id = 'history'").get() as { key: string } | undefined;
    if (r) return Buffer.from(r.key, "utf8");
    const key = createHmac("sha256", randomUUID()).update(randomUUID()).digest("hex");
    this.db.prepare("insert or ignore into cursor_keys values ('history',?)").run(key);
    return Buffer.from(key, "utf8");
  }
  private encodeCursor(payload: Record<string, string>): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.cursorKey()).update(body).digest("base64url");
    return `${body}.${mac.slice(0, 22)}`;
  }
  private decodeCursor(cursor: string): Record<string, string> | null {
    const [body, mac] = cursor.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", this.cursorKey()).update(body).digest("base64url").slice(0, 22);
    try {
      return timingSafeEqual(Buffer.from(mac), Buffer.from(want)) ? JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, string> : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------------
  // the analysis pipeline (§7.1–§7.9) — the history-analysis job body
  // ------------------------------------------------------------------

  async runAnalysis(_ctx: CallContext, control: { checkpoint(): void; progress(p: { phase: string; message?: string; done?: number; total?: number }): void }, repoPath: string, policyInput: unknown, deadlineMs: number): Promise<{ runId: string; state: string; warnings: string[]; policyHash: string; commitCount: number; deduped: boolean }> {
    const policy = normalizePolicy(policyInput);
    this.rememberPolicy(policy);
    const pH = policyHash(policy);
    const warnings: string[] = [];
    const root = resolve(repoPath);
    const repositoryId = this.repositoryIdFor(root);
    const runId = randomUUID();

    // window + boundary (§6.1)
    control.progress({ phase: "reading", message: "resolving the window" });
    const plan = planWindow(root, policy);
    if ("error" in plan) throw new Error(plan.error);
    const commitListHash = sha256Hex(plan.ids.join("\n"));
    const boundary: Omit<HistoryBoundaryView, "repositoryId"> = {
      headCommit: plan.head, since: plan.since, until: plan.until, shallow: plan.shallow,
      commitCount: plan.ids.length, commitListHash, ...(plan.cappedAt ? { cappedAt: plan.cappedAt } : {}),
    };
    const boundaryHash = `bnd:${sha16(canonical(boundary))}`;

    // the same (repository, boundary, policy) already complete → the same stored rows, no work (F06-A4)
    const existing = this.db.prepare("select run_id, state from history_runs where repository_id = ? and boundary_hash = ? and policy_hash = ?").get(repositoryId, boundaryHash, pH) as { run_id: string; state: string } | undefined;
    if (existing && (existing.state === "COMPLETE" || existing.state === "STALE")) {
      return { runId: existing.run_id, state: "COMPLETE", warnings, policyHash: pH, commitCount: boundary.commitCount, deduped: true };
    }

    // incremental or rebuild (§7.1/§11)
    const prev = this.latestRunFor(repositoryId);
    let incrementalFrom: string | null = null;
    if (prev && prev.policy_hash === pH && ["COMPLETE", "PARTIAL", "STALE"].includes(prev.state)) {
      if (prev.head_commit !== plan.head && isAncestor(root, prev.head_commit, plan.head) && prev.since_time === plan.since && prev.until_time === plan.until) incrementalFrom = prev.head_commit;
      else if (prev.head_commit !== plan.head && !isAncestor(root, prev.head_commit, plan.head)) warnings.push(`the previous head ${prev.head_commit.slice(0, 10)} is no longer an ancestor of the current head: the history was rewritten, so the boundary was rebuilt`);
      else if (prev.since_time !== plan.since || prev.until_time !== plan.until) warnings.push("the window changed, so the boundary was rebuilt");
      if (existing) this.db.prepare("delete from history_runs where run_id = ?").run(existing.run_id); // a failed/partial run is replaced
    }
    this.db.prepare("insert into history_runs(run_id, repository_id, head_commit, since_time, until_time, shallow, commit_count, boundary_hash, policy_hash, worker_version, state, created_at, note, policy_json, stats_json, repo_root) values (?,?,?,?,?,?,?,?,?,'', 'READING', ?, '', ?, '{}', ?)")
      .run(runId, repositoryId, plan.head, plan.since, plan.until, plan.shallow ? 1 : 0, plan.ids.length, boundaryHash, pH, new Date().toISOString(), JSON.stringify(policy), root);

    // read: the whole window on a rebuild, or only the commits after the previous head on an incremental
    // pass (§7.1). The difference is computed by git (`prev..head`) and intersected with the window so
    // side-branch commits merged in since the previous head are not missed.
    let readIds = plan.ids;
    if (incrementalFrom) {
      const listed = gitRun(root, ["rev-list", `${incrementalFrom}..${plan.head}`], 8 * 1024 * 1024);
      const fresh = new Set((listed ?? "").split("\n").filter(Boolean));
      readIds = plan.ids.filter((id) => fresh.has(id));
      control.progress({ phase: "reading", message: `incremental: ${readIds.length} new commit(s) since ${incrementalFrom.slice(0, 10)}` });
    }
    control.progress({ phase: "reading", message: `reading ${readIds.length} commit(s)`, done: 0, total: readIds.length });
    const read = await readCommits(root, readIds, { firstParent: plan.firstParent, similarityPercent: policy.rename.enabled ? policy.rename.similarityPercent : 0, deadlineMs });
    if (read.gitError) warnings.push(`git could not complete the read: ${read.gitError}`);
    if (read.deadlineHit) warnings.push(`the read stopped at its time budget: the commits read before the deadline were analysed and the report is partial`);
    if (plan.cappedAt) warnings.push(`the commit cap (${CAP_COMMITS}) bit: only the newest ${CAP_COMMITS} commits of the window were analysed`);
    const commits = this.mergeStoredCommits(repositoryId, plan, read.commits);
    control.checkpoint();

    // classification (§7.2/§7.3)
    control.progress({ phase: "classifying", message: "classifying commits" });
    const trackedPaths = new Set<string>();
    for (const c of commits) for (const f of c.files) { trackedPaths.add(f.path); if (f.oldPath) trackedPaths.add(f.oldPath); }
    const sizes = commits.filter((c) => c.filesChanged > 0).map((c) => c.filesChanged).sort((a, b) => a - b);
    const medianFiles = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    const blameIgnore = blameIgnoreSet(root);
    const byInner = new Map<string, RawCommit>();
    for (const c of commits) {
      const t = normTarget(c.subject);
      if (t !== c.subject && !byInner.has(t)) byInner.set(t, c);
    }
    const revertTargets = new Map<string, RawCommit>();
    for (const c of commits) {
      if (!/^Revert\s+"/.test(c.subject)) continue;
      const inner = normTarget(c.subject);
      const target = byInner.get(inner);
      if (target && target.hash !== c.hash && fileSetEq(target.files, c.files)) revertTargets.set(inner, target);
    }
    const candidates = policy.exclusions.format ? commits.filter((c) => approxEqShare(c) && c.filesChanged >= 2).slice(-FORMAT_CANDIDATE_CAP) : [];
    if (policy.exclusions.format) {
      const n = commits.filter((c) => approxEqShare(c) && c.filesChanged >= 2).length;
      if (n > FORMAT_CANDIDATE_CAP) warnings.push(`the whitespace-format check ran on the newest ${FORMAT_CANDIDATE_CAP} of ${n} candidate commits; the older ones were not checked`);
    }
    const candidateSet = new Set(candidates.map((c) => c.hash));
    const whitespace = whitespaceChecker(root);
    const checked = (hash: string): number | null => (candidateSet.has(hash) ? whitespace(hash) : null);
    const classes = new Map<string, ClassifyOutcome>();
    for (const c of commits) {
      classes.set(c.hash, classifyCommit(c, { policy, trackedPaths: trackedPaths.size, medianFiles, blameIgnore, firstParent: plan.firstParent, revertTargets, whitespace: checked }));
    }
    const logical = logicalChanges(commits);

    // lineages (§7.4)
    const lineages = buildLineages(plan.ids, commits);

    // health (§7.6): the worker parses the head worktree's files
    control.progress({ phase: "scoring", message: "measuring code health" });
    this.partialMetrics = false;
    const headPaths = lineages.filter((l) => !l.paths.at(-1)!.validTo).map((l) => l.paths.at(-1)!.path);
    const health = await this.readHealth(root, headPaths.slice(0, MAX_HEALTH_FILES), policy);
    warnings.push(...health.warnings);
    if (this.workerVersionSeen) this.db.prepare("update history_runs set worker_version = ? where run_id = ?").run(this.workerVersionSeen, runId);

    // impact (§7.7) from the latest indexed revision (or reported unavailable)
    const impact = this.impactFor();
    if (!impact.available) warnings.push(impact.reason);

    // coupling (§7.9), then scoring (§7.5/§7.8) using the fan-out
    control.progress({ phase: "scoring", message: "co-change edges" });
    const coupling = this.computeCoupling(commits, classes, logical, lineages, policy);
    if (coupling.pairTruncated) warnings.push(`the co-change pair budget (${COUPLING_PAIR_CAP}) bit: the remaining pairs were not examined`);
    const scored = this.scoreRows(commits, classes, logical, lineages, coupling, health.map, plan, policy, impact);

    // persistence: one transaction, the job's commit point (§11)
    const persistOutcome = this.persist(root, repositoryId, runId, plan, commits, classes, logical, lineages, coupling, scored);
    warnings.push(...persistOutcome.warnings);
    const state = read.deadlineHit || plan.cappedAt || coupling.pairTruncated || persistOutcome.partialMetrics ? "PARTIAL" : "COMPLETE";
    this.db.prepare("update history_runs set state = ?, note = ? where run_id = ?").run(state, persistOutcome.note, runId);
    return { runId, state, warnings, policyHash: pH, commitCount: plan.ids.length, deduped: false };
  }

  private mergeStoredCommits(repositoryId: string, plan: WindowPlan, fresh: RawCommit[]): RawCommit[] {
    const byHash = new Map(fresh.map((c) => [c.hash, c]));
    const stored = this.db.prepare("select commit_hash, committed_at, parent_count, insertions, deletions from commit_events where repository_id = ? and committed_at >= ? and committed_at <= ?").all(repositoryId, plan.since, plan.until) as { commit_hash: string; committed_at: string; parent_count: number; insertions: number; deletions: number }[];
    const storedFiles = this.db.prepare("select commit_hash, path, old_path, status, similarity, insertions, deletions, generated from file_changes where repository_id = ?").all(repositoryId) as { commit_hash: string; path: string; old_path: string | null; status: string; similarity: number | null; insertions: number | null; deletions: number | null; generated: number }[];
    const filesBy = new Map<string, RawFileChange[]>();
    for (const f of storedFiles) {
      const arr = filesBy.get(f.commit_hash) ?? [];
      arr.push({ path: f.path, oldPath: f.old_path, status: f.status as RawFileChange["status"], similarity: f.similarity, insertions: f.insertions, deletions: f.deletions, generated: f.generated === 1 });
      filesBy.set(f.commit_hash, arr);
    }
    for (const r of stored) {
      if (byHash.has(r.commit_hash)) continue;
      const meta = plan.meta.get(r.commit_hash);
      byHash.set(r.commit_hash, {
        hash: r.commit_hash, email: meta?.email ?? "", committedAt: r.committed_at, parents: meta?.parents ?? [],
        subject: meta?.subject ?? "", files: filesBy.get(r.commit_hash) ?? [],
        insertions: Number(r.insertions ?? 0), deletions: Number(r.deletions ?? 0), binaryFiles: 0,
        filesChanged: (filesBy.get(r.commit_hash) ?? []).length,
      });
    }
    return [...byHash.values()];
  }

  /** Code-health signals from the Rust worker (§7.6); files at the head worktree only, bounded. */
  async readHealth(root: string, paths: string[], policy: HistoryPolicy): Promise<{ map: Map<string, HealthJson>; warnings: string[] }> {
    const map = new Map<string, HealthJson>();
    const warnings: string[] = [];
    if (!paths.length) return { map, warnings };
    const th = policy.health.thresholds;
    const existing = paths.filter((p) => !p.includes("..") && existsSync(`${root}/${p}`));
    const missingCount = paths.length - existing.length;
    if (missingCount > 0) warnings.push(`${missingCount} analysed file(s) no longer exist at the working tree; their code-health signals are missing and reported as such`);
    for (let i = 0; i < existing.length; i += MAX_HEALTH_FILES) {
      const slice = existing.slice(i, i + MAX_HEALTH_FILES);
      try {
        const r = await this.worker.metrics(root, slice, 30_000);
        for (const f of r.files) {
          const fns = (f.functions ?? []) as { name: string; length: number; complexity: number; nesting: number; params: number }[];
          const long = fns.filter((x) => x.length > th.lengthLines).length;
          const cx = fns.filter((x) => x.complexity > th.complexity).length;
          const deep = fns.filter((x) => x.nesting > th.nesting).length;
          const many = fns.filter((x) => x.params > th.params).length;
          const worst = fns.slice().sort((a, b) => (b.complexity - a.complexity) || (b.length - a.length))[0] ?? null;
          const n = fns.length;
          const signals: HealthSignal[] = [
            { id: "longFunctions", label: `functions over the length threshold (${th.lengthLines} lines)`, value: n ? long : "NOT_AVAILABLE", threshold: 0, status: n ? (long > 0 ? "ABOVE" : "OK") : "MISSING" },
            { id: "complexFunctions", label: `functions over the complexity threshold (${th.complexity})`, value: n ? cx : "NOT_AVAILABLE", threshold: 0, status: n ? (cx > 0 ? "ABOVE" : "OK") : "MISSING" },
            { id: "deepNesting", label: `functions over the nesting threshold (${th.nesting})`, value: n ? deep : "NOT_AVAILABLE", threshold: 0, status: n ? (deep > 0 ? "ABOVE" : "OK") : "MISSING" },
            { id: "manyParameters", label: `functions over the parameter threshold (${th.params})`, value: n ? many : "NOT_AVAILABLE", threshold: 0, status: n ? (many > 0 ? "ABOVE" : "OK") : "MISSING" },
            { id: "fileLines", label: "lines in the file", value: f.lines ?? "NOT_AVAILABLE", threshold: th.fileLines, status: (f.lines ?? 0) > th.fileLines ? "ABOVE" : "OK" },
            { id: "worstComplexity", label: "the worst function's complexity", value: worst ? worst.complexity : "NOT_AVAILABLE", threshold: th.complexity, status: (worst?.complexity ?? 0) > th.complexity ? "ABOVE" : "OK" },
          ];
          const debt = Math.max(
            n ? long / n : 0, n ? cx / n : 0, n ? deep / n : 0, n ? many / n : 0,
            (f.lines ?? 0) > th.fileLines ? Math.min(1, (f.lines ?? 0) / th.fileLines) : 0,
            worst ? Math.min(1, worst.complexity / th.complexity) : 0,
          );
          map.set(f.path, { signals, debt, worstFunction: worst ? { name: worst.name, value: worst.complexity } : undefined, lines: f.lines ?? 0, symbols: f.symbols ?? 0, metricsVersion: f.metricsVersion ?? r.metricsVersion });
        }
        if (r.files.some((x) => x.error)) this.partialMetrics = true;
        if (r.metricsVersion) this.workerVersionSeen = `metrics-v${r.metricsVersion}`;
      } catch (e) {
        warnings.push(`code-health metrics could not run: ${(e as Error).message}; health is missing for the remaining files and counted as such`);
        break;
      }
    }
    return { map, warnings };
  }

  /** Impact assembly (§7.7): dependents (graph), incidents (reported exceptions + failing tests), coverage (test artifacts). */
  impactFor(): { available: boolean; reason: string; forFile: (path: string) => { dependents: number | null; incidents: number | null; coveragePercent: number | null } } {
    const rev = this.store.latestRevision();
    if (!rev) return { available: false, reason: "no indexed revision for this repository, so dependents, incidents and coverage are reported as unavailable", forFile: () => ({ dependents: null, incidents: null, coveragePercent: null }) };
    const fileOf = (id: string): string => /^[a-z]+:([^#]+)/.exec(id)?.[1] ?? "";
    const inflow = new Map<string, Set<string>>();
    for (const r of this.store.allRelationships(rev.id)) {
      const kf = fileOf(r.from), kt = fileOf(r.to);
      if (!kf || !kt || kf === kt) continue;
      let set = inflow.get(kt);
      if (!set) { set = new Set(); inflow.set(kt, set); }
      set.add(kf);
    }
    const hot = new Map<string, number>([...runtimeHotness(this.store, rev).entries()].map(([id, h]) => [id, h.value]));
    const coverage = new Map<string, number>();
    const entityHotness = new Map<string, number>();
    for (const e of this.store.entities(rev.id)) {
      const h = hot.get(e.entityId);
      if (h !== undefined) entityHotness.set(e.entityId, h);
      if (e.kind !== "file") continue;
      const f = this.store.factsFor(rev.id, e.entityId).find((x) => x.predicate === "coverage");
      const v = f ? (f.object as unknown as { value?: { percent?: number } }).value : null;
      if (v?.percent !== undefined) coverage.set(e.file, v.percent);
    }
    const byFile = new Map<string, string[]>();
    for (const e of this.store.entities(rev.id)) {
      if (e.kind === "file") continue;
      const arr = byFile.get(e.file) ?? [];
      arr.push(e.entityId);
      byFile.set(e.file, arr);
    }
    return {
      available: true, reason: "",
      forFile: (path: string) => {
        const entities = byFile.get(path) ?? [];
        const incidents = entities.filter((id) => (entityHotness.get(id) ?? 0) > 0).length;
        return { dependents: inflow.has(path) ? inflow.get(path)!.size : 0, incidents, coveragePercent: coverage.get(path) ?? null };
      },
    };
  }

  // ---- coupling (§7.9) ----
  computeCoupling(commits: RawCommit[], classes: Map<string, ClassifyOutcome>, logical: Map<string, string>, lineages: LineageDetail[], policy: HistoryPolicy): CouplingResult {
    const pathOf = new Map<string, string>();
    for (const l of lineages) for (const seg of l.paths) if (!pathOf.has(seg.path)) pathOf.set(seg.path, l.lineageId);
    // Every counted logical change, with the lineages it touched. Single-file changes count towards the
    // marginals (confidence and lift denominators) and the total, but cannot form a pair.
    const grouped = new Map<string, { at: string; lineages: string[] }>();
    for (const c of commits) {
      const cl = classes.get(c.hash);
      if (!cl || !COUNTED_FOR_COUPLING.has(cl.clazz)) continue;
      const gid = logical.get(c.hash) ?? c.hash;
      const cur = grouped.get(gid) ?? { at: c.committedAt, lineages: [] };
      for (const f of c.files) {
        const lin = pathOf.get(f.path) ?? pathOf.get(f.oldPath ?? "");
        if (lin && !cur.lineages.includes(lin)) cur.lineages.push(lin);
      }
      grouped.set(gid, cur);
    }
    const all = [...grouped.entries()].map(([id, g]) => ({ id, at: g.at, lineages: g.lineages }));
    const totalChanges = all.length;
    const counts = new Map<string, number>();
    for (const g of all) for (const l of g.lineages) counts.set(l, (counts.get(l) ?? 0) + 1);
    // ubiquitous files (§7.9): in more than the share of all counted logical changes — dropped from pairing, listed
    const ubiquitous = [...counts.entries()].filter(([, n]) => n / Math.max(1, totalChanges) > policy.coupling.ubiquitousShare)
      .map(([lin, n]) => ({ path: (lineages.find((l) => l.lineageId === lin)?.paths.at(-1)?.path) ?? lin, share: n / Math.max(1, totalChanges), logicalChanges: n, totalChanges }));
    const ubiquitousSet = new Set(ubiquitous.map((u) => u.path));
    const lineageOf = new Map<string, string>();
    for (const l of lineages) { const p = l.paths.at(-1)?.path; if (p) lineageOf.set(p, l.lineageId); }
    const ubSet = new Set([...ubiquitousSet].map((p) => lineageOf.get(p) ?? p));
    const eligible = new Map<string, number>();
    for (const [l, n] of counts) if (!ubSet.has(l)) eligible.set(l, n);
    // pairs over the eligible groups with ≥ 2 lineages and at most K files (Σ k² stays bounded)
    let pairBudget = COUPLING_PAIR_CAP, pairTruncated = false;
    const raw = new Map<string, { support: number; at: string; last: string }>();
    for (const g of [...all].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
      const lins = [...new Set(g.lineages.filter((l) => eligible.has(l)))].sort((a, b) => a.localeCompare(b));
      if (lins.length < 2 || lins.length > policy.coupling.maxFilesPerChange) continue;
      for (let i = 0; i < lins.length && !pairTruncated; i++) {
        for (let j = i + 1; j < lins.length && !pairTruncated; j++) {
          const key = `${lins[i]}\u0001${lins[j]}`;
          const cur = raw.get(key) ?? { support: 0, at: g.at, last: g.at };
          cur.support++;
          if (g.at < cur.at) cur.at = g.at;
          if (g.at > cur.last) cur.last = g.at;
          if (pairBudget-- <= 0) pairTruncated = true;
          raw.set(key, cur);
        }
      }
    }
    const edges: CouplingResult["edges"] = [];
    let belowFloorCount = 0;
    const belowFloorSamples: { a: string; b: string; support: number }[] = [];
    for (const [key, s] of raw) {
      const [a, b] = key.split("\u0001");
      const ca = eligible.get(a) ?? 0, cb = eligible.get(b) ?? 0;
      const confA = ca > 0 ? s.support / ca : 0, confB = cb > 0 ? s.support / cb : 0;
      const lift = (s.support / Math.max(1, totalChanges)) / Math.max(Number.EPSILON, (ca / Math.max(1, totalChanges)) * (cb / Math.max(1, totalChanges)));
      const jaccard = s.support / Math.max(1, ca + cb - s.support);
      if (s.support >= policy.coupling.minSupport && Math.max(confA, confB) >= policy.coupling.minConfidence && lift > 1) {
        edges.push({ a, b, support: s.support, countA: ca, countB: cb, firstSeen: s.at, lastSeen: s.last, confidenceAToB: confA, confidenceBToA: confB, lift, jaccard });
      } else {
        belowFloorCount++;
        if (belowFloorSamples.length < 25) belowFloorSamples.push({ a, b, support: s.support });
      }
    }
    // per-file cap: the strongest pairs per file (§13)
    const byFile = new Map<string, CouplingResult["edges"]>();
    for (const e of edges) for (const f of [e.a, e.b]) { const arr = byFile.get(f) ?? []; arr.push(e); byFile.set(f, arr); }
    const kept = new Set<string>();
    for (const [, arr] of byFile) for (const e of arr.sort((x, y) => y.support - x.support || `${x.a}\u0001${x.b}`.localeCompare(`${y.a}\u0001${y.b}`)).slice(0, MAX_EDGES_PER_FILE)) kept.add(`${e.a}\u0001${e.b}`);
    return { edges: edges.filter((e) => kept.has(`${e.a}\u0001${e.b}`)), belowFloorCount, belowFloorSamples, ubiquitous, totalChanges, counts: eligible, pathOf, pairTruncated };
  }

  // ---- scoring (§7.5/§7.7/§7.8) — pure over the pipeline's outputs, deterministic order ----
  scoreRows(commits: RawCommit[], classes: Map<string, ClassifyOutcome>, logical: Map<string, string>, lineages: LineageDetail[], coupling: CouplingResult, health: Map<string, HealthJson>, plan: WindowPlan, policy: HistoryPolicy, impact: ReturnType<HistoryEngine["impactFor"]>): { rows: ScoredRow[]; rank: Map<string, number>; rawRank: Map<string, number>; belowFloorCount: number } {
    const pathOf = coupling.pathOf;
    // counted and excluded changes per lineage
    const counted = new Map<string, RawCommit[]>();
    const excluded = new Map<string, { commit: RawCommit; rule: string; reason: string }[]>();
    for (const c of [...commits].sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.hash.localeCompare(b.hash))) {
      const cl = classes.get(c.hash);
      if (!cl || cl.clazz === "MERGE") continue;
      const linPaths = new Map<string, RawFileChange>();
      for (const f of c.files) {
        const lin = pathOf.get(f.path) ?? pathOf.get(f.oldPath ?? "");
        if (lin && !linPaths.has(lin)) linPaths.set(lin, f);
      }
      for (const lin of linPaths.keys()) {
        if (cl.counted) {
          const arr = counted.get(lin) ?? [];
          arr.push(c);
          counted.set(lin, arr);
        } else {
          const arr = excluded.get(lin) ?? [];
          if (!arr.some((x) => x.commit.hash === c.hash)) { arr.push({ commit: c, rule: cl.rule ?? "", reason: cl.reason }); excluded.set(lin, arr); }
        }
      }
    }
    const untilTime = new Date(plan.until).getTime();
    const halfLife = policy.decay.halfLifeDays * 24 * 3600 * 1000;
    const decayedOf = (times: number[]): number => times.reduce((s, t) => s + Math.pow(0.5, (untilTime - t) / Math.max(1, halfLife)), 0);
    const rows: ScoredRow[] = [];
    for (const lin of counted.keys()) {
      const detail = lineages.find((l) => l.lineageId === lin);
      if (!detail) continue;
      const path = detail.paths.at(-1)!.path;
      const cs = counted.get(lin)!;
      const times = cs.map((x) => new Date(x.committedAt).getTime());
      const h = health.get(path) ?? null;
      const im = impact.forFile(path);
      rows.push({
        lineageId: lin, path, renamedFrom: detail.renamedFrom,
        raw: cs.length, rawTimes: times, logical: new Set(cs.map((x) => logical.get(x.hash) ?? x.hash)).size,
        emailSet: new Set(cs.map((x) => x.email.toLowerCase())),
        decayed: decayedOf(times),
        excludedRawTimes: (excluded.get(lin) ?? []).map((x) => new Date(x.commit.committedAt).getTime()),
        excludedRules: new Map((excluded.get(lin) ?? []).filter((x) => x.rule).map((x) => [x.commit.hash, x.rule])),
        health: h, dependents: im.dependents, incidents: im.incidents, coveragePercent: im.coveragePercent,
        factors: [], missing: [], contributionSum: 0,
      });
    }
    // percentiles within the analysed population (§7.5, D9)
    const changePct = percentiles(rows.map((r) => r.decayed));
    const debtPct = percentiles(rows.filter((r) => r.health).map((r) => r.health!.debt));
    const impactRaw = rows.map((r) => (r.dependents === null ? null : 0.5 * r.dependents + 0.35 * (r.incidents ?? 0) + 0.15 * (r.coveragePercent === null ? 0.5 : Math.min(1, 1 - r.coveragePercent / 100))));
    const impactPct = percentiles(impactRaw.filter((v): v is number => v !== null));
    const knowledgePct = percentiles(rows.map((r) => r.emailSet.size));
    const fan = new Map<string, number>();
    for (const e of coupling.edges) { fan.set(e.a, (fan.get(e.a) ?? 0) + 1); fan.set(e.b, (fan.get(e.b) ?? 0) + 1); }
    const fanPct = percentiles(rows.map((r) => fan.get(r.lineageId) ?? 0));
    const weights = effectiveWeights(policy);
    const mk = (id: FactorId, raw: number | null, norm: number | null, missing: boolean): FactorsRow =>
      ({ id, label: FACTOR_LABELS[id], raw: raw === null || !Number.isFinite(raw) ? null : raw, norm, weight: weights[id] ?? 0, contribution: (weights[id] ?? 0) * (norm ?? 0.5), missing });
    rows.forEach((r, idx) => {
      const missing: string[] = [];
      const changeNorm = changePct.get(r.decayed) ?? null;
      const healthNorm = r.health ? 1 - (debtPct.get(r.health.debt) ?? 0.5) : (missing.push("health"), null);
      const impactNorm = impactRaw[idx] === null ? (missing.push("impact"), null) : (impactPct.get(impactRaw[idx]!) ?? null);
      const couplingNorm = (fan.get(r.lineageId) ?? 0) > 0 ? (fanPct.get(fan.get(r.lineageId) ?? 0) ?? null) : (missing.push("coupling"), null);
      const knowledgeNorm = r.emailSet.size > 0 ? 1 - (knowledgePct.get(r.emailSet.size) ?? 0.5) : (missing.push("knowledge"), null);
      r.factors = [
        mk("change", r.decayed, changeNorm, false),
        mk("health", r.health?.debt ?? null, healthNorm, healthNorm === null),
        mk("impact", r.dependents, impactNorm, impactNorm === null),
        mk("coupling", fan.get(r.lineageId) ?? 0, couplingNorm, couplingNorm === null),
        mk("knowledge", r.emailSet.size, knowledgeNorm, knowledgeNorm === null),
      ];
      r.missing = missing;
      r.contributionSum = r.factors.reduce((a, f) => a + f.contribution, 0);
    });
    const wsum = FACTOR_IDS.reduce((a, f) => a + (weights[f] ?? 0), 0) || 1;
    const scoreOf = (factors: FactorsRow[]) => factors.reduce((a, f) => a + f.contribution, 0) / wsum;
    // Contributions are stored normalised (÷ Σ weight), so a row's factors sum to its score exactly
    // (F06-A5) with deterministic float addition order.
    for (const r of rows) {
      for (const f of r.factors) f.contribution = f.contribution / wsum;
      r.contributionSum = r.factors.reduce((a, f) => a + f.contribution, 0);
    }
    // rank: contributionSum desc, path asc — deterministic under any row order (F06-A4)
    const rank = new Map([...rows].sort((a, b) => b.contributionSum - a.contributionSum || a.path.localeCompare(b.path)).map((r, i) => [r.lineageId, i + 1]));
    // rank_raw (§7.3 "ranking effect"): rank with every excluded commit counted back in
    const rawDecayed = rows.map((r) => decayedOf([...r.rawTimes, ...r.excludedRawTimes]));
    const rawPct = percentiles(rawDecayed);
    const rawScored = rows.map((r, i) => {
      const factors: FactorsRow[] = r.factors.map((f) =>
        f.id === "change" ? { ...f, raw: rawDecayed[i], norm: rawPct.get(rawDecayed[i]) ?? 0.5, contribution: ((weights.change ?? 0) * (rawPct.get(rawDecayed[i]) ?? 0.5)) / wsum } : { ...f });
      return { lineageId: r.lineageId, path: r.path, sum: scoreOf(factors) };
    });
    const rawRank = new Map([...rawScored].sort((a, b) => b.sum - a.sum || a.path.localeCompare(b.path)).map((r, i) => [r.lineageId, i + 1]));
    return { rows, rank, rawRank, belowFloorCount: coupling.belowFloorCount };
  }

  // ------------------------------------------------------------------
  // persistence (§6.2/§11): raw rows are upserted per (repository, commit); run-keyed results are rewritten
  // ------------------------------------------------------------------

  private persist(root: string, repositoryId: string, runId: string, plan: WindowPlan, commits: RawCommit[], classes: Map<string, ClassifyOutcome>, logical: Map<string, string>, lineages: LineageDetail[], coupling: CouplingResult, scored: ReturnType<HistoryEngine["scoreRows"]>): { warnings: string[]; note: string; partialMetrics: boolean } {
    void root; void plan;
    const warnings: string[] = [];
    const db = this.db;
    const statics = this.dependencyFlags(coupling.pathOf, coupling.edges);
    if (!statics.available) warnings.push(`no indexed revision for this repository, so the co-change edges' static-dependency annotation is unavailable (${statics.reason})`);
    const insCommit = db.prepare("insert or replace into commit_events(repository_id, commit_hash, author_hash, committed_at, parent_count, files_changed, insertions, deletions, class, class_reason, logical_change_id, pr_number) values (?,?,?,?,?,?,?,?,?,?,?,?)");
    const insFile = db.prepare("insert or replace into file_changes(repository_id, commit_hash, path, old_path, status, similarity, insertions, deletions, generated) values (?,?,?,?,?,?,?,?,?)");
    const delLin = db.prepare("delete from file_lineage where repository_id = ?");
    const insLin = db.prepare("insert or replace into file_lineage(repository_id, lineage_id, path, valid_from_commit, valid_to_commit) values (?,?,?,?,?)");
    const delEx = db.prepare("delete from history_exclusions where run_id = ?");
    const insEx = db.prepare("insert or replace into history_exclusions(run_id, commit_hash, reason, rule) values (?,?,?,?)");
    const delScore = db.prepare("delete from hotspot_scores where run_id = ?");
    const insScore = db.prepare("insert or replace into hotspot_scores(run_id, lineage_id, path, changes_raw, changes_decayed, logical_changes, distinct_contributors, health_json, impact_json, factors_json, score, rank, rank_raw, times_json, formula_version) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const delEdge = db.prepare("delete from cochange_edges where run_id = ?");
    const insEdge = db.prepare("insert or replace into cochange_edges(edge_id, run_id, a_lineage, b_lineage, support, count_a, count_b, total_changes, confidence_a_to_b, confidence_b_to_a, lift, jaccard, first_seen, last_seen, static_dependency) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    let wrote = 0;
    this.store.tx(() => {
      delLin.run(repositoryId);
      for (const l of lineages) for (const seg of l.paths) insLin.run(repositoryId, l.lineageId, seg.path, seg.validFrom, seg.validTo);
      for (const c of commits) {
        const cl = classes.get(c.hash);
        const gid = logical.get(c.hash) ?? c.hash;
        const pr = /^pr:(\d+)$/.exec(gid) ? Number(gid.slice(3)) : null;
        insCommit.run(repositoryId, c.hash, this.hmacAuthor(c.email), c.committedAt, c.parents.length, c.files.length, c.insertions, c.deletions, cl?.clazz ?? "NORMAL", cl?.reason ?? "", gid, pr);
        for (const f of c.files) insFile.run(repositoryId, c.hash, f.path, f.oldPath, f.status, f.similarity, f.insertions, f.deletions, f.generated ? 1 : 0);
        wrote++;
      }
      delEx.run(runId);
      for (const c of commits) {
        const cl = classes.get(c.hash);
        if (cl?.rule) insEx.run(runId, c.hash, cl.reason, cl.rule);
      }
      for (const u of coupling.ubiquitous) insEx.run(runId, `ubiquitous:${sha16(u.path)}`, JSON.stringify(u), "ubiquitous-file");
      delScore.run(runId);
      for (const r of scored.rows) {
        const healthJson = JSON.stringify(r.health
          ? { signals: r.health.signals, worstFunction: r.health.worstFunction ?? null, debt: r.health.debt, lines: r.health.lines, symbols: r.health.symbols, metricsVersion: r.health.metricsVersion ?? null }
          : { signals: [], worstFunction: null, debt: null, lines: 0, symbols: 0, metricsVersion: null });
        const impactJson = JSON.stringify({ dependents: r.dependents === null ? "NOT_AVAILABLE" : r.dependents, incidents: r.incidents === null ? "NOT_AVAILABLE" : r.incidents, coveragePercent: r.coveragePercent === null ? "NOT_AVAILABLE" : r.coveragePercent });
        insScore.run(runId, r.lineageId, r.path, r.raw, r.decayed, r.logical, r.emailSet.size, healthJson, impactJson, JSON.stringify(r.factors), r.contributionSum, scored.rank.get(r.lineageId) ?? 0, scored.rawRank.get(r.lineageId) ?? 0, JSON.stringify(r.rawTimes), String(FORMULA_VERSION));
      }
      delEdge.run(runId);
      for (const e of coupling.edges) {
        const edgeId = `edge:${sha16(`${runId}\u0000${e.a}\u0000${e.b}`)}`;
        insEdge.run(edgeId, runId, e.a, e.b, e.support, e.countA, e.countB, coupling.totalChanges, e.confidenceAToB, e.confidenceBToA, e.lift, e.jaccard, e.firstSeen, e.lastSeen, statics.available ? (statics.flags.get(`${e.a}\u0001${e.b}`) ?? "NONE") : "UNKNOWN");
      }
      // run-level counters the read paths must not re-derive or lose (§7.9 below-floor disclosure)
      db.prepare("update history_runs set state = 'COMPLETE', stats_json = ? where run_id = ?")
        .run(JSON.stringify({ commits: wrote, logicalChanges: coupling.totalChanges, edges: coupling.edges.length, belowFloorCount: coupling.belowFloorCount, pairTruncated: coupling.pairTruncated, ubiquitousFiles: coupling.ubiquitous.length }), runId);
    });
    if (wrote === 0) warnings.push("no commits were read for this window and policy; the report is empty and honest about it");
    const note = `${wrote} commit(s) read, ${scored.rows.length} file(s) scored, ${coupling.edges.length} co-change edge(s) kept from ${coupling.totalChanges} eligible logical change(s)`;
    return { warnings, note, partialMetrics: this.partialMetrics };
  }

  /** A→B / B→A / BOTH / NONE from the static flow graph at the latest indexed revision (§7.9, §6.3). */
  private dependencyFlags(pathOf: Map<string, string>, edges: { a: string; b: string }[]): { available: boolean; reason: string; flags: Map<string, "NONE" | "A_TO_B" | "B_TO_A" | "BOTH"> } {
    const flags = new Map<string, "NONE" | "A_TO_B" | "B_TO_A" | "BOTH">();
    if (!edges.length) return { available: true, reason: "", flags };
    const rev = this.store.latestRevision();
    if (!rev) return { available: false, reason: "no indexed revision", flags };
    const flow = flowGraph(this.store, rev.id);
    // The static graph keys most edges on the file entity itself (`file:<path>`); a file with no parsed
    // symbols still has that entity, so both are used as the file's node set.
    const entitiesOf = new Map<string, string[]>();
    for (const e of this.store.entities(rev.id)) if (e.kind === "file") entitiesOf.set(e.file, [e.entityId]);
    for (const [file, ents] of flow.byFile) entitiesOf.set(file, [...(entitiesOf.get(file) ?? []), ...ents.map((e) => e.entityId)]);
    const dirBetween = (a: string, b: string): "NONE" | "A_TO_B" | "B_TO_A" | "BOTH" => {
      const ea = entitiesOf.get(a), eb = entitiesOf.get(b);
      if (!ea?.length || !eb?.length) return "NONE";
      const eaSet = new Set(ea), ebSet = new Set(eb);
      const reaches = (from: string[], into: Set<string>): boolean => {
        for (const id of from) for (const r of flow.out.get(id) ?? []) if (into.has(r.to)) return true;
        return false;
      };
      const aToB = reaches(ea, ebSet), bToA = reaches(eb, eaSet);
      return aToB && bToA ? "BOTH" : aToB ? "A_TO_B" : bToA ? "B_TO_A" : "NONE";
    };
    // the lineage's newest path is the file name the static graph knows
    const newestPath = new Map<string, string>();
    for (const [path, lin] of pathOf) newestPath.set(lin, path);
    for (const e of edges) {
      const a = newestPath.get(e.a), b = newestPath.get(e.b);
      if (a && b) flags.set(`${e.a}\u0001${e.b}`, dirBetween(a, b));
    }
    return { available: true, reason: "", flags };
  }

  // ------------------------------------------------------------------
  // the report and explanation queries (§8)
  // ------------------------------------------------------------------

  getReport(ctx: CallContext, req: { runId: string; order?: "SCORE" | "CHANGES" | "HEALTH" | "IMPACT"; cursor?: string; limit?: number }): { report: HotspotReportView; nextCursor?: string } | ApiFail {
    const run = this.db.prepare("select * from history_runs where run_id = ?").get(req.runId) as RunRow | undefined;
    if (!run) return failApi(ctx, "NOT_FOUND", "no such history run; run C26/analyzeHistory first");
    if (run.state === "READING") return failApi(ctx, "INSUFFICIENT_EVIDENCE", "this run is still reading history; see its job status and try again", true);
    const root = this.rootFor(run.repository_id);
    const warnings: string[] = [];
    const stale = { stale: false, behindBy: 0, rewritten: false };
    if (root) {
      const now = inspectHead(root);
      if (now.isRepo && now.head && now.head !== run.head_commit) {
        if (isAncestor(root, run.head_commit, now.head)) { stale.stale = true; stale.behindBy = commitCountBetween(root, run.head_commit, now.head); }
        else { stale.rewritten = true; stale.stale = true; }
      }
      if (now.isRepo && now.shallow !== !!run.shallow) { stale.stale = true; warnings.push(`the repository is ${now.shallow ? "now" : "no longer"} shallow since this analysis; re-analyse for numbers that reflect that`); }
    }
    if (stale.stale) warnings.push(stale.rewritten
      ? "the history was rewritten since this run: the boundary is INVALIDATED and a rebuild is required"
      : `analysed up to ${run.head_commit.slice(0, 10)}, which is ${stale.behindBy} commit(s) behind the current head`);
    // A rewritten history is a different boundary: mark the run INVALIDATED so no surface ever mixes the two.
    if (stale.rewritten && run.state !== "INVALIDATED") {
      this.db.prepare("update history_runs set state = 'INVALIDATED', note = ? where run_id = ?").run("the history was rewritten; the boundary no longer describes the repository", run.run_id);
      run.state = "INVALIDATED";
    }
    if (run.shallow) warnings.push("this clone is shallow: history is truncated at its boundary, so every score here is a lower bound and the ranking may be misleading");
    // authorization comes before ranking or counting (F01-A3 / F06-A6)
    const denied = this.deniedCheck(root);
    const allRows = this.db.prepare("select * from hotspot_scores where run_id = ?").all(req.runId) as unknown as ScoreRow[];
    const visible = allRows.filter((r) => !denied(r.path));
    const hiddenCount = allRows.length - visible.length;
    if (hiddenCount > 0) warnings.push(`${hiddenCount} file(s) are in code you do not have access to and were left out of this report (counted, never named)`);
    const order = req.order ?? "SCORE";
    const sorted = this.sortRows(visible, order);
    const limit = Math.min(MAX_SCORE_ROWS_PAGE, Math.max(1, req.limit ?? DEFAULT_SCORE_ROWS_PAGE));
    let start = 0;
    if (req.cursor) {
      const dec = this.decodeCursor(req.cursor);
      if (!dec || dec.runId !== req.runId || dec.order !== order || dec.boundaryHash !== run.boundary_hash) return failApi(ctx, "INVALID_SCHEMA", "this cursor does not belong to this run and order; start a fresh page", false);
      start = Number(dec.offset) || 0;
      if (start >= sorted.length) return failApi(ctx, "INVALID_SCHEMA", "the cursor points past the end of this run's rows; start a fresh page", false);
    }
    const page = sorted.slice(start, start + limit);
    const policy = this.runPolicy(run.policy_hash) ?? DEFAULT_POLICY;
    const stats = JSON.parse(run.stats_json || "{}") as { belowFloorCount?: number; pairTruncated?: boolean; ubiquitousFiles?: number };
    const stability = this.rankStabilityInternal(req.runId, 20, 50, 5);
    const nextCursor = start + limit < sorted.length ? this.encodeCursor({ runId: req.runId, order, offset: String(start + limit), boundaryHash: run.boundary_hash }) : undefined;
    const report: HotspotReportView = {
      runId: req.runId, boundary: this.boundaryOf(run), policyHash: run.policy_hash, mergePolicyUsed: policy.mergePolicy,
      state: run.state, stale, warnings, rows: page.map((r) => this.toRow(r, policy)),
      ...(nextCursor ? { nextCursor } : {}),
      exclusions: this.exclusionSummary(run),
      stability: stability?.view ?? null,
      coverage: {
        shallow: !!run.shallow, commitCount: run.commit_count,
        ...(run.commit_count >= CAP_COMMITS ? { cappedAt: CAP_COMMITS } : {}),
        symbolResolution: "FILE_ONLY",
        gaps: [
          ...(run.commit_count >= CAP_COMMITS ? [`the analysis is capped at ${CAP_COMMITS} commits, so only the newest part of the window was analysed`] : []),
          ...(run.state === "PARTIAL" ? ["the run is partial: a bound (commit cap, read deadline or pair budget) bit; see the warnings"] : []),
          ...(stats.pairTruncated ? [`the co-change pair budget (${COUPLING_PAIR_CAP}) bit; the remaining pairs were not examined`] : []),
          ...(stats.belowFloorCount ? [`${stats.belowFloorCount} co-change pair(s) fell below the reporting floor (support ≥ ${policy.coupling.minSupport} and confidence ≥ ${policy.coupling.minConfidence}); they are counted but not reported`] : []),
          ...(stats.ubiquitousFiles ? [`${stats.ubiquitousFiles} file(s) changed in more than ${Math.round(policy.coupling.ubiquitousShare * 100)}% of logical changes and were left out of the co-change population (listed in the exclusions)`] : []),
          "history is resolved to files, not symbols: commits before the first indexed revision are not resolved to definitions (Registry carries identity only for indexed revisions); function-level history is not attempted",
          "files deleted before the analysed head are not ranked; a rename keeps its history only because rename tracking is on",
        ],
      },
      contributorsAvailable: policy.contributors !== "HIDDEN",
    };
    return { report, ...(nextCursor ? { nextCursor } : {}) };
  }

  private sortRows(rows: ScoreRow[], order: "SCORE" | "CHANGES" | "HEALTH" | "IMPACT"): ScoreRow[] {
    const debtOf = (r: ScoreRow): number => (JSON.parse(r.health_json) as { debt: number | null }).debt ?? -1;
    const impactOf = (r: ScoreRow): number => { const v = (JSON.parse(r.impact_json) as { dependents: number | "NOT_AVAILABLE" }).dependents; return typeof v === "number" ? v : -1; };
    switch (order) {
      case "CHANGES": return [...rows].sort((a, b) => b.changes_decayed - a.changes_decayed || a.path.localeCompare(b.path));
      case "HEALTH": return [...rows].sort((a, b) => debtOf(b) - debtOf(a) || a.path.localeCompare(b.path));
      case "IMPACT": return [...rows].sort((a, b) => impactOf(b) - impactOf(a) || a.path.localeCompare(b.path));
      default: return [...rows].sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
    }
  }

  private toRow(r: ScoreRow, policy: HistoryPolicy): HotspotScoreRow {
    const health = JSON.parse(r.health_json) as { signals: HealthSignal[]; worstFunction: { name: string; value: number } | null };
    const impact = JSON.parse(r.impact_json) as { dependents: number | "NOT_AVAILABLE"; coveragePercent: number | "NOT_AVAILABLE"; incidents: number | "NOT_AVAILABLE" };
    const factors = JSON.parse(r.factors_json) as FactorsRow[];
    const changeFactor = factors.find((f) => f.id === "change");
    const hidden = policy.contributors === "HIDDEN";
    return {
      runId: r.run_id, lineageId: r.lineage_id, path: r.path, renamedFrom: this.renamedFrom(r.run_id, r.lineage_id),
      score: r.score, rank: r.rank, rankRaw: r.rank_raw,
      change: { raw: r.changes_raw, logical: r.logical_changes, decayed: r.changes_decayed, percentile: changeFactor?.norm ?? 0.5 },
      health: { signals: health.signals, ...(health.worstFunction ? { worstFunction: { name: health.worstFunction.name, value: Number(health.worstFunction.value) } } : {}) },
      impact: { dependents: typeof impact.dependents === "number" ? impact.dependents : 0, incidents: impact.incidents, coveragePercent: impact.coveragePercent },
      knowledge: { contributors: hidden ? "HIDDEN" : r.distinct_contributors },
      missing: factors.filter((f) => f.missing).map((f) => f.id),
    };
  }

  private renamedFrom(runId: string, lineageId: string): string[] {
    const run = this.db.prepare("select repository_id from history_runs where run_id = ?").get(runId) as unknown as { repository_id: string } | undefined;
    if (!run) return [];
    const segs = this.db.prepare("select path from file_lineage where repository_id = ? and lineage_id = ? order by rowid").all(run.repository_id, lineageId) as { path: string }[];
    return segs.length > 1 ? segs.slice(0, -1).map((s) => s.path) : [];
  }

  private boundaryOf(run: RunRow): HistoryBoundaryView {
    return {
      repositoryId: run.repository_id, headCommit: run.head_commit, ...(run.since_time ? { since: run.since_time } : {}), until: run.until_time,
      shallow: !!run.shallow, commitCount: run.commit_count, commitListHash: run.boundary_hash.replace(/^bnd:/, ""),
    };
  }

  /** The exclusion ledger (§7.3): every excluded commit with its rule and the ubiquitous files, with samples. */
  private exclusionSummary(run: RunRow): ExclusionSummary {
    const root = this.rootFor(run.repository_id);
    const rows = this.db.prepare("select rule, reason, commit_hash from history_exclusions where run_id = ? and rule <> 'ubiquitous-file'").all(run.run_id) as { rule: string; reason: string; commit_hash: string }[];
    const byRule = new Map<string, number>();
    for (const r of rows) byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
    const samples: ExcludedCommitView[] = rows.slice(0, 25).map((r) => {
      const ce = this.db.prepare("select committed_at, class, class_reason, files_changed, logical_change_id, pr_number from commit_events where commit_hash = ? limit 1").get(r.commit_hash) as { committed_at: string; class: string; class_reason: string; files_changed: number; logical_change_id: string; pr_number: number | null } | undefined;
      return {
        commitHash: r.commit_hash, committedAt: ce?.committed_at ?? "", subject: this.readSubject(root, r.commit_hash),
        prNumber: (ce?.pr_number as number | null) ?? null, class: ce?.class ?? "", classReason: r.reason || ce?.class_reason || "", filesChanged: ce?.files_changed ?? 0,
        logicalChangeId: ce?.logical_change_id ?? "", rule: r.rule,
      };
    });
    const ubiquitous = (this.db.prepare("select reason from history_exclusions where run_id = ? and rule = 'ubiquitous-file'").all(run.run_id) as { reason: string }[])
      .map((r) => JSON.parse(r.reason) as { path: string; share: number; logicalChanges: number; totalChanges: number });
    return { total: rows.length, byRule: [...byRule.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count), ubiquitousFiles: ubiquitous, samples };
  }

  private readSubject(root: string | null, hash: string): string {
    if (!root) return "";
    if (!this.subjectCache.has(hash)) {
      const out = gitRun(root, ["log", "--no-walk=unsorted", "--pretty=format:%H%x1f%s", hash], 1024 * 1024);
      if (out === null) return "";
      for (const line of out.split("\n")) { const [h, s] = line.split("\x1f"); if (h && s !== undefined) this.subjectCache.set(h, s); }
    }
    return this.subjectCache.get(hash) ?? "";
  }

  /** Explaining a hotspot (§7.10): the factors that made the score, the counted changes, the excluded commits, sensitivity and the trend. */
  explainHotspot(ctx: CallContext, req: { runId: string; lineageId: string; cursor?: string; limit?: number }): { explain: ExplainHotspotView; nextCursor?: string } | ApiFail {
    const run = this.db.prepare("select * from history_runs where run_id = ?").get(req.runId) as RunRow | undefined;
    if (!run) return failApi(ctx, "NOT_FOUND", "no such history run; run C26/analyzeHistory first");
    const row = this.db.prepare("select * from hotspot_scores where run_id = ? and lineage_id = ?").get(req.runId, req.lineageId) as ScoreRow | undefined;
    if (!row) return failApi(ctx, "NOT_FOUND", "no scored row for this lineage in this run");
    const root = this.rootFor(run.repository_id);
    if (this.deniedCheck(root)(row.path)) return failApi(ctx, "FORBIDDEN", "this file is in code you do not have access to", false);
    const policy = this.runPolicy(run.policy_hash) ?? DEFAULT_POLICY;
    const segs = this.lineageSegments(run.repository_id, req.lineageId);
    const at = (hash: string): string => (this.db.prepare("select committed_at from commit_events where repository_id = ? and commit_hash = ?").get(run.repository_id, hash) as { committed_at: string } | undefined)?.committed_at ?? "";
    const excludedBy = new Set(this.exclusionHashes(run.run_id));
    // counted commits touching this lineage: never excluded, and not the merge class (which has no diff of its own)
    const counted = new Map<string, string | null>();
    for (const p of segs) {
      const fs = this.db.prepare("select commit_hash, path from file_changes where repository_id = ? and (path = ? or old_path = ?)").all(run.repository_id, p, p) as { commit_hash: string; path: string }[];
      for (const f of fs) if (!excludedBy.has(f.commit_hash)) counted.set(f.commit_hash, f.path === p ? null : p);
    }
    const ordered = [...counted.entries()].map(([hash, oldPath]) => ({ hash, at: at(hash), pathAtCommit: oldPath }))
      .filter((c) => c.at !== "").sort((a, b) => b.at.localeCompare(a.at) || a.hash.localeCompare(b.hash));
    const limit = Math.min(MAX_EXPLAIN_COMMITS_PAGE, Math.max(1, req.limit ?? MAX_EXPLAIN_COMMITS_PAGE));
    let start = 0;
    if (req.cursor) {
      const dec = this.decodeCursor(req.cursor);
      if (!dec || dec.runId !== req.runId || dec.lineageId !== req.lineageId) return failApi(ctx, "INVALID_SCHEMA", "this cursor does not belong to this lineage; start a fresh page", false);
      start = Number(dec.offset) || 0;
      if (start >= ordered.length) return failApi(ctx, "INVALID_SCHEMA", "the cursor points past the end of this lineage's commits; start a fresh page", false);
    }
    const changes: CommitEvidence[] = ordered.slice(start, start + limit).map((c) => this.commitEvidence(run.repository_id, c.hash, root, c.pathAtCommit));
    // the excluded commits that touched this file, always shown beside the counted ones (F06-A5)
    const excluded: ExcludedCommitView[] = [];
    const ledger = this.db.prepare("select commit_hash, rule, reason from history_exclusions where run_id = ? and rule <> 'ubiquitous-file'").all(run.run_id) as { commit_hash: string; rule: string; reason: string }[];
    for (const l of ledger) {
      const hit = segs.some((p) => !!this.db.prepare("select 1 from file_changes where repository_id = ? and commit_hash = ? and (path = ? or old_path = ?)").get(run.repository_id, l.commit_hash, p, p));
      if (hit) excluded.push({ ...this.commitEvidence(run.repository_id, l.commit_hash, root), rule: l.rule, classReason: l.reason });
    }
    excluded.sort((a, b) => b.committedAt.localeCompare(a.committedAt) || a.commitHash.localeCompare(b.commitHash));
    const factors: FactorExplanation[] = (JSON.parse(row.factors_json) as FactorsRow[])
      .map((f) => ({ id: f.id, label: f.label, raw: f.raw ?? 0, normalised: f.norm, weight: f.weight, contribution: f.contribution, missing: f.missing }));
    const sensitivity = this.rankSensitivityOf(run, row);
    // trend (§12.1): monthly counts over every counted change of this lineage, raw and decayed
    const untilTime = new Date(run.until_time).getTime();
    const halfLife = policy.decay.halfLifeDays * 24 * 3600 * 1000;
    const buckets = new Map<string, { raw: number; decayed: number }>();
    for (const c of ordered) {
      const month = c.at.slice(0, 7);
      const b = buckets.get(month) ?? { raw: 0, decayed: 0 };
      b.raw += 1;
      b.decayed += Math.pow(0.5, (untilTime - new Date(c.at).getTime()) / Math.max(1, halfLife));
      buckets.set(month, b);
    }
    const trend = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => ({ month, raw: v.raw, decayed: Math.round(v.decayed * 1e6) / 1e6 }));
    const nextCursor = start + limit < ordered.length ? this.encodeCursor({ runId: req.runId, lineageId: req.lineageId, offset: String(start + limit) }) : undefined;
    // Display names leave the store only when the policy names them AND this principal holds a grant (F06-A6).
    let contributors: { displayName: string; commits: number }[] | undefined;
    if (policy.contributors === "NAMES_FOR_AUTHORISED" && this.namesGranted(ctx.actor.principalId) && root) {
      const byAuthor = new Map<string, number>();
      for (const c of ordered) {
        const h = (this.db.prepare("select author_hash from commit_events where repository_id = ? and commit_hash = ?").get(run.repository_id, c.hash) as { author_hash: string } | undefined)?.author_hash;
        if (h) byAuthor.set(h, (byAuthor.get(h) ?? 0) + 1);
      }
      const hashes = ordered.slice(0, 500).map((c) => c.hash);
      const out = hashes.length ? gitRun(root, ["log", "--no-walk=unsorted", "--format=%H%x1f%ae%x1f%an", ...hashes], 8 * 1024 * 1024) : null;
      const nameOf = new Map<string, string>();
      for (const line of (out ?? "").split("\n")) { const [h, email, name] = line.split("\x1f"); if (h && email) nameOf.set(this.hmacAuthor(email), name || email); }
      contributors = [...byAuthor.entries()].map(([h, n]) => ({ displayName: nameOf.get(h) ?? "(unnamed)", commits: n })).sort((a, b) => b.commits - a.commits || a.displayName.localeCompare(b.displayName)).slice(0, 20);
    }
    return {
      explain: {
        runId: req.runId, lineageId: req.lineageId, path: row.path, renamedFrom: this.renamedFrom(req.runId, req.lineageId),
        score: row.score, rank: row.rank, factors, changes, ...(nextCursor ? { nextCursor } : {}), excluded, sensitivity, trend,
        ...(contributors ? { contributors } : {}),
        gaps: this.explainGaps(run),
      },
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private explainGaps(run: RunRow): string[] {
    const policy = this.runPolicy(run.policy_hash) ?? DEFAULT_POLICY;
    const gaps: string[] = [];
    if (policy.contributors === "HIDDEN") gaps.push("contributor counts are hidden by this policy, so the knowledge factor is computed from identity hashes and the per-person breakdown is not available to anyone through this API");
    if (run.state === "PARTIAL") gaps.push("this run is partial: a bound (commit cap, read deadline or pair budget) bit; the numbers cover what was analysed and say so");
    gaps.push("rename tracking is a similarity heuristic; splits and merges of files are not followed beyond copy detection, and files deleted before the head are not ranked");
    gaps.push("history before the window's boundary is not analysed; a shallow clone truncates it further and every score is then only a lower bound");
    gaps.push("the score is a prioritisation heuristic composed of the factors above; it is not a probability of defects and says nothing about a person's productivity");
    return gaps;
  }

  private commitEvidence(repositoryId: string, hash: string, root: string | null, pathAtCommit?: string | null): CommitEvidence & { rule?: string } {
    const ce = this.db.prepare("select committed_at, class, class_reason, files_changed, logical_change_id, pr_number from commit_events where repository_id = ? and commit_hash = ?").get(repositoryId, hash) as Record<string, string | number | null> | undefined;
    return {
      commitHash: hash, committedAt: String(ce?.committed_at ?? ""), subject: this.readSubject(root, hash),
      prNumber: (ce?.pr_number as number | null) ?? null, class: String(ce?.class ?? "NORMAL"), classReason: String(ce?.class_reason ?? ""),
      filesChanged: Number(ce?.files_changed ?? 0), logicalChangeId: String(ce?.logical_change_id ?? ""),
      ...(pathAtCommit ? { pathAtCommit } : {}),
    };
  }

  /** `explainCoupling` (F06-A3): the commits where both files changed, with the support on display. */
  explainCoupling(ctx: CallContext, req: { edgeId: string; cursor?: string; limit?: number }): { explain: ExplainCouplingView } | ApiFail {
    const edge = this.db.prepare("select * from cochange_edges where edge_id = ?").get(req.edgeId) as EdgeRow | undefined;
    if (!edge) return failApi(ctx, "NOT_FOUND", "no such co-change edge; edges exist per run — use C26/listCoupling to list them", false);
    const run = this.db.prepare("select * from history_runs where run_id = ?").get(edge.run_id) as RunRow | undefined;
    if (!run) return failApi(ctx, "NOT_FOUND", "the edge's run is gone", false);
    const root = this.rootFor(run.repository_id);
    const deny = this.deniedCheck(root);
    const aSegs = this.lineageSegments(run.repository_id, edge.a_lineage);
    const bSegs = this.lineageSegments(run.repository_id, edge.b_lineage);
    if (aSegs.some(deny) || bSegs.some(deny)) return failApi(ctx, "FORBIDDEN", "a file of this co-change edge is in code you do not have access to", false);
    const commitsOf = (segs: string[]): Set<string> => {
      const out = new Set<string>();
      for (const p of segs) for (const r of this.db.prepare("select commit_hash from file_changes where repository_id = ? and (path = ? or old_path = ?)").all(run.repository_id, p, p) as { commit_hash: string }[]) out.add(r.commit_hash);
      return out;
    };
    const aCommits = commitsOf(aSegs), bCommits = commitsOf(bSegs);
    const excludedBy = new Set(this.exclusionHashes(run.run_id));
    const both = [...aCommits].filter((h) => bCommits.has(h) && !excludedBy.has(h));
    const at = (hash: string): string => (this.db.prepare("select committed_at from commit_events where repository_id = ? and commit_hash = ?").get(run.repository_id, hash) as { committed_at: string } | undefined)?.committed_at ?? "";
    const ordered = both.filter((h) => at(h) !== "").sort((x, y) => at(y).localeCompare(at(x)) || x.localeCompare(y));
    const limit = Math.min(MAX_EXPLAIN_COMMITS_PAGE, Math.max(1, req.limit ?? MAX_EXPLAIN_COMMITS_PAGE));
    let start = 0;
    if (req.cursor) {
      const dec = this.decodeCursor(req.cursor);
      if (!dec || dec.edgeId !== req.edgeId) return failApi(ctx, "INVALID_SCHEMA", "this cursor does not belong to this edge; start a fresh page", false);
      start = Number(dec.offset) || 0;
      if (start >= ordered.length) return failApi(ctx, "INVALID_SCHEMA", "the cursor points past the end of this edge's commits; start a fresh page", false);
    }
    const commits = ordered.slice(start, start + limit).map((h) => this.commitEvidence(run.repository_id, h, root));
    const nextCursor = start + limit < ordered.length ? this.encodeCursor({ edgeId: req.edgeId, offset: String(start + limit) }) : undefined;
    const newest = (segs: string[]): string => segs.at(-1) ?? "";
    return {
      explain: {
        edgeId: edge.edge_id, runId: run.run_id,
        aPath: newest(aSegs), bPath: newest(bSegs),
        support: edge.support, countA: edge.count_a, countB: edge.count_b, total: edge.total_changes,
        confidenceAToB: edge.confidence_a_to_b, confidenceBToA: edge.confidence_b_to_a, lift: edge.lift,
        staticDependency: edge.static_dependency, commits, ...(nextCursor ? { nextCursor } : {}),
        gaps: [
          `the support counts eligible logical changes in this run's window (${edge.support} of ${edge.total_changes}); changes touching more than ${(this.runPolicy(run.policy_hash) ?? DEFAULT_POLICY).coupling.maxFilesPerChange} files and ubiquitous files are outside that population`,
          "co-change is a statistical relation — files that tend to change together — and is deliberately kept out of the static call graph (§6.3)",
          ...(edge.static_dependency === "NONE" ? ["no static call or import relation exists between these files at the head: this is hidden coupling, worth knowing but not proof of a defect"] : []),
          ...(edge.static_dependency === "UNKNOWN" ? ["no indexed revision exists for this repository, so whether a static call or import relation exists could not be checked; this is unknown, not absent"] : []),
        ],
      },
    };
  }

  /** The stored-edges listing (§8); below-floor pairs are counted in the run's stats, never listed (F06-A3). */
  listCoupling(ctx: CallContext, req: { runId: string; forLineage?: string; minSupport?: number; cursor?: string; limit?: number }): { edges: CouplingEdgeView[]; total: number; belowFloorCount: number | null; nextCursor?: string } | ApiFail {
    const run = this.db.prepare("select * from history_runs where run_id = ?").get(req.runId) as RunRow | undefined;
    if (!run) return failApi(ctx, "NOT_FOUND", "no such history run; run C26/analyzeHistory first");
    let edges = this.db.prepare("select * from cochange_edges where run_id = ?").all(req.runId) as unknown as EdgeRow[];
    if (req.forLineage) edges = edges.filter((e) => e.a_lineage === req.forLineage || e.b_lineage === req.forLineage);
    if (req.minSupport !== undefined) edges = edges.filter((e) => e.support >= (req.minSupport ?? 1));
    edges.sort((a, b) => b.support - a.support || a.a_lineage.localeCompare(b.a_lineage) || a.b_lineage.localeCompare(b.b_lineage));
    const limit = Math.min(200, Math.max(1, req.limit ?? 20));
    let start = 0;
    if (req.cursor) {
      const dec = this.decodeCursor(req.cursor);
      if (!dec || dec.runId !== req.runId || dec.for !== (req.forLineage ?? "")) return failApi(ctx, "INVALID_SCHEMA", "this cursor does not belong to this query; start a fresh page", false);
      start = Number(dec.offset) || 0;
      if (start >= edges.length) return failApi(ctx, "INVALID_SCHEMA", "the cursor points past the end of this run's edges; start a fresh page", false);
    }
    const page = edges.slice(start, start + limit);
    const newest = new Map<string, string>();
    for (const s of this.db.prepare("select lineage_id, path from file_lineage where repository_id = ? order by rowid").all(run.repository_id) as { lineage_id: string; path: string }[]) newest.set(s.lineage_id, s.path);
    const stats = JSON.parse(run.stats_json || "{}") as { belowFloorCount?: number };
    const nextCursor = start + limit < edges.length ? this.encodeCursor({ runId: req.runId, for: req.forLineage ?? "", offset: String(start + limit) }) : undefined;
    return {
      edges: page.map((e) => ({
        edgeId: e.edge_id, runId: e.run_id, aLineage: e.a_lineage, aPath: newest.get(e.a_lineage) ?? "", bLineage: e.b_lineage, bPath: newest.get(e.b_lineage) ?? "",
        support: e.support, countA: e.count_a, countB: e.count_b, totalChanges: e.total_changes,
        confidenceAToB: e.confidence_a_to_b, confidenceBToA: e.confidence_b_to_a, lift: e.lift, jaccard: e.jaccard,
        firstSeen: e.first_seen, lastSeen: e.last_seen, staticDependency: e.static_dependency,
      })),
      total: edges.length,
      belowFloorCount: typeof stats.belowFloorCount === "number" ? stats.belowFloorCount : null,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private lineageSegments(repositoryId: string, lineageId: string): string[] {
    return (this.db.prepare("select path from file_lineage where repository_id = ? and lineage_id = ? order by rowid").all(repositoryId, lineageId) as { path: string }[]).map((r) => r.path);
  }
  private exclusionHashes(runId: string): string[] {
    return (this.db.prepare("select commit_hash from history_exclusions where run_id = ? and rule <> 'ubiquitous-file'").all(runId) as { commit_hash: string }[]).map((r) => r.commit_hash);
  }

  // ---- rank stability (F06-D10; the same policy hash gives the same trial sets) ----

  rankStability(ctx: CallContext, req: { runId: string; perturbationPercent?: number; trials?: number; topK?: number }): RankStabilityView | ApiFail {
    void ctx;
    const run = this.db.prepare("select run_id from history_runs where run_id = ?").get(req.runId) as { run_id: string } | undefined;
    if (!run) return failApi(ctx, "NOT_FOUND", "no such history run; run C26/analyzeHistory first");
    const r = this.rankStabilityInternal(req.runId, req.perturbationPercent ?? 20, Math.min(200, Math.max(2, req.trials ?? 50)), Math.max(1, req.topK ?? 10));
    if (r === null) return failApi(ctx, "INSUFFICIENT_EVIDENCE", "this run has no scored rows to re-rank", true);
    return r.view;
  }

  private rankStabilityInternal(runId: string, perturbationPercent: number, trials: number, topK: number): { view: RankStabilityView } | null {
    interface StableRow { lineageId: string; norms: Record<FactorId, number>; times: number[]; changeDecayed: number }
    const raws = this.db.prepare("select * from hotspot_scores where run_id = ?").all(runId) as unknown as ScoreRow[];
    if (!raws.length) return null;
    const run = this.db.prepare("select * from history_runs where run_id = ?").get(runId) as unknown as RunRow;
    const policy = this.runPolicy(run.policy_hash) ?? DEFAULT_POLICY;
    const rows: StableRow[] = raws.map((r) => ({
      lineageId: r.lineage_id, norms: this.factorNormsOf(r), times: JSON.parse(r.times_json) as number[], changeDecayed: r.changes_decayed,
    }));
    const baselineTop = [...raws].sort((a, b) => a.rank - b.rank).slice(0, topK).map((r) => r.lineage_id);
    const seedHex = sha256Hex(`stability\u0000${run.policy_hash}\u0000${perturbationPercent}\u0000${trials}\u0000${topK}`);
    const rng = new SeededRandom(seedHex);
    const untilBase = new Date(run.until_time).getTime();
    const halfLife = policy.decay.halfLifeDays * 24 * 3600 * 1000;
    const baseWeights = effectiveWeights(policy);
    let stable = 0;
    const changes: { entered: string[]; left: string[] }[] = [];
    for (let t = 0; t < trials; t++) {
      const weights: Record<FactorId, number> = { ...baseWeights };
      for (const f of FACTOR_IDS) weights[f] = Math.max(0, weights[f] * (1 + (2 * rng.next() - 1) * (perturbationPercent / 100)));
      // the window shifts by a month in a third of the trials: decayed change values are recomputed from stored times
      const shift = t % 3 === 0 ? -MONTH : t % 3 === 1 ? 0 : MONTH;
      const wsum = FACTOR_IDS.reduce((a, f) => a + weights[f], 0) || 1;
      const decayed = rows.map((r) => shift === 0 ? r.changeDecayed : r.times.reduce((s, tt) => s + Math.pow(0.5, (untilBase + shift - tt) / Math.max(1, halfLife)), 0));
      const pct = percentiles(decayed);
      const scored = rows.map((r, i) => FACTOR_IDS.reduce((s, f) => s + weights[f] * (f === "change" ? (pct.get(decayed[i]) ?? 0.5) : (r.norms[f] ?? 0.5)), 0) / wsum);
      const top = [...rows.map((r, i) => ({ id: r.lineageId, s: scored[i], path: "" }))].sort((a, b) => b.s - a.s).slice(0, topK).map((x) => x.id);
      if (top.join(",") === baselineTop.join(",")) stable++;
      else changes.push({ entered: top.filter((id) => !baselineTop.includes(id)), left: baselineTop.filter((id) => !top.includes(id)) });
    }
    return { view: { topK, trials, stableFraction: stable / trials, changes: changes.slice(0, 10), perturbationPercent, seedHex: seedHex.slice(0, 12) } };
  }

  private factorNormsOf(row: ScoreRow): Record<FactorId, number> {
    const out = {} as Record<FactorId, number>;
    for (const f of JSON.parse(row.factors_json) as FactorsRow[]) out[f.id] = f.missing || f.norm === null || !Number.isFinite(f.norm) ? 0.5 : f.norm;
    return out;
  }

  // ---- sensitivity of a rank (§7.10): what the exclusions and each factor do to the ordering ----

  private rankSensitivityOf(run: RunRow, row: ScoreRow): RankSensitivity {
    const all = this.db.prepare("select * from hotspot_scores where run_id = ?").all(run.run_id) as unknown as ScoreRow[];
    const policy = this.runPolicy(run.policy_hash) ?? DEFAULT_POLICY;
    const weights = effectiveWeights(policy);
    const wsum = FACTOR_IDS.reduce((a, f) => a + (weights[f] ?? 0), 0) || 1;
    const ids = all.map((r) => r.lineage_id);
    const norms = all.map((r) => this.factorNormsOf(r));
    const rankOf = (scored: number[]): number => {
      const sorted = [...scored.map((s, i) => ({ s, id: ids[i] }))].sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
      return sorted.findIndex((x) => x.id === row.lineage_id) + 1;
    };
    const scoreWith = (n: Record<FactorId, number>[], w: Record<FactorId, number>): number[] => {
      const ws = FACTOR_IDS.reduce((a, f) => a + (w[f] ?? 0), 0) || 1;
      return n.map((x) => FACTOR_IDS.reduce((s, f) => s + (w[f] ?? 0) * (x[f] ?? 0.5), 0) / ws);
    };
    const baseline = rankOf(scoreWith(norms, weights));
    // rank again with each exclusion class's commits counted back in (§7.3's "ranking effect of exclusions")
    const ledger = this.db.prepare("select rule, commit_hash from history_exclusions where run_id = ? and rule <> 'ubiquitous-file'").all(run.run_id) as { rule: string; commit_hash: string }[];
    const untilTime = new Date(run.until_time).getTime();
    const halfLife = policy.decay.halfLifeDays * 24 * 3600 * 1000;
    const withClass: { rule: string; rank: number }[] = [];
    for (const rule of [...new Set(ledger.map((x) => x.rule))].sort()) {
      const extra = new Map<string, number[]>();
      for (const l of ledger.filter((x) => x.rule === rule)) {
        const ce = this.db.prepare("select committed_at from commit_events where repository_id = ? and commit_hash = ?").get(run.repository_id, l.commit_hash) as { committed_at: string } | undefined;
        if (!ce) continue;
        const t = new Date(ce.committed_at).getTime();
        for (const f of this.db.prepare("select path, old_path from file_changes where repository_id = ? and commit_hash = ?").all(run.repository_id, l.commit_hash) as { path: string; old_path: string | null }[]) {
          for (const p of [f.path, f.old_path ?? ""].filter(Boolean)) {
            const lin = this.lineageOfPath(run.repository_id, p);
            if (lin) { const arr = extra.get(lin) ?? []; arr.push(t); extra.set(lin, arr); }
          }
        }
      }
      if (!extra.size) continue;
      const decayed = all.map((r) => r.changes_decayed + (extra.get(r.lineage_id) ?? []).reduce((s, t) => s + Math.pow(0.5, (untilTime - t) / Math.max(1, halfLife)), 0));
      const pct = percentiles(decayed);
      const withNorms = norms.map((n, i) => ({ ...n, change: pct.get(decayed[i]) ?? 0.5 }));
      withClass.push({ rule, rank: rankOf(scoreWith(withNorms, weights)) });
    }
    // rank again with each factor removed (§7.10's "what would change the rank")
    const withoutFactor = FACTOR_IDS.map((f) => ({ id: f as string, label: FACTOR_LABELS[f], rank: rankOf(scoreWith(norms, { ...weights, [f]: 0 })) }));
    return { baseline, withClass, withoutFactor };
  }

  private lineageOfPath(repositoryId: string, path: string): string | null {
    const r = this.db.prepare("select lineage_id from file_lineage where repository_id = ? and (path = ? or path = ?) order by rowid desc limit 1").get(repositoryId, path, path) as { lineage_id: string } | undefined;
    return r?.lineage_id ?? null;
  }

  // ---- deletion propagation (§10) ----

  /** Deletes everything this feature stored for a repository (repository deletion / revocation). */
  purgeRepository(repositoryId: string): void {
    const db = this.db;
    const runs = db.prepare("select run_id from history_runs where repository_id = ?").all(repositoryId) as { run_id: string }[];
    this.store.tx(() => {
      for (const r of runs) {
        db.prepare("delete from hotspot_scores where run_id = ?").run(r.run_id);
        db.prepare("delete from cochange_edges where run_id = ?").run(r.run_id);
        db.prepare("delete from history_exclusions where run_id = ?").run(r.run_id);
      }
      db.prepare("delete from history_runs where repository_id = ?").run(repositoryId);
      db.prepare("delete from commit_events where repository_id = ?").run(repositoryId);
      db.prepare("delete from file_changes where repository_id = ?").run(repositoryId);
      db.prepare("delete from file_lineage where repository_id = ?").run(repositoryId);
      db.prepare("delete from history_contributor_names where repository_id = ?").run(repositoryId);
    });
  }
}

// ---------------------------------------------------------------------------
// V16 terrain integration (§17): one function the terrain form calls. With the flag off, or with no
// usable run, it returns null and the terrain behaves exactly as before.
// ---------------------------------------------------------------------------

export interface HistoryFactorsView {
  factors: Map<string, { churn: number; knowledge: number; coupling: number | null }>;
  raw: Map<string, { churn: string; knowledge: string; coupling: string }>;
  runId: string; boundaryHash: string; state: string; shallow: boolean;
  warning: string | null;
}

/**
 * The terrain's `churn` and `knowledge` from the F06 store (flag `history.v2`), normalised 0..1 with the
 * same percentile method as the hotspot score. `coupling` is the stored co-change fan-out when there is a
 * run (the terrain's own coupling stays the static degree). Missing data is the neutral 0.5 and is flagged.
 */
export function historyFactors(store: Store, rev: RevisionRow): HistoryFactorsView | null {
  const db = store.db;
  const flag = db.prepare("select v2 from history_flags where id = 1").get() as { v2: number } | undefined;
  if (!flag?.v2) return null;
  const known = db.prepare("select repository_id from repositories where root = ?").get(resolve(rev.repoRoot)) as { repository_id: string } | undefined;
  const repoIds = [known?.repository_id, `repo:${sha16("path:" + resolve(rev.repoRoot))}`].filter(Boolean) as string[];
  const run = repoIds.map((id) => db.prepare("select * from history_runs where repository_id = ? and state in ('COMPLETE','STALE','PARTIAL') order by created_at desc limit 1").get(id) as RunRow | undefined).find(Boolean);
  if (!run) return null;
  const scores = db.prepare("select * from hotspot_scores where run_id = ?").all(run.run_id) as unknown as ScoreRow[];
  if (!scores.length) return null;
  const denied = store.deniedPrefixes(rev.repoRoot);
  const factors = new Map<string, { churn: number; knowledge: number; coupling: number | null }>();
  const raw = new Map<string, { churn: string; knowledge: string; coupling: string }>();
  for (const s of scores) {
    if (denied.some((p) => s.path === p || s.path.startsWith(p.endsWith("/") ? p : p + "/"))) continue;
    const fx = JSON.parse(s.factors_json) as FactorsRow[];
    const get = (id: FactorId): number | null => { const f = fx.find((x) => x.id === id); return !f || f.missing || f.norm === null || !Number.isFinite(f.norm) ? null : f.norm; };
    const coupling = get("coupling");
    factors.set(s.path, { churn: get("change") ?? 0.5, knowledge: get("knowledge") ?? 0.5, coupling });
    raw.set(s.path, {
      churn: `${s.changes_raw} change(s) in the analysed window, ${s.changes_decayed.toFixed(1)} time-decayed`,
      knowledge: `${s.distinct_contributors} contributor(s)`,
      coupling: coupling === null ? "no co-change data" : `${(fx.find((x) => x.id === "coupling")?.raw ?? 0)} co-change edge(s)`,
    });
  }
  const warning = run.shallow
    ? "the analysed history window came from a shallow clone: churn here is a lower bound"
    : run.state === "PARTIAL" ? "the analysed history run is partial; churn and knowledge cover what was analysed" : null;
  return { factors, raw, runId: run.run_id, boundaryHash: run.boundary_hash, state: run.state, shallow: !!run.shallow, warning };
}
