// C03 identity, tenancy and source authorization. Isolation is structural, not a filter someone has to remember to apply:
// every tenant has its own database file and its own parser process. Nothing is shared that could leak: not rows, not
// embeddings, not caches (they live in the tenant's store or are keyed by it), not the parser's in-memory parse cache.
// A tenant can only index a path under one of its allowed roots, and a principal must be a member of the tenant.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { StubProvider } from "@cie/model";
import type { ApiResult, CallContext, ModelProvider } from "@cie/schema";
import type { RouterModel } from "./llm-router.ts";
import { Service } from "./service.ts";
import { Store } from "./store.ts";
import { WorkerClient } from "./worker.ts";

export interface TenantConfig { /** Principals allowed to act for this tenant. Empty means any principal the transport authenticates for it. */ members: string[]; /** Absolute directories this tenant may index. */ allowedRoots: string[] }
const fail = <T>(ctx: CallContext, code: "UNAUTHORIZED" | "FORBIDDEN", message: string): ApiResult<T> => ({ ok: false, error: { code, message, retryable: false }, metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings: [] } });

export class TenantHost {
  private dir: string;
  private model: ModelProvider;
  private workerFactory: () => WorkerClient;
  private configs = new Map<string, TenantConfig>();
  private services = new Map<string, Service>();

  private router: RouterModel | null;

  constructor(dir: string, opts: { model?: ModelProvider; workerFactory?: () => WorkerClient; router?: RouterModel | null } = {}) {
    this.router = opts.router ?? null;
    this.dir = dir; mkdirSync(join(dir, "tenants"), { recursive: true });
    this.model = opts.model ?? new StubProvider(); this.workerFactory = opts.workerFactory ?? (() => new WorkerClient());
    const f = join(dir, "tenants.json");
    if (existsSync(f)) for (const [id, cfg] of Object.entries(JSON.parse(readFileSync(f, "utf8")) as Record<string, TenantConfig>)) this.configs.set(id, cfg);
  }
  private persist() { writeFileSync(join(this.dir, "tenants.json"), JSON.stringify(Object.fromEntries(this.configs), null, 1)); }

  register(tenantId: string, cfg: TenantConfig) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(tenantId)) throw new Error("a tenant id is 1-64 letters, digits, dots, dashes or underscores");
    this.configs.set(tenantId, { members: [...cfg.members], allowedRoots: cfg.allowedRoots.map((r) => { try { return realpathSync(r); } catch { return r; } }) });
    this.persist();
  }
  /** A tenant's file is named by a hash, so no tenant id, however odd, can point outside the tenants directory. */
  private fileFor(tenantId: string) { return join(this.dir, "tenants", createHash("sha256").update(tenantId).digest("hex").slice(0, 24) + ".db"); }

  /** The tenant's service, if the caller is a known tenant and (when members are listed) a member. The tenant comes from the trusted transport, never from request data. */
  service(ctx: CallContext): ApiResult<Service> {
    const t = ctx.actor.tenantId, cfg = this.configs.get(t);
    if (!cfg) return fail(ctx, "UNAUTHORIZED", "unknown tenant");
    if (cfg.members.length && !cfg.members.includes(ctx.actor.principalId)) return fail(ctx, "UNAUTHORIZED", "not a member of this tenant");
    let svc = this.services.get(t);
    if (!svc) { svc = new Service(new Store(this.fileFor(t)), this.workerFactory(), this.model); (svc as any).tenantId = t; svc.router = this.router; this.services.set(t, svc); }
    return { ok: true, value: svc, metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings: [] } };
  }

  /** May this tenant read this path? Only under an allowed root, after resolving links, so `..` and symlinks do not escape. */
  authorizeSource(ctx: CallContext, path: string): ApiResult<true> | null {
    const cfg = this.configs.get(ctx.actor.tenantId);
    if (!cfg) return fail(ctx, "UNAUTHORIZED", "unknown tenant");
    let real: string; try { real = realpathSync(path); } catch { return fail(ctx, "FORBIDDEN", "that path is not available to this tenant"); }
    return cfg.allowedRoots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep)) ? null : fail(ctx, "FORBIDDEN", "that path is not available to this tenant");
  }

  /** The first folder this tenant may read; where browsing starts. */
  firstRoot(ctx: CallContext): string | null { return this.configs.get(ctx.actor.tenantId)?.allowedRoots[0] ?? null; }

  /** Index a repository for a tenant, after authenticating it and authorizing the source. */
  async ingest(ctx: CallContext, req: { repoPath: string }) {
    const s = this.service(ctx);
    if (!s.ok) return s as ApiResult<never>;
    const denied = this.authorizeSource(ctx, req.repoPath);
    if (denied) return denied as ApiResult<never>;
    return s.value.ingestRepository(ctx, req);
  }
  close() { for (const s of this.services.values()) { (s as any).worker?.close?.(); s.store.db.close(); } this.services.clear(); }
}
