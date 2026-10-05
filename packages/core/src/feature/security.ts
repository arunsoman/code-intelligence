// Task 2.K — security gate over a candidate's changed files (PF-045, PF-047; AT-35, AT-36, AT-62).
// Analysis is static and in-process: no candidate code is executed. Rules:
//   * only lines the candidate INTRODUCES can block; lines already in the base are reported as pre-existing
//   * a finding never stores the secret: only rule, path, line and a masked excerpt
//   * a missing tool is INCOMPLETE, never PASS: the built-in rules are pattern checks, so for anything above docs-only the gate
//     is complete only when an external static-analysis adapter ran clean (plan S14)
//   * a suppression needs an owner with security authority, a reason and a future expiry, and is still listed in the report
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorize, type AuthorityConfig } from "./authority.ts";
import { ConfigError } from "./config.ts";
import { asSet, canonHash, defineSchema, type Canon } from "./canon.ts";
import type { Id, Tier } from "./types.ts";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type FindingClass = "SECRET" | "SAST" | "DEPENDENCY" | "PROVENANCE";
export interface Finding { id: string; rule: string; cls: FindingClass; severity: Severity; path: string; line?: number; message: string; excerpt?: string; origin: "BUILTIN" | string; introduced: boolean }
export interface Suppression { rule: string; path: string; reason: string; owner: Id; expires: string }
export interface SecurityPolicy {
  suppressions: Suppression[];
  /** Whether an external static-analysis adapter is required for tiers above T0 (default true; see header). */
  requireExternalSast: boolean;
  /** When true, a missing code-similarity source is a gap (default false: there is no offline source, so it is reported as a coverage note instead). */
  requireSimilarityCheck: boolean;
  /** Names allowed to run install scripts, and registries other than npm that are trusted. */
  allowInstallScripts: string[]; trustedRegistries: string[]; denyLicences: string[]; allowLicences?: string[];
}
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  suppressions: [], requireExternalSast: true, requireSimilarityCheck: false, allowInstallScripts: [], trustedRegistries: ["https://registry.npmjs.org/"],
  denyLicences: ["GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0"],
};

const KEYS = new Set(Object.keys(DEFAULT_SECURITY_POLICY));
/** `.cie/security.json`; unknown keys and malformed suppressions are rejected, not ignored. */
export function loadSecurityPolicy(repoRoot: string): SecurityPolicy {
  const file = join(repoRoot, ".cie", "security.json");
  if (!existsSync(file)) return structuredClone(DEFAULT_SECURITY_POLICY);
  let raw: any; try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ConfigError(".cie/security.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(".cie/security.json must be an object");
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) throw new ConfigError(`unknown security setting ${k}`);
  const out = structuredClone(DEFAULT_SECURITY_POLICY);
  const strs = (k: string) => { if (!Array.isArray(raw[k]) || !raw[k].every((s: unknown) => typeof s === "string" && s.length > 0 && s.length < 200)) throw new ConfigError(`${k} must be a list of strings`); return raw[k] as string[]; };
  for (const k of ["requireExternalSast", "requireSimilarityCheck"] as const) if (raw[k] !== undefined) { if (typeof raw[k] !== "boolean") throw new ConfigError(`${k} must be true or false`); out[k] = raw[k]; }
  for (const k of ["allowInstallScripts", "trustedRegistries", "denyLicences"] as const) if (raw[k] !== undefined) out[k] = strs(k);
  if (raw.allowLicences !== undefined) out.allowLicences = strs("allowLicences");
  if (raw.suppressions !== undefined) {
    if (!Array.isArray(raw.suppressions)) throw new ConfigError("suppressions must be a list");
    out.suppressions = raw.suppressions.map((s: any, i: number): Suppression => {
      for (const k of Object.keys(s ?? {})) if (!["rule", "path", "reason", "owner", "expires"].includes(k)) throw new ConfigError(`suppression ${i}: unknown key ${k}`);
      for (const k of ["rule", "path", "reason", "owner", "expires"]) if (typeof s?.[k] !== "string" || !s[k].trim()) throw new ConfigError(`suppression ${i}: ${k} is required`);
      if (Number.isNaN(Date.parse(s.expires))) throw new ConfigError(`suppression ${i}: expires must be a date`);
      return { rule: s.rule, path: s.path, reason: s.reason, owner: s.owner, expires: s.expires };
    });
  }
  return out;
}
const PolicyIdentity = defineSchema<SecurityPolicy>("pf.SecurityPolicy", "1", (p) => ({
  requireExternalSast: p.requireExternalSast, requireSimilarityCheck: p.requireSimilarityCheck, allowInstallScripts: asSet([...p.allowInstallScripts]) as Canon, trustedRegistries: asSet([...p.trustedRegistries]) as Canon, denyLicences: asSet([...p.denyLicences]) as Canon,
  allowLicences: p.allowLicences ? asSet([...p.allowLicences]) as Canon : null,
  suppressions: asSet(p.suppressions.map((s): Canon => ({ rule: s.rule, path: s.path, reason: s.reason, owner: s.owner, expires: s.expires }))) as Canon,
}));
export const securityPolicyHash = (p: SecurityPolicy): string => canonHash(PolicyIdentity, p);

// ------------------------------------------------------------------------------------------------ rules

const PLACEHOLDER = /^(x+|\*+|\.+|changeme|change-me|example|examples?[-_ ].*|placeholder|your[-_ ].*|<.*>|\$\{.*\}|%.*%|test|dummy|secret|password|token|redacted|null|undefined|none)$/i;
const entropy = (s: string): number => { const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1); let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); } return h; };
const mask = (s: string): string => `${s.slice(0, 2)}…(${s.length} chars)`;

interface LineRule { id: string; cls: FindingClass; severity: Severity; message: string; test: (line: string) => string | null }
const re = (r: RegExp) => (line: string) => { const m = r.exec(line); return m ? m[0] : null; };

export const SECRET_RULES: LineRule[] = [
  { id: "SEC001", cls: "SECRET", severity: "CRITICAL", message: "an AWS access key id", test: re(/\bAKIA[0-9A-Z]{16}\b/) },
  { id: "SEC002", cls: "SECRET", severity: "CRITICAL", message: "a GitHub token", test: re(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/) },
  { id: "SEC003", cls: "SECRET", severity: "CRITICAL", message: "a private key block", test: re(/-----BEGIN [A-Z ]*PRIVATE KEY-----/) },
  { id: "SEC004", cls: "SECRET", severity: "CRITICAL", message: "a Slack token", test: re(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/) },
  { id: "SEC005", cls: "SECRET", severity: "HIGH", message: "a JSON web token", test: re(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/) },
  { id: "SEC008", cls: "SECRET", severity: "CRITICAL", message: "an API key (sk-…)", test: re(/\bsk-[A-Za-z0-9_-]{20,}\b/) },
  { id: "SEC009", cls: "SECRET", severity: "HIGH", message: "a connection string with an embedded password", test: (l) => { const m = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/i.exec(l); return m && !PLACEHOLDER.test(m[1]!) && !/^\$\{|^%|^<|^\{\{/.test(m[1]!) ? m[0] : null; } },
  { id: "SEC006", cls: "SECRET", severity: "HIGH", message: "a hard-coded credential assignment", test: (l) => { const m = /\b(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|auth)\w*\s*[:=]\s*(["'`])([^"'`\s]{8,})\1/i.exec(l); return m && !PLACEHOLDER.test(m[2]!) && !/process\.env|import\.meta\.env/.test(l) ? m[0] : null; } },
  { id: "SEC007", cls: "SECRET", severity: "MEDIUM", message: "a long high-entropy string literal", test: (l) => { for (const m of l.matchAll(/(["'`])([A-Za-z0-9+/_=-]{32,})\1/g)) { const v = m[2]!; if (!/^[0-9a-f]+$/i.test(v) && entropy(v) >= 4.3 && !/^sha(?:1|256|384|512)-/.test(v) ) return m[0]; } return null; } },
];

/** SAST002: a child_process call (bare exec/execSync, or through child_process/cp) whose command is not a plain literal; RegExp.exec and other receivers are not shell calls. */
function shellCommandFromText(l: string): string | null {
  const call = /(?:(?<![\w$.])|\b(?:child_process|childProcess|cp)\.)(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*/g;
  for (const m of l.matchAll(call)) {
    const fn = m[1]!; const rest = l.slice(m.index! + m[0].length);
    const literal = /^(["'])(?:\\.|(?!\1).)*\1\s*(?=[,)])/.test(rest) || /^`[^`$]*`\s*(?=[,)])/.test(rest);
    if (literal) continue;
    if (/^(?:exec|execSync)$/.test(fn)) return m[0] + rest.slice(0, 20);
    if (/\bshell\s*:\s*true\b/.test(rest) || fn === "execFile" || fn === "execFileSync") return m[0] + rest.slice(0, 20);
  }
  return null;
}
export const SAST_RULES: LineRule[] = [
  { id: "SAST001", cls: "SAST", severity: "HIGH", message: "dynamic code evaluation (eval / new Function)", test: re(/\beval\s*\(|\bnew\s+Function\s*\(/) },
  { id: "SAST002", cls: "SAST", severity: "HIGH", message: "a shell command built from non-literal text", test: (l) => shellCommandFromText(l) },
  { id: "SAST003", cls: "SAST", severity: "HIGH", message: "TLS certificate verification disabled", test: re(/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/) },
  { id: "SAST004", cls: "SAST", severity: "MEDIUM", message: "unsafe HTML insertion", test: re(/\.(?:innerHTML|outerHTML)\s*=[^=]|dangerouslySetInnerHTML|document\.write\s*\(/) },
  { id: "SAST005", cls: "SAST", severity: "HIGH", message: "SQL built by string concatenation or interpolation", test: re(/\b(?:query|execute|exec|raw|all|get|run)\s*\(\s*(?:`[^`]*\b(?:select|insert|update|delete)\b[^`]*\$\{|["'][^"']*\b(?:select|insert|update|delete)\b[^"']*["']\s*\+)/i) },
  { id: "SAST006", cls: "SAST", severity: "MEDIUM", message: "a weak hash algorithm (md5 or sha1)", test: re(/createHash\(\s*["'](?:md5|sha1)["']/i) },
  { id: "SAST007", cls: "SAST", severity: "MEDIUM", message: "Math.random used where an unpredictable value is needed", test: (l) => /Math\.random\s*\(/.test(l) && /token|secret|password|session|nonce|csrf|otp|apikey|api_key/i.test(l) ? "Math.random()" : null },
  { id: "SAST008", cls: "SAST", severity: "LOW", message: "a non-local plain-HTTP URL", test: (l) => { const m = /["'`]http:\/\/(?!localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|example\.(?:com|org)|www\.w3\.org)[^"'`\s]+/.exec(l); return m ? m[0] : null; } },
  { id: "SAST009", cls: "SAST", severity: "MEDIUM", message: "CORS open to every origin", test: re(/Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']|\borigin\s*:\s*["']\*["']/) },
  { id: "SAST010", cls: "SAST", severity: "HIGH", message: "a file path taken straight from the request", test: re(/\b(?:readFile|readFileSync|createReadStream|sendFile|unlink|unlinkSync|writeFile|writeFileSync)\s*\([^)]*\b(?:req|request|ctx)\.(?:params|query|body)\b/) },
];

const SCANNED = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|env|ini|properties|sh|py|go|rs|java|kt|rb|php|cs|sql|md|txt|conf|cfg|xml|html|css)$|(^|\/)(Dockerfile|\.npmrc|\.netrc)$/i;
export interface ScanFile { path: string; text: string; base: string | null }

/** Lines of `text` that are new relative to `base` (by trimmed content, as a multiset, so moved lines are not "introduced"). */
export function introducedLines(text: string, base: string | null): Set<number> {
  const out = new Set<number>(); const lines = text.split("\n");
  if (base === null) { lines.forEach((_, i) => out.add(i + 1)); return out; }
  const have = new Map<string, number>(); for (const l of base.split("\n")) { const k = l.trim(); have.set(k, (have.get(k) ?? 0) + 1); }
  lines.forEach((l, i) => { const k = l.trim(); const n = have.get(k) ?? 0; if (n > 0) have.set(k, n - 1); else out.add(i + 1); });
  return out;
}

export function scanFiles(files: ScanFile[], rules: LineRule[], origin = "BUILTIN"): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!SCANNED.test(f.path) || f.text.length > 2_000_000) continue;
    const added = introducedLines(f.text, f.base);
    f.text.split("\n").forEach((line, i) => {
      if (line.length > 4000) return; // minified or generated: not meaningfully line-checkable
      for (const r of rules) {
        const hit = r.test(line); if (!hit) continue;
        out.push({ id: `${r.id}:${f.path}:${i + 1}`, rule: r.id, cls: r.cls, severity: r.severity, path: f.path, line: i + 1, message: r.message, excerpt: r.cls === "SECRET" ? mask(hit) : hit.slice(0, 80), origin, introduced: added.has(i + 1) });
      }
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ adapters

export interface SastAdapter { name: string; version: string; scan(files: ScanFile[], signal?: AbortSignal): Promise<Finding[]> | Finding[] }
export interface SecurityTools { sast: SastAdapter[] }
export interface ToolRun { name: string; version: string; kind: "BUILTIN" | "EXTERNAL"; ran: boolean; error?: string }

export interface SecurityReport {
  schemaVersion: 1; tier: Tier; scanned: string[]; findings: Finding[]; suppressed: (Finding & { suppression: Suppression })[]; preexisting: Finding[];
  tools: ToolRun[]; gaps: string[]; status: "PASS" | "BLOCKED" | "INCOMPLETE"; blocking: Finding[]; policyHash: string;
}
const BLOCKING: Severity[] = ["CRITICAL", "HIGH"];

export interface SecurityInput { files: ScanFile[]; tier: Tier; policy: SecurityPolicy; tools?: SecurityTools; auth: AuthorityConfig; requester: Id; now?: string; signal?: AbortSignal }
export async function runSecurityScan(i: SecurityInput): Promise<SecurityReport> {
  const gaps: string[] = []; const tools: ToolRun[] = [{ name: "builtin-secret-scan", version: "1", kind: "BUILTIN", ran: true }, { name: "builtin-pattern-rules", version: "1", kind: "BUILTIN", ran: true }];
  let found = scanFiles(i.files, [...SECRET_RULES, ...SAST_RULES]);
  let externalClean = false;
  for (const a of i.tools?.sast ?? []) {
    try { const r = await a.scan(i.files, i.signal); found = found.concat(r.map((f) => ({ ...f, origin: a.name }))); tools.push({ name: a.name, version: a.version, kind: "EXTERNAL", ran: true }); externalClean = true; }
    catch (e) { tools.push({ name: a.name, version: a.version, kind: "EXTERNAL", ran: false, error: String((e as Error).message ?? e).slice(0, 120) }); gaps.push(`static-analysis adapter ${a.name} failed: ${String((e as Error).message ?? e).slice(0, 80)}`); }
  }
  const now = i.now ?? new Date().toISOString();
  const valid = i.policy.suppressions.filter((s) => s.expires > now && authorize(i.auth, s.owner, "security", i.requester).allowed);
  for (const s of i.policy.suppressions) if (!valid.includes(s)) gaps.push(s.expires <= now ? `suppression of ${s.rule} at ${s.path} expired and is ignored` : `suppression of ${s.rule} at ${s.path} is ignored: ${s.owner} has no security authority`);
  const suppressed: SecurityReport["suppressed"] = []; const live: Finding[] = [];
  for (const f of found) {
    const s = valid.find((x) => x.rule === f.rule && (x.path === f.path || (x.path.endsWith("/") && f.path.startsWith(x.path))));
    if (s && f.introduced) suppressed.push({ ...f, suppression: s }); else live.push(f);
  }
  const preexisting = live.filter((f) => !f.introduced), introduced = live.filter((f) => f.introduced);
  const blocking = introduced.filter((f) => f.cls === "SECRET" ? f.severity !== "LOW" : BLOCKING.includes(f.severity));
  const needsExternal = i.tier !== "T0" && i.policy.requireExternalSast;
  if (needsExternal && !externalClean) gaps.push("no external static-analysis adapter ran: only the built-in pattern rules were applied, so the code is not fully analysed");
  const status: SecurityReport["status"] = blocking.length ? "BLOCKED" : gaps.length ? "INCOMPLETE" : "PASS";
  return { schemaVersion: 1, tier: i.tier, scanned: i.files.filter((f) => SCANNED.test(f.path)).map((f) => f.path).sort(), findings: introduced, suppressed, preexisting, tools, gaps, status, blocking, policyHash: securityPolicyHash(i.policy) };
}
