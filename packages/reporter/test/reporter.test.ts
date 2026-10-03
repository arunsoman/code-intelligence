import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createReporter, isLoopbackUrl } from "../src/index.ts";

test("only loopback servers are accepted", () => {
  assert.ok(isLoopbackUrl("http://127.0.0.1:4317") && isLoopbackUrl("http://localhost:1"));
  assert.ok(!isLoopbackUrl("https://example.com") && !isLoopbackUrl("nonsense"));
  assert.throws(() => createReporter({ url: "https://collector.example.com" }), /localhost/);
});

test("reports name, message and stack; can omit the message; throttles repeats; never throws", async () => {
  const bodies: any[] = [];
  const srv = createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => { bodies.push(JSON.parse(b)); rs.end(JSON.stringify({ ok: true })); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const report = createReporter({ url, source: "test-app", throttleMs: 60_000 });
  const err = new TypeError("card 4111 declined");
  assert.equal(await report(err), true);
  assert.equal(await report(err), false, "same error within the throttle window is not re-sent");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].source, "test-app");
  assert.equal(bodies[0].error.name, "TypeError");
  assert.match(bodies[0].error.stack, /reporter\.test/);
  const quiet = createReporter({ url, includeMessage: false });
  await quiet(new Error("secret value 123"));
  assert.equal(bodies[1].error.message, "");
  srv.close();
  const dead = createReporter({ url: "http://127.0.0.1:1" });
  assert.equal(await dead(new Error("x")), false, "an unreachable server is swallowed, not thrown");
});
