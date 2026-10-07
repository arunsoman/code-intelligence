// GitHub CI/security signal reads for the release-readiness ledger: PR review state, commit check-runs, Dependabot
// alerts, code-scanning (CodeQL) alerts, workflow runs and releases. A sibling to GhIssueForge (issue-forge.ts), not
// an addition to it — that class's own header restricts it to issues; this one is read-only CI/security evidence.
// Nothing here writes anything. Same injected-runner pattern as issue-forge.ts, so tests use a scripted GitHub.
import { classifyGhFailure, GhError, type GhRunner } from "../gh-forge.ts";
import { execFileSync } from "node:child_process";

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
export interface ReviewSummary { reviewer: string; state: ReviewState; submittedAt: string }

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | "stale" | null;
export interface CheckRunSummary { name: string; status: "queued" | "in_progress" | "completed"; conclusion: CheckConclusion; detailsUrl: string }

export type AlertSeverity = "low" | "medium" | "high" | "critical" | "unknown";
export interface DependabotAlertSummary { number: number; state: "open" | "dismissed" | "fixed" | "auto_dismissed"; severity: AlertSeverity; package: string; summary: string; htmlUrl: string }
export interface CodeScanningAlertSummary { number: number; state: "open" | "dismissed" | "fixed"; severity: AlertSeverity; rule: string; description: string; htmlUrl: string }

export interface WorkflowRunSummary { id: number; name: string; status: string; conclusion: string | null; headSha: string; htmlUrl: string }
export interface ReleaseSummary { tagName: string; name: string; draft: boolean; publishedAt: string | null; htmlUrl: string }

export interface CiForge {
  pullReviews(repo: string, pr: number): Promise<ReviewSummary[]>;
  checkRuns(repo: string, sha: string): Promise<CheckRunSummary[]>;
  dependabotAlerts(repo: string): Promise<DependabotAlertSummary[]>;
  codeScanningAlerts(repo: string): Promise<CodeScanningAlertSummary[]>;
  actionsRuns(repo: string, workflow?: string): Promise<WorkflowRunSummary[]>;
  releaseByTag(repo: string, tag: string): Promise<ReleaseSummary | null>;
}

const defaultRunner = (timeoutMs: number): GhRunner => (args) => {
  try { return { status: 0, stdout: execFileSync("gh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
  catch (e) { const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }; return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") }; }
};
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const severity = (s: unknown): AlertSeverity => (s === "low" || s === "medium" || s === "high" || s === "critical" ? s : "unknown");

export class GhCiForge implements CiForge {
  private readonly run: GhRunner;
  constructor(opts: { run?: GhRunner; timeoutMs?: number } = {}) { this.run = opts.run ?? defaultRunner(opts.timeoutMs ?? 30_000); }
  private repo(r: string): string { if (!REPO.test(r)) throw new GhError("NOT_FOUND", `"${r.slice(0, 60)}" is not an owner/name repository`); return r; }
  private api(args: string[]): any {
    const res = this.run(["api", ...args]);
    if (res.status !== 0) throw classifyGhFailure(res.status, res.stderr);
    try { return JSON.parse(res.stdout || "null"); } catch { throw new GhError("UNREACHABLE", "gh returned output that is not JSON"); }
  }

  async pullReviews(repo: string, pr: number): Promise<ReviewSummary[]> {
    const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/pulls/${Math.trunc(pr)}/reviews`, "-f", "per_page=100"]);
    return (Array.isArray(j) ? j : []).map((r: any) => ({ reviewer: String(r.user?.login ?? ""), state: String(r.state ?? "PENDING") as ReviewState, submittedAt: String(r.submitted_at ?? "") }));
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRunSummary[]> {
    const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/commits/${sha}/check-runs`, "-f", "per_page=100"]);
    return (Array.isArray(j?.check_runs) ? j.check_runs : []).map((r: any) => ({
      name: String(r.name ?? ""), status: String(r.status ?? "queued") as CheckRunSummary["status"],
      conclusion: (r.conclusion ?? null) as CheckConclusion, detailsUrl: String(r.details_url ?? r.html_url ?? ""),
    }));
  }

  async dependabotAlerts(repo: string): Promise<DependabotAlertSummary[]> {
    const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/dependabot/alerts`, "-f", "state=open", "-f", "per_page=100"]);
    return (Array.isArray(j) ? j : []).map((a: any) => ({
      number: Number(a.number), state: String(a.state ?? "open") as DependabotAlertSummary["state"],
      severity: severity(a.security_advisory?.severity), package: String(a.dependency?.package?.name ?? ""),
      summary: String(a.security_advisory?.summary ?? ""), htmlUrl: String(a.html_url ?? ""),
    }));
  }

  async codeScanningAlerts(repo: string): Promise<CodeScanningAlertSummary[]> {
    const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/code-scanning/alerts`, "-f", "state=open", "-f", "per_page=100"]);
    return (Array.isArray(j) ? j : []).map((a: any) => ({
      number: Number(a.number), state: String(a.state ?? "open") as CodeScanningAlertSummary["state"],
      severity: severity(a.rule?.security_severity_level ?? a.rule?.severity), rule: String(a.rule?.id ?? ""),
      description: String(a.rule?.description ?? ""), htmlUrl: String(a.html_url ?? ""),
    }));
  }

  async actionsRuns(repo: string, workflow?: string): Promise<WorkflowRunSummary[]> {
    const path = workflow ? `repos/${this.repo(repo)}/actions/workflows/${workflow}/runs` : `repos/${this.repo(repo)}/actions/runs`;
    const j = this.api(["-X", "GET", path, "-f", "per_page=20"]);
    return (Array.isArray(j?.workflow_runs) ? j.workflow_runs : []).map((r: any) => ({
      id: Number(r.id), name: String(r.name ?? ""), status: String(r.status ?? ""), conclusion: r.conclusion ?? null,
      headSha: String(r.head_sha ?? ""), htmlUrl: String(r.html_url ?? ""),
    }));
  }

  async releaseByTag(repo: string, tag: string): Promise<ReleaseSummary | null> {
    try {
      const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/releases/tags/${encodeURIComponent(tag)}`]);
      if (!j) return null;
      return { tagName: String(j.tag_name ?? tag), name: String(j.name ?? ""), draft: j.draft === true, publishedAt: j.published_at ?? null, htmlUrl: String(j.html_url ?? "") };
    } catch (e) {
      if (e instanceof GhError && e.state === "NOT_FOUND") return null;
      throw e;
    }
  }
}
export { GhError };
