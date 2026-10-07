// V18 RouteMap: framework-aware HTTP routes and the guards that protect them.
// Rows are routes (method + path); columns are guards discovered by the framework plugins
// (framework_role facts with role: "guard"). A cell marks the guard as applied on a route
// when the guard subject is the route handler, its controller/class, or a containing module.

import type { Claim, MatrixAxis, MatrixCell, ViewNode } from "@cie/schema";
import type { Entity, Fact } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { baseView, claimOf, containsEvidence, emptyForm, hash, nodeBase } from "./common.ts";

interface RouteInfo {
  id: string;
  method: string;
  path: string;
  handler: string;
  framework?: string;
  entityName: string;
  file: string;
  controllerId?: string;
  evidenceIds: string[];
}

interface GuardInfo {
  id: string;
  name: string;
  framework?: string;
  evidenceIds: string[];
  appliesTo: Set<string>; // route ids
}

function routeValue(f: Fact) {
  const v = (f.object as { value?: { method?: string; path?: string; handler?: string; kind?: string } }).value ?? {};
  return {
    method: String(v.method ?? "").toUpperCase(),
    path: String(v.path ?? ""),
    handler: String(v.handler ?? ""),
    kind: String(v.kind ?? ""),
  };
}

function frameworkName(f: Fact): string | undefined {
  const v = (f.object as { value?: { framework?: string } }).value ?? {};
  return v.framework || undefined;
}

function collectRoutes(store: Store, rev: string, entities: Map<string, Entity>): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const f of store.factsByPredicate(rev, "route")) {
    const rv = routeValue(f);
    if (!rv.path && !rv.method) continue;
    const e = entities.get(f.subject);
    const controllerRel = store.relationshipsFor(rev, f.subject).find((r) => r.kind === "exposes_route");
    out.push({
      id: f.subject,
      method: rv.method,
      path: rv.path,
      handler: rv.handler,
      framework: frameworkName(f),
      entityName: e?.name ?? rv.handler,
      file: e?.file ?? "",
      controllerId: controllerRel?.from,
      evidenceIds: f.evidence.map((e) => e.id),
    });
  }
  return out.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`) || a.id.localeCompare(b.id));
}

function collectGuards(store: Store, rev: string, entities: Map<string, Entity>): GuardInfo[] {
  const out: GuardInfo[] = [];
  for (const f of store.factsByPredicate(rev, "framework_role")) {
    const v = (f.object as { value?: { role?: string; framework?: string; name?: string } }).value ?? {};
    if (v.role !== "guard") continue;
    const e = entities.get(f.subject);
    const factName = v.name;
    out.push({
      id: f.subject,
      name: factName || (e?.name ?? short(f.subject)),
      framework: v.framework || frameworkName(f),
      evidenceIds: f.evidence.map((e) => e.id),
      appliesTo: new Set(),
    });
  }
  return out;
}

function short(id: string) { return id.replace(/^[a-z]+:/, "").replace(/^.*\//, ""); }

function guardAppliesToRoute(guardId: string, route: RouteInfo, store: Store, rev: string, entities: Map<string, Entity>): boolean {
  if (guardId === route.id) return true;
  if (guardId === route.controllerId) return true;
  // Guard may be attached to the controller's file entity rather than the class entity.
  if (route.controllerId) {
    const controller = entities.get(route.controllerId);
    const guardEntity = entities.get(guardId);
    if (controller && guardEntity && guardEntity.kind === "file" && controller.file === guardEntity.name) return true;
    if (controller && guardEntity && guardEntity.file === controller.file) return true;
  }
  // Guard placed on a class/module that contains the route handler via contains relationships.
  const rels = store.relationshipsFor(rev, route.id);
  const parents = new Set<string>();
  for (const r of rels) {
    if (r.kind === "contains" && r.to === route.id) parents.add(r.from);
    if (r.kind === "exposes_route" && r.to === route.id) parents.add(r.from);
  }
  for (const p of parents) {
    if (p === guardId) return true;
    const pe = entities.get(p);
    const ge = entities.get(guardId);
    if (pe && ge && ge.file === pe.file) return true;
    const prels = store.relationshipsFor(rev, p);
    for (const r of prels) if (r.kind === "contains" && r.to === p && r.from === guardId) return true;
  }
  return false;
}

export function buildRouteMap(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "RouteMap" as const, question, kind: "routemap", caption: "", reason: "You asked about routes, so this shows the HTTP endpoints the framework exposes and the guards that protect them." };
  const entities = new Map(store.entities(rev.id).map((e) => [e.entityId, e]));
  const routes = collectRoutes(store, rev.id, entities);
  if (routes.length === 0) return emptyForm(o, "No framework routes were found in this revision.");

  const guards = collectGuards(store, rev.id, entities);
  for (const g of guards) for (const r of routes) if (guardAppliesToRoute(g.id, r, store, rev.id, entities)) g.appliesTo.add(r.id);

  const v = baseView(o);
  const claims: Claim[] = [];
  const nodeId = (id: string) => `n:${id}`;

  // Nodes: each route, and each guard that applies to at least one route.
  const activeGuards = guards.filter((g) => g.appliesTo.size > 0);
  let row = 0;
  for (const r of routes) {
    const e = entities.get(r.id);
    const label = `${r.method} ${r.path}`;
    const notes: string[] = [`${r.framework ? `${r.framework} ` : ""}route handled by ${r.handler || r.entityName}.`];
    if (r.file) notes.push(`Declared in ${r.file}.`);
    v.nodes.push(nodeBase(e ?? { entityId: r.id, kind: "route", name: label, file: r.file, spans: [] }, {
      id: nodeId(r.id), evidenceIds: r.evidenceIds, label, kind: e?.kind ?? "route", file: r.file,
      tier: "RELEVANT", role: "route", pos: { x: 0, y: row * 70 }, notes,
    } as ViewNode));
    row++;
  }
  for (const g of activeGuards) {
    const e = entities.get(g.id);
    const c = claimOf(store, rev.id, {
      assertion: `${g.name} is applied to ${g.appliesTo.size} route(s) as a ${g.framework ? g.framework + " " : ""}guard.`,
      claimClass: "framework-guard",
      evidenceIds: g.evidenceIds,
      subjects: [g.id],
      rationaleSummary: "Detected by the framework plugin from security annotations or CanActivate implementations.",
    });
    claims.push(c);
    v.nodes.push(nodeBase(e ?? { entityId: g.id, kind: "guard", name: g.name, file: "", spans: [] }, {
      id: nodeId(g.id), evidenceIds: g.evidenceIds, label: g.name, kind: e?.kind ?? "guard", file: e?.file ?? "",
      tier: "CRITICAL", role: "guard", pos: { x: 360, y: row * 70 }, badge: g.framework ? `${g.framework} guard` : "guard",
      notes: [c.draft.assertion], ownClaimId: c.draft.id, claimIds: [c.draft.id], displayMode: c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE",
    } as ViewNode));
    row++;
    for (const rid of g.appliesTo) {
      v.edges.push({
        id: `e:guard:${g.id}:${rid}`, fromNodeId: nodeId(g.id), toNodeId: nodeId(rid),
        kind: "guards", evidenceIds: g.evidenceIds, displayMode: "FACT", label: "protects",
      });
    }
  }

  // Matrix: rows = routes, cols = guards.
  const mRows = new Map<string, MatrixAxis>(), mCols: MatrixAxis[] = [], mCells: MatrixCell[] = [];
  for (const r of routes) {
    mRows.set(r.id, {
      id: r.id, label: `${r.method} ${r.path}`, sub: `handled by ${r.handler || r.entityName}`, role: "route",
      entityRefs: [r.id], evidenceIds: r.evidenceIds,
    });
  }
  for (const g of activeGuards) {
    mCols.push({
      id: g.id, label: g.name, sub: g.framework ? `${g.framework} guard` : "guard", role: "guard",
      entityRefs: [g.id], evidenceIds: g.evidenceIds,
    });
    for (const rid of g.appliesTo) {
      const route = routes.find((r) => r.id === rid);
      mCells.push({
        row: rid, col: g.id, state: "guarded", displayMode: "FACT",
        evidenceIds: [...routemapEvFor(rid, g.id, store, rev.id, route?.evidenceIds ?? []), ...g.evidenceIds].slice(0, 6),
        note: `${g.name} protects ${route?.method ?? ""} ${route?.path ?? ""}.`,
      });
    }
  }
  if (mRows.size && mCols.length) {
    // Add explicit unguarded cells for routes with no guard, so the matrix shows the empty meaning per row.
    for (const r of routes) {
      const covered = new Set(mCells.filter((c) => c.row === r.id).map((c) => c.col));
      for (const g of activeGuards) if (!covered.has(g.id)) {
        mCells.push({
          row: r.id, col: g.id, state: "unguarded", displayMode: "INFERENCE",
          evidenceIds: r.evidenceIds, note: `${g.name} does not apply to ${r.method} ${r.path}.`,
        });
      }
    }
    v.matrix = {
      rowTitle: "Route (method + path)", colTitle: "Guard",
      rows: [...mRows.values()], cols: mCols, cells: mCells,
      states: {
        guarded: { label: "guarded", glyph: "✓", description: "The framework plugin found a security annotation, CanActivate implementation, or configured filter applied to this route." },
        unguarded: { label: "unguarded", glyph: "○", description: "No framework guard was found on this route. It may still be protected by a proxy or convention." },
      },
      emptyMeaning: "No guard applies to this route.",
    };
  }

  const guardedCount = new Set(routes.filter((r) => activeGuards.some((g) => g.appliesTo.has(r.id))).map((r) => r.id)).size;
  const unguarded = routes.filter((r) => !activeGuards.some((g) => g.appliesTo.has(r.id))).length;
  v.caption = `${routes.length} framework route(s) found; ${guardedCount} protected by ${activeGuards.length} guard(s), ${unguarded} with no detected guard.`;
  v.gaps.push("Guards are detected by framework plugins from annotations and CanActivate implementations; protection in a reverse proxy or API gateway may not be visible.");
  v.gaps.push("Unguarded routes are inference, not proof that no protection exists.");
  return { view: v, claims };
}

function routemapEvFor(routeId: string, guardId: string, store: Store, rev: string, fallback: string[]): string[] {
  const rels = store.relationshipsFor(rev, routeId);
  const ev = rels.filter((r) => r.from === guardId || r.to === guardId).flatMap((r) => r.evidence.map((e) => e.id));
  return ev.length ? ev : fallback;
}
