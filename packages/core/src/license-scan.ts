// License/SBOM scanner for the release-readiness ledger. Stateless: reads whichever manifest files exist in a
// repository and reports what it found. A license is never guessed — absent a real lookup it is reported "UNKNOWN",
// the same "say I can't determine this" rule the rest of the system follows (e.g. C25's own findings carry
// disclaimers rather than invented certainty).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Ecosystem = "npm" | "cargo" | "go" | "pip";
export interface ManifestDependency { name: string; version: string }
export interface ManifestScanResult { ecosystem: Ecosystem; dependencies: ManifestDependency[] }

export interface SbomComponent { name: string; version: string; license: string }
export interface SbomResult { components: SbomComponent[]; forbidden: SbomComponent[] }

function scanNpm(repoRoot: string): ManifestScanResult | null {
  const path = join(repoRoot, "package.json");
  if (!existsSync(path)) return null;
  let json: any;
  try { json = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const deps: ManifestDependency[] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const entries = json?.[section];
    if (entries && typeof entries === "object") for (const [name, version] of Object.entries(entries)) deps.push({ name, version: String(version) });
  }
  return { ecosystem: "npm", dependencies: deps };
}

function scanCargo(repoRoot: string): ManifestScanResult | null {
  const path = join(repoRoot, "Cargo.toml");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let inDeps = false;
  const deps: ManifestDependency[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inDeps = /^\[dependencies/.test(line); continue; }
    if (!inDeps || !line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(line) ?? /^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(line);
    if (m) deps.push({ name: m[1]!, version: m[2]! });
  }
  return { ecosystem: "cargo", dependencies: deps };
}

function scanGo(repoRoot: string): ManifestScanResult | null {
  const path = join(repoRoot, "go.mod");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const deps: ManifestDependency[] = [];
  let inRequire = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^require\s*\(/.test(line)) { inRequire = true; continue; }
    if (inRequire && line === ")") { inRequire = false; continue; }
    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (single) { deps.push({ name: single[1]!, version: single[2]! }); continue; }
    if (inRequire) {
      const m = /^(\S+)\s+(\S+)/.exec(line);
      if (m) deps.push({ name: m[1]!, version: m[2]! });
    }
  }
  return { ecosystem: "go", dependencies: deps };
}

function scanPip(repoRoot: string): ManifestScanResult | null {
  const path = join(repoRoot, "requirements.txt");
  if (!existsSync(path)) return null;
  const deps: ManifestDependency[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9._-]+)\s*==\s*([^\s;]+)/.exec(line);
    if (m) { deps.push({ name: m[1]!, version: m[2]! }); continue; }
    const bare = /^([A-Za-z0-9._-]+)\s*$/.exec(line);
    if (bare) deps.push({ name: bare[1]!, version: "*" });
  }
  return { ecosystem: "pip", dependencies: deps };
}

/** Reads whichever manifests exist at repoRoot. A missing manifest is skipped, never an error. */
export function scanManifests(repoRoot: string): ManifestScanResult[] {
  const results = [scanNpm(repoRoot), scanCargo(repoRoot), scanGo(repoRoot), scanPip(repoRoot)];
  return results.filter((r): r is ManifestScanResult => r !== null);
}

/** Builds a minimal SBOM from a flat dependency list. A license is UNKNOWN unless `licenseOf` resolves one;
 *  UNKNOWN is never treated as forbidden, since that would be guessing a violation from an absence of data. */
export function buildSbom(deps: ManifestDependency[], opts: { licenseOf?: (name: string, version: string) => string | null; forbiddenLicenses?: string[] } = {}): SbomResult {
  const forbiddenSet = new Set(opts.forbiddenLicenses ?? []);
  const components: SbomComponent[] = deps.map((d) => ({ name: d.name, version: d.version, license: opts.licenseOf?.(d.name, d.version) ?? "UNKNOWN" }));
  const forbidden = components.filter((c) => c.license !== "UNKNOWN" && forbiddenSet.has(c.license));
  return { components, forbidden };
}
