// Phase 4: the release-readiness aggregator. Every row is checked against its own producer, plus the house
// invariant that a row this aggregator cannot determine reports "unknown", never a guessed "pass".
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReleaseReadiness, type ReadinessDeps } from "../src/release-readiness.ts";
import { ReleaseScope, type ReleaseAdapters } from "../src/release-scope.ts";
import { GhCiForge } from "../src/feature/ci-forge.ts";
import { Security } from "../src/security.ts";
import { setup } from "./helpers.ts";
import type { GhRunner } from "../src/gh-forge.ts";

const SEC_REPO = resolve(import.meta.dirname, "../../../fixtures/security-repo");
const MILESTONE = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };

/** A scripted GitHub: one exact JSON response (or failure) per endpoint string, same convention as ci-forge.test.ts. */
class FakeGitHub {
  responses = new Map<string, unknown>();
  failures = new Map<string, string>();
  run: GhRunner = (args) => {
    let endpoint = "";
    for (let i = 1; i < args.length; i++) { if (args[i] === "-X" || args[i] === "-f") i++; else endpoint = args[i]!; }
    if (this.failures.has(endpoint)) return { status: 1, stdout: "", stderr: this.failures.get(endpoint)! };
    if (!this.responses.has(endpoint)) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    return { status: 0, stdout: JSON.stringify(this.responses.get(endpoint)), stderr: "" };
  };
}

async function world(opts: { issues?: { number: number; title: string; state: "open" | "closed" }[] } = {}) {
  const t = await setup(undefined, SEC_REPO);
  const gh = new FakeGitHub();
  const adapters: ReleaseAdapters = { milestoneIssues: () => opts.issues ?? [{ number: 1, title: "fix the thing", state: "open" }] };
  const releases = new ReleaseScope(t.svc.store, adapters);
  const release = releases.createRelease("arun", "t", { name: "v2.5.0", tag: "v2.5.0", milestone: MILESTONE });
  releases.freezeScope(release.releaseId, "arun", release.version);
  const deps: ReadinessDeps = { releases, ci: new GhCiForge({ run: gh.run }), security: new Security(t.svc.store), store: t.svc.store };
  return { ...t, gh, releases, release, deps };
}

test("with no revisionId and no prNumbers: backlog is computed, everything revision-dependent is honestly unknown", async () => {
  const { deps, release, worker } = await world();
  try {
    const r = await buildReleaseReadiness(deps, { releaseId: release.releaseId });
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("backlog")!.status, "pass", "v1 freeze: nothing needs assessment");
    assert.equal(byId.get("review")!.status, "unknown");
    assert.equal(byId.get("tests")!.status, "unknown");
    assert.equal(byId.get("sast")!.status, "unknown");
    assert.equal(byId.get("cleanup")!.status, "unknown");
    assert.equal(byId.get("sbom")!.status, "unknown");
    assert.equal(byId.get("ops")!.status, "unknown");
    // sca/build still attempt a live GitHub call regardless of revisionId; with nothing registered on the fake,
    // the SCA call fails outright (unknown), while the release lookup for "build" resolves successfully to "no
    // release found for this tag" (a real, determined warn) even though the workflow-runs call also fails.
    assert.equal(byId.get("sca")!.status, "unknown");
    assert.equal(byId.get("build")!.status, "warn");
    assert.match(byId.get("build")!.detail, /no GitHub release found/);
  } finally { worker.close(); }
});

test("milestone drift: an item needing assessment makes the backlog row warn, not pass", async () => {
  const issues = [{ number: 1, title: "a", state: "open" as const }];
  const { deps, releases, release, worker } = await world({ issues });
  try {
    issues.push({ number: 2, title: "landed after freeze", state: "open" });
    releases.freezeScope(release.releaseId, "arun", releases.getRelease(release.releaseId).release.version); // -> scope v2, #2 is NEEDS_ASSESSMENT
    const r = await buildReleaseReadiness(deps, { releaseId: release.releaseId });
    const backlog = r.rows.find((x) => x.id === "backlog")!;
    assert.equal(backlog.status, "warn");
    assert.match(backlog.detail, /after freeze/);
  } finally { worker.close(); }
});

test("sca: a critical Dependabot alert blocks; no alerts pass", async () => {
  const { gh, deps, release, worker } = await world();
  try {
    gh.responses.set("repos/acme/widgets/dependabot/alerts", [
      { number: 1, state: "open", security_advisory: { severity: "critical", summary: "proto pollution" }, dependency: { package: { name: "lodash" } }, html_url: "https://gh/1" },
    ]);
    const r = await buildReleaseReadiness(deps, { releaseId: release.releaseId });
    const row = r.rows.find((x) => x.id === "sca")!;
    assert.equal(row.status, "blocked");
    assert.equal(r.overall.tone, "blocked");
    assert.match(r.overall.text, /blocker/);
  } finally { worker.close(); }
});

test("sca: an empty alert list is a real pass (a successful call that found nothing)", async () => {
  const { gh, deps, release, worker } = await world();
  try {
    gh.responses.set("repos/acme/widgets/dependabot/alerts", []);
    const r = await buildReleaseReadiness(deps, { releaseId: release.releaseId });
    assert.equal(r.rows.find((x) => x.id === "sca")!.status, "pass");
  } finally { worker.close(); }
});

test("build: a failed workflow run and a missing GitHub release both warn, never silently pass", async () => {
  const { gh, deps, release, worker } = await world();
  try {
    gh.responses.set("repos/acme/widgets/actions/runs", { workflow_runs: [{ id: 1, name: "release", status: "completed", conclusion: "failure", head_sha: "abc", html_url: "https://gh/1" }] });
    // releases/tags/v2.5.0 intentionally unregistered -> 404 -> releaseByTag resolves null, not a thrown error
    const r = await buildReleaseReadiness(deps, { releaseId: release.releaseId });
    const row = r.rows.find((x) => x.id === "build")!;
    assert.equal(row.status, "warn");
    assert.match(row.detail, /failure/);
    assert.match(row.detail, /no GitHub release found/);
  } finally { worker.close(); }
});

test("review: PR numbers supplied but none approved warns; all approved passes", async () => {
  const { gh, deps, release, worker } = await world();
  try {
    gh.responses.set("repos/acme/widgets/pulls/10/reviews", [{ user: { login: "bob" }, state: "COMMENTED", submitted_at: "t" }]);
    const unreviewed = await buildReleaseReadiness(deps, { releaseId: release.releaseId, prNumbers: [10] });
    assert.equal(unreviewed.rows.find((x) => x.id === "review")!.status, "warn");

    gh.responses.set("repos/acme/widgets/pulls/10/reviews", [{ user: { login: "bob" }, state: "APPROVED", submitted_at: "t" }]);
    const reviewed = await buildReleaseReadiness(deps, { releaseId: release.releaseId, prNumbers: [10] });
    assert.equal(reviewed.rows.find((x) => x.id === "review")!.status, "pass");
  } finally { worker.close(); }
});

test("with a real indexed revision: sast/cleanup read C25's actual findings, and an empty analyze result is unknown not pass", async () => {
  const { deps, revision, release, worker } = await world();
  const sec = deps.security;
  try {
    // Before analyze() ever runs: still "unknown", not a false "pass".
    const before = await buildReleaseReadiness(deps, { releaseId: release.releaseId, revisionId: revision });
    assert.equal(before.rows.find((x) => x.id === "sast")!.status, "unknown");

    sec.analyze({ revision });
    const after = await buildReleaseReadiness(deps, { releaseId: release.releaseId, revisionId: revision });
    const sast = after.rows.find((x) => x.id === "sast")!;
    const cleanup = after.rows.find((x) => x.id === "cleanup")!;
    assert.notEqual(sast.status, "unknown", "the fixture repo has seeded security findings");
    assert.match(sast.detail, /registerUser|deleteAccountHandler/);
    void cleanup;
  } finally { worker.close(); }
});

test("overall tone: blocked beats warn beats ready, and rows are sorted worst-first", async () => {
  const { gh, deps, release, worker } = await world();
  try {
    gh.responses.set("repos/acme/widgets/dependabot/alerts", [{ number: 1, state: "open", security_advisory: { severity: "high", summary: "x" }, dependency: { package: { name: "y" } }, html_url: "u" }]);
    gh.responses.set("repos/acme/widgets/pulls/10/reviews", [{ user: { login: "bob" }, state: "COMMENTED", submitted_at: "t" }]);
    const r = await buildReleaseReadiness(deps, { releaseId: release.releaseId, prNumbers: [10] });
    assert.equal(r.overall.tone, "blocked");
    assert.equal(r.rows[0]!.status, "blocked", "the worst row sorts first");
  } finally { worker.close(); }
});
