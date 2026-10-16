// The read-only tools a chat model may call, declared once: each has a name, what it is for, and a JSON schema for its
// arguments. The prompt, the schema sent to the model and argument checking are all generated from this list, so adding a
// tool is one entry here, not another rule in a prompt and another branch in a validator. Every tool reports what it saw in
// a short text the model reads next, and the ids of the code elements in it — the only ids an answer may cite.
import { createHash } from "node:crypto";
import {traceEntities} from "./evidence-trace.ts";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CallContext, ChatAnalysisResult, Entity } from "@cie/schema";
import type { AccessPolicy } from "./access.ts";
import type { ChatStep } from "./chat-plan.ts";
import { executeChatPlan } from "./chat-execution.ts";
import { coveredChildren } from "./source-coverage.ts";
import { sourceCandidates } from "./code-search.ts";
import { resolveMentions } from "./mentions.ts";
import { retrieveForQuestion } from "./retrieval.ts";
import { renderIrs } from "./irfirst.ts";  // IR-first pull tools (ir_of); similar_of/concept_of dynamic-import the rest
import type { Service } from "./service.ts";
import type { RevisionRow } from "./store.ts";
import { VISUALS } from "./visuals.ts";

export interface ToolEnv {
  svc: Service; ctx: CallContext; rev: RevisionRow; access: AccessPolicy; pins?: string[]; currentSubject?: string;
  /** F14 §7.3: inside a PR, "this"/"the change"/"it" resolve to the changed entity set; revision defaults to the PR head. */
  prScope?: import("./pr-chat.ts").PrScope;
  /** Code elements some tool has shown the model; an answer may cite only these. */
  seen: Map<string, { name: string; file: string }>;
  /** Analyses with a view, in call order, for the "Show …" buttons. */
  results: ChatAnalysisResult[];
  /** Source intervals actually delivered, distinct from symbols merely discovered. */
  sourceReads?: Map<string, { total: number; contentHash: string; ranges: [number, number][] }>;
  /** Entities whose semantic IR was rendered with ir_of: inspected structurally, though literal values,
   * exact types and comments remain unseen until read_code escalates to the source (the IR-first ladder). */
  irReads?: Set<string>;
  warnings: string[];
}
export type JsonSchema = { type: "object"; properties: Record<string, { type: "string" | "integer" | "array"; description?: string; enum?: string[]; maxLength?: number; items?: { type: "string" }; maxItems?: number }>; required: string[]; additionalProperties: false };
export interface ChatTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Absent for the tools the conversation loop handles itself (answer, not_analysis). */
  run?: (env: ToolEnv, args: Record<string, unknown>) => Promise<string>;
}

const MAX_SOURCE_LINES = 320, MAX_SOURCE_CHARS = 14000, MAX_LINKS = 20;
const FORMS = VISUALS.filter((v) => v.formId !== "HypothesisGraph");

const str = (description: string, extra: { enum?: string[]; maxLength?: number } = {}) => ({ type: "string" as const, description, maxLength: 1000, ...extra });
const obj = (properties: JsonSchema["properties"], required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

/** Arguments that do not fit the tool's own schema are refused, with the reason the model reads back. */
export function checkArgs(schema: JsonSchema, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be a JSON object";
  const a = args as Record<string, unknown>;
  for (const k of schema.required) if (a[k] === undefined || a[k] === "") return `missing required argument "${k}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = schema.properties[k];
    if (!p) return `unknown argument "${k}"`;
    if (v === undefined || v === null) continue;
    if (p.type === "string" && (typeof v !== "string" || v.length > (p.maxLength ?? 1000))) return `"${k}" must be a string of at most ${p.maxLength ?? 1000} characters`;
    if (p.type === "integer" && !Number.isInteger(v)) return `"${k}" must be an integer`;
    if (p.type === "array" && (!Array.isArray(v) || v.length > (p.maxItems ?? 20) || v.some((x) => typeof x !== "string"))) return `"${k}" must be a list of at most ${p.maxItems ?? 20} strings`;
    if (p.enum && !p.enum.includes(v as string)) return `"${k}" must be one of: ${p.enum.join(", ")}`;
  }
  return null;
}

const note = (env: ToolEnv, e: Pick<Entity, "entityId" | "name" | "file">) => { env.seen.set(e.entityId, { name: e.name, file: e.file }); return e.entityId; };
// The id itself already contains the file path (`kind:file#name`, or `file:path` for a file entity), so repeating
// it here would only duplicate what's inside the brackets; kind and name are kept since a file entity's id has no
// `#name` suffix to recover its name from.
const line = (env: ToolEnv, e: Pick<Entity, "entityId" | "name" | "file" | "kind">) => `- [${note(env, e)}] ${e.kind} ${e.name}`;

/** The entity an argument names: its id, or a name looked up the same way a question's mentions are. */
function entityFor(env: ToolEnv, ref: string): Entity | null {
  const { svc, rev, access } = env;
  const byId = svc.store.entitiesById(rev.id, [ref])[0];
  if (byId) return access.denied(byId.file) ? null : byId;
  const hit = resolveMentions(svc.store, rev.id, ref, access).resolved[0]?.matches[0];
  return hit ? svc.store.entitiesById(rev.id, [hit.entityId])[0] ?? null : null;
}

function sourceOf(rev: RevisionRow, e: Entity, access: AccessPolicy): { startLine: number; endLine: number; text: string; stale: boolean; contentHash: string } | null {
  const span = e.spans[0];
  if (!span) return null;
  const path = resolve(rev.repoRoot, span.sourceId), rel = relative(rev.repoRoot, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  let buf: Buffer;
  try {
    const root = realpathSync(rev.repoRoot), physical = realpathSync(path);
    const physicalRel = relative(root, physical);
    if (physicalRel === ".." || physicalRel.startsWith("../") || isAbsolute(physicalRel) || access.denied(physicalRel)) return null;
    buf = readFileSync(physical);
  } catch { return null; }
  const contentHash = createHash("sha256").update(buf).digest("hex");
  const stale = contentHash !== span.contentHash;
  // File entities may carry a zero-length location span rather than a whole-file span.
  const startLine = e.kind === "file" ? 1 : buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
  const text = (e.kind === "file" ? buf : buf.subarray(span.startByte, span.endByteExclusive)).toString("utf8");
  return { startLine, endLine: startLine + text.split("\n").length - 1, text, stale, contentHash };
}

/** Page relative to the entity span; even a single very long line can be continued without losing text. */
export function sourcePage(text: string, offset = 0): { text: string; nextOffset?: number } {
  const rest = text.slice(offset);
  const lines = rest.split("\n");
  const page = lines.slice(0, MAX_SOURCE_LINES).join("\n").slice(0, MAX_SOURCE_CHARS);
  const end = offset + page.length;
  return { text: page, ...(end < text.length ? { nextOffset: end } : {}) };
}

/** Upgrade saved coverage using the same hash-verified source and delivered ranges.
 * This derives child coverage from old checkpoints without spending duplicate tool calls. */
export function restoreContainedCoverage(env: ToolEnv): void {
  const saved = [...(env.sourceReads ?? [])];
  const parents = env.svc.store.entitiesById(env.rev.id, saved.map(([id]) => id));
  const children = env.svc.store.entities(env.rev.id).filter(e => !env.access.denied(e.file));
  for (const parent of parents) {
    if (env.access.denied(parent.file) || !["file", "class", "interface"].includes(parent.kind)) continue;
    const read = env.sourceReads!.get(parent.entityId)!, source = sourceOf(env.rev, parent, env.access);
    if (!source || source.stale || source.contentHash !== read.contentHash || source.text.length !== read.total) continue;
    for (const { entity, total } of coveredChildren(parent, source.text, read, children)) {
      note(env, entity);
      env.sourceReads!.set(entity.entityId, { total, contentHash: source.contentHash, ranges: [[0, total]] });
    }
  }
}

/** Run one existing analysis step (the same code the scripted planner runs) and report it to the model. Exported so
 * the agent loop can also call it directly, outside any tool call, to guarantee a view (see chat-agent.ts). */
export async function analysis(env: ToolEnv, step: ChatStep): Promise<string> {
  if (step.subject && env.access.denied(step.subject)) return "That subject is not accessible to this user.";
  const r = await executeChatPlan(env.svc, env.ctx, env.rev, { steps: [step] }, env.currentSubject, env.pins);
  if (!r.ok) return `Failed: ${r.error.message}`;
  if (r.value.kind !== "analysis") return "No analysis was produced.";
  env.warnings.push(...r.metadata.warnings);
  const result = r.value.results[0];
  if (!result) return "No analysis was produced.";
  if (result.status !== "complete") return `${result.status}: ${result.message}`;
  env.results.push(result);
  const nodes = (result.view?.nodes ?? []).filter((n) => n.tier !== "HIDDEN" && !n.ghost && n.entityRefs[0]).slice(0, 15);
  const elements = nodes.map((n) => `- [${note(env, { entityId: n.entityRefs[0], name: n.label, file: n.file ?? "" })}] ${n.label}${n.file ? ` — ${n.file}` : ""}`);
  return [`${result.title}${result.subject ? ` (subject: ${result.subject})` : ""}:`, result.message.slice(0, 4000), ...(elements.length ? ["Elements shown:", ...elements] : [])].join("\n");
}

export const CHAT_TOOLS: ChatTool[] = [
  {
    name: "find_code",
    description: "Find classes, functions, methods and files by name or by what they are about. Use it to locate something before reading it, or when a name in the question did not resolve.",
    parameters: obj({ query: str("A name, partial name or a few words describing the code") }, ["query"]),
    async run(env, { query }) {
      // A lexical name/path hit is not treated as authoritative on its own: the broader relevance
      // retrieval (semantic/task-match, concept-aware) always runs too, and either corroborates a
      // direct hit or flags it as resting on a generic word alone — this is what keeps an unrelated
      // same-repo match (a test fixture, another package's same-named helper) from being presented
      // as an established answer just because it matched text.
      const q = query as string;
      const named = resolveMentions(env.svc.store, env.rev.id, q, env.access).resolved.flatMap((m) => m.matches);
      const direct = sourceCandidates(env.svc.store, env.rev.id, q, env.access);
      const r = retrieveForQuestion(env.svc.store, env.rev.id, q, { access: env.access, maxNodes: 12 });
      const corroborated = (id: string) => (r.scored.get(id)?.score ?? 0) > 0;
      const confirmed = direct.filter(e => corroborated(e.entityId));
      const uncorroborated = direct.filter(e => !corroborated(e.entityId));
      const related = r.bundle.entities.filter((e) => e.kind !== "file" && !direct.some(d => d.entityId === e.entityId) && r.scored.get(e.entityId)?.factors.some((f) => f.factor === "TASK_MATCH" && f.normalizedScore > 0))
        .sort((a, b) => (r.scored.get(b.entityId)?.score ?? 0) - (r.scored.get(a.entityId)?.score ?? 0));
      const all = [...new Map([...named.map((m) => ({ entityId: m.entityId, name: m.name, file: m.file, kind: m.kind })), ...related].map((e) => [e.entityId, e])).values()].slice(0, 6);
      const sections: string[] = [];
      // Result caps keep each observation small: the model pays for every line in every later turn, and
      // beyond the first handful it rarely reads deeper — a focused follow-up find_code is cheaper.
      if (confirmed.length) sections.push(`${confirmed.length} indexed name/path match(es) for "${q}", also supported by the broader relevance retrieval (read implementations to establish relevance):`, ...confirmed.slice(0, 6).map(e => line(env, e)));
      if (uncorroborated.length) sections.push(`${uncorroborated.length} name/path match(es) for "${q}" on generic/common terms only; nothing else in this investigation supports them as belonging to this question's domain — verify the implementation's actual subject before relying on it:`, ...uncorroborated.slice(0, 4).map(e => line(env, e)));
      if (all.length) sections.push(`${all.length} tentative semantic candidate(s) for "${q}"; these are not established domain matches:`, ...all.slice(0, 5).map(e => line(env, e)));
      return sections.length ? sections.join("\n") : `Nothing in this revision matches "${q}".`;
    },
  },
  {
    name: "read_code",
    description: "Read one class, function, method or file: its source, what it contains, what calls it and what it calls. Read code before saying what it does. If a next offset is returned, continue reading with that offset to inspect the rest.",
    parameters: obj({ id: str("An id from an earlier result, or the exact name of the element"), offset: { type: "integer", description: "Character offset within the entity source; use the next offset returned by a prior read (default 0)" } }, ["id"]),
    async run(env, { id, offset = 0 }) {
      if (!Number.isSafeInteger(offset) || Number(offset) < 0) return "Refused: offset must be a nonnegative safe integer.";
      const e = entityFor(env, id as string);
      if (!e) return `No accessible element is called or identified by "${id}". Try find_code.`;
      const { svc, rev, access } = env;
      note(env, e);
      const rels = svc.store.relationshipsFor(rev.id, e.entityId);
      const others = new Map(svc.store.entitiesById(rev.id, [...new Set(rels.flatMap((r) => [r.from, r.to]))]).map((x) => [x.entityId, x]));
      const linked = (pick: (r: (typeof rels)[number]) => string | null) => {
        const ids = [...new Set(rels.map(pick).filter((x): x is string => !!x && x !== e.entityId))];
        const shown = ids.map((x) => others.get(x)).filter((x): x is Entity => !!x && !access.denied(x.file));
        return { lines: shown.slice(0, MAX_LINKS).map((x) => line(env, x)), more: Math.max(0, shown.length - MAX_LINKS), unresolved: ids.length - shown.length };
      };
      const sections: string[] = [];
      const section = (title: string, l: ReturnType<typeof linked>) => { if (l.lines.length) sections.push(`${title}:`, ...l.lines, ...(l.more ? [`  … and ${l.more} more`] : [])); };
      section("Contains", linked((r) => (r.kind === "contains" && r.from === e.entityId ? r.to : null)));
      section("Called by", linked((r) => (r.kind === "calls" && r.to === e.entityId ? r.from : null)));
      section("Calls", linked((r) => (r.kind === "calls" && r.from === e.entityId ? r.to : null)));
      section("Imported by", linked((r) => (r.kind === "imports" && r.to === e.entityId ? r.from : null)));
      const src = sourceOf(rev, e, access);
      if (src?.stale) return "Source changed since indexing. Reindex this repository before reading this element; indexed symbol offsets and relationships may no longer describe the current file.";
      if (src && Number(offset) > src.text.length) return "Refused: offset is past the end of the entity source.";
      const page = src ? sourcePage(src.text, Number(offset)) : null;
      const inherited: Entity[] = [];
      if (src && page) {
        env.sourceReads ??= new Map();
        const previous = env.sourceReads.get(e.entityId);
        const read = previous?.contentHash === src.contentHash ? previous : { total: src.text.length, contentHash: src.contentHash, ranges: [] };
        read.ranges.push([Number(offset), Number(offset) + page.text.length]);
        read.ranges.sort((a, b) => a[0] - b[0]);
        env.sourceReads.set(e.entityId, read);
        if (["file", "class", "interface"].includes(e.kind)) {
          const children = svc.store.entities(rev.id).filter(child => !access.denied(child.file));
          for (const { entity, total } of coveredChildren(e, src.text, read, children)) {
            note(env, entity);
            env.sourceReads.set(entity.entityId, { total, contentHash: src.contentHash, ranges: [[0, total]] });
            inherited.push(entity);
          }
        }
      }
      svc.store.audit(env.ctx.actor.principalId, "chat.read", rev.id, { entity: e.entityId });
      return [
        `[${e.entityId}] ${e.kind} ${e.name} — ${e.file}${src ? `:${src.startLine}-${src.endLine}` : ""}`,
        src ? `\`\`\`\n${page!.text}\n\`\`\`` : "(source text unavailable)",
        ...(page?.nextOffset !== undefined ? [`Source continues: call read_code with id=${JSON.stringify(e.entityId)} and offset=${page.nextOffset}.`] : []),
        ...(inherited.length ? ["Contained implementations fully covered by these source pages:", ...inherited.slice(0, 8).map(child => `[${child.entityId}] ${child.name}`)] : []),
        sections.join("\n").slice(0, 4500),
      ].join("\n");
    },
  },
  {
    name: "show_view",
    description: `Build one analysis view over the code (the user also sees it as a picture). Forms:\n${FORMS.map((v) => `  ${v.formId}: ${v.blurb}`).join("\n")}`,
    parameters: obj({
      form: str("Which view", { enum: FORMS.map((v) => v.formId) }),
      question: str("What this view should answer, in the user's words"),
      subject: str("Optional file, module or element the view is about", { maxLength: 300 }),
      kind: str("CausalGraph only: failure for errors, invariant for wrong values", { enum: ["failure", "invariant"] }),
    }, ["form", "question"]),
    run: (env, a) => analysis(env, { tool: "view", form: a.form as string, question: a.question as string, ...(a.kind ? { kind: a.kind as "failure" | "invariant" } : {}), ...(a.subject ? { subject: a.subject as string } : {}), ...(a.subject ? { seeds: seedsFor(env, a.subject as string) } : {}) }),
  },
  {
    name: "read_module",
    description: "Inspect a named indexed component, module, package or subsystem. Returns its indexed file and symbol counts, package layout, and representative classes/interfaces. Use this for named component introductions; use project_overview only for the entire repository.",
    parameters: obj({ module: str("Component, module, package, or directory name", { maxLength: 300 }) }, ["module"]),
    async run(env, { module }) {
      const all = env.svc.store.entities(env.rev.id).filter((e) => !env.access.denied(e.file));
      const files = [...new Set(all.map((e) => e.file).filter(Boolean))];
      const requested = String(module).toLowerCase().replace(/\\/g, "/").replace(/\b(component|module|package|subsystem|service)\b/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
      const dirs = new Set<string>();
      for (const file of files) {
        const parts = file.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      const candidates = [...dirs].map((path) => {
        const tail = path.split("/").at(-1)!.toLowerCase();
        const exact = requested.some((term) => term === tail);
        const pathMatch = requested.length > 1 && path.toLowerCase().endsWith(requested.join("/"));
        const count = files.filter((file) => file.startsWith(`${path}/`)).length;
        return { path, exact, pathMatch, count, depth: path.split("/").length };
      }).filter((x) => x.exact || x.pathMatch).sort((a, b) => Number(b.pathMatch) - Number(a.pathMatch) || b.count - a.count || a.depth - b.depth || a.path.localeCompare(b.path));
      const scope = candidates[0]?.path;
      if (!scope) return `No indexed directory matches "${String(module)}". Use find_code to locate the component or provide its directory name.`;
      const scopedFiles = new Set(files.filter((file) => file === scope || file.startsWith(`${scope}/`)));
      const scoped = all.filter((e) => scopedFiles.has(e.file));
      const byDir = new Map<string, number>();
      for (const file of scopedFiles) {
        const rest = file.slice(scope.length).replace(/^\//, "");
        const child = rest.split("/")[0] || ".";
        byDir.set(child, (byDir.get(child) ?? 0) + 1);
      }
      const symbols = scoped.filter((e) => ["class", "interface", "function", "method"].includes(e.kind));
      const priority = /engine|service|manager|controller|consumer|processor|writer|reserve|posting|rollback|impl|job|listener/i;
      const representative = [...symbols].sort((a, b) => Number(priority.test(b.name)) - Number(priority.test(a.name)) || ["class", "interface"].indexOf(a.kind) - ["class", "interface"].indexOf(b.kind) || a.file.localeCompare(b.file) || a.name.localeCompare(b.name)).slice(0, 24);
      const counts = new Map<string, number>();
      for (const e of scoped) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      const lines = [
        `Indexed component scope: ${scope}`,
        `Coverage: ${scopedFiles.size} files; ${scoped.length} indexed entities (${counts.get("class") ?? 0} classes, ${counts.get("interface") ?? 0} interfaces, ${counts.get("method") ?? 0} methods, ${counts.get("test") ?? 0} tests). This is index coverage, not a claim that every file was read in full.`,
        `Package layout: ${[...byDir].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([dir, count]) => `${dir}/ (${count})`).join(", ")}`,
        "Representative indexed symbols:",
        ...representative.map((e) => `- [${note(env, e)}] ${e.kind} ${e.name} — ${e.file}`),
      ];
      return lines.join("\n");
    },
  },
  {
    name: "project_overview",
    description: "Explain the whole project: its purpose, structure and architecture.",
    parameters: obj({ question: str("What the user asked about the project") }, ["question"]),
    run: (env, a) => analysis(env, { tool: "overview", question: a.question as string }),
  },
  {
    name: "change_risk",
    description: "Rank production source files by composite change risk (a relative heuristic, not a probability); reports the highest-ranked file.",
    parameters: obj({ question: str("What the user asked about risk") }, ["question"]),
    run: (env, a) => analysis(env, { tool: "risk", question: a.question as string }),
  },
  {
    name: "find_tests",
    description: "Find tests linked to a source file, separating static call paths from measured coverage. Without a subject, uses the current subject or reports general test confidence.",
    parameters: obj({ question: str("What the user asked about tests"), subject: str("A source file path (as find_code or read_code reported it)", { maxLength: 300 }) }, ["question"]),
    run: (env, a) => analysis(env, { tool: "tests", question: a.question as string, ...(a.subject ? { subject: fileFor(env, a.subject as string) } : {}) }),
  },
  {
    name: "get_routes",
    description: "List framework HTTP routes (method + path) extracted from Spring, NestJS, Express, Next.js, or Spring Cloud Gateway. Optionally filter by method, path fragment, or framework.",
    parameters: obj({ method: str("HTTP method to filter by, e.g. GET or POST", { maxLength: 12 }), path: str("Path fragment to filter by, e.g. /users", { maxLength: 200 }), framework: str("Framework name to filter by, e.g. spring or nestjs", { maxLength: 30 }) }, []),
    async run(env, { method, path, framework }) {
      const routes = env.svc.store.factsByPredicate(env.rev.id, "route").map((f) => {
        const v = (f.object as { value?: { method?: string; path?: string; handler?: string; framework?: string; kind?: string } }).value ?? {};
        return { id: f.subject, method: String(v.method ?? "").toUpperCase(), path: String(v.path ?? ""), handler: String(v.handler ?? ""), framework: v.framework, kind: v.kind };
      }).filter((r) => r.path || r.method);
      const filtered = routes.filter((r) =>
        (!method || r.method === String(method).toUpperCase()) &&
        (!path || r.path.toLowerCase().includes(String(path).toLowerCase())) &&
        (!framework || String(r.framework ?? "").toLowerCase() === String(framework).toLowerCase()));
      if (!filtered.length) return `No framework routes matched${method ? ` method ${method}` : ""}${path ? ` path ${path}` : ""}${framework ? ` framework ${framework}` : ""}.`;
      const entities = new Map(env.svc.store.entitiesById(env.rev.id, filtered.map((r) => r.id)).map((e) => [e.entityId, e]));
      for (const r of filtered) env.seen.set(r.id, { name: `${r.method} ${r.path}`, file: entities.get(r.id)?.file ?? "" });
      return [`${filtered.length} route(s):`, ...filtered.map((r) => `- [${r.id}] ${r.method} ${r.path} — ${r.framework ? `${r.framework} ` : ""}${r.handler || r.kind || "handler"}`)].join("\n");
    },
  },
  {
    name: "get_guards",
    description: "List framework guards and which routes they protect. Optionally filter by route id/name or guard name.",
    parameters: obj({ route: str("Route id or name to focus on", { maxLength: 300 }), guard: str("Guard name fragment to filter by", { maxLength: 100 }) }, []),
    async run(env, { route, guard }) {
      const store = env.svc.store;
      const rev = env.rev.id;
      const entities = new Map(store.entities(rev).map((e) => [e.entityId, e]));
      const routes = store.factsByPredicate(rev, "route").map((f) => {
        const v = (f.object as { value?: { method?: string; path?: string; handler?: string; framework?: string; kind?: string } }).value ?? {};
        return { id: f.subject, method: String(v.method ?? "").toUpperCase(), path: String(v.path ?? ""), handler: String(v.handler ?? ""), framework: v.framework };
      }).filter((r) => r.path || r.method);
      const guards = store.factsByPredicate(rev, "framework_role").filter((f) => (f.object as { value?: { role?: string } }).value?.role === "guard").map((f) => {
        const v = (f.object as { value?: { role?: string; framework?: string; name?: string } }).value ?? {};
        const e = entities.get(f.subject);
        return { id: f.subject, name: v.name || (e?.name ?? f.subject), framework: v.framework, evidenceIds: f.evidence.map((e) => e.id) };
      });
      let targetRouteId: string | null = null;
      if (route) {
        const re = entityFor(env, route as string);
        targetRouteId = re?.entityId ?? routes.find((r) => `${r.method} ${r.path}`.toLowerCase() === String(route).toLowerCase() || r.path.toLowerCase().includes(String(route).toLowerCase()))?.id ?? null;
      }
      const filtered = guards.filter((g) => (!guard || g.name.toLowerCase().includes(String(guard).toLowerCase())));
      const rels = store.allRelationships(rev);
      const applies = (g: typeof guards[number], r: typeof routes[number]) => {
        if (g.id === r.id) return true;
        const exposes = rels.find((rel) => rel.kind === "exposes_route" && rel.to === r.id);
        if (g.id === exposes?.from) return true;
        return rels.some((rel) => rel.kind === "contains" && rel.to === r.id && rel.from === g.id);
      };
      const out: string[] = [];
      for (const g of filtered) {
        env.seen.set(g.id, { name: g.name, file: entities.get(g.id)?.file ?? "" });
        const covered = routes.filter((r) => applies(g, r) && (!targetRouteId || r.id === targetRouteId));
        out.push(`- [${g.id}] ${g.name}${g.framework ? ` (${g.framework} guard)` : ""}`);
        if (covered.length) out.push(...covered.slice(0, 12).map((r) => `  • ${r.method} ${r.path}`));
        else if (targetRouteId) out.push(`  • does not protect the requested route`);
        else out.push(`  • no matching routes found`);
      }
      if (!filtered.length) return targetRouteId ? "No framework guards protect that route." : "No framework guards found.";
      return out.join("\n");
    },
  },
  {
    name: "get_module_graph",
    description: "Show the framework module / dependency-injection graph: modules, controllers, providers, and what they import or inject. Optionally focus on one module id or name.",
    parameters: obj({ module: str("Module id or name to focus on", { maxLength: 300 }) }, []),
    async run(env, { module }) {
      const store = env.svc.store;
      const rev = env.rev.id;
      const entities = new Map(store.entities(rev).map((e) => [e.entityId, e]));
      const modules = store.factsByPredicate(rev, "framework_role").filter((f) => (f.object as { value?: { role?: string } }).value?.role === "module").map((f) => {
        const e = entities.get(f.subject);
        return { id: f.subject, name: e?.name ?? f.subject, file: e?.file ?? "" };
      });
      const root = module ? (entityFor(env, module as string)?.entityId ?? modules.find((m) => m.name.toLowerCase() === String(module).toLowerCase())?.id) : undefined;
      const relevant = root ? [root] : modules.map((m) => m.id);
      const rels = store.allRelationships(rev).filter((r) => ["contains", "injects", "imports"].includes(r.kind));
      const lines: string[] = [];
      for (const id of relevant) {
        const e = entities.get(id);
        env.seen.set(id, { name: e?.name ?? id, file: e?.file ?? "" });
        lines.push(`- [${id}] ${e?.name ?? id}${e?.file ? ` — ${e.file}` : ""}`);
        const children = rels.filter((r) => r.from === id && r.kind === "contains").slice(0, 20);
        for (const c of children) {
          const ce = entities.get(c.to);
          env.seen.set(c.to, { name: ce?.name ?? c.to, file: ce?.file ?? "" });
          lines.push(`  • contains [${c.to}] ${ce?.name ?? c.to} (${c.label ?? "member"})`);
        }
        const injects = rels.filter((r) => r.from === id && r.kind === "injects").slice(0, 20);
        for (const i of injects) {
          const ie = entities.get(i.to);
          env.seen.set(i.to, { name: ie?.name ?? i.to, file: ie?.file ?? "" });
          lines.push(`  • injects [${i.to}] ${ie?.name ?? i.to}${i.label ? ` (${i.label})` : ""}`);
        }
        const imports = rels.filter((r) => r.from === id && r.kind === "imports").slice(0, 20);
        for (const i of imports) {
          const ie = entities.get(i.to);
          env.seen.set(i.to, { name: ie?.name ?? i.to, file: ie?.file ?? "" });
          lines.push(`  • imports [${i.to}] ${ie?.name ?? i.to}`);
        }
      }
      if (!lines.length) return "No framework module graph found.";
      return lines.join("\n");
    },
  },
  {
    name: "ir_of",
    description: "Read a function or method's semantic IR — a deterministic pseudocode of what it does: calls, guards (`when:`/`loop:`), assignments. Locals, literals values ($t) are private; x.[?] is a computed field; x += y is a compound write. Cheaper and language-uniform vs read_code — prefer it for structure questions; escalate to read_code when literal values, comments or exact types matter.",
    parameters: obj({ id: str("An id from an earlier result, or the exact name of the element") }, ["id"]),
    async run(env, { id }) {
      const e = entityFor(env, id as string);
      if (!e) return `No accessible element is called or identified by "${id}". Try find_code.`;
      if (!(e.irDump ?? "").length) return `No stored IR for [${e.entityId}] (files and data-only elements have none). Use read_code for its source.`;
      const [r] = renderIrs([{ entityId: e.entityId, name: e.name, file: e.file, irDump: e.irDump! }]);
      note(env, e);
      (env.irReads ??= new Set()).add(e.entityId); // IR-tier inspection: citable without a source read
      env.svc.store.audit(env.ctx.actor.principalId, "chat.ir", env.rev.id, { entity: e.entityId });
      return [`${e.kind} ${e.name} (${e.file}) — semantic IR:`, r?.render ?? "(render failed)", "Cite [" + e.entityId + "] when you use this; read_code shows the source when literals or types matter."].join("\n");
    },
  },
  {
    name: "similar_of",
    description: "List the structurally nearest stored symbols to one element — 'code shaped like this', by the indexed IR vectors, stable across renames and languages. Use it to find near-duplicates, copies of a pattern, or where else this logic lives.",
    parameters: obj({ id: str("An id from an earlier result, or the exact name of the element"), topK: { type: "integer", description: "How many results (1-50, default 8)" } }, ["id"]),
    async run(env, { id, topK = 8 }) {
      const e = entityFor(env, id as string);
      if (!e) return `No accessible element is called or identified by "${id}". Try find_code.`;
      note(env, e);
      const { similarOf } = await import("./irfirst.ts");
      const hits = similarOf(env.svc.store, env.rev.id, e.entityId, Number.isInteger(Number(topK)) ? Number(topK) : 8).filter((x) => !env.access.denied(x.file));
      if (!hits.length) return `No structural neighbors are in the index yet for [${e.entityId}] (vectors index functions/methods with stored IR).`;
      const lines = [];
      const byId = new Map(env.svc.store.entitiesById(env.rev.id, hits.map((h) => h.entityId)).map((x) => [x.entityId, x]));
      for (const h of hits) {
        const he = byId.get(h.entityId);
        if (he) lines.push(`  ${Math.round(h.similarity * 100)}% ${line(env, he)}`);
      }
      return [`${hits.length} structural neighbor(s) of [${e.entityId}] (similarity is approximate, not identity):`, ...lines].join("\n");
    },
  },
  {
    name: "concept_of",
    description: "Read a concept card: a named group of related code pieces (e.g. a duplicated logic family or an inferred concept) with each member's semantic IR. Concept ids and names come from earlier results or the concept store. Use it to answer at the level of 'this concept' rather than file by file.",
    parameters: obj({ concept: str("A concept id from an earlier result, or a name fragment to search by") }, ["concept"]),
    async run(env, { concept }) {
      const q = (concept as string).trim().toLowerCase();
      const clusters = env.svc.store.conceptClusters(env.rev.id);
      const hit = clusters.find((c) => c.conceptId.toLowerCase() === q)
        ?? clusters.find((c) => (c.name ?? "").toLowerCase() === q)
        ?? clusters.find((c) => (c.name ?? "").toLowerCase().includes(q));
      if (!hit) return `No concept matches "${concept}". Concepts exist for near-duplicate families and inferred groupings; a concept search (C11/listConcepts) may help.`;
      const { conceptIrView } = await import("./irfirst.ts");
      const card = conceptIrView(env.svc.store, env.rev.id, hit.conceptId, { maxMembers: 12 });
      if (!card) return `Concept "${hit.conceptId}" is not attached to this revision (its members may have been re-indexed).`;
      const byId = new Map(env.svc.store.entitiesById(env.rev.id, card.members.map((m) => m.entityId)).map((x) => [x.entityId, x]));
      const body = card.members.flatMap((m) => {
        const e = byId.get(m.entityId);
        if (!e || env.access.denied(e.file)) return [];
        note(env, e);
        return [`[${m.entityId}] ${e.name} (${e.file})`, ...(m.render ? ["```", m.render.split("\n").slice(1).join("\n"), "```"] : ["(member without stored IR)"])];
      });
      env.svc.store.audit(env.ctx.actor.principalId, "chat.concept_ir", env.rev.id, { concept: hit.conceptId });
      return [`Concept [${card.conceptId}]${card.name ? ` “${card.name}”` : ""} (${card.kind}; ${card.renderedCount}/${card.members.length} members carry IR):`, ...body].join("\n");
    },
  },
  {
    name: "get_config",
    description: "Read configuration values extracted by the framework config resolver (package.json, .env, application.yml/properties, tsconfig.json, pom.xml). Secrets are redacted.",
    parameters: obj({ key: str("Key fragment to filter by, e.g. DATABASE_URL or spring.datasource", { maxLength: 200 }), source: str("Source file fragment, e.g. .env or application.yml", { maxLength: 100 }) }, []),
    async run(env, { key, source }) {
      const store = env.svc.store;
      const rev = env.rev.id;
      const facts = store.factsByPredicate(rev, "config_value");
      const filtered = facts.filter((f) => {
        const v = (f.object as { value?: { key?: string; source?: string } }).value ?? {};
        return (!key || String(v.key ?? "").toLowerCase().includes(String(key).toLowerCase())) && (!source || String(v.source ?? "").toLowerCase().includes(String(source).toLowerCase()));
      });
      if (!filtered.length) return "No matching config values found.";
      return [`${filtered.length} config value(s):`, ...filtered.map((f) => {
        const v = (f.object as { value?: { key: string; source: string; value?: unknown; redacted?: unknown; framework?: string } }).value ?? { key: "?", source: "?" };
        const shown = v.redacted !== undefined ? String(v.redacted) : v.value !== undefined ? String(v.value) : "(redacted)";
        return `- ${v.key} = ${shown} (${v.source}${v.framework ? `, ${v.framework}` : ""})`;
      })].join("\n");
    },
  },
  {
    name: "duplicates",
    description: "Scan the whole indexed system for duplicate code in ONE call — no anchor needed. Returns exact-shape clone groups (identical IR fingerprint, may be unrelated-by-name) and near-duplicate pairs with their diff summaries. Use for 'are there duplicates / find duplicate code' questions. For questions about one element use similar_of/similar_to instead.",
    parameters: obj({ minPct: { type: "integer", description: "Optional near-duplicate threshold as a percent, 0..100 (default 85)" } }, []),
    async run(env, { minPct }) {
      const { cloneScan } = await import("./irfirst.ts");
      const minSimilarity = Number.isInteger(Number(minPct)) ? Math.min(100, Math.max(0, Number(minPct))) / 100 : undefined;
      const scan = cloneScan(env.svc.store, env.rev.id, { minSimilarity, maxGroups: 12, maxPairs: 16 });
      const body: string[] = [];
      let shown = 0;
      const byId = new Map(env.svc.store.entitiesById(env.rev.id, scan.exactGroups.flatMap((g) => g.members.map((e) => e.entityId))).map((e) => [e.entityId, e]));
      // A scan hit is an IR inspection (fingerprint and vectors are computed from the stored IR), and the top
      // group's bodies are rendered so the model sees what it claims about; everything still passes the
      // independent claim verifier, which re-checks each citation against the store and the live source.
      for (const g of scan.exactGroups) for (const e of g.members) if (byId.has(e.entityId) && !env.access.denied(byId.get(e.entityId)!.file)) note(env, byId.get(e.entityId)!), (env.irReads ??= new Set()).add(e.entityId);
      const rendered = new Set<string>();
      if (scan.exactGroups.length) {
        const top = scan.exactGroups[0].members.map((e) => byId.get(e.entityId)!).filter((e) => e && !env.access.denied(e.file)).slice(0, 4);
        const { renderIrs } = await import("./irfirst.ts");
        for (const [i, r] of renderIrs(top.map((e) => ({ entityId: e.entityId, name: e.name, file: e.file, irDump: e.irDump ?? "" }))).entries()) {
          byId.get(r.entityId)!.irDump && rendered.add(r.entityId);
          if (r.render) rendered.add(r.entityId), body.push(`IR of [${r.entityId}]:`, "```", r.render.split("\n").slice(1).join("\n"), "```");
          if (i === 3) break;
        }
      }
      for (const g of scan.exactGroups) {
        const members = g.members.flatMap((e) => { const hit = byId.get(e.entityId); return hit && !env.access.denied(hit.file) ? [hit] : []; });
        if (!members.length) continue;
        shown += members.length;
        body.push(`Identical IR (${members.length} copies):`, ...members.map((e) => `  [${e.entityId}] ${line(env, e)}`));
      }
      const pairFiles = new Map(env.svc.store.entitiesById(env.rev.id, scan.nearPairs.flatMap((p) => [p.a, p.b])).map((e) => [e.entityId, e]));
      const pairs: string[] = [];
      for (const p of scan.nearPairs) {
        const a = pairFiles.get(p.a), b = pairFiles.get(p.b);
        if (!a || !b || env.access.denied(a.file) || env.access.denied(b.file)) continue;
        note(env, a); note(env, b);
        (env.irReads ??= new Set()).add(a.entityId); (env.irReads ??= new Set()).add(b.entityId);
        shown += 2;
        pairs.push(`  ${Math.round(p.similarity * 100)}% [${a.entityId}] ↔ [${b.entityId}]${p.diff ? ` — ${p.diff}` : ""}`);
      }
      env.svc.store.audit(env.ctx.actor.principalId, "chat.clone_scan", env.rev.id, { groups: body.filter(Boolean).length, pairs: pairs.length, minSimilarity } as Record<string, unknown>);
      if (!body.length && !pairs.length) return `No duplicate code found: the whole indexed revision was scanned (every element's IR fingerprint and every near-duplicate pair at ≥${Math.round((typeof minSimilarity === "number" ? minSimilarity : 0.85) * 100)}%). A scan finding absence — the answer is the scan itself, not a search that came up short.`;
      return [`${shown} element(s) in duplicate candidates — exact-shape groups are identity modulo slot-normalized names; pairs are the concept stage's proved near-duplicates:`, ...body, ...(pairs.length ? ["Near-duplicates:", ...pairs] : [])].join("\n");
    },
  },
  {
    name: "similar_to",
    description: "Find code structurally similar to a NAMED element, without needing its id first: a name (or fragment) is resolved, then the rename-stable structural neighborhood is listed. Same ground as similar_of with mention resolution built in.",
    parameters: obj({ name: str("The element's name, id, or a close fragment, e.g. AuthService", { maxLength: 300 }), topK: { type: "integer", description: "How many results (1-50, default 8)" } }, ["name"]),
    async run(env, { name, topK }) {
      const anchor = entityFor(env, (name as string).trim());
      if (!anchor) return `No accessible element is called or identified by "${name}". Try find_code.`;
      note(env, anchor);
      (env.irReads ??= new Set()).add(anchor.entityId);
      const { similarOf } = await import("./irfirst.ts");
      const hits = similarOf(env.svc.store, env.rev.id, anchor.entityId, Number.isInteger(Number(topK)) ? Number(topK) : 8).filter((x) => !env.access.denied(x.file));
      if (!hits.length) return `[${anchor.entityId}] is resolved but has no structural neighbors in the index yet (vectors index functions/methods with stored IR).`;
      for (const h of hits) {
        const e = env.svc.store.entitiesById(env.rev.id, [h.entityId])[0];
        if (e && !env.access.denied(e.file)) note(env, e), (env.irReads ??= new Set()).add(e.entityId);
      }
      env.svc.store.audit(env.ctx.actor.principalId, "chat.similar_to", env.rev.id, { anchor: anchor.entityId, hits: hits.length } as Record<string, unknown>);
      const lines = hits.map((h) => `  ${Math.round(h.similarity * 100)}% [${h.entityId}] ${h.name} (${h.file})`);
      return [`Resolved "${name}" to [${anchor.entityId}]. ${hits.length} structural neighbor(s) (similarity is approximate, not identity):`, ...lines].join("\n");
    },
  },
  {
    name: "evidence_of",
    description: "Inspect indexed source links, analyzer provenance and partial coverage for one element. This does not read its implementation or prove runtime behavior; use ir_of/read_code for behavior.",
    parameters: obj({entity:str("Element id or name")},["entity"]),
    run: async (env,{entity}) => {
      const e=entityFor(env,String(entity));if(!e)return "No accessible indexed element matches that name.";
      note(env,e);
      const trace=traceEntities(env.svc.store,env.rev.id,[e.entityId],ev=>env.svc.resolveEvidence(env.rev,ev));
      return [`Indexed evidence for [${e.entityId}]. Coverage: PARTIAL. Analyzer provenance: ${trace.provenance}.`,
        ...trace.limitations,...trace.items.flatMap(i=>i.sources.map(source=>`${i.label}: ${source.file} bytes ${source.startByte}-${source.endByteExclusive}${source.producer?` (${source.producer.id} v${source.producer.version})`:" (producer not recorded)"}`))].join("\n");
    },
  },
  {
    name: "answer",
    description: "Finish: give the user the answer. Only state what tool results showed, and cite the ids of the elements you rely on.",
    parameters: { type: "object", properties: { text: str("The answer, in plain prose", { maxLength: 6000 }), cites: { type: "array", items: { type: "string" }, maxItems: 20, description: "Ids (in [brackets] in tool results) the answer relies on" } }, required: ["text", "cites"], additionalProperties: false },
  },
  {
    name: "not_analysis",
    description: "Call this alone, first, when the message is not a question about the code: a command for the map on screen (zoom, pin, boost, demote, why is X shown or hidden, explain the selection), reopening a saved investigation, or a pasted stack trace. Another handler takes over.",
    parameters: obj({ reason: str("Why", { maxLength: 300 }) }),
  },
];

/** A view about one element starts from it: the element itself and, for a file or class, what it holds. */
function seedsFor(env: ToolEnv, subject: string): string[] {
  const e = entityFor(env, subject);
  return e ? [e.entityId] : [];
}
/** Test lookup works on files; an element's id or name means the file it lives in. */
function fileFor(env: ToolEnv, subject: string): string {
  const e = entityFor(env, subject);
  return e?.file ?? subject;
}

export const toolByName = new Map(CHAT_TOOLS.map((t) => [t.name, t]));
