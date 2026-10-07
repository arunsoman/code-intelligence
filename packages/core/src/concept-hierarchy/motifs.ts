// The motif catalogue (plan §0.6): ten GENERIC control/data shapes. Nothing here knows what the code
// means for the business — "debit", "credit", "increment" and friends are deliberately absent; they
// emerge from composition rules in semantic-concepts.ts, never from a lexicon. Each matcher returns
// the nodes it matched and the variables it bound, or null.
import type { MotifMatch, Pdg, PdgNode } from "./types.ts";

export interface MotifPattern {
  id: string;
  /** Every occurrence of this motif in the graph, possibly none. */
  match(pdg: Pdg): Omit<MotifMatch, "entityId">[];
}

const byId = (pdg: Pdg) => new Map(pdg.nodes.map((n) => [n.id, n]));
const outEdges = (pdg: Pdg) => {
  const m = new Map<string, Pdg["edges"]>();
  for (const e of pdg.edges) m.set(e.from, [...(m.get(e.from) ?? []), e]);
  return m;
};
const inEdges = (pdg: Pdg) => {
  const m = new Map<string, Pdg["edges"]>();
  for (const e of pdg.edges) m.set(e.to, [...(m.get(e.to) ?? []), e]);
  return m;
};
const guardedBy = (pdg: Pdg, nodeId: string) => pdg.edges.filter((e) => e.to === nodeId && e.kind === "guard").map((e) => e.from);
const node = (pdg: Pdg, id: string): PdgNode | undefined => byId(pdg).get(id);
/** A use node resolves to the def that feeds it (one hop); a def resolves to itself. */
const resolveDef = (pdg: Pdg, id: string): PdgNode | undefined => {
  const n = node(pdg, id);
  if (!n) return undefined;
  if (n.kind === "def") return n;
  if (n.kind === "use") {
    const feed = pdg.edges.find((e) => e.kind === "data" && e.to === id);
    return feed ? node(pdg, feed.from) : undefined;
  }
  return undefined;
};

/** 1. guarded-write: a variable is written inside a conditional region. */
const guardedWrite: MotifPattern = {
  id: "guarded-write",
  match(pdg) {
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const n of pdg.nodes) {
      if (n.kind !== "def" || !n.name) continue;
      const guard = guardedBy(pdg, n.id).find((g) => node(pdg, g)?.kind === "branch");
      if (guard) out.push({ motif: this.id, nodes: [guard, n.id], binds: { var: n.name } });
    }
    return out;
  },
};

/** 2. loop-accumulate: a variable's own value feeds its next value (x = x + e; x += e; x++). */
const loopAccumulate: MotifPattern = {
  id: "loop-accumulate",
  match(pdg) {
    const inc = inEdges(pdg);
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const n of pdg.nodes) {
      if (n.kind !== "def" || !n.name || !n.op) continue;
      const feeds = (inc.get(n.id) ?? []).filter((e) => e.kind === "data");
      const selfFed = feeds.some((e) => node(pdg, e.from)?.kind === "use" && node(pdg, e.from)!.name === n.name);
      if (selfFed) out.push({ motif: this.id, nodes: [n.id], binds: { var: n.name } });
    }
    return out;
  },
};

/** 3. resource-acquire-release: an acquire lexicon call with a release lexicon call after it. */
const resourceAcquireRelease: MotifPattern = {
  id: "resource-acquire-release",
  match(pdg) {
    const acq = pdg.nodes.filter((n) => n.kind === "acquire");
    const rel = pdg.nodes.filter((n) => n.kind === "release");
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const a of acq) {
      const after = rel.find((r) => r.at > a.at);
      if (after) out.push({ motif: this.id, nodes: [a.id, after.id], binds: { resource: a.name ?? "resource" } });
    }
    return out;
  },
};

/** 4. retry-loop: a self-fed counter named like an attempt counter, with a call under the same guard. */
const retryLoop: MotifPattern = {
  id: "retry-loop",
  match(pdg) {
    const inc = inEdges(pdg);
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const n of pdg.nodes) {
      if (n.kind !== "def" || !n.name || !/retr|attempt|tries|attempt/i.test(n.name)) continue;
      const selfFed = (inc.get(n.id) ?? []).some((e) => e.kind === "data" && node(pdg, e.from)?.kind === "use" && node(pdg, e.from)!.name === n.name);
      if (!selfFed) continue;
      const guards = guardedBy(pdg, n.id);
      const hasCall = pdg.nodes.some((c) => c.kind === "call" && guards.some((g) => guardedBy(pdg, c.id).includes(g)));
      if (hasCall) out.push({ motif: this.id, nodes: [n.id], binds: { var: n.name } });
    }
    return out;
  },
};

/** 5. early-exit-guard: a branch guarding a return or throw in the first half of the function. */
const earlyExitGuard: MotifPattern = {
  id: "early-exit-guard",
  match(pdg) {
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const t of pdg.nodes.filter((n) => n.kind === "return" || n.kind === "throw")) {
      if (t.at > pdg.nodes.length / 2) continue;
      const g = guardedBy(pdg, t.id).find((x) => node(pdg, x)?.kind === "branch");
      if (g) out.push({ motif: this.id, nodes: [g, t.id], binds: {} });
    }
    return out;
  },
};

/** 6. fan-out-dispatch: one branch guarding calls to two or more distinct callees. */
const fanOutDispatch: MotifPattern = {
  id: "fan-out-dispatch",
  match(pdg) {
    const branches = pdg.nodes.filter((n) => n.kind === "branch");
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const b of branches) {
      const guarded = pdg.nodes.filter((n) => n.kind === "call" && guardedBy(pdg, n.id).includes(b.id));
      const names = new Set(guarded.map((c) => c.name ?? "?"));
      if (names.size >= 2) out.push({ motif: this.id, nodes: [b.id, ...guarded.map((c) => c.id)], binds: {} });
    }
    return out;
  },
};

/** 7. collect-and-return: a local's value reaches the returned value. */
const collectAndReturn: MotifPattern = {
  id: "collect-and-return",
  match(pdg) {
    const inc = inEdges(pdg);
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const r of pdg.nodes.filter((n) => n.kind === "return")) {
      const feeds = (inc.get(r.id) ?? []).filter((e) => e.kind === "data");
      for (const f of feeds) {
        const d = resolveDef(pdg, f.from);
        if (d?.kind === "def" && d.name) out.push({ motif: this.id, nodes: [d.id, r.id], binds: { var: d.name } });
      }
    }
    return out;
  },
};

/** 8. wrap-rethrow: a throw whose value is built by a call (wrapping the original error). */
const wrapRethrow: MotifPattern = {
  id: "wrap-rethrow",
  match(pdg) {
    const inc = inEdges(pdg);
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const t of pdg.nodes.filter((n) => n.kind === "throw")) {
      const feeds = (inc.get(t.id) ?? []).filter((e) => e.kind === "data");
      const fromCall = feeds.map((e) => node(pdg, e.from)).find((n) => n?.kind === "call");
      if (fromCall) out.push({ motif: this.id, nodes: [fromCall.id, t.id], binds: { wrapper: fromCall.name ?? "error" } });
    }
    return out;
  },
};

/** 9. flag-guard: a boolean-named local is written, and a branch appears later in the function. */
const flagGuard: MotifPattern = {
  id: "flag-guard",
  match(pdg) {
    const flags = pdg.nodes.filter((n) => n.kind === "def" && n.name && /^(is|has|should|can|needs)[A-Z_]/.test(n.name));
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const f of flags) {
      const laterBranch = pdg.nodes.find((n) => n.kind === "branch" && n.at > f.at);
      if (laterBranch) out.push({ motif: this.id, nodes: [f.id, laterBranch.id], binds: { var: f.name! } });
    }
    return out;
  },
};

/** 10. null-check-fallback: a branch on a call-derived variable, with a different variable written under it. */
const nullCheckFallback: MotifPattern = {
  id: "null-check-fallback",
  match(pdg) {
    const inc = inEdges(pdg);
    const out: Omit<MotifMatch, "entityId">[] = [];
    for (const b of pdg.nodes.filter((n) => n.kind === "branch" && n.name)) {
      const condFeeds = (inc.get(b.id) ?? []).filter((e) => e.kind === "data");
      const fromCall = condFeeds.map((e) => resolveDef(pdg, e.from)).some((d) =>
        d?.kind === "def" && (inc.get(d.id) ?? []).some((e2) => e2.kind === "data" && node(pdg, e2.from)?.kind === "call"));
      if (!fromCall) continue;
      const guardedDef = pdg.nodes.find((n) => n.kind === "def" && n.name && n.name !== b.name && guardedBy(pdg, n.id).includes(b.id));
      if (guardedDef) out.push({ motif: this.id, nodes: [b.id, guardedDef.id], binds: { checked: b.name!, fallback: guardedDef.name! } });
    }
    return out;
  },
};

/** Order matters only for display; matchers are independent and all run. */
export const MOTIF_PATTERNS: MotifPattern[] = [
  guardedWrite, loopAccumulate, resourceAcquireRelease, retryLoop, earlyExitGuard,
  fanOutDispatch, collectAndReturn, wrapRethrow, flagGuard, nullCheckFallback,
];

/** Every motif occurrence in one function, in catalogue order. */
export function matchMotifs(pdg: Pdg): MotifMatch[] {
  return MOTIF_PATTERNS.flatMap((p) => p.match(pdg).map((m) => ({ ...m, entityId: pdg.entityId })));
}
