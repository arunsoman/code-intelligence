// F11 slice S0 — the retrospective evaluation harness (§14.1), patterned on scripts/f01-bench.ts.
//
// Measures the two unmeasured things before slice 3: does a surfaced item correspond to a later, known consequence
// (recall on consequence PRs), and how often would a control PR — one with no later consequence — still have
// produced a comment (the noise rate).
//
//   node scripts/f11-retro.ts --corpus docs/eval-f11-corpus.json [--out docs/eval-f11-retro.json]
//
// Corpus format (record the selection rule BEFORE looking at results, §14.1.1–2):
//   { "selectionRule": "…", "prs": [
//       { "repo": "/path/to/clone", "base": "<sha>", "head": "<sha>", "prNumber": 7,
//         "consequence": "revert of src/payments/payment-service.ts in #88" | null } ] }
// `consequence: null` marks a matched control, chosen by a stated rule (same size band, same languages, no
// revert/hotfix/incident referencing it within N days).
//
// Two reviewers label blind (§14.1.4): the harness emits a labelling sheet (items per PR, no consequence column);
// disagreements are reported, not resolved silently. The decision rule below was written before any run (§14.2) —
// do not tune thresholds until the numbers look good; if matches are near zero, stop and revisit the ranking.
//
// Exit code 0 always: this is a measurement, not a gate.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";
import { StubProvider } from "@cie/model";
import { Service } from "../packages/core/src/service.ts";

/** §14.2 decision rule, written before the first run. The owner sets the noise limit in advance. */
const DECISION_RULE = {
  proceedToSlice3If: {
    noiseRateOnControlsBelow: 0.20, // owner-set limit, in advance
    consequencePrsMatchedAtLeast: 1, // "at least some"
  },
  ifMatchesNearZero: "stop and revisit the ranking or the premise — do not tune thresholds until the numbers look good",
};

interface CorpusPr { repo: string; base: string; head: string; prNumber: number; consequence: string | null }
interface Corpus { selectionRule: string; prs: CorpusPr[] }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const corpusPath = resolve(arg("--corpus") ?? "docs/eval-f11-corpus.json");
  const outPath = resolve(arg("--out") ?? "docs/eval-f11-retro.json");
  if (!existsSync(corpusPath)) {
    console.error(`f11-retro: corpus not found: ${corpusPath}`);
    console.error('f11-retro: write one, e.g. { "selectionRule": "…", "prs": [{ "repo": "…", "base": "…", "head": "…", "prNumber": 1, "consequence": "revert in #9" }] }');
    process.exitCode = 2;
    return;
  }
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
  if (!corpus.selectionRule || !Array.isArray(corpus.prs)) { console.error("f11-retro: the corpus needs a selectionRule and a prs array"); process.exitCode = 2; return; }

  const records: {
    repo: string; prNumber: number; base: string; head: string; corpusHash: string;
    consequence: string | null; // kept out of the labelling sheet
    analysisId: string; state: string;
    surfaced: { id: string; claimClass: string; text: string; score: number }[];
    suppressedCount: number; fogCount: number; silent: boolean;
    error?: string;
  }[] = [];

  for (const pr of corpus.prs) {
    const corpusHash = sha(JSON.stringify({ repo: pr.repo, base: pr.base, head: pr.head, prNumber: pr.prNumber })).slice(0, 16);
    const rec: (typeof records)[number] = {
      repo: pr.repo, prNumber: pr.prNumber, base: pr.base, head: pr.head, corpusHash,
      consequence: pr.consequence, analysisId: "", state: "", surfaced: [], suppressedCount: 0, fogCount: 0, silent: false,
    };
    records.push(rec);
    try {
      const svc = new Service(new Store(":memory:"), new WorkerClient(), new StubProvider());
      const view = await svc.pr.run({ actor: "f11-retro" }, undefined, {
        repoRoot: resolve(pr.repo), forge: "github", prNumber: pr.prNumber, headRef: pr.head, baseRef: pr.base,
      });
      const report = svc.pr.impactReportOf(view.analysisId);
      rec.analysisId = view.analysisId;
      rec.state = view.state;
      if (report) {
        rec.surfaced = report.surfaced.map((i) => ({ id: i.id, claimClass: i.claimClass, text: i.text, score: i.rank.score }));
        rec.suppressedCount = report.suppressed.length;
        rec.fogCount = report.fog.length;
        rec.silent = report.surfaced.length === 0;
      }
    } catch (e) {
      rec.error = String((e as Error).message ?? e).slice(0, 300);
    }
  }

  // ---- the labelling sheet (§14.1.4): blind — no consequence column; two reviewers label independently
  const sheet = records.map((r) => ({
    corpusHash: r.corpusHash, prNumber: r.prNumber,
    items: r.surfaced.map((i) => ({ id: i.id, claimClass: i.claimClass, text: i.text })),
    reviewer1MatchesItemIds: [] as string[], reviewer2MatchesItemIds: [] as string[],
  }));

  // ---- report (§14.1.5): denominators first; small corpora get small claims
  const consequence = records.filter((r) => r.consequence !== null);
  const controls = records.filter((r) => r.consequence === null);
  const report = {
    generatedAt: new Date().toISOString(),
    selectionRule: corpus.selectionRule,
    decisionRule: DECISION_RULE,
    denominators: { consequencePrs: consequence.length, controlPrs: controls.length, errored: records.filter((r) => r.error).length },
    itemsPerPr: records.map((r) => ({ corpusHash: r.corpusHash, surfaced: r.surfaced.length, suppressed: r.suppressedCount, fog: r.fogCount, silent: r.silent, error: r.error })),
    // recall + noise are completed after blind labelling: match = a reviewer's item id ∈ reviewerNMatchesItemIds
    labellingSheet: sheet,
    consequenceMatches: consequence.map((r) => ({ corpusHash: r.corpusHash, consequence: r.consequence, matchedItemIds: [] as string[], labellingDisagreement: false })),
    noiseRateOnControls: controls.length ? controls.filter((r) => !r.silent && r.surfaced.length > 0).length / controls.length : null,
    note: "recall on consequence PRs is filled in from the blind labelling sheet; disagreements are reported, not resolved silently",
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  writeFileSync(outPath.replace(/-retro\.json$/, "-labelling-sheet.json"), JSON.stringify(sheet, null, 2));
  console.log(`f11-retro: ${records.length} PRs → ${outPath}`);
  console.log(`f11-retro: denominators ${JSON.stringify(report.denominators)}; control noise rate ${report.noiseRateOnControls ?? "n/a"} (limit ${DECISION_RULE.proceedToSlice3If.noiseRateOnControlsBelow}, set in advance)`);
}

main().then(() => {}, (e) => { console.error(`f11-retro: ${(e as Error).message}`); process.exitCode = 1; });
