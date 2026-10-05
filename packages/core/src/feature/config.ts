// Feature configuration and the exact-binding gate. Defaults follow plan §8 (assumptions confirmed for Wave 0).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EgressPolicy, OutcomeMode, TrackingMode } from "./types.ts";

export interface FeatureConfig {
  /** MANDATORY for CREATE_DRAFT_PR, OPTIONAL for PLAN and BUILD_PREVIEW unless the project overrides (plan §8.2). */
  tracking: Partial<Record<OutcomeMode, TrackingMode>>;
  /** Plan §8.3: local-only unless the project opts in to a cloud provider. */
  egress: EgressPolicy;
  /** Scope → principals. Without a binding, policy/access/security decisions stay blocked (plan S7). */
  authorityFile: string;
  /** Concurrent runner processes (plan S12). */
  runnerPool: number;
  /** pf-perf-core-v1 repetitions per case (plan S11). */
  perfRepetitions: number;
  /** Stacks the slice can build and test (plan S17). */
  supportedStacks: string[];
}

export const DEFAULT_CONFIG: FeatureConfig = {
  tracking: { PLAN: "OPTIONAL", BUILD_PREVIEW: "OPTIONAL", CREATE_DRAFT_PR: "MANDATORY" },
  egress: "LOCAL_ONLY", authorityFile: ".cie/authority.json", runnerPool: 2, perfRepetitions: 10, supportedStacks: ["typescript-node-npm"],
};

export class ConfigError extends Error { constructor(m: string) { super(m); this.name = "ConfigError"; } }

const TRACKING = new Set(["MANDATORY", "OPTIONAL", "OFFLINE_UNSYNCED"]);
const MODES = new Set(["PLAN", "BUILD_PREVIEW", "CREATE_DRAFT_PR"]);

/** Reads `<repo>/.cie/feature.json`. Unknown keys and out-of-range values are rejected, never ignored. */
export function loadFeatureConfig(repoRoot: string): FeatureConfig {
  const file = join(repoRoot, ".cie", "feature.json");
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ConfigError(".cie/feature.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(".cie/feature.json must be an object");
  const o = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(o)) if (!known.has(k)) throw new ConfigError(`unknown setting ${k}`);
  const out = structuredClone(DEFAULT_CONFIG);
  if (o.tracking !== undefined) {
    const t = o.tracking as Record<string, unknown>;
    if (!t || typeof t !== "object") throw new ConfigError("tracking must be an object");
    for (const [m, v] of Object.entries(t)) { if (!MODES.has(m) || typeof v !== "string" || !TRACKING.has(v)) throw new ConfigError(`bad tracking entry ${m}`); out.tracking[m as OutcomeMode] = v as TrackingMode; }
  }
  if (o.egress !== undefined) { if (o.egress !== "LOCAL_ONLY" && o.egress !== "CLOUD_ALLOWED") throw new ConfigError("egress must be LOCAL_ONLY or CLOUD_ALLOWED"); out.egress = o.egress; }
  if (o.authorityFile !== undefined) { if (typeof o.authorityFile !== "string" || o.authorityFile.startsWith("/") || o.authorityFile.split("/").includes("..")) throw new ConfigError("authorityFile must be a relative path inside the repository"); out.authorityFile = o.authorityFile; }
  for (const k of ["runnerPool", "perfRepetitions"] as const) {
    if (o[k] === undefined) continue;
    if (!Number.isInteger(o[k]) || (o[k] as number) < 1 || (o[k] as number) > (k === "runnerPool" ? 16 : 200)) throw new ConfigError(`${k} is out of range`);
    out[k] = o[k] as number;
  }
  if (o.supportedStacks !== undefined) { if (!Array.isArray(o.supportedStacks) || !o.supportedStacks.every((s) => typeof s === "string")) throw new ConfigError("supportedStacks must be strings"); out.supportedStacks = o.supportedStacks as string[]; }
  return out;
}

export const trackingFor = (cfg: FeatureConfig, mode: OutcomeMode): TrackingMode => cfg.tracking[mode] ?? DEFAULT_CONFIG.tracking[mode] ?? "MANDATORY";

// ---------------------------------------------------------------------------------------------- exact-binding gate

export interface CanonParity { protocol: "pf-canon-v1"; vectorsSha256: string; node: { passed: boolean; vectors: number }; rust: { passed: boolean; vectors: number } }

/**
 * Exact-bound publication stays off until BOTH runtimes passed the CURRENT vector file (spec §29.1, plan T0.4).
 * The attestation is written by `scripts/canon-parity.mjs`. It guards against accidents (a vector edit nobody re-ran);
 * it is not tamper-proof, and a hostile local user could write it by hand.
 */
export function exactBindingEnabled(vectorsFile: string, attestationFile: string): { enabled: boolean; reason: string } {
  if (!existsSync(vectorsFile)) return { enabled: false, reason: "vector file is missing" };
  if (!existsSync(attestationFile)) return { enabled: false, reason: "no parity attestation: run scripts/canon-parity.mjs" };
  let a: CanonParity;
  try { a = JSON.parse(readFileSync(attestationFile, "utf8")); } catch { return { enabled: false, reason: "attestation is not valid JSON" }; }
  const sum = createHash("sha256").update(readFileSync(vectorsFile)).digest("hex");
  if (a.protocol !== "pf-canon-v1") return { enabled: false, reason: "attestation names a different protocol" };
  if (a.vectorsSha256 !== sum) return { enabled: false, reason: "vectors changed since the last parity run" };
  if (!a.node?.passed || !a.rust?.passed) return { enabled: false, reason: `parity failed (node ${a.node?.passed ? "ok" : "FAIL"}, rust ${a.rust?.passed ? "ok" : "FAIL"})` };
  if (!(a.node.vectors > 0) || a.node.vectors !== a.rust.vectors) return { enabled: false, reason: "the runtimes ran different numbers of vectors" };
  return { enabled: true, reason: `node and rust agree on ${a.node.vectors} vectors` };
}
