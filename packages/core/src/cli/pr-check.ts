// F11 slice S3 — the headless blast-radius check for CI (§12.1, §10.6).
//
//   node packages/core/src/cli/pr-check.ts --repo . --base <sha> --head <sha> --pr <number> [--dry-run] [--policy .cie/pr-policy.json]
//
// Runs the PR analysis exactly as the service would (same engine, same gate), prints the rendered impact comment,
// and — unless the run is read-only — publishes it through the same receipt-first publisher the server uses.
//
// Read-only mode (F11-A8): on a fork-triggered run there is no write scope. The Markdown is written to stdout and
// to $GITHUB_STEP_SUMMARY when set, and nothing is posted. A run is read-only when CIE_PR_CHECK_READONLY=1 or when
// no GitHub token can be found at call time (the token is read, never stored).
//
// Exit codes: 0 posted/updated/silent · 1 tool failure · 2 argument or policy problems.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../store.ts";
import { WorkerClient } from "../worker.ts";
import { StubProvider } from "@cie/model";
import { renderImpactComment } from "../impact-render.ts";
import { validateImpactPolicy, type ImpactPolicy } from "../impact-report.ts";
import { newGrant } from "../pr-publish.ts";
import { ghAuthToken } from "../gh.ts";
import { Service } from "../service.ts";

interface Args { repo: string; base: string; head: string; pr: number; dryRun: boolean; policyPath?: string }

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { repo: ".", base: "", head: "", pr: 0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] ?? "";
    else if (a === "--base") args.base = argv[++i] ?? "";
    else if (a === "--head") args.head = argv[++i] ?? "";
    else if (a === "--pr") args.pr = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--policy") args.policyPath = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  if (!args.base || !args.head) return { error: "give --base and --head commit hashes" };
  if (!Number.isInteger(args.pr) || args.pr <= 0) return { error: "give --pr <number>" };
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) { console.error(`cie pr-check: ${parsed.error}`); return 2; }
  const args = parsed;

  let policy: ImpactPolicy | undefined;
  if (args.policyPath) {
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(args.policyPath, "utf8")); }
    catch (e) { console.error(`cie pr-check: cannot read the policy document: ${(e as Error).message}`); return 2; }
    const check = validateImpactPolicy(doc);
    if (!check.ok) { console.error(`cie pr-check: the policy document is invalid: ${check.problems.join("; ")}`); return 2; }
    policy = check.policy;
  }

  const repoRoot = resolve(args.repo);
  const svc = new Service(new Store(process.env.CIE_DB ?? join(repoRoot, ".cie/pr-check.db")), new WorkerClient(), new StubProvider());
  const readOnly = process.env.CIE_PR_CHECK_READONLY === "1" || !ghAuthToken().ok;
  if (readOnly && !process.env.CIE_PR_CHECK_READONLY) {
    console.error("cie pr-check: no GitHub token found at call time; running read-only (fork mode: the Markdown is an artefact, nothing is posted)");
  }

  let view: { analysisId: string; state: string };
  try {
    view = await svc.pr.run({ actor: "cie-pr-check" }, undefined, { repoRoot, forge: "github", prNumber: args.pr, headRef: args.head, baseRef: args.base });
  } catch (e) {
    console.error(`cie pr-check: analysis failed: ${(e as Error).message}`);
    return 1;
  }
  const report = svc.pr.impactReportOf(view.analysisId);
  if (!report) { console.error("cie pr-check: no impact report was produced; is this an F11 build?"); return 1; }

  const denied = svc.store.deniedPrefixes(repoRoot);
  const row = svc.pr.row(view.analysisId);
  const rendered = renderImpactComment({
    report, analysisState: row?.state ?? "DECIDED", policy, deniedPrefixes: denied,
    resolveEvidence: (id) => !!svc.store.evidence(row?.head_revision ?? "", id),
    reviewUrl: svc.prPublisher.selfUrl ? `${svc.prPublisher.selfUrl}/#pr=${view.analysisId}` : undefined,
  });

  if (args.dryRun || readOnly) {
    // F11-A13: what you see here is byte-identical to what the publisher posts for this report hash.
    console.log(rendered.markdown);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CIE blast radius (read-only)\n\n${rendered.markdown}\n`);
    }
    if (rendered.silent) console.error("cie pr-check: silent — nothing met the noise threshold; no comment would be posted");
    return 0;
  }

  const grant = newGrant(svc.store, { repositoryId: repoRoot, headHash: args.head, principalId: "cie-pr-check", operation: "PUBLISH_IMPACT", ttlMs: 600_000 });
  const receipt = await svc.prPublisher.publishImpact(grant.id, { repositoryId: repoRoot, prNumber: args.pr, analysisId: view.analysisId, headHash: args.head, policy });
  if (receipt.state === "FAILED") { console.error(`cie pr-check: publication failed: ${receipt.lastError ?? "unknown"}`); return 1; }
  console.log(`cie pr-check: ${receipt.state}${receipt.state === "PREPARED" ? " (silent: nothing met the noise threshold)" : ""} — receipt ${receipt.publicationId}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`cie pr-check: ${(e as Error).message}`); process.exitCode = 1; });
}
