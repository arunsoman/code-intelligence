import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildHandler } from "../src/server.ts";
import { ctx, setup, FIXTURE } from "./helpers.ts";

async function withServer(fn: (base: string) => Promise<void>) {
  const { svc, worker, revision } = await setup();
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); } finally { srv.close(); worker.close(); }
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("gateway: allowlist, idempotency header, content-type, host guard", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, "/api/v1/components/C99/nope", {})).status, 404);
    assert.equal((await post(base, "/api/v1/components/C04/ingestRepository", { repoPath: FIXTURE })).status, 400, "mutating op needs Idempotency-Key");
    assert.equal((await post(base, "/api/v1/components/C01/switchBranch", { repoPath: FIXTURE, branch: "main" })).status, 400, "switching a checkout also requires an action key");
    assert.equal((await post(base, "/api/v1/components/C01/fetchBranches", { repoPath: FIXTURE })).status, 400, "fetching also requires an action key");
    const ct = await fetch(base + "/api/v1/components/C01/status", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(ct.status, 415);
    // fetch() ignores a custom Host header, so use a raw request for the rebinding check.
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path: "/api/v1/components/C01/status", method: "POST", headers: { "content-type": "application/json", host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      rq.on("error", reject); rq.end("{}");
    });
    assert.equal(status, 403);
    const ok = await (await post(base, "/api/v1/components/C19/ask", { question: "authentication" })).json() as any;
    assert.ok(ok.ok && ok.value.view.nodes.length > 0);
    const rel = await post(base, "/api/v1/components/C04/ingestRepository", { repoPath: "relative/path" }, { "idempotency-key": "k" });
    assert.equal(rel.status, 400);
  });
});

test("gateway: path traversal on static files is refused", async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/..%2f..%2fetc/passwd");
    const body = await r.text();
    // Either refused, or the SPA fallback page; never file contents from outside the web root.
    assert.ok([200, 403, 404].includes(r.status));
    assert.ok(!body.includes("root:") && (r.status !== 200 || body.includes("<div id=\"root\">")));
  });
});
