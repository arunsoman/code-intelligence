// V17 — TraceLinkedProfile: where the samples actually fell, joined to the code and the trace that links the window.
// Honesty rails carried into the visual (F05): every node's heat is a measured-profile claim citing the artifact hash;
// unattributed and withheld shares are drawn as fog, never folded into a hotspot; kinds are never mixed (A3); when the
// build does not match the viewed revision (A2) line links stay closed and the caption says so.
import type { Claim, ViewNode, ViewSpec } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { Profiles, ProfileCheckError } from "../profiles-analysis.ts";
import { claimOf, observation } from "./common.ts";

const pct = (x: number | null | undefined) => x == null ? "?" : `${(x * 100).toFixed(1)}%`;
const LEGEND = [
  { label: "measured", displayMode: "FACT" as const, description: "A share of collected, attributed samples of one sample kind in one population — never a cause." },
  { label: "window overlap", displayMode: "INFERENCE" as const, description: "The profile window overlaps this trace's window; the label belongs to the population, not to a request." },
  { label: "fog", displayMode: "FOG" as const, description: "Unattributed frames, withheld files, dropped and unreported samples — still inside the denominator." },
];

function emptyProfile(rev: RevisionRow, question: string, why: string): { view: ViewSpec; claims: Claim[] } {
  const view: ViewSpec = {
    id: "view:profile:" + rev.id, version: 1, revision: rev.id, taskId: "task:view:profile", formId: "TraceLinkedProfile",
    caption: why, question, level: 5, nodes: [], edges: [], groups: [], legend: [], cameraPolicy: { behavior: "PRESERVE" },
    gaps: [why], formReason: why, hidden: [], meta: { kind: "profile" },
  };
  return { view, claims: [] };
}

function baseProfileView(o: { rev: RevisionRow; question: string; caption: string; reason: string }): ViewSpec {
  return {
    id: "view:profile:" + o.rev.id, version: 1, revision: o.rev.id, taskId: "task:view:profile", formId: "TraceLinkedProfile",
    caption: o.caption, question: o.question, level: 5, nodes: [], edges: [], groups: [], legend: LEGEND,
    cameraPolicy: { behavior: "PRESERVE" }, gaps: [], formReason: o.reason, hidden: [], meta: { kind: "profile" },
  };
}

export function buildProfile(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const profiles = new Profiles(store, {} as never); // read paths touch only the store; the worker is never called here
  const artifacts = profiles.listArtifacts().filter((a) => !subject || a.artifactHash === subject);
  if (!artifacts.length) {
    return emptyProfile(rev, question, "No profile has been imported into this store yet. In the Profiles panel, import a V8 .cpuprofile or folded-stack file first.");
  }
  const view = baseProfileView({ rev, question, caption: "", reason: "You asked where the samples fall, so this shows the hotspot table as a view: measured samples of one sample kind, with the window-overlap wording and never a causal claim." });
  const claims: Claim[] = [];
  let best: ReturnType<Profiles["queryHotspots"]> | null = null;
  let chosen: ReturnType<Profiles["listArtifacts"]>[number] | null = null;
  for (const a of artifacts) {
    try {
      const res = profiles.queryHotspots({ artifactHash: a.artifactHash, limit: 15, viewRevision: rev.id });
      if (!best || res.sampleCount > best.sampleCount) { best = res; chosen = a; }
    } catch (e) { if (!(e instanceof ProfileCheckError)) throw e; }
  }
  if (!best || !chosen) return emptyProfile(rev, question, "A profile is stored but no sample kind survived ingestion; see the Profiles panel diagnostics.");
  const artifactHash = chosen.artifactHash;
  const state = (store.db.prepare("select revision_state from profile_mappings where artifact_hash = ? limit 1").get(artifactHash) as { revision_state?: string } | undefined)?.revision_state ?? "UNKNOWN";
  for (const r of best.rows) {
    if (r.functionKey === "__withheld__" || r.functionKey === "__unattributed__") continue; // drawn once as fog below
    const key = `profile-hotspot:${artifactHash.slice(0, 12)}:${r.functionKey}`;
    // Mint evidence for the measured share; its locator cites artifact, population and counts (F05-A5, §7.9).
    const ev = observation(store, rev.id, key, "RUNTIME", r.file ?? "",
      `${r.rank}. ${r.name} — ${pct(r.selfShare)} of ${best.unit} samples (self), ${pct(r.totalShare)} cumulative; population ${best.populationHash.slice(0, 12)}, n=${r.sampleCount}`,
      new Date().toISOString());
    const entityId = r.entityId ?? null;
    const claim = claimOf(store, rev.id, {
      assertion: `${r.name} measured ${pct(r.selfShare)} self / ${pct(r.totalShare)} cumulative of ${best.unit} samples (n=${r.sampleCount}) — a measured profile of one window; not a cause, not a per-request rate.`,
      claimClass: "measured-profile", evidenceIds: [ev.id],
      rationaleSummary: `Hotspot aggregate of profile ${artifactHash.slice(0, 12)}, correlation grade ${best.grade}.`,
    });
    claims.push(claim);
    if (!entityId) continue;
    const node: ViewNode = {
      id: key, entityRefs: [entityId], label: r.name, kind: "profile-hotspot", file: r.file ?? "",
      claimIds: [claim.draft.id], evidenceIds: [ev.id], tier: r.rank === 1 ? "CRITICAL" : "RELEVANT",
      displayMode: "FACT", unresolvedCalls: 0, role: "hotspot", rank: r.rank, score: r.selfShare,
      heat: { value: Math.max(0, Math.min(1, r.selfShare)), label: `${pct(r.selfShare)} of samples` },
      notes: [
        r.attributionMethod === "CODE_LOCATION_EXACT" ? "source line linked (F05-D2)" : r.attributionMethod === "FUNCTION_NAME" ? "function name matched only; line links closed" : r.attributionMethod === "ACCESS_DENIED" ? "withheld by policy" : "unattributed to this revision's code",
        `uncertainty ${pct(r.uncertaintyLow)}–${pct(r.uncertaintyHigh)} (Wilson, ${r.sampleCount} samples)`,
      ],
    };
    view.nodes.push(node);
  }
  // Unattributed and withheld rows are part of the same population — drawn as fog, never as a hotspot (F05-D9).
  const un = best.rows.find((r) => r.functionKey === "__unattributed__"), wh = best.rows.find((r) => r.functionKey === "__withheld__");
  const fogNote = [
    un ? `frames outside this repository's code hold ${pct(un.selfShare)} of samples` : "",
    wh ? `files denied by the access policy are drawn as one "(withheld)" row holding ${pct(wh.selfShare)} of samples; denominators keep the whole population` : "",
    state === "MISMATCH" ? "the profile's build does not match this revision, so no source line linking is shown (F05-A2)" : "",
  ].filter(Boolean);
  view.gaps = [
    `basis: ${best.unit} samples; population ${best.populationHash.slice(0, 12)}; ${pct(best.coverage.collectionRatio)} collected` + (best.coverage.droppedSamples === "NOT_REPORTED" ? "; dropped samples: not reported" : `; ${best.coverage.droppedSamples} samples dropped`),
    ...fogNote,
    ...(best.coverage.truncatedStacks ? [`${best.coverage.truncatedStacks} stacks were truncated by the depth cap`] : []),
  ];
  view.caption = `Measured samples of kind ${best.unit}: top functions of population ${best.populationHash.slice(0, 12)}. ${state === "MISMATCH" ? "Build mismatch: no line links (F05-A2). " : ""}Correlation ${best.grade}.`;
  return { view, claims };
}