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
