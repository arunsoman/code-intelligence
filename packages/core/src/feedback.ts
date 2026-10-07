// F15: the reviewer feedback loop — per-repository mutes and ranking weights (spec: F15-reviewer-feedback-loop.md).
//
// The central design point (§1.2) is separation: "correct / incorrect" feeds the existing claim ledger and
// calibration (C18, unchanged), "useful / noise" feeds only the ranking weights and mutes. A true claim can be
// noise and a false claim can look useful; mixing the two would corrupt both stores.
//
// The "learning" is a deterministic, bounded function of a visible label log: recomputing the weights from the
// log on another machine gives identical weights (F15-A1), every change is attributable to a named label and a
// named actor, and one command reverses it (§1.4).

import { createHash, randomUUID } from "node:crypto";
import type { ImpactItem, ImpactReport } from "@cie/schema";
import type { Role } from "./collab.ts";
import { wilson } from "./claims.ts";
import type { Store } from "./store.ts";

// ---------------------------------------------------------------- data model (§6)

export interface UsefulnessLabel {
  id: string; repositoryId: string; itemKind: string; itemId: string; analysisId: string;
  label: "USEFUL" | "NOISE"; principalId: string; role: Role;
  source: "COMMAND" | "REACTION"; isPrAuthor: boolean; provenance: "HUMAN" | "SYNTHETIC"; at: string;
}
export type MuteScope = { type: "REPOSITORY" } | { type: "PATH_PREFIX" | "SYMBOL"; value: string };
export interface MuteRule {
  id: string; repositoryId: string; kind: string; scope: MuteScope;
  createdBy: string; createdAt: string; expiresAt?: string; reason?: string; revokedBy?: string; revokedAt?: string;
}
export interface KindWeight {
  repositoryId: string; kind: string; weight: number;
  labels: { useful: number; noise: number; principals: number };
  status: "default" | "uncalibrated-adjusted"; computedFromLogHash: string; computedAt: string;
}
export interface FeedbackState {
  repositoryId: string;
  labels: { total: number; useful: number; noise: number; principals: number };
  /** Comment-level reactions (weak signal, §7.2.3): they never move per-kind weights. */
  reactions: { up: number; down: number };
  weights: KindWeight[];
  mutes: { active: MuteRule[]; expired: number; revoked: number };
  resets: number;
  /** Per-kind live label counts (what the weights were derived from). */
  kinds: Record<string, { useful: number; noise: number; principals: number }>;
}

// ---------------------------------------------------------------- constants (§7.3, §7.4, §13, S0/D4/D5)

/** D4: below these minimums a kind keeps weight 1.0 and status "default". */
export const MIN_FEEDBACK = 10;
export const DISTINCT_PRINCIPALS = 2;
/** §7.3: one recompute moves a weight by at most this much, clamped to [WEIGHT_MIN, WEIGHT_MAX]. */
export const MAX_WEIGHT_STEP = 0.25;
export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 1.5;
/** §7.4: a mute without an explicit expiry expires after this many days, so forgotten mutes lapse. */
export const MUTE_DEFAULT_TTL_DAYS = 90;
/** §10.3: free text in a command is stored only as a redacted, length-limited mute reason. */
export const REASON_MAX_CHARS = 120;
/** §13: the log read per recompute is capped; truncation is disclosed in the returned state. */
export const LOG_CAP = 10_000;
/** D5/S0: kinds that cannot be silently muted away (§7.5). */
export const SAFETY_CLASS_KINDS = ["TRANSACTION_BYPASS", "TESTS_LOST"];
/** The feedback block marker inside the impact comment (§12), next to the F11/F13 markers. */
export const FEEDBACK_MARKER = "<!-- cie-feedback -->";

const clampWeight = (w: number) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const isBotPrincipal = (p: string) => /\[bot\]$/i.test(p) || p === "github-actions";

/** The mute/weight kind namespace of an item: the specific consequence kind when there is one. */
export const itemKindOf = (item: ImpactItem): string => item.kindDetail ?? item.kind;

// ---------------------------------------------------------------- the pure weight function (§7.3, F15-A1/A3/A7)

export interface WeightInput { useful: number; noise: number; principals: number }
export interface WeightOpts { minFeedback?: number; distinctPrincipals?: number }
/**
 * weight = clamp(0.5 + lower bound of the Wilson interval for u/(u+n), 0.5, 1.5) — reuses wilson() from the
 * calibration gate. Below the minimums the weight is 1.0 ("default"): a few angry reviews cannot swing ranking,
 * and one principal alone can never move a weight (F15-A3). Pure: depends only on the counts, so replaying the
 * label log on a fresh store gives identical weights and `computedFromLogHash` (F15-A1).
 */
export function computeKindWeight(input: WeightInput, opts: WeightOpts = {}): { weight: number; status: KindWeight["status"] } {
  const minFeedback = opts.minFeedback ?? MIN_FEEDBACK;
  const p = opts.distinctPrincipals ?? DISTINCT_PRINCIPALS;
  const n = input.useful + input.noise;
  if (input.principals < p || n < minFeedback) return { weight: 1.0, status: "default" };
  const rate = wilson(input.useful, n).lower;
  return { weight: clampWeight(0.5 + rate), status: "uncalibrated-adjusted" };
}

// ---------------------------------------------------------------- footer (§7.6, §12)

/** §12 copy: never "learned" or "trained"; the uncalibrated label is mandatory while weights are. */
export function footerLine(state: Pick<FeedbackState, "labels" | "mutes">): string {
  const base = state.labels.total > 0
    ? `Ranking adjusted from ${state.labels.total} labels by ${state.labels.principals} reviewer${state.labels.principals === 1 ? "" : "s"} (uncalibrated)`
    : "Ranking: default — no feedback yet";
  const muted = state.mutes.active.length;
  const tail = muted > 0 ? ` · ${muted} kind${muted === 1 ? "" : "s"} muted` : "";
  return `${base}${tail}${state.labels.total > 0 || muted > 0 ? " · log" : ""}`;
}

/** F15-A9: the footer states ranking status and muted counts exactly as stored; a mutated footer is rejected. */
export function checkFeedbackLine(line: string, state: Pick<FeedbackState, "labels" | "mutes">): { ok: true } | { ok: false; rule: number; reason: string } {
  if (!line.startsWith("Ranking")) return { ok: false, rule: 1, reason: "the footer line must start with 'Ranking'" };
  if (Buffer.byteLength(line, "utf8") > 400) return { ok: false, rule: 2, reason: "the footer line is over the per-line budget" };
  if (/\b(learned|trained|smart(er)?|AI-?tuned)\b/i.test(line)) return { ok: false, rule: 3, reason: "the footer never claims learning or training (§12)" };
  if (line !== footerLine(state)) return { ok: false, rule: 4, reason: "the footer does not match the recorded feedback state" };
  return { ok: true };
}

// ---------------------------------------------------------------- applying mutes and weights to a report (§5, §7.4)

const muteMatches = (item: ImpactItem, mute: MuteRule): boolean => {
  if (itemKindOf(item) !== mute.kind && item.kind !== mute.kind) return false;
  if (mute.scope.type === "REPOSITORY") return true;
  if (mute.scope.type === "PATH_PREFIX") return item.citations.some((c) => c.path === mute.scope.value || c.path.startsWith((mute.scope as { value: string }).value + "/"));
  return item.subjectEntityIds.some((id) => id === mute.scope.value || id.endsWith(`#${mute.scope.value}`) || id.endsWith(`::${mute.scope.value}`));
};

export interface FeedbackInput {
  mutes: MuteRule[];
  weights: KindWeight[];
  labelSummary: { total: number; principals: number };
  logHash: string;
  at?: string;
}

/**
 * Apply reviewer feedback to a freshly built report as ranking inputs (§5): a mute moves matching items from
 * `surfaced` to `muted` — counted, never deleted; `suppressed` is untouched so why-not still explains them
 * (F15-A5). A kind weight scales that kind's scores and is recorded in rank.factors (MUTE / WEIGHT), so "why
 * not?" can explain every suppression. The footer state is stored on the report (§11): an old report stays
 * explainable after weights change.
 */
export function applyFeedback(report: ImpactReport, input: FeedbackInput): ImpactReport {
  const active = input.mutes;
  const weightOf = new Map(input.weights.filter((w) => w.status === "uncalibrated-adjusted").map((w) => [w.kind, w.weight]));
  const muted: ImpactItem[] = [];
  const surfaced: ImpactItem[] = [];
  for (const item of report.surfaced) {
    const mute = active.find((m) => muteMatches(item, m));
    if (mute) {
      muted.push({ ...item, rank: { score: item.rank.score, factors: [...item.rank.factors, { name: "MUTE", value: 1, weight: 0 }] } });
      continue;
    }
    const w = weightOf.get(itemKindOf(item)) ?? weightOf.get(item.kind);
    if (w !== undefined && w !== 1) {
      surfaced.push({ ...item, rank: { score: item.rank.score * w, factors: [...item.rank.factors, { name: "WEIGHT", value: w, weight: w }] } });
      continue;
    }
    surfaced.push(item);
  }
  const line = footerLine({
    labels: { total: input.labelSummary.total, useful: 0, noise: 0, principals: input.labelSummary.principals },
    mutes: { active, expired: 0, revoked: 0 },
  });
  return { ...report, surfaced, muted, feedback: { line, logHash: input.logHash, computedAt: input.at ?? new Date().toISOString() } };
}

/** §7.5: safety-class muted items are shown as a one-line count with their kind, rather than disappearing. */
export function mutedCountLines(muted: ImpactItem[]): string[] {
  const byKind = new Map<string, number>();
  for (const item of muted) byKind.set(itemKindOf(item), (byKind.get(itemKindOf(item)) ?? 0) + 1);
  const lines: string[] = [];
  const safety = [...byKind.entries()].filter(([k]) => SAFETY_CLASS_KINDS.includes(k));
  const rest = [...byKind.entries()].filter(([k]) => !SAFETY_CLASS_KINDS.includes(k));
  for (const [kind, n] of safety) lines.push(`${n} muted item${n === 1 ? "" : "s"} of kind ${kind} (safety class — counted, never hidden)`);
  const restCount = rest.reduce((a, [, n]) => a + n, 0);
  if (restCount) lines.push(`${restCount} muted item${restCount === 1 ? "" : "s"} (${rest.length} kind${rest.length === 1 ? "" : "s"})`);
  return lines;
}

// ---------------------------------------------------------------- the store

type LabelRow = {
  id: string; repository_id: string; item_kind: string; item_id: string; analysis_id: string; label: string;
  principal_id: string; role: string; source: string; is_pr_author: number; provenance: string; at: string;
};
type MuteRow = {
  id: string; repository_id: string; kind: string; scope_type: string; scope_value: string | null;
  created_by: string; created_at: string; expires_at: string | null; reason: string | null;
  revoked_by: string | null; revoked_at: string | null;
};

const rowToLabel = (r: LabelRow): UsefulnessLabel => ({
  id: r.id, repositoryId: r.repository_id, itemKind: r.item_kind, itemId: r.item_id, analysisId: r.analysis_id,
  label: r.label as UsefulnessLabel["label"], principalId: r.principal_id, role: r.role as Role,
  source: r.source as UsefulnessLabel["source"], isPrAuthor: !!r.is_pr_author,
  provenance: r.provenance as UsefulnessLabel["provenance"], at: r.at,
});
const rowToMute = (r: MuteRow): MuteRule => ({
  id: r.id, repositoryId: r.repository_id, kind: r.kind,
  scope: r.scope_type === "REPOSITORY" ? { type: "REPOSITORY" } : { type: r.scope_type as "PATH_PREFIX" | "SYMBOL", value: r.scope_value ?? "" },
  createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at ?? undefined, reason: r.reason ?? undefined,
  revokedBy: r.revoked_by ?? undefined, revokedAt: r.revoked_at ?? undefined,
});

export class FeedbackStore {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }

  // ---- roles (D2: the watcher maps forge permissions; these rows pin overrides and audit them) ----
  roleFor(repositoryId: string, principal: string): Role | null {
    const r = this.store.db.prepare("select role from feedback_roles where repository_id = ? and principal_id = ?").get(repositoryId, principal) as { role: Role } | undefined;
    return r?.role ?? null;
  }
  setRole(repositoryId: string, principal: string, role: Role, setBy: string, at = new Date().toISOString()): void {
    this.store.db.prepare("insert or replace into feedback_roles values (?,?,?,?,?)").run(repositoryId, principal, role, setBy, at);
  }

  // ---- usefulness labels (§7.1, §7.2) ----
  /**
   * Append one label to the log (§7.2). Bots are excluded (A4); the derived counts keep one live label per
   * (principal, itemKind, repository, analysis) — a newer row replaces the older in the counts but the log keeps
   * both; the PR author's labels are recorded with isPrAuthor and never count toward the distinct-principal
   * minimum (A3). Only the command and an integer or kind token are parsed from comment text (§10.3).
   */
  recordLabel(input: {
    repositoryId: string; itemKind: string; itemId: string; analysisId: string;
    label: "USEFUL" | "NOISE"; principalId: string; role: Role;
    source?: "COMMAND" | "REACTION"; isPrAuthor?: boolean; provenance?: "HUMAN" | "SYNTHETIC"; at?: string;
  }): { ok: true; label: UsefulnessLabel } | { ok: false; error: string } {
    if (isBotPrincipal(input.principalId)) return { ok: false, error: "bot accounts are excluded from feedback labels (§7.2.1)" };
    if (input.itemKind === "COMMENT" && (input.source ?? "COMMAND") !== "REACTION") return { ok: false, error: "only a comment-level reaction may label the whole comment (§7.2.3)" };
    const label: UsefulnessLabel = {
      id: randomUUID(), repositoryId: input.repositoryId, itemKind: input.itemKind, itemId: input.itemId, analysisId: input.analysisId,
      label: input.label, principalId: input.principalId, role: input.role,
      source: input.source ?? "COMMAND", isPrAuthor: input.isPrAuthor ?? false,
      provenance: input.provenance ?? "HUMAN", at: input.at ?? new Date().toISOString(),
    };
    this.store.db.prepare("insert into usefulness_labels values (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      label.id, label.repositoryId, label.itemKind, label.itemId, label.analysisId, label.label,
      label.principalId, label.role, label.source, label.isPrAuthor ? 1 : 0, label.provenance, label.at);
    return { ok: true, label };
  }

  labels(repositoryId: string, cap = LOG_CAP): { rows: UsefulnessLabel[]; truncated: boolean } {
    const rows = (this.store.db.prepare("select * from usefulness_labels where repository_id = ? order by at, id limit ?").all(repositoryId, cap + 1) as LabelRow[]).map(rowToLabel);
    const truncated = rows.length > cap;
    return { rows: rows.slice(0, cap), truncated };
  }

  /** The live label set: the newest row per (principal, itemKind, analysisId) (§7.2.2). The log keeps everything. */
  liveLabels(repositoryId: string): UsefulnessLabel[] {
    const { rows } = this.labels(repositoryId);
    const live = new Map<string, UsefulnessLabel>();
    for (const l of rows) {
      const key = `${l.principalId}|${l.itemKind}|${l.analysisId}`;
      const prev = live.get(key);
      if (!prev || l.at > prev.at || (l.at === prev.at && l.id > prev.id)) live.set(key, l);
    }
    return [...live.values()];
  }

  /** Per-kind live counts: human, non-reaction labels only — the exact input of the weight function. */
  kindStats(repositoryId: string): Record<string, { useful: number; noise: number; principals: number; authorLabels: number }> {
    const out: Record<string, { useful: number; noise: number; principals: number; authorLabels: number }> = {};
    const seen = new Set<string>();
    for (const l of this.liveLabels(repositoryId)) {
      if (l.provenance !== "HUMAN" || l.source === "REACTION" || l.itemKind === "COMMENT") continue; // A10, §7.2.3
      if (isBotPrincipal(l.principalId)) continue; // A4
      const s = (out[l.itemKind] ??= { useful: 0, noise: 0, principals: 0, authorLabels: 0 });
      if (l.label === "USEFUL") s.useful++; else s.noise++;
      if (l.isPrAuthor) s.authorLabels++;
      const pKey = `${l.itemKind}|${l.principalId}`;
      if (!l.isPrAuthor && !seen.has(pKey)) { seen.add(pKey); s.principals++; }
    }
    return out;
  }

  /** §7.2.3: 👍/👎 on the impact comment — recorded, shown in the noise-rate display, never move per-kind weights. */
  recordReaction(repositoryId: string, analysisId: string, commentId: string, label: "USEFUL" | "NOISE", principalId: string, at = new Date().toISOString()): { ok: true; label: UsefulnessLabel } | { ok: false; error: string } {
    return this.recordLabel({ repositoryId, itemKind: "COMMENT", itemId: commentId, analysisId, label, principalId, role: "viewer", source: "REACTION", at });
  }

  // ---- mutes (§7.4, §7.5) ----
  setMute(input: {
    repositoryId: string; kind: string; scope?: MuteScope; createdBy: string; role: Role;
    expiresAt?: string; reason?: string; at?: string;
  }): { ok: true; mute: MuteRule } | { ok: false; error: string } {
    const scope: MuteScope = input.scope ?? { type: "REPOSITORY" };
    if (input.role === "viewer") return { ok: false, error: "muting needs at least the editor role (§7.4)" };
    if (scope.type === "REPOSITORY" && input.role !== "owner") return { ok: false, error: "a repository-wide mute needs the owner role (§7.4)" };
    if (SAFETY_CLASS_KINDS.includes(input.kind) && scope.type !== "REPOSITORY" && input.role !== "owner") {
      return { ok: false, error: `kind ${input.kind} is safety-class: an editor may not mute it at ${scope.type} scope; an owner may, and the count still shows (§7.5)` };
    }
    const at = input.at ?? new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.parse(at) + MUTE_DEFAULT_TTL_DAYS * 86_400_000).toISOString();
    const reason = input.reason ? redactReason(input.reason) : undefined;
    const mute: MuteRule = {
      id: "mute:" + sha(`${input.repositoryId}|${input.kind}|${scope.type}|${at}`).slice(0, 16),
      repositoryId: input.repositoryId, kind: input.kind, scope, createdBy: input.createdBy,
      createdAt: at, expiresAt, reason,
    };
    this.store.db.prepare("insert into mute_rules values (?,?,?,?,?,?,?,?,?,?,?)").run(
      mute.id, mute.repositoryId, mute.kind, scope.type, scope.type === "REPOSITORY" ? null : scope.value,
      mute.createdBy, mute.createdAt, mute.expiresAt ?? null, mute.reason ?? null, null, null);
    return { ok: true, mute };
  }

  clearMute(repositoryId: string, idOrKind: string, revokedBy: string, role: Role, at = new Date().toISOString()): { ok: true; mute: MuteRule } | { ok: false; error: string } {
    if (role === "viewer") return { ok: false, error: "unmuting needs at least the editor role (§7.4)" };
    const rows = (this.store.db.prepare("select * from mute_rules where repository_id = ? and (id = ? or kind = ?) order by created_at desc").all(repositoryId, idOrKind, idOrKind) as MuteRow[]).map(rowToMute);
    const target = rows.find((m) => !m.revokedBy && (!m.expiresAt || m.expiresAt > at));
    if (!target) return { ok: false, error: "no active mute matches" };
    this.store.db.prepare("update mute_rules set revoked_by = ?, revoked_at = ? where id = ?").run(revokedBy, at, target.id);
    return { ok: true, mute: { ...target, revokedBy, revokedAt: at } };
  }

  mutes(repositoryId: string, at = new Date().toISOString()): { active: MuteRule[]; expired: MuteRule[]; revoked: MuteRule[] } {
    const all = (this.store.db.prepare("select * from mute_rules where repository_id = ? order by created_at").all(repositoryId) as MuteRow[]).map(rowToMute);
    return {
      active: all.filter((m) => !m.revokedBy && (!m.expiresAt || m.expiresAt > at)),
      expired: all.filter((m) => !m.revokedBy && !!m.expiresAt && m.expiresAt <= at),
      revoked: all.filter((m) => !!m.revokedBy),
    };
  }

  // ---- weights (§7.3) ----
  weights(repositoryId: string): KindWeight[] {
    return (this.store.db.prepare("select * from kind_weights where repository_id = ? order by kind").all(repositoryId) as any[]).map((r) => ({
      repositoryId: r.repository_id, kind: r.kind, weight: r.weight,
      labels: { useful: r.useful, noise: r.noise, principals: r.principals },
      status: r.status as KindWeight["status"], computedFromLogHash: r.log_hash, computedAt: r.computed_at,
    }));
  }

  /** The hash of the live label set the weights were computed from — replaying the log reproduces it (F15-A1). */
  logHash(repositoryId: string): string {
    const live = this.liveLabels(repositoryId)
      .filter((l) => l.provenance === "HUMAN" && l.source !== "REACTION" && l.itemKind !== "COMMENT")
      .map((l) => ({ kind: l.itemKind, principal: l.principalId, item: l.itemId, label: l.label, at: l.at }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return sha(JSON.stringify(live));
  }

  /**
   * Rebuild the derived weights from the log (bounded: LOG_CAP rows per recompute, truncation disclosed).
   * One step of at most MAX_WEIGHT_STEP per recompute (A7), clamped to [WEIGHT_MIN, WEIGHT_MAX]; below the
   * minimums a kind returns to weight 1.0 / "default". Derived data only — safe to rebuild after a crash (§11).
   */
  recomputeWeights(repositoryId: string, opts: WeightOpts = {}): { weights: KindWeight[]; truncated: boolean; logHash: string } {
    const stats = this.kindStats(repositoryId);
    const prev = new Map(this.weights(repositoryId).map((w) => [w.kind, w]));
    const logHash = this.logHash(repositoryId);
    const at = new Date().toISOString();
    const weights: KindWeight[] = [];
    for (const kind of [...Object.keys(stats), ...prev.keys()].filter((k, i, a) => a.indexOf(k) === i).sort()) {
      const s = stats[kind] ?? { useful: 0, noise: 0, principals: 0, authorLabels: 0 };
      const target = computeKindWeight({ useful: s.useful, noise: s.noise, principals: s.principals }, opts);
      const old = prev.get(kind);
      const weight = old ? clampWeight(old.weight + Math.max(-MAX_WEIGHT_STEP, Math.min(MAX_WEIGHT_STEP, target.weight - old.weight))) : target.weight;
      const w: KindWeight = {
        repositoryId, kind, weight,
        labels: { useful: s.useful, noise: s.noise, principals: s.principals },
        status: weight === 1.0 && target.status === "default" ? "default" : target.status,
        computedFromLogHash: logHash, computedAt: at,
      };
      weights.push(w);
      this.store.db.prepare(`insert into kind_weights values (?,?,?,?,?,?,?,?,?)
        on conflict(repository_id, kind) do update set weight = excluded.weight, useful = excluded.useful, noise = excluded.noise,
        principals = excluded.principals, status = excluded.status, log_hash = excluded.log_hash, computed_at = excluded.computed_at`)
        .run(repositoryId, kind, w.weight, w.labels.useful, w.labels.noise, w.labels.principals, w.status, w.computedFromLogHash, w.computedAt);
    }
    // Kinds that dropped out of the stats entirely return to default and are removed.
    for (const [kind, old] of prev) if (!stats[kind]) this.store.db.prepare("delete from kind_weights where repository_id = ? and kind = ?").run(repositoryId, kind);
    return { weights, truncated: this.labels(repositoryId).truncated, logHash };
  }

  /** §7.7: weights return to default; the label log stays intact (A12). A reset marker is appended. */
  resetRanking(repositoryId: string, principalId: string, at = new Date().toISOString()): void {
    this.store.db.prepare("delete from kind_weights where repository_id = ?").run(repositoryId);
    this.store.db.prepare("insert into feedback_resets values (?,?,?)").run(repositoryId, principalId, at);
  }

  /** C17/getFeedbackState — the counts, weights, mutes and status the footer and share page render from. */
  state(repositoryId: string, at = new Date().toISOString()): FeedbackState {
    const { rows, truncated } = this.labels(repositoryId);
    void truncated; // the state is counts-only; truncation is disclosed by recomputeWeights (§13)
    const live = this.liveLabels(repositoryId).filter((l) => l.provenance === "HUMAN" && l.source !== "REACTION" && l.itemKind !== "COMMENT" && !isBotPrincipal(l.principalId));
    const kinds = this.kindStats(repositoryId);
    const principals = new Set(live.filter((l) => !l.isPrAuthor).map((l) => l.principalId)).size;
    const reactions = rows.filter((l) => l.source === "REACTION");
    const mutes = this.mutes(repositoryId, at);
    const resets = (this.store.db.prepare("select count(*) n from feedback_resets where repository_id = ?").get(repositoryId) as { n: number }).n;
    return {
      repositoryId,
      labels: {
        total: rows.filter((l) => l.source !== "REACTION").length,
        useful: live.filter((l) => l.label === "USEFUL").length,
        noise: live.filter((l) => l.label === "NOISE").length,
        principals,
      },
      reactions: { up: reactions.filter((l) => l.label === "USEFUL").length, down: reactions.filter((l) => l.label === "NOISE").length },
      weights: this.weights(repositoryId),
      mutes: { active: mutes.active, expired: mutes.expired.length, revoked: mutes.revoked.length },
      resets,
      kinds,
    };
  }
}

/** §10.3: free text from a command is stored only as a redacted, length-limited mute reason (F15-A11). */
export function redactReason(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").replace(/@/g, "").replace(/#(\d+)/g, "# ").trim().slice(0, REASON_MAX_CHARS).trim();
}
