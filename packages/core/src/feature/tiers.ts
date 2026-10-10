// Applicability tiers (plan §2.4). Chosen from the actual change, never from the prompt text or the model's opinion.
import type { Tier } from "./types.ts";

export interface ChangedPath { path: string; kind: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" }

const DOC = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs?|documentation)\//i;
const LICENCE = /(^|\/)(LICENSE|NOTICE|CHANGELOG)[^/]*$/i;
/** Anything that touches access, data shape, dependencies, runtime configuration, CI or infrastructure forces T2. */
const T2 = [
  /(^|\/)(auth|authz|authn|access|permissions?|rbac|acl|tenants?|security|crypto|secrets?)([./_-]|$)/i,
  /(^|\/)(migrations?|schema|db|database|prisma|sql)(\/|\.|$)/i, /\.(sql|prisma)$/i,
  /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|Cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml)$/,
  /(^|\/)\.env(\.|$)/, /(^|\/)(Dockerfile|docker-compose[^/]*|\.github|\.gitlab-ci\.ya?ml|Jenkinsfile|terraform|helm|k8s)(\/|\.|$)/i,
  /(^|\/)(config|settings)[^/]*\.(json|ya?ml|toml|ini)$/i,
];

export interface TierResult { tier: Tier; reasons: string[] }

/**
 * F13: every changed path that hits a high-impact pattern, with the pattern id (the index into the pattern table
 * classifyTier uses). The deletion reason has no pattern id and is not reported here; the summary wants patterns.
 */
export function highImpactHits(changes: readonly ChangedPath[]): { patternId: number; path: string; kind: ChangedPath["kind"] }[] {
  const out: { patternId: number; path: string; kind: ChangedPath["kind"] }[] = [];
  for (const c of changes) {
    const hit = T2.findIndex((re) => re.test(c.path));
    if (hit >= 0) out.push({ patternId: hit, path: c.path, kind: c.kind });
  }
  return out;
}

/** F13: one reader-facing label per pattern id (§7.3 — the mapping lives in this one table). */
export const PATTERN_LABEL: Record<number, string> = {
  0: "access control & security", 1: "access control & security", 2: "access control & security", 3: "access control & security",
  4: "access control & security", 5: "access control & security", 6: "access control & security", 7: "access control & security",
  8: "access control & security", 9: "access control & security",
  10: "database & schema", 11: "database & schema", 12: "database & schema",
  13: "dependencies & lockfiles", 14: "dependencies & lockfiles", 15: "dependencies & lockfiles", 16: "dependencies & lockfiles",
  17: "runtime configuration",
  18: "CI & infrastructure",
  19: "configuration files",
};

/** T0 only when every path is documentation; T2 when any path matches a high-impact pattern; otherwise T1. Empty change is T0. */
export function classifyTier(changes: readonly ChangedPath[]): TierResult {
  const reasons: string[] = [];
  for (const c of changes) {
    const hit = T2.findIndex((re) => re.test(c.path));
    if (hit >= 0) reasons.push(`${c.kind.toLowerCase()} ${c.path} matches a high-impact pattern (#${hit})`);
    if (c.kind === "DELETED" && !DOC.test(c.path)) reasons.push(`deleting ${c.path} can remove a consumer-visible behaviour`);
  }
  if (reasons.length) return { tier: "T2", reasons };
  if (changes.every((c) => DOC.test(c.path) || LICENCE.test(c.path))) return { tier: "T0", reasons: ["documentation only"] };
  return { tier: "T1", reasons: ["executable or UI change without a high-impact pattern"] };
}
