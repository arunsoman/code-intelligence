import type { Entity } from "@cie/schema";
import type { AccessPolicy } from "./access.ts";
import { isNonProductionFile } from "./module-tests.ts";
import { queryTerms } from "./retrieval.ts";
import type { Store } from "./store.ts";

const GENERIC = new Set(["user", "users", "case", "cases", "where", "then", "never", "happens", "hapens", "also", "not", "system", "code"]);
const ACTION_WORDS = new Set(["refund", "refunded", "payment", "payments", "transaction", "transactions", "pay", "pays", "paid", "fail", "failed", "failure", "success"]);
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Source lookup must not depend on which nodes survive a diagram's display cutoff.
 * Match the entire accessible index, weighting distinctive query words over common names. */
export function sourceCandidates(store: Store, revision: string, query: string, access: AccessPolicy): Entity[] {
  const includeTests = /\b(?:tests?|fixtures?|examples?)\b|(?:^|\/)__tests__\//i.test(query);
  const entities = store.entities(revision).filter(e => !access.denied(e.file) && (includeTests || !isNonProductionFile(e.file)));
  const terms = [...new Set(queryTerms(query.replace(/(?<=\w)-(?=\w)/g, "")).filter(t => !GENERIC.has(t)).map(normalized))];
  if (!terms.length) return [];
  const hits = entities.map(e => ({ e, name: normalized(e.name), path: normalized(e.file) }));
  const frequency = new Map(terms.map(t => [t, hits.filter(h => h.name.includes(t) || h.path.includes(t)).length]));
  const hasSpecificMatch = terms.some(t => !ACTION_WORDS.has(t) && frequency.get(t)! > 0);
  return hits.map(h => ({ e: h.e, score: terms.reduce((score, t) => score +
    (h.name.includes(t) ? 2 : h.path.includes(t) ? 1 : 0) * Math.log(1 + entities.length / Math.max(1, frequency.get(t)!)) * (hasSpecificMatch && ACTION_WORDS.has(t) ? 0.25 : 1), 0) }))
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.e.kind === "file") - Number(b.e.kind === "file") || a.e.entityId.localeCompare(b.e.entityId))
    .slice(0, 12).map(h => h.e);
}
