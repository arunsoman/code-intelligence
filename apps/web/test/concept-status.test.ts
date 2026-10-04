import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConceptStore, JobView } from "@cie/schema";
import { VERSIONING_HELP, conceptExtractions, providerInfo, versionInfos } from "../src/concept-status.ts";

const job = (over: Partial<JobView>): JobView => ({ id: "j1", kind: "concepts", state: "RUNNING", cancelRequested: false, committing: false, phase: "extracting", message: "", params: { revision: "r1" }, createdAt: "2026-01-01T00:00:00.000Z", ...over }) as JobView;

const store = (versions: ConceptStore["versions"], version: number): ConceptStore => ({ version, versions, cards: [], claims: {}, diff: null, statedConfidence: [] });

test("an offline stub is named as deterministic and explicitly not model-read", () => {
  const stub = providerInfo("stub/deterministic-graph-v1");
  assert.equal(stub.deterministic, true);
  assert.equal(stub.badge, "deterministic, not model-read");
  assert.equal(providerInfo("openai/gpt-4o").deterministic, false);
  assert.equal(providerInfo("anthropic/claude-sonnet").badge, "model-read");
  // Every version carries its own provenance, and only the newest is current.
  const infos = versionInfos(store([
    { version: 2, revision: "r2", createdAt: "2026-02-01T00:00:00.000Z", provider: "openai/gpt-4o", cards: 30 },
    { version: 1, revision: "r1", createdAt: "2026-01-01T00:00:00.000Z", provider: "stub/deterministic-graph-v1", cards: 18 },
  ], 2));
  assert.deepEqual(infos.map((v) => [v.version, v.badge, v.current]), [
    [2, "model-read", true],
    [1, "deterministic, not model-read", false],
  ]);
});

test("a running extraction shows its progress, and a restart-interrupted one says why it ended", () => {
  const jobs: JobView[] = [
    job({ id: "run", message: "Reading the code with the model: part 326 of about 362" }),
    job({ id: "queued", state: "QUEUED", message: "Waiting for the running job to finish" }),
    job({ id: "dead", state: "FAILED", message: "Interrupted by a restart." }),
    job({ id: "other-rev", state: "RUNNING", message: "part 1 of about 2", params: { revision: "r-old" } }),
    job({ id: "index", kind: "index", state: "RUNNING", message: "Reading the repository…" }),
  ];
  const here = conceptExtractions(jobs, "r1");
  assert.deepEqual(here.map((j) => j.id), ["run", "queued", "dead"], "only this revision's concept jobs");
  assert.equal(here[0].progress, "part 326 of about 362");
  assert.equal(here[0].detail, "Extracting concepts: part 326 of about 362");
  assert.equal(here[0].failed, false);
  assert.equal(here[1].progress, "waiting to start");
  assert.equal(here[2].interrupted, true);
  assert.equal(here[2].failed, true);
  // Without a revision filter every concept job is shown.
  assert.equal(conceptExtractions(jobs).length, 4);
});

test("the versioning note is provided as help text", () => {
  assert.match(VERSIONING_HELP, /versioned/i);
});
