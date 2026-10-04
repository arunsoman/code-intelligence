// Deadlock candidates by lock order (design §6). Build a graph with an edge A→B whenever B may be taken while A is held,
// find the cycles, then ask whether the cycle could really happen: is it serialized by a lock that surrounds it, does one of
// its waits give up (try-lock, timeout), is the lock reentrant. A cycle is a candidate for a deadlock, never a finding that one occurs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store, RevisionRow } from "../store.ts";
import { sccs } from "../graph.ts";
import { fileLine, loadFunctions, spanEvidence, spanOf, type Fn, type FindingSpan } from "./functions.ts";
import { LIMITS, type Acquisition, type LockKind } from "./source.ts";
import type { DetectorFinding, SafetyObligation, SourceSpan } from "@cie/schema";

const h = (...p: unknown[]) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);
export const RULE = { id: "defect.lock-order-cycle", version: 2 };

interface Witness { from: string; to: string; fn: string; site: "acquire" | "call"; kind: LockKind; at: number; held: string[]; via?: string; aliasUncertain: boolean }

/** Which locks are known to be reentrant, from their declarations (`new ReentrantLock()`, RLock, Rust ReentrantMutex). */
export function reentrantLocks(rev: RevisionRow): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, depth = 0) => {
    if (depth > 6) return;
    let names: string[]; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === "node_modules" || n === "target" || n.startsWith(".")) continue;
      const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(ts|tsx|js|rs|java|py)$/.test(n) && st.size < 400_000) {
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(/(?:const|let|var|static|readonly)\s+(\w+)\s*(?::[^=]+)?=\s*(?:new\s+)?(\w*(?:Reentrant|Recursive|RLock)\w*)/gi)) out.add(m[1]);
        for (const m of text.matchAll(/(\w+)\s*:\s*[\w:]*ReentrantMutex/g)) out.add(m[1]);
        // Java: `ReentrantLock lock = new ReentrantLock()`; Python: `lock = threading.RLock()`. Go's sync.Mutex is not reentrant, so nothing is added for it.
        for (const m of text.matchAll(/\bReentrant\w*\s+(\w+)\s*(?:=|;)/g)) out.add(m[1]);
        for (const m of text.matchAll(/\b(\w+)\s*=\s*(?:threading\.)?RLock\s*\(/g)) out.add(m[1]);
      }
    }
  };
  walk(resolve(rev.repoRoot));
  return out;
}

export function detectLockOrder(store: Store, rev: RevisionRow, opts: { entityIds?: string[] } = {}): DetectorFinding[] {
  const fns = loadFunctions(store, rev);
  const byName = new Map<string, string[]>();
  for (const f of fns.values()) byName.set(f.entity.name.replace(/^.*\./, ""), [...(byName.get(f.entity.name.replace(/^.*\./, "")) ?? []), f.entity.entityId]);
  const reentrant = reentrantLocks(rev);

  // Calls we can resolve: the call graph the indexer already built, matched to the call sites the scanner found.
  const targets = (id: string) => store.relationshipsFor(rev.id, id).filter((r) => r.kind === "calls" && r.from === id).map((r) => r.to);
  const resolveCall = (f: Fn, name: string): string | null => {
    const ts = targets(f.entity.entityId).filter((t) => fns.get(t)?.entity.name.replace(/^.*\./, "") === name);
    if (ts.length === 1) return ts[0];
    const g = byName.get(name); return !ts.length && g?.length === 1 && g[0] !== f.entity.entityId ? g[0] : null;
  };

  // Locks each function may take, including through what it calls (fixpoint, so recursion terminates).
  const direct = new Map<string, Map<string, LockKind>>();
  for (const f of fns.values()) { const m = new Map<string, LockKind>(); for (const a of f.scan.acquisitions) if (!m.has(a.lock) || m.get(a.lock) === "try") m.set(a.lock, a.kind); direct.set(f.entity.entityId, m); }
  const takes = new Map<string, Map<string, LockKind>>([...direct].map(([k, v]) => [k, new Map(v)]));
  for (let changed = true, n = 0; changed && n < 50; n++) {
    changed = false;
    for (const f of fns.values()) for (const c of f.scan.calls) {
      const g = resolveCall(f, c.name); if (!g) continue;
      const mine = takes.get(f.entity.entityId)!;
      for (const [lock, kind] of takes.get(g) ?? []) if (!mine.has(lock)) { mine.set(lock, kind); changed = true; }
    }
  }

  const edges: Witness[] = []; const selfNest: { fn: string; lock: string; at: number; via?: string; kind: LockKind }[] = [];
  let unresolvedCallsWhileHolding = 0;
  for (const f of fns.values()) {
    for (const a of f.scan.acquisitions) {
      if (a.kind === "try") continue; // a try-lock never waits, so nothing waits on it
      for (const held of a.heldBefore) {
        if (held === a.lock) { selfNest.push({ fn: f.entity.entityId, lock: a.lock, at: a.at, kind: a.kind }); continue; }
        edges.push({ from: held, to: a.lock, fn: f.entity.entityId, site: "acquire", kind: a.kind, at: a.at, held: a.heldBefore, aliasUncertain: a.aliasUncertain });
      }
    }
    for (const c of f.scan.calls) {
      if (!c.held.length) continue;
      const g = resolveCall(f, c.name);
      if (!g) { if (/^[a-z]/.test(c.name) && !["push", "pop", "get", "set", "log", "has", "add", "release", "map", "filter", "join", "slice"].includes(c.name)) unresolvedCallsWhileHolding++; continue; }
      for (const [lock, kind] of takes.get(g) ?? []) {
        if (kind === "try") continue;
        for (const held of c.held) {
          if (held === lock) { selfNest.push({ fn: f.entity.entityId, lock, at: c.at, via: g, kind }); continue; }
          edges.push({ from: held, to: lock, fn: f.entity.entityId, site: "call", kind, at: c.at, held: c.held, via: g, aliasUncertain: false });
        }
      }
    }
  }

  const findings: DetectorFinding[] = [];
  const keep = (id: string) => !opts.entityIds?.length || opts.entityIds.includes(id);

  // Cycles: strongly connected components of the lock graph, then a shortest witness cycle through each.
  const locks = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  for (const comp of sccs(locks, edges.map((e) => [e.from, e.to] as [string, string]))) {
    const inComp = new Set(comp);
    const es = edges.filter((e) => inComp.has(e.from) && inComp.has(e.to));
    const cycle = shortestCycle(comp[0], es);
    if (!cycle || !cycle.some((e) => keep(e.fn))) continue;
    findings.push(cycleFinding(store, rev, fns, comp, cycle, es, reentrant, unresolvedCallsWhileHolding));
  }

  // A non-reentrant lock taken again, directly or through a callee, while already held, waits on itself.
  const seenSelf = new Set<string>();
  for (const s of selfNest) {
    if (reentrant.has(s.lock)) continue;
    const key = `${s.fn}|${s.lock}|${s.via ?? ""}`; if (seenSelf.has(key) || !keep(s.fn)) continue; seenSelf.add(key);
    const f = fns.get(s.fn)!; const ev = spanEvidence(store, rev, f, s.at, 24);
    const span: FindingSpan = { ...spanOf(f, s.at, 60), line: fileLine(store, rev, f, s.at) };
    const nonBlocking = s.kind === "timeout";
    findings.push({
      id: "finding:" + h(RULE.id, rev.id, key), version: 1, kind: "DEADLOCK_CANDIDATE", revision: rev.id, entityIds: [s.fn, ...(s.via ? [s.via] : [])], spans: [toSpan(span, f, rev)], ruleId: RULE.id, ruleVersion: RULE.version, evidenceIds: [ev.id],
      coverageGaps: [...LIMITS.slice(0, 1), "whether this lock is reentrant was decided from its declaration; an undeclared lock is assumed not to be"], severity: nonBlocking ? "LOW" : "HIGH", evidenceLevel: "STATIC_CANDIDATE",
      safetyObligations: obligations("lock-self"),
      witness: { kind: "SELF_DEADLOCK", paths: [[s.fn, s.lock, s.lock]], detail: `Potential self-deadlock: ${f.entity.name} takes ${s.lock} again${s.via ? ` through ${fns.get(s.via)?.entity.name}` : ""} while already holding it, and ${s.lock} is not declared reentrant.${nonBlocking ? " The second acquisition has a timeout." : ""}` },
    });
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}

function toSpan(sp: FindingSpan, f: Fn, rev: RevisionRow): SourceSpan { return { sourceId: sp.file, contentHash: f.fileHash, revision: rev.id, startByte: sp.startByte, endByteExclusive: sp.endByte }; }

function obligations(kind: string): SafetyObligation[] {
  const o = (d: string): SafetyObligation => ({ id: "obl:" + h(kind, d), description: d, predicateSchemaId: `defect.obligation.${kind}.v1`, state: "PENDING", evidenceIds: [] });
  return kind === "lock-order"
    ? [o("every path that takes both locks takes them in one global order"), o("the protected state is still consistent after the change"), o("no new nested acquisition is introduced")]
    : [o("the second acquisition no longer happens while the lock is held"), o("the protected state is still consistent after the change")];
}

function shortestCycle(start: string, es: Witness[]): Witness[] | null {
  const out = new Map<string, Witness[]>(); for (const e of es) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  for (const l of out.values()) l.sort((a, b) => a.to.localeCompare(b.to) || a.fn.localeCompare(b.fn) || a.at - b.at);
  const prev = new Map<string, Witness>(); const q = [start]; const seen = new Set([start]);
  while (q.length) {
    const cur = q.shift()!;
    for (const e of out.get(cur) ?? []) {
      if (e.to === start) { const path = [e]; for (let c = cur; c !== start; ) { const p = prev.get(c)!; path.unshift(p); c = p.from; } return path; }
      if (!seen.has(e.to)) { seen.add(e.to); prev.set(e.to, e); q.push(e.to); }
    }
  }
  return null;
}

/** Could this cycle really happen? A lock that every acquiring path holds serializes it; a timeout lets a wait end; neither is proof either way. */
export function cycleFeasibility(cycle: Witness[], all: Witness[]): { feasible: boolean; reasons: string[]; recovers: boolean } {
  const reasons: string[] = []; const cyc = new Set(cycle.flatMap((e) => [e.from, e.to]));
  // For each edge there may be several functions that realize it; the cycle is feasible if some choice of one witness per edge is not serialized.
  const options = cycle.map((e) => all.filter((w) => w.from === e.from && w.to === e.to));
  const common = (choice: Witness[]) => { const sets = choice.map((w) => new Set(w.held.filter((l) => !cyc.has(l)))); return [...(sets[0] ?? [])].filter((l) => sets.every((s) => s.has(l))); };
  let anyFeasible = false, gate: string[] = [];
  const walk = (i: number, choice: Witness[]) => { if (anyFeasible) return; if (i === options.length) { const g = common(choice); if (!g.length) anyFeasible = true; else gate = g; return; } for (const w of options[i]) walk(i + 1, [...choice, w]); };
  walk(0, []);
  if (!anyFeasible && gate.length) reasons.push(`every path that takes these locks first takes ${gate.join(", ")}, so they cannot overlap`);
  const recovers = cycle.some((e) => e.kind === "timeout");
  if (recovers) reasons.push("one of the waits gives up after a timeout, so the wait cannot be permanent");
  return { feasible: anyFeasible, reasons, recovers };
}

function cycleFinding(store: Store, rev: RevisionRow, fns: Map<string, Fn>, comp: string[], cycle: Witness[], all: Witness[], reentrant: Set<string>, unresolved: number): DetectorFinding {
  const feas = cycleFeasibility(cycle, all);
  const fnIds = [...new Set(cycle.map((e) => e.fn).concat(cycle.flatMap((e) => (e.via ? [e.via] : []))))];
  const spans: FindingSpan[] = [], evidenceIds: string[] = [];
  for (const e of cycle) {
    const f = fns.get(e.fn)!; const len = e.site === "call" ? 40 : 56;
    spans.push({ ...spanOf(f, e.at, len), line: fileLine(store, rev, f, e.at) });
    evidenceIds.push(spanEvidence(store, rev, f, e.at, len).id);
  }
  const aliasGap = cycle.some((e) => e.aliasUncertain) ? ["a lock in this cycle is named by a parameter or computed expression, so which lock it is depends on the caller"] : [];
  const gaps = [...LIMITS.slice(1, 4), ...aliasGap, ...(unresolved ? [`${unresolved} call(s) made while holding a lock could not be resolved, so other locks may be taken that are not shown`] : []), ...feas.reasons.map((r) => `not realizable as written: ${r}`).filter(() => !feas.feasible)];
  const names = cycle.map((e) => `${e.to} is taken while ${e.from} is held (in ${fns.get(e.fn)!.entity.name}${e.via ? `, through ${fns.get(e.via)?.entity.name}` : ""})`);
  const severity = !feas.feasible || feas.recovers ? "LOW" : new Set(cycle.map((e) => e.fn)).size >= 2 ? "HIGH" : "MEDIUM";
  const statement = `Potential lock-order inversion between ${comp.join(" and ")}: ${names.join("; ")}.${feas.feasible ? "" : ` It is probably not realizable: ${feas.reasons[0]}.`}${feas.recovers ? " One of the waits has a timeout." : ""} This is a static candidate, not an observed deadlock.`;
  return {
    id: "finding:" + h(RULE.id, rev.id, [...comp].sort()), version: 1, kind: "DEADLOCK_CANDIDATE", revision: rev.id, entityIds: fnIds, spans: spans.map((sp, i) => toSpan(sp, fns.get(cycle[i].fn)!, rev)), ruleId: RULE.id, ruleVersion: RULE.version, evidenceIds,
    coverageGaps: gaps, severity, evidenceLevel: "STATIC_CANDIDATE", safetyObligations: obligations("lock-order"),
    witness: { kind: "LOCK_ORDER_CYCLE", paths: cycle.map((e) => [e.fn, e.from, e.to]), detail: statement },
  };
}
