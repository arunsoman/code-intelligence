// Pure view logic for the Validate and Deliver stages (task 3.P): no status is shown more favourably than the server computed it.
import type { Dashboard, DeliverView, TestOrigin } from "../../../../packages/core/src/feature/dashboard.ts";

/** Only an actual PASS looks like one. Everything else is a warning or an error; nothing unknown is shown green. */
export const statusTone = (status: string): "ok" | "warn" | "bad" => (status === "PASS" ? "ok" : status === "FAIL" ? "bad" : "warn");
export const statusText = (status: string): string => (status === "PASS_UNREVIEWED_ORACLE" ? "pass (expectation not reviewed)" : status.replaceAll("_", " ").toLowerCase());
export const bannerTone = (e: Dashboard["banner"]["eligibility"]): "ok" | "warn" | "bad" => (e === "VERIFIED_WITHIN_SCOPE" ? "ok" : e === "BLOCKED" ? "bad" : "warn");

export const ORIGIN_TEXT: Record<TestOrigin, string> = { ADDED: "added by this change", IN_MODIFIED_FILE: "in a file this change modified", NOT_IN_CHANGED_FILES: "existing (not in a changed file)" };
export const BASIS_TEXT: Record<string, string> = {
  EXPLICIT: "linked on purpose: an attributed edit or a criterion names this test", STATIC_DEPENDENCY: "imports a changed file; not observed running",
  OBSERVED_COVERAGE: "observed while running", REVIEWED: "linked by a reviewer", HEURISTIC: "guessed from names or paths; weakest basis",
};

export const TEST_PAGE = 40;
export type TestRow = Dashboard["tests"][number];
export function filterTests(rows: TestRow[], f: { status: string; origin: string; text: string }): TestRow[] {
  return rows.filter((r) => (!f.status || r.status === f.status) && (!f.origin || r.origin === f.origin) && r.name.toLowerCase().includes(f.text.toLowerCase()));
}
export const countByStatus = (rows: TestRow[]): string => Object.entries(rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})).sort().map(([k, n]) => `${statusText(k)}: ${n}`).join(" · ") || "No test outcomes recorded.";

/** One line per target: baseline health beside the candidate's build, so a pre-existing failure is not read as a regression. */
export const targetLine = (t: Dashboard["targets"][number]): string => `${t.target}: baseline ${t.baseline.replaceAll("_", " ").toLowerCase()} · candidate ${statusText(t.candidate)}`;

export const reasonList = (reasons: string[], max = 8): { shown: string[]; more: number } => ({ shown: reasons.slice(0, max), more: Math.max(0, reasons.length - max) });
export const exportFileName = (e: { id: string; format: string }): string => `feature-${e.id.split(":").pop()!.slice(0, 8)}.${e.format === "BUNDLE" ? "json" : e.format === "UNIFIED_DIFF" ? "diff" : "patch"}`;
export const validDestination = (s: string): boolean => /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}:[A-Za-z0-9][A-Za-z0-9_./-]{0,100}$/.test(s) && !s.includes("..");
/** The action a button stands for, with the exact reason it is unavailable; a disabled button never has a blank explanation. */
export const actionState = (v: DeliverView, name: DeliverView["actions"][number]["action"]): { enabled: boolean; reason: string } => v.actions.find((a) => a.action === name) ?? { enabled: false, reason: "not available" };

/** Declaration rows (D001): a claim nobody recorded, or whose declarer lost the authority, is a warning, never a pass. */
export const declarationTone = (state: string): "ok" | "warn" | "bad" => (state === "DECLARED" || state === "CONFIRMED" || state === "NOT_CLAIMED" ? "ok" : state === "NO_LONGER_AUTHORISED" ? "bad" : "warn");
export const declarationText = (state: string): string => ({ DECLARED: "declared", CONFIRMED: "confirmed", UNCONFIRMED: "not confirmed", NOT_DECLARED: "claimed but not declared", NO_LONGER_AUTHORISED: "declarer no longer authorised", NOT_CLAIMED: "not claimed" } as Record<string, string>)[state] ?? state.replaceAll("_", " ").toLowerCase();
export const RELEASE_TEXT: Record<string, string> = { NONE: "No operational note or release plan has been drafted.", DRAFT: "A draft exists. It is not a decision until a principal with release authority confirms it.", CONFIRMED: "Confirmed by a principal with release authority." };
export const publishAuthorityText = (a: { bound: boolean; repositories: string[]; bases: string[] }): string => a.bound ? `You are bound to create draft pull requests in ${a.repositories.join(", ")} against ${a.bases.join(", ")}.` : "You are not bound for publication. Owning the request does not grant it; a publish binding names the principal, repository and base branch.";
