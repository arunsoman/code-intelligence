// C06: what the configuration and the surrounding artifacts say, joined to code, with every join graded. Routes, migrations, queue
// bindings and feature flags are read as declarations of intent: nothing here says what is deployed or enabled in any environment.
// A join that has one answer is RESOLVED; one with several is AMBIGUOUS and lists them; one with none is ABSENT. Nothing is guessed.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic, EvidenceRef } from "@cie/schema";
import { blank } from "./defect/source.ts";
import type { Store } from "./store.ts";

export type JoinStatus = "RESOLVED" | "RESOLVED_BY_NAME" | "AMBIGUOUS" | "ABSENT" | "INLINE";
export interface Artifact {
  id: string; kind: "route" | "table" | "queue" | "flag"; name: string;
  status: JoinStatus | "DECLARED_ONLY" | "USED_ONLY" | "CONFLICTING";
  /** What this was joined to: entity ids, files, or declarations. */
  joins: string[]; candidates: string[]; evidenceIds: string[]; detail: string;
  /** Always "UNKNOWN": a declaration is intent, not proof of what runs. */
  deployed: "UNKNOWN";
}
export interface ArtifactSet { revision: string; artifacts: Artifact[]; diagnostics: Diagnostic[]; notice: string }
const NOTICE = "These are declarations found in the repository. They are not evidence of what is deployed or enabled anywhere.";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function fileEvidence(store: Store, revision: string, root: string, file: string, start: number, end: number, cls: EvidenceRef["class"] = "STATIC_PARSED"): string {
  const buf = readFileSync(resolve(root, file));
  const ev: EvidenceRef = { id: "ev:" + sha(`${revision}|${file}|${start}|${end}|artifact`).slice(0, 16), sourceId: file, location: { kind: "CodeLocation", span: { sourceId: file, contentHash: sha(buf), revision, startByte: start, endByteExclusive: end } }, class: cls, observedAt: new Date().toISOString(), accessScopeId: "local", state: "CURRENT" };
  store.putEvidence(revision, ev);
  return ev.id;
}
const byteOf = (text: string, charIdx: number) => Buffer.byteLength(text.slice(0, charIdx), "utf8");
const read = (root: string, rel: string): string | null => { try { return readFileSync(resolve(root, rel), "utf8"); } catch { return null; } };
function walk(root: string, dir: string, re: RegExp, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let names: string[] = []; try { names = readdirSync(resolve(root, dir), { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)); } catch { return out; }
  for (const n of names.sort()) { if (n === "node_modules/" || n === ".git/" || n === "target/") continue; const p = join(dir, n.replace(/\/$/, "")); if (n.endsWith("/")) walk(root, p, re, out, depth + 1); else if (re.test(p)) out.push(p); }
  return out;
}

export function extractArtifacts(store: Store, revisionId: string): ArtifactSet {
  const rev = store.revision(revisionId); if (!rev) throw new Error("unknown revision");
  const root = rev.repoRoot;
  const artifacts: Artifact[] = []; const diagnostics: Diagnostic[] = [];
  const diag = (code: string, message: string, related: string[] = []) => diagnostics.push({ code, message, relatedEntityIds: related, retryable: false });
  const entities = store.entities(revisionId).filter((e) => ["function", "method"].includes(e.kind));
  const tsFiles = store.entities(revisionId).filter((e) => e.kind === "file" && /\.(ts|tsx)$/.test(e.file)).map((e) => e.file);
  const push = (a: Omit<Artifact, "deployed">) => artifacts.push({ ...a, deployed: "UNKNOWN" });

  // ------------------------------------------------------------------ routes
  const VERB = /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(["'`])([^"'`]+)\2\s*((?:,\s*[^()]*?|,\s*\([^)]*\)\s*=>[^)]*)*)\)\s*;?/g;
  for (const file of tsFiles) {
    const src = read(root, file); if (src === null) continue;
    const clean = blank(src, "ts", true);
    // Imports: local name -> module file, so a name that was imported is that file's function, not any function with that name.
    const imported = new Map<string, string>();
    for (const m of clean.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) for (const part of m[1].split(",")) { const [orig, alias] = part.trim().split(/\s+as\s+/); if (orig) imported.set((alias ?? orig).trim(), `${m[2]}|${orig.trim()}`); }
    VERB.lastIndex = 0;
    for (let m = VERB.exec(clean); m; m = VERB.exec(clean)) {
      const [whole, method, , path, rest] = m;
      const args = rest.replace(/^,\s*/, "");
      const parts = args.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
      const handlerSrc = parts.at(-1) ?? "";
      const middleware = parts.slice(0, -1);
      const ev = [fileEvidence(store, revisionId, root, file, byteOf(src, m.index), byteOf(src, m.index + whole.length))];
      const name = `${method.toUpperCase()} ${path}`;
      if (!handlerSrc) { push({ id: `route:${file}:${name}`, kind: "route", name, status: "ABSENT", joins: [], candidates: [], evidenceIds: ev, detail: "no handler is given" }); diag("ROUTE_NO_HANDLER", `${name} in ${file} names no handler.`); continue; }
      if (/=>|^function\b/.test(handlerSrc)) { push({ id: `route:${file}:${name}`, kind: "route", name, status: "INLINE", joins: [], candidates: [], evidenceIds: ev, detail: "handled by an inline function written at the registration" }); continue; }
      const ident = handlerSrc.replace(/\s+/g, "");
      const imp = imported.get(ident);
      const local = entities.filter((e) => e.file === file && e.name === ident);
      const cands = entities.filter((e) => e.name === ident || e.name.endsWith("." + ident));
      let status: Artifact["status"], joins: string[] = [], detail: string;
      if (imp) {
        const [mod, orig] = imp.split("|");
        const target = cands.filter((c) => c.name === orig && c.file.replace(/\.(ts|tsx)$/, "").endsWith(mod.replace(/^\.\//, "").replace(/^\.\.\//, "")));
        if (target.length === 1) { status = "RESOLVED"; joins = [target[0].entityId]; detail = `imported from ${mod}`; }
        else if (target.length > 1) { status = "AMBIGUOUS"; joins = []; detail = `${target.length} functions named ${orig} match the import`; }
        else { status = "ABSENT"; detail = `imported from ${mod}, but no function ${orig} is declared there`; }
      } else if (local.length === 1) { status = "RESOLVED"; joins = [local[0].entityId]; detail = "declared in the same file"; }
      else if (cands.length === 1) { status = "RESOLVED_BY_NAME"; joins = [cands[0].entityId]; detail = "matched by name only; it is not imported here"; }
      else if (cands.length > 1) { status = "AMBIGUOUS"; detail = `${cands.length} functions are named ${ident} and none is imported here`; }
      else { status = "ABSENT"; detail = `no function named ${ident} exists in the repository`; }
      push({ id: `route:${file}:${name}`, kind: "route", name, status, joins, candidates: status === "AMBIGUOUS" ? cands.map((c) => c.entityId).sort() : [], evidenceIds: ev, detail: middleware.length ? `${detail}; checks first: ${middleware.join(", ")}` : detail });
      if (status === "AMBIGUOUS") diag("ROUTE_HANDLER_AMBIGUOUS", `${name}: ${detail}.`, cands.map((c) => c.entityId));
      if (status === "ABSENT") diag("ROUTE_HANDLER_ABSENT", `${name}: ${detail}.`);
    }
  }

  // ---- routes in Java (Spring), Python (Flask / FastAPI) and Go (net/http, gin, chi, echo)
  {
    const allFiles = store.entities(revisionId).filter((e) => e.kind === "file").map((e) => e.file);
    const members = store.entities(revisionId).filter((e) => ["function", "method"].includes(e.kind));
    /** The function or method an annotation belongs to: the one whose span contains it (Java includes its annotations), else the first one after it (Python decorators). */
    const handlerAfter = (file: string, endByte: number) => members.filter((m) => m.file === file && (m.spans[0]?.startByte ?? 0) <= endByte && (m.spans[0]?.endByteExclusive ?? 0) > endByte).sort((a, b) => (a.spans[0].endByteExclusive - a.spans[0].startByte) - (b.spans[0].endByteExclusive - b.spans[0].startByte))[0] ?? members.filter((m) => m.file === file && (m.spans[0]?.startByte ?? 0) >= endByte).sort((a, b) => a.spans[0].startByte - b.spans[0].startByte)[0];
    const addRoute = (file: string, method: string, path: string, start: number, end: number, src: string, h: { entityId: string } | undefined, how: string) => {
      const name = `${method.toUpperCase()} ${path || "/"}`;
      const ev = [fileEvidence(store, revisionId, root, file, byteOf(src, start), byteOf(src, end))];
      push({ id: `route:${file}:${name}`, kind: "route", name, status: h ? "RESOLVED" : "ABSENT", joins: h ? [h.entityId] : [], candidates: [], evidenceIds: ev, detail: h ? how : "no handler follows this declaration" });
      if (!h) diag("ROUTE_HANDLER_ABSENT", `${name} in ${file}: no handler follows this declaration.`);
    };
    for (const file of allFiles.filter((f) => f.endsWith(".java"))) {
      const src = read(root, file); if (src === null) continue;
      const clean = blank(src, "ts", true);
      const base = /@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']*)["']/.exec(clean)?.[1] ?? "";
      for (const m of clean.matchAll(/@(Get|Post|Put|Delete|Patch|Request)Mapping(?:\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?["']([^"']*)["'][^)]*\))?/g)) {
        const isClassLevel = m[1] === "Request" && /\b(class|interface)\b/.test(clean.slice(m.index! + m[0].length, m.index! + m[0].length + 200).split("{")[0]);
        if (isClassLevel) continue;
        const method = m[1] === "Request" ? (/RequestMethod\.(\w+)/.exec(m[0])?.[1] ?? "ANY") : m[1];
        addRoute(file, method, `${base}${m[2] ?? ""}`, m.index!, m.index! + m[0].length, src, handlerAfter(file, byteOf(src, m.index! + m[0].length)), "Spring mapping on the method that follows");
      }
    }
    for (const file of allFiles.filter((f) => f.endsWith(".py"))) {
      const src = read(root, file); if (src === null) continue;
      const clean = blank(src, "ts", true).replace(/#[^\n]*/g, (c) => " ".repeat(c.length));
      for (const m of clean.matchAll(/^[ \t]*@(\w+)\.(get|post|put|delete|patch|route)\(\s*["']([^"']*)["']([^)]*)\)/gm)) {
        const method = m[2] === "route" ? (/methods\s*=\s*\[\s*["'](\w+)/.exec(m[4])?.[1] ?? "GET") : m[2];
        addRoute(file, method, m[3], m.index!, m.index! + m[0].length, src, handlerAfter(file, byteOf(src, m.index! + m[0].length)), "decorator on the function that follows");
      }
    }
    for (const file of allFiles.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))) {
      const src = read(root, file); if (src === null) continue;
      const clean = blank(src, "ts", true);
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      for (const m of clean.matchAll(/\b\w+\.(HandleFunc|Handle|GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\(\s*"([^"]*)"\s*,\s*([\w.]+)\s*\)/g)) {
        const method = /^(HandleFunc|Handle)$/.test(m[1]) ? "ANY" : m[1];
        const ident = m[3].split(".").pop()!;
        const cands = members.filter((x) => x.file.startsWith(dir) && x.file.replace(/[^/]*$/, "") === file.replace(/[^/]*$/, "") && (x.name === ident || x.name.endsWith("." + ident)));
        const ev = [fileEvidence(store, revisionId, root, file, byteOf(src, m.index!), byteOf(src, m.index! + m[0].length))];
        const name = `${method.toUpperCase()} ${m[2]}`;
        const status: Artifact["status"] = cands.length === 1 ? "RESOLVED" : cands.length > 1 ? "AMBIGUOUS" : "ABSENT";
        push({ id: `route:${file}:${name}`, kind: "route", name, status, joins: cands.length === 1 ? [cands[0].entityId] : [], candidates: cands.length > 1 ? cands.map((c) => c.entityId).sort() : [], evidenceIds: ev, detail: cands.length === 1 ? "handler declared in the same package" : cands.length ? `${cands.length} candidates in the package` : `no function named ${ident} in this package` });
        if (status === "ABSENT") diag("ROUTE_HANDLER_ABSENT", `${name}: no function named ${ident} in this package.`);
      }
    }
  }

  // ------------------------------------------------------------------ migrations -> tables
  const sqlFiles = walk(root, "migrations", /\.sql$/).concat(walk(root, "db/migrations", /\.sql$/)).sort();
  const schema = new Map<string, { created: string; dropped: string | null; columns: Set<string>; ev: string[] }>();
  for (const file of sqlFiles) {
    const sql = read(root, file); if (sql === null) continue;
    for (const m of sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([^;]*?)\)\s*;/gi)) {
      const ev = fileEvidence(store, revisionId, root, file, byteOf(sql, m.index!), byteOf(sql, m.index! + m[0].length));
      schema.set(m[1], { created: file, dropped: null, columns: new Set(m[2].split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean)), ev: [ev] });
    }
    for (const m of sql.matchAll(/\bALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+["`]?(\w+)/gi)) { const t = schema.get(m[1]); if (t) { t.columns.add(m[2]); t.ev.push(fileEvidence(store, revisionId, root, file, byteOf(sql, m.index!), byteOf(sql, m.index! + m[0].length))); } else diag("MIGRATION_ALTERS_UNKNOWN_TABLE", `${file} alters ${m[1]}, which no earlier migration creates.`); }
    for (const m of sql.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) { const t = schema.get(m[1]); if (t) { t.dropped = file; t.ev.push(fileEvidence(store, revisionId, root, file, byteOf(sql, m.index!), byteOf(sql, m.index! + m[0].length))); } }
  }
  const used = new Map<string, { file: string; start: number; end: number }[]>();
  for (const file of tsFiles) {
    const src = read(root, file); if (src === null) continue;
    for (const m of src.matchAll(/\b(?:db|knex|sql|client)\s*\.\s*(?:insert|update|delete|select|query|from|table)\s*\(\s*["'`](\w+)["'`]/g)) used.set(m[1], [...(used.get(m[1]) ?? []), { file, start: byteOf(src, m.index!), end: byteOf(src, m.index! + m[0].length) }]);
  }
  for (const [name, t] of schema) {
    const live = !t.dropped;
    const uses = used.get(name) ?? [];
    push({ id: `table:${name}`, kind: "table", name, status: !live ? "DECLARED_ONLY" : uses.length ? "RESOLVED" : "DECLARED_ONLY", joins: uses.map((u) => u.file), candidates: [], evidenceIds: [...t.ev, ...uses.map((u) => fileEvidence(store, revisionId, root, u.file, u.start, u.end))], detail: !live ? `created in ${t.created} and dropped in ${t.dropped}` : uses.length ? `created in ${t.created} (${[...t.columns].join(", ")}); used by ${[...new Set(uses.map((u) => u.file))].join(", ")}` : `created in ${t.created}; no code in this repository uses it` });
    if (!live && uses.length) diag("TABLE_USED_AFTER_DROP", `${name} is dropped by ${t.dropped}, but code still uses it.`);
  }
  for (const [name, uses] of used) if (!schema.has(name)) {
    push({ id: `table:${name}`, kind: "table", name, status: "ABSENT", joins: [], candidates: [], evidenceIds: uses.map((u) => fileEvidence(store, revisionId, root, u.file, u.start, u.end)), detail: sqlFiles.length ? "used by code, but no migration creates it" : "used by code; this repository has no migrations at all" });
    diag("TABLE_WITHOUT_MIGRATION", `${name} is used by code but no migration creates it.`);
  }

  // ------------------------------------------------------------------ queues
  const declared = new Map<string, { consumer?: string; file: string }>();
  for (const file of walk(root, "config", /queues?\.(json)$/).concat(walk(root, ".", /^queues?\.json$/))) {
    const text = read(root, file); if (!text) continue;
    try { for (const q of JSON.parse(text).queues ?? []) declared.set(q.topic, { consumer: q.consumer, file }); } catch { diag("QUEUE_CONFIG_UNREADABLE", `${file} could not be read; its queues are not known.`); }
  }
  const pubs = new Map<string, { file: string; start: number; end: number }[]>(), subs = new Map<string, { file: string; start: number; end: number }[]>();
  for (const file of tsFiles) {
    const src = read(root, file); if (src === null) continue;
    for (const m of src.matchAll(/\b(?:queue|bus|broker|events)\s*\.\s*(publish|subscribe|emit|on)\s*\(\s*["'`]([\w.:-]+)["'`]/g)) { const map = m[1] === "publish" || m[1] === "emit" ? pubs : subs; map.set(m[2], [...(map.get(m[2]) ?? []), { file, start: byteOf(src, m.index!), end: byteOf(src, m.index! + m[0].length) }]); }
  }
  for (const topic of [...new Set([...declared.keys(), ...pubs.keys(), ...subs.keys()])].sort()) {
    const p = pubs.get(topic) ?? [], s = subs.get(topic) ?? [], d = declared.get(topic);
    const ev = [...p, ...s].map((u) => fileEvidence(store, revisionId, root, u.file, u.start, u.end));
    const joins = [...new Set([...p, ...s].map((u) => u.file))];
    const parts: string[] = [];
    let status: Artifact["status"] = "RESOLVED";
    if (!d) { parts.push("not declared in any queue configuration"); status = "USED_ONLY"; }
    if (p.length && !s.length) { parts.push("published, but nothing in this repository subscribes"); if (status === "RESOLVED") status = "ABSENT"; diag("QUEUE_NO_SUBSCRIBER", `${topic} is published but has no subscriber in this repository${d?.consumer ? ` (the configuration names ${d.consumer}, which may live elsewhere)` : ""}.`); }
    if (s.length && !p.length) { parts.push("subscribed, but nothing in this repository publishes"); if (status === "RESOLVED") status = "ABSENT"; diag("QUEUE_NO_PUBLISHER", `${topic} is subscribed to but has no publisher in this repository.`); }
    if (d && !p.length && !s.length) { status = "DECLARED_ONLY"; parts.push(`declared (consumer ${d.consumer ?? "unnamed"}) but used by no code here`); }
    if (!d) diag("QUEUE_UNDECLARED", `${topic} is used in code but declared in no queue configuration.`);
    push({ id: `queue:${topic}`, kind: "queue", name: topic, status, joins, candidates: [], evidenceIds: ev, detail: parts.length ? parts.join("; ") : `${p.length} publisher(s), ${s.length} subscriber(s); declared in ${d!.file}` });
  }

  // ------------------------------------------------------------------ feature flags
  const defaults = new Map<string, { file: string; value: unknown }[]>();
  for (const file of walk(root, "config", /flags[\w.-]*\.json$/).concat(walk(root, ".", /^flags[\w.-]*\.json$/))) {
    const text = read(root, file); if (!text) continue;
    try { for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, { default?: unknown }>)) defaults.set(k, [...(defaults.get(k) ?? []), { file, value: v?.default }]); } catch { diag("FLAG_CONFIG_UNREADABLE", `${file} could not be read; its flags are not known.`); }
  }
  const flagUses = new Map<string, { file: string; start: number; end: number }[]>();
  for (const file of tsFiles) {
    const src = read(root, file); if (src === null) continue;
    for (const m of src.matchAll(/\bflags?\s*\.\s*(?:isEnabled|get|enabled|variation)\s*\(\s*["'`]([\w.:-]+)["'`]/g)) flagUses.set(m[1], [...(flagUses.get(m[1]) ?? []), { file, start: byteOf(src, m.index!), end: byteOf(src, m.index! + m[0].length) }]);
  }
  for (const flag of [...new Set([...defaults.keys(), ...flagUses.keys()])].sort()) {
    const d = defaults.get(flag) ?? [], u = flagUses.get(flag) ?? [];
    const values = new Set(d.map((x) => JSON.stringify(x.value)));
    const ev = u.map((x) => fileEvidence(store, revisionId, root, x.file, x.start, x.end));
    let status: Artifact["status"], detail: string;
    if (!d.length) { status = "ABSENT"; detail = "used by code, with no declared default in any configuration file, so what it is when unset is not known"; diag("FLAG_UNDECLARED", `${flag} is used in code but declared nowhere; its value is unknown.`); }
    else if (values.size > 1) { status = "CONFLICTING"; detail = `declared with different defaults: ${d.map((x) => `${x.file} says ${JSON.stringify(x.value)}`).join("; ")}; which applies depends on the environment, which this repository does not say`; diag("FLAG_DEFAULT_CONFLICT", `${flag}: ${detail}.`); }
    else if (!u.length) { status = "DECLARED_ONLY"; detail = `declared in ${d[0].file} but no code here reads it`; }
    else { status = "RESOLVED"; detail = `declared in ${d.map((x) => x.file).join(", ")} (default ${JSON.stringify(d[0].value)}) and read by ${[...new Set(u.map((x) => x.file))].join(", ")}`; }
    push({ id: `flag:${flag}`, kind: "flag", name: flag, status, joins: [...new Set(u.map((x) => x.file))], candidates: [], evidenceIds: ev, detail });
  }
  return { revision: revisionId, artifacts, diagnostics, notice: NOTICE };
}

/** The diagnostics alone, for callers that only want to know what is missing or unclear. */
export const validateArtifacts = (store: Store, revision: string): Diagnostic[] => extractArtifacts(store, revision).diagnostics;
