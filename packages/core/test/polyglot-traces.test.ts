import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { looksLikeTrace, parseTrace } from "../src/trace.ts";
import { ctx, setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/polyglot");
const JAVA = `Exception in thread "http-nio-8080-exec-1" com.acme.pay.FraudRejectedException: acct-1
\tat com.acme.pay.PaymentService.charge(PaymentService.java:24)
\tat com.acme.pay.PaymentController.create(PaymentController.java:16)
\tat jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)
Caused by: java.lang.IllegalStateException: gateway down
\tat com.acme.pay.CardGateway.authorize(CardGateway.java:9)`;
const PY = `Traceback (most recent call last):
  File "/srv/app/api.py", line 12, in create_payment
    return service.charge("acct", 5)
  File "/srv/app/service.py", line 17, in charge
    raise InsufficientFunds(account)
app.service.InsufficientFunds: acct`;
const GO = `panic: negative amount

goroutine 1 [running]:
example.com/app/internal/ledger.(*Ledger).Reserve(0xc000012345, 0xffffffffffffffff)
\t/build/go/internal/ledger/ledger.go:14 +0x3d
main.(*Server).Handle(0xc000012340, 0x3)
\t/build/go/cmd/main.go:15 +0x25
main.main()
\t/build/go/cmd/main.go:22 +0x45
exit status 2`;

test("Java, Python and Go stack traces are parsed: error class, message, and frames with the function and the file's real location", () => {
  const j = parseTrace(JAVA);
  assert.deepEqual([j.errorClass, j.message], ["FraudRejectedException", "acct-1"]);
  assert.deepEqual(j.frames.slice(0, 2).map((f) => [f.fn, f.file, f.line]), [["PaymentService.charge", "com/acme/pay/PaymentService.java", 24], ["PaymentController.create", "com/acme/pay/PaymentController.java", 16]]);
  assert.ok(j.frames.length >= 5);
  const p = parseTrace(PY);
  assert.deepEqual([p.errorClass, p.message], ["InsufficientFunds", "acct"], "a custom exception that does not end in Error");
  assert.deepEqual(p.frames.map((f) => [f.fn, f.file.split("/").pop(), f.line]), [["create_payment", "api.py", 12], ["charge", "service.py", 17]]);
  const g = parseTrace(GO);
  assert.deepEqual([g.errorClass, g.message], ["panic", "negative amount"]);
  assert.deepEqual(g.frames.map((f) => [f.fn, f.file.split("/").pop(), f.line]), [["Ledger.Reserve", "ledger.go", 14], ["Server.Handle", "main.go", 15], ["main", "main.go", 22]]);
  for (const t of [JAVA, PY, GO]) assert.ok(looksLikeTrace(t));
  assert.ok(!looksLikeTrace("how does authentication work\nplease explain"));
});

test("a pasted Java, Python or Go trace becomes a ranked suspect list whose top suspect is the function that threw, in the repository's own files", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const run = async (trace: string) => { const r = await svc.investigate(ctx(), { trace, revision }); assert.ok(r.ok, JSON.stringify((r as any).error)); return r.value; };
  const java = await run(JAVA);
  const top = (v: any) => v.nodes.filter((n: any) => n.role === "suspect").sort((a: any, b: any) => (a.rank ?? 99) - (b.rank ?? 99)).map((n: any) => n.label);
  assert.equal(top(java.view)[0], "PaymentService.charge", top(java.view).join());
  assert.ok(top(java.view).includes("PaymentController.create"), "the caller on the stack is a suspect too");
  const py = await run(PY);
  assert.equal(top(py.view)[0], "PaymentService.charge", top(py.view).join());
  assert.ok(top(py.view).includes("create_payment"));
  const go = await run(GO);
  assert.equal(top(go.view)[0], "Ledger.Reserve", top(go.view).join());
  assert.ok(top(go.view).includes("Server.Handle"));
  // The framework frames (Spring, the JDK) are outside the repository: unmatched, not invented as code.
  const r = svc.reportException(ctx(), { trace: JAVA, source: "api" });
  assert.ok(r.ok);
  worker.close();
});
