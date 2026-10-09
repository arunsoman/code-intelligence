import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctx, setup } from "./helpers.ts";
import { diagnostic, sanitizeDiagnostic, withDiagnostics } from "../src/diagnostics.ts";

function logging(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "cie-diagnostics-"));
  const keys = ["CIE_LOG_FILE", "CIE_LOG_LEVEL", "CIE_LOG_STDERR", "CIE_LOG_MAX_BYTES"];
  const saved = keys.map((key) => process.env[key]);
  process.env.CIE_LOG_FILE = join(dir, "trace.jsonl");
  process.env.CIE_LOG_LEVEL = "debug";
  process.env.CIE_LOG_STDERR = "0";
  delete process.env.CIE_LOG_MAX_BYTES;
  t.after(() => { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file: process.env.CIE_LOG_FILE };
}

test("diagnostics isolate concurrent async request contexts and preserve nested context", async (t) => {
  const { file } = logging(t);
  await Promise.all(["request-a", "request-b"].map((requestId) => withDiagnostics({ requestId }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    withDiagnostics({ stage: "nested" }, () => diagnostic("nested"));
    diagnostic("complete");
  })));
  const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const id of ["request-a", "request-b"]) {
    const pair = rows.filter((row) => row.requestId === id);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].stage, "nested");
    assert.equal(pair[1].stage, undefined);
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("diagnostics redact credentials, source fields and errors; circular values remain serializable", (t) => {
  const { file } = logging(t);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  diagnostic("safety", { authorization: "private credential", source: "private source", question: "password=hunter2", error: new Error("Bearer abc123"), tokenShape: "ghp_" + "x".repeat(35), cycle });
  const raw = readFileSync(file, "utf8");
  for (const forbidden of ["private credential", "private source", "hunter2", "abc123", "x".repeat(35)]) assert.ok(!raw.includes(forbidden));
  const row = JSON.parse(raw);
  assert.equal(row.cycle.self, "[circular]");
  assert.ok(row.error.stack);
  assert.match(String(sanitizeDiagnostic("word ".repeat(1800))), /truncated/);
});

test("diagnostics honor levels, rotate bounded files, and identify oversized records", (t) => {
  const { file } = logging(t);
  process.env.CIE_LOG_MAX_BYTES = "1024";
  for (let i = 0; i < 50; i++) diagnostic("rotation", { sequence: i, padding: "word ".repeat(40) });
  assert.ok(existsSync(file + ".3"));
  assert.ok(!existsSync(file + ".4"));
  for (const path of [file, file + ".1", file + ".2", file + ".3"]) assert.ok(statSync(path).size <= 1024);
  diagnostic("oversized", { details: "word ".repeat(400) });
  assert.match(readFileSync(file, "utf8"), /record exceeded size limit/);
  process.env.CIE_LOG_LEVEL = "off";
  const before = readFileSync(file, "utf8");
  diagnostic("disabled", {}, "error");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an unwritable diagnostic destination never breaks application work", (t) => {
  const { dir } = logging(t);
  const parent = join(dir, "regular-file"); writeFileSync(parent, "data");
  process.env.CIE_LOG_FILE = join(parent, "trace.jsonl");
  assert.doesNotThrow(() => diagnostic("failure"));
});


test("a real empty chart request emits a correlated retrieval, model and chart trace", async (t) => {
  const { file } = logging(t);
  const { svc, worker, revision } = await setup();
  t.after(() => { worker.close(); svc.store.db.close(); });
  const call = ctx();
  const response = await svc.converse(call, { text: "show me the ER diagram", revision });
  assert.ok(response.ok);
  const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const trace = records.filter((row) => row.requestId === call.requestId);
  for (const event of ["conversation.start", "conversation.route", "ask.route", "retrieval.complete", "retrieval.candidates", "model.dispatch", "model.complete", "chart.plan", "chart.compiled", "conversation.complete"]) {
    assert.ok(trace.some((row) => row.event === event), `missing ${event}`);
  }
  assert.ok(trace.every((row) => row.traceId === call.traceId));
  const retrieval = trace.find((row) => row.event === "retrieval.complete");
  assert.equal(retrieval.overview, false);
  assert.ok(Number.isInteger(retrieval.bundle.entityCount));
  assert.equal(retrieval.bundle.facts, undefined);
  assert.equal(retrieval.bundle.evidence, undefined);
  const chart = trace.find((row) => row.event === "chart.compiled");
  assert.equal(chart.nodes, 0);
  assert.ok(chart.gaps.length > 0);
});
