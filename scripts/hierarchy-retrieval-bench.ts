// Does choosing context from the concept hierarchy first make the evidence a model needs smaller?
//
//   node scripts/hierarchy-retrieval-bench.ts [repoPath] [goldFile] [reportFile]
//   defaults: this repository, docs/eval-hierarchy-retrieval-gold.json, docs/eval-hierarchy-retrieval.json
//
// For each question it ranks the functions three ways, fits the best-ranked ones into the same token budget with the same bundle
// builder, and asks one thing of each: how many of the files a good answer needs are inside it?
//   baseline   the order retrieveForQuestion (what the chat uses today) gives its own picks
//   flat       field-weighted word overlap over the hierarchy's function metadata (HierarchyIndex, mode "flat")
//   two-stage  the same, with the Domain view's matching groups ranked first (HierarchyIndex, mode "two-stage")
// Tokens are what is SENT to a model: the bundle after the same projection the model provider applies (entities, relationships and
// only behavioural facts), JSON length / 4. The raw bundle is far larger and is not what a model reads; it is reported separately.
// Because all three go through one fit procedure, the comparison is on ranking alone.
//
// Deterministic and offline: no model is called and nothing leaves the machine. Concept names come from the offline stub, so this is
// a LOWER bound for the hierarchy methods: model-written names are searchable too and may help.
//
// WHAT THIS DOES NOT MEASURE: whether a model answers better or worse with the smaller context. That needs a judge (a model or a
// person) and a stated cost; it is the next step, not this one. Recall here is file-level and the questions are few and were written
// by the same assistant that wrote the prototype (see the gold file), so intervals are wide and results are indicative.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StubProvider } from "@cie/model";
import type { ConceptHierarchyView, EvidenceBundle } from "@cie/schema";
import { wilson } from "../packages/core/src/claims.ts";
import { HierarchyIndex, type RetrievalMode } from "../packages/core/src/hierarchy-retrieval.ts";
import { bundleFor, retrieveForQuestion } from "../packages/core/src/retrieval.ts";
import { Service } from "../packages/core/src/service.ts";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";

const root = resolve(import.meta.dirname, "..");
const repoPath = resolve(process.argv[2] ?? root);
const goldPath = resolve(process.argv[3] ?? `${root}/docs/eval-hierarchy-retrieval-gold.json`);
const reportPath = resolve(process.argv[4] ?? `${root}/docs/eval-hierarchy-retrieval.json`);
const GRID = [500, 1000, 2000, 4000, 8000, 16000];
const MAX_RANKED = 400;
type Method = "baseline" | "flat" | "two-stage";
const METHODS: Method[] = ["baseline", "flat", "two-stage"];

interface Gold { id: string; kind: "named" | "paraphrase"; question: string; gold: string[] }
interface Cell { tokens: number; rawTokens: number; hit: number; of: number; filesInContext: number; symbols: number }

const ctx = { requestId: "hier-bench", idempotencyKey: "hier-bench", actor: { principalId: "system", tenantId: "local", sessionId: "bench" }, deadlineMs: Date.now() + 900_000, traceId: "hier-bench" };
const git = (...a: string[]) => { try { return execFileSync("git", ["-C", repoPath, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
/** What a model is actually sent for a bundle. MIRRORS compact() in packages/model/src/ollama.ts: keep the two in step. */
const BEHAVIOURAL = ["throws", "writes", "uses_transaction", "publishes", "subscribes"];
const sentTokens = (b: EvidenceBundle) => Math.ceil(JSON.stringify({
  entities: b.entities.map((e) => ({ entityId: e.entityId, kind: e.kind, name: e.name, file: e.file })),
  relationships: b.relationships.map((r) => ({ kind: r.kind, from: r.from, to: r.to, resolution: r.resolution, evidenceIds: r.evidence.map((x) => x.id) })),
  facts: b.facts.filter((f) => BEHAVIOURAL.includes(f.predicate)).slice(0, 400).map((f) => ({ subject: f.subject, predicate: f.predicate, value: (f.object as { value?: unknown }).value, evidenceIds: f.evidence.map((x) => x.id) })),
  unresolved: b.unresolved, coverage: b.coverage,
}).length / 4);
const GATEWAY_LIMIT = 200_000;      // runModel rejects a bundle whose raw estimate is above this (packages/model/src/gateway.ts)
const PRODUCTION_BUDGET = 60_000;   // what the service asks retrieveForQuestion to cut to (CIE_CHUNK_TOKEN_BUDGET default)
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;

async function main() {
  const gold = (JSON.parse(readFileSync(goldPath, "utf8")) as { questions: Gold[] }).questions;
  process.env.CIE_SEARCH = "off"; // the text index is not part of what is measured; skipping it keeps the run short
  const store = new Store(":memory:"), worker = new WorkerClient();
  const svc = new Service(store, worker, new StubProvider());
  try {
    const t0 = performance.now();
    const ing = await svc.ingestRepository(ctx, { repoPath });
    if (!ing.ok) throw new Error(`indexing failed: ${ing.error.message}`);
    const revision = ing.value.id;
    const built = await svc.buildConceptHierarchy(ctx, { revision });
    if (!built.ok) throw new Error(`hierarchy failed: ${built.error.message}`);
    const view: ConceptHierarchyView = built.value;
    const index = new HierarchyIndex(view);
    console.log(`Indexed ${repoPath} @ ${git("rev-parse", "--short", "HEAD") ?? "?"}: ${ing.value.fileCount} files, ${view.concepts.length} concepts, ${index.docs.length} functions (${Math.round((performance.now() - t0) / 1000)}s).`);

    const indexed = new Set(store.entities(revision).filter((e) => e.kind === "file").map((e) => e.file));
    const missing = gold.flatMap((q) => q.gold.filter((f) => !indexed.has(f)).map((f) => `${q.id}: ${f}`));
    if (missing.length) console.warn(`WARNING: gold files not in the index (counted as misses for every method): ${missing.join(", ")}`);

    const filesOf = (b: EvidenceBundle) => {
      const syms = b.entities.filter((e) => e.kind !== "file");
      return { files: new Set(syms.map((e) => e.file)), symbols: syms.length };
    };
    const cell = (b: EvidenceBundle, q: Gold): Cell => {
      const { files, symbols } = filesOf(b);
      return { tokens: sentTokens(b), rawTokens: b.tokenEstimate, hit: q.gold.filter((f) => files.has(f)).length, of: q.gold.length, filesInContext: files.size, symbols };
    };
    const empty = (): EvidenceBundle => bundleFor(store, revision, []);

    // The largest prefix of a ranking whose SENT size fits the budget (it grows with the prefix, so a search is enough).
    const fit = (ids: string[], budget: number): EvidenceBundle => {
      let lo = 0, hi = ids.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sentTokens(bundleFor(store, revision, ids.slice(0, mid))) <= budget) lo = mid; else hi = mid - 1; }
      return lo ? bundleFor(store, revision, ids.slice(0, lo)) : empty();
    };

    // The baseline's own ordering of its picks: strongest tier first, then score (its lowest-ranked-first cut, reversed).
    const TIER = { CRITICAL: 3, RELEVANT: 2, CONTEXT: 1, HIDDEN: 0 } as const;
    const baselineRank = (question: string) => {
      const r = retrieveForQuestion(store, revision, question);
      const symbols = r.bundle.entities.filter((e) => e.kind !== "file");
      const ids = symbols.map((e) => e.entityId).sort((a, b) => (TIER[r.tiers.get(b) ?? "HIDDEN"] - TIER[r.tiers.get(a) ?? "HIDDEN"]) || ((r.scored.get(b)?.score ?? 0) - (r.scored.get(a)?.score ?? 0)) || a.localeCompare(b));
      return { ids, rawNatural: r.bundle.tokenEstimate, sentNatural: sentTokens(r.bundle), bundle: r.bundle };
    };

    const rows: { id: string; kind: string; question: string; gold: string[]; groups: string[]; production: { raw: number; sent: number; overGateway: boolean; hit: number; of: number }; natural: Cell; byBudget: Record<string, Record<Method, Cell>> }[] = [];
    for (const q of gold) {
      const rankings = { flat: index.rank(q.question, { mode: "flat" as RetrievalMode }), "two-stage": index.rank(q.question, { mode: "two-stage" as RetrievalMode }) };
      const base = baselineRank(q.question);
      const ids = { baseline: base.ids.slice(0, MAX_RANKED), flat: rankings.flat.ranked.slice(0, MAX_RANKED).map((r) => r.entityId), "two-stage": rankings["two-stage"].ranked.slice(0, MAX_RANKED).map((r) => r.entityId) };
      const byBudget: Record<string, Record<Method, Cell>> = {};
      for (const B of GRID) byBudget[B] = { baseline: cell(fit(ids.baseline, B), q), flat: cell(fit(ids.flat, B), q), "two-stage": cell(fit(ids["two-stage"], B), q) };
      // What the service really does today: ask for PRODUCTION_BUDGET raw tokens, and the gateway refuses anything over GATEWAY_LIMIT.
      const prod = retrieveForQuestion(store, revision, q.question, { tokenBudget: PRODUCTION_BUDGET }).bundle;
      rows.push({ id: q.id, kind: q.kind, question: q.question, gold: q.gold, groups: rankings["two-stage"].groups,
        production: { raw: prod.tokenEstimate, sent: sentTokens(prod), overGateway: prod.tokenEstimate > GATEWAY_LIMIT, hit: cell(prod, q).hit, of: q.gold.length }, natural: cell(base.bundle, q), byBudget });
      process.stdout.write(`  ${q.id} `);
    }
    console.log("");

    // ---- aggregates, every proportion with an interval
    const agg: Record<string, Record<string, unknown>> = {};
    const scopes: [string, typeof rows][] = [["all", rows], ["named", rows.filter((r) => r.kind === "named")], ["paraphrase", rows.filter((r) => r.kind === "paraphrase")]];
    for (const [scope, rs] of scopes) {
      agg[scope] = {};
      for (const B of GRID) {
        const per: Record<string, unknown> = {};
        for (const m of METHODS) {
          const cs = rs.map((r) => r.byBudget[B][m]);
          const hit = cs.reduce((n, c) => n + c.hit, 0), of = cs.reduce((n, c) => n + c.of, 0), full = cs.filter((c) => c.hit === c.of).length;
          const w = wilson(hit, of), wf = wilson(full, cs.length);
          per[m] = { goldFilesCovered: hit, goldFiles: of, recall: of ? hit / of : 0, recallCI: [w.lower, w.upper], questionsFullySatisfied: full, questions: cs.length, fullRate: cs.length ? full / cs.length : 0, fullRateCI: [wf.lower, wf.upper],
            meanTokens: cs.length ? Math.round(cs.reduce((n, c) => n + c.tokens, 0) / cs.length) : 0, meanFilesInContext: cs.length ? +(cs.reduce((n, c) => n + c.filesInContext, 0) / cs.length).toFixed(1) : 0 };
        }
        (agg[scope] as Record<string, unknown>)[String(B)] = per;
      }
    }
    // The smallest budget on the grid at which each question is fully covered, per method (null: not within the grid).
    const toFull: Record<string, { median: number | null; reached: number; of: number; perQuestion: Record<string, number | null> }> = {};
    for (const m of METHODS) {
      const per: Record<string, number | null> = {};
      for (const r of rows) per[r.id] = GRID.find((B) => r.byBudget[B][m].hit === r.byBudget[B][m].of) ?? null;
      const reached = Object.values(per).filter((v): v is number => v !== null);
      toFull[m] = { median: median(reached), reached: reached.length, of: rows.length, perQuestion: per };
    }
    const production = { budgetAskedRaw: PRODUCTION_BUDGET, gatewayLimitRaw: GATEWAY_LIMIT, questionsOverGatewayLimit: rows.filter((r) => r.production.overGateway).length, of: rows.length, medianRawTokens: median(rows.map((r) => r.production.raw)), medianSentTokens: median(rows.map((r) => r.production.sent)), recall: rows.reduce((n, r) => n + r.production.hit, 0) / rows.reduce((n, r) => n + r.production.of, 0), questionsFullySatisfied: rows.filter((r) => r.production.hit === r.production.of).length };
    const natural = { tokensMean: Math.round(rows.reduce((n, r) => n + r.natural.tokens, 0) / rows.length), rawTokensMean: Math.round(rows.reduce((n, r) => n + r.natural.rawTokens, 0) / rows.length), recall: rows.reduce((n, r) => n + r.natural.hit, 0) / rows.reduce((n, r) => n + r.natural.of, 0), fullSatisfied: rows.filter((r) => r.natural.hit === r.natural.of).length };

    const report = {
      generatedAt: new Date().toISOString(), repo: repoPath, head: git("rev-parse", "HEAD"), dirty: (git("status", "--porcelain") ?? "").length > 0, node: process.version,
      corpus: { files: ing.value.fileCount, concepts: view.concepts.length, functions: index.docs.length, conceptNames: "offline stub (mechanical)" },
      method: { grid: GRID, bundle: "bundleFor; tokens = JSON length / 4 of what the model provider sends (entities, relationships, behavioural facts)", recall: "gold files with at least one non-file entity in the bundle", maxRankedConsidered: MAX_RANKED },
      caveats: [
        "Gold questions were written by the assistant that wrote the prototype, not an independent labeller.",
        `Only ${rows.length} questions; every interval is wide.`,
        "File-level recall; file-level nodes are not counted unless a symbol from the file is in the bundle.",
        "Sent-token projection mirrors packages/model/src/ollama.ts compact(); it is copied, not imported.",
        "Concept names are mechanical stub names; model-written names could change the hierarchy methods' results.",
        "Baseline ordering is retrieveForQuestion's own picks without the semantic (hash embedding) option or concept cards the chat path may add; it is then cut by the same fit procedure as the other two, not by its own truncation.",
        "Does not measure answer quality with a smaller context, only whether the needed files are inside it.",
        ...(missing.length ? [`Gold files missing from the index: ${missing.join(", ")}`] : []),
      ],
      natural, production, toFullRecall: toFull, aggregates: agg, questions: rows,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

    // ---- the table people will read
    console.log(`\nGold-file recall at each token budget (95% Wilson interval), ${rows.length} questions, ${rows.reduce((n, r) => n + r.gold.length, 0)} gold files:\n`);
    console.log("budget  " + METHODS.map((m) => m.padEnd(30)).join(""));
    for (const B of GRID) {
      const per = (agg.all as Record<string, Record<Method, { recall: number; recallCI: number[]; meanTokens: number; questionsFullySatisfied: number; questions: number }>>)[String(B)];
      console.log(String(B).padEnd(8) + METHODS.map((m) => `${pct(per[m].recall)} [${pct(per[m].recallCI[0])}-${pct(per[m].recallCI[1])}] ${String(per[m].meanTokens).padStart(6)}t ${per[m].questionsFullySatisfied}/${per[m].questions}`.padEnd(30)).join(""));
    }
    console.log(`\nbaseline unbudgeted: mean ${natural.tokensMean} SENT tokens (${natural.rawTokensMean} raw), recall ${pct(natural.recall)}, ${natural.fullSatisfied}/${rows.length} fully covered`);
    console.log(`as the service runs today (asks for ${PRODUCTION_BUDGET} raw tokens): median ${production.medianRawTokens} raw / ${production.medianSentTokens} sent; recall ${pct(production.recall)}, ${production.questionsFullySatisfied}/${production.of} fully covered; ${production.questionsOverGatewayLimit}/${production.of} questions stay over the gateway's ${GATEWAY_LIMIT} limit`);
    console.log("tokens needed to fully cover a question (smallest grid budget; median over those that get there):");
    for (const m of METHODS) console.log(`  ${m.padEnd(10)} median ${toFull[m].median ?? "n/a"}  (${toFull[m].reached}/${toFull[m].of} questions reach full coverage within ${GRID.at(-1)})`);
    for (const k of ["named", "paraphrase"] as const) {
      const per = (agg[k] as Record<string, Record<Method, { recall: number }>>)["2000"];
      console.log(`  at 2000 sent tokens, ${k.padEnd(10)} recall: ` + METHODS.map((m) => `${m} ${pct(per[m].recall)}`).join(" · "));
    }
    console.log(`\nReport: ${reportPath}`);
  } finally { worker.close(); }
}
await main();
