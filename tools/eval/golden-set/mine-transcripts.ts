// Stage 0 prerequisite: a golden set should start from real questions, not invented ones. This mines every `user`
// turn out of an existing cie SQLite store's chat_sessions table and writes them as *draft*, unlabeled GoldenCases
// (needsLabeling: true, expectedFacts: []) for a human to review, discard, or fill in. It never writes directly into
// the curated cases/*.json files a human maintains — only into its own "mined-*.json" output, so a re-run can never
// silently overwrite someone's labeling work.
// Usage: npx tsx tools/eval/golden-set/mine-transcripts.ts <path-to-store.sqlite> [--repo=my-repo] [--out=mined.json]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatTurn } from "../../../packages/core/src/chat-session.ts";
import type { GoldenCase } from "./schema.ts";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dbPath = positional[0];
if (!dbPath) { console.error("Usage: mine-transcripts.ts <path-to-store.sqlite> [--repo=name] [--out=mined.json]"); process.exit(1); }
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? "true"]; }));
const repo = flags.repo ?? "unlabeled";
const out = flags.out ?? join(import.meta.dirname, `mined-${repo}.json`);

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare("select session_id, turns_json from chat_sessions").all() as { session_id: string; turns_json: string }[];

const seen = new Set<string>();
const cases: GoldenCase[] = [];
for (const row of rows) {
  let turns: ChatTurn[];
  try { turns = JSON.parse(row.turns_json); } catch { continue; }
  for (const turn of turns) {
    if (turn.role !== "user" || turn.state !== "complete") continue;
    const question = turn.text.trim();
    if (!question || seen.has(question)) continue;
    seen.add(question);
    cases.push({
      id: `mined-${row.session_id}-${turn.seq}`,
      repo,
      question,
      type: "open", // a human must assign the real type when labeling
      expectedFacts: [],
      needsLabeling: true,
      notes: `Mined from session ${row.session_id}, turn ${turn.seq} (${turn.at}). Assign a type, fill expectedFacts from reading the actual code, then clear needsLabeling.`,
    });
  }
}
db.close();

writeFileSync(out, JSON.stringify(cases, null, 2));
console.log(`Mined ${cases.length} distinct user question(s) from ${rows.length} session(s) into ${out}.`);
console.log(cases.length ? "Review and label each case, then move it into cases/ (removing needsLabeling) before it counts toward any baseline metric." : "No user turns found — there is no chat history in this store yet.");
