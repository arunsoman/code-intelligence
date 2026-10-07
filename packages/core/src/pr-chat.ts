// F14 — chat inside the PR thread (§1–§17).
//
// A reviewer writes `/cie impact adjustBalance` on the PR; CIE replies in the thread from a developer's own
// running CIE, answering from the local index at the PR head. First delivery boundary (§2): a local watcher, five
// read-only commands, no model. Free-form `@cie <question>` gets exactly one explanation that it needs a local
// model (§14) until S0 shows the installed model drives the agent loop.
//
// Security posture (§10): comment text is attacker-controlled and is never interpolated into a sentence template or
// executed; commands can only read (F14-A2 enumerates the reachable operations and asserts none is mutating); a
// reply is built under the commenter's access policy with denied paths counted, never named (F14-A6); the egress
// rule by repository visibility is enforced in checkReplyLine and a violating reply is refused, not altered
// (F14-A7); every reply line passes the gate before it can be emitted (F14-A14: a hypothesis rendered as a fact is
// rejected). One reply per (comment, content) — a replayed webhook or a double delivery answers once (F14-A1).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessPolicy } from "./access.ts";
import type { ChangeSet } from "./history.ts";
import type { ImpactReport } from "@cie/schema";
import type { Store } from "./store.ts";
import { dependents } from "./graph.ts";
import { testsReaching } from "./testartifacts.ts";
import { resolveMentions, within, type Mentions } from "./mentions.ts";
import { consequenceNoteFor } from "./pr-summary.ts";
import { escapeForgeText } from "./impact-render.ts";
import { execFileSync } from "node:child_process";
import type { Role } from "./collab.ts";
import type { MuteRule } from "./feedback.ts";

// ---------------------------------------------------------------- data model (§6)

export interface PrChatEvent {
  eventId: string; repository: string; prNumber: number; commentId: string;
  author: string; authorAssociation: string; body: string; headHash: string; createdAt: string;
  untrusted: true;
}
export type ReplyKind = "COMMAND" | "FREE_FORM" | "REFUSED" | "HELP";
export type ReplyOutcome = "POSTED" | "SKIPPED" | "FAILED" | "READY";
export interface PrChatReply {
  commentId: string; replyId?: string; headHash: string; kind: ReplyKind;
  outcome: ReplyOutcome; reason?: string; reportHash?: string; at: string;
}
/** §7.3: what "this" means inside a PR. */
export interface PrScope {
  analysisId: string; headHash: string; baseHash: string; headRevision: string; repoRoot: string;
  changedEntityIds: string[];
  /** The F11 report's surfaced items, 1-based, for `/cie why <n>`. */
  reportItems: { n: number; id: string }[];
}
export type ReplyVisibility = "public" | "private";

// ---------------------------------------------------------------- grammar (§7.1)

export type ParsedChat =
  | { type: "command"; verb: ChatVerb; args: string }
  | { type: "freeform"; question: string }
  | { type: "ignore" };

/** F15 reviewer-feedback verbs (§1.3) — mutating; the watcher intercepts them before the read-only dispatch. */
export const FEEDBACK_VERBS = ["noise", "useful", "wrong", "right", "mute", "mutes", "unmute", "reset-ranking"] as const;
export type FeedbackVerb = (typeof FEEDBACK_VERBS)[number];
export const isFeedbackVerb = (v: string): v is FeedbackVerb => (FEEDBACK_VERBS as readonly string[]).includes(v);
export type ReadVerb = "impact" | "tests" | "callers" | "why" | "why-not" | "help";
export type ChatVerb = ReadVerb | FeedbackVerb;

const VERBS = new Set<string>(["impact", "tests", "callers", "why", "why-not", "help", ...FEEDBACK_VERBS]);

/**
 * A comment is a command only if its first non-empty line begins with `/cie ` (or `@cie ` for free-form); the verb
 * is case-insensitive, arguments exact. A comment quoting another (`>` lines) is never a command (F14-A3).
 * Anything else is ignored silently, not answered (§7.1).
 */
export function parseChat(body: string): ParsedChat {
  const lines = body.split(/\r?\n/);
  if (lines.some((l) => l.trimStart().startsWith(">"))) return { type: "ignore" };
  const first = lines.find((l) => l.trim().length > 0);
  if (!first) return { type: "ignore" };
  const m = first.match(/^\/(cie)\s+(\S+)\s*([\s\S]*)$/i);
  if (m) {
    const verb = m[2].toLowerCase();
    if (!VERBS.has(verb)) return { type: "command", verb: "help", args: `unknown verb: ${m[2]}` };
    return { type: "command", verb: verb as ChatVerb, args: (m[3] ?? "").trim() };
  }
  const f = first.match(/^@(cie)\s+([\s\S]*)$/i);
  if (f) return { type: "freeform", question: (f[2] ?? "").trim() };
  return { type: "ignore" };
}

// ---------------------------------------------------------------- reply shaping (§7.5)

export type ReplyClaimClass = "FACT" | "INFERENCE" | "HYPOTHESIS" | "FOG";
export interface ReplyClaim {
  class: ReplyClaimClass;
  /** One sentence, template-produced; attacker-controlled fragments are escaped at render time. */
  text: string;
  evidence: { id: string; path: string; startLine: number; endLine: number }[];
}
export interface ChatShapedResult {
  schemaVersion: 1; kind: ReplyKind; headHash: string;
  claims: ReplyClaim[]; gaps: string[];
  /** Set when the result is a refusal: one sentence, posted as-is (§12). */
  refusedReason?: string;
}

export const REPLY_MARKER_PREFIX = "<!-- cie-reply:";
export const replyMarker = (commentId: string) => `${REPLY_MARKER_PREFIX}${commentId} -->`;
export const REPLY_BUDGET_BYTES = 4096;
export const REPLY_LINE_BYTES = 400;
export const PUBLIC_SPAN_CHARS = 120;
export const PRIVATE_SPAN_CHARS = 200;

const HYPOTHESIS_WORDING = /\b(may|might|could|perhaps|possibly|unclear|unproven|i think|suggests|unknown whether)\b/i;
const CERTAINTY_WORDING = /will break|will fail|will cause|causes|caused by|is safe|are safe|safe to|verified|guaranteed|guarantees?|proves?|tests pass|all tests pass/i;

export interface ReplyGateCtx {
  visibility: ReplyVisibility;
  deniedPrefixes: string[];
  resolveEvidence: (evidenceId: string) => boolean;
}

/**
 * §7.5/§10 — every reply line passes this gate before it can be emitted; a line that fails is refused, not
 * altered. Rules: a FACT line may never carry hypothesis or certainty wording (F14-A14); in a public repository a
 * line may carry symbol names, paths, line numbers, counts and classes but never source text — no fences and no
 * span longer than PUBLIC_SPAN_CHARS — while a private repository allows one-line spans up to PRIVATE_SPAN_CHARS
 * (F14-A7); a line naming a denied path is impossible — denied paths are counted, never named (F14-A6); cited
 * evidence must resolve; a line over the per-line budget is rejected.
 */
export function checkReplyLine(claim: ReplyClaim, ctx: ReplyGateCtx): { ok: true } | { ok: false; rule: number; reason: string } {
  if (!["FACT", "INFERENCE", "HYPOTHESIS", "FOG"].includes(claim.class)) return { ok: false, rule: 1, reason: "unknown claim class" };
  if (claim.class === "FACT" && HYPOTHESIS_WORDING.test(claim.text)) return { ok: false, rule: 2, reason: "a hypothesis rendered as a fact is rejected (F14-A14)" };
  if (CERTAINTY_WORDING.test(claim.text)) return { ok: false, rule: 3, reason: "certainty wording is never emitted" };
  const spanLimit = ctx.visibility === "public" ? PUBLIC_SPAN_CHARS : PRIVATE_SPAN_CHARS;
  if (claim.text.includes("```")) return { ok: false, rule: 4, reason: "source text never leaves in a reply line" };
  for (const m of claim.text.matchAll(/`([^`]*)`/g)) {
    if (m[1].includes("\n") || m[1].length > spanLimit) return { ok: false, rule: 4, reason: `span over the ${ctx.visibility}-repository limit` };
  }
  for (const p of ctx.deniedPrefixes) {
    if (claim.text.includes(p)) return { ok: false, rule: 5, reason: "a reply naming a denied path is impossible; it is counted, never named (F14-A6)" };
  }
  if (claim.class === "FACT" && !claim.evidence.length) return { ok: false, rule: 6, reason: "a FACT line needs at least one citation" };
  for (const e of claim.evidence) {
    if (ctx.deniedPrefixes.some((p) => e.path === p || e.path.startsWith(p + "/"))) return { ok: false, rule: 5, reason: "citation names a denied path" };
    if (!ctx.resolveEvidence(e.id)) return { ok: false, rule: 7, reason: `evidence ${e.id} does not resolve` };
  }
  if (Buffer.byteLength(claim.text, "utf8") > REPLY_LINE_BYTES) return { ok: false, rule: 8, reason: "line over the per-line budget" };
  return { ok: true };
}

const mdCode = (s: string) => `\`${escapeForgeText(s).replace(/`/g, "\\`")}\``;

/**
 * Render the shaped result as the reply Markdown (§12): class word, sentence, citation links; the head it was
 * answered on; the fixed line. Deterministic for the same result. Every line has already passed checkReplyLine —
 * this function cannot produce a line that fails the gate.
 */
export function renderReply(result: ChatShapedResult, o: { commentId: string; nowHeadHash?: string; reviewUrl?: string }): string {
  const out: string[] = [replyMarker(o.commentId)];
  if (result.refusedReason) {
    out.push(escapeForgeText(result.refusedReason));
  } else {
    for (const claim of result.claims) {
      const cite = claim.evidence.length ? ` — ${claim.evidence.map((e) => `${mdCode(e.path)}:${e.startLine}`).join(", ")}` : "";
      out.push(`${claim.class.padEnd(9)}  ${escapeForgeText(claim.text)}${cite}`);
    }
    if (result.gaps.length) out.push(`Not determined: ${result.gaps.map(escapeForgeText).join("; ")}.`);
  }
  const headNote = o.nowHeadHash && o.nowHeadHash !== result.headHash
    ? ` · answered on ${result.headHash.slice(0, 7)}; the PR now points to ${o.nowHeadHash.slice(0, 7)}`
    : ` · answered on head ${result.headHash.slice(0, 7)}`;
  out.push(`CIE chat${headNote} · not a safety verdict · reply "/cie help" for commands${o.reviewUrl ? ` · ${o.reviewUrl}` : ""}`);
  let markdown = out.join("\n");
  if (Buffer.byteLength(markdown, "utf8") > REPLY_BUDGET_BYTES) {
    markdown = markdown.slice(0, REPLY_BUDGET_BYTES - 120) + "\n…(trimmed; the full answer needs the share page)";
  }
  return markdown;
}

/** The service operations the chat path can reach (§10.2) — F14-A2 asserts every one is registered read-only.
 *  The command handlers themselves call internal read-only builders (graph projection, testsReaching, store
 *  facts/evidence) directly; they never reach a mutating op. */
export const PR_CHAT_READ_OPS = [
  "C15/runPrCommand", "C23/getImpactReport",
];

// ---------------------------------------------------------------- command handlers (§7.2, §7.3)

export interface ChatEnv {
  store: Store;
  scope: PrScope;
  access: AccessPolicy;
  cs: ChangeSet | null;
  report: ImpactReport | null;
  /** Whether a local model is configured; without it free-form is refused with the one-time explanation (§14). */
  modelAvailable: boolean;
}

const shortName = (id: string) => id.replace(/^[a-z]+:/, "").replace(/^.*#/, "");

/** A resolvable evidence id for an entity: its own span fact's evidence when present, else an edge's evidence. */
function evidenceFor(env: ChatEnv, entityId: string): string | null {
  for (const f of env.store.factsFor(env.scope.headRevision, entityId)) if (f.evidence.length) return f.evidence[0].id;
  for (const r of env.store.allRelationships(env.scope.headRevision)) {
    if ((r.from === entityId || r.to === entityId) && r.evidence.length) return r.evidence[0].id;
  }
  return null;
}

/** Byte span → line numbers against the checked-out head; null when the file cannot be read (never guessed). */
function locationOf(env: ChatEnv, entityId: string): { id: string; path: string; startLine: number; endLine: number } | null {
  const e = env.store.entitiesById(env.scope.headRevision, [entityId])[0];
  const evidenceId = e ? evidenceFor(env, entityId) : null;
  if (!e || !e.spans.length || !evidenceId) return null;
  const span = e.spans[0];
  try {
    const bytes = readFileSync(join(env.scope.repoRoot, e.file));
    const lineOf = (byte: number) => bytes.subarray(0, Math.min(byte, bytes.length)).toString("utf8").split("\n").length;
    return { id: evidenceId, path: e.file, startLine: lineOf(span.startByte), endLine: lineOf(Math.max(span.startByte, span.endByteExclusive - 1)) };
  } catch {
    return null;
  }
}

/** §7.2 — resolve one symbol argument against the head index; ambiguity is reported, never silently resolved. */
function resolveOne(env: ChatEnv, arg: string, claims: ReplyClaim[], gaps: string[]): string | null {
  if (!arg) return null;
  const mentions: Mentions = resolveMentions(env.store, env.scope.headRevision, arg, env.access);
  const hits = new Map<string, { name: string; file: string }>();
  for (const m of mentions.resolved) for (const match of m.matches) hits.set(match.entityId, { name: match.name, file: match.file });
  if (!hits.size) {
    // zero matches: name up to three nearest indexed names, never a guess (§7.2)
    const names = env.store.entities(env.scope.headRevision)
      .filter((e) => !env.access.denied(e.file))
      .map((e) => e.name)
      .filter((n) => within(arg.toLowerCase(), n.toLowerCase(), 3) || n.toLowerCase().includes(arg.toLowerCase()))
      .sort().slice(0, 3);
    claims.push({ class: "FOG", text: `no indexed symbol matches ${mdCode(arg)}${names.length ? `; nearest: ${names.map(mdCode).join(", ")}` : ""}.`, evidence: [] });
    return null;
  }
  if (hits.size > 1) {
    const candidates = [...hits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id]) => id);
    claims.push({ class: "FOG", text: `${mdCode(arg)} is ambiguous — it matches ${candidates.map((c) => mdCode(shortName(c))).join(", ")}; ask with a more specific name.`, evidence: [] });
    return null;
  }
  return [...hits.keys()][0];
}

const HELP_TEXT = "commands: /cie impact <symbol> · /cie tests <symbol> · /cie callers <symbol> · /cie why <n> · /cie why-not <symbol> · /cie noise|useful|wrong|right <n> · /cie mute|unmute <KIND> · /cie mutes · /cie reset-ranking · /cie help. Free-form @cie questions need a local model.";

function impactCommand(env: ChatEnv, arg: string, claims: ReplyClaim[], gaps: string[]): void {
  const id = resolveOne(env, arg, claims, gaps);
  if (!id) return;
  const proj = dependents(env.store, env.scope.headRevision, id, { maxDepth: 4, access: env.access });
  const deps = proj.nodes.filter((n) => n.depth > 0); // the depth-0 node is the subject itself
  const files = new Set(deps.map((n) => n.file).filter(Boolean));
  claims.push({
    class: "FACT",
    text: `${mdCode(shortName(id))} has ${deps.length} dependent(s) in ${files.size} file(s) (depth ≤ 4).`,
    evidence: [locationOf(env, id)].filter((x): x is NonNullable<typeof x> => !!x),
  });
  if (proj.omittedByAccess) gaps.push(`${proj.omittedByAccess} dependent path(s) withheld by the access policy`);
  if (proj.truncated.byDepth || proj.truncated.byNodes) gaps.push("the dependent set was truncated at the graph limits");
  const note = env.cs ? consequenceNoteFor(id, env.cs) : null;
  if (note) claims.push({ class: "INFERENCE", text: `${mdCode(shortName(id))} ${note} in this change.`, evidence: [locationOf(env, id)].filter((x): x is NonNullable<typeof x> => !!x) });
  const writes = env.store.factsFor(env.scope.headRevision, id).filter((f) => f.predicate === "writes");
  if (writes.length) {
    const fields = [...new Set(writes.map((w) => String((w.object as { value?: unknown }).value ?? "?")))].sort();
    const tx = env.store.factsFor(env.scope.headRevision, id).some((f) => f.predicate === "uses_transaction");
    claims.push({ class: "INFERENCE", text: `it writes ${fields.map(mdCode).join(", ")} ${tx ? "inside a transaction" : "outside a transaction"}.`, evidence: [locationOf(env, id)].filter((x): x is NonNullable<typeof x> => !!x) });
  }
}

function testsCommand(env: ChatEnv, arg: string, claims: ReplyClaim[], gaps: string[]): void {
  const id = resolveOne(env, arg, claims, gaps);
  if (!id) return;
  const tests = testsReaching(env.store, env.scope.headRevision, id, 4);
  if (!tests.length) {
    claims.push({ class: "FOG", text: `no test reaches ${mdCode(shortName(id))} within 4 hops.`, evidence: [locationOf(env, id)].filter((x): x is NonNullable<typeof x> => !!x) });
    return;
  }
  claims.push({
    class: "FACT",
    text: `${mdCode(shortName(id))} is reached by ${tests.length} test(s): ${tests.slice(0, 5).map((t) => mdCode(t.name)).join(", ")}${tests.length > 5 ? ` … ${tests.length - 5} more` : ""}.`,
    evidence: tests.slice(0, 5).flatMap((t) => t.evidenceIds.slice(0, 1)).map((eid) => ({ id: eid, path: locationOf(env, id)?.path ?? "", startLine: 1, endLine: 1 })),
  });
}

function callersCommand(env: ChatEnv, arg: string, claims: ReplyClaim[], gaps: string[]): void {
  const id = resolveOne(env, arg, claims, gaps);
  if (!id) return;
  const callers = env.store.allRelationships(env.scope.headRevision)
    .filter((r) => r.kind === "calls" && r.to === id && !env.access.deniedEntity(r.from))
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!callers.length) {
    claims.push({ class: "FACT", text: `${mdCode(shortName(id))} has no indexed callers.`, evidence: [locationOf(env, id)].filter((x): x is NonNullable<typeof x> => !!x) });
    return;
  }
  const names = [...new Set(callers.map((c) => shortName(c.from)))].slice(0, 5);
  claims.push({
    class: "FACT",
    text: `${mdCode(shortName(id))} is called by ${callers.length} indexed caller(s): ${names.map(mdCode).join(", ")}${callers.length > 5 ? ` … ${callers.length - 5} more` : ""}.`,
    evidence: callers.slice(0, 3).flatMap((c) => c.evidence.slice(0, 1).map((e) => ({ id: e.id, path: locationOf(env, c.from)?.path ?? "", startLine: locationOf(env, c.from)?.startLine ?? 1, endLine: 1 }))),
  });
}

function whyCommand(env: ChatEnv, arg: string, claims: ReplyClaim[], gaps: string[]): void {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) { claims.push({ class: "FOG", text: `/cie why takes the item number from the report comment, e.g. /cie why 1.`, evidence: [] }); return; }
  const item = env.report?.surfaced[n - 1];
  if (!item) { claims.push({ class: "FOG", text: `the report has ${env.report?.surfaced.length ?? 0} surfaced item(s); there is no item ${n}.`, evidence: [] }); return; }
  const fallback = item.subjectEntityIds.length ? [locationOf(env, item.subjectEntityIds[0])].filter((x): x is NonNullable<typeof x> => !!x) : [];
  claims.push({
    class: item.claimClass as ReplyClaimClass,
    text: `${item.text} (score ${item.rank.score}).`,
    evidence: item.citations.length
      ? item.citations.slice(0, 3).map((c) => ({ id: item.evidenceIds[0] ?? item.id, path: c.path, startLine: c.startLine, endLine: c.endLine }))
      : fallback,
  });
}

function whyNotCommand(env: ChatEnv, arg: string, claims: ReplyClaim[], gaps: string[]): void {
  const id = resolveOne(env, arg, claims, gaps);
  if (!id) return;
  const loc = locationOf(env, id);
  if (loc && env.access.denied(loc.path)) { gaps.push("1 matching path is withheld by the access policy"); return; }
  const surfaced = env.report?.surfaced.find((i) => i.subjectEntityIds.includes(id));
  if (surfaced) { claims.push({ class: "FACT", text: `${mdCode(shortName(id))} is shown in the report — item with score ${surfaced.rank.score}.`, evidence: loc ? [loc] : [] }); return; }
  const suppressed = env.report?.suppressed.find((i) => i.subjectEntityIds.includes(id));
  if (suppressed) { claims.push({ class: "FACT", text: `${mdCode(shortName(id))} is below the noise threshold (${suppressed.suppressed?.reason ?? "suppressed"}).`, evidence: loc ? [loc] : [] }); return; }
  // F15-A5: a muted item is still explainable — the suppression is a reviewer rule, counted, never deleted.
  const muted = env.report?.muted?.find((i) => i.subjectEntityIds.includes(id));
  if (muted) { claims.push({ class: "FACT", text: `${mdCode(shortName(id))} is muted for this repository by reviewer feedback — counted, not deleted; a mute is a reviewer rule, not a finding (§7.4).`, evidence: loc ? [loc] : [] }); return; }
  claims.push({ class: "FOG", text: `${mdCode(shortName(id))} is not in the report and nothing withholds it; absence here is not evidence of absence.`, evidence: loc ? [loc] : [] });
}

/** Run one parsed command against the PR scope. Purely read-only: it never writes to the store or the forge.
 *  (The F15 feedback verbs never reach this function — the watcher intercepts them, §7.1.) */
export function runChatCommand(env: ChatEnv, parsed: { verb: ReadVerb; args: string }): ChatShapedResult {
  const claims: ReplyClaim[] = [];
  const gaps: string[] = [];
  switch (parsed.verb) {
    case "help": claims.push({ class: "FOG", text: HELP_TEXT, evidence: [] }); break; // fixed text, not a finding — FOG carries no citation
    case "impact": impactCommand(env, parsed.args, claims, gaps); break;
    case "tests": testsCommand(env, parsed.args, claims, gaps); break;
    case "callers": callersCommand(env, parsed.args, claims, gaps); break;
    case "why": whyCommand(env, parsed.args, claims, gaps); break;
    case "why-not": whyNotCommand(env, parsed.args, claims, gaps); break;
  }
  return { schemaVersion: 1, kind: parsed.verb === "help" ? "HELP" : "COMMAND", headHash: env.scope.headHash, claims, gaps };
}

/** Gate every claim of a shaped result; returns the claims that pass and the refusal reason when none do. */
export function gateResult(result: ChatShapedResult, ctx: ReplyGateCtx): { claims: ReplyClaim[]; refusedReason?: string } {
  const kept: ReplyClaim[] = [];
  let firstRefusal: string | null = null;
  for (const claim of result.claims) {
    const v = checkReplyLine(claim, ctx);
    if (v.ok) kept.push(claim);
    else if (!firstRefusal) firstRefusal = v.reason;
  }
  if (result.refusedReason) return { claims: [], refusedReason: result.refusedReason };
  if (!kept.length && result.claims.length) return { claims: [], refusedReason: `Refused: ${firstRefusal ?? "nothing survived the egress check"}.` };
  return { claims: kept };
}

// ---------------------------------------------------------------- reply ledger and limits (§7.7, §11)

export interface PrChatLimits { maxRepliesPerPr: number; maxCommandsPerUserPerHour: number }
export const DEFAULT_CHAT_LIMITS: PrChatLimits = { maxRepliesPerPr: 20, maxCommandsPerUserPerHour: 10 };
/** Associations that count as write access by default (§10.1, D3: read-only users may not invoke). */
export const DEFAULT_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const contentHashOf = (body: string) => sha(body);

export interface ReplyLedgerRow {
  comment_id: string; content_hash: string; analysis_id: string; pr_number: number; repository: string;
  author: string; head_hash: string; kind: ReplyKind; outcome: ReplyOutcome; reason: string | null;
  reply_id: string | null; report_hash: string | null; reply_body: string | null; idempotency_key: string | null;
  result_hash: string | null; created_at: string;
}

/**
 * One reply per (comment, content hash) — §11. The row records the shaped reply body and the idempotency key
 * before posting, so a crash between answering and posting re-posts with the same key instead of duplicating.
 */
export class ReplyLedger {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }

  row(commentId: string, contentHash: string): ReplyLedgerRow | null {
    return (this.store.db.prepare("select * from pr_chat_replies where comment_id = ? and content_hash = ?").get(commentId, contentHash) as ReplyLedgerRow | undefined) ?? null;
  }
  anyRow(commentId: string): ReplyLedgerRow | null {
    return (this.store.db.prepare("select * from pr_chat_replies where comment_id = ? order by created_at desc limit 1").get(commentId) as ReplyLedgerRow | undefined) ?? null;
  }

  insert(row: Omit<ReplyLedgerRow, "created_at"> & { created_at?: string }): void {
    this.store.db.prepare(`insert into pr_chat_replies values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.comment_id, row.content_hash, row.analysis_id, row.pr_number, row.repository, row.author, row.head_hash,
      row.kind, row.outcome, row.reason, row.reply_id, row.report_hash, row.reply_body, row.idempotency_key, row.result_hash,
      row.created_at ?? new Date().toISOString());
  }

  markPosted(commentId: string, contentHash: string, replyId: string, outcome: "POSTED" | "FAILED" = "POSTED", reason?: string): void {
    this.store.db.prepare("update pr_chat_replies set outcome = ?, reply_id = ?, reason = ? where comment_id = ? and content_hash = ?")
      .run(outcome, replyId, reason ?? null, commentId, contentHash);
  }

  /** §7.7 — per-PR and per-user sliding-hour caps. */
  checkLimits(prNumber: number, author: string, limits: PrChatLimits, nowMs: number): { ok: true } | { ok: false; which: "pr" | "user"; windowMs: number } {
    const hourAgo = new Date(nowMs - 3_600_000).toISOString();
    const prCount = Number((this.store.db.prepare("select count(*) n from pr_chat_replies where pr_number = ? and outcome in ('POSTED','READY')").get(prNumber) as { n: number }).n);
    if (prCount >= limits.maxRepliesPerPr) return { ok: false, which: "pr", windowMs: 3_600_000 };
    const userCount = Number((this.store.db.prepare("select count(*) n from pr_chat_replies where author = ? and outcome in ('POSTED','READY') and created_at >= ?").get(author, hourAgo) as { n: number }).n);
    if (userCount >= limits.maxCommandsPerUserPerHour) return { ok: false, which: "user", windowMs: 3_600_000 };
    return { ok: true };
  }

  /** One refusal/notice per user per PR per kind within the window ("one reply, then silence", §7.7, §10.1).
   *  A PR-level limit notice is deduped per PR, not per user: once the cap is announced, later comments are silent. */
  noticeAlreadySent(prNumber: number, author: string, kind: string, nowMs: number): boolean {
    const dayAgo = new Date(nowMs - 24 * 3_600_000).toISOString();
    if (kind === "LIMIT_pr") {
      return !!this.store.db.prepare("select 1 from pr_chat_replies where pr_number = ? and kind = ? and created_at >= ? limit 1")
        .get(prNumber, kind, dayAgo);
    }
    return !!this.store.db.prepare("select 1 from pr_chat_replies where pr_number = ? and author = ? and kind = ? and created_at >= ? limit 1")
      .get(prNumber, author, kind, dayAgo);
  }
}

// ---------------------------------------------------------------- transport (F19 interface, §8)

export interface ChatTransport {
  listComments(prNumber: number, since?: string): Promise<PrChatEvent[]>;
  postReply(prNumber: number, inReplyTo: string, body: string): Promise<{ id: string }>;
  visibility(): Promise<ReplyVisibility>;
  /** Forge permission lookup when the association on the event is not enough (§10.1). F15 (D2): "admin" maps to owner. */
  commenterPermission?(prNumber: number, login: string): Promise<"write" | "read" | "none" | "admin">;
  /** F15 S2: comment-level reactions on the impact comment (weak signal, §7.2.3) — the F19 forge shape is TBD. */
  listReactions?(commentId: string): Promise<{ id: string; user: string; kind: "+1" | "-1" }[]>;
}

/**
 * The `gh` CLI as the first-slice transport (local-first, §7.6). The token is read at call time, never stored
 * (§10); nothing here can act beyond reading comments and posting one reply.
 */
export function ghCliChatTransport(repoRoot: string, repo: string): ChatTransport {
  const gh = (args: string[]): string => {
    try { return execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return ""; }
  };
  return {
    listComments: async (prNumber, since) => {
      const out = gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "comments,headRefOid"]);
      if (!out) return [];
      const v = JSON.parse(out) as { headRefOid?: string; comments?: { id: string; author: { login: string }; authorAssociation?: string; body: string; createdAt: string }[] };
      return (v.comments ?? []).filter((c) => !since || c.createdAt > since).map((c) => ({
        eventId: c.id, repository: repo, prNumber, commentId: c.id, author: c.author.login,
        authorAssociation: c.authorAssociation ?? "NONE", body: c.body, headHash: v.headRefOid ?? "",
        createdAt: c.createdAt, untrusted: true,
      }));
    },
    postReply: async (prNumber, inReplyTo, body) => {
      const out = gh(["api", "-X", "POST", `repos/${repo}/issues/${prNumber}/comments`, "-f", `body=${body}`]);
      const v = JSON.parse(out || "{}") as { id?: number };
      return { id: String(v.id ?? inReplyTo) };
    },
    visibility: async () => {
      const out = gh(["repo", "view", repo, "--json", "visibility"]);
      try { return (JSON.parse(out) as { visibility?: string }).visibility === "PUBLIC" ? "public" : "private"; } catch { return "public"; }
    },
  };
}

// ---------------------------------------------------------------- watcher (§4 flow, §9)

/**
 * F15: the mutating feedback verbs (noise/useful/wrong/right/mute/mutes/unmute/reset-ranking) reach the label
 * log, the mute rules and the claim ledger through this hook — never through the read-only command path (§7.1).
 * The service implements it over FeedbackStore; tests can substitute a fake.
 */
export interface ChatFeedback {
  /** 1-based item number of the current report, as numbered in the impact comment. */
  itemAt(n: number): { itemKind: string; itemId: string; kindDetail?: string; text: string } | null;
  recordUsefulness(n: number, label: "USEFUL" | "NOISE", actor: string): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  /** wrong/right → the C18 claim ledger (§7.1): a REFUTE/CONFIRM verdict on the claim behind item N. */
  recordVerdict(n: number, verdict: "CONFIRM" | "REFUTE", actor: string): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  setMute(kind: string, actor: string, reason: string | undefined, role: Role): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  listMutes(): Promise<MuteRule[]>;
  clearMute(kind: string, actor: string, role: Role): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  resetRanking(actor: string, role: Role): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  labelTotals(): { total: number; principals: number };
}

export interface WatcherDeps {
  ledger: ReplyLedger;
  /** Build the PR scope for an event's head; null when the analysis is not ready (§14). */
  scopeFor: (ev: PrChatEvent) => PrScope | null;
  buildEnv: (scope: PrScope) => ChatEnv;
  reportHashOf: (analysisId: string) => string | null;
  nowHeadHashOf: (analysisId: string) => string | null;
  deniedPrefixesOf: (repoRoot: string) => string[];
  evidenceOf: (revision: string, evidenceId: string) => unknown;
  transport: ChatTransport;
  reviewUrl?: string;
  /** F15: feedback hooks for the mutating verbs; absent → feedback commands get one explanation, then silence. */
  feedbackFor?: (ev: PrChatEvent, scope: PrScope) => ChatFeedback | null;
}
export interface WatcherOpts {
  limits?: Partial<PrChatLimits>;
  allowedAssociations?: string[];
  modelAvailable?: boolean;
  now?: () => number;
}

export class PrChatWatcher {
  readonly deps: WatcherDeps;
  readonly limits: PrChatLimits;
  readonly allowed: string[];
  readonly modelAvailable: boolean;
  readonly now: () => number;
  constructor(deps: WatcherDeps, opts: WatcherOpts = {}) {
    this.deps = deps;
    this.limits = { ...DEFAULT_CHAT_LIMITS, ...opts.limits };
    this.allowed = opts.allowedAssociations ?? DEFAULT_ALLOWED_ASSOCIATIONS;
    this.modelAvailable = opts.modelAvailable ?? false;
    this.now = opts.now ?? Date.now;
  }

  /** Authorise the commenter (§10.1): write association by default; one refusal per user per PR. */
  private async authorised(ev: PrChatEvent): Promise<boolean> {
    if (this.allowed.includes(ev.authorAssociation.toUpperCase())) return true;
    const perm = await this.deps.transport.commenterPermission?.(ev.prNumber, ev.author);
    return perm === "write" || perm === "admin";
  }

  /** F15 D2: map the forge permission (or the association fallback) to a CIE role; null = no recognised role. */
  private async roleFor(ev: PrChatEvent): Promise<Role | null> {
    const perm = await this.deps.transport.commenterPermission?.(ev.prNumber, ev.author);
    if (perm === "admin") return "owner";
    if (perm === "write") return "editor";
    if (perm === "read") return "viewer";
    const byAssociation: Record<string, Role> = { OWNER: "owner", MEMBER: "editor", COLLABORATOR: "editor", CONTRIBUTOR: "viewer" };
    return byAssociation[ev.authorAssociation.toUpperCase()] ?? null;
  }

  /** One refused/not-enabled notice per (PR, author, kind) within the window, then silence. */
  private async notice(ev: PrChatEvent, kind: string, contentHash: string, base: PrChatReply, refusedReason: string, reason: string): Promise<PrChatReply> {
    const ledger = this.deps.ledger;
    if (ledger.noticeAlreadySent(ev.prNumber, ev.author, kind, this.now())) return { ...base, kind: "REFUSED", outcome: "SKIPPED", reason: `${reason} (notice already sent)` };
    const body = renderReply({ schemaVersion: 1, kind: "REFUSED", headHash: ev.headHash, claims: [], gaps: [], refusedReason }, { commentId: ev.commentId });
    await this.deps.transport.postReply(ev.prNumber, ev.commentId, body);
    ledger.insert({ comment_id: ev.commentId, content_hash: contentHash, analysis_id: "", pr_number: ev.prNumber, repository: ev.repository, author: ev.author, head_hash: ev.headHash, kind, outcome: "POSTED", reason, reply_id: null, report_hash: null, reply_body: body, idempotency_key: null, result_hash: null });
    return { ...base, kind: "REFUSED", outcome: "POSTED", reason };
  }

  /**
   * F15: handle one mutating feedback verb (§1.3, §7). Labels need at least the viewer role, mutes and reset the
   * editor role; the repository-wide and safety-class floors live in FeedbackStore.setMute (§7.4, §7.5). Only the
   * command and an integer or kind token are parsed from comment text — free text is never stored beyond the
   * redacted, length-limited mute reason (§10.3).
   */
  private async handleFeedback(ev: PrChatEvent, parsed: { type: "command"; verb: FeedbackVerb; args: string }, contentHash: string, base: PrChatReply): Promise<PrChatReply> {
    const ledger = this.deps.ledger;
    const scope = this.deps.scopeFor(ev);
    if (!scope) {
      return this.notice(ev, "REFUSED", contentHash, base, `Refused: analysis not ready for ${mdCode(ev.headHash.slice(0, 7))} — CIE answers only from the index at the comment's head (§14). Run the analysis and ask again.`, "analysis not ready");
    }
    const role = await this.roleFor(ev);
    if (!role) return this.notice(ev, "REFUSED", contentHash, base, `Refused: ${mdCode(ev.author)} has no recognised role on this repository, so CIE does not record feedback from it (§10.1).`, "no role");
    const fb = this.deps.feedbackFor?.(ev, scope) ?? null;
    if (!fb) {
      return this.notice(ev, "FEEDBACK_DISABLED", contentHash, base, "Feedback commands are not enabled for this analysis — the store has no feedback log for it.", "feedback not enabled");
    }
    const limited = ledger.checkLimits(ev.prNumber, ev.author, this.limits, this.now());
    if (!limited.ok) {
      return this.notice(ev, `LIMIT_${limited.which}`, contentHash, base, `Refused: limit reached — CIE stays silent until the window resets (§7.7).`, `limit ${limited.which}`);
    }

    const needsEditor = parsed.verb === "mute" || parsed.verb === "unmute" || parsed.verb === "reset-ranking";
    if (needsEditor && role === "viewer") {
      return this.notice(ev, "REFUSED_FEEDBACK", contentHash, base, `Refused: ${mdCode(parsed.verb)} needs at least the editor role; ${mdCode(ev.author)} is a viewer here (§7.4).`, "role below editor");
    }

    const itemIndex = (): number | null => {
      const n = Number(parsed.args.trim().split(/\s+/)[0]);
      return Number.isInteger(n) && n >= 1 ? n : null;
    };
    const kindToken = (): string | null => {
      const tok = parsed.args.trim().split(/\s+/)[0] ?? "";
      return /^[A-Z][A-Z0-9_]{1,60}$/.test(tok) ? tok : null;
    };
    const fog = (text: string): ChatShapedResult => ({ schemaVersion: 1, kind: "COMMAND", headHash: scope.headHash, claims: [{ class: "FOG", text, evidence: [] }], gaps: [] });
    const refused = (error: string): ChatShapedResult => ({ schemaVersion: 1, kind: "REFUSED", headHash: scope.headHash, claims: [], gaps: [], refusedReason: `Refused: ${error}` });

    let result: ChatShapedResult;
    switch (parsed.verb) {
      case "noise":
      case "useful": {
        const n = itemIndex();
        if (!n) { result = fog("/cie noise and /cie useful take the item number from the impact comment, e.g. /cie noise 2."); break; }
        const r = await fb.recordUsefulness(n, parsed.verb === "useful" ? "USEFUL" : "NOISE", ev.author);
        result = r.ok ? fog(r.summary) : refused(r.error);
        break;
      }
      case "wrong":
      case "right": {
        const n = itemIndex();
        if (!n) { result = fog("/cie wrong and /cie right take the item number from the impact comment, e.g. /cie wrong 3."); break; }
        const r = await fb.recordVerdict(n, parsed.verb === "right" ? "CONFIRM" : "REFUTE", ev.author);
        result = r.ok ? fog(r.summary) : refused(r.error);
        break;
      }
      case "mute": {
        const kind = kindToken();
        if (!kind) { result = fog("/cie mute takes an upper-case kind token, e.g. /cie mute MODULE_COUPLING — optionally followed by one line of reason."); break; }
        const reason = parsed.args.trim().slice(kind.length).trim() || undefined;
        const r = await fb.setMute(kind, ev.author, reason, role);
        result = r.ok ? fog(r.summary) : refused(r.error);
        break;
      }
      case "mutes": {
        const mutes = await fb.listMutes();
        const visibility = await this.deps.transport.visibility();
        const lines = mutes.length
          ? mutes.map((m) => {
              const scopeText = m.scope.type === "REPOSITORY" ? "repository-wide" : `${m.scope.type.toLowerCase()} ${m.scope.value}`;
              const who = visibility === "private" ? ` by ${m.createdBy}` : "";
              const exp = m.expiresAt ? `, expires ${m.expiresAt.slice(0, 10)}` : "";
              return `${m.kind} muted (${scopeText}${who}${exp})`;
            })
          : ["nothing is muted for this repository"];
        result = fog(lines.join("; ") + ".");
        break;
      }
      case "unmute": {
        const kind = kindToken();
        if (!kind) { result = fog("/cie unmute takes an upper-case kind token, e.g. /cie unmute MODULE_COUPLING."); break; }
        const r = await fb.clearMute(kind, ev.author, role);
        result = r.ok ? fog(r.summary) : refused(r.error);
        break;
      }
      case "reset-ranking": {
        const r = await fb.resetRanking(ev.author, role);
        result = r.ok ? fog(r.summary) : refused(r.error);
        break;
      }
    }
    return this.postShaped(ev, scope, contentHash, base, result);
  }

  /** Gate, render, record and post one shaped result — the shared tail of the command and feedback paths (§11). */
  private async postShaped(ev: PrChatEvent, scope: PrScope, contentHash: string, base: PrChatReply, result: ChatShapedResult): Promise<PrChatReply> {
    const ledger = this.deps.ledger;
    const visibility = await this.deps.transport.visibility();
    const denied = this.deps.deniedPrefixesOf ? this.deps.deniedPrefixesOf(scope.repoRoot) : [];
    const gated = gateResult(result, { visibility, deniedPrefixes: denied, resolveEvidence: (id) => !!this.deps.evidenceOf(scope.headRevision, id) });
    const shaped: ChatShapedResult = { ...result, claims: gated.claims, refusedReason: gated.refusedReason };
    const nowHead = this.deps.nowHeadHashOf(scope.analysisId);
    const replyBody = renderReply(shaped, { commentId: ev.commentId, nowHeadHash: nowHead ?? undefined, reviewUrl: this.deps.reviewUrl });
    const resultHash = sha(JSON.stringify(shaped));
    const idempotencyKey = `prchat:${ev.commentId}:${contentHash.slice(0, 12)}`;
    ledger.insert({
      comment_id: ev.commentId, content_hash: contentHash, analysis_id: scope.analysisId, pr_number: ev.prNumber,
      repository: ev.repository, author: ev.author, head_hash: scope.headHash, kind: shaped.kind, outcome: "READY",
      reason: null, reply_id: null, report_hash: this.deps.reportHashOf(scope.analysisId), reply_body: replyBody,
      idempotency_key: idempotencyKey, result_hash: resultHash,
    });
    try {
      const receipt = await this.deps.transport.postReply(ev.prNumber, ev.commentId, replyBody);
      ledger.markPosted(ev.commentId, contentHash, receipt.id);
      return { ...base, replyId: receipt.id, kind: shaped.kind, outcome: "POSTED", reportHash: this.deps.reportHashOf(scope.analysisId) ?? undefined };
    } catch (e) {
      ledger.markPosted(ev.commentId, contentHash, "", "FAILED", String((e as Error).message ?? e).slice(0, 200));
      return { ...base, kind: shaped.kind, outcome: "FAILED", reason: String((e as Error).message ?? e).slice(0, 200) };
    }
  }

  /**
   * Handle one comment event: authorise → parse → scope → answer → gate → post → record (§4). Idempotent per
   * (comment, content); an edited comment whose command text is unchanged is ignored (F14-A11).
   */
  async handleEvent(ev: PrChatEvent): Promise<PrChatReply> {
    const at = new Date(this.now()).toISOString();
    const base = { commentId: ev.commentId, headHash: ev.headHash, at };
    const ledger = this.deps.ledger;

    const parsed = parseChat(ev.body);
    if (parsed.type === "ignore") return { ...base, kind: "COMMAND", outcome: "SKIPPED", reason: "not a command" };
    // §11: the content key is the parsed command, so an edit that leaves the command unchanged is ignored,
    // while an edit that changes it is answered afresh (F14-A11).
    const contentHash = contentHashOf(JSON.stringify(parsed));
    if (ledger.row(ev.commentId, contentHash)) return { ...base, kind: "COMMAND", outcome: "SKIPPED", reason: "already answered (the parsed command is unchanged, so an edit that only touches prose is ignored)" };

    // F15: mutating feedback verbs take their own role-gated path (§7.1) — labels from viewers, mutes from editors.
    if (parsed.type === "command" && isFeedbackVerb(parsed.verb)) return this.handleFeedback(ev, parsed, contentHash, base);

    if (!(await this.authorised(ev))) {
      if (ledger.noticeAlreadySent(ev.prNumber, ev.author, "REFUSED", this.now())) return { ...base, kind: "REFUSED", outcome: "SKIPPED", reason: "refusal already sent" };
      const body = renderReply({ schemaVersion: 1, kind: "REFUSED", headHash: ev.headHash, claims: [], gaps: [], refusedReason: `Refused: ${mdCode(ev.author)} does not have write access to this repository, so CIE does not run commands for it (§10.1).` }, { commentId: ev.commentId });
      await this.deps.transport.postReply(ev.prNumber, ev.commentId, body);
      ledger.insert({ comment_id: ev.commentId, content_hash: contentHash, analysis_id: "", pr_number: ev.prNumber, repository: ev.repository, author: ev.author, head_hash: ev.headHash, kind: "REFUSED", outcome: "POSTED", reason: "not authorised", reply_id: null, report_hash: null, reply_body: body, idempotency_key: null, result_hash: null });
      return { ...base, kind: "REFUSED", outcome: "POSTED", reason: "not authorised" };
    }

    const limited = ledger.checkLimits(ev.prNumber, ev.author, this.limits, this.now());
    if (!limited.ok) {
      if (ledger.noticeAlreadySent(ev.prNumber, ev.author, `LIMIT_${limited.which}`, this.now())) return { ...base, kind: "REFUSED", outcome: "SKIPPED", reason: "limit notice already sent" };
      const what = limited.which === "pr" ? `this PR already has ${this.limits.maxRepliesPerPr} CIE replies` : `${mdCode(ev.author)} already used ${this.limits.maxCommandsPerUserPerHour} CIE commands this hour`;
      const body = renderReply({ schemaVersion: 1, kind: "REFUSED", headHash: ev.headHash, claims: [], gaps: [], refusedReason: `Refused: limit reached — ${what}; CIE stays silent until the window resets (§7.7).` }, { commentId: ev.commentId });
      await this.deps.transport.postReply(ev.prNumber, ev.commentId, body);
      ledger.insert({ comment_id: ev.commentId, content_hash: contentHash, analysis_id: "", pr_number: ev.prNumber, repository: ev.repository, author: ev.author, head_hash: ev.headHash, kind: `LIMIT_${limited.which}` as ReplyKind, outcome: "POSTED", reason: "limit", reply_id: null, report_hash: null, reply_body: body, idempotency_key: null, result_hash: null });
      return { ...base, kind: "REFUSED", outcome: "POSTED", reason: `limit ${limited.which}` };
    }

    const scope = this.deps.scopeFor(ev);
    if (!scope) {
      const body = renderReply({ schemaVersion: 1, kind: "REFUSED", headHash: ev.headHash, claims: [], gaps: [], refusedReason: `Analysis not ready for ${mdCode(ev.headHash.slice(0, 7))} — CIE answers only from the index at the comment's head (§14). Run the analysis and ask again.` }, { commentId: ev.commentId });
      await this.deps.transport.postReply(ev.prNumber, ev.commentId, body);
      ledger.insert({ comment_id: ev.commentId, content_hash: contentHash, analysis_id: "", pr_number: ev.prNumber, repository: ev.repository, author: ev.author, head_hash: ev.headHash, kind: "REFUSED", outcome: "POSTED", reason: "analysis not ready", reply_id: null, report_hash: null, reply_body: body, idempotency_key: null, result_hash: null });
      return { ...base, kind: "REFUSED", outcome: "POSTED", reason: "analysis not ready" };
    }

    let result: ChatShapedResult;
    if (parsed.type === "freeform") {
      if (!this.modelAvailable) {
        if (ledger.noticeAlreadySent(ev.prNumber, ev.author, "FREE_FORM", this.now())) return { ...base, kind: "FREE_FORM", outcome: "SKIPPED", reason: "explanation already sent" };
        result = { schemaVersion: 1, kind: "FREE_FORM", headHash: scope.headHash, claims: [{ class: "FOG", text: "Free-form questions need a locally installed model; deterministic commands work without one. /cie help lists them.", evidence: [] }], gaps: [] };
      } else {
        // S3 (not shipped): the question would run through chat-agent.ts here, wrapped as quoted data (§7.4).
        result = { schemaVersion: 1, kind: "FREE_FORM", headHash: scope.headHash, claims: [], gaps: [], refusedReason: "Free-form answering is not enabled in this build." };
      }
    } else {
      result = runChatCommand(this.deps.buildEnv(scope), parsed);
    }

    return this.postShaped(ev, scope, contentHash, base, result);
  }

  /** Poll one PR once: every new command comment gets exactly one reply (S2 watcher loop, §7.6). */
  async pollOnce(prNumber: number, since?: string): Promise<PrChatReply[]> {
    const events = await this.deps.transport.listComments(prNumber, since);
    const replies: PrChatReply[] = [];
    for (const ev of events) {
      if (ev.author === "cie[bot]" || ev.author === "github-actions[bot]") continue; // never answer ourselves
      replies.push(await this.handleEvent(ev));
    }
    return replies;
  }
}
