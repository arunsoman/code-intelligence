import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcceptanceCriterion } from "../src/feature/types.ts";
import { boot, createEdit } from "./feature-boot.ts";

const crit = (id: string): AcceptanceCriterion => ({ id, requirementIds: ["r1"], scenario: "s", expectedOutcome: `generated ${id}`, mandatory: true, oracleSourceRefs: [], oracleOrigin: "GENERATED_UNREVIEWED", validationKinds: ["UNIT"] });

test("S6 confirming generated outcomes is a recorded decision that makes them a reviewed oracle, versions the contract and stales the candidate", async () => {
  const w = await boot({ acceptance: [crit("A1"), crit("A2")], edits: () => [createEdit("src/a.ts", "export {};\n")] });
  try {
    const call = (b: Record<string, unknown>, key = "k1", who = "arun") => w.h["C15/confirmAcceptance"](w.as(who, key), { contractId: `contract:${w.rid}`, expectedVersion: 0, rationale: "these are right", criteria: [{ id: "A1" }, { id: "A2", expectedOutcome: "my own example" }], ...b });
    const before = w.fs.getRequest(w.rid)!.contract!.hash;
    const r = call({}); assert.equal(r.ok, true, JSON.stringify(r.error)); const c = r.value.value;
    assert.equal(c.version, 1); assert.notEqual(c.hash, before);
    assert.deepEqual(c.acceptance.map((a: any) => [a.id, a.oracleOrigin, a.expectedOutcome]), [["A1", "USER_EXAMPLE", "generated A1"], ["A2", "USER_EXAMPLE", "my own example"]]);
    assert.ok(c.acceptance[0].oracleSourceRefs[0].locator.startsWith("decision:"));
    assert.equal(w.fs.listCandidates(w.rid)[0]!.status, "STALE"); assert.match(r.value.diagnostics[0], /is stale/);
    const d = w.fs.listDecisions(w.rid).find((x) => x.questionId === "confirm-acceptance")!; assert.equal(d.kind, "DISPOSITION"); assert.deepEqual(d.affectedIds, ["A1", "A2"]); assert.equal(d.rationale, "these are right");
    assert.equal(call({ expectedVersion: 1 }, "k1").value.diagnostics[0], "already confirmed"); // the same key is a replay, not a second version
    assert.equal(w.fs.getRequest(w.rid)!.contractVersion, 1);
    // refusals
    assert.equal(call({}, "k2").error.code, "VERSION_CONFLICT"); assert.equal(call({ expectedVersion: 1, criteria: [{ id: "A9" }] }, "k3").error.code, "NOT_FOUND");
    assert.equal(call({ expectedVersion: 1, criteria: [] }, "k4").error.code, "INVALID_SCHEMA"); assert.equal(call({ expectedVersion: 1, rationale: " " }, "k5").error.code, "INVALID_SCHEMA");
    assert.equal(call({ expectedVersion: 1, criteria: [{ id: "A1" }, { id: "A1" }] }, "k6").error.code, "INVALID_SCHEMA"); assert.equal(call({ expectedVersion: 1, criteria: [{ id: "A1", expectedOutcome: "  " }] }, "k7").error.code, "INVALID_SCHEMA");
    assert.equal(call({ expectedVersion: 1 }, "k8", "mallory").error.code, "NOT_FOUND");
  } finally { w.close(); }
});
