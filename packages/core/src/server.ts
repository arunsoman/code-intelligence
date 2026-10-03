// Local gateway: /api/v1/components/{componentId}/{operation} command routes (contracts §1) + static web app.
// Loopback only. Trusted identity is established here, never taken from request JSON.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createProvider } from "@cie/model";
import type { ApiResult, CallContext } from "@cie/schema";
import { Service } from "./service.ts";
import { Store } from "./store.ts";
import { WorkerClient } from "./worker.ts";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";
const MAX_BODY = 8 * 1024 * 1024; // saved views and pasted traces can be large
const WEB_DIST = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

export function buildHandler(svc: Service) {
  // Allowlisted public operations. Mutating ones require an Idempotency-Key header.
  const ops: Record<string, { mutating: boolean; run: (ctx: CallContext, body: any) => Promise<ApiResult<unknown>> | ApiResult<unknown> }> = {
    "C01/status": { mutating: false, run: (c, b) => svc.status(c, b) },
    "C01/browseDirectory": { mutating: false, run: (c, b) => svc.browseDirectory(c, b) },
    "C01/captureEditorEvent": { mutating: false, run: (c, b) => svc.captureEditorEvent(c, b) },
    "C01/editorContext": { mutating: false, run: (c, b) => svc.editorContext(c, b) },
    "C03/setEgress": { mutating: true, run: (c, b) => svc.setEgress(c, b) },
    "C03/auditLog": { mutating: false, run: (c, b) => svc.auditLog(c, b) },
    "C04/ingestRepository": { mutating: true, run: (c, b) => svc.ingestRepository(c, b) },
    "C24/reportException": { mutating: false, run: (c, b) => svc.reportException(c, b) },
    "C24/listExceptions": { mutating: false, run: (c, b) => svc.listExceptions(c, b) },
    "C24/dismissException": { mutating: true, run: (c, b) => svc.dismissException(c, b) },
    "C11/extractConcepts": { mutating: true, run: (c, b) => svc.extractConcepts(c, b) },
    "C11/listConcepts": { mutating: false, run: (c, b) => svc.listConcepts(c, b) },
    "C11/conceptStore": { mutating: false, run: (c, b) => svc.conceptStore(c, b) },
    "C19/refresh": { mutating: false, run: (c, b) => svc.refreshView(c, b) },
    "C19/setOverride": { mutating: true, run: (c, b) => svc.setOverride(c, b) },
    "C19/listOverrides": { mutating: false, run: (c, b) => svc.listOverrides(c, b) },
    "C19/visuals": { mutating: false, run: (c, b) => svc.visuals(c, b) },
    "C19/ask": { mutating: false, run: (c, b) => svc.ask(c, b) },
    "C19/investigate": { mutating: false, run: (c, b) => svc.investigate(c, b) },
    "C19/steer": { mutating: false, run: (c, b) => svc.steer(c, b) },
    "C15/converse": { mutating: false, run: (c, b) => svc.converse(c, b) },
    "C15/explain": { mutating: false, run: (c, b) => svc.explain(c, b) },
    "C15/whyShown": { mutating: false, run: (c, b) => svc.whyShown(c, b) },
    "C15/whyHidden": { mutating: false, run: (c, b) => svc.whyHidden(c, b) },
    "C18/evidence": { mutating: false, run: (c, b) => svc.evidenceFor(c, b) },
    "C18/claims": { mutating: false, run: (c, b) => svc.claims(c, b) },
    "C18/verdict": { mutating: true, run: (c, b) => svc.verdict(c, b) },
    "C13/saveWorkspace": { mutating: true, run: (c, b) => svc.saveWorkspace(c, b) },
    "C13/listWorkspaces": { mutating: false, run: (c) => svc.listWorkspaces(c) },
    "C13/openWorkspace": { mutating: false, run: (c, b) => svc.openWorkspace(c, b) },
    "C13/changesSince": { mutating: true, run: (c, b) => svc.changesSince(c, b) },
  };
  const statusFor = (r: ApiResult<unknown>) => r.ok ? 200 : ({ INVALID_SCHEMA: 400, NOT_FOUND: 404, EVIDENCE_MISSING: 404, VERSION_CONFLICT: 409, UNAUTHORIZED: 401, FORBIDDEN: 403, BUDGET_EXCEEDED: 429, DEADLINE_EXCEEDED: 504, PROVIDER_UNAVAILABLE: 503 } as Record<string, number>)[r.error.code] ?? 500;
  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: only accept loopback Host headers.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, { error: "bad host" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = url.pathname.match(/^\/api\/v1\/components\/(C\d\d)\/([A-Za-z]+)$/);
    if (m) {
      const op = ops[`${m[1]}/${m[2]}`];
      if (!op || req.method !== "POST") return send(res, op ? 405 : 404, { ok: false, error: { code: "NOT_FOUND", message: "unknown operation", retryable: false } });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { ok: false, error: { code: "INVALID_SCHEMA", message: "content-type must be application/json", retryable: false } });
      let body: any;
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: "invalid JSON body", retryable: false } }); }
      const idem = String(req.headers["idempotency-key"] ?? "");
      if (op.mutating && !idem) return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: "Idempotency-Key header required", retryable: false } });
      const ctx: CallContext = { requestId: randomUUID(), idempotencyKey: idem, actor: { principalId: "local-user", tenantId: "local", sessionId: "local" }, deadlineMs: Date.now() + 60_000, traceId: randomUUID() };
      try {
        const result = await op.run(ctx, body);
        return send(res, statusFor(result), result);
      } catch (e) {
        return send(res, 500, { ok: false, error: { code: "STORAGE_FAILURE", message: "internal error", retryable: true } });
      }
    }
    // Static web app (SPA fallback).
    if (req.method !== "GET") return send(res, 405, "method not allowed", "text/plain");
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (rel.startsWith("..")) return send(res, 403, "forbidden", "text/plain");
    let file = join(WEB_DIST, rel || "index.html");
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
    if (!existsSync(file)) return send(res, 404, "web app not built; run `npm run web:build`", "text/plain");
    send(res, 200, readFileSync(file), MIME[extname(file)] ?? "application/octet-stream");
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { provider, note } = await createProvider();
  if (note) console.warn(note);
  const svc = new Service(new Store(), new WorkerClient(), provider);
  createServer(buildHandler(svc)).listen(PORT, HOST, () => console.log(`cie listening on http://${HOST}:${PORT} (model: ${provider.name}/${provider.model})`));
}
