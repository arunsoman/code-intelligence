// Phase 2: motif extraction. One extractor per generic, domain-agnostic pattern in MOTIF_PATTERNS; nothing
// here knows any business domain. Extractors read only the PDG's plain data, so a reused PDG yields the
// same motifs, and `extractAllMotifs` memoizes whole-PDG results by the PDG's structural signature.
import { createHash } from "node:crypto";
import { CONCEPT_CONFIG, MOTIF_PATTERNS } from "./config.ts";
import type { Motif, MotifIndex, Pdg, PdgIndex, PdgNode } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const lastSegment = (callText: string): string => {
  const base = callText.replace(/\(.*$/, "").trim();
  const parts = base.split(".");
  return parts[parts.length - 1] || base;
};

const callsOf = (pdg: Pdg, n: PdgNode): string[] => n.calls;

function motifOf(pdg: Pdg, pattern: (typeof MOTIF_PATTERNS)[number], nodes: number[], edges: { from: number; to: number; kind: string }[], bindings: Record<string, string>, ops: Record<string, string>, extra?: { unmatchedRelease?: boolean }): Motif | null {
  if (!nodes.length || nodes.length > CONCEPT_CONFIG.motif.maxMotifSize) return null;
  const uniqueNodes = [...new Set(nodes)].sort((a, b) => a - b);
  const reads = [...new Set(uniqueNodes.flatMap((id) => pdg.nodes[id]?.reads ?? []))];
  const writes = [...new Set(uniqueNodes.flatMap((id) => pdg.nodes[id]?.writes ?? []))];
  const m: Motif = {
    id: motifId(pattern, pdg.entityId, uniqueNodes, bindings),
    pattern,
    entityId: pdg.entityId,
    file: pdg.file,
    nodes: uniqueNodes,
    edges,
    bindings,
    ops,
    reads,
    writes,
    rawSignature: "",
    ...(extra?.unmatchedRelease !== undefined ? { unmatchedRelease: extra.unmatchedRelease } : {}),
  };
  m.rawSignature = motifRawSignature(m);
  return m;
}

/** Deterministic motif identity: pattern + entity + participating sites + named participants. */
const motifId = (pattern: string, entityId: string, nodes: number[], bindings: Record<string, string>): string =>
  `motif:${sha(`${pattern}|${entityId}|${nodes.join(",")}|${Object.entries(bindings).map(([k, v]) => `${k}=${v}`).sort().join(",")}`).slice(0, 16)}`;

/** Pattern + shape hash before canonicalization; the memo key across revisions. */
export function motifRawSignature(motif: Motif): string {
  const parts = [
    motif.pattern,
    motif.nodes.map((n) => motifEntityType(motif, n)).join(","),
    motif.edges.map((e) => `${e.kind}:${e.from}-${e.to}`).sort().join(","),
    Object.entries(motif.bindings).map(([k, v]) => `${k}=${v}`).sort().join(","),
    Object.entries(motif.ops).map(([k, v]) => `${k}=${v}`).sort().join(","),
    [...motif.reads].sort().join(","),
    [...motif.writes].sort().join(","),
    motif.unmatchedRelease ? "unmatched" : "matched",
  ];
  return sha(parts.join("|")).slice(0, 24);
}

const motifEntityType = (motif: Motif, nodeId: number): string => `${nodeId}`;

// ---------------------------------------------------------------- reachability (node-level, control flow)

/** Nodes reachable from `start` following control flow, optionally blocking blocks that contain any of `avoid` nodes. */
function reachableNodes(pdg: Pdg, start: number, avoid: number[] = []): Set<number> {
  const avoidBlocks = new Set(avoid.map((n) => pdg.nodes[n]?.block));
  const seen = new Set<number>();
  const work: number[] = [];
  const startBlock = pdg.nodes[start]?.block;
  if (startBlock === undefined) return seen;
  // Nodes later in the same block.
  const blockNodes = pdg.blocks[startBlock]?.nodes ?? [];
  const idx = blockNodes.indexOf(start);
  for (const nid of blockNodes.slice(idx + 1)) if (!avoidBlocks.has(pdg.nodes[nid].block)) { seen.add(nid); work.push(nid); }
  // Block-level BFS from the successors of the start block.
  const blockWork = [...(pdg.blocks[startBlock]?.succs ?? [])];
  const seenBlocks = new Set<number>(blockWork);
  while (blockWork.length) {
    const b = blockWork.pop()!;
    if (avoidBlocks.has(b)) continue;
    for (const nid of pdg.blocks[b]?.nodes ?? []) { seen.add(nid); work.push(nid); }
    for (const s of pdg.blocks[b]?.succs ?? []) if (!seenBlocks.has(s)) { seenBlocks.add(s); blockWork.push(s); }
  }
  return seen;
}

/** True when some control-flow path from `start` reaches the exit block without passing any node in `gateways` —
 *  the leak-shape test for acquired-but-never-released resources. */
function gatewayAvoidingPathToExitExists(pdg: Pdg, start: number, gateways: number[]): boolean {
  if (!gateways.length) return true;
  const gatewayBlocks = new Set(gateways.map((n) => pdg.nodes[n]?.block));
  const exit = pdg.exitBlock;
  const seen = new Set<number>();
  const work = [pdg.nodes[start]?.block];
  while (work.length) {
    const b = work.pop()!;
    if (b === undefined || seen.has(b)) continue;
    if (b === exit) return true; // a path that avoided every gateway reaches the exit
    if (gatewayBlocks.has(b)) continue;
    seen.add(b);
    for (const s of pdg.blocks[b]?.succs ?? []) work.push(s);
  }
  return false;
}

// ---------------------------------------------------------------- extractors

/** A write to a variable that happens only under a condition. The op slot carries the update kind
 *  ("assign"/"add"/"sub"/"mul"/"div") — composition rules specialize on it later. */
export function extractGuardedWriteMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  for (const ge of pdg.guardEdges) {
    const n = pdg.nodes[ge.node];
    const g = pdg.nodes[ge.guard];
    if (!n || !g || !n.writes.length) continue;
    if (n.kind === "cond") continue; // loop conditions that self-update (i++) are accumulators, not guarded writes
    for (const w of n.writes) {
      const m = motifOf(pdg, "guarded-write", [ge.node, ge.guard], [{ from: ge.guard, to: ge.node, kind: ge.kind }], { target: w, guard: g.text }, { op: n.writeOps[w] ?? "assign", branch: ge.kind });
      if (m) out.push(m);
    }
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** A variable updated in place (add/sub) inside a loop that also reads it: the accumulator shape. */
export function extractLoopAccumulateMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  for (const loop of pdg.loops) {
    for (const b of loop.blocks) {
      for (const nid of pdg.blocks[b]?.nodes ?? []) {
        const n = pdg.nodes[nid];
        if (!n) continue;
        for (const w of n.writes) {
          const op = n.writeOps[w];
          if ((op !== "add" && op !== "sub") || !n.reads.includes(w)) continue;
          const m = motifOf(pdg, "loop-accumulate", [nid], [], { target: w }, { op });
          if (m) out.push(m);
        }
      }
    }
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** Acquire/release pairs by name catalog; an acquire whose release can be bypassed on some path to exit
 *  is flagged `unmatchedRelease` — the leak-candidate shape the composition rules pick up. */
export function extractResourceLifecycleMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  const acquires = new Set<string>(CONCEPT_CONFIG.motif.acquireNames);
  const releases = new Set<string>(CONCEPT_CONFIG.motif.releaseNames);
  const callNodes = pdg.nodes.filter((n) => n.calls.length);
  const acquireNodes = callNodes.filter((n) => n.calls.some((c) => acquires.has(lastSegment(c))));
  const releaseNodes = callNodes.filter((n) => n.calls.some((c) => releases.has(lastSegment(c))));
  for (const a of acquireNodes) {
    const reach = reachableNodes(pdg, a.id);
    const matched = releaseNodes.filter((r) => reach.has(r.id));
    const aName = a.calls.find((c) => acquires.has(lastSegment(c)))!;
    if (matched.length) {
      const r = matched[0];
      const rName = r.calls.find((c) => releases.has(lastSegment(c)))!;
      // Leak shape: some path from the acquire to the exit avoids every release.
      const unmatched = gatewayAvoidingPathToExitExists(pdg, a.id, releaseNodes.map((n) => n.id));
      const m = motifOf(pdg, "resource-acquire-release", [a.id, r.id], [], { acquire: aName, release: rName }, { op: "call" }, { unmatchedRelease: unmatched });
      if (m) out.push(m);
    } else {
      const m = motifOf(pdg, "resource-acquire-release", [a.id], [], { acquire: aName, release: "" }, { op: "call" }, { unmatchedRelease: true });
      if (m) out.push(m);
    }
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** A loop whose body both attempts (calls) and advances a counter the loop condition reads: the retry shape. */
export function extractRetryLoopMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  for (const loop of pdg.loops) {
    const headerNodes = pdg.blocks[loop.header]?.nodes ?? [];
    const cond = headerNodes.map((id) => pdg.nodes[id]).find((n) => n.kind === "cond");
    if (!cond) continue;
    const bodyNodes = loop.blocks.flatMap((b) => pdg.blocks[b]?.nodes ?? []).map((id) => pdg.nodes[id]);
    const attempt = bodyNodes.find((n) => n.calls.length);
    if (!attempt) continue;
    const counters = new Set(cond.reads);
    const counterNode = bodyNodes.find((n) => n.writes.some((w) => counters.has(w) && (n.writeOps[w] === "add" || n.writeOps[w] === "sub")));
    if (!counterNode) continue;
    const counter = [...counters].find((w) => counterNode.writes.includes(w))!;
    const m = motifOf(pdg, "retry-loop", [cond.id, attempt.id, counterNode.id], [], { counter, attempt: attempt.calls[0] }, { op: "loop" });
    if (m) out.push(m);
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** The statements of a catch clause (grouped by catchId): what the code does when the operation fails. */
export function extractErrorHandlingMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  const byCatch = new Map<number, PdgNode[]>();
  for (const n of pdg.nodes) if (n.catchId !== null) byCatch.set(n.catchId, [...(byCatch.get(n.catchId) ?? []), n]);
  for (const [, nodes] of byCatch) {
    if (!nodes.length) continue;
    const meaningful = nodes.filter((n) => n.calls.length || n.writes.length || n.kind === "throw" || n.kind === "return");
    if (!meaningful.length) continue;
    const m = motifOf(pdg, "error-handling-block", meaningful.map((n) => n.id), [], { handler: nodes[0].text }, { op: "catch" });
    if (m) out.push(m);
  }
  // Standalone throw statements outside any catch are error paths too.
  for (const n of pdg.nodes) {
    if (n.kind !== "throw" || n.catchId !== null) continue;
    const m = motifOf(pdg, "error-handling-block", [n.id], [], { handler: n.text }, { op: "throw" });
    if (m) out.push(m);
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** One variable assigned (never arithmetically updated) in two or more differently-guarded branches: a discrete state machine.
 *  Branch distinctness is by (condition, branch sense) — a true if/else pair counts. */
export function extractStateTransitionMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  const byVar = new Map<string, { node: PdgNode; guard: number; kind: string }[]>();
  for (const ge of pdg.guardEdges) {
    const n = pdg.nodes[ge.node];
    if (!n) continue;
    if (n.kind === "cond" || n.kind === "return" || n.kind === "throw" || n.kind === "jump") continue;
    for (const w of n.writes) {
      if ((n.writeOps[w] ?? "assign") !== "assign") continue;
      byVar.set(w, [...(byVar.get(w) ?? []), { node: n, guard: ge.guard, kind: ge.kind }]);
    }
  }
  for (const [v, entries] of byVar) {
    if (entries.length < 2) continue;
    const distinctBranches = new Set(entries.map((e) => `${e.guard}:${e.kind}`));
    if (distinctBranches.size < 2) continue;
    const nodes = [...new Set(entries.map((e) => e.node.id))];
    const m = motifOf(pdg, "state-transition", nodes, [], { state: v }, { op: "assign" });
    if (m) out.push(m);
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** A condition whose true branch immediately returns or throws: the early-exit-on-invalid-input shape. */
export function extractValidationCheckMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  for (const ge of pdg.guardEdges) {
    if (ge.kind !== "true-branch" && ge.kind !== "loop") continue;
    const n = pdg.nodes[ge.node];
    const g = pdg.nodes[ge.guard];
    if (!n || !g) continue;
    if (n.kind !== "return" && n.kind !== "throw") continue;
    const m = motifOf(pdg, "validation-check", [ge.guard, ge.node], [{ from: ge.guard, to: ge.node, kind: ge.kind }], { check: g.text }, { op: "early-exit" });
    if (m) out.push(m);
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** Check-then-compute-then-store on the same variable: the cache-lookup shape. */
export function extractCacheLookupMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  for (const ge of pdg.guardEdges) {
    if (ge.kind !== "true-branch" && ge.kind !== "false-branch") continue;
    const n = pdg.nodes[ge.node];
    const g = pdg.nodes[ge.guard];
    if (!n || !g || !n.writes.length) continue;
    const checked = g.reads.find((r) => n.writes.includes(r));
    if (!checked) continue;
    const m = motifOf(pdg, "cache-lookup", [ge.guard, ge.node], [{ from: ge.guard, to: ge.node, kind: ge.kind }], { cache: checked, check: g.text }, { op: "memoize" });
    if (m) out.push(m);
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** Two calls from the generic pairing catalog where the second is reachable from the first. */
export function extractPairedCallMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  const callNodes = pdg.nodes.filter((n) => n.calls.length);
  for (const pair of CONCEPT_CONFIG.motif.pairedCallNames) {
    const [first, second] = pair as readonly string[];
    if (first === second) continue;
    const firsts = callNodes.filter((n) => n.calls.some((c) => lastSegment(c) === first));
    const seconds = callNodes.filter((n) => n.calls.some((c) => lastSegment(c) === second));
    for (const a of firsts) {
      const reach = reachableNodes(pdg, a.id);
      const b = seconds.find((s) => s.id !== a.id && reach.has(s.id));
      if (!b) continue;
      const aName = a.calls.find((c) => lastSegment(c) === first)!;
      const bName = b.calls.find((c) => lastSegment(c) === second)!;
      const m = motifOf(pdg, "paired-call", [a.id, b.id], [], { first: aName, second: bName }, { op: "pair" });
      if (m) out.push(m);
    }
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

/** A call that happens only under a condition (and is not part of a resource/pair catalog). */
export function extractConditionalCallMotifs(pdg: Pdg): Motif[] {
  const out: Motif[] = [];
  for (const ge of pdg.guardEdges) {
    const n = pdg.nodes[ge.node];
    const g = pdg.nodes[ge.guard];
    if (!n || !g) continue;
    if (n.kind !== "call") continue;
    const m = motifOf(pdg, "conditional-call", [ge.guard, ge.node], [{ from: ge.guard, to: ge.node, kind: ge.kind }], { callee: n.calls[0], guard: g.text }, { op: "call", branch: ge.kind });
    if (m) out.push(m);
  }
  return out.slice(0, CONCEPT_CONFIG.motif.maxPerPattern);
}

const EXTRACTORS: Record<(typeof MOTIF_PATTERNS)[number], (pdg: Pdg) => Motif[]> = {
  "guarded-write": extractGuardedWriteMotifs,
  "loop-accumulate": extractLoopAccumulateMotifs,
  "resource-acquire-release": extractResourceLifecycleMotifs,
  "retry-loop": extractRetryLoopMotifs,
  "error-handling-block": extractErrorHandlingMotifs,
  "state-transition": extractStateTransitionMotifs,
  "validation-check": extractValidationCheckMotifs,
  "cache-lookup": extractCacheLookupMotifs,
  "paired-call": extractPairedCallMotifs,
  "conditional-call": extractConditionalCallMotifs,
};

/** Read/write site counts among the motif's nodes. */
export function computeCardinality(motif: Motif, pdg: Pdg): { reads: number; writes: number } {
  let reads = 0, writes = 0;
  for (const id of motif.nodes) {
    const n = pdg.nodes[id];
    if (!n) continue;
    if (n.reads.length) reads++;
    if (n.writes.length) writes++;
  }
  return { reads, writes };
}

/** Extract every pattern for every PDG, reusing `previous` entries whose PDG signature is unchanged.
 *  A reused entry is re-keyed to the current entity: identical structure in two functions yields two
 *  occurrences, not one entity's motifs stamped on both. */
export function extractAllMotifs(pdgIndex: PdgIndex, previous?: MotifIndex): MotifIndex {
  const index: MotifIndex = { byEntity: new Map(), bySignature: previous?.bySignature ?? new Map() };
  for (const [entityId, pdg] of pdgIndex) {
    const cached = index.bySignature.get(pdg.signature);
    if (cached) {
      index.byEntity.set(entityId, cached.map((m) => ({ ...m, id: motifId(m.pattern, entityId, m.nodes, m.bindings), entityId, file: pdg.file })));
      continue;
    }
    const motifs: Motif[] = [];
    for (const pattern of MOTIF_PATTERNS) {
      const found = EXTRACTORS[pattern](pdg);
      motifs.push(...found);
      if (motifs.length > 2000) break; // pathological source guard
    }
    index.byEntity.set(entityId, motifs);
    index.bySignature.set(pdg.signature, motifs);
  }
  return index;
}
