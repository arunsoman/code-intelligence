import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeTrace, mapTrace, parseTrace } from "../src/trace.ts";
import { ctx, setup } from "./helpers.ts";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../fixtures/payments-repo");
const TRACE = `FraudRejectedError: acct-9 over limit
    at checkFraud (${root}/src/payments/fraud.ts:5:18)
    at charge (${root}/src/payments/payment-service.ts:10:3)
    at createPayment (${root}/src/api/payments-controller.ts:6:11)
    at Layer.handle (/usr/lib/node_modules/express/lib/router/layer.js:95:5)`;

test("parses class, message and frames", () => {
  const t = parseTrace(TRACE);
  assert.equal(t.errorClass, "FraudRejectedError");
  assert.equal(t.message, "acct-9 over limit");
  assert.equal(t.frames.length, 4);
  assert.deepEqual([t.frames[0].fn, t.frames[0].line, t.frames[0].col], ["checkFraud", 5, 18]);
  assert.ok(looksLikeTrace(TRACE));
  assert.ok(!looksLikeTrace("why does login fail"));
});

test("maps frames onto entities by file and line; frames outside the repo are reported, not guessed", async () => {
  const { svc, worker, revision } = await setup(undefined, root);
  const rev = svc.store.revision(revision)!;
  const m = mapTrace(svc.store, rev, TRACE);
  assert.deepEqual(m.frames.map((f) => f.entityId), [
    "function:src/payments/fraud.ts#checkFraud", "function:src/payments/payment-service.ts#charge", "function:src/api/payments-controller.ts#createPayment",
  ]);
  assert.equal(m.unmatched.length, 1);
  assert.ok(m.frames.every((f) => f.evidence.class === "RUNTIME" && svc.store.evidence(revision, f.evidence.id)));
  void ctx;
  worker.close();
});

import { normalizeFramePath } from "../src/trace.ts";

test("frame paths from every runtime normalize to repo-relative candidates", () => {
  const cases: [string, string][] = [
    ["file:///home/u/app/src/a.ts", "/home/u/app/src/a.ts"],
    ["file:///C:/Users/u/app/src/a.ts", "C:/Users/u/app/src/a.ts"],
    ["C:\\Users\\u\\app\\src\\a.ts", "C:/Users/u/app/src/a.ts"],
    ["http://localhost:5173/src/payments/fraud.ts?t=1699999", "/src/payments/fraud.ts"],
    ["webpack-internal:///(app-pages-browser)/./src/lib/a.ts", "src/lib/a.ts"],
    ["webpack://my-app/./src/b.ts?abcd", "src/b.ts"],
    ["http://localhost:3000/@fs/home/u/app/src/c.ts", "/home/u/app/src/c.ts"],
    ["./src/d.ts", "src/d.ts"],
  ];
  for (const [raw, want] of cases) assert.equal(normalizeFramePath(raw), want, raw);
});

test("Chrome, Firefox, async, constructor and browser-dev-server frames all parse", () => {
  const chrome = `TypeError: x is undefined
    at async Object.charge (http://localhost:5173/src/payments/payment-service.ts?t=17:10:3)
    at new PaymentController (webpack-internal:///./src/api/payments-controller.ts:6:11)
    at Foo.bar [as baz] (/app/src/a.ts:1:2)
    at /app/src/b.ts:3:4`;
  const c = parseTrace(chrome);
  assert.equal(c.errorClass, "TypeError");
  assert.deepEqual(c.frames.map((f) => [f.fn, f.file, f.line]), [["Object.charge", "/src/payments/payment-service.ts", 10], ["PaymentController", "src/api/payments-controller.ts", 6], ["Foo.bar", "/app/src/a.ts", 1], [undefined, "/app/src/b.ts", 3]]);
  const ff = parseTrace(`checkFraud@http://localhost:5173/src/payments/fraud.ts?t=1:5:18\ncharge/<@http://localhost:5173/src/payments/payment-service.ts:10:3\n@http://localhost:5173/src/main.ts:1:1`);
  assert.deepEqual(ff.frames.map((f) => [f.fn, f.file, f.line]), [["checkFraud", "/src/payments/fraud.ts", 5], ["charge", "/src/payments/payment-service.ts", 10], [undefined, "/src/main.ts", 1]]);
  assert.equal(parseTrace("Uncaught (in promise) FraudRejectedError: nope\n  at f (/a.ts:1:1)").errorClass, "FraudRejectedError");
  assert.equal(parseTrace("UnhandledPromiseRejection: x\n  at f (/a.ts:1:1)").errorClass, "UnhandledPromiseRejection");
});

test("a browser dev-server trace maps onto repository files by suffix; a drifted line falls back to the function name", async () => {
  const { svc, worker, revision } = await setup(undefined, root);
  const rev = svc.store.revision(revision)!;
  const web = `FraudRejectedError: acct-9 over limit
    at checkFraud (http://localhost:5173/src/payments/fraud.ts?t=99:5:18)
    at charge (http://localhost:5173/src/payments/payment-service.ts?t=99:999:3)`;
  const m = mapTrace(svc.store, rev, web);
  assert.deepEqual(m.frames.map((f) => f.entityId), ["function:src/payments/fraud.ts#checkFraud", "function:src/payments/payment-service.ts#charge"]);
  assert.equal(m.unmatched.length, 0);
  worker.close();
});

test("a plain Error heading is recognised, and a reported error keeps its message without a duplicated heading", () => {
  const p = parseTrace("Error: card declined\n    at charge (/a/b.ts:3:9)");
  assert.equal(p.errorClass, "Error"); assert.equal(p.message, "card declined");
  assert.equal(parseTrace("TypeError: x is not a function\n    at f (/a.ts:1:1)").errorClass, "TypeError");
  assert.equal(parseTrace("    at charge (/a/b.ts:3:9)").errorClass, null, "frames alone have no class");
});
