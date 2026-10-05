// Task 2.K — dependency diff and review (PF-046; AT-36, AT-62). Works on text only: the candidate is never installed or run.
// What it checks: direct dependency changes, install-time scripts, where each added package comes from, its integrity and licence,
// whether the lockfile moved with package.json, and (through an adapter) known advisories. A missing advisory source is INCOMPLETE,
// never PASS: offline means "unknown", not "safe".
import type { Finding, SecurityPolicy, Severity } from "./security.ts";
import { securityPolicyHash } from "./security.ts";

export interface DepChange { name: string; section: string; before?: string; after?: string; kind: "ADDED" | "REMOVED" | "CHANGED" }
export interface LockPackage { name: string; version: string; resolved?: string; integrity?: string; hasInstallScript?: boolean; license?: string; dev?: boolean }
export interface Advisory { name: string; version: string; id: string; severity: Severity; summary: string }
export interface AdvisoryAdapter { name: string; lookup(pkgs: { name: string; version: string }[], signal?: AbortSignal): Promise<Advisory[]> | Advisory[] }

export interface DependencyReport {
  schemaVersion: 1; changes: DepChange[]; scriptChanges: string[]; added: LockPackage[]; findings: Finding[]; advisories: Advisory[];
  gaps: string[]; status: "PASS" | "BLOCKED" | "INCOMPLETE"; advisoriesChecked: boolean; lockfile: "UPDATED" | "UNCHANGED" | "ABSENT" | "NOT_APPLICABLE"; policyHash: string;
}

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish"] as const;

export interface ParsedPackage { sections: Record<string, Record<string, string>>; scripts: Record<string, string>; invalid: boolean }
export function parsePackageJson(text: string | null): ParsedPackage {
  const empty: ParsedPackage = { sections: {}, scripts: {}, invalid: false };
  if (text === null) return empty;
  try {
    const j = JSON.parse(text) as Record<string, any>;
    const sections: Record<string, Record<string, string>> = {};
    for (const s of SECTIONS) if (j?.[s] && typeof j[s] === "object") sections[s] = Object.fromEntries(Object.entries(j[s]).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    return { sections, scripts: j?.scripts && typeof j.scripts === "object" ? j.scripts : {}, invalid: false };
  } catch { return { ...empty, invalid: true }; }
}

/** npm lockfile v2/v3 (`packages`) and v1 (`dependencies`). Unknown shapes yield an empty map, reported by the caller as a gap. */
export function parseLock(text: string | null): { packages: Map<string, LockPackage>; valid: boolean } {
  const packages = new Map<string, LockPackage>();
  if (text === null) return { packages, valid: true };
  let j: any; try { j = JSON.parse(text); } catch { return { packages, valid: false }; }
  const put = (name: string, p: any) => { if (name && p && typeof p.version === "string") packages.set(`${name}@${p.version}`, { name, version: p.version, resolved: p.resolved, integrity: p.integrity, hasInstallScript: p.hasInstallScript === true, license: typeof p.license === "string" ? p.license : Array.isArray(p.license) ? p.license.join(" OR ") : undefined, dev: p.dev === true }); };
  if (j?.packages && typeof j.packages === "object") for (const [k, p] of Object.entries(j.packages)) { const at = k.lastIndexOf("node_modules/"); if (at >= 0) put(k.slice(at + "node_modules/".length), p); }
  else if (j?.dependencies && typeof j.dependencies === "object") { const walk = (deps: Record<string, any>) => { for (const [n, p] of Object.entries(deps)) { put(n, p); if (p?.dependencies) walk(p.dependencies); } }; walk(j.dependencies); }
  else return { packages, valid: false };
  return { packages, valid: true };
}

export function diffDependencies(before: ParsedPackage, after: ParsedPackage): { changes: DepChange[]; scriptChanges: string[] } {
  const changes: DepChange[] = [];
  for (const s of SECTIONS) {
    const a = before.sections[s] ?? {}, b = after.sections[s] ?? {};
    for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(n in a)) changes.push({ name: n, section: s, after: b[n], kind: "ADDED" });
      else if (!(n in b)) changes.push({ name: n, section: s, before: a[n], kind: "REMOVED" });
      else if (a[n] !== b[n]) changes.push({ name: n, section: s, before: a[n], after: b[n], kind: "CHANGED" });
    }
  }
  const scriptChanges = INSTALL_SCRIPTS.filter((s) => (before.scripts[s] ?? null) !== (after.scripts[s] ?? null)).map((s) => `scripts.${s} ${before.scripts[s] === undefined ? "added" : after.scripts[s] === undefined ? "removed" : "changed"}`);
  return { changes, scriptChanges };
}

const NON_REGISTRY = /^(git\+|git:|git@|ssh:|https?:|github:|gitlab:|bitbucket:|file:|link:|workspace:|[\w.-]+\/[\w.-]+(#.*)?$)/i;
const UNPINNED = /^(\*|latest|x|)$/i;

export interface DependencyInput {
  read: (path: string, side: "base" | "candidate") => string | null;
  lockfileExists: boolean; policy: SecurityPolicy; advisories?: AdvisoryAdapter[]; signal?: AbortSignal;
  /** Paths of package.json files and lockfiles the candidate changed; the review covers exactly these. */
  changedPaths: string[];
}

export async function reviewDependencies(i: DependencyInput): Promise<DependencyReport> {
  const findings: Finding[] = []; const gaps: string[] = []; const changes: DepChange[] = []; const scriptChanges: string[] = [];
  const pkgPaths = i.changedPaths.filter((p) => /(^|\/)package\.json$/.test(p)), lockPaths = i.changedPaths.filter((p) => /(^|\/)package-lock\.json$/.test(p));
  const add = (rule: string, severity: Severity, path: string, message: string, excerpt?: string): void => { findings.push({ id: `${rule}:${path}:${excerpt ?? message}`.slice(0, 200), rule, cls: "DEPENDENCY", severity, path, message, excerpt, origin: "BUILTIN", introduced: true }); };

  for (const p of pkgPaths) {
    const before = parsePackageJson(i.read(p, "base")), after = parsePackageJson(i.read(p, "candidate"));
    if (after.invalid) { add("DEP001", "HIGH", p, "package.json is no longer valid JSON, so its dependencies cannot be reviewed"); continue; }
    const d = diffDependencies(before, after); changes.push(...d.changes); scriptChanges.push(...d.scriptChanges.map((s) => `${p}: ${s}`));
    for (const s of d.scriptChanges) add("DEP002", "HIGH", p, `an install-time script changed (${s}); it runs on every consumer's install`, s);
    for (const c of d.changes) {
      if (c.kind === "REMOVED") continue;
      const range = c.after ?? "";
      if (NON_REGISTRY.test(range)) add("DEP003", "HIGH", p, `${c.name} (${c.section}) is resolved from outside the registry: ${range.slice(0, 80)}`, c.name);
      else if (UNPINNED.test(range)) add("DEP004", "MEDIUM", p, `${c.name} (${c.section}) uses an unpinned range "${range}"`, c.name);
    }
  }

  const lockBefore = new Map<string, LockPackage>(), lockAfter = new Map<string, LockPackage>();
  for (const p of lockPaths) {
    const b = parseLock(i.read(p, "base")), a = parseLock(i.read(p, "candidate"));
    if (!a.valid) { gaps.push(`${p} could not be parsed, so the added packages were not reviewed`); continue; }
    for (const [k, v] of b.packages) lockBefore.set(k, v); for (const [k, v] of a.packages) lockAfter.set(k, v);
  }
  const added = [...lockAfter.values()].filter((p) => !lockBefore.has(`${p.name}@${p.version}`)).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const trusted = (r: string) => i.policy.trustedRegistries.some((t) => r.startsWith(t));
  let noLicence = 0;
  for (const p of added) {
    const id = `${p.name}@${p.version}`, at = lockPaths[0] ?? "package-lock.json";
    if (p.hasInstallScript && !i.policy.allowInstallScripts.includes(p.name)) add("DEP005", "HIGH", at, `${id} runs an install script and is not on the allowed list`, id);
    if (p.resolved && !trusted(p.resolved) && !/^(file|link):/.test(p.resolved)) add("DEP006", "HIGH", at, `${id} is fetched from an untrusted source: ${p.resolved.slice(0, 80)}`, id);
    if (!p.integrity && !(p.resolved ?? "").startsWith("file:") && !(p.resolved ?? "").startsWith("link:")) add("DEP007", "MEDIUM", at, `${id} has no integrity hash, so its content cannot be verified`, id);
    if (!p.license) { noLicence++; continue; }
    // "A OR B" is acceptable if any one alternative is; "A AND B" needs every part to be.
    const alternatives = p.license.split(/\s+OR\s+/i).map((x) => x.replace(/[()]/g, "").trim()).filter(Boolean);
    const parts = (alt: string) => alt.split(/\s+AND\s+/i).map((x) => x.trim()).filter(Boolean);
    if (alternatives.length && alternatives.every((alt) => parts(alt).some((x) => i.policy.denyLicences.includes(x)))) add("DEP008", "HIGH", at, `${id} is licensed ${p.license}, which the policy denies`, id);
    else if (i.policy.allowLicences && !alternatives.some((alt) => parts(alt).every((x) => i.policy.allowLicences!.includes(x)))) add("DEP009", "HIGH", at, `${id} is licensed ${p.license}, which is not on the allowed list`, id);
  }
  if (noLicence) gaps.push(`the licence of ${noLicence} added package(s) is not recorded in the lockfile, so it was not checked`);

  const directChanged = changes.some((c) => c.kind !== "REMOVED");
  const lockfile: DependencyReport["lockfile"] = !pkgPaths.length && !lockPaths.length ? "NOT_APPLICABLE" : lockPaths.length ? "UPDATED" : i.lockfileExists ? "UNCHANGED" : "ABSENT";
  if (directChanged && lockfile === "UNCHANGED") gaps.push("package.json dependencies changed but the lockfile did not, so the resolved versions are not pinned or reviewable");
  if (directChanged && lockfile === "ABSENT") gaps.push("there is no lockfile, so the versions this change resolves to are not pinned");
  if (directChanged && lockfile === "UPDATED") for (const c of changes.filter((x) => x.kind !== "REMOVED" && x.section !== "peerDependencies")) if (![...lockAfter.values()].some((p) => p.name === c.name)) gaps.push(`${c.name} was added to package.json but does not appear in the updated lockfile`);

  const toCheck = added.map((p) => ({ name: p.name, version: p.version }));
  let advisories: Advisory[] = []; let advisoriesChecked = false;
  if (toCheck.length) {
    const adapters = i.advisories ?? [];
    if (!adapters.length) gaps.push(`no advisory source is available (offline): the known-vulnerability status of ${toCheck.length} added package(s) is unknown`);
    for (const a of adapters) {
      try { advisories = advisories.concat(await a.lookup(toCheck, i.signal)); advisoriesChecked = true; }
      catch (e) { gaps.push(`advisory source ${a.name} failed: ${String((e as Error).message ?? e).slice(0, 80)}`); }
    }
    for (const adv of advisories) if (adv.severity === "CRITICAL" || adv.severity === "HIGH") add("DEP010", adv.severity, "package-lock.json", `${adv.name}@${adv.version}: ${adv.id} — ${adv.summary.slice(0, 120)}`, `${adv.name}@${adv.version}:${adv.id}`);
  }
  const blocking = findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
  return { schemaVersion: 1, changes, scriptChanges, added, findings, advisories, gaps, status: blocking ? "BLOCKED" : gaps.length ? "INCOMPLETE" : "PASS", advisoriesChecked, lockfile, policyHash: securityPolicyHash(i.policy) };
}
