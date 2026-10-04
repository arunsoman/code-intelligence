// C25: security and policy findings from the code, graded by what is actually known. Each rule is versioned and cites the bytes it
// matched; a finding is a candidate until the alarm gate is satisfied (deterministic proof, or two authorised confirmations), and
// nothing here certifies anything: no finding is not "safe". A model's accusation is a candidate like any other.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "@cie/schema";
import { ALARM_ROLE, validateAlarm } from "./claim-ledger.ts";
import { blank } from "./defect/source.ts";
import { loadFunctions, spanEvidence, type Fn } from "./defect/functions.ts";
import { looksLikeIo } from "./defect/perf.ts";
import { entryPoints, guards, routes, sinks } from "./forms/analysis.ts";
import { claimOf, flowGraph, observation, short } from "./forms/common.ts";
import type { Store } from "./store.ts";
import { testsReaching } from "./testartifacts.ts";

export interface Rule { id: string; version: number; title: string; text: string; enabled?: boolean }
export const RULES: Record<string, Rule> = {
  "R-PII-LOG": { id: "R-PII-LOG", version: 1, title: "Sensitive data in logs", text: "A log call whose arguments include an identifier named like a secret or personal datum, not passed through a masking, hashing or length operation." },
  "R-AUTHZ-GAP": { id: "R-AUTHZ-GAP", version: 1, title: "State change without an authorisation check", text: "A request-handling entry point (takes a request parameter) reaches code that changes state through calls, with no check that can refuse it before the change." },
  "R-POLICY-MISSING": { id: "R-POLICY-MISSING", version: 1, title: "Required policy not declared", text: "A policy the task requires is not declared in policies/*.json, so there is nothing to enforce or audit against." },
};
const ruleDigest = (r: Rule) => createHash("sha256").update(JSON.stringify([r.id, r.version, r.title, r.text])).digest("hex").slice(0, 12);

export type FindingState = "CANDIDATE" | "ALARM";
export interface Finding {
  id: string; revision: string; ruleId: string; ruleVersion: number; ruleDigest: string;
  title: string; severity: "high" | "medium" | "low"; source: "RULE" | "MODEL";
  state: FindingState; superseded: boolean;
  summary: string; evidenceIds: string[]; claimId: string;
  /** What the finding depends on and what it does not say. */
  assumptions: string[]; counterArgument: string; disclaimer: string;
  subject: string;
}
const DISCLAIMER = "A finding is a candidate from static analysis. No finding does not mean safe, and nothing here certifies compliance.";

const SENSITIVE = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|ssn|card(?:number|num)?|cvv|iban|email|phone|dob|birthdate)/i;
const WRITE_VERB = /^(save|saveAll|saveAndFlush|delete|deleteById|deleteAll|update|insert|upsert|execute|executemany|executeUpdate|Exec|ExecContext|Create|Update|Delete|Save|commit|add|merge|persist|remove|bulk_create)$/;
const SECRET_KIND = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|ssn|cvv|card)/i;
const SANITIZER = /^(?:len|size|count|length|hash\w*|mask\w*|redact\w*|digest|sha\w*|md5|encrypt\w*|anonym\w*|truncate\w*|fingerprint\w*|typeof|Boolean|String\.length)$/i;
// Loggers in the languages we read: console / logger / log objects, Java's System.out and SLF4J-style `log.info`, Go's log and fmt printers
// and Python's logging and print. `print(` and `fmt.Print*` write to the process output, which is where logs go.
const LOGGER_RECEIVERS = ["console", "logger", "log", "LOG", "LOGGER", "logging", "slog", "zap", "glog", "klog"];
const LOG_METHODS = ["log", "info", "warn", "warning", "error", "debug", "trace", "fatal", "critical", "exception", "printf", "println", "print", "Printf", "Println", "Print", "Infof", "Info", "Warnf", "Warn", "Errorf", "Error", "Debugf", "Debug", "Fatalf", "Fatal", "Panicf", "Panic"];
const LOGGER_FACTORY = /^(?:LoggerFactory|LogFactory|logrus|zap|slog|logging)$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Names that refer to a logger in this text: `const out = console`, `const l = logger.child(...)`,
 * destructured `const { info } = logger`, Python `log = logging.getLogger(...)`, and plain
 * reassignment. Only simple, local assignments are followed; anything indirect stays unresolved and
 * therefore unreported, as before.
 */
export function loggerAliases(src: string): { receivers: Set<string>; methods: Set<string> } {
  const receivers = new Set<string>();
  const methods = new Set<string>();
  const isLogger = (expr: string): boolean => {
    const parts = expr.replace(/\s+/g, "").split(".").filter(Boolean);
    if (!parts.length) return false;
    if (parts[0] === "System" && (parts[1] === "out" || parts[1] === "err")) return true;
    return receivers.has(parts[0]) || LOGGER_RECEIVERS.includes(parts[0]) || LOGGER_FACTORY.test(parts[0]);
  };
  // const out = console / let l = logger.child("x") / final Logger log = LoggerFactory.getLogger(...)
  for (const m of src.matchAll(/\b(?:const|let|var|final|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([A-Za-z_$][\w$.]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g)) if (isLogger(m[2])) receivers.add(m[1]);
  // plain reassignment: out = console
  for (const m of src.matchAll(/(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*)\s*[;\n]/g)) if (isLogger(m[2])) receivers.add(m[1]);
  // destructuring: const { info, error: e } = logger
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$.]*)/g)) {
    if (!isLogger(m[2])) continue;
    for (const part of m[1].split(",")) { const name = part.trim().split(/\s*:\s*/).pop()?.trim() ?? ""; if (/^[A-Za-z_$][\w$]*$/.test(name)) methods.add(name); }
  }
  // python: log = logging.getLogger(__name__)
  for (const m of src.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:logging|log)\s*\.\s*getLogger\s*\(/g)) receivers.add(m[1]);
  return { receivers, methods };
}

function logCallRegex(aliases: { receivers: Set<string>; methods: Set<string> }): RegExp {
  const names = [...LOGGER_RECEIVERS, "System\\s*\\.\\s*(?:out|err)", ...[...aliases.receivers].map(escapeRe)];
  const methods = LOG_METHODS.map(escapeRe).join("|");
  const bare = [...aliases.methods].map(escapeRe).join("|");
  const parts = [`(?:[\\w$]+\\s*\\.\\s*)*(?:${names.join("|")})\\s*\\.\\s*(?:${methods})`, `fmt\\s*\\.\\s*(?:Printf|Println|Print|Fprintf|Fprintln|Fprint)`, `print`];
  if (bare) parts.push(bare);
  return new RegExp(`\\b(?:${parts.join("|")})\\s*\\(`, "g");
}
/** Expressions inside f-strings and template literals: `f"user {email}"` and `${email}` carry the value even though the string content is blanked. */
const interpolations = (text: string, lang: string): string => {
  const out: string[] = [];
  if (lang === "python") for (const m of text.matchAll(/\b[fF][rR]?(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) for (const e of m[2].matchAll(/\{([^{}!:]+)/g)) out.push(e[1]);
  if (lang === "ts" || lang === "java") for (const m of text.matchAll(/`((?:[^`\\]|\\.)*)`/g)) for (const e of m[1].matchAll(/\$\{([^}]+)\}/g)) out.push(e[1]);
  return out.join(" , ");
};

function balancedEnd(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === "(") d++; else if (s[i] === ")") { d--; if (d === 0) return i; } }
  return -1;
}

/** Sensitive identifiers that reach a log call's arguments unsanitised. Comments and string contents are blanked first, so words inside them never match. */
export function sensitiveLogArgs(src: string, lang: "ts" | "rust" | "java" | "go" | "python" = "ts"): { at: number; end: number; ids: string[] }[] {
  const clean = blank(src, lang);
  const out: { at: number; end: number; ids: string[] }[] = [];
  const LOG_CALL = logCallRegex(loggerAliases(clean));
  LOG_CALL.lastIndex = 0;
  for (let m = LOG_CALL.exec(clean); m; m = LOG_CALL.exec(clean)) {
    const open = m.index + m[0].length - 1, close = balancedEnd(clean, open);
    if (close < 0) continue;
    const args = clean.slice(open + 1, close) + " , " + interpolations(src.slice(open + 1, close), lang);
    const ids: string[] = [];
    for (const c of args.matchAll(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g)) {
      const chain = c[0].replace(/\s+/g, "");
      const segs = chain.split(".");
      if (!segs.some((s) => SENSITIVE.test(s))) continue;
      if (segs.at(-1) === "length") continue; // a size is not the secret
      // Wrapped in a sanitizer: the nearest call that encloses it is a masking, hashing or similar function.
      const before = args.slice(0, c.index!).replace(/\s+$/, "");
      const enclosing = /([A-Za-z_$][\w$.]*)\s*\($/.exec(before);
      if (enclosing && SANITIZER.test(enclosing[1].split(".").pop()!)) continue;
      if (SANITIZER.test(segs[0]) && segs.length === 1) continue;
      ids.push(chain);
    }
    if (ids.length) out.push({ at: m.index, end: close + 1, ids: [...new Set(ids)] });
  }
  return out;
}


// ---- Which functions take requests, and which are protected by a declaration rather than by a call the graph could see.
const fileCache = new Map<string, string | null>();
const fileText = (root: string, rel: string): string | null => { const k = `${root}|${rel}`; if (!fileCache.has(k)) { try { fileCache.set(k, readFileSync(join(root, rel), "utf8")); } catch { fileCache.set(k, null); } } return fileCache.get(k)!; };
/** The decorator lines directly above a Python function (they are outside the function's own span). */
const decoratorsAbove = (root: string, fn: Fn): string => {
  const t = fileText(root, fn.file); if (!t) return "";
  const before = Buffer.from(t, "utf8").subarray(0, fn.start).toString("utf8").split("\n"); const out: string[] = [];
  for (let i = before.length - 1; i >= 0 && out.length < 8; i--) { const l = before[i].trim(); if (l === "") continue; if (l.startsWith("@") || /^[\w.]+\(.*\)[,)]*$/.test(l) || l.startsWith(")")) out.unshift(l); else break; }
  return out.join("\n");
};
const ROUTE_DECORATOR = /@\w+\.(?:get|post|put|delete|patch|route|websocket|api_route)\s*\(/;
const JAVA_MAPPING = /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\b/;
const GO_HANDLER_SIG = /\(\s*(?:\w+\s+)?(?:http\.ResponseWriter\s*,\s*\w*\s*\*?http\.Request|\*?gin\.Context|echo\.Context|\*?fiber\.Ctx|\*?fasthttp\.RequestCtx)/;
export function isRequestHandler(root: string, fn: Fn): boolean {
  if (fn.lang === "java") return JAVA_MAPPING.test(fn.src.slice(0, fn.src.indexOf("{") >= 0 ? fn.src.indexOf("{") : 400)) || /@(?:KafkaListener|RabbitListener|JmsListener|SqsListener)\b/.test(fn.src.slice(0, 300));
  if (fn.lang === "go") return GO_HANDLER_SIG.test(fn.src.slice(0, fn.src.indexOf("{") >= 0 ? fn.src.indexOf("{") : 300));
  if (fn.lang === "python") return ROUTE_DECORATOR.test(decoratorsAbove(root, fn)) || /\b(?:request|req)\b/.test(fn.src.slice(0, fn.src.indexOf(")") + 1));
  return /\b(?:req|request|ctx|event)\b/.test(fn.src.slice(0, fn.src.indexOf(")") + 1));
}
/**
 * Handlers that a declaration protects: Spring's @PreAuthorize / @Secured / @RolesAllowed (on the method or its class), Python decorators
 * such as @login_required, FastAPI `Depends(...)` on auth dependencies, and Go handlers registered through an auth-named wrapper or
 * under a router that `.Use(...)`s an auth middleware. A declaration is a claim that the framework enforces it, so each is shown as a guard, not proof.
 */
export function securedByDeclaration(root: string, fns: Map<string, Fn>): Set<string> {
  const out = new Set<string>();
  const AUTH = /(?:auth|login_required|jwt|permission|require\w*|protect|guard|secure|rbac|acl|session_required|token_required)/i;
  for (const fn of fns.values()) {
    if (fn.lang === "java") {
      const t = fileText(root, fn.file) ?? "";
      const classLevel = /@(?:PreAuthorize|Secured|RolesAllowed)\b[^]*?\b(?:class|interface)\s+\w+/.exec(t.slice(0, Math.max(0, t.indexOf(fn.src.slice(0, 40)))))?.[0].length;
      if (/@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed|PermitAll)\b/.test(fn.src.slice(0, 400)) || classLevel) out.add(fn.entity.entityId);
    } else if (fn.lang === "python") {
      const d = decoratorsAbove(root, fn);
      if (/@[\w.]*(?:login_required|jwt_required|permission_required|requires_auth|auth_required|token_required|requires_roles?|roles_required|authenticated)\b/i.test(d) || /Depends\s*\([^)]*(?:auth|current_user|permission|token|security)/i.test(d + " " + fn.src.slice(0, fn.src.indexOf(")") + 1))) out.add(fn.entity.entityId);
    } else if (fn.lang === "go") {
      const t = fileText(root, fn.file) ?? ""; const name = fn.entity.name.split(".").pop()!;
      const wrapped = new RegExp(`\\b(\\w+)\\s*\\(\\s*${name}\\s*\\)`, "g");
      for (const m of t.matchAll(wrapped)) if (AUTH.test(m[1]) && /(?:Handle|HandleFunc|GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\s*\(/.test(t.slice(Math.max(0, m.index! - 120), m.index!))) out.add(fn.entity.entityId);
      if (/\.Use\s*\(\s*[\w.]*(?:auth|Auth|jwt|JWT|session|Session|token|Token|Protect|protect|Guard|guard)/.test(t) && new RegExp(`\\b${name}\\b`).test(t.replace(/func[^\n]*\n/g, ""))) out.add(fn.entity.entityId);
    }
  }
  return out;
}

export interface AnalyzeRequest { revision: string; policyIds?: string[]; rules?: Record<string, Rule> }

export class Security {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }

  private persist(f: Finding) {
    this.store.db.prepare("insert or replace into sec_findings values (?,?,?,?,?,?,?,?,?)").run(f.id, f.revision, f.ruleId, f.ruleVersion, f.ruleDigest, f.state, f.superseded ? 1 : 0, JSON.stringify(f), new Date().toISOString());
  }
  get(id: string): Finding | null { const r = this.store.db.prepare("select json, superseded from sec_findings where id = ?").get(id) as any; return r ? { ...JSON.parse(r.json), superseded: !!r.superseded } : null; }
  list(revision: string, opts: { includeSuperseded?: boolean } = {}): Finding[] {
    return (this.store.db.prepare("select json, superseded from sec_findings where revision = ? order by created_at, id").all(revision) as any[]).filter((r) => opts.includeSuperseded || !r.superseded).map((r) => ({ ...JSON.parse(r.json), superseded: !!r.superseded }));
  }

  private mk(rev: { id: string }, rule: Rule, subject: string, over: Pick<Finding, "title" | "severity" | "summary" | "evidenceIds" | "assumptions" | "counterArgument"> & { source?: Finding["source"] }): Finding {
    const claim = claimOf(this.store, rev.id, { assertion: over.summary, claimClass: "security-finding", evidenceIds: over.evidenceIds, rationaleSummary: `Rule ${rule.id}@${rule.version}: ${rule.text}` });
    const id = "fnd:" + createHash("sha256").update([rev.id, rule.id, rule.version, subject].join("|")).digest("hex").slice(0, 14);
    const prior = this.get(id);
    return { id, revision: rev.id, ruleId: rule.id, ruleVersion: rule.version, ruleDigest: ruleDigest(rule), title: over.title, severity: over.severity, source: over.source ?? "RULE", state: prior?.state ?? "CANDIDATE", superseded: false, summary: over.summary, evidenceIds: claim.draft.evidenceIds, claimId: claim.draft.id, assumptions: over.assumptions, counterArgument: over.counterArgument, disclaimer: DISCLAIMER, subject };
  }

  analyze(req: AnalyzeRequest): Finding[] {
    const store = this.store, rev = store.revision(req.revision);
    if (!rev) throw new Error("unknown revision");
    const rules = { ...RULES, ...(req.rules ?? {}) };
    const out: Finding[] = [];
    // A rule whose version changed since an earlier analysis: its older findings stay readable but are marked superseded.
    for (const r of Object.values(rules)) store.db.prepare("update sec_findings set superseded = 1 where revision = ? and rule_id = ? and rule_version < ?").run(rev.id, r.id, r.version);

    const fns = loadFunctions(store, rev);
    const flow = flowGraph(store, rev.id);
    // ---- R-PII-LOG
    const pii = rules["R-PII-LOG"];
    if (pii && pii.enabled !== false) for (const fn of [...fns.values()].sort((a, b) => a.entity.entityId.localeCompare(b.entity.entityId))) {
      if (fn.file.includes("test")) continue;
      for (const hit of sensitiveLogArgs(fn.src, fn.lang)) {
        const ev = spanEvidence(store, rev, fn as Fn, hit.at, hit.end - hit.at);
        const secret = hit.ids.some((i) => SECRET_KIND.test(i));
        out.push(this.mk(rev, pii, `${fn.entity.entityId}@${hit.at}`, { title: pii.title, severity: secret ? "high" : "medium", summary: `${short(fn.entity.entityId)} logs ${hit.ids.join(", ")} without masking it.`, evidenceIds: [ev.id], assumptions: ["the log output is persisted or shipped somewhere", "the named value carries what its name says"], counterArgument: "The identifier may hold a non-sensitive value despite its name, or the logger may redact it downstream; neither is visible in the code." }));
      }
    }
    // ---- R-AUTHZ-GAP
    const authz = rules["R-AUTHZ-GAP"];
    if (authz && authz.enabled !== false) {
      const g = guards(store, rev.id, flow), s = new Map(sinks(store, rev.id));
      // Persistence calls change state too: `repository.save(x)`, `db.Exec(...)`, `cursor.execute(...)`. They are sinks even though no field is assigned.
      for (const fn of fns.values()) for (const c of fn.scan.calls) if (WRITE_VERB.test(c.method ?? c.name) && c.receiver && looksLikeIo(c) && !s.has(fn.entity.entityId)) { const ev = spanEvidence(store, rev, fn as Fn, c.at, Math.min(80, c.text.length)); s.set(fn.entity.entityId, { fields: new Set([`${c.receiver}.${c.method}`]), evidenceIds: [ev.id], inTx: false }); }
      const protectedFns = securedByDeclaration(rev.repoRoot, fns);
      const entries = entryPoints(flow).filter((e) => { const fn = fns.get(e.id); return !!fn && isRequestHandler(rev.repoRoot, fn) && !protectedFns.has(e.id) && !fn.file.includes("test"); });
      const all = routes(flow, entries, new Set(s.keys()), new Set(g.keys())).filter((r) => !r.gates.length);
      // One finding per entry point: a route to a deeper writer says more than the entry being a writer itself.
      const deeper = new Set(all.filter((r) => r.entry.id !== r.sink).map((r) => r.entry.id));
      for (const r of all) {
        if (r.entry.id === r.sink && deeper.has(r.entry.id)) continue;
        const ev = [...new Set([...r.rels.flatMap((x) => x.evidence.map((e) => e.id)), ...(s.get(r.sink)?.evidenceIds ?? [])])];
        out.push(this.mk(rev, authz, `${r.entry.id}>${r.sink}`, { title: authz.title, severity: "high", summary: r.entry.id === r.sink ? `${short(r.entry.id)} changes ${[...s.get(r.sink)!.fields].join(", ")}, and nothing before it can refuse the caller.` : `${short(r.entry.id)} reaches ${short(r.sink)}, which changes ${[...s.get(r.sink)!.fields].join(", ")}, and nothing on the way can refuse the caller.`, evidenceIds: ev, assumptions: ["the entry point is reachable by callers who are not the owner", "a refusal elsewhere (a gateway, middleware outside this repository) is not in the code"], counterArgument: "A proxy, gateway or framework middleware outside the analysed code may already check the caller." }));
      }
    }
    // ---- R-POLICY-MISSING
    const polRule = rules["R-POLICY-MISSING"];
    const declared = this.declaredPolicies(rev.repoRoot);
    if (polRule && polRule.enabled !== false) for (const id of req.policyIds ?? []) if (!declared.has(id)) {
      const ev = observation(store, rev.id, `policy-absent:${id}`, "DOCUMENT", "policies/", `The policy ${id} is not declared in any policies/*.json of this repository.`).id;
      out.push(this.mk(rev, polRule, id, { title: polRule.title, severity: "medium", summary: `The required policy ${id} is not declared, so nothing in this repository says what must hold or can be audited against it.`, evidenceIds: [ev], assumptions: ["policies are meant to be declared in policies/*.json"], counterArgument: "The policy may be held elsewhere (a wiki, a platform repository) and enforced there." }));
    }
    for (const f of out) this.persist(f);
    return out;
  }

  declaredPolicies(root: string): Map<string, { id: string; rule: string; text: string }> {
    const m = new Map<string, { id: string; rule: string; text: string }>();
    const p = join(root, "policies/security.json");
    if (existsSync(p)) { try { for (const x of JSON.parse(readFileSync(p, "utf8")).policies ?? []) m.set(x.id, x); } catch { /* unreadable: nothing declared */ } }
    return m;
  }

  /** The policies a repository declares, each with what the rules found against it. A policy with no findings is "none found", not "met". */
  policyStatus(revision: string): { id: string; text: string; rule: string; findings: number; status: "VIOLATION_CANDIDATES" | "NONE_FOUND" }[] {
    const rev = this.store.revision(revision)!;
    const fs = this.list(revision);
    return [...this.declaredPolicies(rev.repoRoot).values()].map((p) => { const n = fs.filter((f) => f.ruleId === p.rule).length; return { ...p, findings: n, status: n ? "VIOLATION_CANDIDATES" as const : "NONE_FOUND" as const }; });
  }

  /** What a finding was found by: the rule as it was when it fired, and whether that rule has since changed. */
  ruleTrace(findingId: string, current: Record<string, Rule> = RULES) {
    const f = this.get(findingId);
    if (!f) return null;
    const now = current[f.ruleId];
    return { findingId, ruleId: f.ruleId, firedUnderVersion: f.ruleVersion, firedUnderDigest: f.ruleDigest, currentVersion: now?.version ?? null, currentDigest: now ? ruleDigest(now) : null, changedSince: !!now && (now.version !== f.ruleVersion || ruleDigest(now) !== f.ruleDigest), superseded: f.superseded, evidenceIds: f.evidenceIds };
  }

  /** A model's accusation enters as a candidate with the evidence class it actually has, and can only leave that state through the gate. */
  proposeFromModel(revision: string, draft: { title: string; summary: string; evidenceIds: string[] }): Finding {
    const rev = this.store.revision(revision)!;
    const rule: Rule = { id: "MODEL-PROPOSED", version: 1, title: draft.title, text: "Proposed by a language model; unverified." };
    const f = this.mk(rev, rule, draft.summary, { title: draft.title, severity: "medium", summary: draft.summary, evidenceIds: draft.evidenceIds, assumptions: ["the model read the cited code correctly"], counterArgument: "A model's reading is an inference; nothing here confirmed it.", source: "MODEL" });
    this.persist(f);
    return f;
  }

  /** C16's alarm rule applied to a security finding: deterministic proof, or two authorised confirmations from distinct people. */
  gateSecurityAlarm(findingId: string, req: { proofEvidenceIds: string[] }): { ok: boolean; finding: Finding; basis: string; reasons: string[] } {
    const f = this.get(findingId);
    if (!f) throw new Error("unknown finding");
    const claim = this.store.getClaim(f.claimId) as Claim;
    const d = validateAlarm(this.store, claim, req.proofEvidenceIds);
    const next: Finding = { ...f, state: d.eligible ? "ALARM" : "CANDIDATE" };
    this.persist(next);
    return { ok: d.eligible, finding: next, basis: d.basis, reasons: d.reasons };
  }

  /**
   * An invariant is supported only by tests that reach the code and pass, with the assumptions stated; one that fails is a
   * counterexample; with no tests, or only an argument, it is not established. Nothing here says "proven".
   */
  checkInvariant(revision: string, req: { entityIds: string[]; testIds?: string[] }) {
    const reaching = req.entityIds.flatMap((id) => testsReaching(this.store, revision, id));
    const pool = req.testIds?.length ? reaching.filter((t) => req.testIds!.includes(t.testId)) : reaching;
    const unique = [...new Map(pool.map((t) => [t.testId, t])).values()];
    const failing = unique.filter((t) => t.status === "failed"), passing = unique.filter((t) => t.status === "passed");
    const assumptions = ["the tests assert the property, not merely run the code", "the test environment resembles production", ...(passing.length ? [`${passing.length} passing test(s) reach the code through at most three calls`] : [])];
    const status = failing.length ? "COUNTEREXAMPLE" : passing.length ? "SUPPORTED_BY_TESTS" : "NOT_ESTABLISHED";
    const reason = failing.length ? `${failing.map((t) => t.name).join(", ")} fail${failing.length === 1 ? "s" : ""} on code the invariant covers.` : passing.length ? "Tests that reach this code pass. That is support, not proof." : "No test reaches this code; an argument without a test or a verifier is not proof.";
    return { status, reason, tests: unique.map((t) => ({ name: t.name, status: t.status, evidenceIds: t.evidenceIds })), assumptions, proof: false as const, disclaimer: DISCLAIMER };
  }

  /** Audit narrative: findings with their evidence, the controls found, and what could not be checked. Inference labels are kept. */
  buildAuditNarrative(revision: string, findingIds: string[]): { markdown: string; findings: number; missingControls: string[] } {
    const fs = findingIds.map((id) => this.get(id)).filter((f): f is Finding => !!f && f.revision === revision);
    const status = this.policyStatus(revision);
    const missing = fs.filter((f) => f.ruleId === "R-POLICY-MISSING").map((f) => f.subject);
    const lines = ["# Security findings (candidates)", "", DISCLAIMER, ""];
    for (const f of fs) lines.push(`## ${f.title} — ${f.state === "ALARM" ? "alarm (gate satisfied)" : "candidate (inference, not confirmed)"}`, "", f.summary, "", `- Rule: ${f.ruleId}@${f.ruleVersion} (${f.ruleDigest})`, `- Evidence: ${f.evidenceIds.join(", ")}`, `- Assumes: ${f.assumptions.join("; ")}`, `- Counter-argument: ${f.counterArgument}`, "");
    lines.push("## Policies", "", ...status.map((p) => `- ${p.id}: ${p.status === "NONE_FOUND" ? "no violation candidates found (this is not a statement that it is met)" : `${p.findings} violation candidate(s)`}`), ...missing.map((m) => `- ${m}: not declared`), "");
    return { markdown: lines.join("\n"), findings: fs.length, missingControls: missing };
  }
}
export { ALARM_ROLE };
