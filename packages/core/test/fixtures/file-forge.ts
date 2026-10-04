// A recording GitHub that survives a process kill: the crash-resume test needs the "PR already created" state to be
// visible to the process that resumes, exactly as a real forge would be. One JSON file, one PR per head branch.
import { readFileSync, writeFileSync } from "node:fs";

export interface FileForgePr { repository: string; headBranch: string; number: number; url: string; headHash: string; draft: boolean; body: string }

export function fileForge(path: string) {
  const read = (): FileForgePr[] => { try { return JSON.parse(readFileSync(path, "utf8")) as FileForgePr[]; } catch { return []; } };
  const write = (prs: FileForgePr[]) => writeFileSync(path, JSON.stringify(prs, null, 2));
  return {
    async resolve(_repository: string, _baseBranch: string, headBranch: string) {
      void headBranch;
      return { baseHash: "base", headHash: null as string | null };
    },
    async find(p: { headBranch: string }) { return read().find((x) => x.headBranch === p.headBranch) ?? null; },
    async createDraft(p: { repository: string; headBranch: string; headHash: string }, body: string) {
      const prs = read();
      const existing = prs.find((x) => x.headBranch === p.headBranch);
      if (existing) return existing;
      const pr = { repository: p.repository, headBranch: p.headBranch, number: prs.length + 1, url: `https://example.invalid/pr/${prs.length + 1}`, headHash: p.headHash, draft: true, body };
      prs.push(pr);
      write(prs);
      return pr;
    },
  };
}
