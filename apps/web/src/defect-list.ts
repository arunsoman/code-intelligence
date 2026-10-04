// Pure list machinery for the "Defects and performance" panel: plain-language registries for the
// detector's vocabulary, filtering/sorting, grouping by file, windowing for the virtualized list,
// and the one-line row identity. No React, no DOM: everything here is unit-tested directly.

import type { DetectorFinding, ResolvedEvidence, Severity } from "@cie/schema";

export type TriageStatus = "NEW" | "REVIEWED" | "DISMISSED";

// ---------------------------------------------------------------- plain-language registries
// Terms the detector emits are opaque; every one gets a one-liner a person can act on (UX-19/20/22).

export const KIND_INFO: Record<string, { label: string; what: string; fix: string }> = {
  DEADLOCK_CANDIDATE: {
    label: "Deadlock candidate",
    what: "A path of code can acquire one lock and then another while a second path acquires them in the opposite order. If both run at once, neither can finish.",
    fix: "Give the two locks a single agreed order and take them in that order everywhere, or take one lock that covers both, or use try-lock with a timeout and back off.",
  },
  MEMORY_RACE: {
    label: "Memory race",
    what: "Two different threads can read and write the same memory without any ordering between them, so the result can differ between runs.",
    fix: "Protect the shared state with one lock (or make it thread-local), or switch the access to an atomic type. Then re-running the detector should no longer flag it.",
  },
  LOGICAL_RACE: {
    label: "Logical race",
    what: "The interleaving is not a raw memory race, but two steps can happen in an order the logic does not expect (for example a check and its use drifting apart).",
    fix: "Make the sequence atomic (single lock, single transaction, or message-based ordering) so an interleaved run cannot split check and use.",
  },
  STARVATION: {
    label: "Starvation",
    what: "A thread or request can be kept waiting indefinitely while others are always chosen first.",
    fix: "Bound the waiting (timeouts, fair queues, admission control) so no caller can be skipped forever.",
  },
  CONTENTION: {
    label: "Contention",
    what: "One lock is a choke-point: enough callers queue on it and waiting time becomes visible.",
    fix: "Shrink the section held under the lock, split the lock by shard, or move the work out of the critical section; then measure again under the same workload.",
  },
  CPU_HOTSPOT: {
    label: "CPU hotspot",
    what: "A measurable share of CPU time is spent in this code.",
    fix: "Profile the region, then cut algorithmic work (memoize, batch, skip redundant work) before micro-tuning; re-measure to confirm.",
  },
  ALLOCATION_HOTSPOT: {
    label: "Allocation hotspot",
    what: "Frequent allocation happens in a hot path, adding allocation and GC cost.",
    fix: "Reuse buffers or pre-size collections, and move construction out of loops; re-measure before and after.",
  },
  IO_BOTTLENECK: {
    label: "I/O bottleneck",
    what: "A measurable share of time is spent waiting on input/output in this path.",
    fix: "Batch or pipeline the I/O, cache repeated reads, or move the call off the hot path; re-measure against the same workload.",
  },
  QUEUE_SATURATION: {
    label: "Queue saturation",
    what: "A queue (or pool) can fill up, so later work waits, drops, or blocks its producer.",
    fix: "Add or raise bounded backpressure: capacity with load-shedding, or a bounded wait, and monitor the chosen policy.",
  },
  LOOP_OPTIMIZATION: {
    label: "Loop optimization",
    what: "Work inside a loop can be moved out or reduced without changing the program's meaning.",
    fix: "Hoist invariants, pre-compute, or replace the loop's repeated work; keep the old behaviour as a test to compare against.",
  },
  REPEATED_EXTERNAL_CALL: {
    label: "Repeated external call",
    what: "The same external call (file, network, database) is issued again inside a loop with the same arguments.",
    fix: "Hoist the call out of the loop, or capture its result once and reuse it. Watch for arguments that actually change per iteration.",
  },
  RESOURCE_LEAK: {
    label: "Resource leak",
    what: "A resource (handle, connection, file) can be acquired on this path without being released again.",
    fix: "Use try-with-resources / RAII / deferred close so the release runs even on the error paths, including exceptions.",
  },
};
export const KIND_LABEL = (kind: string): string => KIND_INFO[kind]?.label ?? kind.replaceAll("_", " ").toLowerCase();
export const RULE_HINT: Record<string, string> = {
  "defect.call-in-loop": "The rule scans loops for external calls whose arguments do not change between iterations. A repeated identical call is usually redundant; it is a candidate, not a proven fault.",
};
export const LEVEL_INFO: Record<string, string> = {
  STATIC_CANDIDATE: "static analysis flagged this without executing anything — it is a candidate, not a confirmed defect",
  DETECTOR_REPORT: "a tool run reported it, under that tool's own limits",
  REPRODUCED: "a controlled run reproduced it",
  MEASURED: "a measurement (profile/benchmark) supports it",
  BOUNDED_EXHAUSTIVE: "checked exhaustively, but only within declared bounds",
};
export const STATUS_INFO: Record<TriageStatus, string> = {
  NEW: "not yet looked at",
  REVIEWED: "checked by someone (in this browser)",
  DISMISSED: "marked not actionable by someone (in this browser)",
};
export const GLOSSARY: [string, string][] = [
  ["Evidence level", "how a finding was established; see the individual definitions"],
  ["Static candidate", LEVEL_INFO.STATIC_CANDIDATE],
  ["Detector report", LEVEL_INFO.DETECTOR_REPORT],
  ["Reproduced", LEVEL_INFO.REPRODUCED],
  ["Measured", LEVEL_INFO.MEASURED],
  ["Bounded exhaustive", LEVEL_INFO.BOUNDED_EXHAUSTIVE],
  ["Display categories", "findings carry an evidence category, never a probability that they are true"],
  ["Coverage gaps", "what the analysis could and could not examine — unknowns are listed, not hidden"],
  ["Correctness obligation", "a check that must hold for the evidence to mean what it says (PENDING = not yet evidenced)"],
  ["Fact location", "where the detector recorded the problem in the pinned revision"],
  ["Evidence location", "where the cited evidence was re-read from; the two can differ"],
];

export const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const sevRank = (s: Severity): number => SEVERITIES.indexOf(s);
export const sevClass = (s: Severity | TriageStatus): string => s.toLowerCase();

// ---------------------------------------------------------------- list helpers

export interface Row { type: "group" | "finding"; id: string; label: string; finding?: DetectorFinding; location?: ResolvedEvidence | null }
export interface ListOptions { search: string; severities: Set<Severity>; kindFilter: string; statusFilter: TriageStatus | "ALL"; groupByFile: boolean }

export const statusOf = (f: DetectorFinding, triage: Map<string, TriageStatus>): TriageStatus => triage.get(f.id) ?? "NEW";
export const locationOf = (f: DetectorFinding, evidence: Map<string, ResolvedEvidence>): ResolvedEvidence | null => f.evidenceIds.length ? evidence.get(f.evidenceIds[0]) ?? null : null;
/** The row's one readable identity: plain kind, severity and a unique file:line (UX-01/31). */
export const rowLabel = (f: DetectorFinding, loc: ResolvedEvidence | null): string => {
  const where = loc && loc.startLine > 0 ? `${loc.file.split("/").pop()}:${loc.startLine}` : loc?.file ?? "no source evidence";
  return `${KIND_LABEL(f.kind)}, ${f.severity} — ${where}`;
};
/** Findings the row location is unknown for sort after every located finding; they are the least identifiable. */
const fileKey = (f: DetectorFinding, evidence: Map<string, ResolvedEvidence>): string => locationOf(f, evidence)?.file ?? "\uffff";
/** Text search + severity + kind + status filters, then severity-desc, file, line order. */
export function filterFindings(findings: DetectorFinding[], evidence: Map<string, ResolvedEvidence>, triage: Map<string, TriageStatus>, o: ListOptions): DetectorFinding[] {
  const q = o.search.trim().toLowerCase();
  return findings.filter((f) => {
    const loc = locationOf(f, evidence);
    if (o.severities.size && !o.severities.has(f.severity)) return false;
    if (o.kindFilter && f.kind !== o.kindFilter) return false;
    if (o.statusFilter !== "ALL" && statusOf(f, triage) !== o.statusFilter) return false;
    if (q) {
      const hay = `${loc?.file ?? ""} ${KIND_LABEL(f.kind)} ${f.kind} ${f.ruleId} ${(loc?.snippet ?? "").split("\n")[0]}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
    || fileKey(a, evidence).localeCompare(fileKey(b, evidence))
    || (locationOf(a, evidence)?.startLine ?? 0) - (locationOf(b, evidence)?.startLine ?? 0));
}
/** Group ordered findings by file, keeping the filter order inside each group and across groups. */
export function groupByFile(ordered: DetectorFinding[], evidence: Map<string, ResolvedEvidence>): { file: string; findings: DetectorFinding[] }[] {
  const groups: { file: string; findings: DetectorFinding[] }[] = [];
  const byFile = new Map<string, { file: string; findings: DetectorFinding[] }>();
  for (const f of ordered) {
    const file = locationOf(f, evidence)?.file ?? "(no file)";
    let g = byFile.get(file);
    if (!g) { g = { file, findings: [] }; byFile.set(file, g); groups.push(g); }
    g.findings.push(f);
  }
  return groups;
}
/** Flatten grouped rows to a fixed-height row array for the windowed list. */
export function flatten(ordered: DetectorFinding[], evidence: Map<string, ResolvedEvidence>, o: ListOptions, expanded: Set<string>): Row[] {
  if (!o.groupByFile) {
    return ordered.map((f) => { const loc = locationOf(f, evidence); return { type: "finding" as const, id: f.id, label: rowLabel(f, loc), finding: f, location: loc }; });
  }
  const rows: Row[] = [];
  for (const g of groupByFile(ordered, evidence)) {
    rows.push({ type: "group", id: `grp:${g.file}`, label: g.file });
    if (expanded.has(g.file)) for (const f of g.findings) { const loc = locationOf(f, evidence); rows.push({ type: "finding", id: f.id, label: rowLabel(f, loc), finding: f, location: loc }); }
  }
  return rows;
}
/** Which slice of fixed-height rows fits the viewport at a scroll offset (UX-17). */
export function windowOf(total: number, offset: number, viewport: number, rowH: number, overscan = 8): [number, number] {
  const start = Math.max(0, Math.floor(offset / rowH) - overscan);
  const end = Math.min(total, Math.ceil((offset + viewport) / rowH) + overscan);
  return [start, end];
}
/** Truncate a long path in the middle so file and line stay readable (UX-26). */
export const truncateMiddle = (s: string, max = 42): string => s.length <= max ? s : `${s.slice(0, Math.floor((max - 1) / 2))}…${s.slice(s.length - Math.floor((max - 1) / 2))}`;
export const severityCounts = (fs: DetectorFinding[]): Map<Severity, number> => {
  const counts = new Map<Severity, number>(SEVERITIES.map((s) => [s, 0] as [Severity, number]));
  for (const f of fs) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  return counts;
};
export const relative = (iso: string): string => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
/** Exact pixel offset of a flattened row index (group headers are 30px, findings 40px). */
export const ROW = 40, GROUP_H = 30;
export const offsetOf = (rows: Row[], index: number): number => {
  let top = 0;
  for (let i = 0; i < index && i < rows.length; i++) top += rows[i].type === "group" ? GROUP_H : ROW;
  return top;
};/** Variable-height windowing: cumulative byte offsets for items of differing height (rule headers, bodies, rows). */
export interface VRow { h: number }
export const cumulative = (rs: VRow[]): number[] => {
  const o = [0];
  for (const r of rs) o.push(o[o.length - 1] + r.h);
  return o;
};
/** The [start, end) index range of items covering a viewport from `top`, with `overscan` items of slack on each side. */
export function windowByOffsets(offs: number[], top: number, viewH: number, overscan = 4): [number, number] {
  if (offs.length <= 1) return [0, 0];
  let a = 0;
  while (a < offs.length - 2 && offs[a + 1] <= top) a++;
  let b = a;
  while (b < offs.length - 1 && offs[b] < top + viewH) b++;
  return [Math.max(0, a - overscan), Math.min(offs.length - 1, b + overscan)];
};
/** One English count: "1 piece of evidence", "3 pieces of evidence". */
export const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
