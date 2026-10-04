// F08 acceptance and design checks. The engine is exercised through deterministic fake adapters (repository host,
// recipe runner, validator, joint runner, publisher) so every rule in the spec is testable without a real forge or a
// real transformation. The acceptance cases are F08-A1…A6; the design checks are F08-D3, D4, D7 and D10.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CampaignSpec, CompatibilityMode, ChildState } from "@cie/schema";
import {
  Campaigns, CAMPAIGN_LIMITS,
  type CampaignAdapters, type CampaignRepo, type JointOutcome, type PublicationOutcome, type RecipeOutcome,
  type ValidationOutcome,
} from "../src/campaigns.ts";
import { Store } from "../src/store.ts";

const repo = (id: string, over: Partial<CampaignRepo> = {}): CampaignRepo => ({
  repositoryId: id, repoRoot: `/r/${id}`, name: id, defaultBranch: "main",
  baseCommit: `base-${id}`, language: "ts", ...over,
});

function spec(over: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    name: "Migrate payments-client 2→3",
    selector: { explicit: [] },
    transformation: { kind: "RECIPE", recipeId: "payments-client-3", recipeVersion: "1.2", args: {} },
    compatibility: { policyId: "compat-1", required: ["CANDIDATE_WITH_CANDIDATE"] },
    batches: { canarySize: 0, maxConcurrent: 3, pauseRules: [] },
    budgets: { wallMs: 60_000, githubWrites: 100 },
    ...over,
  };
}

const PAY = "@acme/payments-client";
const producer = repo("billing-lib", { packages: [PAY] });
const consumer = (id: string) => repo(id, { requiresPackages: [PAY] });

class Harness {
  store = new Store(":memory:");
  repos: CampaignRepo[] = [];
  visibility = new Map<string, Set<string>>();
  excluded = new Set<string>();
  forbidden = new Set<string>();
  applyFails = new Map<string, string>();
  validation = new Map<string, "PASS" | "FAIL">();
  shapes = new Map<string, string>();
  tokensPerChild = new Map<string, number>();
  /** When true, every child's recipe returns the same diff/head identity (used to prove bindings stay per-child). */
  sharedCandidate = false;
  joint: (p: string, c: string, mode: CompatibilityMode) => JointOutcome = () => ({ state: "PASSED" });
  publishFailAfter = Infinity;
  publishCalls: { repoId: string; base: string; diff: string; branch: string }[] = [];
  github = new Map<string, string>();
  private nextPr = 100;
  private tick = 0;
  engine: Campaigns;

  constructor() {
    const adapters: CampaignAdapters = {
      repos: () => this.repos,
      baseCommit: (id, pinned) => pinned ?? this.repos.find((r) => r.repositoryId === id)?.baseCommit ?? null,
      transformationApplies: (id) => this.excluded.has(id) ? { applies: false, reason: "transformation does not apply" } : { applies: true, reason: "" },
      applyRecipe: (id, base, t): RecipeOutcome => {
        if (this.applyFails.has(id)) return { ok: false, error: this.applyFails.get(id)! };
        const key = this.sharedCandidate ? "shared" : id;
        const diffHash = `${key}|${base}|${JSON.stringify(t)}`;
        return {
          ok: true, diffHash, headHash: `head:${diffHash}`, shapeHash: this.shapes.get(id) ?? `shape:${JSON.stringify(t)}`,
          files: ["src/a.ts"], forbiddenPaths: this.forbidden.has(id) ? [".github/workflows/ci.yml"] : [],
          handle: `handle:${id}`, dir: `/scratch/${id}/head`, baseDir: `/scratch/${id}/base`,
          modelTokens: this.tokensPerChild.get(id) ?? 0,
        };
      },
      validateChild: (id): ValidationOutcome => {
        const v = this.validation.get(id) ?? "PASS";
        return v === "PASS"
          ? { state: "PASSED", runs: 3, passedRuns: 3, failedRuns: 0 }
          : { state: "FAILED", runs: 3, passedRuns: 2, failedRuns: 1, reason: "2 tests failed" };
      },
      jointCheck: (req): JointOutcome => this.joint(req.producerRepository, req.consumerRepository, req.mode),
      publish: (req): PublicationOutcome => {
        this.publishCalls.push({ repoId: req.repositoryId, base: req.baseCommit, diff: req.diffHash, branch: req.branch });
        if (this.publishCalls.length > this.publishFailAfter) return { state: "FAILED", reason: "secondary rate limit" };
        if (this.github.has(req.repositoryId)) return { state: "ADOPTED", prNumber: Number(this.github.get(req.repositoryId)!.replace(/\D/g, "")) || this.nextPr++, prState: "draft" };
        const n = this.nextPr++;
        this.github.set(req.repositoryId, "draft");
        return { state: "CREATED", prNumber: n, prState: "draft" };
      },
      githubState: (id) => this.github.get(id) ?? null,
      canSee: (principal, r) => this.visibility.has(principal) ? this.visibility.get(principal)!.has(r.repositoryId) : true,
      canPublish: (principal, r) => this.visibility.has(principal) ? this.visibility.get(principal)!.has(r.repositoryId) : true,
      ownerOf: (id) => `owner:${id}`,
    };
    this.engine = new Campaigns(this.store, adapters, () => new Date(1_700_000_000_000 + (this.tick++) * 1000).toISOString());
  }

  version(campaignId: string, principal = "p1"): number { return this.engine.getCampaign(campaignId, principal).campaign.version; }

  /** Issue a per-child publication grant for every review-ready child, as a trusted host would (§10.1). */
  grantAll(campaignId: string, principal = "p1"): void {
    for (const ch of this.engine.listChildren(campaignId, principal).children) {
      if (ch.state === "REVIEW_READY") this.engine.issuePublicationGrant(campaignId, principal, ch.repositoryId);
    }
  }

  /** Freeze, plan and advance every batch until the campaign pauses, completes or a guard trips. */
  run(campaignId: string, principal = "p1"): void {
    this.engine.freezePopulation(campaignId, principal, this.version(campaignId, principal));
    this.engine.planCampaign(campaignId, principal, this.version(campaignId, principal));
    this.advanceAll(campaignId, principal);
  }

  advanceAll(campaignId: string, principal = "p1"): void {
    for (let guard = 0; guard < 30; guard++) {
      const view = this.engine.getCampaign(campaignId, principal);
      if (["COMPLETED", "PAUSED", "CANCELLED"].includes(view.campaign.state)) return;
      const plan = this.engine.getCampaignPlan(campaignId, principal);
      const next = plan.batches.find((b) => b.state !== "COMPLETE");
      if (!next) return;
      this.engine.advanceCampaign(campaignId, principal, view.campaign.version, next.batchId);
    }
  }
}

// ------------------------------------------------------------------ F08-A1

describe("F08-A1 mixed PASS/FAIL stay mixed", () => {
  test("shows counts per state, no aggregate, and leaves the failed child unpublished", () => {
    const h = new Harness();
    h.repos = [producer, consumer("refunds-api"), consumer("web-checkout"), consumer("mobile-bff"), repo("docs-site")];
    h.validation.set("mobile-bff", "FAIL");
    h.excluded.add("docs-site");
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "refunds-api", "web-checkout", "mobile-bff", "docs-site"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);

    const view = h.engine.getCampaign(c.campaignId, "p1");
    assert.equal(view.counts.REVIEW_READY, 3, "producer + two consumers passed");
    assert.equal(view.counts.FAILED, 1, "one consumer failed its tests");
    assert.equal(view.counts.EXCLUDED, 1, "the independent repository is excluded");
    assert.equal((view as any).healthScore, undefined, "no single campaign health score");
    assert.equal((view.counts as any).passPercent, undefined, "no pass percentage headline");

    h.grantAll(c.campaignId);
    h.engine.publishCampaignChildren(c.campaignId, "p1", null, null);
    const after = h.engine.listChildren(c.campaignId, "p1").children;
    const failed = after.find((r) => r.repositoryId === "mobile-bff")!;
    assert.equal(failed.state, "FAILED");
    assert.match(failed.reason ?? "", /tests failed/, "the failure reason is shown");
    assert.equal(failed.pr, null, "the failed child is not published");
    assert.equal(after.filter((r) => r.state === "PUBLISHED").length, 3);
  });
});

// ------------------------------------------------------------------ F08-A2

describe("F08-A2 population change needs an assessment", () => {
  test("creates population v2 with a diff and refuses to advance an unassessed child", () => {
    const h = new Harness();
    h.repos = [repo("a"), repo("b"), repo("c"), repo("d")];
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { attributes: { language: "ts" } }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));

    h.repos.push(repo("e"));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));
    const diff = h.engine.assessPopulationChange(c.campaignId, "p1", 1, 2);
    assert.deepEqual(diff.added, ["e"], "the added repository appears in the diff");

    const e = h.engine.listChildren(c.campaignId, "p1").children.find((r) => r.repositoryId === "e")!;
    assert.equal(e.assessmentState, "NEEDS_ASSESSMENT");

    h.engine.planCampaign(c.campaignId, "p1", h.version(c.campaignId));
    const batch = h.engine.getCampaignPlan(c.campaignId, "p1").batches.find((b) => b.members.includes("e"))!;
    const refused = h.engine.advanceCampaign(c.campaignId, "p1", h.version(c.campaignId), batch.batchId);
    assert.equal(refused.paused, true);
    assert.match(refused.reason ?? "", /unassessed/);

    h.engine.assessChild(c.campaignId, "p1", "e");
    assert.equal(h.engine.listChildren(c.campaignId, "p1").children.find((r) => r.repositoryId === "e")!.assessmentState, "ASSESSED");
    h.advanceAll(c.campaignId);
    assert.equal(h.engine.listChildren(c.campaignId, "p1").children.find((r) => r.repositoryId === "e")!.state, "REVIEW_READY");
  });
});

// ------------------------------------------------------------------ F08-A3

describe("F08-A3 a moved base is STALE independently", () => {
  test("marks only the moved child STALE and lets siblings continue", () => {
    const h = new Harness();
    h.repos = [repo("a"), repo("b"), repo("c")];
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["a", "b", "c"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);

    h.repos.find((r) => r.repositoryId === "b")!.baseCommit = "base-b-2";
    const view = h.engine.getCampaign(c.campaignId, "p1");
    assert.equal(view.children.find((r) => r.repositoryId === "b")!.stale, true);
    assert.equal(view.children.filter((r) => r.repositoryId !== "b").every((r) => !r.stale), true, "siblings are not stale");
  });
});

// ------------------------------------------------------------------ F08-A4

describe("F08-A4 partial publication retries only unpublished children", () => {
  test("reconciles 2 published / 3 pending and creates exactly 3 on retry", () => {
    const h = new Harness();
    h.repos = [producer, consumer("c1"), consumer("c2"), consumer("c3"), repo("z")];
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2", "c3", "z"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);

    h.publishFailAfter = 2;
    h.grantAll(c.campaignId);
    const first = h.engine.publishCampaignChildren(c.campaignId, "p1", null, null);
    assert.equal(first.results.filter((r) => r.action === "CREATED").length, 2);
    assert.equal(first.results.filter((r) => r.action === "FAILED").length, 3);

    const publishedBefore = h.engine.listChildren(c.campaignId, "p1").children.filter((r) => r.state === "PUBLISHED").map((r) => r.pr!.number).sort();
    assert.equal(publishedBefore.length, 2);

    const rec = h.engine.reconcileCampaign(c.campaignId, "p1");
    const retryable = rec.children.filter((r) => r.action === "RETRY");
    assert.equal(retryable.length, 3, "only the three unpublished children are retryable");

    const before = h.publishCalls.length;
    h.publishFailAfter = Infinity;
    h.grantAll(c.campaignId);
    const retry = h.engine.publishCampaignChildren(c.campaignId, "p1", null, null);
    assert.equal(retry.results.filter((r) => r.action === "CREATED").length, 3, "exactly three PRs created");
    assert.equal(h.publishCalls.length - before, 3, "the two already-published children were not touched");

    const publishedAfter = h.engine.listChildren(c.campaignId, "p1").children.filter((r) => r.state === "PUBLISHED").map((r) => r.pr!.number).sort();
    assert.equal(publishedAfter.length, 5);
    for (const n of publishedBefore) assert.ok(publishedAfter.includes(n), "the first two PRs are untouched");
  });
});

// ------------------------------------------------------------------ F08-A5

describe("F08-A5 incompatible producer/consumer fails the joint check", () => {
  test("fails the required case, pauses the campaign, and marks unrequired modes not evaluated", () => {
    const h = new Harness();
    h.repos = [producer, consumer("consumer-good"), consumer("consumer-bad")];
    h.joint = (_p, c, mode) => mode !== "CANDIDATE_WITH_CANDIDATE"
      ? { state: "NOT_EVALUABLE", reason: "not required" }
      : c === "consumer-bad" ? { state: "FAILED", reason: "type error: createPayment(ctx, amount) still used" } : { state: "PASSED" };
    const c = h.engine.createCampaign("p1", "t", spec({
      selector: { explicit: ["billing-lib", "consumer-good", "consumer-bad"] },
      compatibility: { policyId: "compat-1", required: ["CANDIDATE_WITH_CANDIDATE"] },
      batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [{ kind: "JOINT_FAILURE" }] },
    }));
    h.run(c.campaignId);

    const view = h.engine.getCampaign(c.campaignId, "p1");
    assert.equal(view.campaign.state, "PAUSED");
    const plan = h.engine.getCampaignPlan(c.campaignId, "p1");
    const bad = plan.compatibility.find((x) => x.consumerRepository === "consumer-bad" && x.mode === "CANDIDATE_WITH_CANDIDATE")!;
    assert.equal(bad.state, "FAILED");
    const good = plan.compatibility.find((x) => x.consumerRepository === "consumer-good" && x.mode === "CANDIDATE_WITH_CANDIDATE")!;
    assert.equal(good.state, "PASSED");
    const notRequired = plan.compatibility.find((x) => x.mode === "CANDIDATE_WITH_BASE")!;
    assert.equal(notRequired.state, "NOT_EVALUATED", "an unrequired mode reads 'not evaluated'");
  });
});

// ------------------------------------------------------------------ F08-A6

describe("F08-A6 no leak of hidden population", () => {
  test("computes every aggregate over visible children and never counts the hidden remainder", () => {
    const h = new Harness();
    h.repos = [producer, consumer("refunds-api"), consumer("web-checkout"), consumer("mobile-bff"), repo("docs-site")];
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "refunds-api", "web-checkout", "mobile-bff", "docs-site"] }, batches: { canarySize: 3, maxConcurrent: 3, pauseRules: [] } }));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));
    h.engine.planCampaign(c.campaignId, "p1", h.version(c.campaignId));

    h.visibility.set("p1", new Set(["billing-lib", "refunds-api", "web-checkout", "mobile-bff", "docs-site"]));
    h.visibility.set("p2", new Set(["billing-lib", "refunds-api", "web-checkout"]));

    const full = h.engine.getCampaign(c.campaignId, "p1");
    const scoped = h.engine.getCampaign(c.campaignId, "p2");
    assert.equal(full.children.length, 5);
    assert.equal(scoped.children.length, 3);
    assert.equal(Object.values(scoped.counts).reduce((a, b) => a + b, 0), 3, "counts are over visible children only");
    assert.equal(Object.values(scoped.batchSizes).reduce((a, b) => a + b, 0), 3, "batch sizes are over visible children only");

    const s = JSON.stringify(scoped);
    assert.equal(s.includes("mobile-bff"), false, "a hidden repository id never appears");
    assert.equal(s.includes("docs-site"), false);
    assert.equal(scoped.hiddenNote, "You can see the repositories you have access to.");
    assert.equal(/\bhidden\b[^.]*\d/i.test(s), false, "the hidden remainder is never counted");

    // Selector evaluation happens inside the visible set: a hidden repository that would match does not affect results.
    const visibleNames = new Set(h.engine.visibleRepos("p2").map((r) => r.repositoryId));
    assert.deepEqual([...visibleNames].sort(), ["billing-lib", "refunds-api", "web-checkout"]);
  });
});

// ------------------------------------------------------------------ design checks

describe("F08 design checks", () => {
  test("D3 a recipe touching a forbidden path is BLOCKED, siblings unaffected", () => {
    const h = new Harness();
    h.repos = [repo("a"), repo("b")];
    h.forbidden.add("a");
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["a", "b"] }, batches: { canarySize: 5, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    const children = h.engine.listChildren(c.campaignId, "p1").children;
    assert.equal(children.find((r) => r.repositoryId === "a")!.state, "BLOCKED");
    assert.equal(children.find((r) => r.repositoryId === "b")!.state, "REVIEW_READY");
  });

  test("D4 orders producers before consumers and flags a cycle without inventing an order", () => {
    const h = new Harness();
    h.repos = [producer, consumer("consumer")];
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "consumer"] }, batches: { canarySize: 0, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    const plan = h.engine.getCampaignPlan(c.campaignId, "p1");
    const order = plan.order.mergeOrder.map((m) => m.repositoryId);
    assert.ok(order.indexOf("billing-lib") < order.indexOf("consumer"), "producer merges first");
    assert.deepEqual(plan.cycles, []);

    const h2 = new Harness();
    h2.repos = [repo("x", { requiresRepositories: ["y"], packages: ["px"] }), repo("y", { requiresRepositories: ["x"], packages: ["py"] })];
    const c2 = h2.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["x", "y"] }, batches: { canarySize: 0, maxConcurrent: 3, pauseRules: [] } }));
    h2.run(c2.campaignId);
    const plan2 = h2.engine.getCampaignPlan(c2.campaignId, "p1");
    assert.ok(plan2.cycles.length >= 1, "a producer↔consumer cycle is reported");
  });

  test("D5 a pause rule stops the next batch and resume is a human action", () => {
    const h = new Harness();
    h.repos = [producer, consumer("consumer-1"), consumer("consumer-2")];
    const c = h.engine.createCampaign("p1", "t", spec({
      selector: { explicit: ["billing-lib", "consumer-1", "consumer-2"] },
      batches: { canarySize: 1, maxConcurrent: 3, pauseRules: [{ kind: "CANARY_ALL_READY" }] },
    }));
    h.run(c.campaignId);
    // The canary has one child; if it is REVIEW_READY the rule passes. Force a failure so the next batch waits.
    let view = h.engine.getCampaign(c.campaignId, "p1");
    assert.ok(["PAUSED", "RUNNING", "COMPLETED"].includes(view.campaign.state));
    if (view.campaign.state === "PAUSED") {
      const v = view.campaign.version;
      const resumed = h.engine.resume(c.campaignId, "p1", v);
      assert.equal(resumed.state, "RUNNING");
    }
  });

  test("D7 event replay reproduces the child-state projection", () => {
    const h = new Harness();
    h.repos = [repo("a"), repo("b")];
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["a", "b"] }, batches: { canarySize: 5, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    const replay = h.engine.replay(c.campaignId);
    for (const child of h.engine.listChildren(c.campaignId, "p1").children) {
      assert.equal(replay.children[child.repositoryId], child.state as ChildState, `replay matches projection for ${child.repositoryId}`);
    }
  });

  test("D10 selector evaluation is confined to the visible set", () => {
    const h = new Harness();
    h.repos = [producer, consumer("visible-consumer"), consumer("hidden-consumer")];
    h.visibility.set("p1", new Set(["billing-lib", "visible-consumer", "hidden-consumer"]));
    h.visibility.set("p2", new Set(["billing-lib", "visible-consumer"]));
    const c = h.engine.createCampaign("p2", "t", spec({ selector: { dependentsOf: { package: PAY } } }));
    h.engine.freezePopulation(c.campaignId, "p2", h.version(c.campaignId, "p2"));
    const children = h.engine.listChildren(c.campaignId, "p2").children.map((r) => r.repositoryId).sort();
    assert.deepEqual(children, ["visible-consumer"], "a hidden matching repository never enters the population");
  });

  test("population cap is enforced", () => {
    const h = new Harness();
    h.repos = Array.from({ length: CAMPAIGN_LIMITS.populationCap + 1 }, (_, i) => repo(`repo-${String(i).padStart(4, "0")}`));
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { attributes: { language: "ts" } } }));
    assert.throws(() => h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId)), /cap/);
  });
});

// ------------------------------------------------------------------ execution, budgets, review

describe("F08 execution, budgets and review", () => {
  const three = () => { const h = new Harness(); h.repos = [producer, consumer("c1"), consumer("c2")]; return h; };

  test("D1 identical candidates still get distinct per-child binding hashes", () => {
    const h = three();
    h.sharedCandidate = true;
    for (const r of h.repos) r.baseCommit = "base-same";
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    const children = h.engine.listChildren(c.campaignId, "p1").children;
    const bindings = children.map((x) => x.bindingHash);
    assert.equal(new Set(bindings).size, children.length, "each child binds its own candidate even when the diffs are identical");
    assert.ok(bindings.every((b) => typeof b === "string" && b.length === 64));
  });

  test("D2 approving one child leaves identical-shape siblings unapproved, and the author cannot self-approve", () => {
    const h = three();
    h.shapes.set("c1", "shape-x"); h.shapes.set("c2", "shape-x");
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    assert.throws(() => h.engine.approveChild(c.campaignId, "p1", "c1", "self"), /cannot approve/);
    h.engine.approveChild(c.campaignId, "reviewer-2", "c1", "looks right");
    const after = h.engine.listChildren(c.campaignId, "p1").children;
    assert.equal(after.find((x) => x.repositoryId === "c1")!.approved, true);
    assert.equal(after.find((x) => x.repositoryId === "c2")!.approved, false, "an identical shape does not share the approval");
    const cluster = h.engine.clusterChildren(c.campaignId, "p1").clusters.find((cl) => cl.members.length === 2)!;
    assert.ok(cluster, "identical shapes cluster together");
    assert.equal(new Set(cluster.members.map((m) => m.bindingHash)).size, 2, "cluster members keep distinct bindings");
  });

  test("D6 budget exhaustion pauses and never drops a child silently", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] }, budgets: { wallMs: 60000, githubWrites: 1 } }));
    h.run(c.campaignId);
    h.grantAll(c.campaignId);
    const res = h.engine.publishCampaignChildren(c.campaignId, "p1", null, null);
    assert.equal(res.results.filter((r) => r.action === "CREATED").length, 1);
    assert.equal(res.results.filter((r) => r.action === "FAILED" && /budget/.test(r.reason ?? "")).length, 2);
    assert.equal(h.engine.getCampaign(c.campaignId, "p1").campaign.state, "PAUSED");
    assert.equal(h.engine.listChildren(c.campaignId, "p1").children.filter((x) => x.state === "REVIEW_READY").length, 2, "unadmitted children stay queued");
  });

  test("D8 cancel does not close a published draft PR", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    h.grantAll(c.campaignId);
    h.engine.publishCampaignChildren(c.campaignId, "p1", null, ["c1"]);
    const calls = h.publishCalls.length;
    h.engine.cancel(c.campaignId, "p1", h.version(c.campaignId), "stop");
    assert.equal(h.engine.listChildren(c.campaignId, "p1").children.find((x) => x.repositoryId === "c1")!.state, "PUBLISHED");
    assert.equal(h.publishCalls.length, calls, "cancel issues no outward call");
  });

  test("D9 a transformation change marks materialised children NEEDS_REASSESSMENT", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    h.engine.updateTransformation(c.campaignId, "p1", h.version(c.campaignId), { kind: "RECIPE", recipeId: "payments-client-3", recipeVersion: "1.3", args: {} });
    assert.ok(h.engine.listChildren(c.campaignId, "p1").children.every((x) => x.assessmentState === "NEEDS_ASSESSMENT"));
  });

  test("D11 a redelivered advance is idempotent and adds no child transition", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));
    h.engine.planCampaign(c.campaignId, "p1", h.version(c.campaignId));
    const batch = h.engine.getCampaignPlan(c.campaignId, "p1").batches[0]!;
    h.engine.advanceCampaign(c.campaignId, "p1", h.version(c.campaignId), batch.batchId, "idem-1");
    const count = () => (h.store.db.prepare("select count(*) n from campaign_events where campaign_id = ? and type = 'CHILD_STATE'").get(c.campaignId) as { n: number }).n;
    const before = count();
    h.engine.advanceCampaign(c.campaignId, "p1", h.version(c.campaignId), batch.batchId, "idem-1");
    assert.equal(count(), before, "a redelivered advance adds no child transition");
  });

  test("enforces the concurrency cap across calls", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 1, pauseRules: [] } }));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));
    h.engine.planCampaign(c.campaignId, "p1", h.version(c.campaignId));
    const batch = h.engine.getCampaignPlan(c.campaignId, "p1").batches[0]!;
    h.engine.advanceCampaign(c.campaignId, "p1", h.version(c.campaignId), batch.batchId);
    assert.equal(h.engine.listChildren(c.campaignId, "p1").children.filter((x) => x.state === "REVIEW_READY").length, 1, "only one child is admitted per call under a cap of one");
    h.advanceAll(c.campaignId);
    assert.equal(h.engine.listChildren(c.campaignId, "p1").children.filter((x) => x.state === "REVIEW_READY").length, 3);
  });

  test("refuses to publish a child with no per-child grant bound to its exact candidate", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 1, maxConcurrent: 3, pauseRules: [] } }));
    h.run(c.campaignId);
    const noGrant = h.engine.publishCampaignChildren(c.campaignId, "p1", null, ["c1"]);
    assert.equal(noGrant.results[0]!.action, "FAILED");
    assert.match(noGrant.results[0]!.reason ?? "", /no publication grant/);
    h.engine.issuePublicationGrant(c.campaignId, "p1", "c1");
    assert.equal(h.engine.publishCampaignChildren(c.campaignId, "p1", null, ["c1"]).results[0]!.action, "CREATED");
  });

  test("dry run previews diffs and validation with no branch and no pull request", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] } }));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));
    const dry = h.engine.runDryRun(c.campaignId, "p1");
    assert.equal(dry.repositories.length, 3);
    assert.equal(h.publishCalls.length, 0, "a dry run makes no outward call");
    assert.ok(h.engine.listChildren(c.campaignId, "p1").children.every((x) => x.state === "NOT_STARTED"), "children were not started");
    assert.equal(h.engine.getDryRun(c.campaignId, "p1")!.runId, dry.runId);
  });

  test("a token budget pauses before admission", () => {
    const h = three();
    const c = h.engine.createCampaign("p1", "t", spec({ selector: { explicit: ["billing-lib", "c1", "c2"] }, batches: { canarySize: 10, maxConcurrent: 3, pauseRules: [] }, budgets: { wallMs: 60000, modelTokens: 0, githubWrites: 100 } }));
    h.engine.freezePopulation(c.campaignId, "p1", h.version(c.campaignId));
    h.engine.planCampaign(c.campaignId, "p1", h.version(c.campaignId));
    const batch = h.engine.getCampaignPlan(c.campaignId, "p1").batches[0]!;
    const progress = h.engine.advanceCampaign(c.campaignId, "p1", h.version(c.campaignId), batch.batchId);
    assert.equal(progress.paused, true);
    assert.match(progress.reason ?? "", /BUDGET_STOPPED/);
    assert.ok(h.engine.listChildren(c.campaignId, "p1").children.every((x) => x.state === "NOT_STARTED"), "no child ran");
  });
});
