// C22 typed tool broker (design §10): the only way an investigation reads anything. A request is a registered schema id
// plus a payload whose keys are checked; there is no shell, no file path, no URL and no repository write. A model can
// propose a check only by naming one of these; it can never supply something that is executed.
import { policyFor } from "../access.ts";
import { dependents as graphDependents, findPath } from "../graph.ts";
import type { Store } from "../store.ts";
import type { CoverageCertificate, InvestigationScope, OutcomeTag, RegisteredToolRequest, Usage } from "./types.ts";
import { C22Error } from "./types.ts";
import { hash } from "./reducer.ts";

export interface ToolDef { id: string; schemaId: string; keys: string[]; required: string[] }
export const TOOLS: Record<string, ToolDef> = {
  "graph.dependents": { id: "graph.dependents", schemaId: "c22.tool.graph.dependents.v1", keys: ["entityId", "depth", "minCount"], required: ["entityId"] },
  "graph.paths": { id: "graph.paths", schemaId: "c22.tool.graph.paths.v1", keys: ["from", "to", "maxDepth"], required: ["from", "to"] },
  "source.entity": { id: "source.entity", schemaId: "c22.tool.source.entity.v1", keys: ["entityId", "predicate"], required: ["entityId", "predicate"] },
  "retrieve.evidence": { id: "retrieve.evidence", schemaId: "c22.tool.retrieve.evidence.v1", keys: ["query", "limit"], required: ["query"] },
  "runtime.window": { id: "runtime.window", schemaId: "c22.tool.runtime.window.v1", keys: ["signature"], required: ["signature"] },
};
/** Anything that looks like instructions to a machine is refused outright, whatever tool it is attached to. */
const FORBIDDEN_KEYS = /^(cmd|command|shell|exec|script|eval|code|path|file|url|uri|write|patch|sql|args|argv|env)$/i;

export function toolRequest(toolId: string, payload: Record<string, unknown>): RegisteredToolRequest {
  const t = TOOLS[toolId];
  if (!t) throw new C22Error("FORBIDDEN", `tool "${toolId}" is not registered`);
  return { schemaId: t.schemaId, version: 1, payload };
}

/** Validate a request against its tool: registered id, matching schema id, only known keys, all required keys, plain values. */
export function validateRequest(toolId: string, req: RegisteredToolRequest, scope: InvestigationScope): void {
  const t = TOOLS[toolId];
  if (!t) throw new C22Error("FORBIDDEN", `tool "${toolId}" is not registered; the broker runs only registered read tools`);
  if (!scope.allowedTools.includes(toolId)) throw new C22Error("FORBIDDEN", `tool "${toolId}" is outside this investigation's allowed tools`);
  if (req.schemaId !== t.schemaId) throw new C22Error("INVALID_SCHEMA", `request schema "${req.schemaId}" is not the one registered for ${toolId}`);
  if (!req.payload || typeof req.payload !== "object" || Array.isArray(req.payload)) throw new C22Error("INVALID_SCHEMA", "payload must be an object");
  for (const [k, v] of Object.entries(req.payload)) {
    if (FORBIDDEN_KEYS.test(k)) throw new C22Error("FORBIDDEN", `payload key "${k}" would make this executable or reach outside the repository model; refused`);
    if (!t.keys.includes(k)) throw new C22Error("INVALID_SCHEMA", `payload key "${k}" is not part of ${t.schemaId}`);
    if (!(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) throw new C22Error("INVALID_SCHEMA", `payload value for "${k}" must be plain text or a number`);
    if (typeof v === "string" && v.length > 300) throw new C22Error("INVALID_SCHEMA", `payload value for "${k}" is too long`);
  }
  for (const k of t.required) if (!(k in req.payload)) throw new C22Error("INVALID_SCHEMA", `payload is missing "${k}"`);
}

export interface ToolResult {
  toolId: string; schemaId: string; scopeHash: string; revision: string; evidenceIds: string[]; usage: Usage;
  outcome: OutcomeTag; summary: string; detail: Record<string, unknown>; certificate: CoverageCertificate | null; runtimeIds: string[];
}

export interface ToolEnv { store: Store; scope: InvestigationScope; cancelled: () => boolean }

const cert = (e: ToolEnv, toolId: string, query: unknown, exhaustive: boolean, exclusions: string[]): CoverageCertificate => ({
  id: "cert:" + hash(toolId, query, e.scope.revision), sourceId: `revision:${e.scope.revision}`, revision: e.scope.revision, deploymentId: null, window: null,
  queryHash: hash(query), exhaustiveForPredicate: exhaustive, predicateSchemaId: TOOLS[toolId].schemaId, sampling: "NONE", exclusions,
  issuerAdapterId: `c22.broker.${toolId}`, adapterVersion: "1",
});
const usage: Usage = { tokens: 0, cost: 0, toolSteps: 1 };

/** Run one registered read tool against the pinned revision. Reads only; every result carries what it cannot see. */
export function invokeTool(toolId: string, req: RegisteredToolRequest, e: ToolEnv): ToolResult {
  validateRequest(toolId, req, e.scope);
  if (e.cancelled()) throw new C22Error("CANCELLED", "cancelled before the read started");
  const rev = e.scope.revision, p = req.payload;
  const base = { toolId, schemaId: req.schemaId, scopeHash: e.scope.scopeHash, revision: rev, usage, runtimeIds: [] as string[] };
  const must = (id: unknown) => { const x = e.store.entitiesById(rev, [String(id)])[0]; if (!x) throw new C22Error("INVALID_SCHEMA", `"${String(id)}" is not an entity of revision ${rev}; unknown ids are never guessed`); return x; };
  const depth = Math.min(Number(p.depth ?? p.maxDepth ?? 3) || 3, e.scope.maxGraphDepth);

  const access = policyFor(e.store, e.scope.repoRoot);
  const fogIn = (ids: string[]) => ids.reduce((n, id) => n + e.store.factsFor(rev, id).filter((f) => f.resolution === "UNRESOLVED" && f.predicate === "calls").length, 0);
  if (toolId === "graph.dependents") {
    const target = must(p.entityId);
    const proj = graphDependents(e.store, rev, target.entityId, { maxDepth: depth, maxNodes: e.scope.maxGraphNodes, access });
    const count = proj.nodes.length - 1, min = Number(p.minCount ?? 1), fog = fogIn(proj.nodes.map((x) => x.id));
    // Absence is only certifiable if nothing was cut: not by depth, not by the node budget, not by access policy, and no call hides.
    const cut = proj.truncated.byDepth || proj.truncated.byNodes || proj.omittedByAccess > 0;
    const exhaustive = !cut && fog === 0;
    const why = [...(proj.truncated.byDepth ? [`stopped at ${depth} hop(s)`] : []), ...(proj.truncated.byNodes ? ["graph node cap reached"] : []), ...(proj.omittedByAccess ? [`${proj.omittedByAccess} item(s) hidden by access policy`] : []), ...(fog ? [`${fog} unresolved call(s) in the explored region`] : [])];
    return { ...base, evidenceIds: [...new Set(proj.edges.flatMap((x) => x.evidenceIds))], outcome: count >= min ? "PRESENT" : exhaustive ? "ABSENT_WITH_COVERAGE" : "NOT_OBSERVED", summary: `${count} caller(s) within ${depth} hop(s) of ${target.name}${why.length ? `; ${why.join("; ")}` : ""}`, detail: { count, depth, hash: proj.hash, truncated: proj.truncated }, certificate: cert(e, toolId, p, exhaustive, why) };
  }
  if (toolId === "graph.paths") {
    const a = must(p.from), b = must(p.to);
    const r = findPath(e.store, rev, a.entityId, b.entityId, { maxDepth: depth, maxNodes: e.scope.maxGraphNodes, access });
    const fog = fogIn(r.found ? r.path : []);
    const cut = r.truncated.byDepth || r.truncated.byNodes || r.hiddenRouteExists;
    const exhaustive = !r.found && !cut && fog === 0;
    const why = [...(r.truncated.byDepth ? [`stopped at ${depth} hop(s)`] : []), ...(r.truncated.byNodes ? ["graph node cap reached"] : []), ...(r.hiddenRouteExists ? ["a route exists through entities hidden by access policy"] : [])];
    return { ...base, evidenceIds: r.edges.flatMap((x) => x.evidence.map((v) => v.id)), outcome: r.found ? "PRESENT" : exhaustive ? "ABSENT_WITH_COVERAGE" : "NOT_OBSERVED", summary: r.found ? `a call path of ${r.hops} hop(s) from ${a.name} to ${b.name}` : `no call path found within ${depth} hop(s)${why.length ? `; ${why.join("; ")}` : ""}`, detail: { path: r.path, depth, truncated: r.truncated }, certificate: cert(e, toolId, p, exhaustive, why) };
  }
  if (toolId === "source.entity") {
    const x = must(p.entityId); const pred = String(p.predicate);
    if (!["throws", "writes", "uses_transaction", "unresolved_calls"].includes(pred)) throw new C22Error("INVALID_SCHEMA", `predicate "${pred}" is not one of throws, writes, uses_transaction, unresolved_calls`);
    const facts = e.store.factsFor(rev, x.entityId).filter((f) => (pred === "unresolved_calls" ? f.resolution === "UNRESOLVED" && f.predicate === "calls" : f.predicate === pred));
    const parsedClean = !e.store.revision(rev)?.diagnostics.some((d) => d.code === "PARSE_ERRORS");
    return { ...base, evidenceIds: facts.flatMap((f) => f.evidence.map((v) => v.id)), outcome: facts.length ? "PRESENT" : parsedClean ? "ABSENT_WITH_COVERAGE" : "NOT_OBSERVED", summary: `${facts.length} ${pred} fact(s) on ${x.name}`, detail: { count: facts.length }, certificate: cert(e, toolId, p, parsedClean, parsedClean ? [] : ["the repository had parse errors"]) };
  }
  if (toolId === "retrieve.evidence") {
    const q = String(p.query).toLowerCase(); const limit = Math.min(Number(p.limit ?? 5) || 5, 20);
    const hits = e.store.entities(rev).filter((x) => x.kind !== "file" && x.name.toLowerCase().includes(q)).slice(0, limit);
    const ev = hits.flatMap((h) => e.store.relationshipsFor(rev, h.entityId).filter((r) => r.kind === "contains" && r.to === h.entityId).flatMap((r) => r.evidence.map((v) => v.id)));
    return { ...base, evidenceIds: ev, outcome: hits.length ? "PRESENT" : "NOT_OBSERVED", summary: `${hits.length} entity/entities matching "${String(p.query)}"`, detail: { hits: hits.map((h) => h.entityId) }, certificate: null };
  }
  // runtime.window: reported exceptions are samples of unknown completeness, so zero matches is never absence.
  const sig = String(p.signature).toLowerCase();
  const w = e.scope.incidentWindow;
  const rows = e.store.exceptions(false).filter((x) => `${x.errorClass} ${x.message} ${x.trace}`.toLowerCase().includes(sig) && (!w || (x.lastSeen >= w.start && x.firstSeen <= w.end)));
  return { ...base, evidenceIds: [], runtimeIds: rows.map((r) => r.id), outcome: rows.length ? "PRESENT" : "NOT_OBSERVED", summary: `${rows.length} reported exception(s) matching "${String(p.signature)}"${w ? " in the incident window" : ""}`, detail: { count: rows.length, reports: rows.reduce((n, r) => n + r.count, 0) }, certificate: null };
}
