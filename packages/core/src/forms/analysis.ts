// Structural analysis shared by several forms: where execution enters, what guards it, where state changes.
import type { Entity, Fact, Relationship } from "@cie/schema";
import type { Store } from "../store.ts";
import { containsEvidence, isCode, pathTo, reach, short, type Flow } from "./common.ts";

export interface Entry { id: string; kind: "entry" | "handler"; via?: Relationship }

/** Code nobody calls: operations (nothing calls them) and handlers (only reached through an async hand-off). */
export function entryPoints(flow: Flow): Entry[] {
  const out: Entry[] = [];
  for (const e of flow.entities.values()) {
    if (!isCode(e)) continue;
    const incoming = flow.inn.get(e.entityId) ?? [];
    const calls = incoming.filter((r) => r.kind === "calls"), async = incoming.filter((r) => r.kind === "async-flow");
    if (calls.length) continue;
    if (!(flow.out.get(e.entityId)?.length) && async.length === 0) continue; // isolated helpers are not entry points
    out.push(async.length ? { id: e.entityId, kind: "handler", via: async[0] } : { id: e.entityId, kind: "entry" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Names that suggest enforcement; used only to propose candidates, which are then shown as inferences. */
export const GUARD_NAME = /auth|permit|permission|allow|guard|acl|csrf|valid|sanit|idempot|rate.?limit|throttle|fraud|verify|check|claim.?key|limit/i;
export const GUARD_ERROR = /Forbidden|Unauthori[sz]ed|Denied|Reject|Fraud|Limit|Duplicate|Invalid|Insufficient|Expired|Declined/i;

export interface Guard { id: string; reason: string; errors: string[]; evidenceIds: string[]; nameMatch: boolean; frameworkGuard?: boolean }
export function guards(store: Store, rev: string, flow: Flow): Map<string, Guard> {
  const throwsBy = new Map<string, Fact[]>();
  for (const f of store.factsByPredicate(rev, "throws")) throwsBy.set(f.subject, [...(throwsBy.get(f.subject) ?? []), f]);
  const frameworkGuards = new Map<string, Fact>();
  for (const f of store.factsByPredicate(rev, "framework_role")) {
    if ((f.object as { value?: { role?: string } }).value?.role === "guard") {
      frameworkGuards.set(f.subject, f);
    }
  }
  const out = new Map<string, Guard>();
  for (const e of flow.entities.values()) {
    const isGuardClass = e.kind === "class" && frameworkGuards.has(e.entityId);
    if (!isCode(e) && !isGuardClass) continue;
    const thr = (throwsBy.get(e.entityId) ?? []).filter((f) => GUARD_ERROR.test(String((f.object as { value?: unknown }).value)));
    const nameMatch = GUARD_NAME.test(e.name.split(".").pop()!);
    const fw = frameworkGuards.get(e.entityId);
    // Enforcement means refusing something: a name alone is not enough, there must be a throw site
    // or a framework security annotation (Spring @PreAuthorize, NestJS guard, etc.).
    if (!thr.length && !fw) continue;
    const errors = [...new Set(thr.map((f) => String((f.object as { value?: unknown }).value)))];
    const fwFramework = fw ? String((fw.object as { value?: { framework?: string } }).value?.framework ?? "framework") : "";
    const fwNote = fw ? `Annotated as a guard by ${fwFramework}.` : "";
    out.set(e.entityId, {
      id: e.entityId, errors, nameMatch, frameworkGuard: !!fw,
      reason: `${short(e.entityId)} can refuse the operation${errors.length ? ` by throwing ${errors.join(", ")}` : ""}${nameMatch ? " and is named like a check" : ""}${fwNote ? "; " + fwNote : ""}.`,
      evidenceIds: thr.flatMap((f) => f.evidence.map((x) => x.id)).concat(fw?.evidence.map((x) => x.id) ?? []),
    });
  }
  return out;
}

/** State-changing code: the writers of any field, and what they write. */
export function sinks(store: Store, rev: string): Map<string, { fields: Set<string>; evidenceIds: string[]; inTx: boolean }> {
  const tx = new Set(store.factsByPredicate(rev, "uses_transaction").map((f) => f.subject));
  const out = new Map<string, { fields: Set<string>; evidenceIds: string[]; inTx: boolean }>();
  for (const f of store.factsByPredicate(rev, "writes")) {
    const cur = out.get(f.subject) ?? { fields: new Set<string>(), evidenceIds: [], inTx: tx.has(f.subject) };
    cur.fields.add(String((f.object as { value?: unknown }).value)); cur.evidenceIds.push(...f.evidence.map((x) => x.id)); out.set(f.subject, cur);
  }
  return out;
}

export interface RoutePath { entry: Entry; sink: string; ids: string[]; rels: Relationship[]; gates: string[]; viaAsync: boolean }

const callPos = (r: Relationship) => (r.evidence[0]?.location as { span?: { startByte: number } } | undefined)?.span?.startByte ?? 0;

/** A guard is applied on a route when, before the call that continues the route, one of the route's functions calls it
 *  (check, then act) or when the guard itself is on the route. */
export function gatesOnRoute(flow: Flow, ids: string[], rels: Relationship[], guardIds: Set<string>): string[] {
  const out = new Set<string>();
  ids.forEach((id, i) => {
    if (i < ids.length - 1 && guardIds.has(id)) out.add(id);
    if (i >= rels.length) return;
    const cont = callPos(rels[i]);
    for (const r of flow.out.get(id) ?? []) if (r.kind === "calls" && guardIds.has(r.to) && r.to !== ids[ids.length - 1] && callPos(r) < cont) out.add(r.to);
  });
  return [...out];
}

/** For each guard applied on a route, the call that applies it (the function that checks, and the check). */
export function appliedGuardEdges(flow: Flow, ids: string[], gates: string[]): { guard: string; rel: Relationship }[] {
  const out: { guard: string; rel: Relationship }[] = [];
  for (const gt of gates) for (const id of ids) { const rel = (flow.out.get(id) ?? []).find((r) => r.kind === "calls" && r.to === gt); if (rel) { out.push({ guard: gt, rel }); break; } }
  return out;
}

/** Shortest path from every entry to every sink it can reach (an entry that is itself a sink is a route of length one),
 *  with the guards applied along the way. */
export function routes(flow: Flow, entries: Entry[], sinkIds: Set<string>, guardIds: Set<string>, maxDepth = 8): RoutePath[] {
  const out: RoutePath[] = [];
  for (const entry of entries) {
    const info = reach([entry.id], flow.out, (r) => r.to, maxDepth, 200);
    for (const s of sinkIds) {
      if (!info.has(s)) continue;
      const p = pathTo(info, s);
      out.push({ entry, sink: s, ids: p.ids, rels: p.rels, gates: gatesOnRoute(flow, p.ids, p.rels, guardIds), viaAsync: info.get(s)!.viaAsync });
    }
  }
  return out;
}

export const ownEvidence = (store: Store, rev: string, e: Entity) => containsEvidence(store, rev, e.entityId);
