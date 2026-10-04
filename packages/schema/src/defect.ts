import { z } from "zod";

const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = uint.min(1);
const ids = z.array(id).max(10000);
const strings = z.array(z.string().max(4000)).max(10000);
const timestamp = z.iso.datetime();
export const RegisteredValueSchema = z.object({ schemaId: id, schemaVersion: positive, value: z.json() }).strict();
export const ExperimentKindSchema = z.enum(["SCHEDULE_SEARCH", "RACE_INSTRUMENTATION", "STRESS", "REPLAY", "PROFILE", "BENCHMARK", "SYSTEM_FAULT_TEST"]);
export const RunStatusSchema = z.enum(["SUCCEEDED", "PROPERTY_FAILED", "INCONCLUSIVE", "INFRA_FAILED", "CANCELLED", "BUDGET_STOPPED"]);
export const ExperimentBudgetSchema = z.object({ wallTimeMs: positive.max(3600000), cpuTimeMs: positive, memoryBytes: positive, processes: positive.max(1024), readBytes: positive, outputBytes: positive.max(67108864), cost: z.string().regex(/^\d+(\.\d+)?$/) }).strict();
export const AdapterCapabilitySchema = z.object({
  id, version: id, languageIds: ids, platformIds: ids, classes: z.array(ExperimentKindSchema), schemas: ids,
  supportsReplay: z.boolean(), modelsWeakMemory: z.boolean(), maximumBounds: RegisteredValueSchema, knownExclusions: strings,
}).strict();
export const ExperimentSpecSchema = z.object({
  id, findingId: id, baselineRevision: id, candidateHead: hash.nullable(), adapterId: id, adapterVersion: id,
  kind: ExperimentKindSchema, harnessHandle: id, harnessHash: hash, oracleSchemaId: id,
  fixtureHandles: ids, fixtureHashes: z.array(hash), inputs: RegisteredValueSchema, bounds: RegisteredValueSchema,
  budget: ExperimentBudgetSchema, environmentProfileId: id, executionGrantId: id,
}).strict().refine((s) => s.fixtureHandles.length === s.fixtureHashes.length, "fixture handles and hashes must correspond");
export const RunManifestSchema = z.object({
  id, specId: id, specHash: hash, sourceHash: hash, buildHash: hash, adapterVersion: id, environmentHash: hash,
  oracleHash: hash, fixtureHashes: z.array(hash), seed: z.string().nullable(), scheduleHandle: id.nullable(),
  startedAt: timestamp, finishedAt: timestamp, status: RunStatusSchema, evidenceIds: ids, omissions: strings,
}).strict().refine((s) => s.finishedAt >= s.startedAt, "run timestamps are reversed");
export const NumericIntervalSchema = z.object({ lower: z.number().finite(), upper: z.number().finite(), method: id, confidenceLevel: z.number().gt(0).lt(1) }).strict().refine((x) => x.lower <= x.upper);
export const BenchmarkComparisonSchema = z.object({
  id, baselineRunIds: ids.min(1), candidateRunIds: ids.min(1), workloadHash: hash, environmentHash: hash,
  primaryMetric: id, rawSampleHandle: id, effectEstimate: z.number().finite(), uncertaintyInterval: NumericIntervalSchema.nullable(),
  verdict: z.enum(["IMPROVED", "REGRESSED", "NO_MATERIAL_CHANGE", "INCONCLUSIVE"]), regressions: strings, limitations: strings,
}).strict();
export const PatchValidationSchema = z.object({
  id, proposalId: id, baseHash: hash, headHash: hash, diffHash: hash, harnessHash: hash, oracleHash: hash,
  runManifestIds: ids, benchmarkComparisonIds: ids, obligationIds: ids,
  state: z.enum(["PENDING", "FAILED", "REVIEWABLE_WITH_LIMITS", "PASSED_DEFINED_GATES"]), unresolved: strings,
}).strict();
export const PrPublicationSchema = z.object({
  id, repository: id, baseBranch: id, baseHash: hash, headBranch: id, headHash: hash, proposalId: id,
  validationId: id, authorizationId: id, status: z.enum(["PREPARED", "PUBLISHING", "PUBLISHED", "FAILED", "CONFLICT"]),
  prNumber: positive.nullable(), prUrl: z.url().nullable(),
}).strict();
const span = z.object({ sourceId: id, contentHash: id, revision: id, startByte: uint, endByteExclusive: uint }).strict().refine((s) => s.endByteExclusive >= s.startByte);
const common = { id, entityId: id, evidenceIds: ids.min(1), span: span.optional() };
export const LockOrderFactSchema = z.object({ ...common,
  heldLockId: id, acquiredLockId: id, acquireKind: z.enum(["BLOCKING", "TRY", "REENTRANT"]),
  pathCondition: z.string().max(4000).optional(), globalGuardId: id.optional(), resolution: z.enum(["PARSED", "RESOLVED", "OBSERVED", "UNRESOLVED"]),
}).strict();
export const MemoryAccessFactSchema = z.object({ ...common,
  accessPath: id, mode: z.enum(["READ", "WRITE"]), atomic: z.boolean(), contextId: id,
  concurrentWith: ids, happensBefore: ids, aliasState: z.enum(["RESOLVED", "MAY_ALIAS", "UNKNOWN"]).optional(),
}).strict();
export const DefectDetectionInputSchema = z.object({
  revision: id, lockOrders: z.array(LockOrderFactSchema).max(10000).optional(), memoryAccesses: z.array(MemoryAccessFactSchema).max(2000).optional(),
  budget: z.object({ maxFacts: positive.max(10000).optional(), maxFindings: positive.max(1000).optional() }).strict().optional(),
}).strict().refine((r) => {
  const facts = [...(r.lockOrders ?? []), ...(r.memoryAccesses ?? [])];
  return new Set(facts.map((f) => f.id)).size === facts.length;
}, "fact IDs must be unique");
export const DEFECT_SCHEMAS = {
  "defect.v1.registeredValue": RegisteredValueSchema,
  "defect.v1.adapterCapability": AdapterCapabilitySchema,
  "defect.v1.experimentSpec": ExperimentSpecSchema,
  "defect.v1.runManifest": RunManifestSchema,
  "defect.v1.benchmarkComparison": BenchmarkComparisonSchema,
  "defect.v1.patchValidation": PatchValidationSchema,
  "defect.v1.prPublication": PrPublicationSchema,
  "defect.v1.detectionInput": DefectDetectionInputSchema,
} as const;
export type RegisteredValue = z.infer<typeof RegisteredValueSchema>;
export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;
export type ExperimentSpec = z.infer<typeof ExperimentSpecSchema>;
export type ExperimentBudget = z.infer<typeof ExperimentBudgetSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ExperimentKind = z.infer<typeof ExperimentKindSchema>;
export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;
export type NumericInterval = z.infer<typeof NumericIntervalSchema>;
export type PatchValidation = z.infer<typeof PatchValidationSchema>;
export type PrPublication = z.infer<typeof PrPublicationSchema>;
