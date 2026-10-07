// Release scope: what's actually in a release, frozen against a GitHub milestone.
//
// Mirrors campaigns.ts's event-sourced create / freeze / population-diff engine (F08), scaled down to one
// repository's milestone issues:
//   - freezeScope bumps a monotonic scope version; an issue seen for the first time at v1 is trusted (IN_SCOPE,
//     ASSESSED); an issue that appears at v2+ is NEEDS_ASSESSMENT, never silently folded into scope.
//   - assessScopeChange diffs two scope versions into ADDED / REMOVED / UNCHANGED, the same shape as a campaign's
//     population diff.
//   - assessItem is the human action that promotes a NEEDS_ASSESSMENT item to ASSESSED after it's reviewed.
//   - replay rebuilds the item-state projection from release_events alone, so a replay reproduces the live tables
//     (the same guarantee F08-D7 gives campaigns).
//
// The milestone read is injected (ReleaseAdapters.milestoneIssues), so this engine is testable without a real
// GitHub call; the service wires a real adapter backed by the `gh` CLI.
import { createHash, randomUUID } from "node:crypto";
import type {
  ApiError, AssessmentState, Release, ReleaseItemState, ReleaseItemView, ReleaseMilestoneRef,
  ReleaseScopeDiff, ReleaseScopeDiffEntry, ReleaseSpec, ReleaseState, ReleaseView,
} from "@cie/schema";
import type { Store } from "./store.ts";

export class ReleaseError extends Error {
  readonly api: ApiError;
  constructor(code: ApiError["code"], message: string, retryable = false) {
    super(message);
    this.name = "ReleaseError";
    this.api = { code, message, retryable };
  }
}

export interface ReleaseScopeIssue {
  number: number;
  title: string;
  state: "open" | "closed";
}

/** Everything the engine needs from the outside world. Tests inject a deterministic fake; the service wires `gh`. */
export interface ReleaseAdapters {
  /** Every issue currently in the release's milestone, as the host sees it right now. */
  milestoneIssues(milestone: ReleaseMilestoneRef): ReleaseScopeIssue[];
  /** The repository's milestones, for the wizard's picker. Throws a ReleaseError when the host cannot say. */
  listMilestones?(owner: string, repo: string): ReleaseMilestoneInfo[];
  /** One issue by number (to add an issue from outside the milestone). Throws a ReleaseError when not found. */
  issue?(owner: string, repo: string, number: number): ReleaseScopeIssue;
}

export interface ReleaseMilestoneInfo {
  number: number;
  title: string;
  state: "open" | "closed";
  openIssues: number;
  closedIssues: number;
}

/** Which issues a freeze commits to. Omitted = every milestone issue (the original behaviour). */
export interface FreezeSelection {
  /** Issue numbers committed to the release; every other milestone issue is recorded as EXCLUDED (stretch). */
  include: number[];
  /** Issues added by number from outside the milestone; they are committed to scope. */
  manual?: number[];
}

const nowIso = () => new Date().toISOString();

/** Stable JSON with sorted object keys, so hashes do not depend on insertion order. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, any>;

export class ReleaseScope {
  private store: Store;
  private adapters: ReleaseAdapters;
  private now: () => string;

  constructor(store: Store, adapters: ReleaseAdapters, now: () => string = nowIso) {
    this.store = store;
    this.adapters = adapters;
    this.now = now;
  }

  private db() { return this.store.db; }

  // ---------------------------------------------------------------- events and version fence

  private append(releaseId: string, actor: string, type: string, issueNumber: number | null, payload: unknown, idempotencyKey?: string | null) {
    if (idempotencyKey) {
      const prior = this.db().prepare("select seq from release_events where release_id = ? and idempotency_key = ?").get(releaseId, idempotencyKey) as Row | undefined;
      if (prior) return prior.seq as number;
    }
    const seq = ((this.db().prepare("select coalesce(max(seq),0) n from release_events where release_id = ?").get(releaseId) as Row).n as number) + 1;
    this.db().prepare("insert into release_events(release_id, seq, at, actor, type, issue_number, payload_json, idempotency_key) values (?,?,?,?,?,?,?,?)")
      .run(releaseId, seq, this.now(), actor, type, issueNumber, JSON.stringify(payload ?? {}), idempotencyKey ?? null);
    return seq;
  }

  private events(releaseId: string): { seq: number; at: string; actor: string; type: string; issueNumber: number | null; payload: unknown }[] {
    return (this.db().prepare("select seq, at, actor, type, issue_number, payload_json from release_events where release_id = ? order by seq").all(releaseId) as Row[])
      .map((r) => ({ seq: r.seq, at: r.at, actor: r.actor, type: r.type, issueNumber: r.issue_number, payload: JSON.parse(r.payload_json) }));
  }

  /** Rebuild the item-state projection from the event log alone. */
  replay(releaseId: string): { items: Record<number, ReleaseItemState>; releaseState: ReleaseState | null } {
    const items: Record<number, ReleaseItemState> = {};
    let releaseState: ReleaseState | null = null;
    for (const e of this.events(releaseId)) {
      if (e.type === "RELEASE_STATE") releaseState = (e.payload as any).state as ReleaseState;
      if (e.type === "ITEM_ADDED" && e.issueNumber !== null) items[e.issueNumber] = "IN_SCOPE";
      if (e.type === "ITEM_STATE" && e.issueNumber !== null) items[e.issueNumber] = (e.payload as any).state as ReleaseItemState;
    }
    return { items, releaseState };
  }

  private bump(releaseId: string): number {
    const cur = (this.db().prepare("select version from releases where release_id = ?").get(releaseId) as Row | undefined)?.version as number | undefined;
    if (cur === undefined) throw new ReleaseError("NOT_FOUND", "no such release");
    this.db().prepare("update releases set version = version + 1, updated_at = ? where release_id = ?").run(this.now(), releaseId);
    return cur + 1;
  }

  private setState(releaseId: string, state: ReleaseState, actor: string) {
    this.db().prepare("update releases set state = ?, updated_at = ? where release_id = ?").run(state, this.now(), releaseId);
    this.append(releaseId, actor, "RELEASE_STATE", null, { state });
  }

  // ---------------------------------------------------------------- loading

  private releaseRow(releaseId: string): Row | null {
    return (this.db().prepare("select * from releases where release_id = ?").get(releaseId) as Row | undefined) ?? null;
  }

  private release(releaseId: string): Release {
    const r = this.releaseRow(releaseId);
    if (!r) throw new ReleaseError("NOT_FOUND", "no such release");
    return {
      releaseId: r.release_id, tenantId: r.tenant_id, name: r.name, tag: r.tag,
      milestone: JSON.parse(r.milestone_json), state: r.state, version: r.version,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private itemRows(releaseId: string): Row[] {
    return (this.db().prepare("select * from release_items where release_id = ? order by issue_number").all(releaseId) as Row[]);
  }

  private item(releaseId: string, issueNumber: number): Row | null {
    return (this.db().prepare("select * from release_items where release_id = ? and issue_number = ?").get(releaseId, issueNumber) as Row | undefined) ?? null;
  }

  private currentScopeVersion(releaseId: string): Row | null {
    return (this.db().prepare("select * from release_scope_versions where release_id = ? order by version desc limit 1").get(releaseId) as Row | undefined) ?? null;
  }

  private toItemView(r: Row): ReleaseItemView {
    return {
      issueNumber: r.issue_number, title: r.title, issueState: r.issue_state,
      state: r.state, assessmentState: r.assessment_state, reason: r.reason ?? undefined,
    };
  }

  // ---------------------------------------------------------------- createRelease

  createRelease(actor: string, tenantId: string, spec: ReleaseSpec): Release {
    this.validateSpec(spec);
    const releaseId = `release:${randomUUID()}`;
    const at = this.now();
    this.db().prepare("insert into releases(release_id, tenant_id, name, tag, milestone_json, state, version, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(releaseId, tenantId, spec.name, spec.tag, JSON.stringify(spec.milestone), "DRAFT", 1, actor, at, at);
    this.append(releaseId, actor, "RELEASE_CREATED", null, { name: spec.name, tag: spec.tag, milestone: spec.milestone });
    return this.release(releaseId);
  }

  private validateSpec(spec: ReleaseSpec) {
    if (!spec || typeof spec.name !== "string" || !spec.name.trim()) throw new ReleaseError("INVALID_SCHEMA", "a release needs a name");
    if (typeof spec.tag !== "string" || !spec.tag.trim()) throw new ReleaseError("INVALID_SCHEMA", "a release needs a tag");
    const m = spec.milestone;
    if (!m || !m.owner || !m.repo || typeof m.number !== "number") throw new ReleaseError("INVALID_SCHEMA", "a release needs a GitHub milestone reference");
  }

  // ---------------------------------------------------------------- freezeScope

  freezeScope(releaseId: string, actor: string, expectedVersion: number, selection?: FreezeSelection): { scopeVersion: number; scopeHash: string; items: ReleaseItemView[] } {
    const r = this.release(releaseId);
    if (r.state === "CANCELLED") throw new ReleaseError("VERSION_CONFLICT", "release is cancelled");
    if (r.version !== expectedVersion) throw new ReleaseError("VERSION_CONFLICT", `release is at version ${r.version}`);
    const milestoneIssues = this.adapters.milestoneIssues(r.milestone);
    // Issues added by number earlier stay in the population on a re-freeze; new ones are looked up now.
    const manualNumbers = new Set([...this.manualIssues(releaseId), ...(selection?.manual ?? [])]);
    const inMilestone = new Set(milestoneIssues.map((i) => i.number));
    const extra: ReleaseScopeIssue[] = [];
    for (const n of manualNumbers) {
      if (inMilestone.has(n)) continue;
      const known = this.item(releaseId, n);
      if (known && !(selection?.manual ?? []).includes(n)) { extra.push({ number: n, title: known.title, state: known.issue_state }); continue; }
      extra.push(this.lookupIssue(r.milestone, n));
    }
    const issues = [...milestoneIssues, ...extra];
    if (!issues.length) throw new ReleaseError("INSUFFICIENT_EVIDENCE", "the milestone has no issues");
    const chosen = selection ? new Set([...selection.include, ...manualNumbers]) : null;
    if (chosen && ![...chosen].some((n) => issues.some((i) => i.number === n))) throw new ReleaseError("INSUFFICIENT_EVIDENCE", "choose at least one issue to commit to this release");

    const hash = sha256(canonical(issues.map((i) => i.number).sort((a, b) => a - b)));
    const prev = this.currentScopeVersion(releaseId);
    const version = prev ? (prev.version as number) + 1 : 1;
    const previousItems = new Map(this.itemRows(releaseId).map((row) => [row.issue_number as number, row]));

    this.db().prepare("insert into release_scope_versions(release_id, version, scope_hash, issue_numbers_json, frozen_at, created_by) values (?,?,?,?,?,?)")
      .run(releaseId, version, hash, JSON.stringify(issues.map((i) => i.number)), this.now(), actor);

    for (const issue of issues) {
      const prior = previousItems.get(issue.number);
      if (prior) {
        this.db().prepare("update release_items set scope_version = ?, title = ?, issue_state = ?, updated_at = ? where release_id = ? and issue_number = ?")
          .run(version, issue.title, issue.state, this.now(), releaseId, issue.number);
      } else {
        // An issue seen for the first time after freeze is not silently accepted: v1 items start ASSESSED,
        // later additions do not (mirrors F08-A2).
        const assessment: AssessmentState = version === 1 || manualNumbers.has(issue.number) ? "ASSESSED" : "NEEDS_ASSESSMENT";
        const left = chosen !== null && !chosen.has(issue.number);
        const reason = left ? "stretch — left out of scope at freeze" : manualNumbers.has(issue.number) ? "added by number" : version === 1 ? null : "added to the milestone after freeze";
        this.db().prepare(
          "insert into release_items(release_id, issue_number, scope_version, title, issue_state, state, assessment_state, reason, updated_at) values (?,?,?,?,?,?,?,?,?)",
        ).run(releaseId, issue.number, version, issue.title, issue.state, left ? "EXCLUDED" : "IN_SCOPE", left ? "ASSESSED" : assessment, reason, this.now());
        this.append(releaseId, actor, "ITEM_ADDED", issue.number, { scopeVersion: version, assessment, manual: manualNumbers.has(issue.number) });
        if (left) this.append(releaseId, actor, "ITEM_STATE", issue.number, { state: "EXCLUDED", reason });
      }
    }

    // Items that left the milestone are excluded with a reason (history preserved, not deleted).
    for (const [issueNumber, prior] of previousItems) {
      if (!issues.some((i) => i.number === issueNumber) && prior.state !== "EXCLUDED") {
        this.db().prepare("update release_items set state = ?, assessment_state = ?, reason = ?, updated_at = ? where release_id = ? and issue_number = ?")
          .run("EXCLUDED", "ASSESSED", "no longer in the milestone", this.now(), releaseId, issueNumber);
        this.append(releaseId, actor, "ITEM_STATE", issueNumber, { state: "EXCLUDED", reason: "no longer in the milestone" });
      }
    }

    this.setState(releaseId, "SCOPE_FROZEN", actor);
    this.bump(releaseId);
    this.append(releaseId, actor, "SCOPE_FROZEN", null, { version, scopeHash: hash });
    return { scopeVersion: version, scopeHash: hash, items: this.itemRows(releaseId).map((row) => this.toItemView(row)) };
  }

  // ---------------------------------------------------------------- scope diff

  assessScopeChange(releaseId: string, actor: string, fromVersion: number, toVersion: number): ReleaseScopeDiff {
    const from = this.db().prepare("select * from release_scope_versions where release_id = ? and version = ?").get(releaseId, fromVersion) as Row | undefined;
    const to = this.db().prepare("select * from release_scope_versions where release_id = ? and version = ?").get(releaseId, toVersion) as Row | undefined;
    if (!from || !to) throw new ReleaseError("NOT_FOUND", "no such scope version");
    const fromIds: number[] = JSON.parse(from.issue_numbers_json);
    const toIds: number[] = JSON.parse(to.issue_numbers_json);

    const entries: ReleaseScopeDiffEntry[] = [];
    for (const id of [...new Set([...fromIds, ...toIds])].sort((a, b) => a - b)) {
      const was = fromIds.includes(id); const is = toIds.includes(id);
      if (!was && is) entries.push({ issueNumber: id, change: "ADDED", previousVersion: fromVersion, nextVersion: toVersion, state: "NEEDS_ASSESSMENT", reason: "added after freeze; needs assessment" });
      else if (was && !is) entries.push({ issueNumber: id, change: "REMOVED", previousVersion: fromVersion, nextVersion: toVersion, state: "EXCLUDED", reason: "no longer in the milestone" });
      else entries.push({ issueNumber: id, change: "UNCHANGED", previousVersion: fromVersion, nextVersion: toVersion, state: "IN_SCOPE", reason: "unchanged" });
    }
    this.append(releaseId, actor, "SCOPE_DIFF", null, { fromVersion, toVersion, entries });
    return {
      releaseId, fromVersion, toVersion, scopeHash: to.scope_hash as string, entries,
      added: entries.filter((e) => e.change === "ADDED").map((e) => e.issueNumber),
      removed: entries.filter((e) => e.change === "REMOVED").map((e) => e.issueNumber),
    };
  }

  /** The human action that accepts an added item into scope after review. */
  assessItem(releaseId: string, actor: string, issueNumber: number): ReleaseItemView {
    const row = this.item(releaseId, issueNumber);
    if (!row) throw new ReleaseError("NOT_FOUND", "no such release item");
    this.db().prepare("update release_items set assessment_state = ?, reason = null, updated_at = ? where release_id = ? and issue_number = ?")
      .run("ASSESSED", this.now(), releaseId, issueNumber);
    this.append(releaseId, actor, "ITEM_ASSESSED", issueNumber, {});
    return this.toItemView(this.item(releaseId, issueNumber)!);
  }

  // ---------------------------------------------------------------- reading

  getRelease(releaseId: string): ReleaseView {
    const release = this.release(releaseId);
    const scopeRow = this.currentScopeVersion(releaseId);
    const items = this.itemRows(releaseId).map((row) => this.toItemView(row));
    const counts: Partial<Record<ReleaseItemState, number>> = {};
    for (const it of items) counts[it.state] = (counts[it.state] ?? 0) + 1;
    return {
      release,
      scope: scopeRow ? { version: scopeRow.version, scopeHash: scopeRow.scope_hash, frozenAt: scopeRow.frozen_at } : null,
      items,
      counts,
      needsAssessment: items.filter((i) => i.assessmentState === "NEEDS_ASSESSMENT").length,
    };
  }

  /** A read-only look at what freezeScope would do right now, without committing anything — the wizard's
   *  Scope step shows this before the human commits to Freeze. */
  previewMilestone(releaseId: string): { issues: ReleaseScopeIssue[] } {
    const r = this.release(releaseId);
    return { issues: this.adapters.milestoneIssues(r.milestone) };
  }

  /** The repository's milestones — the wizard's picker. Needs no release yet. */
  listMilestones(owner: string, repo: string): { milestones: ReleaseMilestoneInfo[] } {
    if (!this.adapters.listMilestones) throw new ReleaseError("NOT_IMPLEMENTED", "this host cannot list milestones");
    return { milestones: this.adapters.listMilestones(owner, repo) };
  }

  /** Look an issue up by number so it can be added to scope from outside the milestone. */
  lookupIssue(milestone: ReleaseMilestoneRef, number: number): ReleaseScopeIssue {
    if (!this.adapters.issue) throw new ReleaseError("NOT_IMPLEMENTED", "this host cannot look issues up");
    if (!Number.isInteger(number) || number <= 0) throw new ReleaseError("INVALID_SCHEMA", "an issue number is a positive whole number");
    return this.adapters.issue(milestone.owner, milestone.repo, number);
  }

  lookupReleaseIssue(releaseId: string, number: number): ReleaseScopeIssue {
    return this.lookupIssue(this.release(releaseId).milestone, number);
  }

  /** Issue numbers added to this release by number rather than through the milestone. */
  private manualIssues(releaseId: string): number[] {
    return this.events(releaseId).filter((e) => e.type === "ITEM_ADDED" && e.issueNumber !== null && (e.payload as any).manual === true).map((e) => e.issueNumber as number);
  }

  listReleases(tenantId: string, limit = 50): Release[] {
    return (this.db().prepare("select * from releases where tenant_id = ? order by updated_at desc limit ?").all(tenantId, limit) as Row[]).map((r) => ({
      releaseId: r.release_id, tenantId: r.tenant_id, name: r.name, tag: r.tag,
      milestone: JSON.parse(r.milestone_json), state: r.state, version: r.version,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  /** Items that are IN_SCOPE and ASSESSED — what a downstream evidence producer (e.g. the readiness ledger) may
   *  count toward the release. A NEEDS_ASSESSMENT item is excluded until a human calls assessItem. */
  inScopeIssues(releaseId: string): number[] {
    return this.itemRows(releaseId)
      .filter((r) => r.state === "IN_SCOPE" && r.assessment_state === "ASSESSED")
      .map((r) => r.issue_number as number);
  }
}
