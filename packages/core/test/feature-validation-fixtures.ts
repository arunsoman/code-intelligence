import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { contentRoot, entriesFromDirectory, rawHash } from "../src/feature/canon.ts";
import { record } from "./feature-fixtures.ts";
import type { CandidateRecord, FeatureContract, RunRequest, RunResult, Runner } from "../src/feature/types.ts";
import type { ValidationPlan, ValidationCheck } from "../src/feature/validation.ts";
export class ValidationRunner implements Runner {
  readonly isolation = "CONTAINER" as const; readonly omissions: string[] = []; calls: RunRequest[] = [];
  response: (req: RunRequest) => Partial<RunResult> = () => ({});
  async run(req: RunRequest): Promise<RunResult> { this.calls.push(req); return { status: "PASSED", exitCode: 0, stdout: "✔ accepts current tenant (1ms)\nℹ tests 1\n", stderr: "", truncated: false, isolation: this.isolation, omissions: [], usage: { wallMs: 1 }, ...this.response(req) }; }
}
export function validationFixture() {
  const root = mkdtempSync(join(tmpdir(), "pf-validation-fixture-")); mkdirSync(join(root, "src")); writeFileSync(join(root, "src/app.ts"), "export const version = 1;\n");
  const before = contentRoot(entriesFromDirectory(root, { exclude: [] }));
  writeFileSync(join(root, "src/app.ts"), "export const version = 2;\n"); const after = contentRoot(entriesFromDirectory(root, { exclude: [] })); writeFileSync(join(root, "src/app.ts"), "export const version = 1;\n");
  const store = new Store(":memory:"), fs = new SqliteFeatureStore(store); const rec = record({ requestId: "req:validation", repositoryId: root, state: "IMPLEMENTING", mode: "BUILD_PREVIEW", contractVersion: 1 });
  const contract: FeatureContract = { schemaVersion: 1, id: "contract:req:validation", version: 1, hash: "contract-hash", requestId: rec.requestId, snapshot: rec.source, authorityPolicyHash: "authority", assumptions: [], obligationIds: [],
    requirements: [{ id: "r1", text: "Only current tenant data", source: { artifactId: "prompt", version: "1", locator: "prompt", contentHash: "prompt-hash" }, origin: "USER", type: "ACCESS", status: "ACTIVE", actorIds: ["member"], conditions: [], dependsOn: [], acceptanceIds: ["a1"] }],
    acceptance: [{ id: "a1", requirementIds: ["r1"], scenario: "Export transactions", expectedOutcome: "Only current tenant rows", mandatory: true, oracleOrigin: "EXISTING_TEST", oracleSourceRefs: [{ artifactId: "test", version: "1", locator: "repo:tests/export.test.ts", contentHash: "oracle" }], validationKinds: ["UNIT"] }] };
  const candidate: CandidateRecord = { schemaVersion: 1, id: "candidate-1", requestId: rec.requestId, ordinal: 1, status: "MATERIALIZED", createdAt: rec.createdAt, invocationIds: [], bindingHash: "binding-1", oracleState: "ORIGINAL_PRESERVED", contents: { "src/app.ts": "export const version = 2;\n" }, baseContents: { "src/app.ts": "export const version = 1;\n" },
    mutations: [{ kind: "MODIFIED", oldPath: "src/app.ts", newPath: "src/app.ts", beforeHash: rawHash("export const version = 1;\n"), afterHash: rawHash("export const version = 2;\n"), requirementIds: ["r1"], taskIds: ["t1"], actionIds: ["action-1"], attribution: "COMPLETE" }],
    binding: { repositoryId: root, baseCommitHash: "base-commit", baseContentHash: before, candidateContentHash: after, diffHash: "diff", contractHash: contract.hash, originalOracleHash: "oracle", candidateOracleHash: "oracle", runManifestIds: [], mutationInventoryHash: "inventory", generationProvenanceHash: "provenance" } };
  const check = (id: string, kind: ValidationCheck["kind"], phase: ValidationCheck["phase"], target = "."): ValidationCheck => ({ id, kind, phase, target, acceptanceIds: kind === "UNIT" ? ["a1"] : [], mandatory: true, argv: ["node", `${id}.js`], fullSuiteArgv: ["node", "all-tests.js"], expectedTests: kind === "UNIT" ? ["accepts current tenant"] : [], report: kind === "UNIT" ? "NODE_TEST" : "EXIT", applicability: "APPLICABLE", baseline: phase === "BUILD" || phase === "REGRESSION" });
  const plan: ValidationPlan = { schemaVersion: 1, contractHash: contract.hash, targets: ["backend", "frontend"], checks: [check("backend", "BUILD", "BUILD", "backend"), check("frontend", "BUILD", "BUILD", "frontend"), check("security", "SECURITY", "STATIC_SECURITY"), check("dependency", "DEPENDENCY", "STATIC_SECURITY"), check("operations", "OPERATIONAL", "STATIC_SECURITY"), check("tests", "UNIT", "REGRESSION")], coverageKnown: true, environment: { hash: "environment", fidelity: "REPRESENTATIVE", configHash: "config", migrationHash: "migration", dependencies: "AVAILABLE" }, testData: { kind: "SYNTHETIC", fixtureHash: "fixture", generatorHash: "generator", seed: "7" }, workloadHash: "workload", toolchainHash: "toolchain", performanceApplicable: false };
  const request = { ...rec, contract, validationPlan: plan, tasks: [{ id: "t1", componentId: "C28", requirementIds: ["r1"], dependencyTaskIds: [], obligationIds: [], plannedEdits: ["src/app.ts"], capabilityIds: [], state: "COMPLETE" as const, evidenceIds: [] }], workspace: { ...rec.workspace, candidateHash: candidate.bindingHash, contractHash: contract.hash } };
  fs.createRequest(request, { schemaVersion: 1, eventId: "event:submitted", requestId: request.requestId, type: "FeatureSubmitted", actor: "u", producer: "C02", requirementIds: [], decisionIds: [], result: "OK", rationale: "test fixture", at: rec.createdAt }, "fixture"); fs.putCandidate(candidate);
  return { root, store, fs, request, candidate, plan, runner: new ValidationRunner(), close: () => { store.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
