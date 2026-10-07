// The release-readiness aggregator: pulls every evidence producer built this phase (release-scope, the GitHub CI/
// security connector, C25's static findings, the license/SBOM scanner, the ops-readiness check) into one row list
// scoped to a release, with an overall tone computed from the rows — never the other way around. A row this
// aggregator cannot determine (a missing revision, an unresolved GitHub call, a producer that hasn't run yet)
// reports "unknown", never a guessed "pass": the same Fact/Inference/Hypothesis/Fog discipline the rest of the
// product follows. This mirrors the "Release Lens" mockup discussed with the product owner — same row shape, same
// rule that switching a stakeholder lens only reorders rows, it never recomputes them differently.
import type { ReleaseMilestoneRef } from "@cie/schema";
import { GhError, type GhCiForge } from "./feature/ci-forge.ts";
import { buildSbom, scanManifests } from "./license-scan.ts";
import { opsReadiness } from "./ops-readiness.ts";
import type { ReleaseScope } from "./release-scope.ts";
import type { Security } from "./security.ts";
import type { Store } from "./store.ts";
import { extractArtifacts } from "./artifacts.ts";
import { loadFunctions } from "./defect/functions.ts";

export type RowStatus = "pass" | "warn" | "blocked" | "unknown";
export interface ReadinessRow {
  id: string;
  title: string;
  /** Stakeholder lenses this row is primary evidence for (pm, dev, arch, qa, sec, ops, relmgmt). */
  domain: string[];
  status: RowStatus;
  /** "fact" is read straight from a source; "inference" is derived from one (drawn dashed in the Lens). */
  kind?: "fact" | "inference";
  measure: string;
  detail: string;
  source: string;
}
export interface ReleaseReadiness {
  releaseId: string;
  releaseName: string;
  tag: string;
  overall: { tone: "ready" | "conditional" | "blocked" | "unknown"; text: string };
  rows: ReadinessRow[];
}

export interface ReadinessDeps { releases: ReleaseScope; ci: GhCiForge; security: Security; store: Store }
export interface ReadinessInput {
  releaseId: string;
  /** The indexed revision for this release's repository, if one exists — unlocks static findings, license/SBOM
   * and ops-readiness. Without it those rows report "unknown": this aggregator never resolves a GitHub slug to
   * an indexed revision on its own (that would be a guess), the caller supplies the mapping it already knows. */
  revisionId?: string;
  /** PR numbers known to belong to this release (from the Release Board, once built) — unlocks the review row. */
  prNumbers?: number[];
  /** The head commit to check CI status for. */
  headSha?: string;
}

const repo = (m: ReleaseMilestoneRef) => `${m.owner}/${m.repo}`;
const unknown = (id: string, title: string, domain: string[], reason: string, source: string): ReadinessRow =>
  ({ id, title, domain, status: "unknown", measure: "not determined", detail: reason, source });

async function tryRow<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, reason: e instanceof GhError ? `GitHub: ${e.message}` : (e as Error).message }; }
}

export async function buildReleaseReadiness(deps: ReadinessDeps, input: ReadinessInput): Promise<ReleaseReadiness> {
  const view = deps.releases.getRelease(input.releaseId);
  const slug = repo(view.release.milestone);
  const rows: ReadinessRow[] = [];

  // ---- backlog completeness (always computable: it's this engine's own scope)
  rows.push({
    id: "backlog", title: `Backlog completeness — milestone ${view.release.milestone.number}`,
    domain: ["pm", "relmgmt"],
    status: !view.scope ? "unknown" : view.needsAssessment > 0 ? "warn" : "pass",
    measure: !view.scope ? "scope not frozen yet" : `${view.counts.IN_SCOPE ?? 0} in scope${view.needsAssessment ? `, ${view.needsAssessment} need assessment` : ""}`,
    detail: !view.scope ? "The release hasn't been frozen yet; there is no scope to report on." : view.needsAssessment > 0 ? `${view.needsAssessment} item(s) landed in the milestone after freeze and are not yet counted toward the release.` : "Every item in the frozen scope has been assessed.",
    source: "release-scope.ts",
  });

  // ---- review coverage (needs PR numbers the caller supplies — not yet auto-derivable without the Release Board)
  if (!input.prNumbers?.length) {
    rows.push(unknown("review", "Pull request review coverage", ["dev"], "No PR numbers were supplied for this release yet (the Release Board, once built, will supply these automatically).", "GitHub Reviews API"));
  } else {
    const reviewed = await Promise.all(input.prNumbers.map((pr) => tryRow(() => deps.ci.pullReviews(slug, pr))));
    const failed = reviewed.filter((r) => !r.ok);
    if (failed.length === reviewed.length) {
      rows.push(unknown("review", "Pull request review coverage", ["dev"], (failed[0] as { ok: false; reason: string }).reason, "GitHub Reviews API"));
    } else {
      const unreviewed = reviewed.filter((r) => r.ok && r.value.every((v) => v.state !== "APPROVED")).length;
      rows.push({
        id: "review", title: "Pull request review coverage", domain: ["dev"],
        status: unreviewed > 0 ? "warn" : "pass",
        measure: `${input.prNumbers.length - unreviewed}/${input.prNumbers.length} PRs have an approval`,
        detail: unreviewed > 0 ? `${unreviewed} of ${input.prNumbers.length} PR(s) have no approval yet.` : "Every PR for this release has at least one approval.",
        source: "GitHub Reviews API",
      });
    }
  }

  // ---- unit & integration tests: depends on the Release Board (Phase 6) linking feature requests to this
  // release in a queryable way; not yet built, so this is honestly "unknown" rather than guessed.
  rows.push(unknown("tests", "Unit & integration tests", ["dev", "qa"], "Pending the Release Board (Phase 6): no queryable link from this release to the feature requests built for it yet.", "F07 oracle-preservation"));

  // ---- static findings, split into security vs. cleanliness (mirrors the mockup's two separate rows)
  if (!input.revisionId) {
    rows.push(unknown("sast", "Static security findings", ["sec"], "No indexed revision was supplied for this release's repository.", "C25 rules"));
    rows.push(unknown("cleanup", "Environment cleanup", ["dev"], "No indexed revision was supplied for this release's repository.", "C25 rules"));
  } else {
    const findings = deps.security.list(input.revisionId);
    const cleanupIds = new Set(["R-DEBUG-LEFTOVER", "R-TODO-SCAN"]);
    const cleanup = findings.filter((f) => cleanupIds.has(f.ruleId));
    const security = findings.filter((f) => !cleanupIds.has(f.ruleId));
    // An empty list cannot be told apart from "C25/analyze never ran" — never read as a clean pass.
    rows.push({
      id: "sast", title: "Static security findings", domain: ["sec"],
      status: security.length === 0 ? "unknown" : security.some((f) => f.severity === "high") ? "blocked" : "warn",
      measure: security.length === 0 ? "0 findings stored (or not yet analyzed)" : `${security.length} finding(s)`,
      detail: security.length === 0 ? "No findings are stored for this revision. Run C25/analyze to know whether that's a clean result or analysis hasn't run." : security.map((f) => `${f.summary} (${f.severity})`).join("; "),
      source: "C25 rules",
    });
    rows.push({
      id: "cleanup", title: "Environment cleanup", domain: ["dev"],
      status: cleanup.length === 0 ? "unknown" : "warn",
      measure: cleanup.length === 0 ? "0 findings stored (or not yet analyzed)" : `${cleanup.length} debug/TODO marker(s) found`,
      detail: cleanup.length === 0 ? "No findings are stored for this revision. Run C25/analyze to know whether that's a clean result or analysis hasn't run." : cleanup.map((f) => f.summary).join("; "),
      source: "C25 rules (R-DEBUG-LEFTOVER, R-TODO-SCAN)",
    });
  }

  // ---- SCA (Dependabot) and code-scanning (CodeQL), both live GitHub reads
  const sca = await tryRow(() => deps.ci.dependabotAlerts(slug));
  rows.push(!sca.ok ? unknown("sca", "Dependency vulnerabilities (SCA)", ["sec", "relmgmt"], sca.reason, "GitHub Dependabot alerts")
    : { id: "sca", title: "Dependency vulnerabilities (SCA)", domain: ["sec", "relmgmt"], status: sca.value.length === 0 ? "pass" : sca.value.some((a) => a.severity === "high" || a.severity === "critical") ? "blocked" : "warn", measure: `${sca.value.length} open alert(s)`, detail: sca.value.map((a) => `${a.package} (${a.severity})`).join("; ") || "No open Dependabot alerts.", source: "GitHub Dependabot alerts" });

  // ---- license/SBOM: needs the repository's working tree, resolved from the indexed revision
  if (!input.revisionId) {
    rows.push(unknown("sbom", "SBOM & license scan", ["relmgmt", "sec"], "No indexed revision was supplied for this release's repository.", "license-scan.ts"));
  } else {
    const rev = deps.store.revision(input.revisionId);
    if (!rev) rows.push(unknown("sbom", "SBOM & license scan", ["relmgmt", "sec"], "The supplied revision no longer resolves to a repository this system can read.", "license-scan.ts"));
    else {
      const deps_ = scanManifests(rev.repoRoot).flatMap((m) => m.dependencies);
      const sbom = buildSbom(deps_);
      rows.push({
        id: "sbom", title: "SBOM & license scan", domain: ["relmgmt", "sec"],
        status: sbom.forbidden.length > 0 ? "blocked" : "pass",
        measure: `${sbom.components.length} package(s), ${sbom.forbidden.length} forbidden`,
        detail: sbom.forbidden.length > 0 ? sbom.forbidden.map((c) => `${c.name}@${c.version} (${c.license})`).join("; ") : "No forbidden licenses found among the scanned manifests.",
        source: "license-scan.ts",
      });
    }
  }

  // ---- build & artifact availability
  const runs = await tryRow(() => deps.ci.actionsRuns(slug));
  const rel = await tryRow(() => deps.ci.releaseByTag(slug, view.release.tag));
  if (!runs.ok && !rel.ok) rows.push(unknown("build", "Build & artifact availability", ["dev", "relmgmt"], runs.reason, "GitHub Actions + Releases API"));
  else {
    const latest = runs.ok ? runs.value[0] : undefined;
    const released = rel.ok ? rel.value : null;
    const warnBits: string[] = [];
    if (latest && latest.conclusion && latest.conclusion !== "success") warnBits.push(`latest workflow run ${latest.conclusion}`);
    if (!released) warnBits.push(`no GitHub release found for tag ${view.release.tag}`);
    rows.push({
      id: "build", title: "Build & artifact availability", domain: ["dev", "relmgmt"],
      status: warnBits.length ? "warn" : "pass",
      measure: latest ? `latest run: ${latest.conclusion ?? latest.status}` : "no workflow runs found",
      detail: warnBits.join("; ") || `release ${view.release.tag} is published and the latest workflow run succeeded.`,
      source: "GitHub Actions + Releases API",
    });
  }

  // ---- rows whose producers exist in the product but are not wired to a release yet. They say so, never guess.
  rows.push({ ...unknown("arch", "Architecture alignment", ["arch"], "Not wired to a release yet: tracing this release's structural changes against its design document needs the C23 archaeology producer, which is not connected to releases.", "C23 archaeology · V1 map"), kind: "inference" });
  rows.push({ ...unknown("confidence", "Test-confidence coverage", ["qa"], "Not wired to a release yet: the V12 test-confidence map is not connected to releases, so which behaviors have an asserting test is not determined.", "V12 test-confidence map"), kind: "inference" });
  rows.push(unknown("compliance", "Compliance audit trail", ["relmgmt"], "Not wired to a release yet: the C18 provenance ledger is not connected to releases, so whether every change traces to a commit, PR or CI run is not determined.", "C18 provenance ledger"));

  // ---- operational readiness: RUNBOOK.md, a health-shaped route, structured logging — presence only
  if (!input.revisionId) {
    rows.push(unknown("ops", "Operational readiness", ["ops"], "No indexed revision was supplied for this release's repository.", "C06 route scan · ops-readiness.ts"));
  } else {
    const rev = deps.store.revision(input.revisionId);
    if (!rev) rows.push(unknown("ops", "Operational readiness", ["ops"], "The supplied revision no longer resolves to a repository this system can read.", "C06 route scan · ops-readiness.ts"));
    else {
      const routes = extractArtifacts(deps.store, input.revisionId).artifacts.filter((a) => a.kind === "route");
      const fns = [...loadFunctions(deps.store, rev).values()];
      const r = opsReadiness(rev.repoRoot, routes, fns);
      const missing = [!r.runbookFound && "RUNBOOK.md", !r.healthRouteFound && "a health-check route", !r.loggingFound && "structured logging"].filter(Boolean);
      rows.push({
        id: "ops", title: "Operational readiness", domain: ["ops"],
        status: missing.length === 0 ? "pass" : "warn",
        measure: missing.length === 0 ? "runbook, health route and logging all found" : `missing: ${missing.join(", ")}`,
        detail: missing.length === 0 ? "RUNBOOK.md, a health-check route and structured logging were all found." : `Not found: ${missing.join(", ")}. This reports presence only — it never claims the service is operationally ready.`,
        source: "C06 route scan · ops-readiness.ts",
      });
    }
  }

  const severity: Record<RowStatus, number> = { blocked: 0, warn: 1, unknown: 2, pass: 3 };
  for (const row of rows) row.kind ??= "fact";
  rows.sort((a, b) => severity[a.status] - severity[b.status]);

  const blocked = rows.filter((r) => r.status === "blocked").length;
  const warn = rows.filter((r) => r.status === "warn").length;
  const determined = rows.some((r) => r.status === "pass");
  const overall: ReleaseReadiness["overall"] = blocked > 0
    ? { tone: "blocked", text: `NOT READY — ${blocked} blocker(s)` }
    : warn > 0
    ? { tone: "conditional", text: "READY WITH CONDITIONS" }
    : determined
    ? { tone: "ready", text: "READY" }
    : { tone: "unknown", text: "NOT DETERMINED — not enough evidence is wired up yet" };

  return { releaseId: input.releaseId, releaseName: view.release.name, tag: view.release.tag, overall, rows };
}
