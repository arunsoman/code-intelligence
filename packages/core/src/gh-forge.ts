// The real `gh`-backed DraftForge (F07 WP-09). CIE already authenticates GitHub through the `gh` CLI (`gh.ts`,
// `ghAuthStatus`), so the draft publisher uses the same credential mechanism rather than inventing a token store.
//
// The command runner is injected: production passes the `gh` binary, and the test passes a scripted one, which is how
// the draft-only rule, the find-before-create idempotency and the "never merge" property are checked without network.
// Nothing here can merge, approve, dispatch a workflow or write a protected branch: the only write it issues is a
// create-pull-request call with `draft=true`, and it verifies the receipt it gets back.
import { execFileSync } from "node:child_process";
import type { DraftForge } from "./defect-workflow.ts";

export interface GhReceipt { number: number; url: string; headHash: string; draft: boolean }

/** A `gh` invocation: the args (never a shell string) and what came back. */
export interface GhRunner { (args: string[]): { status: number; stdout: string; stderr: string } }

export interface GhForgeOptions {
  /** Defaults to the real `gh` binary run without a shell and with a timeout. */
  run?: GhRunner;
  timeoutMs?: number;
}

export class GhError extends Error {
  readonly state: "EXPIRED" | "RATE_LIMITED" | "UNREACHABLE" | "NOT_FOUND" | "REFUSED";
  constructor(state: GhError["state"], message: string) {
    super(message);
    this.name = "GhError";
    this.state = state;
  }
}

const defaultRunner = (timeoutMs: number): GhRunner => (args) => {
  try {
    const stdout = execFileSync("gh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
  }
};

/** Map `gh`'s wording onto the connector-state vocabulary the rest of the product already uses. */
export function classifyGhFailure(status: number, stderr: string): GhError {
  if (/rate limit|secondary rate/i.test(stderr)) return new GhError("RATE_LIMITED", "GitHub rate limit reached; the task stays review-ready and the retry is idempotent");
  if (/authentication|bad credentials|401|token.*expired/i.test(stderr)) return new GhError("EXPIRED", "The GitHub credential is missing or expired; run `gh auth login` and retry");
  if (/404|not found/i.test(stderr)) return new GhError("NOT_FOUND", "The repository or ref was not found for this credential");
  if (/403|forbidden|refusing/i.test(stderr)) return new GhError("REFUSED", "GitHub refused the write; CIE only creates draft pull requests and never merges");
  return new GhError("UNREACHABLE", `gh exited ${status}: ${stderr.slice(0, 200)}`);
}

interface GhPull { number: number; html_url: string; draft?: boolean; head?: { sha?: string }; state?: string }

export class GhDraftForge implements DraftForge {
  private readonly run: GhRunner;
  constructor(opts: GhForgeOptions = {}) {
    this.run = opts.run ?? defaultRunner(opts.timeoutMs ?? 30_000);
  }

  private api(args: string[]): unknown {
    const res = this.run(["api", ...args]);
    if (res.status !== 0) throw classifyGhFailure(res.status, res.stderr);
    try { return JSON.parse(res.stdout || "null"); } catch { throw new GhError("UNREACHABLE", "gh returned output that is not JSON"); }
  }

  private ref(repository: string, branch: string): string | null {
    const res = this.run(["api", `repos/${repository}/git/ref/heads/${branch}`]);
    if (res.status !== 0) {
      if (/404|not found/i.test(res.stderr)) return null;
      throw classifyGhFailure(res.status, res.stderr);
    }
    const parsed = JSON.parse(res.stdout || "{}") as { object?: { sha?: string } };
    return parsed.object?.sha ?? null;
  }

  async resolve(repository: string, baseBranch: string, headBranch: string): Promise<{ baseHash: string; headHash: string | null }> {
    const baseHash = this.ref(repository, baseBranch);
    if (!baseHash) throw new GhError("NOT_FOUND", `the base branch ${baseBranch} does not exist in ${repository}`);
    return { baseHash, headHash: this.ref(repository, headBranch) };
  }

  async find(publication: { repository: string; headBranch: string }): Promise<GhReceipt | null> {
    // Listing by head is the find-before-create step: a resumed publication must adopt the PR it already created.
    const owner = publication.repository.split("/")[0] ?? "";
    const pulls = this.api(["-X", "GET", `repos/${publication.repository}/pulls`, "-f", `head=${owner}:${publication.headBranch}`, "-f", "state=all", "-f", "per_page=20"]) as GhPull[];
    const open = (Array.isArray(pulls) ? pulls : []).find((p) => p.head?.sha);
    if (!open) return null;
    return { number: open.number, url: open.html_url, headHash: open.head?.sha ?? "", draft: open.draft === true };
  }

  async createDraft(publication: { repository: string; baseBranch: string; headBranch: string; headHash: string }, body: string): Promise<GhReceipt> {
    const title = (body.match(/^## (.+)$/m)?.[1] ?? "CIE task").slice(0, 120);
    const pulls = this.api([
      "-X", "POST", `repos/${publication.repository}/pulls`,
      "-f", `title=${title}`, "-f", `head=${publication.headBranch}`, "-f", `base=${publication.baseBranch}`,
      "-f", "draft=true", "-f", `body=${body}`,
    ]) as GhPull;
    const receipt: GhReceipt = { number: pulls.number, url: pulls.html_url, headHash: pulls.head?.sha ?? publication.headHash, draft: pulls.draft === true };
    // The receipt is verified here rather than trusted: a non-draft PR from any cause is an error, not a "published" event.
    if (!receipt.draft) throw new GhError("REFUSED", "GitHub returned a pull request that is not a draft; CIE's authority ends at a draft");
    if (receipt.headHash !== publication.headHash) throw new GhError("REFUSED", "the pull request's head is not the validated candidate head");
    return receipt;
  }
}
