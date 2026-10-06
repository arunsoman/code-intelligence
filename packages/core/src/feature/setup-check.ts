// "Is this machine and repository ready to run prompt-to-feature?" Every check says what it found and, when it is not ready, the exact step
// that fixes it. Probes are injectable so the checks are testable without Docker, gh or a model daemon.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ghAuthStatus } from "../gh.ts";
import type { Store } from "../store.ts";
import { loadAuthority } from "./authority.ts";
import { loadFeatureConfig } from "./config.ts";
import { dockerAvailable } from "./docker-runner.ts";
import { generationRouteAllowed } from "./model.ts";
import { generationRoutesFor } from "../llm-router.ts";
import { loadSecurityPolicy } from "./security.ts";

export type SetupState = "READY" | "WARN" | "MISSING";
export type SetupItem = { id: string; state: SetupState; detail: string; fix?: string };
export interface SetupProbes {
  docker?: () => { daemon: boolean; image: boolean }; gh?: () => { ok: boolean; detail: string }; ollama?: () => Promise<{ reachable: boolean; models: string[] }>;
  image?: string; ollamaUrl?: string;
}

const defaultDocker = (image: string) => (): { daemon: boolean; image: boolean } => {
  let daemon = false; try { daemon = spawnSync("/usr/bin/docker", ["info"], { stdio: "ignore", timeout: 8000 }).status === 0; } catch { /* no docker */ }
  return { daemon, image: daemon && dockerAvailable(image) };
};
const defaultOllama = (url: string) => async (): Promise<{ reachable: boolean; models: string[] }> => {
  try { const r = await fetch(`${url.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) }); if (!r.ok) return { reachable: false, models: [] }; const j = await r.json() as { models?: { name: string }[] }; return { reachable: true, models: (j.models ?? []).map((m) => m.name) }; }
  catch { return { reachable: false, models: [] }; }
};

export async function setupCheck(store: Store, repoRoot: string, probes: SetupProbes = {}): Promise<{ ready: boolean; items: SetupItem[] }> {
  const items: SetupItem[] = []; const add = (id: string, state: SetupState, detail: string, fix?: string) => items.push({ id, state, detail, ...(fix ? { fix } : {}) });
  const image = probes.image ?? "node:24-alpine";
  const rev = store.latestRevision(repoRoot);
  add("INDEX", rev ? "READY" : "MISSING", rev ? "the repository is indexed" : "the repository is not indexed (or access to it was withdrawn)", rev ? undefined : "Index the repository first");

  let cfg: ReturnType<typeof loadFeatureConfig> | undefined;
  if (rev) {
  try { cfg = loadFeatureConfig(repoRoot); add("FEATURE_CONFIG", "READY", `egress ${cfg.egress}; stacks ${cfg.supportedStacks.join(", ")}`); } catch (e) { add("FEATURE_CONFIG", "MISSING", `.cie/feature.json is invalid: ${(e as Error).message}`, "Fix or remove .cie/feature.json"); }
  try { const a = loadAuthority(repoRoot, cfg?.authorityFile); add("AUTHORITY", a.bindings.length ? "READY" : "WARN", a.bindings.length ? `${a.bindings.length} authority binding(s)` : "no authority binding: the requester may decide business questions; policy, access, security and release decisions stay blocked", a.bindings.length ? undefined : `Name who may decide those in ${cfg?.authorityFile ?? ".cie/authority.json"}`); }
  catch (e) { add("AUTHORITY", "MISSING", `the authority file is invalid: ${(e as Error).message}`, "Fix the authority file"); }
  try { const p = loadSecurityPolicy(repoRoot); add("SECURITY_POLICY", p.requireExternalSast ? "WARN" : "READY", p.requireExternalSast ? "an external static-analysis tool is required by policy and none is configured, so the security gate will be incomplete" : "external static analysis is not required by this repository's policy; only the built-in pattern rules run", p.requireExternalSast ? "Configure a SAST adapter, or set requireExternalSast to false in .cie/security.json if that is the repository's decision" : undefined); }
  catch (e) { add("SECURITY_POLICY", "MISSING", `.cie/security.json is invalid: ${(e as Error).message}`, "Fix .cie/security.json"); }

  const hasNode = existsSync(join(repoRoot, "package.json"));
  add("STACK", hasNode ? "READY" : "MISSING", hasNode ? "a package.json was found" : "no package.json: slice 1 builds TypeScript/Node apps with npm test only", hasNode ? undefined : "Add a package.json with build and test scripts");
  if (hasNode) { try { const scripts = JSON.parse((await import("node:fs")).readFileSync(join(repoRoot, "package.json"), "utf8")).scripts ?? {}; for (const s of ["build", "test"]) if (!scripts[s]) add(`SCRIPT_${s.toUpperCase()}`, "WARN", `package.json has no "${s}" script, so that gate cannot run`, `Add a "${s}" script`); } catch { add("STACK", "MISSING", "package.json is not valid JSON", "Fix package.json"); } }

  }
  const d = (probes.docker ?? defaultDocker(image))();
  add("CONTAINER", d.daemon && d.image ? "READY" : "MISSING", d.daemon ? (d.image ? `Docker is running and ${image} is present` : `Docker is running but the image ${image} is not present`) : "the Docker daemon is not reachable: validation would run under the weaker local permission model, and build/test commands that need npm cannot run there", d.daemon ? (d.image ? undefined : `docker pull ${image}`) : "Start Docker");
  const g = (probes.gh ?? (() => { const r = ghAuthStatus(); return { ok: r.ok, detail: r.ok ? `signed in as ${r.user}` : r.reason }; }))();
  add("GITHUB", g.ok ? "READY" : "WARN", g.ok ? `gh ${g.detail}` : `gh is not usable (${g.detail}): issue tracking and draft PRs are unavailable`, g.ok ? undefined : "Run: gh auth login");
  const url = probes.ollamaUrl ?? process.env.CIE_OLLAMA_URL ?? "http://127.0.0.1:11434"; const o = await (probes.ollama ?? defaultOllama(url))();
  // The model generation will use is the one the installation has selected; with none stored, the first installed one is what the server would pick.
  const selected = store.selectedModel() ?? o.models[0] ?? null, route = generationRoutesFor(selected, url)[0];
  const allowed = !!route && generationRouteAllowed(route, cfg?.egress ?? "LOCAL_ONLY");
  add("MODEL", o.reachable && o.models.length && allowed ? "READY" : "MISSING", !o.reachable ? "the model daemon is not reachable: requirements cannot be generated" : !o.models.length ? "the daemon has no model installed" : !allowed ? "the configured model route is not allowed by the egress policy" : `generation will use ${selected} (the selected model); ${o.models.length} model(s) installed: ${o.models.slice(0, 4).join(", ")}${o.models.length > 4 ? ", …" : ""}`,
    !o.reachable ? "Start the model daemon (ollama serve)" : !o.models.length ? "ollama pull <model>" : !allowed ? "Use a local model, or opt in to a cloud provider in .cie/feature.json" : undefined);
  if (o.reachable && o.models.length && o.models.every((m) => /(^|[:\-])(0\.\d+b|1b|270m|[1-3]\d\dm)\b/i.test(m))) add("MODEL_SIZE", "WARN", "only very small models are installed (about 1B parameters or less): the builder conformance suite has not been run on them and generated requirements and edits may not be usable", "Evaluate a model with C17/evaluateBuilderVersion before relying on it");
  return { ready: items.every((i) => i.state !== "MISSING"), items };
}
