import assert from "node:assert/strict";
import { test } from "node:test";
import { focusedPreview, attachFisheye, automaticLensGeometry, boundedLensCentre, clipLink, invertLens, localChildren, projectLens, relaxLensNodes, type LensNode } from "../src/fisheye.ts";
import type { Rendered } from "../src/graph.ts";

test("lens projection fixes the boundary and all surrounding context", () => {
  const centre = { x: 100, y: 200 }, radius = 242;
  for (const magnification of [.35, 1, 2.2, 4]) {
    for (const point of [{ x: 342, y: 200 }, { x: 1000, y: -100 }, centre]) {
      assert.deepEqual(projectLens(point, centre, magnification, radius), point);
    }
    const p = projectLens({ x: 105, y: 200 }, centre, magnification, radius);
    assert.equal(Math.sign(p.x - 105), Math.sign(magnification - 1));
  }
});

test("projection is monotonic and inverse hit testing round-trips magnification and shrinking", () => {
  const centre = { x: 75, y: 100 };
  for (const magnification of [.35, .55, 1, 2.2, 4]) {
    let previous = -1;
    for (let distance = 0; distance < 500; distance++) {
      const point = { x: centre.x + distance * .6, y: centre.y + distance * .8 };
      const projected = projectLens(point, centre, magnification, 242);
      const radial = Math.hypot(projected.x - centre.x, projected.y - centre.y);
      assert.ok(radial > previous); previous = radial;
      const inverted = invertLens(projected, centre, magnification, 242);
      assert.ok(Math.hypot(inverted.x - point.x, inverted.y - point.y) < 1e-8);
    }
  }
});

test("links stop at endpoints and are clipped around intervening node boxes", () => {
  const boxes = [{ x: 0, y: 0, width: 100, height: 40 }, { x: 150, y: 0, width: 60, height: 40 }, { x: 300, y: 0, width: 100, height: 40 }];
  assert.deepEqual(clipLink({ x: 0, y: 0 }, { x: 300, y: 0 }, boxes), [
    [{ x: 53, y: 0 }, { x: 117, y: 0 }], [{ x: 183, y: 0 }, { x: 247, y: 0 }],
  ]);
  assert.deepEqual(clipLink({ x: 0, y: 100 }, { x: 300, y: 100 }, boxes), [[{ x: 0, y: 100 }, { x: 300, y: 100 }]]);
  assert.deepEqual(clipLink({ x: -20, y: 0 }, { x: 20, y: 0 }, boxes), []);
});

test("local expansion retains identities and evidence without mutating the source graph", () => {
  const graph: Rendered = {
    nodes: Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, kind: "node", label: `Function ${i}`, count: 1, members: [`n${i}`], displayMode: "FACT", tier: "RELEVANT", pos: { x: i * 250, y: i * 80 }, stale: false })),
    edges: [{ id: "e", from: "n0", to: "n1", label: "calls", count: 1, kind: "calls", edgeIds: ["e"], evidenceIds: ["proof"], displayMode: "FACT", stale: false }], groups: [],
  };
  const parent: LensNode = { id: "aggregate", label: "Module", x: 900, y: 800, width: 190, height: 44, color: "#60a5fa" };
  const before = structuredClone(graph), first = localChildren(parent, graph.nodes, graph.edges, { x: 300, y: 250 }, 242);
  assert.equal(first.nodes.length, 10);
  assert.equal(first.edges[0].ref, graph.edges[0]);
  assert.equal(first.nodes[0].ref, graph.nodes[0]);
  const second = localChildren(parent, graph.nodes, graph.edges, { x: 300, y: 250 }, 242, 1);
  assert.equal(second.nodes.length, 5);
  assert.equal(second.nodes[0].id, "n10");
  assert.deepEqual(graph, before);
  assert.equal(second.edges.length, 0, "no edges are fabricated across pages");
});

test("local relaxation separates focus boxes without moving context or mutating layout", () => {
  const common = { label: "Function", width: 100, height: 40, color: "#60a5fa" };
  const nodes = [{ ...common, id: "a", x: 0, y: 0, movable: true }, { ...common, id: "b", x: 20, y: 0, movable: true }, { ...common, id: "context", x: 500, y: 500 }];
  const before = structuredClone(nodes), result = relaxLensNodes(nodes, { x: 0, y: 0 }, 242);
  assert.deepEqual(result[2], nodes[2]); assert.deepEqual(nodes, before);
  assert.ok(Math.abs(result[0].x - result[1].x) >= 110 || Math.abs(result[0].y - result[1].y) >= 50);
});


test("automatic geometry gives 70% diameter, an 88% inner radius, and a viewport-safe cap", () => {
  const g = automaticLensGeometry(800, 605);
  assert.equal(g.outer * 2, 423.5);
  assert.equal(g.inner / g.outer, .88);
  assert.equal(automaticLensGeometry(2000, 1400).outer * 2, 520);
  for (const [w, h] of [[320, 240], [40, 40], [800, 605]]) {
    const { outer, inner } = automaticLensGeometry(w, h);
    assert.ok(inner < outer);
    const c = boundedLensCentre({ x: -100, y: 10000 }, w, h, outer);
    assert.ok(c.x - outer >= 8 && c.y - outer >= 8);
    assert.ok(c.x + outer <= w - 8 && c.y + outer <= h - 8);
  }
  assert.deepEqual(automaticLensGeometry(0, 0), { outer: 0, inner: 0 });
});

test("expanded child boxes fit inside the inner circle without overlaps across pages", () => {
  const children = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, kind: "node", label: `Child ${i}`, count: 1, members: [`n${i}`], displayMode: "FACT", tier: "RELEVANT", pos: { x: 0, y: 0 }, stale: false })) as Rendered["nodes"];
  const parent: LensNode = { id: "p", label: "Group", x: 0, y: 0, width: 100, height: 40, color: "#60a5fa" };
  for (const radius of [74, 130, 186.34, 228.8]) {
    const seen = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const { nodes } = localChildren(parent, children, [], { x: 0, y: 0 }, radius, page);
      for (const n of nodes) {
        assert.ok(!seen.has(n.id)); seen.add(n.id);
        assert.ok(Math.hypot(Math.abs(n.x) + n.width / 2, Math.abs(n.y) + n.height / 2) <= radius);
        for (const b of nodes) if (b.id !== n.id) assert.ok(Math.abs(n.x - b.x) >= (n.width + b.width) / 2 || Math.abs(n.y - b.y) >= (n.height + b.height) / 2);
      }
    }
    assert.equal(seen.size, children.length);
  }
});


test("automatic hover waits, holds focus, leaves wheel unchanged, and cancels pending work on dispose", (t) => {
  const globals = ["document", "window", "matchMedia", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio"];
  const descriptors = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  const text: string[] = [], arcs: number[] = [];
  const context = new Proxy<Record<string, unknown>>({}, { get: (_, name) => name === "measureText" ? (s: string) => ({ width: s.length * 7 }) : name === "fillText" ? (s: string) => text.push(s) : name === "arc" ? (_x: number, _y: number, r: number) => arcs.push(r) : () => {}, set: () => true });
  class Surface extends EventTarget {
    dataset: Record<string, string> = {}; clientWidth = 800; clientHeight = 605;
    width = 0; height = 0; className = ""; removed = false;
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    getContext() { return context; }
    setAttribute() {} append() {} remove() { this.removed = true; }
    closest() { return null; }
  }
  const host = new Surface(), canvas = new Surface();
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(16); };
  const pointer = (x: number, y: number) => host.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y }));
  let picked = "", sceneLabel = "Focus";
  try {
    set("document", { createElement: () => canvas }); set("window", new EventTarget());
    set("matchMedia", () => ({ matches: false })); set("devicePixelRatio", 1);
    set("ResizeObserver", class { observe() {} disconnect() {} });
    set("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    set("cancelAnimationFrame", (id: number) => frames.delete(id));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const engine = attachFisheye(host as unknown as HTMLElement, {
      scene: () => ({ nodes: [{ id: "focus", label: sceneLabel, x: 400, y: 300, width: 80, height: 40, color: "#60a5fa" }, { id: "neighbor", label: "Unrelated neighbor", x: 450, y: 330, width: 80, height: 40, color: "#60a5fa" }], edges: [] }),
      onNode: (node) => { picked = node.id; },
    });
    flush(); pointer(400, 300); t.mock.timers.tick(199); flush(); assert.equal(text.length, 0);
    t.mock.timers.tick(1); flush(); assert.ok(text.includes("Focus"));
    assert.ok(arcs.some((r) => Math.abs(r - 211.75) < 1e-8)); assert.ok(arcs.some((r) => Math.abs(r - 186.34) < 1e-8));
    sceneLabel = "Changed after capture"; pointer(450, 330); flush();
    assert.equal(host.dataset.lensTarget, "focus"); assert.ok(!text.includes("Unrelated neighbor")); assert.ok(!text.includes("Changed after capture"));
    host.dispatchEvent(Object.assign(new Event("click", { cancelable: true }), { clientX: 400, clientY: 300, detail: 1 }));
    assert.equal(picked, "focus");
    const wheel = new Event("wheel", { cancelable: true }); host.dispatchEvent(wheel); assert.equal(wheel.defaultPrevented, false);
    engine.configure({ radius: 60, falloff: 3, magnification: 4, rings: false }); flush();
    assert.equal(host.dataset.lensMagnification, "2.2"); assert.ok(Math.abs(Number(host.dataset.lensOuterRadius) - 211.75) < 1e-8);
    engine.configure({ enabled: false }); flush(); text.length = 0; pointer(400, 300); t.mock.timers.tick(250); flush(); assert.equal(text.length, 0);
    engine.configure({ enabled: true }); flush(); pointer(400, 300); engine.dispose();
    t.mock.timers.tick(250); flush(); assert.equal(text.length, 0); assert.equal(canvas.removed, true);
  } finally {
    t.mock.timers.reset();
    for (const [name, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});


test("focused previews show only the captured node or relationship without mutating source geometry", () => {
  const a: LensNode = { id: "a", label: "Source", x: 900, y: 500, width: 80, height: 40, color: "#60a5fa" };
  const b: LensNode = { ...a, id: "b", label: "Target", x: 1300 };
  const before = structuredClone([a, b]);
  const node = focusedPreview({ kind: "node", node: a, children: [], edges: [] }, { x: 200, y: 200 }, 180);
  assert.deepEqual(node.nodes.map((n) => n.id), ["a"]); assert.equal(node.edges.length, 0);
  assert.ok(node.nodes[0].details?.includes("No deeper detail available"));
  const edge = { id: "ab", from: "a", to: "b", points: [a, b], color: "#fb7185", sourceArrow: "diamond", sourceArrowFill: "hollow", targetArrow: "triangle", lineStyle: "dotted" };
  const preview = focusedPreview({ kind: "edge", edge, source: a, target: b }, { x: 200, y: 200 }, 180);
  assert.deepEqual(preview.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(preview.edges.length, 1); assert.equal(preview.edges[0].sourceArrowFill, "hollow"); assert.equal(preview.edges[0].lineStyle, "dotted");
  assert.deepEqual([a, b], before); assert.deepEqual(edge.points, [a, b]);
});
