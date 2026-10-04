// Performance and contention candidates from source (design §8), and the ranking that ties them to a measured workload.
// A candidate is a static observation: a call inside a loop, a lock around I/O. It becomes a MEASURED finding only when
// timing from a named workload, build and revision lands on it; until then it says so, and a measurement that is missing is
// never evidence that something is fast.
import { createHash } from "node:crypto";
import type { DetectorFinding, SafetyObligation, SourceSpan } from "@cie/schema";
import { assessLoopTransformation } from "../defect-semantics.ts";
import { computeExclusiveCosts, type TimedSpan } from "../defect-performance.ts";
import type { RevisionRow, Store } from "../store.ts";
import { fileLine, loadFunctions, spanEvidence, spanOf, type Fn } from "./functions.ts";
import { LIMITS, type Call } from "./source.ts";

const h = (...p: unknown[]) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);

/** Is this call plausibly I/O: a database, a network client, a queue, a cache? A judgement from names, and said to be one. */
const IO_RECEIVER = /(^|\.)(db|database|pool|conn|connection|client|http|https|axios|redis|cache|queue|bus|repo|repository|api|gateway|sql|orm|store|session|tx)$/i;
const IO_METHOD = /^(query|execute|fetch|request|publish|send|post|insert|update|delete|findOne|findAll|findMany|select|save|commit|rollback|call)$/;
export const looksLikeIo = (c: Pick<Call, "receiver" | "method" | "name">) => (!!c.receiver && IO_RECEIVER.test(c.receiver)) || IO_METHOD.test(c.method ?? c.name) || (!c.receiver && /^(fetch|query)$/.test(c.name));
const MUTATING = /^(push|pop|shift|unshift|splice|sort|reverse|set|add|delete|remove|clear|append|insert|fill|copyWithin)$/;
const PURE_BUILTIN = /^(Math\.(?:sqrt|abs|floor|ceil|round|min|max|pow|log|exp)|Number|String|Boolean|parseInt|parseFloat)$/;

function ob(kind: string, descriptions: string[]): SafetyObligation[] {
  return descriptions.map((d) => ({ id: "obl:" + h(kind, d), description: d, predicateSchemaId: `defect.obligation.${kind}.v1`, state: "PENDING" as const, evidenceIds: [] }));
}

export function detectPerformance(store: Store, rev: RevisionRow, opts: { entityIds?: string[] } = {}): DetectorFinding[] {
  const fns = loadFunctions(store, rev); const out: DetectorFinding[] = [];
  const keep = (id: string) => !opts.entityIds?.length || opts.entityIds.includes(id);
  const span = (f: Fn, at: number, len: number): SourceSpan => { const s = spanOf(f, at, len); return { sourceId: f.file, contentHash: f.fileHash, revision: rev.id, startByte: s.startByte, endByteExclusive: s.endByte }; };
  const finding = (f: Fn, kind: DetectorFinding["kind"], rule: string, severity: DetectorFinding["severity"], at: number, len: number, detail: string, gaps: string[], obligations: SafetyObligation[], extra: object = {}): DetectorFinding => {
    const ev = spanEvidence(store, rev, f, at, len);
    return { id: "finding:" + h(rule, rev.id, f.entity.entityId, at), version: 1, kind, revision: rev.id, entityIds: [f.entity.entityId], spans: [span(f, at, len)], ruleId: rule, ruleVersion: 1, evidenceIds: [ev.id], coverageGaps: gaps, severity, evidenceLevel: "STATIC_CANDIDATE", safetyObligations: obligations, witness: { kind: rule, paths: [[f.entity.entityId, String(fileLine(store, rev, f, at))]], detail: `${detail} ${JSON.stringify(extra)}`.trim() } };
  };
  for (const f of fns.values()) {
    if (!keep(f.entity.entityId)) continue;
    const s = f.scan;
    // Loop variable names, so a call that uses one is "one call per element".
    const loopVars = new Map<number, string[]>();
    for (const l of s.loops) {
      const m = /(?:const|let|var)\s+(?:\[([^\]]+)\]|(\w+))\s+(?:of|in)\b/.exec(l.header);
      const names = m ? (m[1] ?? m[2]).split(",").map((x) => x.trim()) : [];
      if (l.kind === "iter") { const cb = /\(?\s*(\w+)/.exec(f.src.slice(l.bodyStart, l.bodyEnd).replace(/^\s*async\s*/, "")); if (cb) names.push(cb[1]); }
      loopVars.set(l.id, names.filter(Boolean));
    }
    for (const c of s.calls) {
      // N+1: an awaited I/O call inside a loop that uses the loop's own variable.
      if (c.awaited && c.loops.length && looksLikeIo(c) && c.loops.some((id) => (loopVars.get(id) ?? []).some((v) => new RegExp(`\\b${v}\\b`).test(c.args)))) {
        const loop = s.loops.find((l) => c.loops.includes(l.id))!;
        out.push(finding(f, "REPEATED_EXTERNAL_CALL", "defect.n-plus-one", "MEDIUM", c.at, Math.min(80, c.text.length), `Repeated call candidate: ${c.receiver ? c.receiver + "." : ""}${c.name} is awaited once per element of ${loop.iterable ?? "a loop"}.`,
          ["Loop cardinality and the cost of the call are not known; no workload has measured this.", "Whether the call touches a database or the network is judged from its name.", ...LIMITS.slice(2, 3)],
          ob("n-plus-one", ["Return the same rows in the same order for the same input.", "Preserve error behaviour: which element fails, and what has already happened.", "Bound memory if the calls are batched or run together."]), { loop: loop.header, line: c.line }));
      }
      // I/O while a lock is held; and the worse shape, a lock held across a whole loop of I/O calls (what coarsening a per-iteration lock produces).
      if (c.awaited && c.held.length && looksLikeIo(c)) {
        const acrossLoop = c.loops.some((id) => s.acquisitions.some((a) => c.held.includes(a.lock) && a.at < s.loops[id].at));
        out.push(finding(f, "CONTENTION", acrossLoop ? "defect.lock-held-across-io-loop" : "defect.io-in-critical-section", acrossLoop ? "MEDIUM" : "MEDIUM", c.at, Math.min(80, c.text.length), `${acrossLoop ? "A lock is held across a loop of I/O calls" : "I/O inside a critical section"}: ${c.receiver ? c.receiver + "." : ""}${c.name} is awaited while ${c.held.join(", ")} is held.`,
          ["Hold time is not measured; the call may be fast.", ...LIMITS.slice(0, 1)],
          ob("io-in-lock", ["Anything the lock protected is still consistent if the I/O moves outside it.", "Stale inputs are rechecked or the decision is rechecked after the I/O.", "No new window opens between the check and the effect."]), { held: c.held }));
      }
    }
    // A lock taken on every iteration.
    for (const a of s.acquisitions) {
      const loop = s.loops.find((l) => a.at >= l.bodyStart && a.at < l.bodyEnd);
      if (loop && a.kind !== "try") out.push(finding(f, "CONTENTION", "defect.lock-per-iteration", "LOW", a.at, 56, `${a.lock} is taken on every pass of a loop (${loop.header || loop.kind}).`,
        ["Whether the iterations really need separate critical sections depends on the invariant the lock protects.", ...LIMITS.slice(2, 3)],
        ob("lock-per-iteration", ["Coarsening the lock does not hold it across I/O or long work.", "Fairness and contention for other users of the lock do not get worse.", "The protected invariant holds between iterations as before."]), { lock: a.lock }));
    }
    // A loop condition re-evaluated every pass, assessed by the same gates as any move out of the loop.
    for (const l of s.loops.filter((x) => x.kind === "for" || x.kind === "while")) {
      const cond = l.kind === "for" ? (l.header.split(";")[1] ?? "") : l.header;
      const reads = [...cond.matchAll(/([A-Za-z_$][\w$.]*)\s*(\()?/g)].filter((m) => m[1].includes(".") || m[2] || /\.length$/.test(m[1]));
      if (!reads.length) continue;
      const body = f.src.slice(l.bodyStart, l.bodyEnd);
      const written = new Set<string>([...body.matchAll(/([A-Za-z_$][\w$.]*)\s*(?:[+\-*/%]?=(?!=)|\+\+|--)/g)].map((m) => m[1].split(".")[0]));
      for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) if (MUTATING.test(m[2])) written.add(m[1]);
      const paramTypes = new Map<string, string>(); const sig = /\(([^)]*)\)/.exec(f.src)?.[1] ?? "";
      for (const p of sig.split(",")) { const [n, t] = p.split(":").map((x) => x.trim()); if (n && t) paramTypes.set(n.replace(/[?=].*$/, ""), t); }
      const roots = reads.map((r) => r[1].split(".")[0]);
      const pureFns = reads.filter((r) => r[2]).every((r) => PURE_BUILTIN.test(r[1]));
      const facts = {
        reads: reads.filter((r) => !PURE_BUILTIN.test(r[1])).map((r) => ({ path: r[1].replace(/\.length$/, ""), getter: !!r[2] || /\.length$/.test(r[1]), volatile: false, concurrentMutation: false, aliasResolved: false })),
        writes: [...written], effects: { reads: [], writes: [], mayBlock: false, mayThrow: false, io: false, purity: (pureFns ? "PURE" : "UNKNOWN") as "PURE" | "UNKNOWN", unresolvedCallees: pureFns ? [] : reads.filter((r) => r[2] && !PURE_BUILTIN.test(r[1])).map((r) => r[1]) },
        mayBeEmpty: true, evaluationMovesBeforeLoop: true, benchmarkAvailable: false,
      };
      const g = assessLoopTransformation(facts);
      // A number passed by value cannot be aliased or changed behind the loop's back.
      const onlyPlainNumbers = roots.every((r) => paramTypes.get(r) === "number" || PURE_BUILTIN.test(r) || r === "Math");
      const safe = g.safeCandidate || (onlyPlainNumbers && pureFns && !roots.some((r) => written.has(r)));
      out.push(finding(f, "LOOP_OPTIMIZATION", "defect.loop-condition-reevaluated", "LOW", l.at, Math.min(80, l.header.length + 10), `The condition of a loop calls ${[...new Set(reads.map((r) => r[1]))].join(", ")} on every pass.${safe ? " It looks invariant and pure." : ""}`,
        safe ? ["The compiler or runtime may already hoist this; the benefit has not been measured."] : [...new Set(g.reasons), "Not proposed for change: the safety gates do not pass."],
        ob("loop-invariant", [...g.obligations, "Re-evaluation semantics, exception timing and empty-loop behaviour are unchanged."]), { safeCandidate: safe, reasons: safe ? [] : g.reasons, loop: l.header }));
    }
    // Independent awaits in a row.
    const aw = s.calls.filter((c) => c.awaited && c.binding && looksLikeIo(c) && !c.loops.length && !c.held.length);
    for (let i = 1; i < aw.length; i++) {
      const prev = aw[i - 1], cur = aw[i];
      if (!new RegExp(`\\b${prev.binding}\\b`).test(cur.args + (cur.receiver ?? "")) && cur.at > prev.at && !s.acquisitions.some((a) => a.at > prev.at && a.at < cur.at))
        out.push(finding(f, "IO_BOTTLENECK", "defect.serial-independent-awaits", "LOW", cur.at, Math.min(80, cur.text.length), `${cur.name} waits for ${prev.name} although it does not use its result.`,
          ["Independence is judged from names in the arguments; hidden ordering or shared state between the two calls is not visible.", "Downstream capacity for overlapping calls is unknown."],
          ob("serial-awaits", ["Side effects and ordering that callers rely on are preserved.", "Parallelism is bounded and cancellation still works.", "Errors from either call are still reported."]), { first: prev.name, second: cur.name }));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ----------------------------------------------------------------------------------------------- workload-bound ranking
export interface Profile { revision: string; buildHash: string; workloadHash: string; spans: TimedSpan[] }
export interface Ranked { finding: DetectorFinding; measuredExclusiveMs: number | null; shareOfWorkload: number | null; evidenceLevel: DetectorFinding["evidenceLevel"]; why: string; workloadHash: string | null }

/**
 * Order findings by what a named workload spent in them, not by how alarming they look. Self time is used (children subtracted),
 * so a function that only waits on a slow callee is not blamed for it. A finding with no measurement keeps its static level and
 * goes after every measured one, with a note that no measurement is not evidence of speed. A profile from another revision is not used.
 */
export function rankByWorkload(findings: DetectorFinding[], profile: Profile | null): Ranked[] {
  const total = (c: { spans: { exclusiveMs: number }[] }) => c.spans.reduce((a, s) => a + s.exclusiveMs, 0);
  const usable = profile && profile.spans.length ? profile : null;
  const costs = usable ? computeExclusiveCosts(usable.spans) : null;
  // A function owns its own self time and what its unattributed children (a database driver, a pool wait) spent on its behalf.
  const byEntity = new Map<string, number>();
  if (usable && costs) {
    const spanById = new Map(usable.spans.map((x) => [x.id, x]));
    for (const c of costs.spans) {
      let sp = spanById.get(c.id)!;
      const own = sp.entityId;
      let owner = own ? sp : undefined;
      for (let cur = sp; !owner && cur.parentId; ) { const p = spanById.get(cur.parentId); if (!p) break; if (p.entityId) owner = p; cur = p; }
      if (owner?.entityId) byEntity.set(owner.entityId, (byEntity.get(owner.entityId) ?? 0) + c.exclusiveMs);
      void sp;
    }
  }
  const sum = costs ? total(costs) : 0;
  const rows: Ranked[] = findings.map((f) => {
    if (!usable) return { finding: f, measuredExclusiveMs: null, shareOfWorkload: null, evidenceLevel: f.evidenceLevel, why: "No workload was measured; this is a static candidate.", workloadHash: null };
    if (usable.revision !== f.revision) return { finding: f, measuredExclusiveMs: null, shareOfWorkload: null, evidenceLevel: f.evidenceLevel, why: "The profile is for another revision, so it says nothing about this code.", workloadHash: null };
    const ms = f.entityIds.reduce((a, id) => a + (byEntity.get(id) ?? 0), 0), seen = f.entityIds.some((id) => byEntity.has(id));
    if (!seen) return { finding: f, measuredExclusiveMs: null, shareOfWorkload: null, evidenceLevel: f.evidenceLevel, why: "The workload recorded no time in this code. That is not evidence it is fast: it may not have run, or its spans may be missing or sampled away.", workloadHash: usable.workloadHash };
    return { finding: { ...f, evidenceLevel: "MEASURED" }, measuredExclusiveMs: ms, shareOfWorkload: sum ? ms / sum : null, evidenceLevel: "MEASURED", why: `${ms.toFixed(1)} ms of self time in workload ${usable.workloadHash.slice(0, 8)} (${sum ? ((ms / sum) * 100).toFixed(0) : "?"}% of what it recorded).`, workloadHash: usable.workloadHash };
  });
  return rows.sort((a, b) => (b.measuredExclusiveMs ?? -1) - (a.measuredExclusiveMs ?? -1) || (a.measuredExclusiveMs === null && b.measuredExclusiveMs === null ? ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(b.finding.severity) - ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(a.finding.severity) : 0) || a.finding.id.localeCompare(b.finding.id));
}
