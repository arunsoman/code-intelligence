import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditorEvent } from "@cie/schema";
import { ctx, demoRepo, setup } from "./helpers.ts";

const ev = (repo: string, over: Partial<EditorEvent>): EditorEvent => ({ sessionId: "s1", sequence: 0, kind: "SELECTION", file: `${repo}/src/payments/fraud.ts`, startLine: 5, ...over });

test("editor events resolve to entities by file and line; only paths and line numbers are stored", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = svc.captureEditorEvent(ctx(), { event: ev(repo, { sequence: 1 }) });
  assert.ok(r.ok && r.value.accepted && r.value.indexed);
  assert.deepEqual(r.value.entities, ["function:src/payments/fraud.ts#checkFraud"]);
  const range = svc.captureEditorEvent(ctx(), { event: ev(repo, { sequence: 2, startLine: 5, endLine: 10 }) });
  assert.ok(range.ok && range.value.entities.includes("function:src/payments/fraud.ts#checkFraud") && range.value.entities.includes("function:src/payments/fraud.ts#velocity"));
  const c = svc.editorContext(ctx(), { revision });
  assert.ok(c.ok);
  assert.ok(c.value.focus.some((f) => f.label === "checkFraud"));
  // Nothing but paths, line numbers and entity ids is persisted.
  const rows = JSON.stringify(svc.store.db.prepare("select * from context_events").all());
  assert.ok(!rows.includes("throw new") && !rows.includes("FraudRejectedError("), "no file text is stored");
  worker.close();
});

test("stale and reordered events are dropped, not applied over newer ones", async () => {
  const repo = demoRepo();
  const { svc, worker } = await setup(undefined, repo);
  assert.ok(svc.captureEditorEvent(ctx(), { event: ev(repo, { sequence: 5, startLine: 5 }) }).ok);
  const late = svc.captureEditorEvent(ctx(), { event: ev(repo, { sequence: 3, file: `${repo}/src/ledger/ledger.ts`, startLine: 15 }) });
  assert.ok(late.ok && late.value.accepted === false && late.value.stale === true);
  const dup = svc.captureEditorEvent(ctx(), { event: ev(repo, { sequence: 5 }) });
  assert.ok(dup.ok && dup.value.stale === true, "a replayed event is not applied twice");
  const other = svc.captureEditorEvent(ctx(), { event: ev(repo, { sessionId: "s2", sequence: 0, file: `${repo}/src/ledger/ledger.ts`, startLine: 15 }) });
  assert.ok(other.ok && other.value.accepted, "sequences are per session");
  worker.close();
});

test("editor events reject malformed input and unindexed files are accepted without being resolved", async () => {
  const repo = demoRepo();
  const { svc, worker } = await setup(undefined, repo);
  for (const bad of [{ ...ev(repo, {}), file: "relative/a.ts" }, { ...ev(repo, {}), kind: "NOPE" as any }, { ...ev(repo, {}), sequence: 1.5 }, { ...ev(repo, {}), sessionId: "" }]) {
    const r = svc.captureEditorEvent(ctx(), { event: bad });
    assert.ok(!r.ok && r.error.code === "INVALID_SCHEMA");
  }
  const outside = svc.captureEditorEvent(ctx(), { event: ev(repo, { sequence: 9, file: "/etc/hosts", startLine: 1 }) });
  assert.ok(outside.ok && outside.value.indexed === false && outside.value.entities.length === 0);
  worker.close();
});

test("editor focus becomes referents: 'why are these connected?' works on pinned editor elements without a canvas selection", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const pins = ["function:src/payments/payment-service.ts#charge", "function:src/payments/fraud.ts#checkFraud"];
  const r = await svc.converse(ctx(), { text: "why are these connected?", view: null, pins, revision });
  assert.ok(r.ok && r.value.kind === "explanation", JSON.stringify(r));
  assert.match(r.value.explanation.claims[0].draft.assertion, /charge calls checkFraud|checkFraud is called by charge/);
  const asked = await svc.converse(ctx(), { text: "how do payments work", pins: ["function:src/payments/fraud.ts#checkFraud"], revision });
  assert.ok(asked.ok && asked.value.kind === "view" && asked.value.view.nodes.some((n) => n.label === "checkFraud"), "a pinned editor element is always in the map");
  worker.close();
});

test("evidence carries an absolute path for open-in-editor links", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const asked = await svc.ask(ctx(), { question: "how does fraud checking work", revision });
  assert.ok(asked.ok);
  const n = asked.value.view.nodes.find((x) => x.label === "checkFraud")!;
  const e = svc.evidenceFor(ctx(), { revision, evidenceId: n.evidenceIds[0] });
  assert.ok(e.ok && e.value.absPath === `${repo}/src/payments/fraud.ts` && e.value.startLine > 0);
  worker.close();
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createReporter } from "@cie/reporter";
import { buildHandler } from "../src/server.ts";
import { traceFor } from "./helpers.ts";

test("live exceptions: a running app reports to the inbox; repeats collapse; the report maps onto the repository", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const trace = traceFor(repo);
  const post = (body: unknown) => fetch(`${url}/api/v1/components/C24/reportException`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  const a = await post({ trace, source: "api-server" });
  assert.ok(a.ok && a.value.isNew && a.value.inRepo && a.value.errorClass === "FraudRejectedError");
  const b = await post({ trace, source: "api-server" });
  assert.ok(b.ok && !b.value.isNew && b.value.count === 2 && b.value.id === a.value.id, "same fingerprint → one entry with a count");
  assert.equal((await post({ trace: "nothing useful here" })).ok, false);
  const other = await post({ trace: `TypeError: boom\n    at foo (/not/in/repo.js:1:1)` });
  assert.ok(other.ok && other.value.inRepo === false, "an exception from elsewhere is stored but marked not in this repo");

  // The real reporter, from a real Error, against the real handler.
  const report = createReporter({ url, source: "reporter" });
  assert.equal(await report(new RangeError("from the reporter")), true);

  const list = svc.listExceptions(ctx(), {});
  assert.ok(list.ok);
  assert.equal(list.value.length, 3);
  assert.equal(list.value.find((e) => e.errorClass === "FraudRejectedError")!.count, 2);
  // Investigating an inbox entry is the same path as a pasted trace.
  const inv = await svc.converse(ctx(), { text: list.value.find((e) => e.errorClass === "FraudRejectedError")!.trace, revision });
  assert.ok(inv.ok && inv.value.kind === "view" && inv.value.view.formId === "HypothesisGraph");
  assert.ok(svc.dismissException(ctx(), { id: a.value.id }).ok);
  assert.equal((svc.listExceptions(ctx(), {}) as any).value.length, 2);
  assert.ok(!svc.dismissException(ctx(), { id: "exc:nope" }).ok);
  srv.close(); worker.close();
});

test("an error object reported by the reporter keeps its class and message", async () => {
  const { svc, worker } = await setup();
  const e = new Error("card declined");
  const r = svc.reportException(ctx(), { error: { name: e.name, message: e.message, stack: e.stack }, source: "x" });
  assert.ok(r.ok && r.value.errorClass === "Error");
  const row = (svc.listExceptions(ctx(), {}) as any).value[0];
  assert.equal(row.message, "card declined");
  assert.equal((row.trace.match(/Error: card declined/g) ?? []).length, 1, "heading not duplicated");
  worker.close();
});
