// C32: what an operator needs: is it healthy, did a restore actually work, is it inside its latency and cost budget,
// and will this server and that editor extension understand each other.
import { statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { currentVersion, MIGRATIONS } from "./migrations.ts";
import { restore, tempDir } from "./storage.ts";
import { Store } from "./store.ts";

export const API_VERSION = "1.1.0";
/** The oldest editor extension this server still understands. */
export const MIN_EXTENSION = "0.2.0";

const parse = (v: string) => v.split(".").map((x) => Number(x) || 0);
export const cmpVersion = (a: string, b: string) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; return 0; };

export interface Compat { ok: boolean; reason?: string }
/**
 * Do this server and this extension understand each other? The major version of the API must match (a different major
 * means a different wire format), and the extension must be at least the minimum the server supports.
 */
export function compatibility(server: { api: string; minExtension: string }, ext: { version: string; api: string }): Compat {
  if (parse(server.api)[0] !== parse(ext.api)[0]) return { ok: false, reason: `the extension speaks API ${ext.api} and the server API ${server.api}; update whichever is older` };
  if (cmpVersion(ext.version, server.minExtension) < 0) return { ok: false, reason: `extension ${ext.version} is older than the ${server.minExtension} this server supports; update the extension` };
  return { ok: true };
}

export interface Health { status: "ok" | "degraded" | "down"; checks: { name: string; ok: boolean; detail: string }[]; at: string }
export async function health(parts: { store: Store; ping: () => Promise<unknown>; model: { name: string; model: string; lastError: string | null }; dbPath?: string }): Promise<Health> {
  const checks: Health["checks"] = [];
  try { const t = Date.now(); parts.store.db.prepare("select 1").get(); checks.push({ name: "database", ok: true, detail: `answered in ${Date.now() - t} ms, schema v${currentVersion(parts.store.db)}` }); }
  catch (e) { checks.push({ name: "database", ok: false, detail: (e as Error).message }); }
  try { await parts.ping(); checks.push({ name: "parser", ok: true, detail: "the code parser answered" }); }
  catch (e) { checks.push({ name: "parser", ok: false, detail: `the code parser did not answer: ${(e as Error).message}` }); }
  checks.push({ name: "model", ok: !parts.model.lastError, detail: parts.model.lastError ? `${parts.model.name}/${parts.model.model}: last call failed (${parts.model.lastError}); answers fall back to facts only` : `${parts.model.name}/${parts.model.model}: no recent failure` });
  try {
    const dir = parts.dbPath && parts.dbPath !== ":memory:" ? dirname(parts.dbPath) : ".";
    const fs = statfsSync(dir); const freeMb = Math.round((fs.bavail * fs.bsize) / 1e6);
    checks.push({ name: "disk", ok: freeMb >= 100, detail: `${freeMb} MB free${freeMb < 100 ? "; writes may fail soon" : ""}` });
  } catch (e) { checks.push({ name: "disk", ok: false, detail: (e as Error).message }); }
  const down = checks.some((c) => !c.ok && (c.name === "database"));
  return { status: down ? "down" : checks.every((c) => c.ok) ? "ok" : "degraded", checks, at: new Date().toISOString() };
}

export interface RestoreDrill { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }
/** Prove a backup is usable: restore it somewhere else, open it as the real store, and check it is coherent. */
export function restoreDrill(backupPath: string): RestoreDrill {
  const checks: RestoreDrill["checks"] = [];
  const dir = tempDir();
  const target = join(dir, "drill.db");
  const rep = restore(backupPath, target);
  checks.push({ name: "restore", ok: rep.ok, detail: rep.ok ? `restored at schema v${rep.schemaVersion}` : rep.problems.join("; ") });
  if (!rep.ok) return { ok: false, checks };
  const s = new Store(target);
  try {
    const one = (sql: string) => Number((s.db.prepare(sql).get() as any).n);
    const audit = s.verifyAuditChain();
    checks.push({ name: "audit chain", ok: audit.ok, detail: audit.ok ? "the hash chain is intact" : `broken at event ${audit.brokenAt}` });
    const orphanClaims = one("select count(*) n from claims where revision not in (select id from revisions)");
    checks.push({ name: "claims", ok: orphanClaims === 0, detail: orphanClaims ? `${orphanClaims} claim(s) point at a revision that is not there` : "every claim has its revision" });
    const orphanWs = one("select count(*) n from workspaces where revision is not null and revision not in (select id from revisions)");
    checks.push({ name: "investigations", ok: orphanWs === 0, detail: orphanWs ? `${orphanWs} saved investigation(s) point at a missing revision` : "every saved investigation has its revision" });
    const orphanEv = one("select count(*) n from entities where revision not in (select id from revisions)");
    checks.push({ name: "entities", ok: orphanEv === 0, detail: orphanEv ? `${orphanEv} entity row(s) have no revision` : "every entity has its revision" });
    const v = currentVersion(s.db), newest = Math.max(...MIGRATIONS.map((m) => m.version));
    checks.push({ name: "schema", ok: v === newest, detail: `v${v} (this build is v${newest})` });
    const revs = one("select count(*) n from revisions");
    checks.push({ name: "readable", ok: true, detail: `${revs} revision(s), ${one("select count(*) n from entities")} entities readable` });
  } finally { s.db.close(); }
  return { ok: checks.every((c) => c.ok), checks };
}

export interface Measurements { indexMs: number; files: number; askMs: number[]; tokensPerAsk: number[] }
export interface Limits { indexMsPerFile: number; askP95Ms: number; maxTokensPerAsk: number }
export const DEFAULT_LIMITS: Limits = { indexMsPerFile: 250, askP95Ms: 2500, maxTokensPerAsk: 60_000 };
export const p95 = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

/** Release gates on speed and cost. A change that makes it slower or hungrier than the budget does not ship. */
export function checkGates(m: Measurements, limits: Limits = DEFAULT_LIMITS): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const perFile = m.files ? m.indexMs / m.files : 0;
  if (perFile > limits.indexMsPerFile) failures.push(`indexing took ${perFile.toFixed(1)} ms per file; the limit is ${limits.indexMsPerFile}`);
  if (p95(m.askMs) > limits.askP95Ms) failures.push(`asking took ${p95(m.askMs)} ms at the 95th percentile; the limit is ${limits.askP95Ms}`);
  const worst = Math.max(0, ...m.tokensPerAsk);
  if (worst > limits.maxTokensPerAsk) failures.push(`a question sent about ${worst} tokens to the model; the limit is ${limits.maxTokensPerAsk}`);
  return { ok: failures.length === 0, failures };
}
export { DatabaseSync };
