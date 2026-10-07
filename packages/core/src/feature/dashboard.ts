// Task 3.P — the Validate and Deliver read models (PF-073, PF-074, PF-076; AT-72, AT-74–77). Built only from recorded evidence, the
// plan and the eligibility function; nothing here decides eligibility or runs anything, and no word here is stronger than
// computeEligibility() allows ("verified" appears only when it returns VERIFIED_WITHIN_SCOPE).
import { declarationGaps } from "./declarations.ts";
import { isTestPath } from "../execution.ts";
import { authorityFor, declarationStatus, type DeclarationKind, type DeclarationState } from "./declarations.ts";
import { unevaluatedModels } from "./builder-eval.ts";
import { EXPORT_FORMATS, EXPORT_PURPOSES, exportPolicyHash } from "./patch-export.ts";
import { PUBLISH_PURPOSES } from "./publish.ts";
import type { CandidateRecord, DecisionRecord, EvidenceRecord, FeatureRecord, FeatureStore, PublicationDecision, ValidationKind, ValidationResult } from "./types.ts";
import { computeEligibility, defaultValidationPlan, validationPlanHash, type ValidationPlan } from "./validation.ts";

export type TestOrigin = "ADDED" | "IN_MODIFIED_FILE" | "NOT_IN_CHANGED_FILES";
export type DeclarationRow = { id: DeclarationKind | "EXPECTED_OUTCOMES"; claim: string; state: DeclarationState | "CONFIRMED" | "UNCONFIRMED"; declarer?: string; bindingId?: string; detail: string };
export type Dashboard = {
  banner: { eligibility: PublicationDecision["eligibility"] | "NO_CANDIDATE"; text: string };
  stale: { stale: boolean; reasons: string[] };
  targets: { target: string; baseline: string; candidate: string; checkIds: string[] }[];
  tests: { name: string; target: string; checkId: string; status: string; origin: TestOrigin }[]; testsTruncated: number;
  gates: { kind: ValidationKind; status: string; gaps: string[] }[];
  diagnostics: { checkId: string; kind: ValidationKind; status: string; reason: string; guidance: string }[];
  /** D001: each claim the result rests on, who made it, under which binding, and whether that authority still holds. */
  declarations: DeclarationRow[];
  repair: { allowed: string[]; forbidden: string[]; weakened: { kind: string; file: string; testCase: string; detail: string }[]; blocksVerification: boolean };
};
export type DeliverView = {
  eligibility: PublicationDecision["eligibility"] | "NO_CANDIDATE"; label: string; reasons: string[]; mode: FeatureRecord["mode"];
  /** The candidate these actions are bound to: its binding hash and the content hash a publication must quote back. */ candidateHash?: string; headHash?: string;
  decisionIds: { export: string; publish: string }; exportPolicyHash: string; formats: readonly string[];
  exports: { id: string; format: string; eligibility: string; label?: string; patchArtifactHash: string }[];
  publication?: { prNumber?: number; url?: string; commit?: string; eligibility?: string; updated?: boolean };
  actions: { action: "Export patch" | "Check destination" | "Create draft PR"; enabled: boolean; reason: string }[];
  /** D001/D005: the operational note or release plan (none, draft, confirmed) and whether the requester holds a publish binding. */
  release: { state: "NONE" | "DRAFT" | "CONFIRMED"; draftedBy?: string; confirmedBy?: string };
  publishAuthority: { bound: boolean; repositories: string[]; bases: string[] };
};

function declarationDetail(x: { state: string; declarer?: string; bindingId?: string; reason?: string }): string {
  if (x.state === "DECLARED") return x.bindingId ? `declared by ${x.declarer} under ${x.bindingId}` : `declared by ${x.declarer} (requester)`;
  if (x.state === "NOT_CLAIMED") return "no claim is made, so nothing needs declaring";
  return x.reason ?? "";
}
export const BANNER: Record<Dashboard["banner"]["eligibility"], string> = {
  VERIFIED_WITHIN_SCOPE: "Verified within the scope of the recorded validation — not a claim that the change is bug-free.",
  REVIEW_ONLY_INCOMPLETE: "REVIEW ONLY — VALIDATION INCOMPLETE",
  BLOCKED: "BLOCKED — a mandatory check failed or a precondition is not met",
  NO_CANDIDATE: "No candidate yet — nothing has been validated",
};
const GUIDANCE: Record<string, string> = {
  FAIL: "Change the code so the check passes. Do not edit, skip or loosen a test to make it pass: that is a property change and blocks verification.",
  INCOMPLETE: "The check did not finish or reported a partial population. Fix the cause (missing tool, timeout, skipped test) and run it again.",
  NOT_RUN: "An earlier stage did not pass, or the check was never started. Fix the earlier stage first.",
  STALE: "The candidate, contract or plan changed after this ran. Run it again on the current candidate.",
  PASS_UNREVIEWED_ORACLE: "Passed, but only against a generated, unreviewed expectation. A person must confirm the expected behaviour.",
};
const MAX_TESTS = 500;

const latestPerCheck = (evidence: EvidenceRecord[]): Map<string, EvidenceRecord> => {
  const m = new Map<string, EvidenceRecord>();
  for (const e of [...evidence].filter((x) => !x.verdict && x.validation).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) m.set(e.validation!.checkId, e);
  return m;
};
const statusOf = (rs: ValidationResult[]): string => !rs.length ? "NOT_RUN" : rs.every((r) => r.status === "PASS") ? "PASS" : rs.find((r) => r.status === "FAIL") ? "FAIL" : rs.find((r) => r.status !== "PASS")!.status;

export function validationDashboard(fs: FeatureStore, request: FeatureRecord, candidate: CandidateRecord | null, decision?: PublicationDecision): Dashboard {
  if (!candidate) return { banner: { eligibility: "NO_CANDIDATE", text: BANNER.NO_CANDIDATE }, stale: { stale: false, reasons: [] }, targets: [], tests: [], testsTruncated: 0, gates: [], diagnostics: [], declarations: [], repair: { allowed: [], forbidden: [], weakened: [], blocksVerification: false } };
  const plan: ValidationPlan = request.validationPlan ?? defaultValidationPlan(request, candidate); const planHash = validationPlanHash(plan);
  const latest = latestPerCheck(fs.listEvidence(candidate.id));
  const reasons: string[] = [];
  if (candidate.status !== "MATERIALIZED") reasons.push(`the candidate is ${candidate.status.toLowerCase()}`);
  if (request.contract?.hash !== candidate.binding.contractHash) reasons.push("the contract changed after this candidate was built");
  for (const [checkId, e] of latest) if (e.manifest.harnessHash !== planHash || e.manifest.contentHash !== candidate.binding.candidateContentHash || e.manifest.contractHash !== candidate.binding.contractHash) reasons.push(`${checkId}: evidence was recorded for a different plan, content or contract`);
  const stale = reasons.length > 0;
  const results = (check: string) => latest.get(check)?.results ?? [];
  const mark = (rs: string) => (stale && rs !== "NOT_RUN" ? "STALE" : rs);

  const targets = plan.targets.map((t) => {
    const build = plan.checks.find((c) => c.kind === "BUILD" && c.target === t), unit = plan.checks.find((c) => c.kind === "UNIT" && c.target === t);
    const health = (build && latest.get(build.id)?.validation?.baselineHealth) ?? (unit && latest.get(unit.id)?.validation?.baselineHealth) ?? "NOT_RUN";
    return { target: t, baseline: health, candidate: mark(build ? statusOf(results(build.id)) : "NOT_RUN"), checkIds: [build?.id, unit?.id].filter((x): x is string => !!x) };
  });

  const changedTests = new Map<string, { text: string; added: boolean }>();
  for (const m of candidate.mutations) { const p = m.newPath ?? m.oldPath!; const text = candidate.contents?.[p]; if (isTestPath(p) && typeof text === "string") changedTests.set(p, { text, added: m.kind === "ADDED" }); }
  const originOf = (name: string): TestOrigin => { for (const { text, added } of changedTests.values()) if (text.includes(name)) return added ? "ADDED" : "IN_MODIFIED_FILE"; return "NOT_IN_CHANGED_FILES"; };
  const tests: Dashboard["tests"] = [];
  for (const check of plan.checks.filter((c) => c.kind === "UNIT" || c.kind === "INTEGRATION")) for (const o of latest.get(check.id)?.validation?.outcomes ?? []) tests.push({ name: o.name, target: check.target, checkId: check.id, status: mark(o.state), origin: originOf(o.name) });
  const shown = tests.slice(0, MAX_TESTS);

  const kinds = [...new Set(plan.checks.map((c) => c.kind))];
  const gates = kinds.map((kind) => { const checks = plan.checks.filter((c) => c.kind === kind); const rs = checks.flatMap((c) => results(c.id)); const status = checks.some((c) => !latest.has(c.id)) && !rs.length ? "NOT_RUN" : mark(statusOf(rs)); return { kind, status, gaps: [...new Set(rs.flatMap((r) => r.gaps))].slice(0, 8) }; });
  const diagnostics: Dashboard["diagnostics"] = [];
  for (const check of plan.checks.filter((c) => c.mandatory)) {
    const rs = results(check.id); const st = mark(statusOf(rs));
    if (st === "PASS" || (check.applicability === "NOT_APPLICABLE" && st === "NOT_APPLICABLE")) continue;
    diagnostics.push({ checkId: check.id, kind: check.kind, status: st, reason: [...new Set(rs.flatMap((r) => r.gaps))].slice(0, 4).join("; ") || (latest.has(check.id) ? "no detail recorded" : "never run on this candidate"), guidance: GUIDANCE[st] ?? "Review the result and run the check again." });
  }
  const weakened = (candidate.oracleChanges ?? []).map((c) => ({ ...c }));
  const dstat = declarationStatus(fs, request); const acc = request.contract?.acceptance ?? []; const confirmed = acc.filter((a) => a.oracleOrigin !== "GENERATED_UNREVIEWED").length;
  const declarations: DeclarationRow[] = [
    { id: "EXPECTED_OUTCOMES", claim: "expected outcomes", state: acc.length && confirmed === acc.length ? "CONFIRMED" : "UNCONFIRMED", detail: `${confirmed} of ${acc.length} criteria have an expected outcome a person confirmed; the rest are generated and unreviewed` },
    ...(Object.keys(dstat) as DeclarationKind[]).map((id): DeclarationRow => { const x = dstat[id]; return { id, claim: x.claim, state: x.state, declarer: x.declarer, bindingId: x.bindingId, detail: declarationDetail(x) }; }),
  ];
  const eligibility = decision?.eligibility ?? "REVIEW_ONLY_INCOMPLETE";
  return {
    banner: { eligibility, text: BANNER[eligibility] }, stale: { stale, reasons }, targets, tests: shown, testsTruncated: tests.length - shown.length, gates, diagnostics, declarations,
    repair: { allowed: ["Change source files", "Add new tests", "Fix a genuine defect found by a check"], forbidden: ["Edit, skip, loosen or delete an existing test", "Weaken a test the previous candidate added", "Waive a failed check without a recorded authority"], weakened, blocksVerification: candidate.oracleState === "PROPERTY_CHANGE_PENDING_REVIEW" },
  };
}

export function deliverView(fs: FeatureStore, request: FeatureRecord, candidate: CandidateRecord | null, store?: { getEvaluation?: never }): DeliverView {
  const decide = (purposes: readonly string[]) => candidate ? computeEligibility({ request, candidate, plan: request.validationPlan ?? defaultValidationPlan(request, candidate), evidence: fs.listEvidence(candidate.id).filter((e) => !e.verdict), decisions: fs.listDecisions(request.requestId) as DecisionRecord[], purpose: purposes[0], unevaluatedModels: unevaluatedModels((store ?? fs) as { getEvaluation?: never }, request, candidate), externalGaps: declarationGaps(fs, request) }) : undefined;
  const ex = decide(EXPORT_PURPOSES), pub = decide(PUBLISH_PURPOSES);
  const eligibility = ex?.eligibility ?? "NO_CANDIDATE";
  const usable = !!candidate && candidate.status === "MATERIALIZED" && request.workspace.candidateHash === candidate.bindingHash && ex?.status !== "STALE";
  const blocked = ex?.eligibility === "BLOCKED";
  const why = (ok: boolean, reason: string) => ({ enabled: ok, reason: ok ? "Ready." : reason });
  const exportOk = usable && !blocked;
  const prOk = exportOk && request.mode === "CREATE_DRAFT_PR" && request.issue.syncState !== "TRACKING_BLOCKED";
  const a = (action: DeliverView["actions"][number]["action"], ok: boolean, reason: string) => ({ action, ...why(ok, reason) });
  const pr = candidate?.publication;
  return {
    eligibility, label: BANNER[eligibility], reasons: ex?.reasons ?? [], mode: request.mode, candidateHash: candidate?.bindingHash, headHash: candidate?.binding.candidateContentHash, decisionIds: { export: ex?.id ?? "", publish: pub?.id ?? "" }, exportPolicyHash: exportPolicyHash(), formats: EXPORT_FORMATS,
    exports: (candidate?.exports ?? []).map((e) => ({ id: e.id, format: e.format, eligibility: e.eligibility, label: e.label, patchArtifactHash: e.patchArtifactHash })),
    ...(pr ? { publication: { prNumber: pr.prNumber, url: pr.remoteRef, commit: pr.commit, eligibility: pr.eligibility, updated: pr.updated } } : {}),
    release: { state: request.contract?.releasePlan ? (request.contract.releasePlan.confirmedBy ? "CONFIRMED" : "DRAFT") : "NONE", draftedBy: request.contract?.releasePlan?.draftedBy, confirmedBy: request.contract?.releasePlan?.confirmedBy },
    publishAuthority: (() => { const bs = authorityFor(request.repositoryId).auth.bindings.filter((b) => b.scope === "publish" && b.principals.includes(request.createdBy)); return { bound: bs.length > 0, repositories: [...new Set(bs.flatMap((b) => b.repositories ?? []))], bases: [...new Set(bs.flatMap((b) => b.bases ?? []))] }; })(),
    actions: [
      a("Export patch", exportOk, !candidate ? "there is no candidate" : !usable ? "the candidate is stale or superseded" : "a blocked candidate is not exported"),
      a("Check destination", !!candidate && usable && !blocked && (candidate.exports?.length ?? 0) > 0, "export a patch first"),
      a("Create draft PR", prOk && authorityFor(request.repositoryId).auth.bindings.some((b) => b.scope === "publish" && b.principals.includes(request.createdBy)) && ex?.eligibility === "VERIFIED_WITHIN_SCOPE", request.mode !== "CREATE_DRAFT_PR" ? `this request was made in ${request.mode} mode` : request.issue.syncState === "TRACKING_BLOCKED" ? "issue tracking is mandatory and no issue is bound" : !authorityFor(request.repositoryId).auth.bindings.some((b) => b.scope === "publish" && b.principals.includes(request.createdBy)) ? "you are not bound for publication (a publish binding is required; owning the request grants none)" : ex?.eligibility !== "VERIFIED_WITHIN_SCOPE" ? "only a verified candidate is published" : !candidate ? "there is no candidate" : !usable ? "the candidate is stale or superseded" : "a blocked candidate is not published"),
    ],
  };
}
