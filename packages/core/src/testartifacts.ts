// Test metadata ingestion: coverage (lcov, Istanbul JSON) and results (JUnit XML, Jest/Vitest JSON) found in the
// repository. Coverage is attached to symbols as OBSERVED facts with TEST-class evidence; results to test entities.
// Nothing is run: these are artifacts produced earlier by the project's own tooling, and they are labelled as such.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Entity, EvidenceRef, Fact } from "@cie/schema";
import type { RevisionRow, Store } from "./store.ts";

export interface TestResult { name: string; suite: string; file?: string; status: "passed" | "failed" | "skipped"; message?: string; durationMs?: number }
export interface LineHits { [line: number]: number }
export interface TestSummary {
  found: string[]; coverageFiles: number; coverageLinePercent: number | null;
  tests: { passed: number; failed: number; skipped: number }; failing: { name: string; file?: string; message?: string }[];
  generatedAt: string; staleness: string[];
}

const COVERAGE_PATHS = ["coverage/lcov.info", "lcov.info", "coverage/coverage-final.json", "coverage-final.json"];
const RESULT_PATHS = ["junit.xml", "test-results/junit.xml", "reports/junit.xml", "test-report.xml", "test-results.json", "reports/test-results.json", "jest-results.json", "vitest-results.json"];
const MAX_BYTES = 20 * 1024 * 1024;

export function parseLcov(text: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  let cur: LineHits | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) { cur = {}; out.set(raw.slice(3).trim(), cur); }
    else if (raw.startsWith("DA:") && cur) { const [l, h] = raw.slice(3).split(","); const n = Number(l); if (Number.isInteger(n)) cur[n] = (cur[n] ?? 0) + Number(h || 0); }
    else if (raw === "end_of_record") cur = null;
  }
  return out;
}

export function parseIstanbul(json: unknown): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  if (!json || typeof json !== "object") return out;
  for (const [file, cov] of Object.entries(json as Record<string, any>)) {
    const sm = cov?.statementMap, s = cov?.s;
    if (!sm || !s) continue;
    const hits: LineHits = {};
    for (const [id, loc] of Object.entries<any>(sm)) {
      const line = loc?.start?.line;
      if (Number.isInteger(line)) hits[line] = Math.max(hits[line] ?? 0, Number(s[id] ?? 0));
    }
    out.set(cov.path ?? file, hits);
  }
  return out;
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : undefined; };

export function parseJUnit(xml: string): TestResult[] {
  const out: TestResult[] = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(xml)); ) {
    const name = attr(m[1], "name"); if (!name) continue;
    const body = m[2] ?? "";
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const status: TestResult["status"] = fail ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    const message = fail ? (attr(fail[2], "message") ?? unxml((fail[3] ?? "").trim().split("\n")[0] ?? "")).slice(0, 300) : undefined;
    const time = attr(m[1], "time");
    out.push({ name, suite: attr(m[1], "classname") ?? "", file: attr(m[1], "file"), status, message, durationMs: time ? Math.round(Number(time) * 1000) : undefined });
  }
  return out;
}

/** Jest (`--json`) and Vitest (`--reporter=json`) share this shape. */
export function parseJestJson(json: any): TestResult[] {
  const out: TestResult[] = [];
  for (const f of json?.testResults ?? []) {
    for (const a of f.assertionResults ?? []) {
      const status = a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      out.push({ name: a.title ?? a.fullName ?? "", suite: (a.ancestorTitles ?? []).join(" "), file: f.name, status, message: status === "failed" ? String((a.failureMessages ?? [])[0] ?? "").split("\n")[0].slice(0, 300) : undefined, durationMs: a.duration ?? undefined });
    }
  }
  return out;
}

const readSmall = (p: string): string | null => { try { return statSync(p).size <= MAX_BYTES ? readFileSync(p, "utf8") : null; } catch { return null; } };
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const evidence = (rev: string, key: string, file: string, locator: string, at: string): EvidenceRef => ({
  id: `ev:${sha(rev + key)}`, sourceId: file, location: { kind: "DocumentLocation", documentId: file, version: at, locator },
  class: "TEST", observedAt: at, accessScopeId: "local", state: "CURRENT",
});

function lineOf(buf: Buffer, byte: number): number { let n = 1; for (let i = 0; i < byte && i < buf.length; i++) if (buf[i] === 10) n++; return n; }

/** Map a coverage path (absolute, or relative to the project) onto an indexed file. */
function toRepoFile(p: string, root: string, files: Set<string>): string | null {
  const norm = p.replace(/\\/g, "/");
  const rel = isAbsolute(norm) ? relative(root, norm) : norm.replace(/^\.\//, "");
  if (files.has(rel)) return rel;
  for (const f of files) if (norm.endsWith("/" + f)) return f;
  return null;
}

export function ingestTestArtifacts(store: Store, rev: RevisionRow): TestSummary | null {
  const root = rev.repoRoot;
  const found: string[] = [];
  const at = new Date().toISOString();
  const entities = store.entities(rev.id);
  const files = new Set(entities.filter((e) => e.kind === "file").map((e) => e.file));
  const symbols = entities.filter((e) => ["function", "method", "class"].includes(e.kind));
  const facts: Fact[] = [];
  const staleness: string[] = [];

  // ---- coverage
  let cov: Map<string, LineHits> | null = null, covPath = "";
  for (const rel of COVERAGE_PATHS) {
    const abs = join(root, rel); if (!existsSync(abs)) continue;
    const text = readSmall(abs); if (text === null) continue;
    try { cov = rel.endsWith(".json") ? parseIstanbul(JSON.parse(text)) : parseLcov(text); covPath = rel; found.push(rel); break; } catch { staleness.push(`${rel} could not be parsed`); }
  }
  let totalLines = 0, coveredLines = 0, coverageFiles = 0;
  if (cov) {
    const byFile = new Map<string, LineHits>();
    for (const [p, hits] of cov) { const f = toRepoFile(p, root, files); if (f) byFile.set(f, hits); }
    coverageFiles = byFile.size;
    const covMtime = statSync(join(root, covPath)).mtimeMs;
    for (const [file, hits] of byFile) {
      const lines = Object.keys(hits).map(Number);
      const covered = lines.filter((l) => hits[l] > 0).length;
      totalLines += lines.length; coveredLines += covered;
      try { if (statSync(join(root, file)).mtimeMs > covMtime + 1000) staleness.push(`${file} changed after the coverage report was produced`); } catch { /* ignore */ }
      const buf = (() => { try { return readFileSync(resolve(root, file)); } catch { return null; } })();
      const fileEnt = `file:${file}`;
      facts.push({ id: `fact:coverage:${file}`, subject: fileEnt, predicate: "coverage", object: { kind: "ScalarValue", value: { lines: lines.length, covered, percent: lines.length ? Math.round((covered / lines.length) * 100) : 0, scope: "file" } },
        evidence: [evidence(rev.id, `cov:${file}`, file, `${covPath}: ${covered}/${lines.length} executable lines covered in ${file}`, at)], resolution: "OBSERVED" });
      if (!buf) continue;
      for (const sym of symbols.filter((s) => s.file === file && s.spans[0])) {
        const a = lineOf(buf, sym.spans[0].startByte), b = lineOf(buf, sym.spans[0].endByteExclusive);
        const inside = lines.filter((l) => l >= a && l <= b);
        if (inside.length === 0) continue;
        const c = inside.filter((l) => hits[l] > 0).length;
        facts.push({ id: `fact:coverage:${sym.entityId}`, subject: sym.entityId, predicate: "coverage", object: { kind: "ScalarValue", value: { lines: inside.length, covered: c, percent: Math.round((c / inside.length) * 100), scope: "symbol" } },
          evidence: [evidence(rev.id, `cov:${sym.entityId}`, file, `${covPath}: ${c}/${inside.length} executable lines of ${sym.name} (lines ${a}–${b}) covered`, at)], resolution: "OBSERVED" });
      }
    }
  }

  // ---- results
  let results: TestResult[] = [], resPath = "";
  for (const rel of RESULT_PATHS) {
    const abs = join(root, rel); if (!existsSync(abs)) continue;
    const text = readSmall(abs); if (text === null) continue;
    try { results = rel.endsWith(".xml") ? parseJUnit(text) : parseJestJson(JSON.parse(text)); resPath = rel; found.push(rel); break; } catch { staleness.push(`${rel} could not be parsed`); }
  }
  const tests = entities.filter((e) => e.kind === "test");
  const failing: TestSummary["failing"] = [];
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const r of results) {
    counts[r.status]++;
    const ent: Entity | undefined = tests.find((t) => t.name === r.name || t.name === `${r.suite} ${r.name}`.trim()) ?? tests.find((t) => r.name.endsWith(t.name) || t.name.endsWith(r.name));
    const file = ent?.file ?? (r.file ? toRepoFile(r.file, root, files) ?? undefined : undefined);
    const subject = ent?.entityId ?? (file ? `file:${file}` : null);
    if (!subject) continue;
    if (r.status === "failed") failing.push({ name: r.name, file, message: r.message });
    facts.push({ id: `fact:test_result:${sha(subject + r.name + r.suite)}`, subject, predicate: "test_result", object: { kind: "ScalarValue", value: { name: r.name, suite: r.suite, status: r.status, message: r.message ?? null, durationMs: r.durationMs ?? null } },
      evidence: [evidence(rev.id, `res:${subject}:${r.name}`, file ?? resPath, `${resPath}: test “${r.name}” ${r.status}${r.message ? ` — ${r.message}` : ""}`, at)], resolution: "OBSERVED" });
  }

  store.replaceFactsBySource(rev.id, "fact:coverage:", facts.filter((f) => f.id.startsWith("fact:coverage:")));
  store.replaceFactsBySource(rev.id, "fact:test_result:", facts.filter((f) => f.id.startsWith("fact:test_result:")));
  if (found.length === 0) return null;
  const summary: TestSummary = { found, coverageFiles, coverageLinePercent: totalLines ? Math.round((coveredLines / totalLines) * 100) : null, tests: counts, failing: failing.slice(0, 20), generatedAt: at, staleness };
  store.db.prepare("insert into test_runs values (?,?) on conflict(repo_root) do update set json = excluded.json").run(rev.repoRoot, JSON.stringify(summary));
  return summary;
}

export function loadTestSummary(store: Store, repoRoot: string): TestSummary | null {
  const r = store.db.prepare("select json from test_runs where repo_root = ?").get(repoRoot) as any;
  return r ? JSON.parse(r.json) : null;
}

/** Coverage and test facts for one entity, for notes and objections. */
export function testFactsFor(store: Store, revision: string, entityId: string) {
  const facts = store.factsFor(revision, entityId);
  const cov = facts.find((f) => f.predicate === "coverage");
  const covVal = cov ? ((cov.object as any).value as { lines: number; covered: number; percent: number }) : null;
  return { coverage: covVal && cov ? { ...covVal, evidenceIds: cov.evidence.map((e) => e.id) } : null };
}

/** Tests that reach `entityId` through up to `hops` calls, with their recorded outcome (if a results file was loaded). */
export function testsReaching(store: Store, revision: string, entityId: string, hops = 3): { testId: string; name: string; status: TestResult["status"] | "unknown"; message?: string; evidenceIds: string[] }[] {
  const seen = new Set([entityId]);
  let frontier = [entityId];
  const tests: string[] = [];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: string[] = [];
    for (const id of frontier) for (const r of store.relationshipsFor(revision, id)) {
      if (r.kind !== "calls" || r.to !== id || seen.has(r.from)) continue;
      seen.add(r.from);
      if (r.from.startsWith("test:")) tests.push(r.from); else next.push(r.from);
    }
    frontier = next;
  }
  return tests.map((testId) => {
    const res = store.factsFor(revision, testId).find((f) => f.predicate === "test_result");
    const v = res ? ((res.object as any).value as { status: TestResult["status"]; message?: string | null; name: string }) : null;
    return { testId, name: v?.name ?? testId.replace(/^.*#/, ""), status: v?.status ?? ("unknown" as const), message: v?.message ?? undefined, evidenceIds: res?.evidence.map((e) => e.id) ?? [] };
  });
}
