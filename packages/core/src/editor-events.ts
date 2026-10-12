// C01/C24: IDE events, exception reports and the editor's recent-context readback.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ApiResult, CallContext, EditorContext, EditorEvent } from "@cie/schema";
import { entityAt, fingerprint, locateFrames, parseTrace } from "./trace.ts";
import { actor, fail, ok } from "./service.ts";
import type { Service } from "./service.ts";
import type { Store } from "./store.ts";

export class EditorEvents {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  /** C01: an IDE event. Only path + line numbers are accepted; they resolve to entity ids and nothing else is stored. */
  captureEditorEvent(ctx: CallContext, req: { event: EditorEvent }): ApiResult<{ accepted: boolean; stale?: boolean; entities: string[]; indexed: boolean }> {
    const e = req.event;
    const kinds = ["OPEN_FILE", "SELECTION", "DIFF", "BREAKPOINT"];
    if (!e || !kinds.includes(e.kind) || typeof e.file !== "string" || !isAbsolute(e.file) || !Number.isInteger(e.sequence) || !e.sessionId) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: "event needs sessionId, integer sequence, a known kind and an absolute file path", retryable: false });
    }
    // Stale or reordered events are dropped, never applied over newer ones.
    if (e.sequence <= this.store.lastClientSeq(e.sessionId)) return ok(ctx, { accepted: false, stale: true, entities: [], indexed: true });
    const root = e.file;
    const rev = this.store.allRevisionRoots().filter((r) => root === r.repoRoot || root.startsWith(r.repoRoot + "/")).sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
    if (!rev) { this.store.addContextEvent({ session: e.sessionId, clientSeq: e.sequence, kind: e.kind, revision: "", file: e.file, entities: [], lineStart: null, lineEnd: null }); return ok(ctx, { accepted: true, entities: [], indexed: false }); }
    const full = this.store.revision(rev.id)!;
    const rel = e.file.slice(full.repoRoot.length + 1);
    const lines = e.kind === "OPEN_FILE" ? [] : [e.startLine, e.endLine ?? e.startLine].filter((n): n is number => Number.isInteger(n) && n! > 0);
    const entities = [...new Set(lines.flatMap((l) => { const id = entityAt(this.store, full, rel, l); return id ? [id] : []; }))];
    this.store.addContextEvent({ session: e.sessionId, clientSeq: e.sequence, kind: e.kind, revision: full.id, file: rel, entities, lineStart: lines[0] ?? null, lineEnd: lines[1] ?? null });
    return ok(ctx, { accepted: true, entities, indexed: true }, { revision: full.id });
  }

  editorContext(ctx: CallContext, req: { revision?: string }): ApiResult<EditorContext> {
    const rev = req.revision ?? this.store.latestRevision()?.id;
    const events = this.store.recentContext(20).filter((e) => !rev || e.revision === rev || e.revision === "");
    const names = new Map(rev ? this.store.entities(rev).map((x) => [x.entityId, x.name]) : []);
    const focus: EditorContext["focus"] = [];
    for (const ev of events) if (ev.kind === "SELECTION" || ev.kind === "BREAKPOINT") for (const id of ev.entities) if (!focus.some((f) => f.entityId === id) && names.has(id)) focus.push({ entityId: id, label: names.get(id)! });
    return ok(ctx, { events: events.map(({ seq, kind, file, entities, lineStart, lineEnd, ts }) => ({ seq, kind: kind as EditorContext["events"][number]["kind"], file, entities, lineStart, lineEnd, ts })), focus: focus.slice(0, 6) });
  }

  /** C24: a running app (or you) reports an exception. Stored as an observation; grouped by fingerprint so a loop is one entry with a count. */
  reportException(ctx: CallContext, req: { trace?: string; error?: { name?: string; message?: string; stack?: string }; source?: string }): ApiResult<{ id: string; count: number; isNew: boolean; inRepo: boolean; errorClass: string | null }> {
    const fromError = (e: { name?: string; message?: string; stack?: string }) => {
      const head = `${e.name ?? "Error"}: ${e.message ?? ""}`.trimEnd();
      const stack = e.stack ?? "";
      // V8 stacks already begin with the heading; do not repeat it, but keep the message if the stack's own heading lost it.
      return stack.startsWith(e.name ?? "Error") ? (e.message === "" ? `${head}\n${stack.split("\n").slice(1).join("\n")}` : stack) : `${head}\n${stack}`;
    };
    const text = (req.trace ?? (req.error ? fromError(req.error) : "")).slice(0, 30_000);
    const parsed = parseTrace(text);
    if (parsed.frames.length === 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "no stack frames found in the report", retryable: false });
    const rev = this.store.latestRevision();
    const inRepo = !!rev && locateFrames(this.store, rev, parsed).some((f) => f.file);
    const r = this.store.addException({ id: `exc:${randomUUID()}`, fingerprint: fingerprint(parsed), errorClass: parsed.errorClass ?? "Error", message: parsed.message.slice(0, 300), trace: text, source: (req.source ?? "report").slice(0, 60) });
    this.store.audit(actor(ctx), "exception.report", r.id, { errorClass: parsed.errorClass, frames: parsed.frames.length, inRepo, source: req.source ?? "report" });
    return ok(ctx, { ...r, inRepo, errorClass: parsed.errorClass });
  }

  listExceptions(ctx: CallContext, req: { includeDismissed?: boolean }): ApiResult<ReturnType<Store["exceptions"]>> {
    return ok(ctx, this.store.exceptions(!!req.includeDismissed));
  }

  dismissException(ctx: CallContext, req: { id: string }): ApiResult<{ dismissed: boolean }> {
    const done = this.store.dismissException(req.id);
    if (done) this.store.audit(actor(ctx), "exception.dismiss", req.id);
    return done ? ok(ctx, { dismissed: true }) : fail(ctx, { code: "NOT_FOUND", message: "no such exception", retryable: false });
  }
}
