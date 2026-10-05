import { renderToString } from "react-dom/server";
import { DeliverReview, ValidateReview } from "../src/build/DeliverStages.tsx";
export { auditMarkup } from "../src/a11y.ts";

const call = (async () => ({ ok: false, error: { code: "X", message: "offline" } })) as never;
const noop = async () => {}; const dash = (eligibility: string) => ({
  banner: { eligibility, text: eligibility === "VERIFIED_WITHIN_SCOPE" ? "Verified within the scope of the recorded validation — not a claim that the change is bug-free." : "REVIEW ONLY — VALIDATION INCOMPLETE" },
  stale: { stale: true, reasons: ["the candidate is stale"] }, targets: [{ target: "backend", baseline: "PREEXISTING_FAILURE", candidate: "FAIL", checkIds: ["build:backend"] }],
  tests: [{ name: "accepts current tenant", target: "backend", checkId: "tests:.", status: "PASS_UNREVIEWED_ORACLE", origin: "ADDED" }, { name: "legacy", target: "backend", checkId: "tests:.", status: "SKIP", origin: "NOT_IN_CHANGED_FILES" }], testsTruncated: 3,
  gates: [{ kind: "SECURITY", status: "NOT_RUN", gaps: [] }], diagnostics: [{ checkId: "build:backend", kind: "BUILD", status: "FAIL", reason: "exit 1", guidance: "Change the code so the check passes. Do not edit, skip or loosen a test to make it pass." }],
  repair: { allowed: ["Change source files"], forbidden: ["Edit, skip, loosen or delete an existing test"], weakened: [{ kind: "REPAIR_LOOSENED_MATCHER", file: "tests/a.test.ts", testCase: "x", detail: "strictEqual became ok" }], blocksVerification: true },
});
const deliver = (eligibility: string, enabled: boolean) => ({ eligibility, label: eligibility === "BLOCKED" ? "BLOCKED — a mandatory check failed or a precondition is not met" : "REVIEW ONLY — VALIDATION INCOMPLETE", reasons: ["mandatory BUILD gate is missing"], mode: "BUILD_PREVIEW", candidateHash: "b", headHash: "h",
  decisionIds: { export: "d1", publish: "d2" }, exportPolicyHash: "p", formats: ["UNIFIED_DIFF", "GIT_PATCH", "BUNDLE"], exports: [{ id: "export:abcdef0123", format: "GIT_PATCH", eligibility: "REVIEW_ONLY_INCOMPLETE", label: "REVIEW ONLY — VALIDATION INCOMPLETE", patchArtifactHash: "pf-canon-v1/x:0123456789abcdef" }],
  actions: [{ action: "Export patch", enabled, reason: enabled ? "Ready." : "a blocked candidate is not exported" }, { action: "Check destination", enabled: false, reason: "export a patch first" }, { action: "Create draft PR", enabled: false, reason: "this request was made in BUILD_PREVIEW mode" }] });
const review = (d: unknown, v: unknown) => ({ dashboard: d, deliver: v, validationPlanHash: "ph", results: [] }) as never;

export const render = () => ({
  validate: renderToString(<ValidateReview review={review(dash("REVIEW_ONLY_INCOMPLETE"), deliver("REVIEW_ONLY_INCOMPLETE", true))} candidateHash="b" call={call} refresh={noop} notify={() => {}} />),
  deliverBlocked: renderToString(<DeliverReview review={review(dash("BLOCKED"), deliver("BLOCKED", false))} call={call} refresh={noop} notify={() => {}} />),
  deliverOk: renderToString(<DeliverReview review={review(dash("REVIEW_ONLY_INCOMPLETE"), deliver("REVIEW_ONLY_INCOMPLETE", true))} call={call} refresh={noop} notify={() => {}} />),
});
