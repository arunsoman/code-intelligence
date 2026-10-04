import type { Claim, ClaimState, DisplayMode, EvidenceClass } from "@cie/schema";
import type { Store } from "./store.ts";

/** Allowed lifecycle moves. Same-state moves (re-gating, version bump) are always allowed. RETIRED is terminal. */
export const TRANSITIONS: Record<ClaimState, ClaimState[]> = {
  DRAFTED: ["EVIDENCED", "DISPLAYED", "STALE", "RETIRED"],
  EVIDENCED: ["DRAFTED", "DISPLAYED", "CONFIRMED", "REFUTED", "STALE", "RETIRED"],
  DISPLAYED: ["DRAFTED", "EVIDENCED", "CONFIRMED", "REFUTED", "STALE", "RETIRED"],
  CONFIRMED: ["REFUTED", "STALE", "RETIRED"],
  REFUTED: ["RETIRED"],
  STALE: ["DRAFTED", "EVIDENCED", "DISPLAYED", "CONFIRMED", "REFUTED", "RETIRED"],
  RETIRED: [],
};

export function canTransition(from: ClaimState | null, to: ClaimState): boolean {
  return from === null || from === to || TRANSITIONS[from].includes(to);
}

export interface ClaimEvent { claimId: string; seq: number; event: string; from: ClaimState | null; to: ClaimState; displayMode: DisplayMode; version: number; actor: string; at: string; detail: unknown }

export function claimHistory(store: Store, claimId: string): ClaimEvent[] {
  return (store.db.prepare("select * from claim_events where claim_id = ? order by seq").all(claimId) as any[]).map(rowToEvent);
}
function rowToEvent(r: any): ClaimEvent {
  return { claimId: r.claim_id, seq: r.seq, event: r.event, from: r.from_state, to: r.to_state, displayMode: r.display_mode, version: r.version, actor: r.actor, at: r.at, detail: JSON.parse(r.detail) };
}

/** Historical replay: the state and display mode of a claim as of a point in time, from the append-only ledger alone. */
export function replayAt(store: Store, claimId: string, at: string): { state: ClaimState; displayMode: DisplayMode; version: number } | null {
  const ev = claimHistory(store, claimId).filter((e) => e.at <= at).at(-1);
  return ev ? { state: ev.to, displayMode: ev.displayMode, version: ev.version } : null;
}

/** Every claim as it stood at `at`; claims born later are absent. */
export function replayAllAt(store: Store, at: string): Record<string, { state: ClaimState; displayMode: DisplayMode; version: number }> {
  const ids = (store.db.prepare("select distinct claim_id from claim_events").all() as any[]).map((r) => r.claim_id as string);
  const out: Record<string, any> = {};
  for (const id of ids) { const s = replayAt(store, id, at); if (s) out[id] = s; }
  return out;
}

/** Evidence chain for a claim: the claim's evidence, its counter-evidence, verdicts and the transitions that produced its current state. */
export function evidenceChain(store: Store, claimId: string) {
  const c = store.getClaim(claimId);
  if (!c) return null;
  const rev = c.draft.revision;
  const ev = (ids: string[]) => ids.map((id) => store.evidence(rev, id)).map((e, i) => e ?? { id: ids[i], missing: true });
  return { claim: c.draft.assertion, state: c.state, displayMode: c.displayMode, evidence: ev(c.draft.evidenceIds), counterEvidence: ev(c.draft.counterEvidenceIds), verdicts: c.verdicts, history: claimHistory(store, claimId), dependsOn: c.draft.dependencyIds ?? [] };
}

// ---- roles & alarm eligibility (C16 validateAlarm) ----
export function grantRole(store: Store, principal: string, role: string) {
  store.db.prepare("insert or ignore into roles values (?,?,?)").run(principal, role, new Date().toISOString());
}
export function hasRole(store: Store, principal: string, role: string): boolean {
  return !!store.db.prepare("select 1 from roles where principal = ? and role = ?").get(principal, role);
}

const PROOF_CLASSES: EvidenceClass[] = ["STATIC_RESOLVED", "TEST", "RUNTIME"];
export const ALARM_ROLE = "alarm-approver";

export interface AlarmDecision { eligible: boolean; basis: "DETERMINISTIC_PROOF" | "TWO_CONFIRMATIONS" | "NONE"; reasons: string[] }

/**
 * An alarm needs either deterministic proof evidence (current, resolved-static / test / runtime, cited by the claim) or two CONFIRM
 * verdicts on the current claim from distinct authorised principals. Model agreement, inferred or speculative evidence, refuted,
 * hidden, stale or retired claims never qualify; a human CONFIRM is a verdict, not proof, so it cannot be combined with weak evidence alone.
 */
export function validateAlarm(store: Store, claim: Claim, proofEvidenceIds: string[] = []): AlarmDecision {
  const reasons: string[] = [];
  if (["REFUTED", "RETIRED", "STALE"].includes(claim.state)) return { eligible: false, basis: "NONE", reasons: [`claim is ${claim.state}`] };
  if (claim.displayMode === "HIDDEN") return { eligible: false, basis: "NONE", reasons: ["claim is hidden"] };
  const cited = new Set(claim.draft.evidenceIds);
  const proof = proofEvidenceIds.filter((id) => {
    if (!cited.has(id)) { reasons.push(`${id} is not cited by the claim`); return false; }
    const e = store.evidence(claim.draft.revision, id);
    if (!e) { reasons.push(`${id} does not exist`); return false; }
    if (e.state !== "CURRENT") { reasons.push(`${id} is ${e.state}`); return false; }
    if (!PROOF_CLASSES.includes(e.class)) { reasons.push(`${id} is ${e.class}, not deterministic proof`); return false; }
    return true;
  });
  if (proof.length > 0) return { eligible: true, basis: "DETERMINISTIC_PROOF", reasons: [] };
  const authors = new Set<string>();
  const confirmers = new Set<string>();
  for (const v of claim.verdicts) {
    if (v.verdict === "CONFIRM" && hasRole(store, v.actorId, ALARM_ROLE) && v.actorId !== claim.draft.modelRun?.runId && !authors.has(v.actorId)) confirmers.add(v.actorId);
    if (v.verdict === "REFUTE") confirmers.delete(v.actorId);
  }
  if (confirmers.size >= 2) return { eligible: true, basis: "TWO_CONFIRMATIONS", reasons: [] };
  reasons.push(`${confirmers.size} authorised confirmation(s); two distinct approvers or deterministic proof required`);
  return { eligible: false, basis: "NONE", reasons };
}
