// C09: the graph query engine is checked against independent brute-force oracles (Floyd–Warshall closure and distances,
// mutual reachability for cycles) on random graphs, plus hand-made graphs with known answers, limits, access and hashing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisBatch, Entity, EvidenceRef, Relationship } from "@cie/schema";
import { policyFor } from "../src/access.ts";
import { cycles, dependents, findPath, LIMITS, project, sccs } from "../src/graph.ts";
import { Store } from "../src/store.ts";

const ROOT = "/repo/synth";
const ev = (id: string): EvidenceRef => ({ id: "ev:" + id, sourceId: "f", location: { kind: "CodeLocation", span: { file: "f.ts", startLine: 1, startCol: 1, endLine: 1, endCol: 2 } as any }, class: "STATIC_RESOLVED", observedAt: "2026-01-01T00:00:00Z", accessScopeId: "local", state: "CURRENT" });
const id = (i: number, dir = "src") => `function:${dir}/f${i}.ts#n${i}`;
function mulberry(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** A store holding one synthetic revision. Order of insertion can be shuffled to prove nothing depends on it. */
function synth(nodes: { id: string; file: string }[], edges: [string, string][], opts: { shuffle?: number; revision?: string } = {}) {
  const store = new Store(":memory:");
  let ents: Entity[] = nodes.map((n) => ({ entityId: n.id, kind: "function", name: n.id.replace(/^.*#/, ""), file: n.file, spans: [] }));
  let rels: Relationship[] = edges.map(([a, b], i) => ({ id: `rel:${a}>${b}:${i}`, from: a, to: b, kind: "calls", evidence: [ev(`${a}>${b}`)], resolution: "RESOLVED" }));
  if (opts.shuffle) { const r = mulberry(opts.shuffle); const sh = <T,>(x: T[]) => x.map((v) => [r(), v] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]); ents = sh(ents); rels = sh(rels); }
  const batch: AnalysisBatch = { revision: opts.revision ?? "rev-synth", gitHead: null, repoRoot: ROOT, entities: ents, facts: [], relationships: rels, diagnostics: [], analyzerVersion: "test" };
  store.putBatch(batch);
  return { store, rev: batch.revision };
}
const plain = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: id(i), file: `src/f${i}.ts` })) });

// Brute-force truth.
function oracle(n: number, edges: [number, number][]) {
  const INF = 1e9; const d: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : INF)));
  for (const [a, b] of edges) if (a !== b) d[a][b] = Math.min(d[a][b], 1);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  const selfLoop = new Set(edges.filter(([a, b]) => a === b).map(([a]) => a));
  const groups: number[][] = []; const seen = new Set<number>();
  for (let i = 0; i < n; i++) { if (seen.has(i)) continue; const g = [i]; for (let j = i + 1; j < n; j++) if (d[i][j] < INF && d[j][i] < INF) g.push(j); g.forEach((x) => seen.add(x)); if (g.length > 1 || selfLoop.has(i)) groups.push(g); }
  return { d, groups, INF };
}

test("C09: known graph oracles: reachability, hop distances, shortest paths and cycles agree with brute force on 60 random graphs", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = mulberry(seed * 7919); const n = 6 + Math.floor(r() * 9); const m = Math.floor(n * (1 + r() * 2.2));
    const edges: [number, number][] = Array.from({ length: m }, () => [Math.floor(r() * n), Math.floor(r() * n)] as [number, number]);
    const { store, rev } = synth(plain(n).nodes, edges.map(([a, b]) => [id(a), id(b)]));
    const o = oracle(n, edges);
    for (let a = 0; a < n; a++) {
      const proj = project(store, rev, [id(a)], { maxDepth: 12, maxNodes: 2000 });
      const want = new Map<string, number>(); for (let b = 0; b < n; b++) if (o.d[a][b] < o.INF) want.set(id(b), o.d[a][b]);
      assert.deepEqual(new Map(proj.nodes.map((x) => [x.id, x.depth])), want, `seed ${seed} node ${a}: reachable set and hop distances`);
      const dep = dependents(store, rev, id(a), { maxDepth: 12 });
      const wantIn = new Set<string>(); for (let b = 0; b < n; b++) if (o.d[b][a] < o.INF) wantIn.add(id(b));
      assert.deepEqual(new Set(dep.nodes.map((x) => x.id)), wantIn, `seed ${seed} node ${a}: dependents`);
      for (let b = 0; b < n; b++) {
        const p = findPath(store, rev, id(a), id(b), { maxDepth: 12 });
        assert.equal(p.found, o.d[a][b] < o.INF, `seed ${seed} path ${a}->${b} existence`);
        if (p.found) {
          assert.equal(p.hops, o.d[a][b], `seed ${seed} path ${a}->${b} is shortest`);
          assert.equal(p.path[0], id(a)); assert.equal(p.path.at(-1), id(b));
          p.edges.forEach((e, i) => { assert.equal(e.from, p.path[i]); assert.equal(e.to, p.path[i + 1]); });
        }
      }
    }
    const got = cycles(store, rev).map((c) => c.join("|")).sort();
    assert.deepEqual(got, o.groups.map((g) => g.map((x) => id(x)).sort().join("|")).sort(), `seed ${seed}: cycles`);
  }
});

test("C09: hand-made graphs with known answers: a diamond, a chain, and a cycle with a tail", () => {
  // diamond a→b, a→c, b→d, c→d, d→e
  const { store, rev } = synth(plain(5).nodes, [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]].map(([a, b]) => [id(a), id(b)]));
  const p = project(store, rev, [id(0)], { maxDepth: 5 });
  assert.deepEqual(p.nodes.map((n) => [n.name, n.depth]), [["n0", 0], ["n1", 1], ["n2", 1], ["n3", 2], ["n4", 3]]);
  assert.equal(p.edges.length, 5);
  const path = findPath(store, rev, id(0), id(4));
  assert.equal(path.hops, 3);
  assert.deepEqual(path.path, [id(0), id(1), id(3), id(4)], "ties between equal-length routes break by id, the same way every time");
  assert.deepEqual(dependents(store, rev, id(3), { maxDepth: 5 }).nodes.map((n) => n.name), ["n0", "n1", "n2", "n3"]);
  assert.equal(findPath(store, rev, id(4), id(0)).found, false, "edges are directed");
  assert.deepEqual(cycles(store, rev), []);
  // cycle with a tail: a→b→c→a, c→t
  const c = synth(plain(4).nodes, [[0, 1], [1, 2], [2, 0], [2, 3]].map(([a, b]) => [id(a), id(b)]));
  assert.deepEqual(cycles(c.store, c.rev), [[id(0), id(1), id(2)]]);
  assert.equal(findPath(c.store, c.rev, id(3), id(0)).found, false);
  assert.equal(findPath(c.store, c.rev, id(0), id(3)).hops, 3);
});

test("C09: cycle handling: self-loops, mutual recursion and a big cycle terminate, are reported, and each node is visited once", () => {
  const self = synth(plain(2).nodes, [[id(0), id(0)], [id(0), id(1)]]);
  const ps = project(self.store, self.rev, [id(0)], { maxDepth: 12 });
  assert.equal(ps.nodes.length, 2);
  assert.deepEqual(ps.cycles, [[id(0)]], "a self-loop is a cycle");
  const n = 500;
  const ring = synth(plain(n).nodes, Array.from({ length: n }, (_, i) => [id(i), id((i + 1) % n)] as [string, string]));
  const pr = project(ring.store, ring.rev, [id(0)], { maxDepth: 12, maxNodes: 2000 });
  assert.equal(new Set(pr.nodes.map((x) => x.id)).size, pr.nodes.length, "no node twice");
  assert.equal(findPath(ring.store, ring.rev, id(0), id(10), { maxDepth: 12 }).hops, 10);
  assert.equal(cycles(ring.store, ring.rev)[0].length, n);
  assert.equal(findPath(ring.store, ring.rev, id(5), id(5)).hops, 0);
});

test("C09: deep traversal limits: depth and node budgets cut the answer and say so; requested limits cannot exceed the engine's ceilings", () => {
  const n = 300;
  const chain = synth(plain(n).nodes, Array.from({ length: n - 1 }, (_, i) => [id(i), id(i + 1)] as [string, string]));
  const shallow = project(chain.store, chain.rev, [id(0)], { maxDepth: 4 });
  assert.equal(shallow.nodes.length, 5);
  assert.deepEqual(shallow.truncated, { byDepth: true, byNodes: false });
  const huge = project(chain.store, chain.rev, [id(0)], { maxDepth: 100_000, maxNodes: 1_000_000 });
  assert.equal(Math.max(...huge.nodes.map((x) => x.depth)), LIMITS.maxDepth, "depth is clamped to the ceiling");
  assert.equal(huge.truncated.byDepth, true);
  const fan = synth(plain(60).nodes, Array.from({ length: 59 }, (_, i) => [id(0), id(i + 1)] as [string, string]));
  const wide = project(fan.store, fan.rev, [id(0)], { maxNodes: 10 });
  assert.equal(wide.nodes.length, 10);
  assert.equal(wide.truncated.byNodes, true);
  assert.equal(findPath(chain.store, chain.rev, id(0), id(200), { maxDepth: 6 }).found, false);
  assert.equal(findPath(chain.store, chain.rev, id(0), id(200), { maxDepth: 6 }).truncated.byDepth, true, "not found because of the limit, and it says so");
  const near = findPath(chain.store, chain.rev, id(0), id(5), { maxDepth: 6 });
  assert.ok(near.found && near.hops === 5 && near.truncated.byDepth === false, "within the limit: found, and not marked as cut");
  // A very deep chain does not overflow the stack: strongly connected components are computed without recursion.
  const nodes = Array.from({ length: 20_000 }, (_, i) => `n${i}`);
  assert.deepEqual(sccs(nodes, nodes.slice(1).map((v, i) => [nodes[i], v] as [string, string])), []);
  const back = sccs(nodes, [...nodes.slice(1).map((v, i) => [nodes[i], v] as [string, string]), [nodes[nodes.length - 1], nodes[0]]]);
  assert.equal(back[0].length, 20_000);
});

test("C09: denied intermediate nodes are never traversed or revealed; the caller learns only that something was left out", () => {
  const a = "function:src/a.ts#a", b = "function:secret/b.ts#SECRETNAME", c = "function:src/c.ts#c", d = "function:src/d.ts#d";
  const nodes = [{ id: a, file: "src/a.ts" }, { id: b, file: "secret/b.ts" }, { id: c, file: "src/c.ts" }, { id: d, file: "src/d.ts" }];
  const { store, rev } = synth(nodes, [[a, b], [b, c]]);
  store.denyPath(ROOT, "secret");
  const access = policyFor(store, ROOT);
  const p = findPath(store, rev, a, c, { access });
  assert.equal(p.found, false, "the only route goes through a denied entity");
  assert.equal(p.hiddenRouteExists, true, "it says a route is hidden");
  assert.ok(!JSON.stringify(p).includes("SECRETNAME") && !JSON.stringify(p).includes("secret/"), "and names nothing");
  const proj = project(store, rev, [a], { access });
  assert.deepEqual(proj.nodes.map((n) => n.id), [a]);
  assert.ok(proj.omittedByAccess >= 1);
  assert.ok(!JSON.stringify(proj).includes("SECRETNAME"));
  assert.deepEqual(dependents(store, rev, c, { access }).nodes.map((n) => n.id), [c], "it does not walk backwards through it either");
  assert.equal(findPath(store, rev, a, b, { access }).found, false, "a denied endpoint is simply not there for this caller");
  // With a visible alternative the path is found, and uses only visible nodes.
  const alt = synth([...nodes], [[a, b], [b, c], [a, d], [d, c]]);
  alt.store.denyPath(ROOT, "secret");
  const q = findPath(alt.store, alt.rev, a, c, { access: policyFor(alt.store, ROOT) });
  assert.deepEqual(q.path, [a, d, c]);
  assert.equal(q.hiddenRouteExists, false);
  assert.deepEqual(cycles(alt.store, alt.rev, { access: policyFor(alt.store, ROOT) }), []);
  // And lifting the denial restores it.
  alt.store.denyPath(ROOT, "secret", false);
  assert.equal(findPath(alt.store, alt.rev, a, c, { access: policyFor(alt.store, ROOT) }).hops, 2);
});

test("C09: projections are reproducible: same graph, same bytes, however it was stored; a changed edge changes the hash", () => {
  const r = mulberry(99); const n = 25;
  const edges: [string, string][] = Array.from({ length: 60 }, () => [id(Math.floor(r() * n)), id(Math.floor(r() * n))] as [string, string]);
  const hashes = new Set<string>(); const bodies = new Set<string>();
  for (const shuffle of [0, 1, 2, 3, 4]) {
    const { store, rev } = synth(plain(n).nodes, edges, { shuffle });
    const p1 = project(store, rev, [id(0), id(3)], { maxDepth: 6 }), p2 = project(store, rev, [id(3), id(0)], { maxDepth: 6 });
    assert.equal(p1.hash, p2.hash, "root order does not matter");
    hashes.add(p1.hash); bodies.add(JSON.stringify({ n: p1.nodes, e: p1.edges, c: p1.cycles }));
  }
  assert.equal(hashes.size, 1, "five different storage orders, one hash");
  assert.equal(bodies.size, 1, "and identical content");
  const changed = synth(plain(n).nodes, [...edges, [id(0), id(24)]]);
  assert.notEqual(project(changed.store, changed.rev, [id(0), id(3)], { maxDepth: 6 }).hash, [...hashes][0]);
  const other = synth(plain(n).nodes, edges, { revision: "another-revision" });
  assert.notEqual(project(other.store, other.rev, [id(0), id(3)], { maxDepth: 6 }).hash, [...hashes][0], "a different revision is a different projection");
});
