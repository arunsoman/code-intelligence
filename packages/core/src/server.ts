// Local gateway: /api/v1/components/{componentId}/{operation} command routes (contracts §1) + static web app.
// Loopback only. Trusted identity is established here, never taken from request JSON.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createProvider, resolveModel } from "@cie/model";
import type { ApiResult, CallContext } from "@cie/schema";
import { Interactions } from "./interactions.ts";
import { routerFor } from "./llm-router.ts";
import { featureHandlers } from "./feature/handlers.ts";
import { featureOps } from "./feature/routes.ts";
import { Service } from "./service.ts";
import { TenantHost } from "./tenants.ts";
import { Store } from "./store.ts";
import { WorkerClient } from "./worker.ts";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";
const MAX_BODY = 8 * 1024 * 1024; // saved views and pasted traces can be large
class BodyTooLargeError extends Error { constructor() { super("body too large"); } }
const WEB_DIST = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

export type Identify = (req: IncomingMessage) => { principalId: string; tenantId: string; sessionId: string } | null;
const LOCAL: Identify = () => ({ principalId: "local-user", tenantId: "local", sessionId: "local" });

/**
 * `target` is one service (single user, local) or a TenantHost (one isolated service per tenant). Who is calling comes from
 * `identify`, which stands for the trusted transport (a reverse proxy that authenticated the caller); it is never read from
 * the request body, and a null answer is a 401.
 */
export function buildHandler(target: Service | TenantHost, opts: { identify?: Identify } = {}) {
  const identify = opts.identify ?? LOCAL;
  // Allowlisted public operations. Mutating ones require an Idempotency-Key header.
  const interactionCache = new WeakMap<Service, Interactions>();
  const interactionsOf = (svc: Service) => { let i = interactionCache.get(svc); if (!i) { i = new Interactions(svc); interactionCache.set(svc, i); } return i; };
  const makeOps = (svc: Service) => {
  const ops: Record<string, { mutating: boolean; run: (ctx: CallContext, body: any) => Promise<ApiResult<unknown>> | ApiResult<unknown> }> = {
    "C01/status": { mutating: false, run: (c, b) => svc.status(c, b) },
    "C01/browseDirectory": { mutating: false, run: (c, b) => svc.browseDirectory(c, b) },
    "C01/repositoryGit": { mutating: false, run: (c, b) => svc.repositoryGit(c, b) },
    "C01/switchBranch": { mutating: true, run: (c, b) => svc.switchBranch(c, b) },
    "C01/fetchBranches": { mutating: true, run: (c, b) => svc.fetchBranches(c, b) },
    "C01/captureEditorEvent": { mutating: false, run: (c, b) => svc.captureEditorEvent(c, b) },
    "C01/editorContext": { mutating: false, run: (c, b) => svc.editorContext(c, b) },
    "C03/setEgress": { mutating: true, run: (c, b) => svc.setEgress(c, b) },
    "C01/listModels": { mutating: false, run: (c) => svc.listModels(c) },
    "C01/setModel": { mutating: true, run: (c, b) => svc.setModel(c, b) },
    "C03/auditLog": { mutating: false, run: (c, b) => svc.auditLog(c, b) },
    "C04/ingestRepository": { mutating: true, run: (c, b) => svc.ingestRepository(c, b) },
    "C07/enqueue": { mutating: true, run: (c, b) => svc.enqueueJob(c, b) },
    "C07/getJob": { mutating: false, run: (c, b) => svc.getJob(c, b) },
    "C07/listJobs": { mutating: false, run: (c, b) => svc.listJobs(c, b) },
    "C07/cancelJob": { mutating: true, run: (c, b) => svc.cancelJob(c, b) },
    "C32/health": { mutating: false, run: (c, b) => svc.health(c, b) },
    "C32/version": { mutating: false, run: (c, b) => svc.version(c, b) },
    "C31/backup": { mutating: true, run: (c, b) => svc.backup(c, b) },
    "C31/gc": { mutating: false, run: (c, b) => svc.gc(c, b) },
    "C31/deleteRepository": { mutating: true, run: (c, b) => svc.deleteRepository(c, b) },
    "C02/eventsAfter": { mutating: false, run: (c, b) => ({ ok: true, value: svc.bus.eventsAfter(Number(b?.afterSeq) || 0), metadata: { requestId: c.requestId, completeness: "COMPLETE", warnings: [] } } as ApiResult<unknown>) },
    "C22/start": { mutating: true, run: (c, b) => svc.c22Legacy.start(c, b) },
    "C22/advance": { mutating: true, run: (c, b) => svc.c22Legacy.advance(c, b) },
    "C22/steer": { mutating: true, run: (c, b) => svc.c22Legacy.steer(c, b) },
    "C22/interrupt": { mutating: true, run: (c, b) => svc.c22Legacy.interrupt(c, b) },
    "C22/conclude": { mutating: false, run: (c, b) => svc.c22Legacy.conclude(c, b) },
    "C27/evaluateScenario": { mutating: false, run: (c, b) => svc.evaluateScenario(c, b) },
    "C27/compareScenarios": { mutating: false, run: (c, b) => svc.compareScenarios(c, b) },
    "C24/reportException": { mutating: false, run: (c, b) => svc.reportException(c, b) },
    "C24/listExceptions": { mutating: false, run: (c, b) => svc.listExceptions(c, b) },
    "C24/dismissException": { mutating: true, run: (c, b) => svc.dismissException(c, b) },
    "C26/detect": { mutating: true, run: (c, b) => svc.startDefectDetection(c, b) },
    "C26/compareBenchmarks": { mutating: false, run: (c, b) => svc.compareDefectBenchmarks(c, b) },
    "C11/extractConcepts": { mutating: true, run: (c, b) => svc.extractConcepts(c, b) },
    "C11/listConcepts": { mutating: false, run: (c, b) => svc.listConcepts(c, b) },
    "C11/conceptStore": { mutating: false, run: (c, b) => svc.conceptStore(c, b) },
    "C19/refresh": { mutating: false, run: (c, b) => svc.refreshView(c, b) },
    "C19/overlays": { mutating: false, run: (c, b) => svc.overlays(c, b) },
    "C19/setOverride": { mutating: true, run: (c, b) => svc.setOverride(c, b) },
    "C19/listOverrides": { mutating: false, run: (c, b) => svc.listOverrides(c, b) },
    "C19/visuals": { mutating: false, run: (c, b) => svc.visuals(c, b) },
    "C19/providerGuide": { mutating: false, run: (c, b) => svc.providerGuide(c, b) },
    "C19/ask": { mutating: false, run: (c, b) => svc.ask(c, b) },
    "C19/investigate": { mutating: false, run: (c, b) => svc.investigate(c, b) },
    "C19/steer": { mutating: false, run: (c, b) => svc.steer(c, b) },
    "C21/resolve": { mutating: true, run: (c, b) => interactionsOf(svc).resolve(c, b) },
    "C21/followUp": { mutating: true, run: (c, b) => interactionsOf(svc).followUp(c, b.session, b.text, b.view) },
    "C15/converse": { mutating: false, run: (c, b) => svc.converse(c, b) },
    "C15/explain": { mutating: false, run: (c, b) => svc.explain(c, b) },
    "C15/whyShown": { mutating: false, run: (c, b) => svc.whyShown(c, b) },
    "C15/whyHidden": { mutating: false, run: (c, b) => svc.whyHidden(c, b) },
    "C18/evidence": { mutating: false, run: (c, b) => svc.evidenceFor(c, b) },
    "C18/evidenceBatch": { mutating: false, run: (c, b) => svc.evidenceBatch(c, b) },
    "C26/locateSpans": { mutating: false, run: (c, b) => svc.locateSpans(c, b) },
    "C18/claims": { mutating: false, run: (c, b) => svc.claims(c, b) },
    "C18/verdict": { mutating: true, run: (c, b) => svc.verdict(c, b) },
    "C13/saveWorkspace": { mutating: true, run: (c, b) => svc.saveWorkspace(c, b) },
    "C13/listWorkspaces": { mutating: false, run: (c) => svc.listWorkspaces(c) },
    "C13/openWorkspace": { mutating: false, run: (c, b) => svc.openWorkspace(c, b) },
    "C13/changesSince": { mutating: true, run: (c, b) => svc.changesSince(c, b) },
    "C13/changesSinceIndex": { mutating: true, run: (c, b) => svc.changesSinceIndex(c, b) },
    "C13/changesBetweenRevisions": { mutating: false, run: (c, b) => svc.changesBetweenRevisions(c, b) },
    "C13/revisionStats": { mutating: false, run: (c, b) => svc.revisionStats(c, b) },
  };
  for (const [key, run] of Object.entries(svc.exportOps)) ops[key] = { mutating: ["C30/subscribe", "C30/unsubscribe", "C30/exportClaims"].includes(key), run };
  for (const [key, run] of Object.entries(svc.screenOps)) ops[key] = { mutating: ["C17/runSuite", "C29/addPrincipal", "C29/setAccess"].includes(key), run: run as any };
  for (const [key, run] of Object.entries(svc.indexOps)) ops[key] = { mutating: ["C07/invalidateAndRevalidate", "C04/ingestGhSource"].includes(key), run: run as any };
  for (const [key, run] of Object.entries(svc.collabOps)) ops[key] = { mutating: !["C29/read", "C29/conceptsFor"].includes(key), run };
  for (const [key, run] of Object.entries(svc.securityOps)) ops[key] = { mutating: ["C25/analyze", "C25/gateSecurityAlarm"].includes(key), run };
  for (const [key, run] of Object.entries(svc.runtimeOps)) ops[key] = { mutating: ["C24/recordMarker", "C24/ingest"].includes(key), run };
  for (const [key, run] of Object.entries(svc.historyOps)) ops[key] = { mutating: ["C23/addThread", "C23/reanchorThreads"].includes(key), run };
  for (const [key, run] of Object.entries(svc.registryOps)) ops[key] = { mutating: key === "C08/applyIdentityVerdict", run };
  for (const [key, run] of Object.entries(svc.workspaceOps)) ops[key] = { mutating: !["C13/resume", "C13/resurface"].includes(key), run };
  for (const [key, run] of Object.entries(svc.changeOps)) ops[key] = { mutating: !["C28/interpretDrag", "C28/get", "C28/list"].includes(key), run };
  for (const [key, run] of Object.entries(svc.searchOps)) ops[key] = { mutating: key === "C07/enqueueIndex", run: run as any };
  for (const [key, run] of Object.entries(svc.hotspotOps)) ops[key] = { mutating: ["C26/analyzeHistory", "C26/grantContributorNames", "C26/setHistoryTerrain"].includes(key), run: run as any };
  for (const [key, run] of Object.entries(svc.prOps)) ops[key] = { mutating: !["C23/getPrAnalysis", "C16/listPolicies", "C16/getPolicy", "C16/verifyBinding", "C23/getImpactReport", "C23/explainImpactItem", "C30/previewImpactComment"].includes(key), run: run as any };
  for (const [key, run] of Object.entries(svc.defectOps)) ops[key] = { mutating: !["C26/listFindings", "C26/explainFinding", "C27/listCapabilities", "C27/getRunManifest"].includes(key), run };
  for (const [key, run] of Object.entries(svc.profilingOps)) ops[key] = { mutating: key === "C04/ingestProfile" || key === "C24/correlateProfile", run: run as any };
  // F07 task execution: every command that records a decision, spends a run or writes to a forge is mutating. The
  // read-only ones (get/list) are not, so a client can poll a task's timeline without holding a write token.
  const TASK_MUTATING = new Set(["C02/submitTask", "C02/confirmIntent", "C02/cancelTask", "C15/draftPlan", "C22/resolveObligation", "C28/prepareChange", "C27/validatePatch", "C28/reviewPropertyChange", "C28/approveCandidate", "C30/createPublicationGrant", "C30/publishDraftPR"]);
  for (const [key, run] of Object.entries(svc.taskOps)) ops[key] = { mutating: TASK_MUTATING.has(key), run: run as any };
  for (const [key, run] of Object.entries(svc.campaignOps)) ops[key] = { mutating: !["C28/getCampaign", "C28/listCampaigns", "C28/listChildren", "C28/getCampaignPlan", "C28/clusterChildren", "C28/getDryRun"].includes(key), run: run as any };
  for (const [key, run] of Object.entries(svc.releaseOps)) ops[key] = { mutating: !["C32/getRelease", "C32/listReleases", "C32/getReleaseReadiness", "C32/previewMilestone", "C32/listMilestones", "C32/lookupIssue"].includes(key), run: run as any };
  for (const [key, run] of Object.entries(svc.ciOps)) ops[key] = { mutating: false, run: run as any };
  // Prompt-to-feature (docs/prompt-to-feature): typed stubs until each owning task registers its handler in feature/routes.ts.
  Object.assign(ops, featureOps(featureHandlers(svc), ops));
  return ops;
  };
  const statusFor = (r: ApiResult<unknown>) => r.ok ? 200 : ({ INVALID_SCHEMA: 400, NOT_FOUND: 404, EVIDENCE_MISSING: 404, VERSION_CONFLICT: 409, UNAUTHORIZED: 401, FORBIDDEN: 403, BUDGET_EXCEEDED: 429, DEADLINE_EXCEEDED: 504, PROVIDER_UNAVAILABLE: 503 } as Record<string, number>)[r.error.code] ?? 500;
  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new BodyTooLargeError()); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: only accept loopback Host headers.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, { error: "bad host" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/") || url.pathname === "/healthz";
    const actor = isApi ? identify(req) : null;
    if (isApi && !actor) return send(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "not authenticated", retryable: false } });
    const mk = (idem: string, deadlineMs = 60_000): CallContext => ({ requestId: randomUUID(), idempotencyKey: idem, actor: actor!, deadlineMs: Date.now() + deadlineMs, traceId: randomUUID() });
    /** The service for this caller: the single one, or the tenant's own after the tenant and member are checked. */
    const serviceFor = (c: CallContext): { svc: Service } | { failure: ApiResult<never> } => {
      if (!(target instanceof TenantHost)) return { svc: target };
      const r = target.service(c);
      return r.ok ? { svc: r.value } : { failure: r as ApiResult<never> };
    };
    // C22's v2 catalogue lives at /api/v2/components/C22/{operation}; the five original operations stay on v1.
    const v2 = url.pathname.match(/^\/api\/v2\/components\/(C22|C24)\/([A-Za-z0-9]+)$/);
    if (v2) {
      const c0 = mk(""); const sv0 = serviceFor(c0);
      if ("failure" in sv0) return send(res, statusFor(sv0.failure), sv0.failure);
      const catalogue = v2[1] === "C22" ? sv0.svc.c22v2 : sv0.svc.c24v2;
      const op = v2[2];
      const fn = Object.hasOwn(catalogue, op) ? (catalogue as Record<string, (c: CallContext, b: any) => Promise<ApiResult<unknown>>>)[op] : undefined;
      if (!fn || req.method !== "POST") return send(res, fn ? 405 : 404, { ok: false, error: { code: "NOT_FOUND", message: "unknown operation", retryable: false } });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { ok: false, error: { code: "INVALID_SCHEMA", message: "content-type must be application/json", retryable: false } });
      let body: any;
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {
        if (e instanceof BodyTooLargeError) return send(res, 413, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds the maximum allowed size", retryable: false } });
        return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: "invalid JSON body", retryable: false } });
      }
      const idem = String(req.headers["idempotency-key"] ?? "");
      const mutating = !(v2[1] === "C22" ? ["get", "list", "getCompletion", "getBoard", "getDetails", "readEvents"] : ["getSnapshot", "readUpdates", "querySlice", "traceAncestors", "checkOrder", "explainRelation", "criticalPath", "getCoverage", "replayPlayback"]).includes(op);
      if (mutating && !idem) return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: "Idempotency-Key header required", retryable: false } });
      const result = await fn(mk(idem), body);
      return send(res, statusFor(result), result);
    }
    const m = url.pathname.match(/^\/api\/v1\/components\/(C\d\d)\/([A-Za-z]+)$/);
    if (m) {
      const c1 = mk(""); const sv1 = serviceFor(c1);
      if ("failure" in sv1) return send(res, statusFor(sv1.failure), sv1.failure);
      const op = makeOps(sv1.svc)[`${m[1]}/${m[2]}`];
      if (!op || req.method !== "POST") return send(res, op ? 405 : 404, { ok: false, error: { code: "NOT_FOUND", message: "unknown operation", retryable: false } });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { ok: false, error: { code: "INVALID_SCHEMA", message: "content-type must be application/json", retryable: false } });
      let body: any;
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) {
        if (e instanceof BodyTooLargeError) return send(res, 413, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds the maximum allowed size", retryable: false } });
        return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: "invalid JSON body", retryable: false } });
      }
      const idem = String(req.headers["idempotency-key"] ?? "");
      if (op.mutating && !idem) return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: "Idempotency-Key header required", retryable: false } });
      const ctx = mk(idem);
      // In a multi-tenant server a path is only usable if the tenant is allowed to read it: indexing, and even browsing for it.
      const opKey = `${m[1]}/${m[2]}`;
      if (target instanceof TenantHost && ["C01/switchBranch", "C01/fetchBranches"].includes(opKey)) return send(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "Branch switching and fetching are available only in the local app.", retryable: false } });
      if (target instanceof TenantHost && ["C04/ingestRepository", "C01/browseDirectory", "C01/repositoryGit"].includes(opKey)) {
        const host: TenantHost = target;
        const wanted = opKey === "C01/browseDirectory" ? body?.path : body?.repoPath;
        if (typeof wanted === "string") { const denied = host.authorizeSource(ctx, wanted); if (denied) return send(res, statusFor(denied), denied); }
        else if (opKey === "C01/browseDirectory") {
          const first = host.firstRoot(ctx);
          if (!first) return send(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "this tenant has no readable folders", retryable: false } });
          body = { ...body, path: first };
        }
      }
      try {
        const result = await op.run(ctx, body);
        return send(res, statusFor(result), result);
      } catch (e) {
        if (e instanceof BodyTooLargeError) return send(res, 413, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds the maximum allowed size", retryable: false } });
        const err = e as Error;
        const msg = err.message ?? String(e);
        if (e instanceof TypeError || /Cannot read properties of|is not a function|must be/.test(msg)) {
          console.error("schema error mapped to 400:", msg);
          return send(res, 400, { ok: false, error: { code: "INVALID_SCHEMA", message: `request body field has the wrong type: ${msg}`, retryable: false } });
        }
        console.error("internal error:", e);
        return send(res, 500, { ok: false, error: { code: "STORAGE_FAILURE", message: "internal error", retryable: true } });
      }
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      const c2 = mk("", 5000); const sv2 = serviceFor(c2);
      if ("failure" in sv2) return send(res, statusFor(sv2.failure), sv2.failure);
      const h = await sv2.svc.health(c2, {}); return send(res, h.ok && h.value.status === "down" ? 503 : 200, h.ok ? h.value : h);
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
  const store = new Store();
  const env = process.env;
  const baseUrl = env.CIE_OLLAMA_URL;
  const think = (["low", "medium", "high", "off"] as const).find((x) => x === env.CIE_OLLAMA_THINK);
  // CIE_PROVIDER=stub means fully offline: skip Ollama entirely (used by e2e tests for speed and determinism).
  const resolved = env.CIE_PROVIDER === "stub" ? { model: null, note: undefined, picked: false } : await resolveModel(store.selectedModel(), baseUrl);
  if (resolved.picked && resolved.model) store.setSelectedModel(resolved.model);
  const { provider, note } = await createProvider({ which: env.CIE_PROVIDER, model: resolved.model, baseUrl, think });
  if (resolved.note) console.warn(resolved.note);
  if (note) console.warn(note);
  const svc = new Service(store, new WorkerClient(), provider);
  svc.router = routerFor(resolved.model, env);
  // Durable events become notifications, and due webhooks are sent. A crash between the two loses neither: both are stored first.
  setInterval(() => { try { svc.bus.dispatchPending(); void svc.notifications.dispatch().catch(() => {}); } catch { /* the next tick tries again */ } }, 2000).unref();
  createServer(buildHandler(svc)).listen(PORT, HOST, () => console.log(`cie listening on http://${HOST}:${PORT} (model: ${provider.name}/${provider.model}; router: ${svc.router?.name ?? "off"})`));
}
