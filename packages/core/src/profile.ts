// "What architecture does this project follow?" is a question about the whole repository, so it is answered from the whole repository:
// languages, how the top-level folders are used, which frameworks the imports name, and which way calls run between layers.
// Every statement says it is inferred from names and imports; nothing here is a claim the code proves.
import type { Store } from "./store.ts";

const LAYERS: [string, RegExp][] = [
  ["presentation / API", /(^|\/)(controllers?|api|web|routes?|handlers?|rest|resources?|views?|endpoints?|cmd|ui)(\/|$)/i],
  ["service / business logic", /(^|\/)(services?|usecases?|domain|core|logic|business|app)(\/|$)/i],
  ["data access", /(^|\/)(repositor(y|ies)|dao|db|database|store|storage|persistence|data|models?|entit(y|ies)|migrations?)(\/|$)/i],
  ["messaging / async", /(^|\/)(queues?|bus|events?|messaging|listeners?|consumers?|workers?|jobs?)(\/|$)/i],
  ["configuration / infrastructure", /(^|\/)(config|configuration|infra|infrastructure|deploy)(\/|$)/i],
];
const FRAMEWORKS: [string, RegExp][] = [
  ["Spring Boot", /^org\.springframework/], ["Express", /^express$/], ["NestJS", /^@nestjs\//], ["React", /^react(-dom)?$/], ["Flask", /^flask$/], ["Django", /^django/],
  ["FastAPI", /^fastapi$/], ["SQLAlchemy", /^sqlalchemy/], ["Gin", /gin-gonic\/gin/], ["Echo", /labstack\/echo/], ["chi", /go-chi\/chi/], ["net/http", /^net\/http$/], ["Hibernate / JPA", /^(org\.hibernate|jakarta\.persistence|javax\.persistence)/],
  ["Kafka", /kafka/i], ["RabbitMQ", /rabbit|amqp/i], ["JUnit", /junit/i], ["Jest", /^jest$|@jest\//], ["pytest", /^pytest$/], ["Prisma", /^@prisma\/client$/], ["tokio", /^tokio/], ["serde", /^serde/],
];
const EXT: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", rs: "Rust", nir: "Nirdosha", java: "Java", go: "Go", py: "Python" };

export interface Profile { text: string; languages: Record<string, number>; frameworks: string[]; layers: { layer: string; folders: string[] }[]; style: string; entryPoints: number; topics: number }

export function projectProfile(store: Store, revision: string): Profile {
  const ents = store.entities(revision);
  const files = ents.filter((e) => e.kind === "file").map((e) => e.file);
  const langs: Record<string, number> = {};
  for (const f of files) { const l = EXT[f.split(".").pop() ?? ""]; if (l) langs[l] = (langs[l] ?? 0) + 1; }
  const frameworks = [...new Set(store.factsByPredicate(revision, "imports_external").map((f) => String((f.object as any).value)).flatMap((m) => FRAMEWORKS.filter(([, re]) => re.test(m)).map(([n]) => n)))].sort();
  const layerOf = (file: string) => LAYERS.find(([, re]) => re.test(file))?.[0] ?? null;
  const folders = new Map<string, Set<string>>();
  for (const f of files) { const l = layerOf(f); if (!l) continue; const parts = f.split("/"); const dir = parts.slice(0, Math.min(parts.length - 1, 3)).join("/"); (folders.get(l) ?? folders.set(l, new Set()).get(l)!).add(dir); }
  const layers = [...folders].map(([layer, set]) => ({ layer, folders: [...set].sort().slice(0, 4) }));
  // Which way do calls run between layers? A layered design calls downwards and almost never back up.
  const fileOf = new Map(ents.map((e) => [e.entityId, e.file]));
  const order = LAYERS.map(([n]) => n);
  let down = 0, up = 0;
  for (const r of store.allRelationships(revision)) if (r.kind === "calls") {
    const a = layerOf(fileOf.get(r.from) ?? ""), b = layerOf(fileOf.get(r.to) ?? "");
    if (!a || !b || a === b || a.startsWith("config") || b.startsWith("config")) continue;
    (order.indexOf(a) < order.indexOf(b) ? (down++, 0) : (up++, 0));
  }
  const top = new Map<string, number>();
  for (const f of files) { const p = f.split("/"); const k = p.length > 2 ? p[1] : p[0]; top.set(k, (top.get(k) ?? 0) + 1); }
  const hasLayers = layers.length >= 2 && down > 0;
  const style = hasLayers && up <= down * 0.2 ? `layered (${layers.map((l) => l.layer).join(" → ")}): ${down} call(s) run down the layers and ${up} back up`
    : hasLayers ? `layered folders, but calls run both ways between them (${down} down, ${up} up), so the layering is loose`
    : top.size >= 3 ? `organised by feature or module (${[...top.keys()].slice(0, 6).join(", ")})` : "a small codebase without clear layers";
  const flows = store.allRelationships(revision).filter((r) => r.kind === "async-flow");
  const topics = new Set(flows.map((r) => r.label ?? "")).size;
  const calls = new Set(store.allRelationships(revision).filter((r) => r.kind === "calls").map((r) => r.to));
  const entryPoints = ents.filter((e) => ["function", "method"].includes(e.kind) && !calls.has(e.entityId) && !e.file.includes("test")).length;
  const lang = Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n} file${n === 1 ? "" : "s"})`).join(", ") || "no supported source files";
  const text = [
    `Inferred from folder names, imports and call directions (not proven by the code): this project is ${style}.`,
    `Languages: ${lang}.`,
    frameworks.length ? `Frameworks and libraries named by imports: ${frameworks.join(", ")}.` : "No well-known framework was recognised from imports.",
    layers.length ? `Where the layers live: ${layers.map((l) => `${l.layer} in ${l.folders.join(", ")}`).join("; ")}.` : "",
    topics ? `${topics} asynchronous topic(s) join publishers to subscribers, so part of the flow is event-driven.` : "",
    `${entryPoints} function(s) are called by nothing in the code (entry points, handlers, or dead code).`,
  ].filter(Boolean).join(" ");
  return { text, languages: langs, frameworks, layers, style, entryPoints, topics };
}
