import type { CallContext, RevisionId, ViewSpec } from "../../schema/src/index.ts";
import type { BreadcrumbFrame, ReferentRecord } from "../../schema/src/intents.ts";
import type { Store } from "./store.ts";

export interface ChatSession {
  sessionId: string;
  actorPrincipal: string;
  tenantId: string;
  state: "open" | "archived";
  seq: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface ActiveChartContext {
  id: string;
  state: "active" | "closed";
  openedAtSeq: number;
  closedReason?: "topic" | "revision-invalidated";
  repoRoot: string;
  revision: RevisionId;
  subject?: string;
  chartCode?: string;
  level: 0 | 1 | 2 | 3 | 4 | 5;
  referents: ReferentRecord[];
  breadcrumb: BreadcrumbFrame[];
  recentIntents: { intentId: number; label: string; target: string; chartCode?: string }[];
}

export interface ChatTurn {
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  state: "pending" | "complete" | "failed";
  attempt: number;
  intentId?: number;
  chartCode?: string;
  viewId?: string;
  at: string;
}

export interface ModelContext {
  turns: { role: "user" | "assistant"; text: string }[];
  chart: {
    repoRoot: string;
    revision: string;
    subject?: string;
    chartCode?: string;
    level: number;
    referents: ReferentRecord[];
    breadcrumb: BreadcrumbFrame[];
  };
}

type SessionState = { session: ChatSession; context: ActiveChartContext; turns: ChatTurn[] };

export class ChatSessionManager {
  private sessions = new Map<string, SessionState>();

  private store: Store;
  constructor(store: Store) { this.store = store; }

  getSession(ctx: CallContext, requestedSessionId?: string, revision?: RevisionId) {
    const principalId = ctx.actor.principalId;
    const tenantId = ctx.actor.tenantId;
    const sessionId = requestedSessionId?.trim().slice(0, 120) || ctx.actor.sessionId || crypto.randomUUID();
    const key = `${tenantId}\u0000${principalId}\u0000${sessionId}`;
    let state = this.sessions.get(key);
    if (!state) {
      const row = this.store.db.prepare(`select state, seq, created_at, last_active_at, context_json, turns_json
        from chat_sessions where session_id = ? and actor_principal = ? and tenant_id = ?`).get(sessionId, principalId, tenantId) as {
          state: ChatSession["state"]; seq: number; created_at: string; last_active_at: string; context_json: string; turns_json: string;
        } | undefined;
      if (row) {
        try {
          state = {
            session: { sessionId, actorPrincipal: principalId, tenantId, state: row.state, seq: row.seq, createdAt: row.created_at, lastActiveAt: row.last_active_at },
            context: JSON.parse(row.context_json) as ActiveChartContext,
            turns: JSON.parse(row.turns_json) as ChatTurn[],
          };
        } catch { state = undefined; }
      }
    }
    if (!state) {
      const session: ChatSession = {
        sessionId,
        actorPrincipal: principalId,
        tenantId: ctx.actor.tenantId,
        state: "open",
        seq: 0,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };
      const context: ActiveChartContext = {
        id: crypto.randomUUID(),
        state: "active",
        openedAtSeq: 0,
        repoRoot: revision ? this.store.revision(revision)?.repoRoot ?? "" : "",
        revision: revision ?? this.store.latestRevision()?.id ?? "latest",
        level: 1,
        referents: [],
        breadcrumb: [],
        recentIntents: [],
      };
      state = { session, context, turns: [] };
    }
    if (revision && revision !== state.context.revision) {
      const row = this.store.revision(revision);
      state.context = {
        id: crypto.randomUUID(), state: "active", openedAtSeq: state.session.seq,
        repoRoot: row?.repoRoot ?? "", revision, level: 0, referents: [], breadcrumb: [], recentIntents: [],
      };
    }
    state.session.lastActiveAt = new Date().toISOString();
    this.sessions.set(key, state);
    const persist = () => {
      this.store.db.prepare(`insert into chat_sessions(session_id, actor_principal, tenant_id, state, seq, created_at, last_active_at, context_json, turns_json)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(session_id, actor_principal, tenant_id) do update set state=excluded.state, seq=excluded.seq,
          last_active_at=excluded.last_active_at, context_json=excluded.context_json, turns_json=excluded.turns_json`)
        .run(sessionId, principalId, tenantId, state!.session.state, state!.session.seq, state!.session.createdAt, state!.session.lastActiveAt, JSON.stringify(state!.context), JSON.stringify(state!.turns));
    };
    persist();
    return {
      get session() { return state!.session; },
      get context() { return state!.context; },
      get turns() { return state!.turns; },
      get referentLedger() { return state!.context.referents; },
      appendTurn: (role: ChatTurn["role"], text: string, chartCode?: string) => {
        const turn: ChatTurn = { sessionId, seq: ++state!.session.seq, role, text, state: "complete", attempt: 1, ...(chartCode ? { chartCode } : {}), at: new Date().toISOString() };
        state!.turns.push(turn);
        state!.session.lastActiveAt = turn.at;
        persist();
        return turn;
      },
      updateFocus: (referent: ReferentRecord) => {
        state!.context.referents = [
          ...state!.context.referents.filter((r) => r.entityId !== referent.entityId),
          { ...referent, source: "focus" as const },
        ].slice(-12);
        persist();
      },
      updateView: (view: ViewSpec, subject?: string, intentId?: number) => {
        const ctxState = state!.context;
        ctxState.repoRoot = this.store.revision(view.revision)?.repoRoot ?? ctxState.repoRoot;
        ctxState.revision = view.revision;
        ctxState.subject = subject ?? ctxState.subject;
        ctxState.chartCode = typeof view.params?.chartId === "string" ? view.params.chartId : ctxState.chartCode;
        ctxState.level = Math.min(5, Math.max(0, view.level)) as ActiveChartContext["level"];
        for (const node of view.nodes) for (const entityId of node.entityRefs) {
          const record: ReferentRecord = { entityId, label: node.label, kind: node.kind, level: ctxState.level, turnSeq: state!.session.seq, rev: view.revision, source: "view-render" };
          ctxState.referents = [...ctxState.referents.filter((r) => r.entityId !== entityId), record].slice(-12);
        }
        if (intentId !== undefined) {
          const label = subject ?? view.question;
          ctxState.recentIntents = [...ctxState.recentIntents, { intentId, label, target: subject ?? "", ...(ctxState.chartCode ? { chartCode: ctxState.chartCode } : {}) }].slice(-8);
        }
        persist();
      },
      setSubject: (subject: string | undefined) => {
        if (subject) state!.context.subject = subject;
        persist();
      },
      transitionContext: (resolvedSubject: string | undefined, intentId: number) => {
        const current = state!.context;
        const continuityIntent = [31, 32, 33, 34].includes(intentId);
        const known = resolvedSubject && (current.subject?.toLocaleLowerCase() === resolvedSubject.toLocaleLowerCase() || current.referents.some((r) => r.label.toLocaleLowerCase() === resolvedSubject.toLocaleLowerCase()));
        if (resolvedSubject && current.subject && !known && !continuityIntent) {
          current.state = "closed";
          current.closedReason = "topic";
          state!.context = {
            id: crypto.randomUUID(), state: "active", openedAtSeq: state!.session.seq,
            repoRoot: current.repoRoot, revision: current.revision, subject: resolvedSubject,
            level: 0, referents: [], breadcrumb: [], recentIntents: [],
          };
        }
        persist();
      },
      zoom: (direction: "in" | "out" | "overview", view?: ViewSpec): { message: string; breadcrumbs: BreadcrumbFrame[] } => {
        if (direction === "overview") {
          state!.context.breadcrumb = [];
          state!.context.level = 0;
        } else if (direction === "out") {
          const frame = state!.context.breadcrumb.pop();
          if (frame) {
            state!.context.level = frame.referent.level;
            state!.context.subject = frame.referent.label;
            state!.context.chartCode = frame.chartCode;
          } else state!.context.level = Math.max(0, state!.context.level - 1) as ActiveChartContext["level"];
        } else {
          const referent = state!.context.referents.find((r) => r.source === "focus") ?? state!.context.referents.at(-1);
          if (view && referent) state!.context.breadcrumb.push({
            referent, intentId: state!.context.recentIntents.at(-1)?.intentId ?? 31,
            chartCode: state!.context.chartCode ?? view.formId, question: view.question, viewId: view.id,
          });
          state!.context.level = Math.min(5, state!.context.level + 1) as ActiveChartContext["level"];
        }
        persist();
        return {
          message: direction === "overview" ? "Returning to the project overview." : direction === "out" ? "Zooming out for broader context." : "Zooming in for more detail.",
          breadcrumbs: [...state!.context.breadcrumb],
        };
      },
    };
  }

  async openSession(ctx: CallContext, revision?: RevisionId): Promise<{ sessionId: string; seq: number; revision: RevisionId }> {
    const selectedRevision: RevisionId = revision ?? this.store.latestRevision()?.id ?? "latest";
    const session = this.getSession(ctx, crypto.randomUUID(), selectedRevision);
    return { sessionId: session.session.sessionId, seq: session.session.seq, revision: session.context.revision };
  }

  async buildModelContext(sessionId: string, activeContext: ActiveChartContext, recentTurns: ChatTurn[]): Promise<ModelContext> {
    return {
      turns: recentTurns.slice(-6).map(t => ({ role: t.role, text: t.text })),
      chart: {
        repoRoot: activeContext.repoRoot,
        revision: activeContext.revision,
        subject: activeContext.subject,
        chartCode: activeContext.chartCode,
        level: activeContext.level,
        referents: activeContext.referents,
        breadcrumb: activeContext.breadcrumb,
      }
    };
  }

}
