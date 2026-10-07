// A scripted GitHub whose "remote" is the demo repository itself, so branches really exist and heads are real commits.
import { execFileSync } from "node:child_process";
import type { DraftForge } from "../src/defect-workflow.ts";

const git = (repo: string, ...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export class Forge implements DraftForge {
  prs: { number: number; url: string; headHash: string; draft: boolean }[] = []; creates = 0; repo: string;
  constructor(repo: string) { this.repo = repo; }
  async resolve(_r: string, base: string, head: string) { let h: string | null = null; try { h = git(this.repo, "rev-parse", `refs/heads/${head}`); } catch { /* absent */ } return { baseHash: git(this.repo, "rev-parse", base), headHash: h }; }
  async find(p: { headBranch: string }) { let h = ""; try { h = git(this.repo, "rev-parse", `refs/heads/${p.headBranch}`); } catch { /* absent */ } const pr = this.prs.at(-1); return pr ? { ...pr, headHash: h } : null; }
  async createDraft(p: { headHash: string }) { this.creates++; const pr = { number: 40 + this.creates, url: `https://github.com/acme/transactions/pull/${40 + this.creates}`, headHash: p.headHash, draft: true }; this.prs.push(pr); return pr; }
}
