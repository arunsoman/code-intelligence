// F08 — Coordinated multi-repository changes.
//
// A campaign is a parent record with ONE transformation and a frozen, versioned population; each child is an
// independent F07 task with its own candidate, validation, review and PR. This module owns the orchestration and the
// rules the spec insists on:
//   F08-A1  mixed PASS/FAIL stay mixed — counts per state, never one campaign health score;
//   F08-A2  adding a repository after freeze creates a new population version and needs an assessment;
//   F08-A3  a moved child base is STALE alone; siblings continue;
//   F08-A4  partial publication retries only children that are not PUBLISHED;
//   F08-A5  a required producer/consumer compatibility case that fails pauses the campaign; a mode that is not
//           required reads "not evaluated", never "compatible";
//   F08-A6  every aggregate is computed over the viewer's visible children only, and hidden repositories are never
//           counted (the count itself would reveal them).
//
// Everything is append-only event-sourced: projections derive from `campaign_events`, so a replay reproduces them
// (F08-D7). Adapters for the repository host, the isolated recipe runner, per-child validation, the joint runner and
// GitHub publication are injected, so nothing here touches a real forge or executes a real transformation by default.
import { createHash, randomUUID } from "node:crypto";
import type {
  ApiError, BatchState, BatchView, Campaign, CampaignChild, CampaignOrder, CampaignPlan, CampaignProgress,
  CampaignRole, CampaignSelector, CampaignSpec, CampaignState, CampaignTransformation, CampaignView,
  ChildPublicationResult, ChildState, ChildView, CompatCaseView, CompatibilityMode, CompatibilityState,
  PopulationDiff, PopulationDiffEntry, PauseRule, ReconcileRow,
} from "@cie/schema";
import type { Store } from "./store.ts";

export const CAMPAIGN_LIMITS = {
  populationCap: 200,          // first release: "a few dozen"; the cap is stated and enforced
  maxConcurrentDefault: 3,
  pathsPerChildCap: 50,
};

export class CampaignError extends Error {
  readonly api: ApiError;
  constructor(code: ApiError["code"], message: string, retryable = false) {
    super(message);
    this.name = "CampaignError";
    this.api = { code, message, retryable };
  }
}

// ------------------------------------------------------------------ repository host and adapters

export interface CampaignRepo {
  repositoryId: string;
  repoRoot: string;
  name: string;
  defaultBranch: string;
  baseCommit: string;
  owner?: string;
  topics?: string[];
  language?: string;
  /** Packages this repository exports (used for producer/consumer classification). */
  packages?: string[];
  /** Package names this repository requires. */
  requiresPackages?: string[];
  /** Repository ids this repository consumes (explicit cross-repository edge). */
  requiresRepositories?: string[];
  /** Exported symbols this repository references from elsewhere. */
  symbolsReferenced?: string[];
}

/** A materialised child candidate: identity (head/diff hashes), the scratch trees the validator and joint runner use. */
export interface ChildArtifact {
  repositoryId: string;
  baseCommit: string;
  headHash: string;
  diffHash: string;
  shapeHash?: string;
  files: string[];
  handle?: string;
  dir?: string;
  baseDir?: string;
  repoRoot?: string;
  tokensUsed?: number;
}

export type RecipeOutcome =
  | { ok: true; diffHash: string; files: string[]; forbiddenPaths: string[]; headHash?: string; shapeHash?: string; handle?: string; dir?: string; baseDir?: string; modelTokens?: number }
  | { ok: false; error: string };

export interface ValidationOutcome {
  state: "PASSED" | "FAILED";
  runs: number; passedRuns: number; failedRuns: number;
  reason?: string;
}

export type JointOutcome =
  | { state: "PASSED" | "FAILED"; reason?: string; runManifestId?: string; manifest?: unknown }
  | { state: "NOT_EVALUABLE"; reason: string };

export type PublicationOutcome =
  | { state: "CREATED" | "ADOPTED"; prNumber: number; prState?: string }
  | { state: "FAILED"; reason: string };

export interface JointCheckRequest {
  campaignId: string;
  caseId: string;
  producerRepository: string; consumerRepository: string;
  mode: CompatibilityMode;
  transformation: CampaignTransformation;
  producer: ChildArtifact; consumer: ChildArtifact;
}

export interface PublishRequest {
  repositoryId: string; repoRoot: string; baseCommit: string; headHash: string; diffHash: string;
  branch: string; title: string; body: string; defaultBranch: string;
  /** The isolated candidate tree; when present, the publisher commits and pushes it to the branch before opening the draft. */
  candidateDir?: string;
}

/** Everything the engine needs from the outside world. Tests inject deterministic fakes; the service wires real ones. */
export interface CampaignAdapters {
  /** Every repository the host knows about, before visibility is applied. */
  repos(): CampaignRepo[];
  /** Resolve a base commit (pinned when given, otherwise the default-branch head). */
  baseCommit(repositoryId: string, pinned?: string): string | null;
  /** Whether the transformation's selectors match anything in the repository. */
  transformationApplies(repositoryId: string, transformation: CampaignTransformation): { applies: boolean; reason: string };
  /** Run the transformation in an isolated checkout; returns a tree diff, never a write. */
  applyRecipe(repositoryId: string, baseCommit: string, transformation: CampaignTransformation): RecipeOutcome;
  /** Validate one child candidate in isolation. Absent: the child is BLOCKED with a stated reason, never "passed". */
  validateChild?(repositoryId: string, baseCommit: string, candidate: ChildArtifact): ValidationOutcome;
  /** Run a joint compatibility case. Absent or no linker: NOT_EVALUABLE, never PASS. */
  jointCheck?(request: JointCheckRequest): JointOutcome;
  /** Find-or-create the child's draft PR (idempotent by head branch). */
  publish?(request: PublishRequest): PublicationOutcome;
  /** The current GitHub PR state for a tracked child (draft | open | merged | closed), or null when unknown. */
  githubState?(repositoryId: string, prNumber: number): string | null;
  /** The connector's rate-limit state; when limited, publication pauses with the resume time. */
  rateLimit?(): { limited: boolean; resumeAt?: string };
  /** Per-repository visibility for a principal. */
  canSee?(principal: string, repo: CampaignRepo): boolean;
  /** Per-child authority to publish. */
  canPublish?(principal: string, repo: CampaignRepo): boolean;
  /** CODEOWNERS-derived owner for reviewer assignment. */
  ownerOf?(repositoryId: string): string | null;
}

/** A publication grant bound to one child's exact (base, head, diff), never a campaign-wide permission (§10.1). */
export interface PublicationGrant {
  id: string; campaignId: string; repositoryId: string; principal: string;
  baseHash: string; headHash: string; diffHash: string; expiresAt: string; revoked: boolean;
}

export interface ChildCluster {
  clusterId: string; shapeHash: string; representativeRepositoryId: string;
  members: { repositoryId: string; bindingHash: string; state: ChildState; approved: boolean; stale: boolean }[];
  note: string;
}

export interface DryRunRepositoryResult {
  repositoryId: string; applies: boolean; reason: string;
  diffHash: string | null; files: string[]; forbiddenPaths: string[];
  validation: ValidationOutcome | null;
}

export interface DryRunResult {
  campaignId: string; runId: string; createdBy: string; createdAt: string;
  populationHash: string | null; populationSize: number; repositories: DryRunRepositoryResult[];
  note: string;
}

const nowIso = () => new Date().toISOString();

/** Stable JSON with sorted object keys, so hashes do not depend on insertion order. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, any>;

// ------------------------------------------------------------------ the engine

export class Campaigns {
  private store: Store;
  private adapters: CampaignAdapters;
  private now: () => string;

  constructor(store: Store, adapters: CampaignAdapters, now: () => string = nowIso) {
    this.store = store;
    this.adapters = adapters;
    this.now = now;
  }

  private db() { return this.store.db; }

  // ---------------------------------------------------------------- events and version fence

  private append(campaignId: string, actor: string, type: string, repositoryId: string | null, payload: unknown, idempotencyKey?: string | null) {
    if (idempotencyKey) {
      const prior = this.db().prepare("select seq from campaign_events where campaign_id = ? and idempotency_key = ?").get(campaignId, idempotencyKey) as Row | undefined;
      if (prior) return prior.seq as number;
    }
    const seq = ((this.db().prepare("select coalesce(max(seq),0) n from campaign_events where campaign_id = ?").get(campaignId) as Row).n as number) + 1;
    this.db().prepare("insert into campaign_events(campaign_id, seq, at, actor, type, repository_id, payload_json, idempotency_key) values (?,?,?,?,?,?,?,?)")
      .run(campaignId, seq, this.now(), actor, type, repositoryId, JSON.stringify(payload ?? {}), idempotencyKey ?? null);
    return seq;
  }

  private events(campaignId: string): { seq: number; at: string; actor: string; type: string; repositoryId: string | null; payload: unknown }[] {
    return (this.db().prepare("select seq, at, actor, type, repository_id, payload_json from campaign_events where campaign_id = ? order by seq").all(campaignId) as Row[])
      .map((r) => ({ seq: r.seq, at: r.at, actor: r.actor, type: r.type, repositoryId: r.repository_id, payload: JSON.parse(r.payload_json) }));
  }

  /** Rebuild the child-state projection from the event log alone (F08-D7). */
  replay(campaignId: string): { children: Record<string, ChildState>; campaignState: CampaignState | null } {
    const children: Record<string, ChildState> = {};
    let campaignState: CampaignState | null = null;
    for (const e of this.events(campaignId)) {
      if (e.type === "CAMPAIGN_STATE") campaignState = (e.payload as any).state as CampaignState;
      if (e.type === "CHILD_STATE" && e.repositoryId) children[e.repositoryId] = (e.payload as any).state as ChildState;
    }
    return { children, campaignState };
  }

  private bump(campaignId: string): number {
    const cur = (this.db().prepare("select version from campaigns where campaign_id = ?").get(campaignId) as Row | undefined)?.version as number | undefined;
    if (cur === undefined) throw new CampaignError("NOT_FOUND", "no such campaign");
    this.db().prepare("update campaigns set version = version + 1, updated_at = ? where campaign_id = ?").run(this.now(), campaignId);
    return cur + 1;
  }

  private setState(campaignId: string, state: CampaignState, actor: string) {
    this.db().prepare("update campaigns set state = ?, updated_at = ? where campaign_id = ?").run(state, this.now(), campaignId);
    this.append(campaignId, actor, "CAMPAIGN_STATE", null, { state });
  }

  // ---------------------------------------------------------------- loading

  private campaignRow(campaignId: string): Row | null {
    return (this.db().prepare("select * from campaigns where campaign_id = ?").get(campaignId) as Row | undefined) ?? null;
  }

  private campaign(campaignId: string): Campaign {
    const r = this.campaignRow(campaignId);
    if (!r) throw new CampaignError("NOT_FOUND", "no such campaign");
    return {
      campaignId: r.campaign_id, tenantId: r.tenant_id, name: r.name,
      spec: JSON.parse(r.spec_json), specHash: r.spec_hash, transformationHash: r.transformation_hash,
      state: r.state, version: r.version, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private childRows(campaignId: string): Row[] {
    return (this.db().prepare("select * from campaign_children where campaign_id = ? order by repository_id").all(campaignId) as Row[]);
  }

  private child(campaignId: string, repositoryId: string): Row | null {
    return (this.db().prepare("select * from campaign_children where campaign_id = ? and repository_id = ?").get(campaignId, repositoryId) as Row | undefined) ?? null;
  }

  private currentPopulation(campaignId: string): Row | null {
    return (this.db().prepare("select * from campaign_populations where campaign_id = ? order by version desc limit 1").get(campaignId) as Row | undefined) ?? null;
  }

  // ---------------------------------------------------------------- visibility (F08-A6)

  private repoById(): Map<string, CampaignRepo> {
    return new Map(this.adapters.repos().map((r) => [r.repositoryId, r]));
  }

  private canSee(principal: string, repo: CampaignRepo): boolean {
    return this.adapters.canSee ? this.adapters.canSee(principal, repo) : true;
  }

  /** The repositories the principal may see, sorted (deterministic). This is the authorization scope of any selector. */
  visibleRepos(principal: string): CampaignRepo[] {
    return this.adapters.repos().filter((r) => this.canSee(principal, r)).sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
  }

  private visibleChildren(campaignId: string, principal: string): Row[] {
    const byId = this.repoById();
    return this.childRows(campaignId).filter((c) => {
      const repo = byId.get(c.repository_id);
      return !!repo && this.canSee(principal, repo);
    });
  }

  // ---------------------------------------------------------------- selector evaluation (WP-03)

  /** Evaluate a selector strictly inside the caller's visible set, so a population cannot be inferred from misses. */
  evaluateSelector(selector: CampaignSelector, principal: string): CampaignRepo[] {
    const visible = this.visibleRepos(principal);
    const byId = new Map(visible.map((r) => [r.repositoryId, r]));
    const selected = new Set<string>();

    if (selector.explicit) for (const id of selector.explicit) if (byId.has(id)) selected.add(id);

    if (selector.search) {
      const { query, mode } = selector.search;
      let re: RegExp | null = null;
      if (mode === "REGEX") { try { re = new RegExp(query); } catch { throw new CampaignError("INVALID_SCHEMA", "selector.search.query is not a valid regular expression"); } }
      for (const r of visible) {
        const hay = [r.name, r.repoRoot, ...(r.symbolsReferenced ?? []), ...(r.topics ?? [])].join("\n");
        const hit = mode === "REGEX" ? !!re && re.test(hay) : mode === "SYMBOL" ? (r.symbolsReferenced ?? []).some((s) => s.includes(query)) : hay.includes(query);
        if (hit) selected.add(r.repositoryId);
      }
    }

    if (selector.dependentsOf) {
      const { package: pkg, symbol } = selector.dependentsOf;
      for (const r of visible) {
        const byPackage = pkg ? (r.requiresPackages ?? []).includes(pkg) : false;
        const bySymbol = symbol ? (r.symbolsReferenced ?? []).includes(symbol) : false;
        if (byPackage || bySymbol) selected.add(r.repositoryId);
      }
    }

    if (selector.attributes) {
      for (const r of visible) {
        const ok = Object.entries(selector.attributes).every(([k, v]) => {
          if (k === "owner") return r.owner === v;
          if (k === "language") return r.language === v;
          if (k === "topic") return (r.topics ?? []).includes(String(v));
          return false;
        });
        if (ok) selected.add(r.repositoryId);
      }
    }

    return [...selected].sort().map((id) => byId.get(id)!);
  }

  private scopeHash(principal: string): string {
    return sha256(canonical(this.visibleRepos(principal).map((r) => r.repositoryId)));
  }

  private populationHash(selectorResult: string[], bases: [string, string][], principal: string): string {
    return sha256(canonical({
      selectorResult: [...selectorResult].sort(),
      bases: [...bases].sort((a, b) => a[0].localeCompare(b[0])),
      authorizationScope: this.scopeHash(principal),
    }));
  }

  // ---------------------------------------------------------------- createCampaign

  createCampaign(actor: string, tenantId: string, spec: CampaignSpec): Campaign {
    this.validateSpec(spec);
    const specHash = sha256(canonical(spec));
    const transformationHash = sha256(canonical(spec.transformation));
    const campaignId = `campaign:${randomUUID()}`;
    const at = this.now();
    this.db().prepare("insert into campaigns(campaign_id, tenant_id, name, spec_json, spec_hash, transformation_hash, state, version, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(campaignId, tenantId, spec.name, JSON.stringify(spec), specHash, transformationHash, "DRAFT", 1, actor, at, at);
    this.append(campaignId, actor, "CAMPAIGN_CREATED", null, { name: spec.name, specHash, transformationHash });
    return this.campaign(campaignId);
  }

  private validateSpec(spec: CampaignSpec) {
    if (!spec || typeof spec.name !== "string" || !spec.name.trim()) throw new CampaignError("INVALID_SCHEMA", "campaign needs a name");
    if (!spec.selector || typeof spec.selector !== "object") throw new CampaignError("INVALID_SCHEMA", "campaign needs a selector");
    const t = spec.transformation;
    if (!t || (t.kind !== "RECIPE" && t.kind !== "TASK_TEMPLATE")) throw new CampaignError("INVALID_SCHEMA", "transformation must be RECIPE or TASK_TEMPLATE");
    if (t.kind === "RECIPE" && (!t.recipeId || !t.recipeVersion)) throw new CampaignError("INVALID_SCHEMA", "a RECIPE needs recipeId and recipeVersion");
    if (!spec.batches || typeof spec.batches.canarySize !== "number" || spec.batches.canarySize < 0) throw new CampaignError("INVALID_SCHEMA", "batches.canarySize must be a non-negative number");
    if (!Array.isArray(spec.compatibility?.required)) throw new CampaignError("INVALID_SCHEMA", "compatibility.required must be a list");
    if (!spec.budgets || typeof spec.budgets.githubWrites !== "number") throw new CampaignError("INVALID_SCHEMA", "budgets.githubWrites must be a number");
  }

  // ---------------------------------------------------------------- freezePopulation (F08-A2)

  freezePopulation(campaignId: string, actor: string, expectedVersion: number): { populationVersion: number; populationHash: string; children: CampaignChild[] } {
    const c = this.campaign(campaignId);
    if (c.state === "CANCELLED") throw new CampaignError("VERSION_CONFLICT", "campaign is cancelled");
    if (c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    const selected = this.evaluateSelector(c.spec.selector, actor);
    if (!selected.length) throw new CampaignError("INSUFFICIENT_EVIDENCE", "the selector matched no repository you can see");
    if (selected.length > CAMPAIGN_LIMITS.populationCap) throw new CampaignError("RESOURCE_LIMIT", `population of ${selected.length} exceeds the ${CAMPAIGN_LIMITS.populationCap} cap`);

    const bases: [string, string][] = [];
    for (const r of selected) {
      const base = this.adapters.baseCommit(r.repositoryId) ?? r.baseCommit;
      bases.push([r.repositoryId, base]);
    }
    const hash = this.populationHash(selected.map((r) => r.repositoryId), bases, actor);
    const prev = this.currentPopulation(campaignId);
    const version = prev ? (prev.version as number) + 1 : 1;
    const previousChildren = new Map(this.childRows(campaignId).map((r) => [r.repository_id as string, r]));

    this.db().prepare("insert into campaign_populations(campaign_id, version, population_hash, selector_result_json, frozen_at, created_by) values (?,?,?,?,?,?)")
      .run(campaignId, version, hash, JSON.stringify(selected.map((r) => r.repositoryId)), this.now(), actor);

    for (let i = 0; i < selected.length; i++) {
      const r = selected[i]!;
      const base = bases[i]![1];
      const prior = previousChildren.get(r.repositoryId);
      if (prior) {
        // Existing child: keep its work; a moved base marks it STALE (independently, F08-A3) and bumps its population version.
        const baseChanged = prior.base_commit !== base;
        this.db().prepare("update campaign_children set population_version = ?, base_commit = ?, state = ?, updated_at = ? where campaign_id = ? and repository_id = ?")
          .run(version, base, baseChanged ? "STALE" : prior.state, this.now(), campaignId, r.repositoryId);
        if (baseChanged) this.append(campaignId, actor, "CHILD_STATE", r.repositoryId, { state: "STALE", reason: "base moved" });
      } else {
        // A repository added after freeze is not silently accepted: v1 children start ASSESSED, later additions do not (F08-A2).
        const assessment = version === 1 ? "ASSESSED" : "NEEDS_ASSESSMENT";
        this.db().prepare("insert into campaign_children(campaign_id, repository_id, population_version, base_commit, state, role, blocked_by_json, assessment_state, validation_json, updated_at) values (?,?,?,?,?,?,?,?,?,?)")
          .run(campaignId, r.repositoryId, version, base, "NOT_STARTED", "INDEPENDENT", "[]", assessment, JSON.stringify(null), this.now());
        this.append(campaignId, actor, "CHILD_ADDED", r.repositoryId, { populationVersion: version, base, assessment });
      }
    }

    // Repositories that left the selection are excluded with a reason (history preserved).
    for (const [repoId, prior] of previousChildren) {
      if (!selected.some((r) => r.repositoryId === repoId) && prior.state !== "EXCLUDED") {
        this.db().prepare("update campaign_children set state = ?, assessment_state = ?, updated_at = ? where campaign_id = ? and repository_id = ?")
          .run("EXCLUDED", "ASSESSED", this.now(), campaignId, repoId);
        this.append(campaignId, actor, "CHILD_STATE", repoId, { state: "EXCLUDED", reason: "no longer matches the selector" });
      }
    }

    this.setState(campaignId, "POPULATION_FROZEN", actor);
    this.bump(campaignId);
    this.append(campaignId, actor, "POPULATION_FROZEN", null, { version, populationHash: hash });
    return { populationVersion: version, populationHash: hash, children: this.childRows(campaignId).map((r) => this.toChild(r)) };
  }

  // ---------------------------------------------------------------- population diff (WP-03)

  assessPopulationChange(campaignId: string, actor: string, fromVersion: number, toVersion: number): PopulationDiff {
    const from = this.db().prepare("select * from campaign_populations where campaign_id = ? and version = ?").get(campaignId, fromVersion) as Row | undefined;
    const to = this.db().prepare("select * from campaign_populations where campaign_id = ? and version = ?").get(campaignId, toVersion) as Row | undefined;
    if (!from || !to) throw new CampaignError("NOT_FOUND", "no such population version");
    const fromIds: string[] = JSON.parse(from.selector_result_json);
    const toIds: string[] = JSON.parse(to.selector_result_json);
    const rows = this.childRows(campaignId);
    const baseOf = (id: string) => rows.find((r) => r.repository_id === id)?.base_commit as string | undefined;

    const entries: PopulationDiffEntry[] = [];
    for (const id of [...new Set([...fromIds, ...toIds])].sort()) {
      const was = fromIds.includes(id); const is = toIds.includes(id);
      if (!was && is) entries.push({ repositoryId: id, change: "ADDED", toBase: baseOf(id), previousVersion: fromVersion, nextVersion: toVersion, state: "NEEDS_ASSESSMENT", reason: "added after freeze; needs assessment" });
      else if (was && !is) entries.push({ repositoryId: id, change: "REMOVED", fromBase: baseOf(id), previousVersion: fromVersion, nextVersion: toVersion, state: "EXCLUDED", reason: "no longer matches the selector" });
      else entries.push({ repositoryId: id, change: "UNCHANGED", fromBase: baseOf(id), toBase: baseOf(id), previousVersion: fromVersion, nextVersion: toVersion, state: "ASSESSED", reason: "unchanged" });
    }
    this.append(campaignId, actor, "POPULATION_DIFF", null, { fromVersion, toVersion, entries });
    return {
      campaignId, fromVersion, toVersion, populationHash: to.population_hash as string, entries,
      added: entries.filter((e) => e.change === "ADDED").map((e) => e.repositoryId),
      removed: entries.filter((e) => e.change === "REMOVED").map((e) => e.repositoryId),
      baseChanged: entries.filter((e) => e.change === "BASE_CHANGED").map((e) => e.repositoryId),
    };
  }

  /** Accept an added child after the required checks; only then may it run (F08-A2). */
  assessChild(campaignId: string, actor: string, repositoryId: string): CampaignChild {
    const c = this.campaign(campaignId);
    const row = this.child(campaignId, repositoryId);
    if (!row) throw new CampaignError("NOT_FOUND", "no such child");
    const repo = this.repoById().get(repositoryId);
    if (!repo || !this.canSee(actor, repo)) throw new CampaignError("FORBIDDEN", "no access to that repository");
    const base = this.adapters.baseCommit(repositoryId) ?? repo.baseCommit;
    if (!base) throw new CampaignError("INSUFFICIENT_EVIDENCE", "no base commit could be bound");
    const applies = this.adapters.transformationApplies(repositoryId, c.spec.transformation);
    if (!applies.applies) {
      this.db().prepare("update campaign_children set state = ?, assessment_state = ?, updated_at = ? where campaign_id = ? and repository_id = ?").run("EXCLUDED", "ASSESSED", this.now(), campaignId, repositoryId);
      this.append(campaignId, actor, "CHILD_STATE", repositoryId, { state: "EXCLUDED", reason: applies.reason });
    } else {
      this.db().prepare("update campaign_children set assessment_state = ?, updated_at = ? where campaign_id = ? and repository_id = ?").run("ASSESSED", this.now(), campaignId, repositoryId);
      this.append(campaignId, actor, "CHILD_ASSESSED", repositoryId, {});
    }
    return this.toChild(this.child(campaignId, repositoryId)!);
  }

  // ---------------------------------------------------------------- planCampaign (WP-05)

  planCampaign(campaignId: string, actor: string, expectedVersion: number): CampaignPlan {
    const c = this.campaign(campaignId);
    if (c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    if (c.state === "DRAFT") throw new CampaignError("VERSION_CONFLICT", "freeze the population before planning");
    const pop = this.currentPopulation(campaignId);
    if (!pop) throw new CampaignError("INSUFFICIENT_EVIDENCE", "no frozen population");
    const rows = this.childRows(campaignId).filter((r) => r.state !== "EXCLUDED");
    const ids = rows.map((r) => r.repository_id as string);
    const byId = this.repoById();

    // Producer → consumer edges within the population. A repository is a producer when another member requires one of
    // its packages (or a symbol it exports); a consumer when it requires one.
    const producerEdges = new Map<string, Set<string>>(); // producer -> consumers
    const consumerEdges = new Map<string, Set<string>>(); // consumer -> producers
    for (const r of rows) {
      const repo = byId.get(r.repository_id);
      if (!repo) continue;
      for (const other of rows) {
        if (other.repository_id === r.repository_id) continue;
        const o = byId.get(other.repository_id);
        if (!o) continue;
        const requiresPkg = (o.requiresPackages ?? []).some((p) => (repo.packages ?? []).includes(p));
        const requiresRepo = (o.requiresRepositories ?? []).includes(repo.repositoryId);
        const requiresSymbol = (o.symbolsReferenced ?? []).some((s) => (repo.packages ?? []).some((p) => s.includes(p)));
        if (requiresPkg || requiresRepo || requiresSymbol) {
          if (!producerEdges.has(repo.repositoryId)) producerEdges.set(repo.repositoryId, new Set());
          producerEdges.get(repo.repositoryId)!.add(o.repositoryId);
          if (!consumerEdges.has(o.repositoryId)) consumerEdges.set(o.repositoryId, new Set());
          consumerEdges.get(o.repositoryId)!.add(repo.repositoryId);
        }
      }
    }

    const roles: Record<string, CampaignRole> = {};
    for (const id of ids) {
      const isProducer = (producerEdges.get(id)?.size ?? 0) > 0;
      const isConsumer = (consumerEdges.get(id)?.size ?? 0) > 0;
      roles[id] = isProducer && isConsumer ? "BOTH" : isProducer ? "PRODUCER" : isConsumer ? "CONSUMER" : "INDEPENDENT";
    }

    // Ordering: producers before consumers. Cycles are reported, never ordered away.
    const cycles: string[][] = [];
    const order = this.topological(ids, producerEdges, cycles);
    const layerOf = new Map(order.map((id, i) => [id, i]));

    // Batches: a canary first (smallest blast radius by dependent count), then dependency layers.
    const dependentsCount = (id: string) => producerEdges.get(id)?.size ?? 0;
    const canarySize = Math.min(c.spec.batches.canarySize, ids.length);
    const canary = [...ids].sort((a, b) => dependentsCount(a) - dependentsCount(b) || a.localeCompare(b)).slice(0, canarySize);
    const remaining = ids.filter((id) => !canary.includes(id));
    const layers = new Map<number, string[]>();
    for (const id of remaining) {
      const layer = layerOf.get(id) ?? 99;
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer)!.push(id);
    }
    const batchRows: { batchId: string; ordinal: number; kind: "CANARY" | "STANDARD"; members: string[]; dependsOn: string[] }[] = [];
    let ordinal = 0;
    let prevBatch: string | null = null;
    if (canary.length) {
      batchRows.push({ batchId: "batch-1-canary", ordinal: ordinal++, kind: "CANARY", members: canary.sort(), dependsOn: [] });
      prevBatch = "batch-1-canary";
    }
    for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
      const members = layers.get(layer)!.sort();
      const batchId = `batch-${ordinal + 1}`;
      batchRows.push({ batchId, ordinal, kind: "STANDARD", members, dependsOn: prevBatch ? [prevBatch] : [] });
      prevBatch = batchId; ordinal++;
    }

    this.db().prepare("delete from campaign_batches where campaign_id = ?").run(campaignId);
    for (const b of batchRows) {
      this.db().prepare("insert into campaign_batches(campaign_id, batch_id, ordinal, kind, members_json, depends_on_json, pause_rule_json, state) values (?,?,?,?,?,?,?,?)")
        .run(campaignId, b.batchId, b.ordinal, b.kind, JSON.stringify(b.members), JSON.stringify(b.dependsOn), JSON.stringify(c.spec.batches.pauseRules), "PENDING");
      for (const m of b.members) this.db().prepare("update campaign_children set batch_id = ?, role = ?, updated_at = ? where campaign_id = ? and repository_id = ?").run(b.batchId, roles[m] ?? "INDEPENDENT", this.now(), campaignId, m);
    }

    // Compatibility cases: one per producer→consumer edge for each mode. Only the policy's required modes are PENDING;
    // the rest are NOT_EVALUATED so the UI can say "not evaluated" instead of implying compatibility.
    this.db().prepare("delete from campaign_compat where campaign_id = ?").run(campaignId);
    const required = new Set(c.spec.compatibility.required);
    const allModes: CompatibilityMode[] = ["CANDIDATE_WITH_CANDIDATE", "CANDIDATE_WITH_BASE", "BASE_WITH_CANDIDATE"];
    let caseIdx = 0;
    for (const [producer, consumers] of [...producerEdges.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const consumer of [...consumers].sort()) {
        for (const mode of allModes) {
          const state: CompatibilityState = required.has(mode) ? "PENDING" : "NOT_EVALUATED";
          const caseId = `compat-${++caseIdx}`;
          this.db().prepare("insert into campaign_compat(campaign_id, case_id, producer_repository, consumer_repository, mode, run_manifest_id, state, reason) values (?,?,?,?,?,?,?,?)")
            .run(campaignId, caseId, producer, consumer, mode, null, state, state === "NOT_EVALUATED" ? "not required by the compatibility policy" : null);
        }
      }
    }

    this.setState(campaignId, "PLANNED", actor);
    this.bump(campaignId);
    this.append(campaignId, actor, "CAMPAIGN_PLANNED", null, { batches: batchRows.map((b) => b.batchId), cycles });
    return this.getPlan(campaignId);
  }

  private topological(ids: string[], edges: Map<string, Set<string>>, cycles: string[][]): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (stack.has(id)) { const i = path.indexOf(id); if (i >= 0) cycles.push(path.slice(i)); return; }
      if (seen.has(id)) return;
      stack.add(id);
      for (const next of [...(edges.get(id) ?? [])].sort()) visit(next, [...path, id]);
      stack.delete(id);
      seen.add(id);
      order.push(id);
    };
    for (const id of [...ids].sort()) visit(id, []);
    return order.reverse(); // producers (dependencies) first
  }

  private getPlan(campaignId: string): CampaignPlan {
    const c = this.campaign(campaignId);
    const batches = (this.db().prepare("select * from campaign_batches where campaign_id = ? order by ordinal").all(campaignId) as Row[]).map((b): BatchView => ({
      batchId: b.batch_id, ordinal: b.ordinal, kind: b.kind, state: b.state,
      members: JSON.parse(b.members_json), dependsOn: JSON.parse(b.depends_on_json), pauseRule: JSON.parse(b.pause_rule_json),
    }));
    const compatibility = (this.db().prepare("select * from campaign_compat where campaign_id = ? order by case_id").all(campaignId) as Row[]).map((r): CompatCaseView => ({
      caseId: r.case_id, producerRepository: r.producer_repository, consumerRepository: r.consumer_repository,
      mode: r.mode, state: r.state, reason: r.reason ?? undefined,
    }));
    const roles: Record<string, CampaignRole> = {};
    for (const ch of this.childRows(campaignId)) roles[ch.repository_id] = ch.role;
    const cycles = [...new Set(this.events(campaignId).filter((e) => e.type === "CAMPAIGN_PLANNED").flatMap((e) => ((e.payload as any).cycles ?? []) as string[][]))];
    const order = this.buildOrder(campaignId, batches, compatibility, cycles);
    return { campaignId, version: c.version, batches, compatibility, roles, cycles, order };
  }

  // ---------------------------------------------------------------- order and rollback (WP-10)

  private buildOrder(campaignId: string, batches: BatchView[], compatibility: CompatCaseView[], cycles: string[][]): CampaignOrder {
    const rows = this.childRows(campaignId);
    const byId = this.repoById();
    const producerOf = new Map<string, string[]>();
    for (const c of compatibility) {
      if (!producerOf.has(c.consumerRepository)) producerOf.set(c.consumerRepository, []);
      if (!producerOf.get(c.consumerRepository)!.includes(c.producerRepository)) producerOf.get(c.consumerRepository)!.push(c.producerRepository);
    }
    const mergeOrder = [];
    for (const b of batches) for (const m of b.members) {
      const ch = rows.find((r) => r.repository_id === m);
      mergeOrder.push({
        repositoryId: m, role: (ch?.role ?? "INDEPENDENT") as CampaignRole, batchId: b.batchId,
        dependsOnRepositoryIds: [...(producerOf.get(m) ?? [])].sort(),
        reason: b.kind === "CANARY" ? "canary batch: smallest blast radius ships first" : "dependency layer",
      });
    }
    const notSafeToReorder = compatibility
      .filter((c) => c.state === "FAILED" || c.state === "NOT_EVALUATED")
      .map((c) => ({ producer: c.producerRepository, consumer: c.consumerRepository, mode: c.mode, state: c.state }));
    const rollbackPlan = mergeOrder.map((m) => ({
      repositoryId: m.repositoryId,
      action: "revert is a new reviewed change; prepare a reverse campaign rather than executing an undo",
      consumersFirst: [...(producerOf.get(m.repositoryId) ?? [])].sort(),
    }));
    return {
      mergeOrder, cycles, notSafeToReorder, rollbackPlan,
      externalEffects: ["database migrations", "deployments", "feature flags — these are manual and outside the campaign"],
    };
  }

  // ---------------------------------------------------------------- advance (WP-06)

  /** A child that will not run again under this plan. A REVIEW_READY child has finished executing; it awaits review. */
  private static readonly TERMINAL: ReadonlySet<ChildState> = new Set<ChildState>(["REVIEW_READY", "PUBLISHED", "FAILED", "BLOCKED", "EXCLUDED", "CANCELLED", "CLOSED_ON_GITHUB"]);

  private usageOf(campaignId: string): { wallMs: number; modelTokens: number; githubWrites: number } {
    const r = this.db().prepare("select wall_ms, model_tokens, github_writes from campaign_usage where campaign_id = ?").get(campaignId) as Row | undefined;
    return { wallMs: r?.wall_ms ?? 0, modelTokens: r?.model_tokens ?? 0, githubWrites: r?.github_writes ?? 0 };
  }

  private addUsage(campaignId: string, delta: { wallMs?: number; modelTokens?: number; githubWrites?: number }) {
    this.db().prepare("insert into campaign_usage(campaign_id, wall_ms, model_tokens, github_writes) values (?,?,?,?) on conflict(campaign_id) do update set wall_ms = wall_ms + excluded.wall_ms, model_tokens = model_tokens + excluded.model_tokens, github_writes = github_writes + excluded.github_writes")
      .run(campaignId, delta.wallMs ?? 0, delta.modelTokens ?? 0, delta.githubWrites ?? 0);
  }

  /** Parse the materialised candidate for a child (empty until it has been executed). */
  private childArtifact(campaignId: string, repositoryId: string): ChildArtifact | null {
    const row = this.child(campaignId, repositoryId);
    if (!row) return null;
    if (row.recipe_json) {
      try { return { ...(JSON.parse(row.recipe_json) as ChildArtifact), baseCommit: row.base_commit, repoRoot: this.repoById().get(repositoryId)?.repoRoot }; } catch { /* fall through */ }
    }
    const v = row.validation_json ? JSON.parse(row.validation_json) : null;
    if (v?.diffHash) return { repositoryId, baseCommit: row.base_commit, headHash: row.head_hash ?? v.headHash ?? v.diffHash, diffHash: v.diffHash, files: [] };
    return null;
  }

  /** Advance one batch. Idempotent on (campaignId, batchId, version). Admits at most the concurrency cap per call and
   * stops admission when a budget is exhausted (BUDGET_STOPPED), never dropping a child silently. */
  advanceCampaign(campaignId: string, actor: string, expectedVersion: number, batchId: string | null, idempotencyKey?: string): CampaignProgress {
    const c = this.campaign(campaignId);
    if (c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    if (idempotencyKey) {
      const prior = this.db().prepare("select seq from campaign_events where campaign_id = ? and idempotency_key = ? and type = 'BATCH_ADVANCED'").get(campaignId, idempotencyKey) as Row | undefined;
      if (prior) return this.progress(campaignId, actor, batchId);
    }
    if (c.state === "PAUSED") throw new CampaignError("VERSION_CONFLICT", "campaign is paused; resume it first");
    if (c.state === "CANCELLED" || c.state === "COMPLETED") throw new CampaignError("VERSION_CONFLICT", `campaign is ${c.state}`);

    const batches = (this.db().prepare("select * from campaign_batches where campaign_id = ? order by ordinal").all(campaignId) as Row[]);
    if (!batches.length) throw new CampaignError("INSUFFICIENT_EVIDENCE", "plan the campaign first");
    const batch = batchId ? batches.find((b) => b.batch_id === batchId) : batches.find((b) => b.state !== "COMPLETE");
    if (!batch) throw new CampaignError("NOT_FOUND", "no such batch");
    const members: string[] = JSON.parse(batch.members_json);
    const dependsOn: string[] = JSON.parse(batch.depends_on_json);

    // Pause rules gate a batch before it starts.
    for (const dep of dependsOn) {
      const depRow = batches.find((b) => b.batch_id === dep);
      if (!depRow || depRow.state !== "COMPLETE") {
        return { campaignId, version: c.version, batchId: batch.batch_id, counts: this.counts(campaignId, actor), started: [], hiddenNote: this.hiddenNote(), paused: true, reason: `waiting for ${dep}` };
      }
      const pause = this.evaluatePauseRules(campaignId, depRow, c.spec.batches.pauseRules);
      if (pause) { this.pause(campaignId, actor, pause); return { campaignId, version: this.campaign(campaignId).version, batchId: batch.batch_id, counts: this.counts(campaignId, actor), started: [], hiddenNote: this.hiddenNote(), paused: true, reason: pause }; }
    }

    // An unassessed added child blocks the batch (F08-A2).
    const unassessed = members.filter((m) => (this.child(campaignId, m)?.assessment_state ?? "ASSESSED") === "NEEDS_ASSESSMENT");
    if (unassessed.length) return { campaignId, version: c.version, batchId: batch.batch_id, counts: this.counts(campaignId, actor), started: [], hiddenNote: this.hiddenNote(), paused: true, reason: `unassessed repository: ${unassessed.join(", ")}` };

    // Budgets are checked before admission, not after: exhaustion pauses with a stated reason and leaves the rest queued.
    const used = this.usageOf(campaignId);
    if (c.spec.budgets.modelTokens !== undefined && used.modelTokens >= c.spec.budgets.modelTokens) {
      this.addUsage(campaignId, {});
      return { campaignId, version: this.pause(campaignId, actor, "BUDGET_STOPPED: model token budget exhausted").version, batchId: batch.batch_id, counts: this.counts(campaignId, actor), started: [], hiddenNote: this.hiddenNote(), paused: true, reason: "BUDGET_STOPPED: model token budget exhausted" };
    }

    const pending = members.filter((m) => !Campaigns.TERMINAL.has((this.child(campaignId, m)?.state ?? "NOT_STARTED") as ChildState));
    const cap = Math.max(1, Math.min(c.spec.batches.maxConcurrent || CAMPAIGN_LIMITS.maxConcurrentDefault, CAMPAIGN_LIMITS.populationCap));
    const slice = pending.slice(0, cap);

    this.db().prepare("update campaign_batches set state = 'RUNNING' where campaign_id = ? and batch_id = ?").run(campaignId, batch.batch_id);
    if (c.state !== "RUNNING") this.setState(campaignId, "RUNNING", actor);

    const startedAt = Date.now();
    const started: string[] = [];
    for (const repoId of slice) {
      this.executeChild(campaignId, actor, repoId, c.spec.transformation);
      started.push(repoId);
    }
    this.addUsage(campaignId, { wallMs: Date.now() - startedAt });

    // Joint compatibility for the required modes touched by what just ran.
    if (started.length) this.runJointChecks(campaignId, actor, c.spec.transformation);

    const stillPending = members.filter((m) => !Campaigns.TERMINAL.has((this.child(campaignId, m)?.state ?? "NOT_STARTED") as ChildState));
    if (!stillPending.length) this.db().prepare("update campaign_batches set state = 'COMPLETE' where campaign_id = ? and batch_id = ?").run(campaignId, batch.batch_id);
    this.bump(campaignId);
    this.append(campaignId, actor, "BATCH_ADVANCED", null, { batchId: batch.batch_id, started, remaining: stillPending.length }, idempotencyKey ?? null);

    // Pause rules that fire on completion of this batch.
    const fresh = this.campaign(campaignId);
    const jointFail = (this.db().prepare("select count(*) n from campaign_compat where campaign_id = ? and state = 'FAILED'").get(campaignId) as Row).n as number;
    if (jointFail > 0 && c.spec.batches.pauseRules.some((p) => p.kind === "JOINT_FAILURE")) {
      this.pause(campaignId, actor, "a required joint compatibility case failed");
    }
    const allBatchesComplete = (this.db().prepare("select count(*) n from campaign_batches where campaign_id = ? and state != 'COMPLETE'").get(campaignId) as Row).n as number;
    if (allBatchesComplete === 0 && this.campaign(campaignId).state !== "PAUSED" && this.childRows(campaignId).every((r) => Campaigns.TERMINAL.has(r.state as ChildState))) this.setState(campaignId, "COMPLETED", actor);
    void fresh;
    return this.progress(campaignId, actor, batch.batch_id);
  }

  private executeChild(campaignId: string, actor: string, repositoryId: string, transformation: CampaignTransformation) {
    const row = this.child(campaignId, repositoryId);
    if (!row || ["EXCLUDED", "PUBLISHED", "CANCELLED", "CLOSED_ON_GITHUB"].includes(row.state)) return;
    if (row.assessment_state === "NEEDS_ASSESSMENT") { this.setStateChild(campaignId, actor, repositoryId, "BLOCKED", { reason: "this repository was added after freeze and has not been assessed" }); return; }
    this.setStateChild(campaignId, actor, repositoryId, "RUNNING", {});
    const applies = this.adapters.transformationApplies(repositoryId, transformation);
    if (!applies.applies) { this.setStateChild(campaignId, actor, repositoryId, "EXCLUDED", { reason: applies.reason }); return; }
    const recipe = this.adapters.applyRecipe(repositoryId, row.base_commit, transformation);
    if ("error" in recipe) { this.setStateChild(campaignId, actor, repositoryId, "FAILED", { reason: recipe.error }); return; }
    if (!recipe.files.length) { this.setStateChild(campaignId, actor, repositoryId, "EXCLUDED", { reason: "the transformation matched files but changed none" }); return; }
    if (recipe.forbiddenPaths.length) { this.setStateChild(campaignId, actor, repositoryId, "BLOCKED", { reason: `forbidden path: ${recipe.forbiddenPaths.join(", ")}` }); return; }
    const headHash = recipe.headHash ?? recipe.diffHash;
    const artifact: ChildArtifact = {
      repositoryId, baseCommit: row.base_commit, headHash, diffHash: recipe.diffHash,
      shapeHash: recipe.shapeHash, files: recipe.files, handle: recipe.handle,
      dir: recipe.dir, baseDir: recipe.baseDir, repoRoot: this.repoById().get(repositoryId)?.repoRoot, tokensUsed: recipe.modelTokens ?? 0,
    };
    this.db().prepare("update campaign_children set recipe_json = ?, head_hash = ?, author = coalesce(author, ?), tokens_used = tokens_used + ?, updated_at = ? where campaign_id = ? and repository_id = ?")
      .run(JSON.stringify(artifact), headHash, actor, recipe.modelTokens ?? 0, this.now(), campaignId, repositoryId);
    if (recipe.modelTokens) this.addUsage(campaignId, { modelTokens: recipe.modelTokens });
    if (!this.adapters.validateChild) { this.setStateChild(campaignId, actor, repositoryId, "BLOCKED", { reason: "no isolated validator is configured" }); return; }
    const v = this.adapters.validateChild(repositoryId, row.base_commit, artifact);
    this.db().prepare("update campaign_children set validation_json = ? where campaign_id = ? and repository_id = ?").run(JSON.stringify({ runs: v.runs, passed: v.passedRuns, failed: v.failedRuns, diffHash: recipe.diffHash, headHash }), campaignId, repositoryId);
    if (v.state === "PASSED") this.setStateChild(campaignId, actor, repositoryId, "REVIEW_READY", { diffHash: recipe.diffHash, ...(v.reason ? { reason: v.reason } : {}) });
    else this.setStateChild(campaignId, actor, repositoryId, "FAILED", { reason: v.reason ?? "validation failed" });
  }

  private setStateChild(campaignId: string, actor: string, repositoryId: string, state: ChildState, extra: Record<string, unknown>) {
    this.db().prepare("update campaign_children set state = ?, updated_at = ? where campaign_id = ? and repository_id = ?").run(state, this.now(), campaignId, repositoryId);
    this.append(campaignId, actor, "CHILD_STATE", repositoryId, { state, ...extra });
  }

  /** Run every PENDING joint case for the candidates that exist; an absent runner or linker is NOT_EVALUABLE, never PASS. */
  private runJointChecks(campaignId: string, actor: string, transformation: CampaignTransformation) {
    const cases = this.db().prepare("select * from campaign_compat where campaign_id = ? and state = 'PENDING'").all(campaignId) as Row[];
    for (const cs of cases) {
      if (!this.adapters.jointCheck) {
        this.db().prepare("update campaign_compat set state = 'NOT_EVALUABLE', reason = ? where campaign_id = ? and case_id = ?").run("no joint runner is configured for this ecosystem", campaignId, cs.case_id);
        continue;
      }
      const producer = this.childArtifact(campaignId, cs.producer_repository);
      const consumer = this.childArtifact(campaignId, cs.consumer_repository);
      if (!producer || !consumer || !producer.dir || !consumer.dir) {
        this.db().prepare("update campaign_compat set state = 'NOT_EVALUABLE', reason = ? where campaign_id = ? and case_id = ?").run("a candidate was not materialised; the joint state cannot be evaluated", campaignId, cs.case_id);
        continue;
      }
      const outcome = this.adapters.jointCheck({ campaignId, caseId: cs.case_id, producerRepository: cs.producer_repository, consumerRepository: cs.consumer_repository, mode: cs.mode, transformation, producer, consumer });
      if (outcome.state === "NOT_EVALUABLE") this.db().prepare("update campaign_compat set state = 'NOT_EVALUABLE', reason = ? where campaign_id = ? and case_id = ?").run(outcome.reason, campaignId, cs.case_id);
      else {
        this.db().prepare("update campaign_compat set state = ?, reason = ?, run_manifest_id = ? where campaign_id = ? and case_id = ?").run(outcome.state, outcome.reason ?? null, outcome.runManifestId ?? null, campaignId, cs.case_id);
        if (outcome.manifest && outcome.runManifestId) this.db().prepare("insert or replace into campaign_joint_runs(run_manifest_id, campaign_id, case_id, manifest_json) values (?,?,?,?)").run(outcome.runManifestId, campaignId, cs.case_id, JSON.stringify(outcome.manifest));
      }
    }
  }

  /** One joint case on demand; the state it reaches is the state shown, never a default PASS. */
  runJointCheck(campaignId: string, actor: string, caseId: string): CompatCaseView {
    const c = this.campaign(campaignId);
    const cs = this.db().prepare("select * from campaign_compat where campaign_id = ? and case_id = ?").get(campaignId, caseId) as Row | undefined;
    if (!cs) throw new CampaignError("NOT_FOUND", "no such compatibility case");
    const single = this.adapters.jointCheck;
    if (!single) {
      this.db().prepare("update campaign_compat set state = 'NOT_EVALUABLE', reason = ? where campaign_id = ? and case_id = ?").run("no joint runner is configured for this ecosystem", campaignId, caseId);
    } else {
      const producer = this.childArtifact(campaignId, cs.producer_repository);
      const consumer = this.childArtifact(campaignId, cs.consumer_repository);
      if (!producer || !consumer || !producer.dir || !consumer.dir) {
        this.db().prepare("update campaign_compat set state = 'NOT_EVALUABLE', reason = ? where campaign_id = ? and case_id = ?").run("a candidate was not materialised; the joint state cannot be evaluated", campaignId, caseId);
      } else {
        const outcome = single({ campaignId, caseId, producerRepository: cs.producer_repository, consumerRepository: cs.consumer_repository, mode: cs.mode, transformation: c.spec.transformation, producer, consumer });
        if (outcome.state === "NOT_EVALUABLE") this.db().prepare("update campaign_compat set state = 'NOT_EVALUABLE', reason = ? where campaign_id = ? and case_id = ?").run(outcome.reason, campaignId, caseId);
        else {
          this.db().prepare("update campaign_compat set state = ?, reason = ?, run_manifest_id = ? where campaign_id = ? and case_id = ?").run(outcome.state, outcome.reason ?? null, outcome.runManifestId ?? null, campaignId, caseId);
          if (outcome.manifest && outcome.runManifestId) this.db().prepare("insert or replace into campaign_joint_runs(run_manifest_id, campaign_id, case_id, manifest_json) values (?,?,?,?)").run(outcome.runManifestId, campaignId, caseId, JSON.stringify(outcome.manifest));
        }
      }
    }
    this.append(campaignId, actor, "JOINT_CHECK", null, { caseId });
    const updated = this.db().prepare("select * from campaign_compat where campaign_id = ? and case_id = ?").get(campaignId, caseId) as Row;
    return { caseId: updated.case_id, producerRepository: updated.producer_repository, consumerRepository: updated.consumer_repository, mode: updated.mode, state: updated.state, reason: updated.reason ?? undefined };
  }

  private evaluatePauseRules(campaignId: string, batch: Row, rules: PauseRule[]): string | null {
    const members: string[] = JSON.parse(batch.members_json);
    for (const rule of rules) {
      if (rule.kind === "CANARY_ALL_READY" && batch.kind === "CANARY") {
        const notReady = members.filter((m) => !["REVIEW_READY", "PUBLISHED", "EXCLUDED"].includes(this.child(campaignId, m)?.state ?? ""));
        if (notReady.length) return `canary batch is not fully ready: ${notReady.sort().join(", ")}`;
      }
      if (rule.kind === "FAILURE_RATE" && batch.kind !== "CANARY") {
        const failed = members.filter((m) => this.child(campaignId, m)?.state === "FAILED").length;
        const threshold = rule.threshold ?? 0.1;
        if (members.length && failed / members.length > threshold) return `${failed}/${members.length} of batch ${batch.batch_id} failed (over ${Math.round(threshold * 100)} %)`;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- pause / resume / cancel (WP-05/06)

  pause(campaignId: string, actor: string, reason: string): Campaign {
    this.setState(campaignId, "PAUSED", actor);
    this.append(campaignId, actor, "CAMPAIGN_PAUSED", null, { reason });
    this.bump(campaignId);
    return this.campaign(campaignId);
  }

  resume(campaignId: string, actor: string, expectedVersion: number): Campaign {
    const c = this.campaign(campaignId);
    if (c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    if (c.state !== "PAUSED") throw new CampaignError("VERSION_CONFLICT", "campaign is not paused");
    this.setState(campaignId, "RUNNING", actor);
    this.append(campaignId, actor, "CAMPAIGN_RESUMED", null, {});
    this.bump(campaignId);
    return this.campaign(campaignId);
  }

  /** Cancel: queued children stop; already published draft PRs are NOT closed (closing is an outward action with its own grant). */
  cancel(campaignId: string, actor: string, expectedVersion: number, reason: string): Campaign {
    const c = this.campaign(campaignId);
    if (c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    for (const ch of this.childRows(campaignId)) {
      if (["NOT_STARTED", "PLANNED", "RUNNING"].includes(ch.state)) this.setStateChild(campaignId, actor, ch.repository_id, "CANCELLED", { reason });
    }
    this.setState(campaignId, "CANCELLED", actor);
    this.append(campaignId, actor, "CAMPAIGN_CANCELLED", null, { reason });
    this.bump(campaignId);
    return this.campaign(campaignId);
  }

  // ---------------------------------------------------------------- review and exceptions (WP-08)

  assignChildReviewers(campaignId: string, actor: string, repositoryId: string, principals: string[], role = "reviewer", source = "MANUAL") {
    for (const p of principals) this.db().prepare("insert or replace into campaign_reviewers(campaign_id, repository_id, principal, role, source) values (?,?,?,?,?)").run(campaignId, repositoryId, p, role, source);
    this.append(campaignId, actor, "REVIEWERS_ASSIGNED", repositoryId, { principals, role, source });
  }

  /** Per-child exception; never campaign-wide by default. */
  recordChildException(campaignId: string, actor: string, repositoryId: string, scope: string, rationale: string, approver: string | null, expiresAt: string | null) {
    const id = `exc:${randomUUID()}`;
    this.db().prepare("insert into campaign_exceptions(id, campaign_id, repository_id, scope, rationale, actor, approver, created_at, expires_at) values (?,?,?,?,?,?,?,?,?)")
      .run(id, campaignId, repositoryId, scope, rationale, actor, approver, this.now(), expiresAt);
    this.append(campaignId, actor, "CHILD_EXCEPTION", repositoryId, { id, scope, rationale, expiresAt });
    return id;
  }

  /** The reviewer list for a child: CODEOWNERS where available, otherwise the stated default owner group. */
  reviewersOf(campaignId: string, repositoryId: string): { principal: string; role: string; source: string }[] {
    const rows = this.db().prepare("select principal, role, source from campaign_reviewers where campaign_id = ? and repository_id = ? order by principal").all(campaignId, repositoryId) as Row[];
    if (rows.length) return rows.map((r) => ({ principal: r.principal, role: r.role, source: r.source }));
    const owner = this.adapters.ownerOf?.(repositoryId) ?? null;
    return [{ principal: owner ?? "default-owner-group", role: "reviewer", source: owner ? "CODEOWNERS" : "DEFAULT" }];
  }

  // ---------------------------------------------------------------- publication and reconcile (WP-09)

  /** The child's binding hash: identity of the exact candidate a reviewer or a grant is bound to. It names the child,
   * so two children with textually identical diffs still have distinct bindings (F08-D1). */
  private bindingHash(art: ChildArtifact): string { return sha256(canonical({ repositoryId: art.repositoryId, baseCommit: art.baseCommit, headHash: art.headHash, diffHash: art.diffHash })); }

  /** Per-child publication grant bound to the exact (base, head, diff). Never campaign-wide (§10.1). */
  issuePublicationGrant(campaignId: string, actor: string, repositoryId: string, ttlMs = 6 * 3600_000): PublicationGrant {
    this.campaign(campaignId);
    const repo = this.repoById().get(repositoryId);
    if (!repo) throw new CampaignError("NOT_FOUND", "no such repository");
    if (this.adapters.canPublish && !this.adapters.canPublish(actor, repo)) throw new CampaignError("FORBIDDEN", "you have no publish authority for this repository");
    const art = this.childArtifact(campaignId, repositoryId);
    if (!art) throw new CampaignError("INSUFFICIENT_EVIDENCE", "the child has no materialised candidate to bind a grant to");
    const id = `grant:${randomUUID()}`;
    const expiresAt = new Date(Date.parse(this.now()) + ttlMs).toISOString();
    const grant: PublicationGrant = { id, campaignId, repositoryId, principal: actor, baseHash: art.baseCommit, headHash: art.headHash, diffHash: art.diffHash, expiresAt, revoked: false };
    this.db().prepare("insert into campaign_publication_grants(id, campaign_id, repository_id, principal, base_hash, head_hash, diff_hash, expires_at, revoked, created_at) values (?,?,?,?,?,?,?,?,0,?)")
      .run(id, campaignId, repositoryId, actor, art.baseCommit, art.headHash, art.diffHash, expiresAt, this.now());
    this.append(campaignId, actor, "GRANT_ISSUED", repositoryId, { id, baseHash: art.baseCommit, headHash: art.headHash, diffHash: art.diffHash, expiresAt });
    return grant;
  }

  revokePublicationGrant(campaignId: string, actor: string, grantId: string) {
    this.db().prepare("update campaign_publication_grants set revoked = 1 where id = ?").run(grantId);
    this.append(campaignId, actor, "GRANT_REVOKED", null, { grantId });
  }

  private activeGrant(campaignId: string, repositoryId: string, principal: string, art: ChildArtifact): PublicationGrant | null {
    const r = this.db().prepare("select * from campaign_publication_grants where campaign_id = ? and repository_id = ? and principal = ? and base_hash = ? and head_hash = ? and diff_hash = ? and revoked = 0 order by created_at desc limit 1")
      .get(campaignId, repositoryId, principal, art.baseCommit, art.headHash, art.diffHash) as Row | undefined;
    if (!r) return null;
    if ((r.expires_at as string) <= this.now()) return null;
    return { id: r.id, campaignId, repositoryId, principal, baseHash: r.base_hash, headHash: r.head_hash, diffHash: r.diff_hash, expiresAt: r.expires_at, revoked: false };
  }

  /** The PR body: campaign identity, the child's position, the transformation hash and only the visible siblings (§7.7). */
  private campaignPrBody(c: Campaign, repoId: string, role: CampaignRole, batchId: string | undefined, siblings: { repositoryId: string; prNumber?: number }[]): string {
    const links = siblings.filter((s) => s.repositoryId !== repoId);
    return [
      "## Campaign",
      `${c.name} (\`${c.campaignId}\`)`,
      `Position: ${role}${batchId ? ` · batch ${batchId}` : ""} · transformation \`${c.transformationHash.slice(0, 12)}\``,
      "",
      "## Sibling children you can see",
      links.length ? links.map((s) => `- \`${s.repositoryId}\`${s.prNumber ? ` — #${s.prNumber}` : ""}`).join("\n") : "- none are visible to you",
      "",
      "## Draft",
      "This is a draft. CIE does not merge or deploy anything; review this child independently of the others.",
    ].join("\n");
  }

  publishCampaignChildren(campaignId: string, actor: string, batchId: string | null, repositoryIds: string[] | null, idempotencyKey?: string): { results: ChildPublicationResult[] } {
    const c = this.campaign(campaignId);
    if (c.state === "CANCELLED") throw new CampaignError("VERSION_CONFLICT", "campaign is cancelled");
    const targets = (repositoryIds ?? (batchId ? (JSON.parse((this.db().prepare("select members_json from campaign_batches where campaign_id = ? and batch_id = ?").get(campaignId, batchId) as Row | undefined)?.members_json ?? "[]")) : this.childRows(campaignId).map((r) => r.repository_id))) as string[];
    const byId = this.repoById();
    const results: ChildPublicationResult[] = [];

    // A campaign-wide limiter reads the connector state; RATE_LIMITED pauses with its resume time and does not drop a child.
    const rate = this.adapters.rateLimit?.();
    if (rate?.limited) {
      this.pause(campaignId, actor, `RATE_LIMITED: github rate limit; resumes ${rate.resumeAt ?? "later"}`);
      return { results: [...targets].sort().map((repoId) => ({ repositoryId: repoId, action: "SKIPPED" as const, state: (this.child(campaignId, repoId)?.state ?? "NOT_STARTED") as ChildState, reason: `rate limited; resumes ${rate.resumeAt ?? "later"}` })) };
    }

    const usage = this.usageOf(campaignId);
    let writes = usage.githubWrites;
    for (const repoId of [...targets].sort()) {
      const row = this.child(campaignId, repoId);
      const repo = byId.get(repoId);
      if (!row || !repo) { results.push({ repositoryId: repoId, action: "SKIPPED", state: "EXCLUDED", reason: "no such child" }); continue; }
      if (row.state === "PUBLISHED") { results.push({ repositoryId: repoId, action: "SKIPPED", state: "PUBLISHED", prNumber: row.pr_number ?? undefined, reason: "already published" }); continue; }
      if (row.state !== "REVIEW_READY") { results.push({ repositoryId: repoId, action: "SKIPPED", state: row.state, reason: `child is ${row.state}, not REVIEW_READY` }); continue; }
      if (this.adapters.canPublish && !this.adapters.canPublish(actor, repo)) { results.push({ repositoryId: repoId, action: "FAILED", state: "BLOCKED", reason: "no publish authority for this repository" }); continue; }
      if (writes >= c.spec.budgets.githubWrites) { this.pause(campaignId, actor, "BUDGET_STOPPED: github write budget exhausted"); results.push({ repositoryId: repoId, action: "FAILED", state: "BLOCKED", reason: "github write budget exhausted" }); continue; }
      if (!this.adapters.publish) { results.push({ repositoryId: repoId, action: "FAILED", state: "BLOCKED", reason: "no publisher is configured" }); continue; }
      const art = this.childArtifact(campaignId, repoId);
      if (!art) { results.push({ repositoryId: repoId, action: "FAILED", state: "BLOCKED", reason: "the child has no materialised candidate" }); continue; }
      const grant = this.activeGrant(campaignId, repoId, actor, art);
      if (!grant) { results.push({ repositoryId: repoId, action: "FAILED", state: "BLOCKED", reason: "no publication grant bound to this child's base, head and diff" }); continue; }

      const branch = this.branchName(campaignId, repoId);
      const pub = this.adapters.publish({ repositoryId: repoId, repoRoot: repo.repoRoot, baseCommit: row.base_commit, headHash: art.headHash, diffHash: art.diffHash, branch, title: `${c.name}: ${repoId}`, body: this.campaignPrBody(c, repoId, row.role as CampaignRole, row.batch_id ?? undefined, this.childRows(campaignId).filter((r) => this.canSee(actor, byId.get(r.repository_id) ?? repo)).map((r) => ({ repositoryId: r.repository_id as string, prNumber: r.pr_number ?? undefined }))), defaultBranch: repo.defaultBranch, candidateDir: art.dir });
      if ("prNumber" in pub) {
        this.db().prepare("update campaign_children set state = 'PUBLISHED', publication_id = ?, pr_number = ?, pr_state = ?, updated_at = ? where campaign_id = ? and repository_id = ?")
          .run(`pr:${pub.prNumber}`, pub.prNumber, pub.prState ?? "draft", this.now(), campaignId, repoId);
        this.append(campaignId, actor, "CHILD_PUBLISHED", repoId, { prNumber: pub.prNumber, action: pub.state }, idempotencyKey ? `${idempotencyKey}:${repoId}` : null);
        writes++;
        results.push({ repositoryId: repoId, action: pub.state, state: "PUBLISHED", prNumber: pub.prNumber });
      } else {
        this.append(campaignId, actor, "CHILD_STATE", repoId, { state: row.state, publishFailed: pub.reason });
        results.push({ repositoryId: repoId, action: "FAILED", state: row.state as ChildState, reason: pub.reason });
      }
    }
    if (writes > usage.githubWrites) this.addUsage(campaignId, { githubWrites: writes - usage.githubWrites });
    this.bump(campaignId);
    return { results };
  }

  /** Compare recorded publication with the forge's actual state; the retry acts only on children that are not PUBLISHED. */
  reconcileCampaign(campaignId: string, actor: string): { children: ReconcileRow[] } {
    const byId = this.repoById();
    const rows: ReconcileRow[] = [];
    for (const ch of this.childRows(campaignId)) {
      const repo = byId.get(ch.repository_id);
      if (repo && !this.canSee(actor, repo)) continue;
      const recorded = ch.state as ChildState;
      const github = ch.pr_number && this.adapters.githubState ? (this.adapters.githubState(ch.repository_id, ch.pr_number) ?? "unknown") : (ch.pr_number ? (ch.pr_state ?? "unknown") : "none");
      let action: ReconcileRow["action"] = "NONE";
      if (recorded === "PUBLISHED" && github === "closed") action = "NONE"; // CIE does not reopen
      else if (recorded === "PUBLISHED" && (github === "none" || github === "unknown")) action = "NONE";
      else if (recorded !== "PUBLISHED" && github !== "none" && github !== "unknown") action = "ADOPT";
      else if (recorded === "STALE") action = "STALE";
      else if (recorded === "REVIEW_READY" || recorded === "FAILED") action = "RETRY";
      rows.push({ repositoryId: ch.repository_id, recorded, github, action });
    }
    this.append(campaignId, actor, "CAMPAIGN_RECONCILED", null, { rows });
    return { children: rows };
  }

  private branchName(campaignId: string, repositoryId: string): string {
    const short = createHash("sha256").update(campaignId).digest("hex").slice(0, 8);
    return `cie/campaign-${short}-${repositoryId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  }

  // ---------------------------------------------------------------- review: per-child approvals and clustering (WP-08)

  private approvalOf(campaignId: string, repositoryId: string): Row | undefined {
    return this.db().prepare("select * from campaign_approvals where campaign_id = ? and repository_id = ?").get(campaignId, repositoryId) as Row | undefined;
  }

  /** Approve ONE child. The second-approver rule applies per child, and identical diffs do not share an approval (F08-D2). */
  approveChild(campaignId: string, actor: string, repositoryId: string, explanation: string, clusterId?: string | null): { repositoryId: string; bindingHash: string; approved: true } {
    const c = this.campaign(campaignId);
    const row = this.child(campaignId, repositoryId);
    if (!row) throw new CampaignError("NOT_FOUND", "no such child");
    if (!explanation?.trim()) throw new CampaignError("INVALID_SCHEMA", "say why you approve");
    if (row.state !== "REVIEW_READY") throw new CampaignError("FORBIDDEN", `a child that is ${row.state} cannot be approved`);
    const repo = this.repoById().get(repositoryId);
    if (repo && !this.canSee(actor, repo)) throw new CampaignError("FORBIDDEN", "you cannot see this child's repository");
    const author = (row.author as string | null) ?? c.createdBy;
    if (actor === author) throw new CampaignError("FORBIDDEN", "the person who produced a child cannot approve it");
    if (this.adapters.baseCommit && (this.adapters.baseCommit(repositoryId) ?? row.base_commit) !== row.base_commit) throw new CampaignError("STALE_REVISION", "the child's base moved; re-plan it before approving");
    const art = this.childArtifact(campaignId, repositoryId);
    if (!art) throw new CampaignError("INSUFFICIENT_EVIDENCE", "the child has no materialised candidate");
    const binding = this.bindingHash(art);
    this.db().prepare("insert or replace into campaign_approvals(campaign_id, repository_id, principal, version, binding_hash, explanation, cluster_id, created_at) values (?,?,?,?,?,?,?,?)")
      .run(campaignId, repositoryId, actor, c.version, binding, explanation.trim().slice(0, 500), clusterId ?? null, this.now());
    this.append(campaignId, actor, "CHILD_APPROVED", repositoryId, { bindingHash: binding, clusterId: clusterId ?? null });
    return { repositoryId, bindingHash: binding, approved: true };
  }

  /** Cluster visible children by normalised diff shape so a reviewer can look at a representative — never an "approve all". */
  clusterChildren(campaignId: string, principal: string): { clusters: ChildCluster[]; unclustered: number } {
    const groups = new Map<string, Row[]>();
    let unclustered = 0;
    for (const ch of this.visibleChildren(campaignId, principal)) {
      const art = this.childArtifact(campaignId, ch.repository_id);
      if (!art?.shapeHash) { unclustered++; continue; }
      groups.set(art.shapeHash, [...(groups.get(art.shapeHash) ?? []), ch]);
    }
    const clusters: ChildCluster[] = [...groups.entries()].map(([shapeHash, rows]) => {
      const sorted = [...rows].sort((a, b) => (a.repository_id as string).localeCompare(b.repository_id as string));
      return {
        clusterId: `cluster-${sha256(shapeHash).slice(0, 10)}`,
        shapeHash, representativeRepositoryId: sorted[0]!.repository_id as string,
        members: sorted.map((ch) => { const art = this.childArtifact(campaignId, ch.repository_id)!; return { repositoryId: ch.repository_id as string, bindingHash: this.bindingHash(art), state: ch.state as ChildState, approved: !!this.approvalOf(campaignId, ch.repository_id), stale: false }; }),
        note: "A cluster is a review aid only. Approving one child never approves another; open the child or confirm the cluster view for it, and each approval is recorded against that child's own binding hash.",
      };
    }).sort((a, b) => a.clusterId.localeCompare(b.clusterId));
    return { clusters, unclustered };
  }

  /** Confirm that the viewer looked at a cluster membership for one child; recorded, but not an approval. */
  confirmCluster(campaignId: string, actor: string, repositoryId: string, clusterId: string, expectedBindingHash: string): { repositoryId: string; clusterId: string; bindingHash: string; confirmed: true } {
    const art = this.childArtifact(campaignId, repositoryId);
    if (!art) throw new CampaignError("NOT_FOUND", "no materialised candidate for that child");
    const binding = this.bindingHash(art);
    if (expectedBindingHash && expectedBindingHash !== binding) throw new CampaignError("STALE_REVISION", "the child's binding hash changed since the cluster was computed");
    this.append(campaignId, actor, "CLUSTER_CONFIRMED", repositoryId, { clusterId, bindingHash: binding });
    return { repositoryId, clusterId, bindingHash: binding, confirmed: true };
  }

  // ---------------------------------------------------------------- dry run (WP-12)

  /** Run the transformation across the population with no branch and no pull request; converting it needs a new freeze. */
  runDryRun(campaignId: string, actor: string, expectedVersion?: number): DryRunResult {
    const c = this.campaign(campaignId);
    if (expectedVersion !== undefined && c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    const selected = this.evaluateSelector(c.spec.selector, actor).slice(0, CAMPAIGN_LIMITS.populationCap);
    const repositories: DryRunRepositoryResult[] = [];
    for (const r of selected) {
      const applies = this.adapters.transformationApplies(r.repositoryId, c.spec.transformation);
      if (!applies.applies) { repositories.push({ repositoryId: r.repositoryId, applies: false, reason: applies.reason, diffHash: null, files: [], forbiddenPaths: [], validation: null }); continue; }
      const base = this.adapters.baseCommit(r.repositoryId) ?? r.baseCommit;
      const recipe = this.adapters.applyRecipe(r.repositoryId, base, c.spec.transformation);
      if ("error" in recipe) { repositories.push({ repositoryId: r.repositoryId, applies: true, reason: recipe.error, diffHash: null, files: [], forbiddenPaths: [], validation: null }); continue; }
      const artifact: ChildArtifact = { repositoryId: r.repositoryId, baseCommit: base, headHash: recipe.headHash ?? recipe.diffHash, diffHash: recipe.diffHash, shapeHash: recipe.shapeHash, files: recipe.files, handle: recipe.handle, dir: recipe.dir, baseDir: recipe.baseDir, repoRoot: r.repoRoot };
      const validation = recipe.files.length && !recipe.forbiddenPaths.length && this.adapters.validateChild ? this.adapters.validateChild(r.repositoryId, base, artifact) : null;
      repositories.push({ repositoryId: r.repositoryId, applies: true, reason: "", diffHash: recipe.diffHash, files: recipe.files, forbiddenPaths: recipe.forbiddenPaths, validation });
    }
    const pop = this.currentPopulation(campaignId);
    const result: DryRunResult = { campaignId, runId: `dry:${randomUUID()}`, createdBy: actor, createdAt: this.now(), populationHash: pop?.population_hash ?? null, populationSize: selected.length, repositories, note: "Dry run: no branch and no pull request was created. Converting it to a real campaign requires a new frozen population." };
    this.db().prepare("insert into campaign_dry_runs(run_id, campaign_id, created_by, created_at, result_json) values (?,?,?,?,?)").run(result.runId, campaignId, actor, result.createdAt, JSON.stringify(result));
    this.append(campaignId, actor, "DRY_RUN", null, { runId: result.runId, repositories: repositories.length });
    return result;
  }

  getDryRun(campaignId: string, actor: string, runId?: string): DryRunResult | null {
    this.campaign(campaignId);
    const row = (runId
      ? this.db().prepare("select result_json from campaign_dry_runs where campaign_id = ? and run_id = ?").get(campaignId, runId)
      : this.db().prepare("select result_json from campaign_dry_runs where campaign_id = ? order by created_at desc limit 1").get(campaignId)) as Row | undefined;
    if (!row) return null;
    void actor;
    return JSON.parse(row.result_json) as DryRunResult;
  }

  // ---------------------------------------------------------------- transformation drift (F08-D9)

  /** Changing the recipe version changes the transformation hash and re-assessment requirement; validated children are never carried silently. */
  updateTransformation(campaignId: string, actor: string, expectedVersion: number, transformation: CampaignTransformation): Campaign {
    const c = this.campaign(campaignId);
    if (c.version !== expectedVersion) throw new CampaignError("VERSION_CONFLICT", `campaign is at version ${c.version}`);
    this.validateSpec({ ...c.spec, transformation });
    const transformationHash = sha256(canonical(transformation));
    const spec = { ...c.spec, transformation };
    this.db().prepare("update campaigns set spec_json = ?, transformation_hash = ?, updated_at = ? where campaign_id = ?").run(JSON.stringify(spec), transformationHash, this.now(), campaignId);
    for (const ch of this.childRows(campaignId)) {
      if (!ch.recipe_json) continue;
      const nextState = ["REVIEW_READY", "FAILED", "BLOCKED"].includes(ch.state as string) ? "PLANNED" : ch.state;
      this.db().prepare("update campaign_children set assessment_state = 'NEEDS_ASSESSMENT', state = ?, updated_at = ? where campaign_id = ? and repository_id = ?").run(nextState, this.now(), campaignId, ch.repository_id);
      this.append(campaignId, actor, "CHILD_STATE", ch.repository_id, { state: nextState, reason: "the transformation changed; this child must be re-assessed" });
    }
    this.append(campaignId, actor, "TRANSFORMATION_CHANGED", null, { transformationHash });
    this.bump(campaignId);
    return this.campaign(campaignId);
  }

  // ---------------------------------------------------------------- views (F08-A6)

  /** Campaigns the principal can see at all. A campaign with no visible child is omitted (a standard "not found"). */
  listCampaigns(principal: string, limit = 50): { campaignId: string; name: string; state: CampaignState; transformationHash: string; populationVersion: number | null; counts: Partial<Record<ChildState, number>>; visibleChildren: number }[] {
    const rows = this.db().prepare("select * from campaigns order by updated_at desc limit ?").all(limit) as Row[];
    const out: { campaignId: string; name: string; state: CampaignState; transformationHash: string; populationVersion: number | null; counts: Partial<Record<ChildState, number>>; visibleChildren: number }[] = [];
    for (const r of rows) {
      const visible = this.visibleChildren(r.campaign_id, principal);
      if (!visible.length) continue;
      const pop = this.currentPopulation(r.campaign_id);
      out.push({ campaignId: r.campaign_id, name: r.name, state: r.state as CampaignState, transformationHash: r.transformation_hash, populationVersion: pop ? (pop.version as number) : null, counts: this.counts(r.campaign_id, principal), visibleChildren: visible.length });
    }
    return out;
  }

  private hiddenNote(): string { return "You can see the repositories you have access to."; }

  private counts(campaignId: string, principal: string): Partial<Record<ChildState, number>> {
    const out: Partial<Record<ChildState, number>> = {};
    for (const ch of this.visibleChildren(campaignId, principal)) out[ch.state as ChildState] = (out[ch.state as ChildState] ?? 0) + 1;
    return out;
  }

  private progress(campaignId: string, principal: string, batchId: string | null): CampaignProgress {
    const visible = this.visibleChildren(campaignId, principal);
    const terminal: ChildState[] = ["PUBLISHED", "EXCLUDED", "FAILED", "BLOCKED", "CLOSED_ON_GITHUB", "CANCELLED"];
    const completed = visible.filter((c) => terminal.includes(c.state)).length;
    return {
      campaignId, version: this.campaign(campaignId).version, batchId,
      counts: this.counts(campaignId, principal),
      started: visible.filter((c) => c.state === "RUNNING").map((c) => c.repository_id as string),
      hiddenNote: this.hiddenNote(),
      paused: this.campaign(campaignId).state === "PAUSED",
      totalVisible: visible.length,
      completedVisible: completed,
    } as CampaignProgress & { totalVisible: number; completedVisible: number };
  }

  private toChild(r: Row): CampaignChild {
    return {
      campaignId: r.campaign_id, repositoryId: r.repository_id, populationVersion: r.population_version,
      baseCommit: r.base_commit, taskId: r.task_id ?? undefined, batchId: r.batch_id ?? undefined,
      state: r.state, role: r.role, blockedBy: JSON.parse(r.blocked_by_json ?? "[]"),
      assessmentState: r.assessment_state, publicationId: r.publication_id ?? undefined,
      prNumber: r.pr_number ?? undefined, prState: r.pr_state ?? undefined,
      validation: r.validation_json ? JSON.parse(r.validation_json) : undefined, updatedAt: r.updated_at,
    };
  }

  private toChildView(ch: Row, principal: string): ChildView {
    const exceptions = this.db().prepare("select count(*) n from campaign_exceptions where campaign_id = ? and repository_id = ?").get(ch.campaign_id, ch.repository_id) as Row;
    const c = this.campaign(ch.campaign_id);
    const stale = !!this.adapters.baseCommit && (this.adapters.baseCommit(ch.repository_id) ?? ch.base_commit) !== ch.base_commit;
    const lastEvent = this.db().prepare("select payload_json from campaign_events where campaign_id = ? and repository_id = ? and type = 'CHILD_STATE' order by seq desc limit 1").get(ch.campaign_id, ch.repository_id) as Row | undefined;
    const reason = lastEvent ? ((JSON.parse(lastEvent.payload_json) as { reason?: string }).reason) : undefined;
    const art = this.childArtifact(ch.campaign_id, ch.repository_id);
    void c;
    return {
      repositoryId: ch.repository_id, role: ch.role, state: stale && ch.state !== "PUBLISHED" && ch.state !== "EXCLUDED" ? "STALE" : ch.state,
      assessmentState: ch.assessment_state, batchId: ch.batch_id ?? null, baseCommit: ch.base_commit,
      validation: ch.validation_json ? JSON.parse(ch.validation_json) : null,
      pr: ch.pr_number ? { number: ch.pr_number, state: ch.pr_state ?? "draft" } : null,
      gate: null,
      stale: stale && ch.state !== "PUBLISHED" && ch.state !== "EXCLUDED",
      exception: (exceptions.n as number) > 0,
      reason,
      headHash: art?.headHash,
      bindingHash: art ? this.bindingHash(art) : undefined,
      shapeHash: art?.shapeHash,
      approved: !!this.approvalOf(ch.campaign_id, ch.repository_id),
      author: ch.author ?? undefined,
      tokensUsed: ch.tokens_used ?? 0,
    };
  }

  getCampaign(campaignId: string, principal: string): CampaignView {
    const c = this.campaign(campaignId);
    const pop = this.currentPopulation(campaignId);
    const visible = this.visibleChildren(campaignId, principal);
    const children = visible.map((ch) => this.toChildView(ch, principal));
    const batchSizes: Record<string, number> = {};
    for (const ch of visible) if (ch.batch_id) batchSizes[ch.batch_id] = (batchSizes[ch.batch_id] ?? 0) + 1;
    const terminal: ChildState[] = ["PUBLISHED", "EXCLUDED", "FAILED", "BLOCKED", "CLOSED_ON_GITHUB", "CANCELLED"];
    const completed = children.filter((ch) => terminal.includes(ch.state)).length;
    const plan = c.state === "DRAFT" || c.state === "POPULATION_FROZEN" ? null : (() => { try { return this.getCampaignPlan(campaignId, principal); } catch { return null; } })();
    // The immutable spec may name repositories the viewer cannot see; the viewer-scoped copy never does (F08-A6).
    const visibleIds = new Set(visible.map((ch) => ch.repository_id as string));
    const campaignView: Campaign = { ...c, spec: { ...c.spec, selector: { ...c.spec.selector, explicit: (c.spec.selector.explicit ?? []).filter((id) => visibleIds.has(id)) } } };
    return {
      campaign: campaignView,
      population: pop ? { version: pop.version, populationHash: pop.population_hash, frozenAt: pop.frozen_at } : null,
      children,
      counts: this.counts(campaignId, principal),
      batchSizes,
      progress: { completed, total: children.length },
      hiddenNote: this.hiddenNote(),
      order: plan ? plan.order : null,
      usage: this.usageOf(campaignId),
      budget: c.spec.budgets,
    };
  }

  listChildren(campaignId: string, principal: string, filter?: { state?: ChildState; batchId?: string; failed?: boolean; stale?: boolean; needsAssessment?: boolean }, cursor?: string, limit = 50): { children: ChildView[]; nextCursor?: string } {
    let rows = this.visibleChildren(campaignId, principal).map((ch) => this.toChildView(ch, principal));
    if (filter?.state) rows = rows.filter((r) => r.state === filter.state);
    if (filter?.batchId) rows = rows.filter((r) => r.batchId === filter.batchId);
    if (filter?.failed) rows = rows.filter((r) => r.state === "FAILED" || r.state === "BLOCKED");
    if (filter?.stale) rows = rows.filter((r) => r.state === "STALE");
    if (filter?.needsAssessment) rows = rows.filter((r) => r.assessmentState === "NEEDS_ASSESSMENT");
    rows.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    const start = cursor ? rows.findIndex((r) => r.repositoryId === cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return { children: page, nextCursor: start + limit < rows.length ? page[page.length - 1]?.repositoryId : undefined };
  }

  /** The plan, viewer-scoped: batch members and counts are cut to what the viewer may see. */
  getCampaignPlan(campaignId: string, principal: string): CampaignPlan {
    const plan = this.getPlan(campaignId);
    const visible = new Set(this.visibleChildren(campaignId, principal).map((c) => c.repository_id as string));
    const roles: Record<string, CampaignRole> = {};
    for (const [id, role] of Object.entries(plan.roles)) if (visible.has(id)) roles[id] = role;
    return {
      ...plan,
      roles,
      cycles: plan.cycles.filter((cy) => cy.every((id) => visible.has(id))),
      batches: plan.batches.map((b) => ({ ...b, members: b.members.filter((m) => visible.has(m)) })),
      compatibility: plan.compatibility.filter((c) => visible.has(c.producerRepository) && visible.has(c.consumerRepository)),
      order: {
        ...plan.order,
        mergeOrder: plan.order.mergeOrder.filter((m) => visible.has(m.repositoryId)),
        notSafeToReorder: plan.order.notSafeToReorder.filter((r) => visible.has(r.producer) && visible.has(r.consumer)),
        rollbackPlan: plan.order.rollbackPlan.filter((r) => visible.has(r.repositoryId)),
      },
    };
  }
}
