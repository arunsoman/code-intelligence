// C28 visual intent and change proposals. A gesture on the map becomes a typed intent; an intent that means more than one thing is
// never guessed at; an intent becomes a proposal made of exact text edits against exact file contents; the proposal is checked
// in an isolated copy (does it still compile, do the tests still pass); people approve it; and what leaves is a patch.
//
// The invariant that matters: nothing here ever writes to the repository. A proposal is data. The only outputs are a patch
// someone else applies, and records. There is no apply operation to call.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import ts from "typescript";
import type { Entity, Relationship } from "@cie/schema";
import { policyFor } from "./access.ts";
import { absOffset, loadFunctions } from "./defect/functions.ts";
import type { RevisionRow, Store } from "./store.ts";

export type Intent =
  | { type: "RENAME"; entityId: string; newName: string }
  | { type: "DELETE_UNUSED"; entityId: string }
  | { type: "ADD_CALL"; from: string; to: string; position: "START" | "END" }
  | { type: "DELETE_CALL"; from: string; to: string; site: number }
  | { type: "REPLACE_SPAN"; file: string; start: number; end: number; expected: string; newText: string };
export interface TextEdit { file: string; baseHash: string; start: number; end: number; expected: string; newText: string; why: string }
export type Status = "DRAFT" | "FAILED" | "REVIEWABLE" | "REVIEWABLE_WITH_LIMITS" | "APPROVED" | "REJECTED" | "EXPORTED" | "STALE";
export interface Validation { at: string; compile: { baseline: number; introduced: string[]; resolved: number }; tests: { ran: boolean; passed: number; failed: number; output: string; reason?: string }; state: "PASSED" | "PASSED_COMPILE_ONLY" | "FAILED"; reasons: string[] }
export interface Approval { by: string; at: string; explanation: string; version: number }
export interface HistoryEntry { at: string; actor: string; event: string; detail: string }
export interface ChangeProposal {
  id: string; revision: string; repoRoot: string; version: number; author: string; intent: Intent; edits: TextEdit[]; createdAt: string; status: Status;
  validation: Validation | null; approvals: Approval[]; conflicts: string[]; limits: string[]; history: HistoryEntry[]; patchHash: string | null;
}
export class ChangeError extends Error {
  readonly code: "INVALID_SCHEMA" | "NOT_FOUND" | "STALE_REVISION" | "VERSION_CONFLICT" | "FORBIDDEN" | "INSUFFICIENT_EVIDENCE" | "NEEDS_CLARIFICATION";
  readonly options?: DragOption[];
  constructor(code: ChangeError["code"], message: string, options?: DragOption[]) { super(message); this.code = code; this.options = options; }
}
export interface DragOption { id: string; intent: Intent; label: string; because: string }
export interface DragResult { outcome: "READY" | "NEEDS_CLARIFICATION" | "REJECTED"; options: DragOption[]; reason?: string }

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await async of".split(" "));

export class ChangeEngine {
  private store: Store;
  /** When true, a different person must approve than the one who proposed. */
  requireSecondApprover = true;
  /** Checkouts whose tests an operator allows to be run (reviewed code). Without trust only the compile check runs. */
  readonly trustedRoots = new Set<string>();
  constructor(store: Store) { this.store = store; }
  trust(root: string) { this.trustedRoots.add(realpathSync(root)); }

  // ------------------------------------------------------------------ persistence
  private row(id: string): { json: string } | undefined { return this.store.db.prepare("select json from change_proposals where id = ?").get(id) as any; }
  get(id: string): ChangeProposal { const r = this.row(id); if (!r) throw new ChangeError("NOT_FOUND", "no such proposal"); const p = JSON.parse(r.json) as ChangeProposal; if (!this.store.revision(p.revision)) throw new ChangeError("NOT_FOUND", "the source of this proposal is not accessible"); return p; }
  list(revision?: string): ChangeProposal[] { return (this.store.db.prepare("select json from change_proposals order by rowid desc").all() as { json: string }[]).map((r) => JSON.parse(r.json) as ChangeProposal).filter((p) => (!revision || p.revision === revision) && !!this.store.revision(p.revision)); }
  private save(p: ChangeProposal, event?: HistoryEntry) {
    if (event) { p.history.push(event); this.store.audit(event.actor, `change.${event.event}`, p.id, { version: p.version, status: p.status, detail: event.detail.slice(0, 200) }); }
    this.store.db.prepare("insert into change_proposals(id, revision, status, version, json) values (?,?,?,?,?) on conflict(id) do update set status=excluded.status, version=excluded.version, json=excluded.json").run(p.id, p.revision, p.status, p.version, JSON.stringify(p));
  }
  private at(actor: string, event: string, detail: string): HistoryEntry { return { at: new Date().toISOString(), actor, event, detail }; }

  // ------------------------------------------------------------------ reading code for edits
  private rev(id: string): RevisionRow { const r = this.store.revision(id); if (!r) throw new ChangeError("NOT_FOUND", "unknown or inaccessible revision"); return r; }
  private file(rev: RevisionRow, rel: string): Buffer {
    const path = resolve(rev.repoRoot, rel);
    if (relative(rev.repoRoot, path).startsWith("..") || policyFor(this.store, rev.repoRoot).denied(rel)) throw new ChangeError("FORBIDDEN", "that file is not available");
    return readFileSync(path);
  }
  private entity(rev: RevisionRow, id: string): Entity {
    const e = this.store.entitiesById(rev.id, [id])[0];
    if (!e || e.kind === "file" || e.kind === "test") throw new ChangeError("INVALID_SCHEMA", `"${id}" is not a function or class of this revision`);
    if (policyFor(this.store, rev.repoRoot).denied(e.file)) throw new ChangeError("FORBIDDEN", "that code is not available to you");
    return e;
  }
  private spanText(rev: RevisionRow, ev: { location: { kind: string; span?: any } }) {
    const sp = ev.location.kind === "CodeLocation" ? ev.location.span : null;
    if (!sp) return null;
    const buf = this.file(rev, sp.sourceId);
    return { file: sp.sourceId as string, start: sp.startByte as number, end: sp.endByteExclusive as number, text: buf.subarray(sp.startByte, sp.endByteExclusive).toString("utf8"), buf };
  }
  private edit(rev: RevisionRow, file: string, start: number, end: number, newText: string, why: string): TextEdit {
    const buf = this.file(rev, file);
    return { file, baseHash: sha(buf), start, end, expected: buf.subarray(start, end).toString("utf8"), newText, why };
  }
  /** Byte offset of `token` (as a whole word) inside text that begins at byte offset `base`. */
  private wordAt(text: string, token: string, base: number): { start: number; end: number } | null {
    const m = new RegExp(`(?<![\\w$])${token.replace(/\$/g, "\\$")}(?![\\w$])`).exec(text);
    if (!m) return null;
    const start = base + Buffer.byteLength(text.slice(0, m.index), "utf8");
    return { start, end: start + Buffer.byteLength(token, "utf8") };
  }

  // ------------------------------------------------------------------ drag: what could this gesture mean?
  /**
   * A drag from one element to another. If there is exactly one executable meaning it is ready; if there are several it asks, with
   * the options laid out; if there is none it says why. It never picks one for the person.
   */
  interpretDrag(revision: string, g: { from: string; to: string }): DragResult {
    const rev = this.rev(revision);
    const from = this.entity(rev, g.from), to = this.entity(rev, g.to);
    if (from.entityId === to.entityId) return { outcome: "REJECTED", options: [], reason: "dropped on itself: there is nothing to relate" };
    // One relationship can carry several call sites; each site is a separate thing the gesture could mean.
    const sites = this.callSites(rev, from.entityId, to.entityId);
    const calls = sites;
    const options: DragOption[] = [];
    if (calls.length) {
      sites.forEach((s, i) => options.push({ id: `delete-call-${i}`, intent: { type: "DELETE_CALL", from: from.entityId, to: to.entityId, site: i }, label: `Stop ${from.name} calling ${to.name} (call ${i + 1} of ${calls.length}, line ${s.buf.subarray(0, s.start).toString("utf8").split("\n").length})`, because: "There is already a call along this edge; dragging along it can mean removing it." }));
    } else {
      options.push({ id: "add-call-start", intent: { type: "ADD_CALL", from: from.entityId, to: to.entityId, position: "START" }, label: `Make ${from.name} call ${to.name} first thing`, because: "There is no call yet, so this can mean adding one; the start of the body is one place it could go." });
      options.push({ id: "add-call-end", intent: { type: "ADD_CALL", from: from.entityId, to: to.entityId, position: "END" }, label: `Make ${from.name} call ${to.name} at the end`, because: "The end of the body is the other place it could go." });
    }
    if (options.length === 1) return { outcome: "READY", options };
    return { outcome: "NEEDS_CLARIFICATION", options, reason: calls.length ? `${calls.length} calls run along this edge; which one do you mean?` : `A new call from ${from.name} to ${to.name} could go in more than one place; where do you want it?` };
  }
  private lineOf(rev: RevisionRow, r: Relationship): number {
    const s = r.evidence[0] && this.spanText(rev, r.evidence[0] as any); if (!s) return 0;
    return s.buf.subarray(0, s.start).toString("utf8").split("\n").length;
  }

  // ------------------------------------------------------------------ proposing
  propose(actor: string, req: { revision: string; intent: Intent }): ChangeProposal {
    const rev = this.rev(req.revision);
    const intent = req.intent;
    if (!intent || typeof intent !== "object") throw new ChangeError("INVALID_SCHEMA", "an intent is required");
    const limits: string[] = []; const edits: TextEdit[] = [];
    switch (intent.type) {
      case "RENAME": this.renameEdits(rev, intent, edits, limits); break;
      case "DELETE_UNUSED": this.deleteUnusedEdits(rev, intent, edits, limits); break;
      case "ADD_CALL": this.addCallEdits(rev, intent, edits, limits); break;
      case "DELETE_CALL": this.deleteCallEdits(rev, intent, edits, limits); break;
      case "REPLACE_SPAN": {
        if (!Number.isInteger(intent.start) || !Number.isInteger(intent.end) || intent.start < 0 || intent.end < intent.start) throw new ChangeError("INVALID_SCHEMA", "the span is not valid");
        const e = this.edit(rev, intent.file, intent.start, intent.end, intent.newText, "edit requested directly");
        if (e.expected !== intent.expected) throw new ChangeError("STALE_REVISION", "the text at that span is not what the proposal expected: the file has changed");
        edits.push(e); break;
      }
      default: throw new ChangeError("INVALID_SCHEMA", `unknown intent "${String((intent as { type?: unknown }).type)}"`);
    }
    if (!edits.length) throw new ChangeError("INVALID_SCHEMA", "that intent produces no edits");
    this.assertNoOverlap(edits);
    const conflicts = this.list(rev.id).filter((o) => ["DRAFT", "REVIEWABLE", "REVIEWABLE_WITH_LIMITS", "APPROVED"].includes(o.status) && this.overlaps(edits, o.edits)).map((o) => o.id);
    const p: ChangeProposal = { id: "chg:" + randomUUID(), revision: rev.id, repoRoot: rev.repoRoot, version: 1, author: actor, intent, edits, createdAt: new Date().toISOString(), status: "DRAFT", validation: null, approvals: [], conflicts, limits, history: [], patchHash: null };
    this.save(p, this.at(actor, "propose", `${intent.type}: ${edits.length} edit(s) in ${new Set(edits.map((e) => e.file)).size} file(s)${conflicts.length ? `; overlaps ${conflicts.length} other proposal(s)` : ""}`));
    return p;
  }

  private renameEdits(rev: RevisionRow, i: Extract<Intent, { type: "RENAME" }>, out: TextEdit[], limits: string[]) {
    const e = this.entity(rev, i.entityId); const old = e.name.split(".").pop()!;
    if (!IDENT.test(i.newName) || RESERVED.has(i.newName)) throw new ChangeError("INVALID_SCHEMA", `"${i.newName}" is not a valid name`);
    if (i.newName === old) throw new ChangeError("INVALID_SCHEMA", "the new name is the same as the old one");
    if (this.store.entities(rev.id).some((x) => x.file === e.file && x.name.split(".").pop() === i.newName && x.kind !== "file")) throw new ChangeError("VERSION_CONFLICT", `"${i.newName}" is already declared in ${e.file}`);
    const span = e.spans[0]; const buf = this.file(rev, e.file); const text = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    const def = new RegExp(`(?:\\b(?:function|class)\\s+|^\\s*(?:async\\s+|static\\s+)*)${old.replace(/\$/g, "\\$")}(?![\\w$])`, "m").exec(text);
    const w = def ? this.wordAt(def[0], old, span.startByte + Buffer.byteLength(text.slice(0, def.index), "utf8")) : null;
    if (!w) throw new ChangeError("INVALID_SCHEMA", `the declaration of ${old} could not be located`);
    out.push(this.edit(rev, e.file, w.start, w.end, i.newName, `declaration of ${old}`));
    const rels = this.store.allRelationships(rev.id);
    for (const caller of [...new Set(rels.filter((x) => x.kind === "calls" && x.to === e.entityId).map((x) => x.from))]) {
      const sites = /^function:|^method:/.test(caller) ? this.callSites(rev, caller, e.entityId) : rels.filter((x) => x.kind === "calls" && x.from === caller && x.to === e.entityId).flatMap((x) => x.evidence.map((ev) => this.spanText(rev, ev as any)).filter((y): y is NonNullable<typeof y> => !!y));
      for (const s of sites) { const at = this.wordAt(s.text, old, s.start); if (at) out.push(this.edit(rev, s.file, at.start, at.end, i.newName, `call from ${caller.replace(/^[a-z]+:/, "").replace(/^.*#/, "")}`)); }
    }
    for (const r of rels.filter((x) => x.kind === "imports" && x.to === `file:${e.file}`)) for (const ev of r.evidence) {
      const s = this.spanText(rev, ev as any); if (!s || !new RegExp(`\\{[^}]*(?<![\\w$])${old}(?![\\w$])[^}]*\\}`).test(s.text)) continue;
      const brace = s.text.indexOf("{"); const at = this.wordAt(s.text.slice(brace), old, s.start + Buffer.byteLength(s.text.slice(0, brace), "utf8"));
      if (at) out.push(this.edit(rev, s.file, at.start, at.end, i.newName, `import of ${old}`));
    }
    const exp = new RegExp(`export\\s*\\{[^}]*(?<![\\w$])${old}(?![\\w$])[^}]*\\}`).exec(buf.toString("utf8"));
    if (exp) { const at = this.wordAt(exp[0], old, Buffer.byteLength(buf.toString("utf8").slice(0, exp.index), "utf8")); if (at) out.push(this.edit(rev, e.file, at.start, at.end, i.newName, `re-export of ${old}`)); }
    // Dedupe identical ranges (a call can also appear as imports evidence).
    const seen = new Set<string>(); for (let k = out.length - 1; k >= 0; k--) { const key = `${out[k].file}:${out[k].start}:${out[k].end}`; if (seen.has(key)) out.splice(k, 1); else seen.add(key); }
    limits.push("Only references the index resolved are changed. Calls through values, dynamic property access, string names, other packages and generated code are not found; the compile and test checks are what catch them.");
  }

  private deleteUnusedEdits(rev: RevisionRow, i: Extract<Intent, { type: "DELETE_UNUSED" }>, out: TextEdit[], limits: string[]) {
    const e = this.entity(rev, i.entityId);
    const users = this.store.allRelationships(rev.id).filter((r) => r.to === e.entityId && r.kind !== "contains");
    if (users.length) throw new ChangeError("VERSION_CONFLICT", `${e.name} is still used by ${[...new Set(users.map((r) => r.from.replace(/^[a-z]+:/, "").replace(/^.*#/, "")))].slice(0, 4).join(", ")}; it is not unused`);
    const span = e.spans[0]; const buf = this.file(rev, e.file);
    let start = span.startByte, end = span.endByteExclusive;
    const before = buf.subarray(Math.max(0, start - 40), start).toString("utf8"); const pre = /(export\s+(?:default\s+)?(?:async\s+)?)$/.exec(before);
    if (pre) start -= Buffer.byteLength(pre[1], "utf8");
    while (buf[end] === 0x0a || buf[end] === 0x0d) end++;
    out.push(this.edit(rev, e.file, start, end, "", `remove ${e.name}`));
    limits.push("No resolved caller or import was found. Something the index cannot see (a dynamic call, another repository, a script) may still use it.");
  }

  /**
   * Every place `from` calls `to`. The index keeps one piece of evidence per caller/callee pair, so a caller that calls the same function
   * twice would show only once; the caller's own source is read for the rest. A call counts only if the index resolved from → to.
   */
  private callSites(rev: RevisionRow, from: string, to: string) {
    const rels = this.store.allRelationships(rev.id).filter((r) => r.kind === "calls" && r.from === from && r.to === to);
    if (!rels.length) return [];
    const toName = (this.store.entitiesById(rev.id, [to])[0]?.name ?? "").split(".").pop()!;
    const fn = loadFunctions(this.store, rev, new Set([from])).get(from);
    if (fn) {
      const buf = this.file(rev, fn.file);
      const found = fn.scan.calls.filter((c) => c.name === toName).map((c) => { const start = absOffset(fn, c.at); return { file: fn.file, start, end: start + Buffer.byteLength(c.text, "utf8"), text: c.text, buf }; });
      if (found.length) return found;
    }
    return rels.flatMap((r) => r.evidence.map((e) => this.spanText(rev, e as any)).filter((x): x is NonNullable<typeof x> => !!x));
  }
  private deleteCallEdits(rev: RevisionRow, i: Extract<Intent, { type: "DELETE_CALL" }>, out: TextEdit[], limits: string[]) {
    this.entity(rev, i.from); this.entity(rev, i.to);
    const sites = this.callSites(rev, i.from, i.to); const s = sites[i.site];
    if (!s) throw new ChangeError("INVALID_SCHEMA", "there is no such call");
    const text = s.buf.toString("utf8"); const startChar = Buffer.from(text).subarray(0, s.start).toString("utf8").length;
    const lineStart = text.lastIndexOf("\n", startChar - 1) + 1, semi = text.indexOf(";", startChar + s.text.length), lineEnd = text.indexOf("\n", startChar);
    const stmt = text.slice(lineStart, semi >= 0 ? semi + 1 : lineEnd);
    if (!/^\s*(?:await\s+)?[\w$.]+\([\s\S]*\)\s*;?\s*$/.test(stmt) || stmt.includes("=") && !/==/.test(stmt) && /^\s*(?:const|let|var)\b/.test(stmt) || /\breturn\b/.test(stmt)) throw new ChangeError("INVALID_SCHEMA", "that call is part of a larger expression (its result is used); removing the statement would change the code's meaning, so this is not proposed");
    const b = Buffer.byteLength(text.slice(0, lineStart), "utf8"), e2 = Buffer.byteLength(text.slice(0, (semi >= 0 ? semi + 1 : lineEnd) + (text[(semi >= 0 ? semi + 1 : lineEnd)] === "\n" ? 1 : 0)), "utf8");
    out.push(this.edit(rev, s.file, b, e2, "", "remove the call statement"));
    limits.push("Whatever the call did no longer happens. If it was there for its side effects, the tests and a person need to say that is intended.");
  }
  private addCallEdits(rev: RevisionRow, i: Extract<Intent, { type: "ADD_CALL" }>, out: TextEdit[], limits: string[]) {
    const from = this.entity(rev, i.from), to = this.entity(rev, i.to);
    if (this.callSites(rev, i.from, i.to).length) throw new ChangeError("VERSION_CONFLICT", `${from.name} already calls ${to.name}`);
    const span = from.spans[0]; const buf = this.file(rev, from.file); const text = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    const open = text.indexOf("{"), close = text.lastIndexOf("}"); if (open < 0 || close < 0) throw new ChangeError("INVALID_SCHEMA", `${from.name} has no body to put a call in`);
    const name = to.name.split(".").pop()!;
    const at = i.position === "START" ? open + 1 : close;
    const abs = span.startByte + Buffer.byteLength(text.slice(0, at), "utf8");
    out.push(this.edit(rev, from.file, abs, abs, `${i.position === "START" ? "\n  " : "  "}${name}();${i.position === "START" ? "" : "\n"}`, `call ${name}`));
    // The import, when the callee lives in another file and is not imported there yet.
    if (to.file !== from.file) {
      const imported = this.store.allRelationships(rev.id).some((r) => r.kind === "imports" && r.from === `file:${from.file}` && r.to === `file:${to.file}`);
      if (!imported) { let rel = relative(dirname(from.file), to.file).replace(/\\/g, "/"); if (!rel.startsWith(".")) rel = "./" + rel; out.push(this.edit(rev, from.file, 0, 0, `import { ${name} } from "${rel}";\n`, `import ${name}`)); }
    }
    limits.push(`The call is inserted as ${name}() with no arguments. If ${name} takes parameters, the compile check will say so, and arguments must be chosen by a person.`);
  }

  private overlaps(a: TextEdit[], b: TextEdit[]): boolean { return a.some((x) => b.some((y) => x.file === y.file && x.start < y.end && y.start < x.end || (x.file === y.file && x.start === y.start && x.end === y.end))); }
  private assertNoOverlap(edits: TextEdit[]) {
    const sorted = [...edits].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end);
    for (let k = 1; k < sorted.length; k++) if (sorted[k].file === sorted[k - 1].file && sorted[k].start < sorted[k - 1].end) throw new ChangeError("VERSION_CONFLICT", `two edits overlap in ${sorted[k].file}`);
  }

  // ------------------------------------------------------------------ freshness: is the base still the base?
  private fresh(p: ChangeProposal): { ok: boolean; reason?: string } {
    const rev = this.store.revision(p.revision); if (!rev) return { ok: false, reason: "its source is not accessible" };
    for (const e of p.edits) {
      let buf: Buffer; try { buf = readFileSync(resolve(p.repoRoot, e.file)); } catch { return { ok: false, reason: `${e.file} is gone` }; }
      if (sha(buf) !== e.baseHash) return { ok: false, reason: `${e.file} changed after this was proposed` };
    }
    return { ok: true };
  }
  /** Re-evaluate staleness and record it. A stale proposal is never approved, validated or exported. */
  checkFresh(actor: string, id: string): ChangeProposal {
    const p = this.get(id); const f = this.fresh(p);
    if (!f.ok && p.status !== "STALE" && p.status !== "EXPORTED") { p.status = "STALE"; this.save(p, this.at(actor, "stale", f.reason ?? "")); }
    return p;
  }
  private requireFresh(actor: string, id: string): ChangeProposal {
    const p = this.checkFresh(actor, id);
    if (p.status === "STALE") throw new ChangeError("STALE_REVISION", `This proposal is stale: ${this.fresh(p).reason ?? "its base changed"}. Propose it again against the current code.`);
    return p;
  }

  // ------------------------------------------------------------------ validation in an isolated copy
  /** Apply the edits to a copy and check it: does it still compile, do the tests still pass. The checkout is never touched. */
  async validate(actor: string, id: string): Promise<ChangeProposal> {
    const p0 = this.requireFresh(actor, id);
    if (["APPROVED", "EXPORTED", "REJECTED"].includes(p0.status)) throw new ChangeError("FORBIDDEN", `a proposal that is ${p0.status.toLowerCase()} is not validated again`);
    const work = realpathSync(mkdtempSync(join(tmpdir(), "cie-change-")));
    try {
      const baseDir = join(work, "base"), headDir = join(work, "head");
      const filter = (src: string) => !/(^|\/)(\.git|node_modules|target|coverage|dist|\.cie)(\/|$)/.test(src);
      cpSync(p0.repoRoot, baseDir, { recursive: true, filter }); cpSync(p0.repoRoot, headDir, { recursive: true, filter });
      this.applyTo(headDir, p0.edits);
      const before = this.diagnostics(baseDir), after = this.diagnostics(headDir);
      const beforeCount = new Map<string, number>(); for (const d of before) beforeCount.set(d, (beforeCount.get(d) ?? 0) + 1);
      const introduced: string[] = []; const seen = new Map<string, number>();
      for (const d of after) { seen.set(d, (seen.get(d) ?? 0) + 1); if ((seen.get(d) ?? 0) > (beforeCount.get(d) ?? 0)) introduced.push(d); }
      const resolved = before.length - (after.length - introduced.length);
      const trusted = this.trustedRoots.has(realpathSync(p0.repoRoot));
      const tests = trusted ? await this.runTests(headDir) : { ran: false, passed: 0, failed: 0, output: "", reason: "this repository is not trusted for running its tests; only the compile check ran" };
      const baseTests = trusted ? await this.runTests(baseDir) : null;
      const reasons: string[] = [];
      if (introduced.length) reasons.push(`the change introduces ${introduced.length} new compile error(s)`);
      if (tests.ran && tests.failed > 0 && (baseTests?.failed ?? 0) < tests.failed) reasons.push(`${tests.failed} test(s) fail after the change (${baseTests?.failed ?? 0} before)`);
      if (tests.ran && tests.passed === 0 && tests.failed === 0) reasons.push("no tests ran, so nothing was checked");
      const state: Validation["state"] = reasons.length ? "FAILED" : tests.ran ? "PASSED" : "PASSED_COMPILE_ONLY";
      const v: Validation = { at: new Date().toISOString(), compile: { baseline: before.length, introduced, resolved: Math.max(0, resolved) }, tests, state, reasons };
      const p = this.get(id);
      p.validation = v; p.status = state === "FAILED" ? "FAILED" : state === "PASSED" ? "REVIEWABLE" : "REVIEWABLE_WITH_LIMITS"; p.version += 1; p.approvals = [];
      this.save(p, this.at(actor, "validate", `${state}${reasons.length ? ": " + reasons.join("; ") : ""}`));
      return p;
    } finally { rmSync(work, { recursive: true, force: true }); }
  }

  private applyTo(dir: string, edits: TextEdit[]) {
    const byFile = new Map<string, TextEdit[]>(); for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    for (const [file, es] of byFile) {
      const path = join(dir, file); let buf = readFileSync(path);
      for (const e of [...es].sort((a, b) => b.start - a.start)) {
        if (buf.subarray(e.start, e.end).toString("utf8") !== e.expected) throw new ChangeError("STALE_REVISION", `the text at ${file}:${e.start} is not what the edit expected`);
        buf = Buffer.concat([buf.subarray(0, e.start), Buffer.from(e.newText), buf.subarray(e.end)]);
      }
      writeFileSync(path, buf);
    }
  }
  /** TypeScript diagnostics as `file code message` lines (positions left out so that moving code does not look like new errors). */
  private diagnostics(dir: string): string[] {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { if (/^(node_modules|\.git|target|coverage|dist)$/.test(n)) continue; const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) files.push(p); } };
    walk(dir);
    const program = ts.createProgram(files, { noEmit: true, allowImportingTsExtensions: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, types: [], noImplicitAny: false, lib: ["lib.es2022.d.ts"] });
    return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter((d) => d.file).map((d) => `${relative(dir, d.file!.fileName)} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 160)}`).sort();
  }
  /** Run the checkout's tests under the permission model: it can read the checkout and nothing else, start nothing, reach nothing. */
  private runTests(dir: string): Promise<{ ran: boolean; passed: number; failed: number; output: string }> {
    const tests: string[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { if (/^(node_modules|\.git)$/.test(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.test\.(ts|js|mjs)$/.test(n)) tests.push(p); } };
    walk(dir);
    if (!tests.length) return Promise.resolve({ ran: true, passed: 0, failed: 0, output: "no test files" });
    return new Promise((res) => {
      const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, "--test", "--test-isolation=none", ...tests.map((t) => relative(dir, t))], { cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir, LANG: "C" }, stdio: ["ignore", "pipe", "pipe"], shell: false });
      let out = "", bytes = 0; const cap = (d: Buffer) => { bytes += d.length; if (bytes < 200_000) out += d.toString("utf8"); };
      child.stdout.on("data", cap); child.stderr.on("data", cap);
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", () => { clearTimeout(timer); const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0); res({ ran: true, passed: pass, failed: fail, output: out.split("\n").filter((l) => /✖|ℹ (pass|fail|tests)|Error|error/.test(l)).slice(0, 30).join("\n") }); });
      child.on("error", () => res({ ran: false, passed: 0, failed: 0, output: "could not start the test process" }));
    });
  }

  // ------------------------------------------------------------------ approval, rejection, export
  approve(actor: string, id: string, expectedVersion: number, explanation: string): ChangeProposal {
    const p = this.requireFresh(actor, id);
    if (p.version !== expectedVersion) throw new ChangeError("VERSION_CONFLICT", `this proposal is at version ${p.version}; you approved version ${expectedVersion}`);
    if (p.status !== "REVIEWABLE" && p.status !== "REVIEWABLE_WITH_LIMITS") throw new ChangeError("FORBIDDEN", p.status === "FAILED" ? "a proposal that failed its checks cannot be approved" : p.status === "DRAFT" ? "a proposal that has not been checked cannot be approved" : `a proposal that is ${p.status.toLowerCase()} cannot be approved`);
    if (this.requireSecondApprover && actor === p.author) throw new ChangeError("FORBIDDEN", "the person who proposed a change cannot be the one who approves it");
    if (!explanation?.trim()) throw new ChangeError("INVALID_SCHEMA", "say why you approve");
    const clash = this.list(p.revision).find((o) => o.id !== p.id && ["APPROVED", "EXPORTED"].includes(o.status) && this.overlaps(p.edits, o.edits));
    if (clash) throw new ChangeError("VERSION_CONFLICT", `this overlaps ${clash.id}, which was already approved; one of them has to be proposed again on top of the other`);
    p.status = "APPROVED"; p.approvals.push({ by: actor, at: new Date().toISOString(), explanation: explanation.trim().slice(0, 500), version: p.version });
    this.save(p, this.at(actor, "approve", explanation.trim().slice(0, 120)));
    return p;
  }
  reject(actor: string, id: string, reason: string): ChangeProposal {
    const p = this.get(id);
    if (["APPROVED", "EXPORTED"].includes(p.status) && actor !== p.author) throw new ChangeError("FORBIDDEN", "an approved proposal can only be withdrawn by its author");
    if (p.status === "EXPORTED") throw new ChangeError("FORBIDDEN", "a patch that was exported cannot be rejected; it can only be superseded");
    p.status = "REJECTED"; p.approvals = [];
    this.save(p, this.at(actor, "reject", (reason ?? "").slice(0, 200)));
    return p;
  }
  /** The patch for an approved proposal. This is how a change leaves: as text someone else applies. */
  exportPatch(actor: string, id: string): { patch: string; patchHash: string; proposal: ChangeProposal } {
    const p = this.requireFresh(actor, id);
    if (p.status !== "APPROVED" && p.status !== "EXPORTED") throw new ChangeError("FORBIDDEN", "only an approved proposal can be exported");
    if (!p.approvals.some((a) => a.version === p.version)) throw new ChangeError("FORBIDDEN", "the approval is for an earlier version of this proposal");
    const byFile = new Map<string, TextEdit[]>(); for (const e of p.edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    let patch = "";
    for (const [file, es] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
      const oldText = readFileSync(resolve(p.repoRoot, file)).toString("utf8"); let buf = Buffer.from(oldText);
      for (const e of [...es].sort((a, b) => b.start - a.start)) buf = Buffer.concat([buf.subarray(0, e.start), Buffer.from(e.newText), buf.subarray(e.end)]);
      patch += unifiedDiff(file, oldText, buf.toString("utf8"));
    }
    const patchHash = sha(patch);
    if (p.status !== "EXPORTED") { p.status = "EXPORTED"; p.patchHash = patchHash; this.save(p, this.at(actor, "export", `patch ${patchHash.slice(0, 12)}`)); }
    return { patch, patchHash, proposal: p };
  }
}

/** A minimal unified diff with three lines of context, enough for `git apply` / `patch -p1`. */
export function unifiedDiff(file: string, a: string, b: string): string {
  if (a === b) return "";
  const al = a.split("\n"), bl = b.split("\n");
  let pre = 0; while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
  let sa = al.length, sb = bl.length; while (sa > pre && sb > pre && al[sa - 1] === bl[sb - 1]) { sa--; sb--; }
  const ctx = 3, from = Math.max(0, pre - ctx), toA = Math.min(al.length, sa + ctx), toB = Math.min(bl.length, sb + ctx);
  const lines = [...al.slice(from, pre).map((l) => " " + l), ...al.slice(pre, sa).map((l) => "-" + l), ...bl.slice(pre, sb).map((l) => "+" + l), ...al.slice(sa, toA).map((l) => " " + l)];
  return `--- a/${file}\n+++ b/${file}\n@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@\n${lines.join("\n")}\n`;
}
export { existsSync, mkdirSync };
