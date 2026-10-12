// C33 — reverse-engineering evidence. The operations behind the "Reverse engineering" menu: a fog
// inventory of what the source index could not resolve (external imports), and the evidence records
// plus residual unknowns that analysis of the *artifacts* behind that fog contributes. Records arrive
// as authenticated re-evidence-bundles (@cie/evidence); nothing is stored that cannot prove where it
// came from. The linkage from a fog row to evidence is a stated heuristic (subject path containing the
// module name), shown as such — the honest alternative was no linkage at all.
import {
  createReEvidenceBundle,
  claimClassOf,
  evidenceId,
  parseReEvidenceBundle,
  serializeReEvidenceBundle,
  unknownId,
  ReEvidenceError,
  type ReEvidenceRecord,
  type ReResidualUnknown,
} from "@cie/evidence";
import { reEvidenceIdentitySchema, reEvidenceRecordSchema, reResidualUnknownSchema } from "@cie/evidence";
import type { ApiError } from "@cie/schema";
import type { Store } from "./store.ts";
import type { ArtifactProbeReport, WorkerClient } from "./worker.ts";
import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";

export interface ReFogRow {
  module: string;
  references: number;
  subjects: string[];
  /** Stated heuristic: true when some imported evidence record's subject path names this module. Not a proof of coverage. */
  hasEvidence: boolean;
}

export interface ReListResult {
  records: Array<ReEvidenceRecord & { claimClass: string }>;
  unknowns: ReResidualUnknown[];
}

export interface ReImportResult {
  importedRecords: number;
  importedUnknowns: number;
  bundleDigest: string;
}

export interface ReExportResult {
  bundleDigest: string;
  serialized: string;
}

/** Map package errors onto the gateway's error vocabulary. Tampering is a schema refusal, not a crash; anything else falls through to the storage failure path. */
export function reEvidenceFailure(e: unknown): ApiError | null {
  if (e instanceof ReEvidenceError) return { code: "INVALID_SCHEMA", message: e.message, retryable: false };
  return null;
}

export function reFogInventory(store: Store, revision: string): { rows: ReFogRow[]; note: string } {
  const facts = store.allFacts(revision).filter((f) => f.predicate === "imports_external");
  const evidence = reRows(store, revision, "evidence").map((r) => JSON.parse(r) as ReEvidenceRecord);
  const byModule = new Map<string, { subjects: Set<string>; references: number }>();
  for (const fact of facts) {
    // The worker writes imports_external facts as {kind: "ScalarValue", value: "<module>"}; anything
    // else is reported rather than guessed.
    const value = (fact.object as { kind?: string; value?: unknown }).value;
    const module = typeof value === "string" ? value : JSON.stringify(fact.object);
    const row = byModule.get(module) ?? { subjects: new Set<string>(), references: 0 };
    row.subjects.add(fact.subject);
    row.references += 1;
    byModule.set(module, row);
  }
  const rows: ReFogRow[] = [...byModule.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([module, agg]) => ({
      module,
      references: agg.references,
      subjects: [...agg.subjects].sort(),
      hasEvidence: evidence.some((r) => r.subject.path.includes(`/${module}/`) || r.subject.path.includes(`${module}/`)),
    }));
  return {
    rows,
    note: "These modules are imported but not resolved by the source index. hasEvidence is a path-name heuristic, not proof that every question about the module is answered.",
  };
}

function reRows(store: Store, revision: string, kind: "evidence" | "unknown"): string[] {
  return (store.db.prepare("select json from re_records where revision = ? and kind = ? order by id").all(revision, kind) as Array<{ json: string }>).map((r) => r.json);
}

export function reListEvidence(store: Store, revision: string): ReListResult {
  const records = reRows(store, revision, "evidence").map((json) => {
    const record = JSON.parse(json) as ReEvidenceRecord;
    return { ...record, claimClass: claimClassOf(record) };
  });
  const unknowns = reRows(store, revision, "unknown").map((json) => JSON.parse(json) as ReResidualUnknown);
  return { records, unknowns };
}

export function reImportBundle(store: Store, revision: string, body: { bundleText?: unknown }): ReImportResult {
  if (typeof body?.bundleText !== "string") throw new ReEvidenceError("INVALID_SCHEMA", "the request body needs a bundleText string");
  const bundle = parseReEvidenceBundle(body.bundleText);
  if (bundle.revision !== revision) {
    throw new ReEvidenceError("INVALID_SCHEMA", `the bundle binds to revision ${bundle.revision}, but this operation targets ${revision}`);
  }
  const exists = store.db.prepare("select 1 from revisions where id = ?").get(revision);
  if (!exists) throw new ReEvidenceError("INVALID_SCHEMA", `unknown revision ${revision}`);
  const insert = store.db.prepare("insert or replace into re_records(id, revision, kind, json) values (?,?,?,?)");
  store.db.exec("begin");
  try {
    for (const record of bundle.records) insert.run(record.id, revision, "evidence", JSON.stringify(record));
    for (const unknown of bundle.unknowns) insert.run(unknown.id, revision, "unknown", JSON.stringify(unknown));
    store.db.exec("commit");
  } catch (e) {
    store.db.exec("rollback");
    throw e;
  }
  return { importedRecords: bundle.records.length, importedUnknowns: bundle.unknowns.length, bundleDigest: bundle.digest };
}

export function reExportBundle(store: Store, revision: string): ReExportResult {
  const records = reRows(store, revision, "evidence").map((json) => JSON.parse(json) as ReEvidenceRecord);
  const unknowns = reRows(store, revision, "unknown").map((json) => JSON.parse(json) as ReResidualUnknown);
  const bundle = createReEvidenceBundle({ revision, records, unknowns });
  return { bundleDigest: bundle.digest, serialized: serializeReEvidenceBundle(bundle) };
}

// ---- Artifact probe: point at a jar / .so / .exe inside the indexed repository and the worker reads
// what the bytes support; every claim lands here as an authenticated evidence record. The storage path
// is the SAME authenticated import path external bundles take — a probe stores nothing that cannot
// re-derive its own ids — so "the house does not special-case itself" survives this feature. ----

export interface ReArtifactRow { path: string; sizeBytes: number }
export interface ReListArtifactsResult { rows: ReArtifactRow[]; root: string; note: string }

const ARTIFACT_EXTENSIONS = [".jar", ".war", ".ear", ".zip", ".so", ".dylib", ".dll", ".exe", ".node"];
const ARTIFACT_SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "out", ".next", "coverage", ".cache", ".venv", "__pycache__"]);
const ARTIFACT_MAX_ROWS = 200;
const ARTIFACT_MAX_DEPTH = 7;

/** Candidates for the probe: binary artifacts under the revision's repository root. Read-only, bounded. */
export async function reListArtifacts(store: Store, revision: string): Promise<ReListArtifactsResult> {
  const rev = store.revision(revision);
  if (!rev) throw new ReEvidenceError("INVALID_SCHEMA", `unknown revision ${revision}`);
  const root = rev.repoRoot;
  const rows: ReArtifactRow[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > ARTIFACT_MAX_DEPTH || rows.length >= ARTIFACT_MAX_ROWS) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skipped, not an error — the list is a convenience, not an audit
    }
    for (const entry of entries) {
      if (rows.length >= ARTIFACT_MAX_ROWS) return;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ARTIFACT_SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (ARTIFACT_EXTENSIONS.some((ext) => lower.endsWith(ext)) || /\.so\.\d+$/.test(lower)) {
        try {
          const stat = await fs.stat(full);
          rows.push({ path: full.slice(root.length + 1), sizeBytes: stat.size });
        } catch { /* vanished between readdir and stat: skip */ }
      }
    }
  };
  await walk(root, 0);
  rows.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
  return {
    rows,
    root,
    note: "Candidate artifacts under the indexed repository. The probe reads files here — it does not fetch anything from the network.",
  };
}

export interface ReAnalyzeResult {
  path: string;
  format: string;
  formatDetail: string;
  sizeBytes: number;
  sha256: string;
  bundleDigest: string;
  claims: Array<{ id: string; predicate: string; confidence: string; claimClass: string }>;
  questions: Array<{ id: string; question: string }>;
  notes: string[];
}

/** Probe report → evidence records + residual unknowns. Pure: the Rust side says what it saw; this
 * function only stamps custody (state, observedAt) and derives ids via @cie/evidence. Identical
 * claims collapse to one id — asking twice is one observation. */
export function recordsFromProbe(report: ArtifactProbeReport, revision: string): { records: ReEvidenceRecord[]; unknowns: ReResidualUnknown[] } {
  const provider = { id: "cie-artifact-probe", name: "CIE artifact probe", version: "1" };
  const subject = { path: report.path, sha256: report.sha256, format: report.format };
  const observedAt = new Date().toISOString();
  const byId = new Map<string, ReEvidenceRecord>();
  for (const claim of report.claims) {
    // The probe report crosses a runtime boundary: validate it against the identity schema here, so a
    // worker that reports an unknown confidence or location kind is refused, not stored.
    const identity = reEvidenceIdentitySchema.parse({
      subject,
      provider,
      predicate: claim.predicate,
      confidence: claim.confidence,
      authority: claim.authority,
      limitations: claim.limitations,
      locations: claim.locations,
    });
    const record = reEvidenceRecordSchema.parse({
      ...identity,
      id: evidenceId(identity),
      revision,
      state: "CURRENT",
      observedAt,
    });
    byId.set(record.id, record);
  }
  const now = observedAt;
  const unknowns = report.unresolved.map((u) =>
    reResidualUnknownSchema.parse({
      id: unknownId({ question: u.question, revision }),
      revision,
      question: u.question,
      status: "open",
      reason: u.reason,
      createdAt: now,
      updatedAt: now,
    })
  );
  return { records: [...byId.values()], unknowns };
}

/** Resolve a user-supplied path under the repository root, refusing every escape (absolute paths
 * outside the root, symlink hops out, missing files). Returns the real path or null. */
function resolveUnderRoot(root: string, requested: string): string | null {
  const abs = path.isAbsolute(requested) ? requested : path.join(root, requested);
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(abs);
  } catch {
    return null;
  }
  return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
}

/** The "magic" behind pointing at an artifact: probe it in the worker, wrap every claim in the
 * evidence schema, and store the result through the authenticated import path. */
export async function reAnalyzeArtifact(store: Store, worker: WorkerClient, revision: string, requestedPath: string): Promise<ReAnalyzeResult> {
  const rev = store.revision(revision);
  if (!rev) throw new ReEvidenceError("INVALID_SCHEMA", `unknown revision ${revision}`);
  const root = rev.repoRoot;
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    throw new ReEvidenceError("INVALID_SCHEMA", "path is required: a repository-relative path to a .jar/.so/.dll/.exe/… artifact");
  }
  const abs = resolveUnderRoot(root, requestedPath);
  if (!abs) {
    throw new ReEvidenceError("INVALID_SCHEMA", `${requestedPath} does not resolve inside the indexed repository; the probe only reads files it can see there`);
  }
  const rel = path.relative(realpathSync(root), abs).split(path.sep).join("/");
  const report = await worker.probeArtifact(abs, rel);
  const { records, unknowns } = recordsFromProbe(report, revision);
  const bundle = createReEvidenceBundle({ revision, records, unknowns });
  // Same door every external bundle walks through: parse, recompute, then store.
  const stored = reImportBundle(store, revision, { bundleText: serializeReEvidenceBundle(bundle) });
  return {
    path: rel,
    format: report.format,
    formatDetail: report.formatDetail,
    sizeBytes: report.sizeBytes,
    sha256: report.sha256,
    bundleDigest: stored.bundleDigest,
    claims: bundle.records.map((r) => ({ id: r.id, predicate: r.predicate, confidence: r.confidence, claimClass: claimClassOf(r) })),
    questions: bundle.unknowns.map((u) => ({ id: u.id, question: u.question })),
    notes: report.notes,
  };
}
