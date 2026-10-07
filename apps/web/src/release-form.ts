/** Pure helpers for the Releases wizard, kept out of the component so they can be tested without a DOM. */

/** Accepts `owner/repo`, `/owner/repo/`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)` and
 * returns the pair, or null when the text is not a GitHub repository reference. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  let t = input.trim().replace(/^[a-z]+:\/\//i, "").replace(/^(www\.)?github\.com\//i, "");
  t = t.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = t.split("/");
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  const ok = (s: string | undefined) => !!s && /^[A-Za-z0-9._-]+$/.test(s);
  return ok(owner) && ok(repo) ? { owner: owner!, repo: repo! } : null;
}

export type Selectable = { number: number; included: boolean };

/** Committed vs stretch counts for the scope step and the freeze summary. */
export function scopeCounts(items: Selectable[]): { committed: number; stretch: number; total: number } {
  const committed = items.filter((i) => i.included).length;
  return { committed, stretch: items.length - committed, total: items.length };
}

/** The selection a freeze commits to: milestone issues that are ticked, plus those added by number. */
export function freezeSelection(items: (Selectable & { manual?: boolean })[]): { include: number[]; manual: number[] } {
  return {
    include: items.filter((i) => i.included).map((i) => i.number),
    manual: items.filter((i) => i.manual && i.included).map((i) => i.number),
  };
}
