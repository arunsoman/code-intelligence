// Program dependence graphs — a thin router (plan §0.5).
//
// TypeScript plans and routes; the Rust worker folds. `buildAllPdgs` decides, in stable file order,
// which entities to reuse (by the semantic-ir hash, rename-stable) and which to build within the
// budget, then sends every build to one `worker irPdgs <entities.json>` process — the same pattern
// as `matchMotifsBatch`. The fold itself (statement-grain nodes, flow/data/guard edges, compound
// `+=`/`++` self-assignments, per-slot locals from the stored `irDump`) lives in
// `crates/worker/src/irpdg.rs` and is pinned there by tests in both runtimes. There is no
// TypeScript fold: without a worker binary there is no graph phase, like every other worker phase.
//
// Bounds (concept-config, uncalibrated): a function is truncated after pdgMaxStatements nodes;
// functions past pdgMaxFunctions get no graph and are reported as gaps.
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { defaultWorkerPath } from "../worker.ts";
import type { Entity } from "@cie/schema";
import type { Store } from "../store.ts";
import { conceptConfig } from "./config.ts";
import type { Pdg } from "./types.ts";

/** Function-like entity kinds: the only ones that have a body to graph. */
export const BODY_KINDS = new Set(["function", "method", "test"]);

export interface BuildPdgsResult {
  pdgs: Pdg[];
  /** Entity ids past the function budget, in a stable order. */
  skipped: string[];
  /** How many graphs came from the previous run unchanged. */
  reused: number;
  /** Entity ids with no foldable body (no `irDump`, empty tree) — no graph. */
  unresolved: string[];
}

/** One batched fold in the Rust worker. Throws when the worker is missing or failed: there is no
 *  TypeScript fold to fall back on — the graph phase, like the parse phase, is the worker's. */
function buildPdgsBatch(entries: { entityId: string; file: string; irHash: string | null; irDump: string }[], maxStatements: number): (Pdg | null)[] {
  if (entries.length === 0) return [];
  const input = `${tmpdir()}/cie-irpdg-${process.pid}-${randomUUID()}.json`;
  writeFileSync(input, JSON.stringify({ maxStatements, entities: entries }));
  try {
    const r = spawnSync(defaultWorkerPath(), ["irPdgs", input], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    let parsed: { results?: { entityId: string; pdg: Pdg | null }[]; error?: { code: string; message: string } } | null = null;
    try { parsed = r.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch { /* fall through to the error below */ }
    if (parsed?.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    if (!parsed?.results || !Array.isArray(parsed.results)) {
      throw new Error(`worker irPdgs failed (exit ${r.status}${r.stderr ? `: ${String(r.stderr).slice(0, 200)}` : ""})`);
    }
    return entries.map((e) => parsed!.results!.find((x) => x.entityId === e.entityId)?.pdg ?? null);
  } finally {
    rmSync(input, { force: true });
  }
}

/** Build (or reuse) one graph per function-like entity of the revision, in stable file order. */
export function buildAllPdgs(store: Store, revision: string, previous?: Pdg[]): BuildPdgsResult {
  const maxFns = conceptConfig().pdgMaxFunctions.value;
  const prevByEntity = new Map((previous ?? []).map((p) => [p.entityId, p]));
  const fns = store.entities(revision)
    .filter((e) => BODY_KINDS.has(e.kind))
    .sort((a, b) => a.file.localeCompare(b.file) || a.entityId.localeCompare(b.entityId));
  // Plan: reuse by the semantic-ir hash (stable across renames; source-built graphs of older
  // revisions reuse by the symbol text hash), budget by stream order — a build attempt takes a
  // slot even when it ends up unresolved, matching the streaming behaviour.
  type Plan = { entity: Entity; action: "reuse"; pdg: Pdg } | { entity: Entity; action: "build" };
  const plan: Plan[] = [];
  const skipped: string[] = [];
  let budget = 0;
  for (const e of fns) {
    const prev = prevByEntity.get(e.entityId);
    if (prev && ((e.irHash && prev.bodyHash === e.irHash) || (e.symbolHash && prev.bodyHash === e.symbolHash))) {
      if (budget >= maxFns) skipped.push(e.entityId);
      else { plan.push({ entity: e, action: "reuse", pdg: prev }); budget++; }
      continue;
    }
    if (budget >= maxFns) { skipped.push(e.entityId); budget++; continue; }
    plan.push({ entity: e, action: "build" });
    budget++;
  }
  const todo = plan.filter((p): p is { entity: Entity; action: "build" } => p.action === "build");
  let built = new Map<string, Pdg>();
  const unresolved: string[] = [];
  if (todo.length > 0) {
    // One entry per planned build, in order: dumpless bodies fold to null in the worker.
    const results = buildPdgsBatch(
      todo.map((p) => ({ entityId: p.entity.entityId, file: p.entity.file, irHash: p.entity.irHash ?? null, irDump: p.entity.irDump ?? "" })),
      conceptConfig().pdgMaxStatements.value,
    );
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      const found = results[i] ?? null;
      if (found) built.set(p.entity.entityId, found);
      else unresolved.push(p.entity.entityId);
    }
  }
  const pdgs: Pdg[] = [];
  let reused = 0;
  for (const p of plan) {
    if (p.action === "reuse") { pdgs.push(p.pdg); reused++; continue; }
    const g = built.get(p.entity.entityId);
    if (g) {
      const prev = prevByEntity.get(p.entity.entityId);
      if (prev && prev.bodyHash === g.bodyHash) { pdgs.push(prev); reused++; continue; }
      pdgs.push(g);
    }
  }
  return { pdgs, skipped, reused, unresolved };
}