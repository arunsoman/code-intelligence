// GhCiForge reads (reviews, check-runs, Dependabot alerts, code-scanning alerts, actions runs, releases) against a
// scripted `gh`, mirroring feature-issues.test.ts's fake-GitHub convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GhCiForge, GhError } from "../src/feature/ci-forge.ts";
import type { GhRunner } from "../src/gh-forge.ts";

const REPO = "acme/widgets";

/** A scripted GitHub: one exact JSON response (or failure) per endpoint string. */
class FakeGitHub {
  responses = new Map<string, unknown>();
  failures = new Map<string, string>();
  calls: string[] = [];
  run: GhRunner = (args) => {
    let endpoint = "";
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-X") i++;
      else if (args[i] === "-f") i++;
      else endpoint = args[i]!;
    }
    this.calls.push(endpoint);
    if (this.failures.has(endpoint)) return { status: 1, stdout: "", stderr: this.failures.get(endpoint)! };
    if (!this.responses.has(endpoint)) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    return { status: 0, stdout: JSON.stringify(this.responses.get(endpoint)), stderr: "" };
  };
}

test("pullReviews maps reviewer and state", async () => {
  const gh = new FakeGitHub();
  gh.responses.set(`repos/${REPO}/pulls/42/reviews`, [
    { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-10-01T00:00:00Z" },
    { user: { login: "bob" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-02T00:00:00Z" },
  ]);
  const forge = new GhCiForge({ run: gh.run });
  const reviews = await forge.pullReviews(REPO, 42);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((r) => [r.reviewer, r.state]), [["alice", "APPROVED"], ["bob", "CHANGES_REQUESTED"]]);
});

test("checkRuns reads the nested check_runs array", async () => {
  const gh = new FakeGitHub();
  gh.responses.set(`repos/${REPO}/commits/abc123/check-runs`, {
    check_runs: [{ name: "unit-tests", status: "completed", conclusion: "success", details_url: "https://ci/1" }],
  });
  const forge = new GhCiForge({ run: gh.run });
  const runs = await forge.checkRuns(REPO, "abc123");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.conclusion, "success");
});

test("dependabotAlerts maps severity and package name, unknown severity falls back honestly", async () => {
  const gh = new FakeGitHub();
  gh.responses.set(`repos/${REPO}/dependabot/alerts`, [
    { number: 1, state: "open", security_advisory: { severity: "high", summary: "prototype pollution" }, dependency: { package: { name: "lodash" } }, html_url: "https://gh/1" },
    { number: 2, state: "open", security_advisory: { severity: "weird", summary: "x" }, dependency: { package: { name: "y" } }, html_url: "https://gh/2" },
  ]);
  const forge = new GhCiForge({ run: gh.run });
  const alerts = await forge.dependabotAlerts(REPO);
  assert.equal(alerts[0]!.severity, "high");
  assert.equal(alerts[0]!.package, "lodash");
  assert.equal(alerts[1]!.severity, "unknown", "an unrecognised severity string is never guessed into a known bucket");
});

test("codeScanningAlerts maps rule id and severity", async () => {
  const gh = new FakeGitHub();
  gh.responses.set(`repos/${REPO}/code-scanning/alerts`, [
    { number: 5, state: "open", rule: { id: "js/sql-injection", severity: "error", security_severity_level: "critical", description: "SQL injection" }, html_url: "https://gh/5" },
  ]);
  const forge = new GhCiForge({ run: gh.run });
  const alerts = await forge.codeScanningAlerts(REPO);
  assert.equal(alerts[0]!.rule, "js/sql-injection");
  assert.equal(alerts[0]!.severity, "critical");
});

test("actionsRuns reads the nested workflow_runs array", async () => {
  const gh = new FakeGitHub();
  gh.responses.set(`repos/${REPO}/actions/runs`, { workflow_runs: [{ id: 1, name: "release", status: "completed", conclusion: "success", head_sha: "deadbeef", html_url: "https://gh/run/1" }] });
  const forge = new GhCiForge({ run: gh.run });
  const runs = await forge.actionsRuns(REPO);
  assert.equal(runs[0]!.conclusion, "success");
});

test("releaseByTag returns null rather than throwing on a missing tag", async () => {
  const gh = new FakeGitHub();
  // no response registered for the tag endpoint -> the fake returns a 404, classified as NOT_FOUND
  const forge = new GhCiForge({ run: gh.run });
  const r = await forge.releaseByTag(REPO, "v9.9.9");
  assert.equal(r, null);
});

test("releaseByTag returns the release when found", async () => {
  const gh = new FakeGitHub();
  gh.responses.set(`repos/${REPO}/releases/tags/v2.4.0`, { tag_name: "v2.4.0", name: "v2.4.0", draft: false, published_at: "2026-09-01T00:00:00Z", html_url: "https://gh/rel" });
  const forge = new GhCiForge({ run: gh.run });
  const r = await forge.releaseByTag(REPO, "v2.4.0");
  assert.equal(r?.tagName, "v2.4.0");
  assert.equal(r?.draft, false);
});

test("a malformed repo id is rejected before any call is made", async () => {
  const gh = new FakeGitHub();
  const forge = new GhCiForge({ run: gh.run });
  await assert.rejects(() => forge.pullReviews("not-a-repo", 1), GhError);
  assert.equal(gh.calls.length, 0, "no gh call was attempted for an invalid repo id");
});

test("a rate-limit stderr is classified rather than surfaced as a generic failure", async () => {
  const gh = new FakeGitHub();
  gh.failures.set(`repos/${REPO}/dependabot/alerts`, "API rate limit exceeded for installation");
  const forge = new GhCiForge({ run: gh.run });
  await assert.rejects(() => forge.dependabotAlerts(REPO), (e: unknown) => e instanceof GhError && e.state === "RATE_LIMITED");
});
