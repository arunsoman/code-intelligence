// Usage: npx tsx tools/eval/shahy-onboarding/run.ts [--model=<override>] [--repo=/home/arun/shahy-restructure] [--out=report.md] [--limit=N]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createProvider, resolveModel } from "@cie/model";
import { Service } from "../../../packages/core/src/service.ts";
import { Store } from "../../../packages/core/src/store.ts";
import { WorkerClient } from "../../../packages/core/src/worker.ts";
import { routerFor } from "../../../packages/core/src/llm-router.ts";
import type { ConverseResult, ViewSpec } from "@cie/schema";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? "true"]; }));
const LIVE_DB = args.liveDb ?? join(process.cwd(), ".cie/cie.db");

function liveSelectedModel(dbPath: string): string | null {
  try {
    const out = execFileSync("sqlite3", [dbPath, "select model from selected_model where id = 1;"], { encoding: "utf8" }).trim();
    return out || null;
  } catch { return null; }
}

const REPO_PATH = args.repo ?? "/home/arun/shahy-restructure";
const OUT = args.out ?? join(import.meta.dirname, "report.md");
const QA_FILE = join(import.meta.dirname, "questions-and-answers.md");
const PER_QUESTION_DEADLINE_MS = Number(args.deadline ?? 180_000);
const LIMIT = args.limit ? Number(args.limit) : Infinity;

interface QA { id: number; question: string; myAnswer: string }

function parseQA(path: string): QA[] {
  const text = readFileSync(path, "utf8");
  const headingRe = /^###\s+(\d+)\.\s+(.+)$/gm;
  const matches = [...text.matchAll(headingRe)];
  const out: QA[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const id = Number(m[1]);
    const question = m[2].trim();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.indexOf("\n---", start);
    const body = text.slice(start, end < 0 ? text.length : end).trim();
    out.push({ id, question, myAnswer: body });
  }
  return out;
}

function summarizeView(view: ViewSpec | undefined | null): string {
  if (!view) return "none";
  const parts = [`form ${view.formId}`, `${view.nodes.length} node(s)`, `${view.edges.length} edge(s)`];
  if (view.groups?.length) parts.push(`${view.groups.length} group(s)`);
  if (view.gaps?.length) parts.push(`${view.gaps.length} gap(s)`);
  return parts.join(", ") + (view.caption ? ` — "${view.caption}"` : "");
}

function chartOf(result: ConverseResult): string {
  if (result.kind === "view") return summarizeView(result.view);
  if (result.kind === "analysis") {
    const withView = result.results.find((r) => r.view);
    return withView ? summarizeView(withView.view) : "none (text-only analysis)";
  }
  return "none";
}

interface CaseResult {
  id: number; question: string; elapsedMs: number;
  ok: boolean; kind?: string; validationStatus?: string; message: string; chart: string; warnings: string[];
}

async function runCase(svc: Service, revisionId: string, qa: QA): Promise<CaseResult> {
  const started = Date.now();
  const id = randomUUID();
  const r = await svc.converse(
    { requestId: id, idempotencyKey: id, traceId: id, actor: { principalId: "local-user", tenantId: "local", sessionId: `shahy-onboarding-${qa.id}` }, deadlineMs: Date.now() + PER_QUESTION_DEADLINE_MS },
    { text: qa.question, revision: revisionId },
  );
  const elapsedMs = Date.now() - started;
  if (!r.ok) return { id: qa.id, question: qa.question, elapsedMs, ok: false, message: r.error.message, chart: "none", warnings: [] };
  const validationStatus = r.value.kind === "analysis" ? r.value.validation?.status : undefined;
  return {
    id: qa.id, question: qa.question, elapsedMs, ok: true, kind: r.value.kind, validationStatus,
    message: r.value.message ?? "", chart: chartOf(r.value), warnings: r.metadata.warnings,
  };
}

function renderReport(qas: QA[], results: Map<number, CaseResult>, meta: { model: string; repo: string; revisionId: string; startedAt: string; qaFile: string }): string {
  const lines: string[] = [];
  lines.push("# shahy-restructure onboarding — CIE's actual answers");
  lines.push("");
  lines.push(`Generated ${meta.startedAt}. Repository indexed: \`${meta.repo}\` (revision \`${meta.revisionId}\`). Model: \`${meta.model}\` via the local Ollama daemon.`);
  lines.push("");
  lines.push("This file holds only what CIE's real chat agent actually answered when asked each of the 55 " +
    "questions against the real, indexed repository — including which chart/view it produced, if any. The " +
    "reference answers (written by reading the actual source by hand) live separately in " +
    `\`${meta.qaFile}\`; the two files share question numbers so they line up for comparison without either ` +
    "copy drifting out of sync with the other. CIE indexes Java/TypeScript/Go/Python/Rust; the ~20 Kotlin files " +
    "in this repo (including the one defining MainProduct/MasterProduct/SubProduct, Q46-50) are not parsed, so " +
    "CIE is structurally unable to answer those from its own index the way a human reading the file can — that " +
    "gap is itself a finding, not a bug in this harness.");
  lines.push("");
  const total = results.size, ok = [...results.values()].filter((r) => r.ok).length;
  const withChart = [...results.values()].filter((r) => r.chart !== "none" && !r.chart.startsWith("none")).length;
  const avgMs = Math.round([...results.values()].reduce((s, r) => s + r.elapsedMs, 0) / Math.max(total, 1));
  const kinds = new Map<string, number>();
  for (const r of results.values()) kinds.set(r.kind ?? "error", (kinds.get(r.kind ?? "error") ?? 0) + 1);
  lines.push("## Summary");
  lines.push("");
  lines.push(`- ${total} question(s) run, ${ok} answered without a transport/service error, ${withChart} produced a chart/view.`);
  lines.push(`- Average latency: ${avgMs} ms/question.`);
  lines.push(`- Answer kinds: ${[...kinds.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}.`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const qa of qas) {
    const r = results.get(qa.id);
    lines.push(`## ${qa.id}. ${qa.question}`);
    lines.push("");
    if (!r) { lines.push("_not run (skipped or limit reached)._"); lines.push(""); lines.push("---"); lines.push(""); continue; }
    lines.push(`**CIE's actual answer** (kind: \`${r.kind ?? "error"}\`${r.validationStatus ? `, validation: \`${r.validationStatus}\`` : ""}, ${r.elapsedMs} ms):`);
    lines.push("");
    lines.push(r.ok ? r.message || "_(empty message)_" : `_Request failed: ${r.message}_`);
    lines.push("");
    lines.push(`**Chart shown:** ${r.chart}`);
    if (r.warnings.length) { lines.push(""); lines.push(`**Warnings:** ${r.warnings.join("; ")}`); }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const qas = parseQA(QA_FILE).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  if (!qas.length) { console.error(`No questions parsed from ${QA_FILE}`); process.exitCode = 1; return; }
  console.log(`Parsed ${qas.length} question(s) from ${QA_FILE}.`);

  const liveModel = liveSelectedModel(LIVE_DB);
  const resolved = args.model ? { model: String(args.model), note: undefined } : await resolveModel(liveModel);
  if (resolved.note) console.warn(resolved.note);
  console.log(`Model: ${args.model ? `"${args.model}" (explicit --model override)` : `"${resolved.model}" (the UI's currently selected_model, read from ${LIVE_DB})`}.`);

  const { provider } = await createProvider({ which: "ollama", model: resolved.model });
  const router = routerFor(provider.name === "ollama" ? resolved.model : null);
  if (provider.name !== "ollama") console.warn(`Model "${resolved.model}" is not reachable; falling back to the offline stub provider. Results will reflect the stub's deterministic answers, not a real model.`);

  const store = new Store(":memory:");
  const worker = new WorkerClient();
  const svc = new Service(store, worker, provider);
  svc.router = router;

  console.log(`Indexing ${REPO_PATH} (this is the real repository, not a fixture — may take a little while)...`);
  const indexId = randomUUID();
  const indexStarted = Date.now();
  const indexed = await svc.ingestRepository(
    { requestId: indexId, idempotencyKey: indexId, traceId: indexId, actor: { principalId: "local-user", tenantId: "local", sessionId: "shahy-onboarding" }, deadlineMs: Date.now() + 10 * 60_000 },
    { repoPath: REPO_PATH },
  );
  if (!indexed.ok) { console.error(`Could not index ${REPO_PATH}: ${indexed.error.message}`); process.exitCode = 1; worker.close(); store.db.close(); return; }
  console.log(`Indexed in ${Date.now() - indexStarted} ms: revision ${indexed.value.id}.`);

  const hierarchy = await svc.buildConceptHierarchy(
    { requestId: randomUUID(), idempotencyKey: randomUUID(), traceId: randomUUID(), actor: { principalId: "local-user", tenantId: "local", sessionId: "shahy-onboarding" }, deadlineMs: Date.now() + 5 * 60_000 },
    { revision: indexed.value.id },
  );
  if (!hierarchy.ok) console.warn(`Could not build the concept hierarchy: ${hierarchy.error.message} (repository-scope questions may be refused)`);

  console.log(`Running ${qas.length} question(s) against ${provider.name}/${provider.model} (router: ${router?.name ?? "off"})...`);
  const results = new Map<number, CaseResult>();
  const meta = { model: `${provider.name}/${provider.model}`, repo: REPO_PATH, revisionId: indexed.value.id, startedAt: new Date().toISOString(), qaFile: "questions-and-answers.md" };
  for (const qa of qas) {
    const r = await runCase(svc, indexed.value.id, qa);
    results.set(qa.id, r);
    console.log(`  ${r.ok ? "✓" : "✗"} Q${qa.id} (${r.elapsedMs}ms)${r.kind ? ` [${r.kind}]` : ""} — chart: ${r.chart}`);
    writeFileSync(OUT, renderReport(qas, results, meta));
  }

  console.log(`\nReport written to ${OUT}`);
  worker.close(); store.db.close();
}

await main();
