// Task 2.O — the GitHub issue surface behind the issue trail. Like gh-forge.ts it takes an injected `gh` runner (arguments, never a
// shell string), so tests use a scripted GitHub. Nothing here can merge, approve or delete: it reads issues and labels, creates an
// issue, edits ONE issue's body/state, and adds comments. It never creates or edits labels (repository conventions are not ours to change).
import { classifyGhFailure, GhError, type GhRunner } from "../gh-forge.ts";
import { execFileSync } from "node:child_process";

export interface RemoteIssue { number: number; nodeId: string; title: string; body: string; state: "open" | "closed"; locked: boolean; updatedAt: string; isPullRequest: boolean }
export interface RemoteComment { id: number; body: string }

export interface IssueForge {
  repoInfo(repo: string): Promise<{ private: boolean }>;
  labels(repo: string): Promise<string[]>;
  findIssue(repo: string, marker: string): Promise<RemoteIssue | null>;
  getIssue(repo: string, number: number): Promise<RemoteIssue>;
  createIssue(repo: string, i: { title: string; body: string; labels: string[] }): Promise<RemoteIssue>;
  updateIssue(repo: string, number: number, patch: { body?: string; state?: "open" | "closed"; stateReason?: "completed" | "not_planned" }): Promise<RemoteIssue>;
  recentComments(repo: string, number: number): Promise<RemoteComment[]>;
  createComment(repo: string, number: number, body: string): Promise<RemoteComment>;
}

const defaultRunner = (timeoutMs: number): GhRunner => (args) => {
  try { return { status: 0, stdout: execFileSync("gh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
  catch (e) { const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }; return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") }; }
};
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export class GhIssueForge implements IssueForge {
  private readonly run: GhRunner;
  constructor(opts: { run?: GhRunner; timeoutMs?: number } = {}) { this.run = opts.run ?? defaultRunner(opts.timeoutMs ?? 30_000); }
  private repo(r: string): string { if (!REPO.test(r)) throw new GhError("NOT_FOUND", `"${r.slice(0, 60)}" is not an owner/name repository`); return r; }
  private api(args: string[]): any {
    const res = this.run(["api", ...args]);
    if (res.status !== 0) throw classifyGhFailure(res.status, res.stderr);
    try { return JSON.parse(res.stdout || "null"); } catch { throw new GhError("UNREACHABLE", "gh returned output that is not JSON"); }
  }
  private issue(j: any): RemoteIssue { return { number: j.number, nodeId: String(j.node_id ?? ""), title: String(j.title ?? ""), body: String(j.body ?? ""), state: j.state === "closed" ? "closed" : "open", locked: j.locked === true, updatedAt: String(j.updated_at ?? ""), isPullRequest: !!j.pull_request }; }
  async repoInfo(repo: string) { const j = this.api([`repos/${this.repo(repo)}`]); return { private: j?.private === true }; }
  async labels(repo: string) { const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/labels`, "-f", "per_page=100"]); return (Array.isArray(j) ? j : []).map((l: any) => String(l.name)); }
  async findIssue(repo: string, marker: string) {
    const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/issues`, "-f", "state=all", "-f", "per_page=100", "-f", "sort=created", "-f", "direction=desc"]);
    const hit = (Array.isArray(j) ? j : []).find((x: any) => !x.pull_request && String(x.body ?? "").includes(marker));
    return hit ? this.issue(hit) : null;
  }
  async getIssue(repo: string, number: number) { return this.issue(this.api([`repos/${this.repo(repo)}/issues/${Math.trunc(number)}`])); }
  async createIssue(repo: string, i: { title: string; body: string; labels: string[] }) {
    return this.issue(this.api(["-X", "POST", `repos/${this.repo(repo)}/issues`, "-f", `title=${i.title}`, "-f", `body=${i.body}`, ...i.labels.flatMap((l) => ["-f", `labels[]=${l}`])]));
  }
  async updateIssue(repo: string, number: number, p: { body?: string; state?: "open" | "closed"; stateReason?: "completed" | "not_planned" }) {
    const args = ["-X", "PATCH", `repos/${this.repo(repo)}/issues/${Math.trunc(number)}`];
    if (p.body !== undefined) args.push("-f", `body=${p.body}`); if (p.state) args.push("-f", `state=${p.state}`); if (p.stateReason) args.push("-f", `state_reason=${p.stateReason}`);
    return this.issue(this.api(args));
  }
  async recentComments(repo: string, number: number) { const j = this.api(["-X", "GET", `repos/${this.repo(repo)}/issues/${Math.trunc(number)}/comments`, "-f", "per_page=100"]); return (Array.isArray(j) ? j : []).map((c: any) => ({ id: Number(c.id), body: String(c.body ?? "") })); }
  async createComment(repo: string, number: number, body: string) { const j = this.api(["-X", "POST", `repos/${this.repo(repo)}/issues/${Math.trunc(number)}/comments`, "-f", `body=${body}`]); return { id: Number(j.id), body: String(j.body ?? body) }; }
}
export { GhError };
