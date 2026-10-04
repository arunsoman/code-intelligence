// C21: the interaction catalogue I-01…I-20 as typed commands. Every interaction is bound to a view revision and element ids,
// resolves to one typed command (the same whether it came from a mouse, a keyboard or text), writes the context the catalogue
// says it writes, and asks instead of guessing when the intent is ambiguous. Nothing here edits code.
import { randomUUID } from "node:crypto";
import type { ApiResult, CallContext, ViewSpec } from "@cie/schema";
import { ChangeEngine } from "./changes.ts";
import { applyContextEvent, currentSequence, sessionSnapshot, type ActionName, type ContextSnapshot } from "./context.ts";
import type { Service } from "./service.ts";

export type Via = "mouse" | "keyboard" | "text" | "ide" | "runtime";
interface Base { session: string; via?: Via; /** The view the person was looking at. Selection ids are only meaningful in this view. */ view?: ViewSpec; /** The revision/version the gesture was made against. */ viewRevision?: string; viewVersion?: number }
export type Interaction = Base & (
  | { id: "I-01"; text: string }
  | { id: "I-02"; text: string; onlyRelevantTo?: string }
  | { id: "I-03"; direction: "in" | "out" | "overview" }
  | { id: "I-04"; text: string; now?: string }
  | { id: "I-05"; nodeId: string }
  | { id: "I-06"; nodeId: string }
  | { id: "I-07"; nodeIds: string[]; question?: string }
  | { id: "I-08"; claimId: string; verdict: "CONFIRM" | "REFUTE" | "DISPUTE"; explanation: string; expectedVersion: number }
  | { id: "I-09"; limit?: number }
  | { id: "I-10"; nodeId?: string; name?: string; pin: boolean }
  | { id: "I-11"; groupId: string; collapse: boolean }
  | { id: "I-12"; fromNodeId: string; toNodeId: string }
  | { id: "I-13"; order: string[] }
  | { id: "I-14"; nodeIds: [string, string] }
  | { id: "I-15"; nodeIds: string[] }
  | { id: "I-16"; nodeId: string; note: string; scope: "private" | "team" }
  | { id: "I-17"; file: string; startLine: number; endLine?: number; sequence: number }
  | { id: "I-18"; file: string; sequence: number; fromRevision?: string; toRevision?: string }
  | { id: "I-19"; file: string; lines: number[]; sequence: number }
  | { id: "I-20"; trace: string; source?: string }
);

export interface Clarification { question: string; options: { id: string; label: string }[] }
export interface ResolvedInteraction {
  id: Interaction["id"]; outcome: "DONE" | "NEEDS_CLARIFICATION" | "REJECTED";
  /** The one typed command this gesture means, identical across mouse, keyboard and text. */
  command: string; direction: "text→visual" | "visual→text" | "visual→visual" | "code→visual" | "runtime→visual";
  result?: unknown; clarification?: Clarification; reason?: string; written: ActionName[]; context: ContextSnapshot;
}

const DIRECTION: Record<string, ResolvedInteraction["direction"]> = { "I-01": "text→visual", "I-02": "text→visual", "I-03": "text→visual", "I-04": "text→visual", "I-05": "visual→text", "I-06": "visual→text", "I-07": "visual→text", "I-08": "visual→text", "I-09": "visual→text", "I-10": "visual→visual", "I-11": "visual→visual", "I-12": "visual→visual", "I-13": "visual→visual", "I-14": "visual→visual", "I-15": "visual→visual", "I-16": "visual→visual", "I-17": "code→visual", "I-18": "code→visual", "I-19": "code→visual", "I-20": "runtime→visual" };
const DAY = 86_400_000;

/** "last week", "yesterday", "last 3 days", "before 2026-03-01", "since 2026-03-01": a window, or null when it is not a time directive. */
export function parseTimeDirective(text: string, nowIso: string): { from: string; to: string; label: string } | null {
  const now = Date.parse(nowIso), t = text.toLowerCase();
  const win = (from: number, to: number, label: string) => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), label });
  let m: RegExpExecArray | null;
  if (/\byesterday\b/.test(t)) return win(now - 2 * DAY, now - DAY, "yesterday");
  if (/\blast week\b/.test(t)) return win(now - 14 * DAY, now - 7 * DAY, "last week");
  if (/\blast month\b/.test(t)) return win(now - 60 * DAY, now - 30 * DAY, "last month");
  if ((m = /\blast (\d{1,3}) days?\b/.exec(t))) return win(now - Number(m[1]) * DAY, now, `last ${m[1]} days`);
  if ((m = /\b(?:before|until)\s+(\d{4}-\d{2}-\d{2})\b/.exec(t))) return win(0, Date.parse(m[1]), `before ${m[1]}`);
  if ((m = /\b(?:since|after)\s+(\d{4}-\d{2}-\d{2})\b/.exec(t))) return win(Date.parse(m[1]), now, `since ${m[1]}`);
  return null;
}

export class Interactions {
  declare readonly svc: Service;
  private changes: ChangeEngine;
  private intents = new Map<string, unknown[]>();
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); this.changes = new ChangeEngine(svc.store); }

  private write(session: string, e: { action: ActionName; ids?: string[]; value?: string | number }): ContextSnapshot {
    const r = applyContextEvent(this.svc.store, session, { event: { kind: "ACTION", ...e }, expectedSequence: currentSequence(this.svc.store, session) });
    if (!r.ok) throw new Error(r.error.message);
    return r.snapshot;
  }
  candidates(session: string) { return this.intents.get(session) ?? []; }

  async resolve(ctx: CallContext, it: Interaction): Promise<ApiResult<ResolvedInteraction>> {
    const written: ActionName[] = [];
    const done = (command: string, result: unknown, ...w: { action: ActionName; ids?: string[]; value?: string | number }[]): ApiResult<ResolvedInteraction> => {
      for (const e of w) { this.write(it.session, e); written.push(e.action); }
      return this.wrap(ctx, { id: it.id, outcome: "DONE", command, direction: DIRECTION[it.id], result, written, context: sessionSnapshot(this.svc.store, it.session) });
    };
    const refuse = (code: "VERSION_CONFLICT" | "NOT_FOUND" | "INVALID_SCHEMA", message: string): ApiResult<ResolvedInteraction> => this.err(ctx, code, message);
    const ask = (command: string, question: string, options: Clarification["options"]): ApiResult<ResolvedInteraction> =>
      this.wrap(ctx, { id: it.id, outcome: "NEEDS_CLARIFICATION", command, direction: DIRECTION[it.id], clarification: { question, options }, written, context: sessionSnapshot(this.svc.store, it.session) });

    // Selection refers to ids in one view revision: a gesture made against an older view is refused, not reinterpreted.
    const view = it.view;
    if (view && ((it.viewRevision && it.viewRevision !== view.revision) || (it.viewVersion !== undefined && it.viewVersion !== view.version)))
      return refuse("VERSION_CONFLICT", `that selection was made on view ${it.viewRevision ?? view.revision}@${it.viewVersion ?? view.version}, but the view is now ${view.revision}@${view.version}; select again`);
    const nodeOf = (id: string) => view?.nodes.find((n) => n.id === id);
    const missing = (ids: string[]) => ids.filter((id) => !nodeOf(id));
    const needsView = (ids: string[] = []) => (!view ? refuse("INVALID_SCHEMA", "there is no view on screen to act on") : missing(ids).length ? refuse("NOT_FOUND", `not in this view: ${missing(ids).join(", ")}`) : null);
    const entitiesOf = (ids: string[]) => ids.flatMap((id) => nodeOf(id)?.entityRefs ?? []);
    const revision = view?.revision ?? this.svc.store.latestRevision()?.id;

    switch (it.id) {
      case "I-01": {
        const r = await this.svc.ask(ctx, { question: it.text, revision: view?.revision });
        if (!r.ok) return r as ApiResult<never>;
        return done("ask", { view: r.value.view, claims: r.value.claims }, { action: "TASK", value: it.text }, { action: "RECENT", ids: r.value.view.nodes.slice(0, 5).flatMap((n) => n.entityRefs) });
      }
      case "I-02": {
        const bad = needsView(); if (bad) return bad;
        const kept = view!.nodes.filter((n) => n.tier === "CRITICAL" || n.tier === "RELEVANT").map((n) => n.id);
        const ghost = view!.nodes.filter((n) => n.tier !== "CRITICAL" && n.tier !== "RELEVANT").map((n) => n.id);
        return done("filter", { kept, ghost, explain: "ask why any ghosted element is hidden" }, { action: "FILTER", value: it.onlyRelevantTo ?? it.text });
      }
      case "I-03": {
        const bad = needsView(); if (bad) return bad;
        const cur = view!.level, lvl = it.direction === "overview" ? 1 : Math.max(0, Math.min(5, cur + (it.direction === "in" ? 1 : -1)));
        return done("zoom", { from: cur, to: lvl, identityPreserved: true }, { action: "ZOOM", value: lvl });
      }
      case "I-04": {
        const w = parseTimeDirective(it.text, it.now ?? new Date().toISOString());
        if (!w) return ask("time-window", `I could not read “${it.text}” as a time window. Try “last week”, “last 30 days” or “before 2026-03-01”.`, []);
        const rev = revision;
        const changed = rev ? this.svc.store.factsByPredicate(rev, "history").filter((f) => { const d = (f.object as any).value?.lastDate; return d && d >= w.from && d <= w.to; }).map((f) => ({ file: f.subject.replace(/^file:/, ""), lastDate: (f.object as any).value.lastDate as string, evidenceIds: f.evidence.map((e) => e.id) })).sort((a, b) => a.lastDate.localeCompare(b.lastDate)) : [];
        return done("time-window", { ...w, changed }, { action: "TIME", value: w.label });
      }
      case "I-05": {
        const bad = needsView([it.nodeId]); if (bad) return bad;
        const n = nodeOf(it.nodeId)!;
        const rels = this.svc.store.allRelationships(view!.revision).filter((r) => r.kind === "calls" && (n.entityRefs.includes(r.from) || n.entityRefs.includes(r.to)));
        const cards = this.svc.store.concepts(view!.revision).filter((c) => c.members.some((m) => n.entityRefs.includes(m)));
        return done("identity", { label: n.label, kind: n.kind, file: n.file, displayMode: n.displayMode, callers: rels.filter((r) => n.entityRefs.includes(r.to)).length, callees: rels.filter((r) => n.entityRefs.includes(r.from)).length, responsibilities: cards.map((c) => c.title), evidenceIds: n.evidenceIds }, { action: "RECENT", ids: n.entityRefs });
      }
      case "I-06": {
        const bad = needsView([it.nodeId]); if (bad) return bad;
        const r = this.svc.whyShown(ctx, { view: view!, nodeId: it.nodeId });
        if (!r.ok) return r as ApiResult<never>;
        return done("provenance", r.value, { action: "TRUST", ids: [it.nodeId] });
      }
      case "I-07": {
        const bad = needsView(it.nodeIds); if (bad) return bad;
        if (it.nodeIds.length < 2) return ask("relate", "A relation needs at least two elements. Select another one?", view!.nodes.slice(0, 6).map((n) => ({ id: n.id, label: n.label })));
        const r = await this.svc.explain(ctx, { revision: view!.revision, entityIds: entitiesOf(it.nodeIds), question: it.question ?? "why are these connected?" });
        if (!r.ok) return r as ApiResult<never>;
        return done("relate", r.value, { action: "REFERENT", ids: entitiesOf(it.nodeIds) });
      }
      case "I-08": {
        const r = this.svc.verdict(ctx, { claimId: it.claimId, verdict: it.verdict, explanation: it.explanation, expectedVersion: it.expectedVersion });
        if (!r.ok) return r as ApiResult<never>;
        const refreshed = view ? await this.svc.refreshView(ctx, { view }) : null;
        return done("verdict", { claim: (r.value as any).claim ?? r.value, view: refreshed?.ok ? refreshed.value.view : null }, { action: "TRUST", ids: [it.claimId] });
      }
      case "I-09": {
        const bad = needsView(); if (bad) return bad;
        const ghost = view!.nodes.filter((n) => n.tier === "CONTEXT" || n.tier === "HIDDEN");
        const items = [...ghost.map((n) => ({ entityId: n.entityRefs[0], label: n.label, reason: `ranked ${n.tier.toLowerCase()}`, factors: (n.factors ?? []).filter((f) => f.normalizedScore > 0).map((f) => ({ factor: f.factor, score: f.normalizedScore, reason: f.reason })) })), ...(view!.hidden ?? []).map((h) => ({ entityId: h.entityId, label: h.label, reason: h.reason, factors: [] as { factor: string; score: number; reason: string }[] }))].slice(0, it.limit ?? 20);
        return done("why-hidden", { items }, { action: "SALIENCE_FEEDBACK", ids: items.map((i) => i.entityId) });
      }
      case "I-10": {
        const bad = needsView(it.nodeId ? [it.nodeId] : []); if (bad) return bad;
        let entityId: string | undefined = it.nodeId ? nodeOf(it.nodeId)?.entityRefs[0] : undefined;
        if (!entityId && it.name) {
          const hits = this.svc.store.entities(view!.revision).filter((e) => e.kind !== "file" && e.name.toLowerCase() === it.name!.toLowerCase());
          if (hits.length > 1) return ask("pin", `“${it.name}” names ${hits.length} different elements. Which one?`, hits.map((h) => ({ id: h.entityId, label: `${h.name} (${h.file})` })));
          entityId = hits[0]?.entityId;
        }
        if (!entityId) return refuse("NOT_FOUND", "nothing to pin: name an element or select one");
        const r = this.svc.setOverride(ctx, { revision: view!.revision, entityId, mode: it.pin ? "pin" : null });
        if (!r.ok) return r as ApiResult<never>;
        return done(it.pin ? "pin" : "unpin", { entityId }, { action: "PIN", ids: [entityId], value: it.pin ? "pin" : "unpin" });
      }
      case "I-11": {
        const bad = needsView(); if (bad) return bad;
        const g = view!.groups.find((x) => x.id === it.groupId);
        if (!g) return refuse("NOT_FOUND", `no group ${it.groupId} in this view`);
        return done(it.collapse ? "collapse" : "expand", { groupId: g.id, members: g.childNodeIds.length, state: it.collapse ? "collapsed" : "expanded" }, { action: "ABSTRACTION", ids: [g.id], value: it.collapse ? "collapsed" : "expanded" });
      }
      case "I-12": {
        const bad = needsView([it.fromNodeId, it.toNodeId]); if (bad) return bad;
        const [from, to] = [nodeOf(it.fromNodeId)!.entityRefs[0], nodeOf(it.toNodeId)!.entityRefs[0]];
        const d = this.changes.interpretDrag(view!.revision, { from, to });
        this.remember(it.session, { id: "I-12", from, to, outcome: d.outcome });
        if (d.outcome === "NEEDS_CLARIFICATION") return ask("boundary-proposal", d.reason ?? "which did you mean?", d.options.map((o) => ({ id: o.id, label: o.label })));
        if (d.outcome === "REJECTED") return refuse("INVALID_SCHEMA", d.reason ?? "rejected");
        return done("boundary-proposal", { options: d.options, outline: "what-if", writesCode: false }, { action: "INTENT", ids: [from, to] });
      }
      case "I-13": {
        const bad = needsView(it.order); if (bad) return bad;
        const ents = entitiesOf(it.order);
        // The current order is the call order in the source; the proposal lists the steps whose position changed.
        const cur = [...ents].sort((a, b) => this.svc.store.entities(view!.revision).findIndex((e) => e.entityId === a) - this.svc.store.entities(view!.revision).findIndex((e) => e.entityId === b));
        const moved = ents.filter((e, i) => cur[i] !== e);
        this.remember(it.session, { id: "I-13", order: ents });
        return done("sequence-proposal", { moved, outline: ents, writesCode: false, note: "a sketch of the reorder; nothing is edited" }, { action: "INTENT", ids: ents });
      }
      case "I-14": {
        const bad = needsView(it.nodeIds); if (bad) return bad;
        const [a, b] = it.nodeIds.map((id) => nodeOf(id)!.entityRefs[0]);
        if (a === b) return refuse("INVALID_SCHEMA", "a node cannot be merged with itself");
        const rels = this.svc.store.allRelationships(view!.revision).filter((r) => r.kind === "calls");
        const callersOf = (x: string) => new Set(rels.filter((r) => r.to === x).map((r) => r.from));
        const ca = callersOf(a), cb = callersOf(b);
        const shared = [...ca].filter((x) => cb.has(x));
        const ev = this.svc.store.entities(view!.revision).filter((e) => e.entityId === a || e.entityId === b);
        this.remember(it.session, { id: "I-14", a, b });
        return done("consolidation-proposal", { keep: a, fold: b, redirectCallers: [...cb], sharedCallers: shared, evidence: ev.map((e) => ({ id: e.entityId, file: e.file })), steps: [`point the ${cb.size} caller(s) of ${b} at ${a}`, `delete ${b} once nothing calls it`], writesCode: false }, { action: "INTENT", ids: [a, b] });
      }
      case "I-15": {
        const bad = needsView(it.nodeIds); if (bad) return bad;
        const inside = new Set(entitiesOf(it.nodeIds));
        const rels = this.svc.store.allRelationships(view!.revision).filter((r) => r.kind === "calls");
        const entering = rels.filter((r) => !inside.has(r.from) && inside.has(r.to)), leaving = rels.filter((r) => inside.has(r.from) && !inside.has(r.to));
        const writes = this.svc.store.factsByPredicate(view!.revision, "writes").filter((f) => inside.has(f.subject));
        const sharedData = [...new Set(writes.map((f) => String((f.object as any).value ?? "")))].filter(Boolean);
        this.remember(it.session, { id: "I-15", members: [...inside] });
        return done("extraction-proposal", { interfaces: { entering: entering.map((r) => r.to), leaving: leaving.map((r) => r.to) }, sharedData, risks: [...(entering.length + leaving.length > 6 ? ["wide boundary: many crossing calls"] : []), ...(sharedData.length ? ["shared data would need an owner"] : [])], newInvestigation: true, writesCode: false }, { action: "INTENT", ids: [...inside] }, { action: "TASK", value: "extraction" });
      }
      case "I-16": {
        const bad = needsView([it.nodeId]); if (bad) return bad;
        if (!it.note.trim()) return refuse("INVALID_SCHEMA", "an annotation needs text");
        const rev = this.svc.store.revision(view!.revision)!;
        const id = randomUUID();
        this.svc.store.db.prepare("insert into annotations values (?,?,?,?,?,?,?)").run(id, rev.repoRoot, nodeOf(it.nodeId)!.entityRefs[0], it.note.trim().slice(0, 500), it.scope, ctx.actor.principalId, new Date().toISOString());
        return done("annotate", { id, entityId: nodeOf(it.nodeId)!.entityRefs[0], scope: it.scope, memory: it.scope === "team" ? "semantic" : "episodic" }, { action: "NOTE", ids: [nodeOf(it.nodeId)!.entityRefs[0]] });
      }
      case "I-17": {
        const r = this.svc.captureEditorEvent(ctx, { event: { sessionId: it.session, sequence: it.sequence, kind: "SELECTION", file: it.file, startLine: it.startLine, endLine: it.endLine } });
        if (!r.ok) return r as ApiResult<never>;
        if (!r.value.accepted) return refuse("VERSION_CONFLICT", "that editor event is older than one already applied");
        if (!r.value.entities.length) return ask("locate", "The selection is not inside a known function. Pick one?", []);
        const v = await this.svc.ask(ctx, { question: "explain and locate this in context", revision: this.svc.store.latestRevision()?.id, seeds: r.value.entities });
        return done("locate", { entities: r.value.entities, view: v.ok ? v.value.view : null }, { action: "RECENT", ids: r.value.entities });
      }
      case "I-18": {
        const r = this.svc.captureEditorEvent(ctx, { event: { sessionId: it.session, sequence: it.sequence, kind: "DIFF", file: it.file } });
        if (!r.ok) return r as ApiResult<never>;
        const revs = this.svc.store.allRevisionRoots();
        const offer = it.fromRevision && it.toRevision ? { form: "SemanticDiff", from: it.fromRevision, to: it.toRevision, available: true } : { form: "SemanticDiff", available: false, reason: revs.length < 2 ? "needs two indexed revisions" : "name the two revisions to compare" };
        return done("review", { taskFrame: "review", primaryView: offer }, { action: "TASK", value: "review" });
      }
      case "I-19": {
        const r = this.svc.captureEditorEvent(ctx, { event: { sessionId: it.session, sequence: it.sequence, kind: "BREAKPOINT", file: it.file, startLine: it.lines[0], endLine: it.lines.at(-1) } });
        if (!r.ok) return r as ApiResult<never>;
        if (!r.value.accepted) return refuse("VERSION_CONFLICT", "that editor event is older than one already applied");
        return done("execution-focus", { anchors: r.value.entities, overlay: "RuntimeOverlay", window: "pinned" }, { action: "RUNTIME", ids: r.value.entities, value: "pinned" });
      }
      case "I-20": {
        const rep = this.svc.reportException(ctx, { trace: it.trace, source: it.source ?? "alarm" });
        if (!rep.ok) return rep as ApiResult<never>;
        const inv = await this.svc.investigate(ctx, { trace: it.trace });
        if (!inv.ok) return inv as ApiResult<never>;
        const promoted = inv.value.view.nodes.filter((n) => n.tier === "CRITICAL").flatMap((n) => n.entityRefs);
        return done("incident", { view: inv.value.view, promoted, thread: "opened" }, { action: "INCIDENT", ids: promoted }, { action: "TASK", value: "incident" });
      }
    }
  }

  /**
   * "Why are they connected?" with nothing selected: "they" is whatever the last lasso pinned as the referent. With no referent,
   * or with words that point at nothing the person has chosen, it asks instead of guessing.
   */
  async followUp(ctx: CallContext, session: string, text: string, view: ViewSpec): Promise<ApiResult<ResolvedInteraction>> {
    const snap = sessionSnapshot(this.svc.store, session);
    const pronoun = /\b(they|them|these|those|the same ones|that group)\b/i.test(text);
    if (!pronoun) return this.resolve(ctx, { id: "I-01", session, text, view, via: "text" });
    if (snap.referent.length < 2) return this.wrap(ctx, { id: "I-07", outcome: "NEEDS_CLARIFICATION", command: "relate", direction: "visual→text", clarification: { question: "Which elements do you mean? Lasso them first.", options: view.nodes.slice(0, 6).map((n) => ({ id: n.id, label: n.label })) }, written: [], context: snap });
    const r = await this.svc.explain(ctx, { revision: view.revision, entityIds: snap.referent, question: text });
    if (!r.ok) return r as ApiResult<never>;
    return this.wrap(ctx, { id: "I-07", outcome: "DONE", command: "relate", direction: "visual→text", result: r.value, written: [], context: snap });
  }

  private remember(session: string, intent: unknown) { this.intents.set(session, [...(this.intents.get(session) ?? []), intent]); }
  private wrap(ctx: CallContext, v: ResolvedInteraction): ApiResult<ResolvedInteraction> {
    return { ok: true as const, value: v, metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings: [] } };
  }
  private err(ctx: CallContext, code: "VERSION_CONFLICT" | "NOT_FOUND" | "INVALID_SCHEMA", message: string): ApiResult<ResolvedInteraction> {
    return { ok: false as const, error: { code, message, retryable: false }, metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings: [] } };
  }
}
