// F14 slice S2 — the local PR-chat watcher (§8, §7.6).
//
//   node packages/core/src/cli/pr-chat.ts --repo . --pr <n> [--once] [--dry-run] [--model]
//
// Polls the PR's comments through the forge transport and answers `/cie` commands from the local index at the
// PR head — the developer's own running CIE, local-first (§7.6). No model by default: free-form questions get the
// one-time explanation unless --model marks a local model as configured (D1: only after S0 supports it).
//
// Exit codes: 0 ok · 1 tool/transport failure · 2 argument problems.
import { resolve } from "node:path";
import { Service } from "../service.ts";
import { Store } from "../store.ts";
import { WorkerClient, defaultWorkerPath } from "../worker.ts";
import { StubProvider } from "@cie/model";
import { ghCliChatTransport, PrChatWatcher, ReplyLedger, parseChat, runChatCommand, renderReply, isFeedbackVerb, type PrChatReply } from "../pr-chat.ts";

interface Args { repo: string; pr: number; once: boolean; dryRun: boolean; model: boolean; pollMs: number }

export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { repo: ".", pr: 0, once: false, dryRun: false, model: false, pollMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] ?? "";
    else if (a === "--pr") args.pr = Number(argv[++i]);
    else if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--model") args.model = true;
    else if (a === "--poll-ms") args.pollMs = Number(argv[++i]);
    else if (a === "--help") return { error: "usage: cie pr-chat --repo . --pr <n> [--once] [--dry-run] [--model] [--poll-ms <ms>]" };
    else return { error: `unknown argument: ${a}` };
  }
  if (!Number.isInteger(args.pr) || args.pr <= 0) return { error: "give --pr <number>" };
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) { console.error(`cie pr-chat: ${parsed.error}`); return 2; }
  const args = parsed;
  const repoRoot = resolve(args.repo);
  const repoSlug = process.env.CIE_REPO ?? repoRoot.split("/").slice(-2).join("/");

  const workerPath = (() => { try { return defaultWorkerPath(); } catch { return "/bin/cat"; } })();
  const svc = new Service(new Store("cie.sqlite"), new WorkerClient(workerPath), new StubProvider());
  const ledger = new ReplyLedger(svc.store);
  const transport = ghCliChatTransport(repoRoot, repoSlug);
  const watcher = new PrChatWatcher({
    ledger,
    scopeFor: (ev) => svc.prChatScopeForHead(repoRoot, ev.prNumber, ev.headHash),
    buildEnv: (scope) => svc.prChatEnvFor(scope),
    reportHashOf: (analysisId) => svc.prChatReportHash(analysisId),
    nowHeadHashOf: (analysisId) => svc.prChatNowHead(analysisId),
    deniedPrefixesOf: (root) => svc.store.deniedPrefixes(root),
    evidenceOf: (revision, id) => svc.store.evidence(revision, id),
    transport,
    feedbackFor: (ev, scope) => svc.chatFeedbackFor(ev, scope),
  }, { modelAvailable: args.model });

  const report = (replies: PrChatReply[]) => {
    for (const r of replies) console.log(`${r.outcome} ${r.commentId}${r.replyId ? ` → ${r.replyId}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
  };

  if (args.dryRun) {
    // Print the replies that would be posted; nothing leaves the machine.
    const events = await transport.listComments(args.pr);
    const latest = svc.pr.latestForPr(repoRoot, args.pr) as { id: string } | null;
    const scope = latest ? svc.prChatScopeFor(latest.id) : null;
    for (const ev of events) {
      console.log(`# ${ev.author}: ${ev.body.split("\n")[0].slice(0, 80)}`);
      if (!scope) { console.log("(no analysis for this PR yet — run C23/analyzePullRequest first)"); continue; }
      const parsed = parseChat(ev.body);
      if (parsed.type === "ignore") { console.log("(not a command — ignored)"); continue; }
      if (parsed.type === "freeform") { console.log("(free-form needs a local model; use --model once S0 supports it)"); continue; }
      if (isFeedbackVerb(parsed.verb)) { console.log("(feedback command — mutating; run without --dry-run to record it in the log)"); continue; }
      console.log(renderReply(runChatCommand(svc.prChatEnvFor(scope), parsed as { verb: "impact" | "tests" | "callers" | "why" | "why-not" | "help"; args: string }), { commentId: ev.commentId }));
    }
    return 0;
  }

  try {
    if (args.once) {
      report(await watcher.pollOnce(args.pr));
      return 0;
    }
    for (;;) {
      report(await watcher.pollOnce(args.pr));
      await new Promise((r) => setTimeout(r, args.pollMs));
    }
  } catch (e) {
    console.error(`cie pr-chat: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`cie pr-chat: ${(e as Error).message}`); process.exitCode = 1; });
}
