// F11 — Blast radius: the cited impact report behind the PR impact comment (§6, §7).
//
// A distribution wedge, not a new analysis engine: everything here is assembled from data the PR job already
// computes and used to discard (the ChangeSet from history.compare). Ranking is a transparent weighted sum whose
// factors and weights are declared below with an explicit calibration status — every weight ships "uncalibrated"
// until the §14 retrospective says otherwise, and no weight is described as validated before that run.
//
// The honest-label gate (checkImpactLine) is a pure function: a comment line that fails it cannot be produced.
// Claim classes come from a fixed table keyed by consequence kind (F11-A10) — the mapping is code with a test
// per kind, not a heuristic, and a Hypothesis can never be rendered as a Fact.
import { createHash } from "node:crypto";
import type { AnalyzerRecord, ImpactItem, ImpactItemKind, ImpactReport, CoverageEvidence } from "@cie/schema";
import type { ChangeSet, Consequence } from "./history.ts";
import { canonicalJson } from "./pr-gate.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- fixed class table (§7.1.2, F11-A10)

/**
 * Consequence kind → claim class. A consequence derived from stored facts of both revisions is FACT only when it
 * states a single directly-observed fact; reachability and aggregation consequences are INFERENCE; nothing here is
 * a HYPOTHESIS (a hypothesis crosses an async hand-off or dynamic call, which no current consequence kind does —
 * race-window candidates, when they land, carry their own class). One test per kind pins this table.
 */
export const CONSEQUENCE_CLASS: Record<Consequence["kind"], ImpactItem["claimClass"]> = {
  CALL_ADDED: "FACT", // a calls edge present at head, absent at base: one stored relationship
  CALL_REMOVED: "FACT", // recorded against an observation of the base revision
  NEW_EXTERNAL_DEPENDENCY: "FACT", // one imports_external fact
  ERROR_PATH_ADDED: "FACT", // one throws fact
  TESTS_LOST: "FACT", // two test-name sets compared directly
  MODULE_COUPLING: "INFERENCE", // an aggregation over call edges, not one observed edge
  TRANSACTION_BYPASS: "INFERENCE", // a reachability chain, several hops
  TRANSACTION_RESTORED: "INFERENCE",
  WRITE_REACH_CHANGED: "INFERENCE",
  NEW_CYCLE: "INFERENCE", // computed cycle structure
};

// Claim-class rule (F11-A5): each kind may carry only the classes the fixed table assigns it (§7.1.2) — a
// consequence is never a HYPOTHESIS (no consequence kind crosses an async hand-off), and only Fog lines are Fog.
const classAllowed = (kind: ImpactItemKind, claimed: ImpactItem["claimClass"]): boolean => {
  if (kind === "FOG") return claimed === "FOG";
  if (kind === "TEST_IMPACT") return claimed === "FACT";
  if (kind === "CONSEQUENCE") return claimed === "FACT" || claimed === "INFERENCE"; // never HYPOTHESIS: no consequence kind crosses an async hand-off (§7.1.2)
  return true; // later-section kinds carry their own classes
};

// ---------------------------------------------------------------- ranking (§7.2): one weights table, all uncalibrated

/** Kind severity, highest first (§7.2). Slice-4 kinds join this table when their sections land. */
export const KIND_SEVERITY: Record<string, number> = {
  TRANSACTION_BYPASS: 10,
  TESTS_LOST: 9,
  NEW_CYCLE: 8,
  ERROR_PATH_ADDED: 7,
  WRITE_REACH_CHANGED: 6,
  TRANSACTION_RESTORED: 5,
  MODULE_COUPLING: 4,
  NEW_EXTERNAL_DEPENDENCY: 3,
  CALL_ADDED: 2,
  CALL_REMOVED: 2,
  TEST_IMPACT: 9,
};

/** The one weights table (§7.2). status stays "uncalibrated" until the §14 retrospective measures precision/recall. */
export const RANK_WEIGHTS = [
  { name: "kind severity", weight: 3, status: "uncalibrated" as const, note: "fixed order in KIND_SEVERITY; TRANSACTION_BYPASS > TESTS_LOST > NEW_CYCLE > ERROR_PATH_ADDED > MODULE_COUPLING > CALL_ADDED/REMOVED" },
  { name: "reach", weight: 2, status: "uncalibrated" as const, note: "normalised dependent count of the subject (max-normalised over this report)" },
  { name: "test gap", weight: 1.5, status: "uncalibrated" as const, note: "1 when the subject has no test reaching it at the head" },
  { name: "history", weight: 1, status: "uncalibrated" as const, note: "hotspot lineage (F06); 0 until the terrain join lands (slice S4)" },
  { name: "certainty", weight: 1, status: "uncalibrated" as const, note: "FACT 1 > INFERENCE 2/3 > HYPOTHESIS 1/3; a hypothesis may rank high only through reach and severity, and is always labelled" },
] as const;
const weightOf = (name: string) => RANK_WEIGHTS.find((w) => w.name === name)?.weight ?? 0;

// ---------------------------------------------------------------- policy (§7.4): silence is a designed outcome

export interface ImpactPolicy {
  /** Show at most this many items (default 3). */
  maxItems: number;
  /** Items scoring below this stay suppressed (default 6, uncalibrated). */
  minScore: number;
  /** When true, post a minimal "nothing notable" comment instead of staying silent. */
  alwaysComment: boolean;
  /** Hard comment length budget in bytes (§13). */
  maxCommentBytes: number;
}

export const DEFAULT_IMPACT_POLICY: ImpactPolicy = { maxItems: 3, minScore: 6, alwaysComment: false, maxCommentBytes: 8 * 1024 };

export function validateImpactPolicy(x: unknown): { ok: true; policy: ImpactPolicy } | { ok: false; problems: string[] } {
  const p = (x ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const num = (k: string, def: number, min: number, max: number): number => {
    const v = p[k];
    if (v === undefined) return def;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) { problems.push(`${k} must be a number in [${min}, ${max}]`); return def; }
    return v;
  };
  const policy: ImpactPolicy = {
    maxItems: Math.round(num("maxItems", DEFAULT_IMPACT_POLICY.maxItems, 1, 20)),
    minScore: num("minScore", DEFAULT_IMPACT_POLICY.minScore, 0, 1000),
    alwaysComment: p.alwaysComment === undefined ? DEFAULT_IMPACT_POLICY.alwaysComment : p.alwaysComment === true,
    maxCommentBytes: Math.round(num("maxCommentBytes", DEFAULT_IMPACT_POLICY.maxCommentBytes, 1024, 64 * 1024)),
  };
  return problems.length ? { ok: false, problems } : { ok: true, policy };
}

// ---------------------------------------------------------------- building the report (§7.1)

const short = (id: string) => id.replace(/^[a-z]+:/, "").replace(/^.*#/, "");
const stableItemId = (kind: string, subject: string, text: string) => "imp:" + sha(`${kind}|${subject}|${text}`).slice(0, 16);

export interface ImpactBuildInput {
  analysisId: string;
  baseHash: string;
  headHash: string;
  cs: ChangeSet;
  coverage: CoverageEvidence | null;
  analyzers: AnalyzerRecord[];
  /** Unresolved dynamic-call relationships at the head (a Fog input). */
  unresolvedDynamicCalls: number;
  /** The analysis is INCOMPLETE: its state is stated first, never footnoted (§9). */
  incomplete: boolean;
  incompleteReasons: string[];
  /** Map an evidence id to its cited location, when one is stored. */
  evidenceLocation?: (evidenceId: string) => { path: string; startLine: number; endLine: number } | null;
  policy?: ImpactPolicy;
  now?: string;
}

const subjectOf = (cs: ChangeSet, text: string): string[] => {
  // Deterministic subject recovery: the touched head entities whose short name appears as a word in the
  // consequence text. Consequences name their subjects in the template ("charge now reaches …"), so this is a
  // lookup, not a guess; a consequence that names nothing touched keeps an empty subject and ranks on severity alone.
  const touched = cs.entities.filter((e) => e.head && e.change !== "UNCHANGED").map((e) => e.head!);
  const names = new Map(touched.map((id) => [short(id), id]));
  const found = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$.]*/g)) {
    const id = names.get(m[0]);
    if (id) found.add(id);
  }
  return [...found];
};

function rankItem(severityKind: string, claimClass: ImpactItem["claimClass"], subjects: string[], cs: ChangeSet, noTestAtHead: Set<string>) {
  const factors: { name: string; value: number; weight: number }[] = [];
  const push = (name: string, value: number) => factors.push({ name, value, weight: weightOf(name) });
  push("kind severity", KIND_SEVERITY[severityKind] ?? 1);
  let maxDependents = 1;
  for (const b of cs.blastRadius) maxDependents = Math.max(maxDependents, b.dependents);
  const reach = subjects.length
    ? Math.max(...subjects.map((s) => cs.blastRadius.find((b) => b.entityId === s)?.dependents ?? 0)) / maxDependents
    : 0;
  push("reach", Math.round(reach * 100) / 100);
  push("test gap", subjects.length && subjects.every((s) => noTestAtHead.has(s)) ? 1 : 0);
  push("history", 0); // slice S4: hotspot lineage join; the factor stays visible so the "why?" view is honest about its absence
  push("certainty", claimClass === "FACT" ? 1 : claimClass === "INFERENCE" ? 2 / 3 : claimClass === "HYPOTHESIS" ? 1 / 3 : 0);
  const score = Math.round(factors.reduce((n, f) => n + f.value * f.weight, 0) * 100) / 100;
  return { score, factors };
}

/** Map the ChangeSet the PR job already computed into the report (§7.1). Pure. */
export function buildImpactReport(input: ImpactBuildInput): ImpactReport {
  const policy = input.policy ?? DEFAULT_IMPACT_POLICY;
  const cs = input.cs;
  const loc = input.evidenceLocation ?? (() => null);
  const noTestAtHead = new Set(cs.testImpact.filter((t) => !t.unchanged.length && !t.gained.length).map((t) => t.entityId));

  const items: ImpactItem[] = [];
  const seen = new Map<string, ImpactItem>();
  const addItem = (kind: ImpactItemKind, claimClass: ImpactItem["claimClass"], text: string, subjects: string[], evidenceIds: string[], severityKind?: string) => {
    const id = stableItemId(kind, subjects.sort().join(",") || text.slice(0, 40), text);
    if (seen.has(id)) return seen.get(id)!;
    const citations = [...new Map(evidenceIds.map((e) => [e, loc(e)])).values()].filter((x): x is NonNullable<typeof x> => !!x);
    const item: ImpactItem = {
      id, kind, claimClass, text, subjectEntityIds: subjects, evidenceIds, citations,
      rank: rankItem(severityKind ?? kind, claimClass, subjects, cs, noTestAtHead), calibration: "uncalibrated",
    };
    if (severityKind) item.kindDetail = severityKind; // F15: mutes and kind weights address this namespace
    seen.set(id, item);
    items.push(item);
    return item;
  };

  // Fog items land in `report.fog` (§7.1.5) as well as the item table.
  const fog: ImpactItem[] = [];
  const pushFog = (text: string) => { const f = addItem("FOG", "FOG", text, [], []); if (!fog.includes(f)) fog.push(f); };

  // §7.1.2 — consequences, preserving claimId and evidenceIds; class from the fixed table. The consequence kind
  // (not the item kind) drives the severity ranking.
  for (const c of cs.consequences) {
    addItem("CONSEQUENCE", CONSEQUENCE_CLASS[c.kind] ?? "INFERENCE", c.text, subjectOf(cs, c.text), c.evidenceIds, c.kind);
  }
  // §7.1.3 — test impact with lost tests; missing coverage on changed lines is Fog, never a pass.
  for (const ti of cs.testImpact) {
    if (!ti.lost.length) continue;
    const text = `${ti.lost.join(", ")} no longer reach${ti.lost.length === 1 ? "es" : ""} ${short(ti.entityId)}.`;
    addItem("TEST_IMPACT", "FACT", text, [ti.entityId], []);
  }
  if (input.coverage && input.coverage.executableChangedLines > 0 && input.coverage.percent === null) {
    pushFog(`No coverage evidence for ${input.coverage.executableChangedLines} changed line(s) (${input.coverage.disclosure ?? "no artifact named this head"}).`);
  }

  // Fog (§7.1.5): analysis gaps, skipped files, unfinished analyzers and unresolved dynamic calls — counted, never
  // skipped silently.
  for (const g of cs.gaps) pushFog(g.endsWith(".") ? g : g + ".");
  for (const a of input.analyzers) {
    if (a.coverage.skippedFiles > 0) pushFog(`${a.coverage.skippedFiles} file(s) were not analysed by ${a.id}@${a.version} (${a.coverage.reason}).`);
    if (a.state !== "COMPLETE") pushFog(`Analyzer ${a.id}@${a.version} states ${a.state}${a.reason ? `: ${a.reason}` : ""}; its findings are not claimed.`);
  }
  if (input.unresolvedDynamicCalls > 0) {
    pushFog(`${input.unresolvedDynamicCalls} dynamic call(s) at the head could not be resolved by static analysis; behaviour behind them is not analysed (frameworks, proxies and configuration are invisible to static analysis).`);
  }

  // §7.3 dedupe. Same subject+kind already collapsed in addItem (the stable id). Here: within one entity pair, a
  // lower-severity consequence restating what a higher-severity consequence states is suppressed DUPLICATE — kept in
  // `suppressed` so "why not?" can explain it. Only consequences participate: a TEST_IMPACT line or a reach line on
  // the same subject states a different fact and must survive.
  const kindOf = (item: ImpactItem): string => cs.consequences.find((c) => c.text === item.text)?.kind ?? "";
  const deduped: ImpactItem[] = [];
  const pairBest = new Map<string, ImpactItem>();
  for (const item of items) {
    if (item.kind !== "CONSEQUENCE" || !item.subjectEntityIds.length) { deduped.push(item); continue; }
    const pair = [...item.subjectEntityIds].sort().join(">");
    const prior = pairBest.get(pair);
    if (prior && (KIND_SEVERITY[kindOf(item)] ?? 0) < (KIND_SEVERITY[kindOf(prior)] ?? 0)) {
      item.suppressed = { reason: "DUPLICATE" };
      continue; // recovered into suppressed below via `items`
    }
    if (prior) { item.suppressed = { reason: "DUPLICATE" }; continue; } // same pair already stated; kept for "why not?"
    pairBest.set(pair, item);
    deduped.push(item);
  }

  // §7.2 rank + §7.4 threshold. Everything not surfaced is suppressed with its reason — silence is explained, in the
  // report, so "why not?" never has to guess.
  const ranked = deduped.filter((i) => i.kind !== "FOG").sort((a, b) => b.rank.score - a.rank.score || a.id.localeCompare(b.id));
  const surfaced: ImpactItem[] = [];
  const suppressed: ImpactItem[] = [];
  for (const item of ranked) {
    if (item.rank.score >= policy.minScore && surfaced.length < policy.maxItems) { surfaced.push(item); continue; }
    suppressed.push({ ...item, suppressed: { reason: item.rank.score < policy.minScore ? "BELOW_THRESHOLD" : "LENGTH_BUDGET" } });
  }
  for (const item of items) if (item.suppressed?.reason === "DUPLICATE") suppressed.push(item);
  suppressed.sort((a, b) => b.rank.score - a.rank.score || a.id.localeCompare(b.id));

  const reach = {
    changedSymbols: cs.entities.filter((e) => e.change !== "UNCHANGED").length,
    dependents: cs.blastRadius.reduce((n, b) => n + b.dependents, 0),
    files: new Set(cs.blastRadius.flatMap((b) => b.files)).size,
    hotspotFiles: 0, // slice S4: change-risk terrain join
    thinOwnershipFiles: 0, // slice S4: ownership overlay
  };
  const languages = new Map<string, { analysedFiles: number; skippedFiles: number }>();
  for (const a of input.analyzers) {
    const cur = languages.get(a.id) ?? { analysedFiles: 0, skippedFiles: 0 };
    cur.analysedFiles += a.coverage.analyzedFiles;
    cur.skippedFiles += a.coverage.skippedFiles;
    languages.set(a.id, cur);
  }
  return {
    analysisId: input.analysisId, headHash: input.headHash, baseHash: input.baseHash,
    generatedAt: input.now ?? new Date().toISOString(), schemaVersion: 1,
    surfaced, suppressed, reach,
    coverage: { languages: [...languages].map(([id, v]) => ({ id, ...v })), evidenceComplete: input.analyzers.every((a) => a.state === "COMPLETE") },
    fog,
  };
}

export const impactReportHash = (r: ImpactReport) => "imr:" + sha(canonicalJson(r)).slice(0, 16);

/** "why this / why not?" for one item (§8): the rank factors with weights, or the suppression reason. */
export function explainImpactItem(report: ImpactReport, itemId: string):
  | { kind: "surfaced"; itemId: string; score: number; calibration: string; factors: { name: string; value: number; weight: number; status: string; note: string }[] }
  | { kind: "suppressed"; itemId: string; reason: string; score: number; calibration: string; factors: { name: string; value: number; weight: number; status: string; note: string }[] }
  | { kind: "not-found"; itemId: string } {
  const annotate = (i: ImpactItem) => ({
    itemId: i.id, score: i.rank.score, calibration: i.calibration,
    factors: i.rank.factors.map((f) => ({ ...f, status: RANK_WEIGHTS.find((w) => w.name === f.name)?.status ?? "uncalibrated", note: RANK_WEIGHTS.find((w) => w.name === f.name)?.note ?? "" })),
  });
  const hit = report.surfaced.find((i) => i.id === itemId);
  if (hit) return { kind: "surfaced", ...annotate(hit) };
  const sup = report.suppressed.find((i) => i.id === itemId);
  if (sup) return { kind: "suppressed", reason: sup.suppressed?.reason ?? "BELOW_THRESHOLD", ...annotate(sup) };
  return { kind: "not-found", itemId };
}

// ---------------------------------------------------------------- the honest-label gate (§7.6, F11-A3/A5)

/** Causal or certainty wording no template in this feature produces (§7.6.3, §12.2). */
export const FORBIDDEN_LINE_WORDING = /\b(will break|will fail|will cause|causes|caused by|is safe|are safe|safe to|verified|guaranteed|guarantees?|proves?|bug)\b/i;

export type ImpactLineRejection =
  | { ok: false; rule: 1; reason: "a non-Fog line needs a resolvable evidence id" }
  | { ok: false; rule: 2; reason: "the claim class is stronger than the fixed table allows for this kind" }
  | { ok: false; rule: 3; reason: "the sentence contains causal or certainty wording no template produces" }
  | { ok: false; rule: 4; reason: "a citation path is under a denied prefix"; withheld: number }
  | { ok: true };

/**
 * The presentation gate (§7.6). Pure, and total over its input: whatever a caller hands it, the answer is one of
 * the five verdicts. Rule 2 implements F11-A5 by construction — the class table is consulted, never the caller's
 * say-so — and the strength order makes the intent explicit even though `classAllowed` already encodes it.
 */
export function checkImpactLine(
  item: Pick<ImpactItem, "kind" | "claimClass" | "text" | "evidenceIds" | "citations">,
  opts: {
    /** Returns whether an evidence id resolves to a stored evidence row (F11-A3: deleting the row rejects the line). */
    resolveEvidence?: (evidenceId: string) => boolean;
    /** Denied path prefixes: a citation under one is withheld — counted, never named (F11-A7). */
    deniedPrefixes?: string[];
  } = {},
): ImpactLineRejection {
  // Rule 1 (F11-A3): a non-Fog line needs a resolvable evidence id. TEST_IMPACT is exempt by design: its evidence
  // is the two-revision test-name comparison recorded in the ChangeSet, and the line itself names the lost tests.
  if (item.kind !== "FOG" && item.kind !== "TEST_IMPACT" && item.claimClass !== "FOG") {
    if (!item.evidenceIds.length) return { ok: false, rule: 1, reason: "a non-Fog line needs a resolvable evidence id" };
    if (opts.resolveEvidence && !item.evidenceIds.some((e) => opts.resolveEvidence!(e))) return { ok: false, rule: 1, reason: "a non-Fog line needs a resolvable evidence id" };
  }
  if (!classAllowed(item.kind, item.claimClass)) return { ok: false, rule: 2, reason: "the claim class is stronger than the fixed table allows for this kind" };
  if (FORBIDDEN_LINE_WORDING.test(item.text)) return { ok: false, rule: 3, reason: "the sentence contains causal or certainty wording no template produces" };
  const denied = opts.deniedPrefixes ?? [];
  if (denied.length && item.citations.length) {
    const withheld = item.citations.filter((c) => denied.some((p) => c.path === p || c.path.startsWith(p + "/"))).length;
    if (withheld) return { ok: false, rule: 4, reason: "a citation path is under a denied prefix", withheld };
  }
  return { ok: true };
}
