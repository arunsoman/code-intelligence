// F02 — publishing a quality-gate result to GitHub (WP-09, §7.12, §10).
//
// The publisher is not trusted to be right: it requires a live grant (double-checked, immediately again before the
// external call), it finds before it creates so an idempotent retry does not accumulate statuses, and it verifies the
// PR's head is still the commit the decision was scored against before it says anything — a moved head is published as
// STALE_REVISION and the stale decision is superseded, not merged into the newer commit's review. Nothing but rule ids,
// counts, paths and line numbers ever leaves for GitHub (no code text) (§10.4), and a finding under a path the caller
// may not see is counted, never named (D9 at the publishing boundary).
//
// F11 egress amendment (decision D4): the impact comment may carry symbol names, paths, line numbers, counts and
// claim classes; never source text, string literals, secrets or non-template model output. Denied paths are counted,
// never named. The impact comment updates independently of the gate comment (decision D2): its own marker, its own
// find-before-create, its own publication rows (decision_id = '' distinguishes the family for supersession).
import { createHash } from "node:crypto";
import type { CheckKind, GateConditionResult, PublicationReceipt } from "@cie/schema";
import type { Store } from "./store.ts";
import type { PrAnalysis } from "./pr-analysis.ts";
import { gateCommentText, gateStatusDescription, hashId } from "./pr-gate.ts";
import { githubApiBase, ghAuthToken, githubRemote, type GhSlug } from "./gh.ts";
import { DEFAULT_IMPACT_POLICY, type ImpactPolicy } from "./impact-report.ts";
import { IMPACT_MARKER, renderImpactComment, renderImpactRetiredComment } from "./impact-render.ts";

const nowIso = () => new Date().toISOString();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- write transport (the only place that talks out)

export interface GitHubTransport {
  /** The commit the PR's head points to right now, or null when it is not retrievable. */
  resolvePrHead: (prNumber: number) => Promise<string | null>;
  /** The repository's visibility as GitHub sees it right now. */
  visibility: () => Promise<"public" | "private">;
  publishStatus: (commitSha: string, s: { state: "error" | "failure" | "pending" | "success"; description: string; targetUrl?: string; context: string }) => Promise<{ id: string; url?: string }>;
  findStatus: (commitSha: string, context: string) => Promise<{ id: string; state: string; description?: string } | null>;
  findComment: (prNumber: number, marker: string) => Promise<{ id: string; body: string } | null>;
  postComment: (prNumber: number, body: string) => Promise<{ id: string; url?: string }>;
  updateComment: (commentId: string, body: string) => Promise<{ id: string; url?: string }>;
}

export class GitHubPublishError extends Error {
  readonly code: "STALE_REVISION" | "FORBIDDEN" | "NOT_FOUND" | "NETWORK" | "CONFLICT";
  constructor(code: "STALE_REVISION" | "FORBIDDEN" | "NOT_FOUND" | "NETWORK" | "CONFLICT", message: string) { super(message); this.code = code; }
}

/** The GitHub REST write side: statuses and PR comments on the repository named by the slug. The token is read at call time (gh) and never stored. */
export function githubRestTransport(slug: GhSlug): GitHubTransport {
  const api = (path: string) => `${githubApiBase(slug)}/repos/${slug.owner}/${slug.repo}${path}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const token = ghAuthToken(slug.host);
    let res: Response;
    try {
      res = await fetch(api(path), {
        method, headers: {
          ...(token.ok ? { authorization: `Bearer ${token.token}` } : {}),
          accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        }, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw new GitHubPublishError("NETWORK", `GitHub did not answer: ${String((e as Error).message ?? e).slice(0, 120)}`); }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* empty body */ }
    return { status: res.status, json };
  };
  return {
    resolvePrHead: async (prNumber) => {
      const { status, json } = await call("GET", `/pulls/${prNumber}`);
      const j = json as { head?: { sha?: string } } | null;
      if (status === 404) return null;
      if (status >= 400) throw new GitHubPublishError("NETWORK", `resolving the PR's head answered ${status}`);
      return j?.head?.sha ?? null;
    },
    visibility: async () => {
      const { status, json } = await call("GET", "");
      const j = json as { private?: boolean } | null;
      if (status >= 400) throw new GitHubPublishError("NETWORK", `resolving the repository answered ${status}`);
      return j?.private ? "private" : "public";
    },
    publishStatus: async (commitSha, s) => {
      const { status, json } = await call("POST", `/statuses/${commitSha}`, { state: s.state, context: s.context, description: s.description.slice(0, 140), ...(s.targetUrl ? { target_url: s.targetUrl } : {}) });
      if (status >= 400) throw new GitHubPublishError(status === 403 || status === 404 ? "FORBIDDEN" : "NETWORK", `publishing the status answered ${status}`);
      const j = json as { id?: number; html_url?: string } | null;
      return { id: String(j?.id ?? sha(`${commitSha}:${s.context}:${nowIso()}`).slice(0, 10)), ...(j?.html_url ? { url: j.html_url } : {}) };
    },
    findStatus: async (commitSha, context) => {
      const { status, json } = await call("GET", `/commits/${commitSha}/statuses?per_page=50`);
      if (status >= 400) return null; // find-before-create: a failed find must not block the publication
      const list = (Array.isArray(json) ? json : []) as { id: string; state: string; context: string; description?: string }[];
      return list.find((s) => s.context === context) ?? null;
    },
    findComment: async (prNumber, marker) => {
      const { status, json } = await call("GET", `/issues/${prNumber}/comments?per_page=100`);
      if (status >= 400) return null;
      const list = (Array.isArray(json) ? json : []) as { id: string; body?: string }[];
      const hit = list.find((c) => (c.body ?? "").includes(marker));
      return hit ? { id: String(hit.id), body: hit.body ?? "" } : null;
    },
    postComment: async (prNumber, body) => {
      const { status, json } = await call("POST", `/issues/${prNumber}/comments`, { body });
      if (status >= 400) throw new GitHubPublishError(status === 403 || status === 404 ? "FORBIDDEN" : "NETWORK", `posting the comment answered ${status}`);
      const j = json as { id: number; html_url?: string } | null;
      return { id: String(j?.id ?? "0"), ...(j?.html_url ? { url: j.html_url } : {}) };
    },
    updateComment: async (commentId, body) => {
      const { status, json } = await call("PATCH", `/issues/comments/${commentId}`, { body });
      if (status >= 400) throw new GitHubPublishError(status === 403 || status === 404 ? "FORBIDDEN" : "NETWORK", `updating the comment answered ${status}`);
      const j = json as { id: number; html_url?: string } | null;
      return { id: String(j?.id ?? commentId), ...(j?.html_url ? { url: j.html_url } : {}) };
    },
  };
}

/** The transport a repository publishes through: from that repository's GitHub origin remote. */
export function githubTransportFor(repoRoot: string): GitHubTransport {
  const slug = githubRemote(repoRoot);
  return githubRestTransport(slug ?? { host: "github.com", owner: "", repo: "" });
}

// ---------------------------------------------------------------- the publication row + grants

export function newGrant(store: Store, g: { repositoryId: string; headHash: string; decisionId?: string; pending?: boolean; principalId: string; operation?: string; ttlMs?: number }): { id: string } {
  const id = "gr:" + sha([g.repositoryId, g.principalId, g.headHash ?? "", g.decisionId ?? "", Date.now(), Math.random()].join("|")).slice(0, 14);
  store.db.prepare("insert into pr_grants values (?,?,?,?,?,?,?,?,?,?)")
    .run(id, g.repositoryId, g.headHash, g.decisionId ?? null, g.pending ? 1 : 0, g.principalId, g.operation ?? "PUBLISH_CHECK", Date.now() + (g.ttlMs ?? 3_600_000), 0, nowIso());
  return { id };
}
interface GrantRow { id: string; repository_id: string; head_hash: string; decision_id: string | null; pending: number; principal_id: string; operation: string; expires_at: number; revoked: number; created_at: string }

export interface PublishRequest {
  repositoryId: string;
  prNumber: number;
  /** The analysis to look everything up from; resolved for decisionId/headHash when only those are known. */
  analysisId?: string;
  decisionId?: string;
  headHash?: string;
  principalId: string;
  kind?: CheckKind;
  alsoComment?: boolean;
}

export class GitHubCheckPublisher {
  readonly store: Store;
  readonly engine: PrAnalysis;
  readonly transportFor: (repoRoot: string) => GitHubTransport;
  readonly context: string;
  /** F11: the check-run context the impact comment is not — it is a comment, but the publication family is separate. */
  readonly impactContext: string;
  /** Base URL of this CIE deployment: the status links back to the PR's review page here (§7.12). */
  readonly selfUrl: string | null;

  constructor(store: Store, engine: PrAnalysis, opts: { transportFor?: (repoRoot: string) => GitHubTransport; context?: string; impactContext?: string; selfUrl?: string | null } = {}) {
    this.store = store; this.engine = engine;
    this.transportFor = opts.transportFor ?? githubTransportFor;
    this.context = opts.context ?? "cie/gate";
    this.impactContext = opts.impactContext ?? "cie/impact";
    this.selfUrl = opts.selfUrl ?? process.env.CIE_SELF_URL ?? null;
  }

  /** The grant check the publisher runs itself, twice: on arrival, and immediately again before the external call. */
  assertGrant(grantId: string, operation = "PUBLISH_CHECK"): GrantRow {
    const g = this.store.db.prepare("select * from pr_grants where id = ?").get(grantId) as GrantRow | undefined;
    if (!g) throw new GitHubPublishError("FORBIDDEN", "no publication grant exists for this check");
    if (g.revoked) throw new GitHubPublishError("FORBIDDEN", "the publication grant was revoked");
    if (Number(g.expires_at) < Date.now()) throw new GitHubPublishError("FORBIDDEN", "the publication grant expired");
    if (g.operation !== operation) throw new GitHubPublishError("FORBIDDEN", `the grant's operation is not ${operation}`);
    return g;
  }

  async publish(grantId: string, req: PublishRequest): Promise<PublicationReceipt> {
    // ---- receipt first: the attempt is recorded before anything leaves ----
    const decisionRow = req.decisionId ? this.engine.decisionRow(req.decisionId) : null;
    const analysisRow = req.analysisId ? this.engine.row(req.analysisId)
      : decisionRow ? this.engine.row(decisionRow.analysis_id)
      : (this.engine.latestForPr(req.repositoryId, req.prNumber) ?? null);
    const headHash = req.headHash ?? analysisRow?.head_hash ?? "";
    const kind: CheckKind = req.kind ?? "STATUS";
    const decisionId = req.decisionId ?? null;
    // The key resolves the CURRENT decision at call time: a repeat of the same saying is deduped, while a pending
    // saying is replaced by the decision that arrived, never swallowed by it (§7.12).
    const currentDecision = decisionId ?? (analysisRow ? this.engine.lastDecisionRow(analysisRow.id)?.decision_id : null) ?? "pending";
    const idempotencyKey = hashId("pub", [req.repositoryId, req.prNumber, headHash, this.context, kind, currentDecision]);
    // An expired waiver changes what is true: no repeat, no pending receipt, nothing republishable until a re-run (§7.9).
    if (analysisRow?.state === "EXPIRED_WAIVER") {
      const refusedKey = hashId("pub", [req.repositoryId, req.prNumber, headHash, this.context, kind, "refused:expired-waiver"]);
      const refusedId = "pub:" + sha([grantId, refusedKey, nowIso()].join("|")).slice(0, 14);
      this.store.db.prepare("insert into check_publications values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(refusedId, decisionId ?? "", req.repositoryId, "github", headHash, refusedKey, kind, null, null, "FAILED", 1,
          "the analysis's waiver has expired (EXPIRED_WAIVER); a stale answer is not published", nowIso());
      return { publicationId: refusedId, forge: "github", repositoryId: req.repositoryId, headHash, kind, state: "FAILED", idempotencyKey: refusedKey, lastError: "STALE_REVISION: the analysis's waiver has expired (EXPIRED_WAIVER); re-run the analysis; nothing is published" };
    }
    const existing = this.store.db.prepare("select * from check_publications where idempotency_key = ?").get(idempotencyKey) as any;
    if (existing && existing.state === "PUBLISHED") return this.receiptOf(existing); // §7.12: repeat a published receipt, never re-say it
    if (existing && existing.state === "PUBLISHING") throw new GitHubPublishError("CONFLICT", "this exact publication is already in flight");

    const grant0 = this.assertGrant(grantId); // first grant check
    const pubId = existing?.id ?? "pub:" + sha([grant0.id, idempotencyKey, nowIso(), Math.random()].join("|")).slice(0, 14);
    if (!existing) this.store.db.prepare("insert into check_publications values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(pubId, decisionId ?? "", req.repositoryId, "github", headHash, idempotencyKey, kind, null, null, "PUBLISHING", 0, null, nowIso());
    else this.store.db.prepare("update check_publications set state = 'PUBLISHING', attempts = attempts + 1 where id = ?").run(pubId);

    try {
      this.engine.sweepExpired(); // a decision whose waiver has expired is not publishable as PASS (§7.9)
      // ---- evidence, computed before the second grant check ----
      const t = this.transportFor(analysisRow?.repo_root ?? req.repositoryId);
      const decisionView = decisionRow ?? this.engine.lastDecisionRow(analysisRow?.id ?? "");
      const dj = decisionView?.json ? JSON.parse(decisionView.json) : null;
      // visibility: a repository GitHub shows publicly may not receive anything scoped narrower (D8)
      if (analysisRow && (await t.visibility()) === "public" && this.store.deniedPrefixes(analysisRow.repo_root ?? req.repositoryId).length > 0) {
        throw new GitHubPublishError("FORBIDDEN", "GitHub shows this repository publicly while the analysis scope is narrower than the platform's; nothing is published");
      }
      // stale-revision guard: the head must still be the PR's head right now (§7.12)
      if (decisionView && headHash) {
        let currentHead: string | null = null;
        try { currentHead = await t.resolvePrHead(req.prNumber); } catch { currentHead = headHash; } // cannot verify → do not cry wolf
        if (currentHead && headHash !== currentHead) {
          this.engine.invalidateDecision(decisionView.decision_id, "the PR head moved after the decision; the published check was stale");
          throw new GitHubPublishError("STALE_REVISION", `the PR's head moved after the decision (scored ${headHash.slice(0, 8)}, the PR's head is now ${currentHead.slice(0, 8)}); the stale decision was superseded`);
        }
      }
      const secondGrant = this.assertGrant(grant0.id); // second grant check, immediately before the external call
      if (secondGrant.id !== grantId) throw new GitHubPublishError("FORBIDDEN", "the publication grant changed under us");

      // ---- what to say ----
      const targetUrl = this.selfUrl ? `${this.selfUrl}/#pr=${analysisRow?.id ?? ""}` : undefined;
      if (!decisionView || !dj) {
        // No decision yet: a pending status that honestly says what is happening, linked to the local page.
        const description = `CIE: analysing PR #${req.prNumber} (head ${headHash.slice(0, 7)})`;
        const prior = kind === "STATUS" ? await t.findStatus(headHash, this.context) : null;
        if (prior && prior.state === "pending" && prior.description === description) this.markPublished(pubId, prior);
        else {
          const s = await t.publishStatus(headHash, { state: "pending", description, ...(targetUrl ? { targetUrl } : {}), context: this.context });
          this.markPublished(pubId, s);
        }
        return this.receiptOf(this.store.db.prepare("select * from check_publications where id = ?").get(pubId) as any);
      }
      if (analysisRow && analysisRow.state === "EXPIRED_WAIVER") {
        // A waiver the decision relied on has expired: the gate answer is stale; re-run, never publish it (§7.9).
        this.store.db.prepare("update check_publications set state = 'FAILED', last_error = ?, updated_at = ? where id = ?").run("the analysis's waiver has expired (EXPIRED_WAIVER); re-run the analysis; nothing was published", nowIso(), pubId);
        throw new GitHubPublishError("STALE_REVISION", "the analysis's waiver has expired (EXPIRED_WAIVER); re-run the analysis; nothing is published");
      }
      if (decisionView.superseded) {
        this.store.db.prepare("update check_publications set state = 'SUPERSEDED', last_error = ?, updated_at = ? where id = ?").run("the decision it was publishing for is superseded", nowIso(), pubId);
        throw new GitHubPublishError("STALE_REVISION", "the decision is superseded; nothing new was published");
      }
      const conditions: GateConditionResult[] = dj.results ?? [];
      const policyIdVersion = { policyId: String(dj.policy?.id ?? ""), version: Number(dj.policy?.version ?? 0) };
      const findings = this.engine.prFindings(analysisRow.id).filter((f) => f.kind === "SECURITY");
      const denied = this.store.deniedPrefixes(analysisRow.repo_root ?? req.repositoryId);
      const visibles = findings.filter((f) => !denied.some((p) => f.path === p || f.path.startsWith(p + "/")));
      const counts = {
        newFindings: visibles.filter((f) => f.introduced && f.disposition !== "RESOLVED_BY_CHANGE").length,
        waived: findings.filter((f) => f.disposition === "WAIVED").length,
      };
      const description = gateStatusDescription({ status: decisionView.status, policy: policyIdVersion, conditions, counts });
      // The comment and the status say only what this caller may see (D9 at the publishing boundary): findings under a
      // denied prefix are counted, never named — and condition reasons that carried a denied path are blanked.
      const withheld = findings.length - visibles.length;
      const sanitize = (reason: string): string => {
        let out = reason;
        for (const p of denied) out = out.replace(new RegExp(`${escapeRegExp(p)}(/\\S+)?`, "g"), "(withheld)").replaceAll(p, "(withheld)");
        return out;
      };
      const conditionsPublic = denied.length ? conditions.map((c) => ({ ...c, reason: sanitize(c.reason) })) : conditions;
      const commentBody = gateCommentText({
        headHash, policy: policyIdVersion,
        decision: { status: decisionView.status, bindingHash: decisionView.binding_hash, evaluatedAt: decisionView.evaluated_at, validUntil: decisionView.valid_until ?? undefined, conditions: conditionsPublic },
        introduced: visibles.filter((f) => f.introduced && f.disposition !== "RESOLVED_BY_CHANGE").map((f) => ({ ruleId: f.ruleId, severity: f.severity, path: f.path, line: f.line, summary: f.summary })),
        existing: visibles.filter((f) => !f.introduced && f.disposition !== "RESOLVED_BY_CHANGE").map((f) => ({ ruleId: f.ruleId, path: f.path, line: f.line })),
        resolvedByChange: findings.filter((f) => f.disposition === "RESOLVED_BY_CHANGE").length,
        analyzers: dj.analyzers ?? [],
        disclosure: withheld ? [`${withheld} finding(s) are in code you may not see; they are counted in the totals, never named here.`] : [],
        analysisId: analysisRow.id,
      });
      // ---- external call ----
      if (kind === "STATUS") {
        const prior = await t.findStatus(headHash, this.context);
        if (prior && prior.state === stateOf(decisionView.status) && prior.description === description) {
          this.store.db.prepare("update check_publications set state = 'PUBLISHED', external_id = ?, updated_at = ? where id = ?").run(prior.id, nowIso(), pubId);
        } else {
          const s = await t.publishStatus(headHash, { state: stateOf(decisionView.status), description, ...(targetUrl ? { targetUrl } : {}), context: this.context });
          this.markPublished(pubId, s);
        }
      }
      if (kind === "COMMENT" || req.alsoComment) {
        // the marker makes the comment updatable rather than a stack of one-shot comments
        const prior = await t.findComment(req.prNumber, "<!-- cie-gate:pr-comment -->");
        const said = prior ? await t.updateComment(prior.id, commentBody) : await t.postComment(req.prNumber, commentBody);
        this.markPublished(pubId, said);
      }
      const row = this.store.db.prepare("select * from check_publications where id = ?").get(pubId) as any;
      // One current saying per decision: a republication supersedes its own earlier ones; a pending saying for the
      // same head is replaced by the decision that arrived (the engine already superseded older heads' publications).
      this.store.db.prepare("update check_publications set state = 'SUPERSEDED' where repository_id = ? and (decision_id = ? or (decision_id = '' and head_hash = ?)) and id <> ? and state = 'PUBLISHED'")
        .run(req.repositoryId, decisionId ?? "", headHash, pubId);
      if (analysisRow) this.engine.markPublished(analysisRow.id);
      return this.receiptOf(row);
    } catch (e) {
      const err = e as { code?: string; name?: string; message?: string };
      const code = err.code ?? "NETWORK";
      const msg = `${err.name ?? "Error"}${err.code ? ` (${err.code})` : ""}: ${String((e as Error).message ?? e).slice(0, 300)}`;
      this.store.db.prepare("update check_publications set state = 'FAILED', last_error = ?, updated_at = ? where id = ?").run(msg.slice(0, 400), nowIso(), pubId);
      return {
        publicationId: pubId, forge: "github", repositoryId: req.repositoryId, headHash, kind,
        externalId: undefined, url: undefined, state: "FAILED", idempotencyKey, lastError: `${code}: ${String((e as Error).message ?? e).slice(0, 300)}`,
      };
    }
  }

  private markPublished(pubId: string, s: { id: string; url?: string }) {
    this.store.db.prepare("update check_publications set state = 'PUBLISHED', external_id = ?, url = ?, updated_at = ? where id = ?").run(s.id, s.url ?? null, nowIso(), pubId);
  }
  /**
   * F11: publish (or update) the blast-radius impact comment for a PR analysis (§7.4, §10, §11). Receipt-first with
   * an idempotency key that binds the saying to the exact report hash: a repeated delivery for one head returns the
   * same receipt and finds-before-creates the one comment; a new head is a new saying that supersedes the old one
   * (F11-A1, F11-A4). Nothing is posted when nothing met the threshold and no earlier comment exists — silence is a
   * designed outcome, recorded as a PREPARED receipt (§7.4). Requires a grant whose operation is PUBLISH_IMPACT.
   */
  async publishImpact(grantId: string, req: { repositoryId: string; prNumber: number; analysisId: string; headHash?: string; policy?: ImpactPolicy }): Promise<PublicationReceipt> {
    const analysisRow = this.engine.row(req.analysisId);
    if (!analysisRow) return { publicationId: "pub:none", forge: "github", repositoryId: req.repositoryId, headHash: req.headHash ?? "", kind: "COMMENT", state: "FAILED", idempotencyKey: "pub:none", lastError: "NOT_FOUND: no such analysis" };
    const headHash = req.headHash ?? analysisRow.head_hash;
    const report = this.engine.impactReportOf(req.analysisId);
    const policy = req.policy ?? DEFAULT_IMPACT_POLICY;
    if (!report) {
      const key = hashId("pub", [req.repositoryId, req.prNumber, headHash, this.impactContext, "no-report"]);
      const id = "pub:" + sha([grantId, key, nowIso()].join("|")).slice(0, 14);
      this.store.db.prepare("insert into check_publications values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, "", req.repositoryId, "github", headHash, key, "COMMENT", null, null, "FAILED", 0, "no impact report exists for this analysis; run C23/analyzePullRequest with an F11 build", nowIso());
      return { publicationId: id, forge: "github", repositoryId: req.repositoryId, headHash, kind: "COMMENT", state: "FAILED", idempotencyKey: key, lastError: "no impact report exists for this analysis" };
    }
    // The key binds the saying to the exact report hash: the same report repeats its receipt; a new head or a
    // changed report is a new saying that supersedes the old one.
    const idempotencyKey = hashId("pub", [req.repositoryId, req.prNumber, headHash, this.impactContext, report.analysisId, sha(JSON.stringify(report)).slice(0, 16)]);
    const existing = this.store.db.prepare("select * from check_publications where idempotency_key = ?").get(idempotencyKey) as any;
    if (existing && existing.state === "PUBLISHED") return this.receiptOf(existing);
    if (existing && existing.state === "PUBLISHING") throw new GitHubPublishError("CONFLICT", "this exact impact publication is already in flight");

    const grant0 = this.assertGrant(grantId, "PUBLISH_IMPACT");
    const pubId = existing?.id ?? "pub:" + sha([grant0.id, idempotencyKey, nowIso(), Math.random()].join("|")).slice(0, 14);
    if (!existing) this.store.db.prepare("insert into check_publications values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(pubId, "", req.repositoryId, "github", headHash, idempotencyKey, "COMMENT", null, null, "PUBLISHING", 0, null, nowIso());
    else this.store.db.prepare("update check_publications set state = 'PUBLISHING', attempts = attempts + 1 where id = ?").run(pubId);

    try {
      this.engine.sweepExpired();
      const t = this.transportFor(analysisRow.repo_root ?? req.repositoryId);
      if ((await t.visibility()) === "public" && this.store.deniedPrefixes(analysisRow.repo_root ?? req.repositoryId).length > 0) {
        throw new GitHubPublishError("FORBIDDEN", "GitHub shows this repository publicly while the analysis scope is narrower than the platform's; nothing is published");
      }
      // stale-head guard: the comment is bound to the exact head the report was built from (§6.1, F11-A1).
      let currentHead: string | null = null;
      try { currentHead = await t.resolvePrHead(req.prNumber); } catch { currentHead = headHash; }
      if (currentHead && headHash !== currentHead) {
        throw new GitHubPublishError("STALE_REVISION", `the PR's head moved after the report (built for ${headHash.slice(0, 8)}, the PR's head is now ${currentHead.slice(0, 8)}); the stale report is superseded, not published`);
      }
      const secondGrant = this.assertGrant(grant0.id, "PUBLISH_IMPACT");
      if (secondGrant.id !== grantId) throw new GitHubPublishError("FORBIDDEN", "the publication grant changed under us");

      const denied = this.store.deniedPrefixes(analysisRow.repo_root ?? req.repositoryId);
      const reviewUrl = this.selfUrl ? `${this.selfUrl}/#pr=${req.analysisId}` : undefined;
      const resolveEvidence = (id: string) => !!this.store.evidence(analysisRow.head_revision ?? "", id);
      const rendered = renderImpactComment({
        report, analysisState: analysisRow.state, policy, deniedPrefixes: denied, resolveEvidence, reviewUrl,
      });
      if (rendered.silent) {
        // §7.4: nothing met the threshold. If an earlier impact comment exists it must not keep claiming stale
        // items — update it to say they no longer apply; otherwise post nothing at all.
        const prior = await t.findComment(req.prNumber, IMPACT_MARKER);
        if (prior) {
          const said = await t.updateComment(prior.id, renderImpactRetiredComment(headHash, policy, reviewUrl));
          this.markPublished(pubId, said);
        } else {
          this.store.db.prepare("update check_publications set state = 'PREPARED', last_error = ?, updated_at = ? where id = ?")
            .run("silent: nothing met the noise threshold and no earlier comment exists; nothing was posted (§7.4)", nowIso(), pubId);
        }
      } else {
        // find-before-create: a repeated delivery for one head updates the one comment (F11-A4).
        const prior = await t.findComment(req.prNumber, IMPACT_MARKER);
        const said = prior ? await t.updateComment(prior.id, rendered.markdown) : await t.postComment(req.prNumber, rendered.markdown);
        this.markPublished(pubId, said);
        // One current impact saying per PR: the new head's publication supersedes the earlier one. Impact
        // publications always record decision_id = '' (F02 decision comments bind a decision id), which
        // distinguishes the family without a schema change.
        this.store.db.prepare("update check_publications set state = 'SUPERSEDED', updated_at = ? where repository_id = ? and kind = 'COMMENT' and decision_id = '' and id <> ? and state = 'PUBLISHED'")
          .run(nowIso(), req.repositoryId, pubId);
      }
      if (analysisRow.state === "DECIDED") this.engine.markPublished(req.analysisId);
      return this.receiptOf(this.store.db.prepare("select * from check_publications where id = ?").get(pubId) as any);
    } catch (e) {
      const err = e as { code?: string; name?: string };
      const code = err.code ?? "NETWORK";
      const msg = `${err.name ?? "Error"}${err.code ? ` (${err.code})` : ""}: ${String((e as Error).message ?? e).slice(0, 300)}`;
      this.store.db.prepare("update check_publications set state = 'FAILED', last_error = ?, updated_at = ? where id = ?").run(msg.slice(0, 400), nowIso(), pubId);
      return { publicationId: pubId, forge: "github", repositoryId: req.repositoryId, headHash, kind: "COMMENT", state: "FAILED", idempotencyKey, lastError: `${code}: ${String((e as Error).message ?? e).slice(0, 300)}` };
    }
  }

  receiptOf(r: any): PublicationReceipt {
    return {
      publicationId: r.id, forge: r.forge, repositoryId: r.repository_id, headHash: r.head_hash, kind: r.kind,
      externalId: r.external_id ?? undefined, url: r.url ?? undefined, state: r.state, idempotencyKey: r.idempotency_key,
      lastError: r.last_error ?? undefined,
    };
  }
}

const stateOf = (s: string): "error" | "failure" | "pending" | "success" => (s === "PASS" ? "success" : s === "FAIL" ? "failure" : s === "INCOMPLETE" ? "pending" : "error");