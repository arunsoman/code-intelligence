// Claim pipeline (C16 gates + C18 ledger). Five gates, in order:
//   GROUNDING    every cited evidence id exists in the authorized bundle and is CURRENT
//   CONSISTENCY  the asserted structure is re-verified against the stored graph for that revision
//   ADVERSARIAL  counter-arguments: unresolved calls, async hand-offs, missing tests, model challenge
//   CALIBRATION  confidence only when enough human verdicts exist for this claim class; otherwise abstain
//   DISPLAY      the single rule that turns gate outcomes into a DisplayMode
// A model-authored claim never displays as FACT, and a human CONFIRM never upgrades it to deterministic proof.
import { createHash, randomUUID } from "node:crypto";
import type { ApiError, Claim, ClaimDraft, Confidence, DisplayMode, EvidenceBundle, GateOutcome, ModelRunRef, Verdict, VerdictKind } from "@cie/schema";
import type { Store } from "./store.ts";
import { testFactsFor, testsReaching } from "./testartifacts.ts";

export interface RawClaim {
  assertion: string; claimClass: string; evidenceIds: string[]; counterEvidenceIds?: string[]; rationaleSummary: string;
  structure?: ClaimDraft["structure"]; dependencyIds?: string[]; subjects?: string[];
}
export interface GateOptions {
  run?: ModelRunRef; store?: Store;
  /** For claims authored by the pipeline itself (not a model): evidence stored for the revision counts even if it is not in the bundle. */
  trusted?: boolean;
}
export interface Objection { text: string; evidenceIds: string[]; blocking: boolean; /** Higher is shown first among non-blocking caveats. */ priority?: number }

export const CALIBRATION_MIN_LABELS = 20;

export function claimId(revision: string, assertion: string, evidenceIds: string[]): string {
  return "claim:" + createHash("sha256").update(revision + assertion + [...evidenceIds].sort().join(",")).digest("hex").slice(0, 16);
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, (centre - margin) / denom), upper: Math.min(1, (centre + margin) / denom) };
}

export function groundingGate(draft: ClaimDraft, bundle: EvidenceBundle, trustedStore?: Store): GateOutcome {
  const byId = new Map(bundle.evidence.map((e) => [e.id, e]));
  if (trustedStore) for (const id of [...draft.evidenceIds, ...draft.counterEvidenceIds]) if (!byId.has(id)) { const e = trustedStore.evidence(bundle.revision, id); if (e) byId.set(id, e); }
  const reasons: string[] = [];
  if (draft.evidenceIds.length === 0) reasons.push("claim cites no evidence");
  const cited = [...draft.evidenceIds, ...draft.counterEvidenceIds];
  for (const id of cited) {
    const ev = byId.get(id);
    if (!ev) reasons.push(`evidence ${id} is not in the retrieved bundle`);
    else if (ev.state !== "CURRENT") reasons.push(`evidence ${id} is ${ev.state}`);
  }
  if (draft.evidenceIds.length > 0 && draft.evidenceIds.every((id) => byId.get(id)?.class === "SPECULATIVE")) reasons.push("only speculative evidence");
  return { gate: "GROUNDING", status: reasons.length ? "FAIL" : "PASS", reasons, evidenceIds: cited };
}

// Containment (symbol ↔ its file) is a static edge too, so claims that route through a file are checkable.
const HOP_KINDS = new Set(["calls", "imports", "async-flow", "contains"]);

export function consistencyGate(draft: ClaimDraft, store?: Store): GateOutcome {
  const out = (status: GateOutcome["status"], reasons: string[]): GateOutcome => ({ gate: "CONSISTENCY", status, reasons, evidenceIds: [] });
  if (store) {
    const prior = store.getClaim(draft.id);
    if (prior?.state === "REFUTED") return out("FAIL", ["previously refuted by a human verdict"]);
  }
  const path = draft.structure?.entityIds;
  if (!path || !store) return out("NOT_APPLICABLE", ["claim has no checkable structure"]);
  const missing = store.entitiesById(draft.revision, path).length !== new Set(path).size;
  if (missing) return out("FAIL", ["claim references an entity that does not exist in this revision"]);
  const reasons: string[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const joined = store.relationshipsFor(draft.revision, a).some((r) => HOP_KINDS.has(r.kind) && ((r.from === a && r.to === b) || (r.from === b && r.to === a)));
    if (!joined) reasons.push(`no static edge between ${a} and ${b}`);
  }
  return reasons.length ? out("FAIL", reasons) : out("PASS", [`${Math.max(0, path.length - 1)} hop(s) re-verified against revision ${draft.revision}`]);
}

/** Deterministic counter-arguments from the stored graph; `modelObjections` come from an optional CHALLENGE call. */
export function adversarialGate(draft: ClaimDraft, store?: Store, modelObjections: Objection[] = []): { gate: GateOutcome; objections: Objection[] } {
  const objections: Objection[] = [];
  const path = draft.structure?.entityIds ?? draft.subjects ?? [];
  if (store) {
    for (const id of path) {
      const fog = store.factsFor(draft.revision, id).filter((f) => f.resolution === "UNRESOLVED" && f.predicate === "calls");
      if (fog.length) objections.push({ text: `${short(id)} makes ${fog.length} call(s) static analysis could not resolve, so the real behavior may include paths not shown.`, evidenceIds: fog.slice(0, 3).flatMap((f) => f.evidence.map((e) => e.id)), blocking: false });
      if (/^(function|method):/.test(id)) {
        const { coverage } = testFactsFor(store, draft.revision, id);
        const reaching = testsReaching(store, draft.revision, id);
        const failing = reaching.filter((t) => t.status === "failed");
        if (failing.length) objections.push({ text: `A failing test exercises ${short(id)}: “${failing[0].name}”${failing[0].message ? ` (${failing[0].message})` : ""}.`, evidenceIds: failing[0].evidenceIds, blocking: false, priority: 3 });
        if (coverage) {
          if (coverage.percent < 50) objections.push({ text: `${short(id)} is only ${coverage.percent}% covered by tests (${coverage.covered}/${coverage.lines} lines).`, evidenceIds: coverage.evidenceIds, blocking: false, priority: 2 });
        } else if (reaching.length === 0) objections.push({ text: `No test directly exercises ${short(id)}.`, evidenceIds: [], blocking: false });
      }
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const hop = store.relationshipsFor(draft.revision, path[i]).find((r) => r.kind === "async-flow" && ((r.from === path[i] && r.to === path[i + 1]) || (r.to === path[i] && r.from === path[i + 1])));
      if (hop) objections.push({ text: `The link ${short(path[i])} ↔ ${short(path[i + 1])} crosses an asynchronous boundary (${hop.label ?? "event"}); ordering and failures are not visible statically.`, evidenceIds: hop.evidence.map((e) => e.id), blocking: true });
    }
  }
  objections.push(...modelObjections);
  const blocking = objections.filter((o) => o.blocking);
  const gate: GateOutcome = {
    gate: "ADVERSARIAL", status: blocking.length ? "INSUFFICIENT" : "PASS",
    reasons: blocking.length ? blocking.map((o) => o.text) : objections.length ? ["caveats noted; none block display"] : ["no counter-argument found"],
    evidenceIds: objections.flatMap((o) => o.evidenceIds),
  };
  return { gate, objections };
}

function short(id: string) { return id.replace(/^[a-z]+:/, "").replace(/^.*#/, ""); }

export function calibrationGate(claimClass: string, store?: Store): { gate: GateOutcome; confidence: Confidence } {
  const { confirmed, refuted } = store ? store.verdictCounts(claimClass) : { confirmed: 0, refuted: 0 };
  const n = confirmed + refuted;
  if (n < CALIBRATION_MIN_LABELS) {
    return {
      gate: { gate: "CALIBRATION", status: "INSUFFICIENT", reasons: [`${n}/${CALIBRATION_MIN_LABELS} labelled verdicts for claim class "${claimClass}"; confidence is not estimated`], evidenceIds: [] },
      confidence: { mode: n > 0 ? "UNCALIBRATED" : "NOT_ESTIMATED", reasonCodes: ["INSUFFICIENT_LABELS"] },
    };
  }
  const band = wilson(confirmed, n);
  return {
    gate: { gate: "CALIBRATION", status: "PASS", reasons: [`${confirmed}/${n} confirmed`], evidenceIds: [] },
    confidence: { mode: "CALIBRATED", band: { ...band, sampleCount: n, confidenceLevel: 0.95 }, reasonCodes: [] },
  };
}

function decide(gates: GateOutcome[], verdicts: Verdict[]): { display: DisplayMode; gate: GateOutcome } {
  const status = (g: string) => gates.find((x) => x.gate === g)?.status;
  const last = verdicts.at(-1)?.verdict;
  let display: DisplayMode = "INFERENCE";
  const why: string[] = [];
  if (last === "REFUTE") { display = "HIDDEN"; why.push("refuted by a human"); }
  else if (status("GROUNDING") === "FAIL") { display = "HIDDEN"; why.push("failed grounding"); }
  else if (status("CONSISTENCY") === "FAIL") { display = "HIDDEN"; why.push("contradicts the stored graph"); }
  else if (last === "CONFIRM") { display = "INFERENCE"; why.push("confirmed by a human (still not deterministic proof)"); }
  else if (status("ADVERSARIAL") === "INSUFFICIENT" || last === "DISPUTE") { display = "HYPOTHESIS"; why.push("a counter-argument cannot be ruled out"); }
  else why.push("grounded and consistent; shown as inference");
  return { display, gate: { gate: "DISPLAY", status: display === "HIDDEN" ? "FAIL" : "PASS", reasons: why, evidenceIds: [] } };
}

/** Blocking objections first, in full; the rest as a count plus one example, so the card stays readable. */
function summarize(objections: Objection[]): string {
  const blocking = objections.filter((o) => o.blocking).map((o) => o.text);
  const caveats = objections.filter((o) => !o.blocking).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const shown = caveats.slice(0, 2).map((c) => c.text).join(" ");
  const tail = caveats.length ? (caveats.length > 2 ? `Also ${caveats.length - 2} more caveat(s). ${shown}` : shown) : "";
  return [...blocking, tail].filter(Boolean).join(" ");
}

function assemble(draft: ClaimDraft, version: number, verdicts: Verdict[], parts: { grounding: GateOutcome; consistency: GateOutcome; adversarial: GateOutcome; objections: Objection[]; calibration: { gate: GateOutcome; confidence: Confidence } }): Claim {
  const { display, gate } = decide([parts.grounding, parts.consistency, parts.adversarial, parts.calibration.gate], verdicts);
  const last = verdicts.at(-1)?.verdict;
  const state: Claim["state"] = last === "CONFIRM" ? "CONFIRMED" : last === "REFUTE" ? "REFUTED"
    : parts.grounding.status !== "PASS" ? "DRAFTED" : display === "HIDDEN" ? "EVIDENCED" : "DISPLAYED";
  return {
    draft, version, state, displayMode: display, verdicts,
    gates: [parts.grounding, parts.consistency, parts.adversarial, parts.calibration.gate, gate],
    confidence: parts.calibration.confidence,
    counterArgument: summarize(parts.objections),
  };
}

export function gateClaim(raw: RawClaim, bundle: EvidenceBundle, opts: GateOptions = {}): Claim {
  const draft: ClaimDraft = {
    id: claimId(bundle.revision, raw.assertion, raw.evidenceIds), revision: bundle.revision,
    assertion: raw.assertion, claimClass: raw.claimClass, evidenceIds: raw.evidenceIds,
    counterEvidenceIds: raw.counterEvidenceIds ?? [], rationaleSummary: raw.rationaleSummary, modelRun: opts.run,
    structure: raw.structure, dependencyIds: raw.dependencyIds, subjects: raw.subjects,
  };
  const adv = adversarialGate(draft, opts.store);
  return assemble(draft, 1, [], {
    grounding: groundingGate(draft, bundle, opts.trusted ? opts.store : undefined), consistency: consistencyGate(draft, opts.store),
    adversarial: adv.gate, objections: adv.objections, calibration: calibrationGate(draft.claimClass, opts.store),
  });
}

/** Re-run the gates with model-supplied objections (grounded ones only) folded in. */
export function withChallenge(claim: Claim, bundle: EvidenceBundle, objections: { text: string; evidenceIds: string[] }[], store?: Store): Claim {
  const known = new Set(bundle.evidence.map((e) => e.id));
  const grounded: Objection[] = objections
    .filter((o) => o.evidenceIds.length === 0 || o.evidenceIds.every((id) => known.has(id)))
    .map((o) => ({ text: `Model objection: ${o.text}`, evidenceIds: o.evidenceIds, blocking: o.evidenceIds.length > 0 }));
  const adv = adversarialGate(claim.draft, store, grounded);
  return assemble(claim.draft, claim.version, claim.verdicts, {
    grounding: claim.gates.find((g) => g.gate === "GROUNDING")!, consistency: claim.gates.find((g) => g.gate === "CONSISTENCY")!,
    adversarial: adv.gate, objections: adv.objections, calibration: calibrationGate(claim.draft.claimClass, store),
  });
}

export type VerdictResult = { ok: true; claim: Claim; affected: Claim[] } | { ok: false; error: ApiError };

/** Human verdicts are commands with an optimistic version check; terminal states are not overwritten by stale requests. */
export function applyVerdict(store: Store, req: { claimId: string; verdict: VerdictKind; explanation: string; actorId: string; expectedVersion: number; evidenceIds?: string[] }): VerdictResult {
  return store.tx<VerdictResult>(() => {
    const claim = store.getClaim(req.claimId);
    if (!claim) return { ok: false, error: { code: "NOT_FOUND", message: "no such claim", retryable: false } };
    if (claim.version !== req.expectedVersion) return { ok: false, error: { code: "VERSION_CONFLICT", message: `claim is at version ${claim.version}`, retryable: false, currentVersion: claim.version } };
    if (!req.explanation.trim()) return { ok: false, error: { code: "INVALID_SCHEMA", message: "a verdict needs an explanation", retryable: false } };
    const v: Verdict = { id: randomUUID(), actorId: req.actorId, claimId: claim.draft.id, verdict: req.verdict, explanation: req.explanation.trim().slice(0, 1000), timestamp: new Date().toISOString(), evidenceIds: req.evidenceIds ?? [] };
    store.addVerdict(v);
    const verdicts = [...claim.verdicts, v];
    const { display, gate } = decide(claim.gates.filter((g) => g.gate !== "DISPLAY"), verdicts);
    const next: Claim = {
      ...claim, version: claim.version + 1, verdicts, displayMode: display,
      state: req.verdict === "CONFIRM" ? "CONFIRMED" : req.verdict === "REFUTE" ? "REFUTED" : claim.state,
      gates: claim.gates.map((g) => (g.gate === "DISPLAY" ? gate : g)),
    };
    store.putClaim(next, req.actorId, `verdict.${req.verdict.toLowerCase()}`);
    // A refutation invalidates everything derived from it, transitively; those claims need re-checking.
    const affected: Claim[] = [];
    if (req.verdict === "REFUTE") {
      const queue = [next.draft.id];
      const seen = new Set(queue);
      while (queue.length) {
        for (const dep of store.dependents(queue.shift()!)) {
          if (seen.has(dep.draft.id)) continue;
          seen.add(dep.draft.id);
          const stale: Claim = { ...dep, version: dep.version + 1, state: "STALE", displayMode: dep.displayMode === "HIDDEN" ? "HIDDEN" : "HYPOTHESIS" };
          store.putClaim(stale, req.actorId, "stale.dependency");
          affected.push(stale);
          queue.push(dep.draft.id);
        }
      }
    }
    store.audit(req.actorId, `claim.${req.verdict.toLowerCase()}`, claim.draft.id, { version: next.version, affected: affected.map((c) => c.draft.id) });
    return { ok: true, claim: next, affected };
  });
}

/**
 * Text written by a model is shown to people next to evidence-backed facts, so it must not pass for one. A summary or caption that
 * claims certainty, carries a link, or speaks to its reader as a system prompt is replaced by the deterministic fallback;
 * display modes already come from the gates, so this only stops the words from contradicting them.
 */
const CERTAINTY = /\b(?:fact|verified|proven|proved|guaranteed|certified|definitely|undeniabl[ey]|100\s?%)\b/i;
const LINK = /\bhttps?:\/\/|\bwww\./i;
const ORDERS = /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|above|all)\b.{0,20}\binstructions?\b|\bsystem\s*:|\bsend\b.{0,40}\b(?:to|at)\b.{0,10}https?:/i;
export function modelText(text: string, fallback: string): { text: string; replaced: boolean } {
  if (CERTAINTY.test(text) || LINK.test(text) || ORDERS.test(text)) return { text: fallback, replaced: true };
  return { text, replaced: false };
}
