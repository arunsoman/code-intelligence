// Offload parity: motif matching runs in the Rust worker in production; both runtimes must agree
// occurrence-for-occurrence — same motif set, same node evidence, same bound variables, same order —
// over the real graphs the TypeScript compiler builds. This is the pins that let the worker own the
// compute (contracts §10) without the identity drifting between runtimes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllPdgs } from "../src/concept-hierarchy/pdg.ts";
import { matchMotifs, matchMotifsBatch } from "../src/concept-hierarchy/motifs.ts";
import { Store } from "../src/store.ts";
import { ACCUMULATE, COLLECT, DISPATCH, FLAG, LEDGER, NULLFALLBACK, RESOURCES, RETRY, RETHROW, makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

const files = {
  "src/ledger.ts": LEDGER, "src/accumulate.ts": ACCUMULATE, "src/collect.ts": COLLECT, "src/dispatch.ts": DISPATCH,
  "src/flag.ts": FLAG, "src/nullfallback.ts": NULLFALLBACK, "src/resources.ts": RESOURCES, "src/retry.ts": RETRY, "src/rethrow.ts": RETHROW,
};

test("the worker matches motifs exactly as the TypeScript reference, occurrence for occurrence", () => {
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, files);
  const { pdgs } = buildAllPdgs(store, "rev");
  assert.ok(pdgs.length >= 9, `one graph per fixture function (got ${pdgs.length})`);
  const local = pdgs.map((g) => matchMotifs(g));
  const offloaded = matchMotifsBatch(pdgs);
  assert.equal(offloaded.length, pdgs.length, "one result per graph, in input order");
  for (const [i, g] of pdgs.entries()) {
    assert.deepEqual(offloaded[i], local[i], `motif parity for ${g.entityId}`);
  }
});

test("the offloaded batch is a drop-in for the reference on an empty and a repeated set", () => {
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, files);
  const { pdgs } = buildAllPdgs(store, "rev");
  assert.deepEqual(matchMotifsBatch([]), []);
  const twice = [...pdgs, pdgs[0]];
  const offloaded = matchMotifsBatch(twice);
  assert.deepEqual(offloaded[twice.length - 1], offloaded[0], "the repeated graph matches identically");
});