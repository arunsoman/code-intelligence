// Prompt-to-feature conformance (plan 4.2): one row per acceptance scenario AT-01–84 from Prompt-to-feature.md, with the tests whose titles
// cite it, whether those tests passed in a recorded run, and a status that is never silent:
//   PASS      at least one test cites the scenario and every such test passed
//   FAIL      a citing test failed
//   SKIPPED   a citing test was skipped (for example Docker is absent), so nothing passed
//   DEFERRED  named in docs/prompt-to-feature/deferred.json with the reason
//   UNTESTED  no test cites it and it is not deferred — this is the gap list
// PASS means "a test written for this scenario passes", not that its whole expected outcome is proven; the test titles are listed so a reviewer can judge.
// Usage: node scripts/conformance.ts --run | --results <spec-reporter output file>   (writes docs/prompt-to-feature/conformance.{json,md})
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTitles } from "./status.ts";

export type Row = { id: string; scenario: string; expected: string; pf: string; tests: { title: string; result: "PASS" | "FAIL" | "SKIPPED" | "NOT_RUN" }[]; status: "PASS" | "FAIL" | "SKIPPED" | "DEFERRED" | "UNTESTED"; reason?: string };

/** Scenarios named by a test title: "AT-07", "AT-74-77" (a range), "AT-22/57" (a list). */
export function atRefs(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(/AT-(\d\d)((?:[/-]\d\d)*)/g)) {
    let prev = Number(m[1]); out.add(`AT-${m[1]}`);
    for (const p of m[2]!.matchAll(/([/-])(\d\d)/g)) { const n = Number(p[2]); if (p[1] === "-") for (let k = prev + 1; k <= n; k++) out.add(`AT-${String(k).padStart(2, "0")}`); else out.add(`AT-${p[2]}`); prev = n; }
  }
  return [...out].filter((x) => Number(x.slice(3)) >= 1 && Number(x.slice(3)) <= 84).sort();
}

export function specRows(spec: string): Pick<Row, "id" | "scenario" | "expected" | "pf">[] {
  const rows = new Map<string, Pick<Row, "id" | "scenario" | "expected" | "pf">>();
  for (const ln of spec.split("\n")) { const m = /^\|\s*(AT-\d\d)\s*\|/.exec(ln); if (!m) continue; const c = ln.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim()); rows.set(c[0]!, { id: c[0]!, scenario: c[1] ?? "", expected: c[2] ?? "", pf: c[3] ?? "" }); }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** `✔ title (1.2ms)` / `✖ title` / `﹣ title # SKIP` lines of node's spec reporter. */
export function parseResults(out: string): Map<string, "PASS" | "FAIL" | "SKIPPED"> {
  const m = new Map<string, "PASS" | "FAIL" | "SKIPPED">();
  for (const line of out.split("\n")) {
    const x = /^\s*(✔|✖|﹣)\s+(.*?)(?:\s+\([\d.]+m?s\))?(?:\s+#\s*SKIP.*)?$/.exec(line); if (!x) continue;
    const title = x[2]!.trim(); const r = x[1] === "✔" ? "PASS" : x[1] === "✖" ? "FAIL" : "SKIPPED";
    if (m.get(title) === "FAIL") continue; m.set(title, r);
  }
  return m;
}

/** A title as it appears in a run: the source text has escapes (\" \\ ), the reporter prints the characters. */
export const plainTitle = (t: string): string => t.replace(/\\(.)/g, "$1");

/** `mapped` names existing tests (by a distinctive part of the title) that cover a scenario without citing it; a name that matches no test is an error elsewhere. */
export function buildConformance(spec: string, rawTitles: string[], results: Map<string, "PASS" | "FAIL" | "SKIPPED">, deferred: Record<string, string>, mapped: Record<string, string[]> = {}): Row[] {
  const titles = rawTitles.map(plainTitle);
  const byAt = new Map<string, string[]>();
  for (const t of titles) for (const id of atRefs(t)) byAt.set(id, [...(byAt.get(id) ?? []), t]);
  for (const [id, parts] of Object.entries(mapped)) for (const part of parts) for (const t of titles) if (t.includes(part)) byAt.set(id, [...(byAt.get(id) ?? []), t]);
  return specRows(spec).map((r): Row => {
    const tests = [...new Set(byAt.get(r.id) ?? [])].map((title) => ({ title, result: (results.get(title) ?? "NOT_RUN") as Row["tests"][number]["result"] }));
    let status: Row["status"]; let reason: string | undefined;
    if (tests.some((t) => t.result === "FAIL")) status = "FAIL";
    else if (tests.length && tests.every((t) => t.result === "PASS")) status = "PASS";
    else if (tests.length) { status = "SKIPPED"; reason = tests.every((t) => t.result === "NOT_RUN") ? "the citing tests were not in the recorded run" : "a citing test was skipped or not run"; }
    else status = "UNTESTED";
    // A deferral is a statement that the scenario's whole expected outcome is not shown, so it overrides PASS (never FAIL); the tests stay listed.
    if (deferred[r.id] && status !== "FAIL") { status = "DEFERRED"; reason = deferred[r.id]; }
    return { ...r, tests, status, ...(reason ? { reason } : {}) };
  });
}

export const summary = (rows: Row[]): Record<Row["status"], number> => rows.reduce((m, r) => ({ ...m, [r.status]: m[r.status] + 1 }), { PASS: 0, FAIL: 0, SKIPPED: 0, DEFERRED: 0, UNTESTED: 0 });

export function markdown(rows: Row[]): string {
  const s = summary(rows);
  return [`# Prompt-to-feature conformance (AT-01–84)`, "", `PASS ${s.PASS} · FAIL ${s.FAIL} · SKIPPED ${s.SKIPPED} · DEFERRED ${s.DEFERRED} · UNTESTED ${s.UNTESTED}`, "",
    "PASS means a test written for the scenario passed in the recorded run. It is an inventory of coverage, not a claim that each scenario's whole expected outcome is proven; read the tests. Generated by `scripts/conformance.ts`.", "",
    "| AT | Status | Scenario | Tests | Note |", "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.scenario.replace(/\|/g, "/")} | ${r.tests.length ? r.tests.map((t) => `${t.result === "PASS" ? "✔" : t.result === "FAIL" ? "✖" : "﹣"} ${t.title.slice(0, 90).replace(/\|/g, "/")}`).join("<br>") : "—"} | ${(r.reason ?? "").replace(/\|/g, "/")} |`), ""].join("\n");
}

const root = join(import.meta.dirname, "..");
if (import.meta.main) {
  const args = process.argv.slice(2); let out = "";
  if (args[0] === "--run") {
    const files = spawnSync("sh", ["-c", "ls packages/core/test/feature-*.test.ts apps/web/test/build-*.test.ts"], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n");
    out = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout;
    // Rust tests that cover scenarios (the canon parity vectors) run through cargo; `test canon::tests::name ... ok` becomes `✔ rust:name`.
    const cargo = spawnSync("cargo", ["test", "-p", "worker", "canon"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const m of (cargo.stdout ?? "").matchAll(/^test (?:[\w:]+::)?(\w+) \.\.\. (ok|FAILED|ignored)/gm)) out += `\n${m[2] === "ok" ? "✔" : m[2] === "FAILED" ? "✖" : "﹣"} rust:${m[1]}`;
  } else if (args[0] === "--results" && args[1]) out = readFileSync(args[1], "utf8");
  else { console.error("usage: node scripts/conformance.ts --run | --results <spec reporter output>"); process.exit(2); }
  const deferred = JSON.parse(readFileSync(join(root, "docs/prompt-to-feature/deferred.json"), "utf8")) as Record<string, string>;
  const mapped = JSON.parse(readFileSync(join(root, "docs/prompt-to-feature/at-map.json"), "utf8")) as Record<string, string[]>;
  const rows = buildConformance(readFileSync(join(root, "Prompt-to-feature.md"), "utf8"), testTitles(), parseResults(out), deferred, mapped);
  writeFileSync(join(root, "docs/prompt-to-feature/conformance.json"), JSON.stringify(rows, null, 1) + "\n"); writeFileSync(join(root, "docs/prompt-to-feature/conformance.md"), markdown(rows));
  const s = summary(rows); console.log(JSON.stringify(s));
  const untested = rows.filter((r) => r.status === "UNTESTED").map((r) => r.id); if (untested.length) console.log("UNTESTED:", untested.join(" "));
  process.exit(s.FAIL ? 1 : 0);
}
