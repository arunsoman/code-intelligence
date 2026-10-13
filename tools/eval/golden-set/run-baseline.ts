// Stage 0 of the v2 migration plan: measure what the *current* system actually does on the golden set, before any
// structural change, so every later stage has something concrete to not regress below.
// Usage: npx tsx tools/eval/golden-set/run-baseline.ts [--model=llama3.2:1b] [--repo=payments-repo] [--out=report.json]
//
// Scoring here is intentionally naive (case-insensitive substring containment of each case's expectedFacts against the
// response message) — that is all that's possible before the Claim/verifier work in stage 3 exists. It is a baseline
// to diff against, not a claim of precision/recall in the v2 sense.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProvider } from "@cie/model";
import { Service } from "../../../packages/core/src/service.ts";
import { Store } from "../../../packages/core/src/store.ts";
import { WorkerClient } from "../../../packages/core/src/worker.ts";
import { routerFor } from "../../../packages/core/src/llm-router.ts";
import { loadGoldenSet, type GoldenCase } from "./schema.ts";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? "true"]; }));
// llama3.2:1b is this project's installed minimal-tier Ollama model; never auto-resolve to a larger or cloud model here
// so the baseline stays reproducible and never triggers a pull.
const MODEL = args.model ?? "llama3.2:1b";
const REPO = args.repo ?? "payments-repo";
const OUT = args.out ?? join(process.cwd(), "tools/eval/golden-set/baseline-report.json");

function buildDemoRepo(repo: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "cie-golden-")), repo === "payments-repo" ? "payments-app" : repo);
  const script = fileURLToPath(new URL("../../../scripts_make_demo_repo.sh", import.meta.url));
  execFileSync("bash", [script, dir, repo], { stdio: "pipe" });
  return dir;
}

interface CaseResult {
  id: string; question: string; type: string; elapsedMs: number;
  ok: boolean; kind?: string; validationStatus?: string; completeness?: string;
  message: string; warnings: string[];
  foundFacts: string[]; missingFacts: string[]; factCoverage: number | null;
  needsLabeling?: boolean;
}

async function runCase(svc: Service, revisionId: string, c: GoldenCase): Promise<CaseResult> {
  const started = Date.now();
  const id = randomUUID();
  const r = await svc.converse(
    { requestId: id, idempotencyKey: id, traceId: id, actor: { principalId: "local-user", tenantId: "local", sessionId: `golden-${c.id}` }, deadlineMs: Date.now() + 180_000 },
    { text: c.question, revision: revisionId },
  );
  const elapsedMs = Date.now() - started;
  if (!r.ok) return { id: c.id, question: c.question, type: c.type, elapsedMs, ok: false, message: r.error.message, warnings: [], foundFacts: [], missingFacts: c.expectedFacts, factCoverage: c.expectedFacts.length ? 0 : null, needsLabeling: c.needsLabeling };
  const message = r.value.message ?? "";
  const lower = message.toLowerCase();
  const foundFacts = c.expectedFacts.filter((f) => lower.includes(f.toLowerCase()));
  const missingFacts = c.expectedFacts.filter((f) => !lower.includes(f.toLowerCase()));
  const validationStatus = r.value.kind === "analysis" ? r.value.validation?.status : undefined;
  return {
    id: c.id, question: c.question, type: c.type, elapsedMs, ok: true, kind: r.value.kind, validationStatus,
    completeness: r.metadata.completeness, message, warnings: r.metadata.warnings,
    foundFacts, missingFacts, factCoverage: c.expectedFacts.length ? foundFacts.length / c.expectedFacts.length : null,
    needsLabeling: c.needsLabeling,
  };
}

async function main() {
  const cases = loadGoldenSet(REPO);
  if (!cases.length) { console.error(`No golden cases found for repo "${REPO}".`); process.exitCode = 1; return; }
  const labeled = cases.filter((c) => !c.needsLabeling);
  if (labeled.length < cases.length) console.warn(`${cases.length - labeled.length} case(s) are unlabeled (needsLabeling) and are included in the run but excluded from the coverage summary.`);

  const { provider } = await createProvider({ which: "ollama", model: MODEL });
  const router = routerFor(provider.name === "ollama" ? MODEL : null);
  if (provider.name !== "ollama") console.warn(`Ollama model "${MODEL}" is not reachable; falling back to the offline stub provider. Results will reflect the stub's deterministic answers, not a real model.`);

  const store = new Store(":memory:");
  const worker = new WorkerClient();
  const svc = new Service(store, worker, provider);
  svc.router = router;

  const repoPath = buildDemoRepo(REPO);
  const indexId = randomUUID();
  const indexed = await svc.ingestRepository(
    { requestId: indexId, idempotencyKey: indexId, traceId: indexId, actor: { principalId: "local-user", tenantId: "local", sessionId: "golden-set" }, deadlineMs: Date.now() + 180_000 },
    { repoPath },
  );
  if (!indexed.ok) { console.error(`Could not index ${repoPath}: ${indexed.error.message}`); process.exitCode = 1; return; }
  // Repository-scope questions (overview, and anything that falls back to it) refuse outright without a built
  // concept hierarchy for this revision (see conceptRequirement in overview.ts) — every real chat flow builds this
  // once per revision before asking; the golden-set runner has to do the same or every case comes back refused.
  const hierarchy = await svc.buildConceptHierarchy(
    { requestId: randomUUID(), idempotencyKey: randomUUID(), traceId: randomUUID(), actor: { principalId: "local-user", tenantId: "local", sessionId: "golden-set" }, deadlineMs: Date.now() + 180_000 },
    { revision: indexed.value.id },
  );
  if (!hierarchy.ok) console.warn(`Could not build the concept hierarchy: ${hierarchy.error.message} (repository-scope questions may be refused)`);

  console.log(`Running ${cases.length} golden case(s) for "${REPO}" against ${provider.name}/${provider.model} (router: ${router?.name ?? "off"})…`);
  const results: CaseResult[] = [];
  for (const c of cases) {
    const result = await runCase(svc, indexed.value.id, c);
    results.push(result);
    console.log(`  ${result.ok ? "✓" : "✗"} ${c.id} (${result.elapsedMs}ms)${result.factCoverage !== null ? ` — ${Math.round((result.factCoverage ?? 0) * 100)}% expected facts found` : ""}${c.needsLabeling ? " [unlabeled]" : ""}`);
  }

  const scored = results.filter((r) => !r.needsLabeling && r.factCoverage !== null);
  const avgCoverage = scored.length ? scored.reduce((s, r) => s + (r.factCoverage ?? 0), 0) / scored.length : null;
  const avgLatencyMs = results.length ? results.reduce((s, r) => s + r.elapsedMs, 0) / results.length : 0;
  const failed = results.filter((r) => !r.ok);
  const unresolved = results.filter((r) => r.validationStatus === "UNRESOLVED");
  const summary = {
    repo: REPO, model: `${provider.name}/${provider.model}`, router: router?.name ?? "off", generatedAt: new Date().toISOString(),
    totalCases: results.length, scoredCases: scored.length, unlabeledCases: results.length - scored.length,
    avgFactCoverage: avgCoverage, avgLatencyMs, failedCases: failed.map((r) => r.id), unresolvedCases: unresolved.map((r) => r.id),
  };
  writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log(`\nFull report: ${OUT}`);
  worker.close(); store.db.close();
}

await main();
