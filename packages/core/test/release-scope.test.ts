// Release-scope acceptance checks, mirroring campaigns.test.ts's F08-A2/D7 shape for the release-scope engine.
// The milestone is a deterministic fake adapter, so every rule is testable without a real GitHub call.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ReleaseMilestoneRef, ReleaseSpec } from "@cie/schema";
import { ReleaseError, ReleaseScope, type ReleaseAdapters, type ReleaseScopeIssue } from "../src/release-scope.ts";
import { Store } from "../src/store.ts";

const milestone: ReleaseMilestoneRef = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };

function spec(over: Partial<ReleaseSpec> = {}): ReleaseSpec {
  return { name: "v2.5.0", tag: "v2.5.0", milestone, ...over };
}

class Harness {
  store = new Store(":memory:");
  issues: ReleaseScopeIssue[] = [];
  engine: ReleaseScope;
  private tick = 0;

  constructor() {
    const adapters: ReleaseAdapters = { milestoneIssues: () => this.issues };
    this.engine = new ReleaseScope(this.store, adapters, () => new Date(1_700_000_000_000 + (this.tick++) * 1000).toISOString());
  }

  version(releaseId: string): number { return this.engine.getRelease(releaseId).release.version; }
}

const issue = (n: number, title = `Issue ${n}`, state: "open" | "closed" = "open"): ReleaseScopeIssue => ({ number: n, title, state });

describe("createRelease", () => {
  test("starts DRAFT at version 1", () => {
    const h = new Harness();
    const r = h.engine.createRelease("p1", "t", spec());
    assert.equal(r.state, "DRAFT");
    assert.equal(r.version, 1);
    assert.equal(r.milestone.number, 7);
  });

  test("refuses a spec without a milestone", () => {
    const h = new Harness();
    assert.throws(() => h.engine.createRelease("p1", "t", spec({ milestone: undefined as any })), ReleaseError);
  });
});

describe("freezeScope v1", () => {
  test("every v1 item starts IN_SCOPE and ASSESSED", () => {
    const h = new Harness();
    h.issues = [issue(1), issue(2), issue(3)];
    const r = h.engine.createRelease("p1", "t", spec());
    const result = h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    assert.equal(result.scopeVersion, 1);
    assert.equal(result.items.length, 3);
    for (const it of result.items) {
      assert.equal(it.state, "IN_SCOPE");
      assert.equal(it.assessmentState, "ASSESSED");
    }
    assert.deepEqual(h.engine.inScopeIssues(r.releaseId).sort(), [1, 2, 3]);
  });

  test("refuses to freeze an empty milestone", () => {
    const h = new Harness();
    h.issues = [];
    const r = h.engine.createRelease("p1", "t", spec());
    assert.throws(() => h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId)), ReleaseError);
  });

  test("refuses a stale expected version", () => {
    const h = new Harness();
    h.issues = [issue(1)];
    const r = h.engine.createRelease("p1", "t", spec());
    assert.throws(() => h.engine.freezeScope(r.releaseId, "p1", 99), ReleaseError);
  });
});

// ------------------------------------------------------------------ milestone drift (mirrors F08-A2)

describe("milestone drift after freeze", () => {
  test("an issue added after freeze is NEEDS_ASSESSMENT, never silently in scope", () => {
    const h = new Harness();
    h.issues = [issue(1), issue(2)];
    const r = h.engine.createRelease("p1", "t", spec());
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));

    h.issues.push(issue(3, "Late addition"));
    const frozen2 = h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    assert.equal(frozen2.scopeVersion, 2);

    const late = frozen2.items.find((i) => i.issueNumber === 3)!;
    assert.equal(late.state, "IN_SCOPE");
    assert.equal(late.assessmentState, "NEEDS_ASSESSMENT");
    assert.match(late.reason ?? "", /after freeze/);

    // Not countable toward the release yet.
    assert.deepEqual(h.engine.inScopeIssues(r.releaseId).sort((a, b) => a - b), [1, 2]);

    const diff = h.engine.assessScopeChange(r.releaseId, "p1", 1, 2);
    assert.deepEqual(diff.added, [3]);
    assert.deepEqual(diff.removed, []);
  });

  test("assessItem promotes a drifted item to ASSESSED and it then counts", () => {
    const h = new Harness();
    h.issues = [issue(1)];
    const r = h.engine.createRelease("p1", "t", spec());
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    h.issues.push(issue(2));
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));

    assert.deepEqual(h.engine.inScopeIssues(r.releaseId), [1]);
    const promoted = h.engine.assessItem(r.releaseId, "p1", 2);
    assert.equal(promoted.assessmentState, "ASSESSED");
    assert.deepEqual(h.engine.inScopeIssues(r.releaseId).sort((a, b) => a - b), [1, 2]);
  });

  test("an issue removed from the milestone is EXCLUDED, history preserved not deleted", () => {
    const h = new Harness();
    h.issues = [issue(1), issue(2)];
    const r = h.engine.createRelease("p1", "t", spec());
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));

    h.issues = [issue(1)];
    const frozen2 = h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    const removed = frozen2.items.find((i) => i.issueNumber === 2)!;
    assert.equal(removed.state, "EXCLUDED");
    assert.equal(removed.assessmentState, "ASSESSED");

    const diff = h.engine.assessScopeChange(r.releaseId, "p1", 1, 2);
    assert.deepEqual(diff.removed, [2]);
  });
});

// ------------------------------------------------------------------ event-sourced replay

describe("replay reproduces the live projection", () => {
  test("item states from replay match the stored release view", () => {
    const h = new Harness();
    h.issues = [issue(1), issue(2)];
    const r = h.engine.createRelease("p1", "t", spec());
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    h.issues.push(issue(3));
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    h.engine.assessItem(r.releaseId, "p1", 3);

    const view = h.engine.getRelease(r.releaseId);
    const { items: replayed, releaseState } = h.engine.replay(r.releaseId);
    assert.equal(releaseState, "SCOPE_FROZEN");
    for (const it of view.items) {
      assert.equal(replayed[it.issueNumber], it.state, `issue ${it.issueNumber} state matches replay`);
    }
  });
});

describe("getRelease", () => {
  test("counts and needsAssessment reflect the current scope", () => {
    const h = new Harness();
    h.issues = [issue(1), issue(2)];
    const r = h.engine.createRelease("p1", "t", spec());
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));
    h.issues.push(issue(3));
    h.engine.freezeScope(r.releaseId, "p1", h.version(r.releaseId));

    const view = h.engine.getRelease(r.releaseId);
    assert.equal(view.counts.IN_SCOPE, 3);
    assert.equal(view.needsAssessment, 1);
    assert.equal(view.scope?.version, 2);
  });
});
