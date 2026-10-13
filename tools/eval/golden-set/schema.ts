// The golden set v2's own migration plan (stage 0) requires before any structural work: real questions, labelled with
// what a correct answer must contain, so later stages can be measured against this system's current behavior instead
// of against nothing. A case is deliberately independent of the (not-yet-built) Claim/QuerySpec types from the v2
// proposal — it only records what a human verified by reading the code, so it stays usable through every migration stage.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** `type` is a best-effort guess at which v2 query-planner template this question would route to; it is not load-bearing
 * for scoring today (the current system has no planner), only for stratifying the set once templates exist (stage 5). */
export type GoldenQuestionType = "locate" | "enumerate" | "count" | "trace" | "explain" | "overview" | "risk" | "compare" | "config" | "route" | "open" | "absent_in_scope" | "out_of_scope";

export interface GoldenCase {
  id: string;
  /** Which fixture/repo this case is asked against. "payments-repo" means `scripts_make_demo_repo.sh` (fixtures/payments-repo). */
  repo: string;
  question: string;
  type: GoldenQuestionType;
  /** Case-insensitive substrings a correct answer's message must contain. Naive (stage-0) scoring, not claim-level
   * precision/recall — that needs the Claim/verifier work from stage 3. Keep each fact short and specific. */
  expectedFacts: string[];
  /** Entity ids (as the index would mint them) a correct answer should cite, when known. Optional: not every
   * question has a clean expected id (e.g. an `absent_in_scope` question expects none). */
  expectedEntityIds?: string[];
  /** Why this case exists / what regression or behavior it's pinned to. */
  notes?: string;
  /** Set by the transcript miner for a freshly-mined, not-yet-labelled case; a human must fill expectedFacts and
   * clear this before the case counts toward any metric. */
  needsLabeling?: boolean;
}

const CASES_DIR = join(import.meta.dirname, "cases");

export function loadGoldenSet(repoFilter?: string): GoldenCase[] {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));
  const cases = files.flatMap((f) => JSON.parse(readFileSync(join(CASES_DIR, f), "utf8")) as GoldenCase[]);
  return repoFilter ? cases.filter((c) => c.repo === repoFilter) : cases;
}
