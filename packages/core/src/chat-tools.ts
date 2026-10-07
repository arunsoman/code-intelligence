// The read-only tools a chat model may call, declared once: each has a name, what it is for, and a JSON schema for its
// arguments. The prompt, the schema sent to the model and argument checking are all generated from this list, so adding a
// tool is one entry here, not another rule in a prompt and another branch in a validator. Every tool reports what it saw in
// a short text the model reads next, and the ids of the code elements in it — the only ids an answer may cite.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CallContext, ChatAnalysisResult, Entity } from "@cie/schema";
import type { AccessPolicy } from "./access.ts";
import type { ChatStep } from "./chat-plan.ts";
import { executeChatPlan } from "./chat-execution.ts";
import { resolveMentions } from "./mentions.ts";
import { retrieveForQuestion } from "./retrieval.ts";
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

const MAX_SOURCE_LINES = 260, MAX_SOURCE_CHARS = 14000, MAX_LINKS = 20;
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
const line = (env: ToolEnv, e: Pick<Entity, "entityId" | "name" | "file" | "kind">) => `- [${note(env, e)}] ${e.kind} ${e.name} — ${e.file}`;

/** The entity an argument names: its id, or a name looked up the same way a question's mentions are. */
function entityFor(env: ToolEnv, ref: string): Entity | null {
  const { svc, rev, access } = env;
  const byId = svc.store.entitiesById(rev.id, [ref])[0];
  if (byId) return access.denied(byId.file) ? null : byId;
  const hit = resolveMentions(svc.store, rev.id, ref, access).resolved[0]?.matches[0];
  return hit ? svc.store.entitiesById(rev.id, [hit.entityId])[0] ?? null : null;
}

function sourceOf(rev: RevisionRow, e: Entity): { startLine: number; endLine: number; text: string; stale: boolean } | null {
  const span = e.spans[0];
  if (!span) return null;
  const path = resolve(rev.repoRoot, span.sourceId), rel = relative(rev.repoRoot, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return null; }
  const stale = createHash("sha256").update(buf).digest("hex") !== span.contentHash;
  const startLine = buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
  const text = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
  return { startLine, endLine: startLine + text.split("\n").length - 1, text, stale };
}

function truncateSource(text: string): string {
  const lines = text.split("\n");
  let out = lines.slice(0, MAX_SOURCE_LINES).join("\n");
  if (out.length > MAX_SOURCE_CHARS) out = out.slice(0, MAX_SOURCE_CHARS);
  return out.length < text.length ? `${out}\n… (${lines.length} lines in all; the rest is not shown)` : out;
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
      const q = query as string;
      const named = resolveMentions(env.svc.store, env.rev.id, q, env.access).resolved.flatMap((m) => m.matches);
      const r = retrieveForQuestion(env.svc.store, env.rev.id, q, { access: env.access, maxNodes: 12 });
      const related = r.bundle.entities.filter((e) => e.kind !== "file" && r.scored.get(e.entityId)?.factors.some((f) => f.factor === "TASK_MATCH" && f.normalizedScore > 0))
        .sort((a, b) => (r.scored.get(b.entityId)?.score ?? 0) - (r.scored.get(a.entityId)?.score ?? 0));
      const all = [...new Map([...named.map((m) => ({ entityId: m.entityId, name: m.name, file: m.file, kind: m.kind })), ...related].map((e) => [e.entityId, e])).values()].slice(0, 12);
      return all.length ? [`${all.length} match(es) for "${q}":`, ...all.map((e) => line(env, e))].join("\n") : `Nothing in this revision matches "${q}".`;
    },
  },
  {
    name: "read_code",
    description: "Read one class, function, method or file: its source, what it contains, what calls it and what it calls. Read code before saying what it does.",
    parameters: obj({ id: str("An id from an earlier result, or the exact name of the element") }, ["id"]),
    async run(env, { id }) {
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
      const src = sourceOf(rev, e);
      svc.store.audit(env.ctx.actor.principalId, "chat.read", rev.id, { entity: e.entityId });
      return [
        `[${e.entityId}] ${e.kind} ${e.name} — ${e.file}${src ? `:${src.startLine}-${src.endLine}` : ""}`,
        src ? `${src.stale ? "(the file changed since it was indexed; this is its current text)\n" : ""}\`\`\`\n${truncateSource(src.text)}\n\`\`\`` : "(source text unavailable)",
        ...sections,
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
