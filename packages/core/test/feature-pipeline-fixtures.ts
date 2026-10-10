// Shared by the pipeline tests: the transactions demo repository, a scripted model, the edits it proposes and a fake container runner.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationRequest, GenerationResponse, GenerationRouter } from "../src/llm-router.ts";
import { rawHash } from "../src/feature/canon.ts";
import type { FeatureEdit } from "../src/feature/candidate.ts";
import type { RunRequest, RunResult, Runner } from "../src/feature/types.ts";

const ROOT = join(import.meta.dirname, "../../..");
/** The bindings a fully authorised demo needs (D001, D005): validation, performance, release and publish. */
export const AUTH = { bindings: [
  { id: "val", scope: "validation", principals: ["arun"] }, { id: "perf", scope: "performance", principals: ["arun"] }, { id: "rel", scope: "release", principals: ["arun"] },
  { id: "pub", scope: "publish", principals: ["arun"], repositories: ["acme/transactions"], bases: ["main"], permissions: ["draft_pr.create"] },
] } as const;
export function demo(authority?: object): string {
  const dir = join(mkdtempSync(join(tmpdir(), "cie-tx-")), "transactions-app");
  execFileSync("bash", [join(ROOT, "scripts_make_demo_repo.sh"), dir, "transactions-app"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/transactions.git"]);
  // This fixture intentionally evaluates built-in security checks. Production still requires external SAST by default.
  mkdirSync(join(dir, ".cie"), { recursive: true });
  writeFileSync(join(dir, ".cie/security.json"), JSON.stringify({ requireExternalSast: false }));
  if (authority) { mkdirSync(join(dir, ".cie"), { recursive: true }); writeFileSync(join(dir, ".cie/authority.json"), JSON.stringify(authority)); }
  return dir;
}

/** A stand-in model that reads the prompt and returns what a careful builder would: it is a script, and the test says so. */
export class Script implements GenerationRouter {
  provider = "local"; model = "scripted"; endpoint = "http://127.0.0.1:11434"; hosted = false; calls = 0;
  async generate(req: GenerationRequest): Promise<GenerationResponse> {
    this.calls++; const base = { resolvedVersion: "script-v1", inputTokens: 10, outputTokens: 10 };
    if (/Draft acceptance/.test(req.system)) return { ...base, text: JSON.stringify({ acceptance: [
      { id: "A1", requirementIds: ["R1"], scenario: "A member exports their tenant's transactions", expectedOutcome: "The CSV has a header row and one row per transaction of that tenant only", mandatory: true },
      { id: "A2", requirementIds: ["R2"], scenario: "A support user tries to export", expectedOutcome: "The export is refused with status 403", mandatory: true }], assumptions: [] }) };
    if (/Propose exact edits/.test(req.system)) return { ...base, text: JSON.stringify({ edits: [] }) };
    const text = (JSON.parse(req.user) as { sources: { text: string }[] }).sources[0]!.text;
    return { ...base, text: JSON.stringify({ requirements: [
      { id: "R1", text: "Members can export their own tenant's transactions as CSV.", type: "FUNCTIONAL", sourceIndex: 0, actorIds: ["member"], conditions: [], dependsOn: [] },
      { id: "R2", text: "Support staff must not be able to export transactions.", type: "ACCESS", sourceIndex: 0, actorIds: ["support"], conditions: [], dependsOn: [] }].slice(0, /support/i.test(text) ? 2 : 1) }) };
  }
}
export const PROMPT = "Add CSV export of transactions so members can export their own tenant's transactions as CSV. Support staff must not be able to export transactions.";

/** The edits the "model" proposes, computed from the real file text so the quoted spans are exact. */
export const exportEdits = (repo: string): FeatureEdit[] => {
  const api = readFileSync(join(repo, "src/api.ts"), "utf8"); const anchor = "export type Response<T>";
  return [
    { op: "CREATE_FILE", file: "src/export.ts", why: "csv", requirementIds: ["R1", "R2"], content: `import type { Transaction } from "./transactions.ts";\n\nconst cell = (v: string | number): string => { const s = String(v); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };\n\nexport function toCsv(rows: Transaction[]): string {\n  const head = "id,amountCents,currency,createdAt";\n  return [head, ...rows.map((t) => [t.id, t.amountCents, t.currency, t.createdAt].map(cell).join(","))].join("\\n") + "\\n";\n}\n` },
    { op: "REPLACE_SPAN", file: "src/api.ts", baseHash: rawHash(api), start: Buffer.byteLength(api.slice(0, api.indexOf(anchor))), end: Buffer.byteLength(api.slice(0, api.indexOf(anchor))) + anchor.length, expected: anchor, why: "route", requirementIds: ["R1", "R2"],
      newText: `import { toCsv } from "./export.ts";\n\nexport function exportTransactions(user: User, db: Db): { status: 200 | 403; body: string } {\n  if (!canReadTransactions(user)) return { status: 403, body: "not allowed" };\n  return { status: 200, body: toCsv(listTransactions(db, user.tenantId)) };\n}\n\n${anchor}` },
    { op: "CREATE_FILE", file: "tests/export.test.ts", why: "tests", requirementIds: ["R1", "R2"], content: `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { exportTransactions } from "../src/api.ts";\n\nconst db = { transactions: [\n  { id: "t1", tenantId: "acme", amountCents: 1250, currency: "USD", createdAt: "2026-10-01T10:00:00Z" },\n  { id: "t3", tenantId: "globex", amountCents: 500, currency: "EUR", createdAt: "2026-10-03T10:00:00Z" },\n] };\n\ntest("a member exports a header row and only their tenant's rows", () => {\n  const r = exportTransactions({ id: "u1", tenantId: "acme", role: "member" }, db);\n  assert.equal(r.status, 200); assert.equal(r.body, "id,amountCents,currency,createdAt\\nt1,1250,USD,2026-10-01T10:00:00Z\\n");\n});\n\ntest("support staff cannot export", () => {\n  assert.equal(exportTransactions({ id: "u2", tenantId: "acme", role: "support" }, db).status, 403);\n});\n` },
  ];
};

export class FakeRunner implements Runner {
  readonly isolation = "CONTAINER" as const; readonly omissions: string[] = []; calls: RunRequest[] = [];
  async run(req: RunRequest): Promise<RunResult> { this.calls.push(req); const test = req.argv.includes("test");
    return { status: "PASSED", exitCode: 0, stdout: test ? "TAP version 13\nok 1 - a member exports a header row and only their tenant's rows\nok 2 - support staff cannot export\n# tests 2\n# pass 2\n# fail 0\n" : "ok api.ts\n", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } }; }
}

