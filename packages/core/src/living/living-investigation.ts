/**
 * Living Investigation — MVP facade over C22.
 *
 * Aligns command shapes with the real C22 engine where possible, and provides
 * a deterministic demo case file so the UI is runnable without a live worker.
 */

import type { DisplayMode } from "@cie/schema";
import type {
  CompletionReport,
  DiscriminatingCheck,
  HypothesisRecord,
  InvestigationDetails,
  InvestigationSnapshot,
  Observation,
} from "../c22/types.ts";

export type EpistemicGrade = DisplayMode;

export interface HypothesisCard {
  id: string;
  version: number;
  title: string;
  summary: string;
  evaluation: string;
  freshness: string;
  grade: EpistemicGrade;
  assumptionCount: number;
  openAssumptions: number;
  supportCount: number;
  contradictCount: number;
  claimId: string | null;
}

export interface NextCheckCard {
  id: string;
  description: string;
  hypothesisIds: string[];
  toolId: string;
  executionClass: string;
  expectedCostLabel: string;
  rationale: string;
}

export interface ViewHint {
  concern: "activity" | "sequence" | "data" | "history" | "causality" | "recovery" | "source" | "concurrency";
  label: string;
  reason: string;
  subjectRefs: string[];
}

export interface LivingCaseFile {
  investigationId: string;
  question: string;
  revision: string;
  workspaceId: string;
  execution: string;
  disposition: string;
  mode: string;
  version: number;
  hypotheses: HypothesisCard[];
  observations: Array<{ id: string; description: string; kind: string; retracted: boolean }>;
  nextChecks: NextCheckCard[];
  viewHints: ViewHint[];
  completion: CompletionReport | null;
  statusLine: string;
  gaps: string[];
  demo?: boolean;
}

export interface OpenLivingArgs {
  workspaceId: string;
  revision: string;
  question: string;
  entityRefs?: string[];
  trace?: string;
  mode?: "GUIDED" | "BOUNDED_AUTOMATIC" | "LIVE_REFINEMENT";
  seed?: boolean;
}

function gradeFromEvaluation(status: string): EpistemicGrade {
  if (status === "SUPPORTED" || status === "REFUTED") return "FACT";
  if (status === "CONTESTED") return "INFERENCE";
  if (status === "UNRESOLVED") return "HYPOTHESIS";
  return "HYPOTHESIS";
}

function statusLineOf(snap: { execution: string; disposition?: string }, hyps: HypothesisCard[]): string {
  const open = hyps.filter((h) => h.evaluation === "OPEN" || h.evaluation === "UNRESOLVED").length;
  const supported = hyps.filter((h) => h.evaluation === "SUPPORTED").length;
  const contested = hyps.filter((h) => h.evaluation === "CONTESTED").length;
  if (snap.execution === "FINISHED" || snap.execution === "CANCELLED") {
    return `Closed · ${snap.disposition ?? "unknown disposition"}`;
  }
  if (supported && !open && !contested) return `Supported mechanism identified (${supported})`;
  if (contested) return `${contested} contested · ${open} still open`;
  if (open) return `${open} competing hypotheses · investigation active`;
  return `Investigation ${String(snap.execution).toLowerCase()}`;
}

function buildViewHints(question: string, entityRefs: string[]): ViewHint[] {
  const q = question.toLowerCase();
  const hints: ViewHint[] = [];
  const refs = entityRefs.slice(0, 8);
  hints.push({ concern: "activity", label: "Activity / journey", reason: "Shows the end-to-end path the symptom sits on", subjectRefs: refs });
  if (/timeout|retry|fail|error|crash|hang/.test(q)) {
    hints.push({ concern: "recovery", label: "Recovery / compensation", reason: "Timeout and failure paths are central to this question", subjectRefs: refs });
  }
  if (/race|concurrent|parallel|lock|deadlock/.test(q)) {
    hints.push({ concern: "concurrency", label: "Concurrency / interleaving", reason: "Question suggests shared-state or ordering concerns", subjectRefs: refs });
  }
  if (/data|write|read|persist|ledger|balance|order/.test(q)) {
    hints.push({ concern: "data", label: "Data lineage", reason: "Data movement or persistence appears relevant", subjectRefs: refs });
  }
  if (/after|since|refactor|change|commit|pr|regression/.test(q)) {
    hints.push({ concern: "history", label: "History / change coupling", reason: "Temporal or change-related language detected", subjectRefs: refs });
  }
  hints.push({ concern: "sequence", label: "Sequence", reason: "Interaction order often discriminates hypotheses", subjectRefs: refs });
  hints.push({ concern: "causality", label: "Causality", reason: "Runtime ordering and attribution when available", subjectRefs: refs });
  return hints;
}

export function toHypothesisCard(h: HypothesisRecord): HypothesisCard {
  const assumptions = (h as any).assumptions ?? [];
  const openAssumptions = assumptions.filter((a: any) => a.status === "UNCHECKED" || a.verification === "UNCHECKED" || a.status === "UNKNOWN").length;
  const status = (h.evaluation as any)?.state ?? "OPEN";
  return {
    id: h.id,
    version: h.version,
    title: (h as any).title || h.statement?.slice(0, 80) || h.id,
    summary: h.statement || (h as any).title || "",
    evaluation: status,
    freshness: h.evaluation?.freshness ?? "CURRENT",
    grade: gradeFromEvaluation(status),
    assumptionCount: assumptions.length,
    openAssumptions,
    supportCount: 0,
    contradictCount: 0,
    claimId: h.claimId ?? null,
  };
}

export function buildCaseFile(
  details: InvestigationDetails,
  opts?: { assessmentsByHyp?: Map<string, { support: number; contradict: number }>; demo?: boolean },
): LivingCaseFile {
  const snap = details.snapshot;
  const hyps = (details.hypotheses ?? []).map((h) => {
    const card = toHypothesisCard(h);
    const counts = opts?.assessmentsByHyp?.get(h.id);
    if (counts) {
      card.supportCount = counts.support;
      card.contradictCount = counts.contradict;
    }
    return card;
  });

  const rawChecks: any[] = (details as any).checks ?? (details as any).readyChecks ?? (details as any).plan?.ready ?? [];
  const nextChecks: NextCheckCard[] = rawChecks.slice(0, 5).map((c: DiscriminatingCheck | any) => ({
    id: c.id,
    description: c.description ?? c.id,
    hypothesisIds: c.hypothesisIds ?? [],
    toolId: c.toolId ?? "unknown",
    executionClass: c.executionClass ?? "READ_ONLY",
    expectedCostLabel: c.expectedCost ? `${(c.expectedCost as any).units ?? "?"} units` : "unknown",
    rationale: c.value?.method === "CALIBRATED_EXPECTED_GAIN" ? "Highest expected information gain" : "Next ready discriminating check",
  }));

  const observations = (details.observations ?? []).map((o: Observation) => ({
    id: o.id,
    description: o.description,
    kind: o.kind,
    retracted: !!o.retracted,
  }));

  const gaps: string[] = [];
  const completion = (details as any).completion ?? null;
  if (completion?.gaps) {
    for (const g of completion.gaps) gaps.push(typeof g === "string" ? g : (g as any).description ?? String(g));
  }
  if ((snap as any).coverage?.missing) {
    for (const g of (snap as any).coverage.missing) gaps.push(g.description ?? g.id ?? String(g));
  }

  return {
    investigationId: snap.id,
    question: snap.goal?.question ?? "",
    revision: snap.scope?.revision ?? "",
    workspaceId: snap.workspaceId,
    execution: snap.execution,
    disposition: snap.disposition ?? "UNASSESSED",
    mode: snap.mode,
    version: snap.version ?? 1,
    hypotheses: hyps,
    observations,
    nextChecks,
    viewHints: buildViewHints(snap.goal?.question ?? "", snap.goal?.entityRefs ?? []),
    completion,
    statusLine: statusLineOf(snap, hyps),
    gaps: [...new Set(gaps)],
    demo: opts?.demo,
  };
}

// ---- Commands aligned with real C22 engine ----

export function openLivingInvestigationCommand(args: OpenLivingArgs) {
  return {
    component: "C22" as const,
    op: "create" as const,
    body: {
      workspaceId: args.workspaceId,
      revision: args.revision,
      goal: {
        question: args.question.slice(0, 500),
        entityRefs: args.entityRefs ?? [],
        ...(args.trace?.trim() ? { trace: args.trace.trim() } : {}),
      },
      mode: args.mode ?? "GUIDED",
      seed: args.seed !== false,
    },
  };
}

export function proposeHypothesisCommand(investigationId: string, expectedVersion: number, draft: {
  statement: string;
  assumptions?: string[];
  basisEvidenceIds?: string[];
}) {
  return {
    component: "C22" as const,
    op: "proposeHypothesis" as const,
    body: {
      investigationId,
      expectedVersion,
      origin: "USER" as const,
      draft: {
        statement: draft.statement,
        mechanism: [],
        assumptions: (draft.assumptions ?? []).map((statement, i) => ({
          id: `asm:user:${i}`,
          statement,
          entityRefs: [],
          verification: "UNCHECKED",
          evidenceIds: [],
        })),
        predictions: [],
        basisEvidenceIds: draft.basisEvidenceIds ?? [],
        alternativeRelations: [],
      },
    },
  };
}

export function retireHypothesisCommand(investigationId: string, expectedVersion: number, hypothesisId: string, reason: string) {
  return {
    component: "C22" as const,
    op: "retireHypothesis" as const,
    body: { investigationId, expectedVersion, hypothesisId, reason },
  };
}

export function steerCommand(investigationId: string, expectedVersion: number, action: { type: string; [k: string]: unknown }) {
  return {
    component: "C22" as const,
    op: "steer" as const,
    body: { investigationId, expectedVersion, action },
  };
}

export function runNextCheckCommand(investigationId: string, checkId: string) {
  // Engine uses reserve/advance step flow; this is the product-level intent.
  return {
    component: "C22" as const,
    op: "runCheck" as const,
    body: { investigationId, checkId },
  };
}

export function requestCompletionCommand(investigationId: string, expectedVersion: number) {
  return {
    component: "C22" as const,
    op: "steer" as const,
    body: {
      investigationId,
      expectedVersion,
      action: { type: "REQUEST_COMPLETION" },
    },
  };
}

// ---- Demo case file (offline MVP) ----

export function demoCaseFile(question: string, workspaceId: string, revision: string): LivingCaseFile {
  const q = question.trim() || "Why does checkout time out after payment authorization?";
  const hyps: HypothesisCard[] = [
    {
      id: "hyp:demo:timeout-upstream",
      version: 1,
      title: "Upstream payment provider latency",
      summary: "Authorization calls exceed the client timeout under peak load; retries amplify queueing.",
      evaluation: "OPEN",
      freshness: "CURRENT",
      grade: "HYPOTHESIS",
      assumptionCount: 2,
      openAssumptions: 2,
      supportCount: 0,
      contradictCount: 0,
      claimId: "clm:demo:1",
    },
    {
      id: "hyp:demo:lock-contention",
      version: 1,
      title: "Ledger lock contention on order row",
      summary: "Concurrent capture and reconcile hold the same row lock; checkout waits until timeout.",
      evaluation: "OPEN",
      freshness: "CURRENT",
      grade: "HYPOTHESIS",
      assumptionCount: 1,
      openAssumptions: 1,
      supportCount: 0,
      contradictCount: 0,
      claimId: "clm:demo:2",
    },
    {
      id: "hyp:demo:missing-idempotency",
      version: 1,
      title: "Missing idempotency on retry path",
      summary: "Retry after partial success creates duplicate work and extends the critical section.",
      evaluation: "OPEN",
      freshness: "CURRENT",
      grade: "HYPOTHESIS",
      assumptionCount: 2,
      openAssumptions: 1,
      supportCount: 0,
      contradictCount: 0,
      claimId: "clm:demo:3",
    },
  ];
  return {
    investigationId: "inv:demo:living",
    question: q,
    revision,
    workspaceId,
    execution: "READY",
    disposition: "UNASSESSED",
    mode: "GUIDED",
    version: 1,
    hypotheses: hyps,
    observations: [
      { id: "obs:demo:1", description: "Client logs show HTTP 504 from /checkout after ~30s", kind: "USER_REPORT", retracted: false },
      { id: "obs:demo:2", description: "No RUNTIME evidence window attached yet for the incident period", kind: "SOURCE_FACT", retracted: false },
    ],
    nextChecks: [
      {
        id: "chk:demo:provider-latency",
        description: "Compare p95 authorization latency vs checkout timeout budget on the incident revision",
        hypothesisIds: ["hyp:demo:timeout-upstream"],
        toolId: "metrics.window",
        executionClass: "READ_ONLY",
        expectedCostLabel: "low",
        rationale: "Discriminates upstream latency from local lock waits",
      },
      {
        id: "chk:demo:lock-order",
        description: "Inspect lock order and transaction boundaries on order-row writers",
        hypothesisIds: ["hyp:demo:lock-contention"],
        toolId: "graph.locks",
        executionClass: "READ_ONLY",
        expectedCostLabel: "low",
        rationale: "Tests whether capture and reconcile can block each other",
      },
      {
        id: "chk:demo:idempotency",
        description: "Check whether retry path reuses the same idempotency key for authorization",
        hypothesisIds: ["hyp:demo:missing-idempotency"],
        toolId: "source.pattern",
        executionClass: "READ_ONLY",
        expectedCostLabel: "low",
        rationale: "Confirms or refutes duplicate work on retry",
      },
    ],
    viewHints: buildViewHints(q, []),
    completion: null,
    statusLine: "3 competing hypotheses · investigation active",
    gaps: [
      "No RUNTIME evidence window for the incident time range",
      "Provider-side traces not in scope of this revision",
    ],
    demo: true,
  };
}

/** Advance demo state when user "runs" a check — pure client-side for MVP. */
export function demoRunCheck(cf: LivingCaseFile, checkId: string): LivingCaseFile {
  const check = cf.nextChecks.find((c) => c.id === checkId);
  if (!check) return cf;
  const nextHyps = cf.hypotheses.map((h) => {
    if (!check.hypothesisIds.includes(h.id)) return h;
    // First run: move targeted hypothesis to CONTESTED with some support
    if (h.evaluation === "OPEN") {
      return { ...h, evaluation: "CONTESTED", grade: "INFERENCE" as EpistemicGrade, supportCount: h.supportCount + 1 };
    }
    if (h.evaluation === "CONTESTED") {
      return { ...h, evaluation: "SUPPORTED", grade: "FACT" as EpistemicGrade, supportCount: h.supportCount + 1 };
    }
    return h;
  });
  const remaining = cf.nextChecks.filter((c) => c.id !== checkId);
  const obs = [
    ...cf.observations,
    {
      id: `obs:demo:run:${checkId}`,
      description: `Check “${check.description}” completed (demo). Result recorded as observation.`,
      kind: "TEST_RESULT",
      retracted: false,
    },
  ];
  const supported = nextHyps.filter((h) => h.evaluation === "SUPPORTED").length;
  const open = nextHyps.filter((h) => h.evaluation === "OPEN" || h.evaluation === "UNRESOLVED").length;
  const contested = nextHyps.filter((h) => h.evaluation === "CONTESTED").length;
  let statusLine = cf.statusLine;
  if (supported && !open && !contested) statusLine = `Supported mechanism identified (${supported})`;
  else if (contested) statusLine = `${contested} contested · ${open} still open`;
  else statusLine = `${open} competing hypotheses · investigation active`;

  return {
    ...cf,
    hypotheses: nextHyps,
    nextChecks: remaining,
    observations: obs,
    statusLine,
    version: cf.version + 1,
  };
}

export function demoAssessCompletion(cf: LivingCaseFile): LivingCaseFile {
  const supported = cf.hypotheses.filter((h) => h.evaluation === "SUPPORTED");
  const open = cf.hypotheses.filter((h) => h.evaluation === "OPEN" || h.evaluation === "UNRESOLVED" || h.evaluation === "CONTESTED");
  const disposition = supported.length && open.length === 0
    ? "EXPLAINED_WITH_LIMITS"
    : supported.length
      ? "EXPLAINED_WITH_LIMITS"
      : "UNRESOLVED";
  return {
    ...cf,
    execution: "FINISHED",
    disposition,
    statusLine: disposition === "UNRESOLVED"
      ? "Closed · unresolved — competing explanations remain"
      : "Closed · explained within stated limits",
    completion: {
      disposition,
      summary: disposition === "UNRESOLVED"
        ? "No single mechanism is fully supported. Remaining hypotheses and gaps are listed."
        : `Supported: ${supported.map((h) => h.title).join("; ") || "none"}. Limits and gaps remain explicit.`,
      gaps: cf.gaps,
    } as any,
    version: cf.version + 1,
  };
}

export function demoSteer(cf: LivingCaseFile, action: "focus" | "defer" | "retire", hypId: string): LivingCaseFile {
  if (action === "retire") {
    return {
      ...cf,
      hypotheses: cf.hypotheses.filter((h) => h.id !== hypId),
      nextChecks: cf.nextChecks.filter((c) => !c.hypothesisIds.includes(hypId) || c.hypothesisIds.some((id) => id !== hypId)),
      version: cf.version + 1,
      statusLine: statusLineOf({ execution: cf.execution, disposition: cf.disposition }, cf.hypotheses.filter((h) => h.id !== hypId)),
    };
  }
  if (action === "focus") {
    const ordered = [...cf.hypotheses].sort((a, b) => (a.id === hypId ? -1 : b.id === hypId ? 1 : 0));
    return { ...cf, hypotheses: ordered, version: cf.version + 1 };
  }
  // defer: move to end
  const target = cf.hypotheses.find((h) => h.id === hypId);
  const rest = cf.hypotheses.filter((h) => h.id !== hypId);
  return { ...cf, hypotheses: target ? [...rest, target] : cf.hypotheses, version: cf.version + 1 };
}

export const GRADE_LABEL: Record<EpistemicGrade, string> = {
  FACT: "Fact",
  INFERENCE: "Inference",
  HYPOTHESIS: "Hypothesis",
  FOG: "Fog",
  HIDDEN: "Hidden",
};

export const GRADE_HINT: Record<EpistemicGrade, string> = {
  FACT: "Supported by accepted evidence under current gates",
  INFERENCE: "Reasonable conclusion that still depends on interpretation",
  HYPOTHESIS: "Proposed explanation; not yet established",
  FOG: "Insufficient evidence; treated as unknown",
  HIDDEN: "Not shown under current display policy",
};

export function completionHonestyLine(report: CompletionReport | null | undefined): string {
  if (!report) return "No completion assessment yet.";
  const d = (report as any).disposition ?? (report as any).status ?? "UNRESOLVED";
  if (d === "EXPLAINED_WITH_LIMITS") return "Explained within stated limits — remaining gaps are listed.";
  if (d === "UNRESOLVED") return "Unresolved. Competing explanations remain; gaps are explicit.";
  if (d === "USER_CLOSED") return "Closed by user without a supported mechanism.";
  if (d === "STALE") return "Stale relative to the pinned revision or evidence window.";
  return `Completion status: ${d}`;
}
