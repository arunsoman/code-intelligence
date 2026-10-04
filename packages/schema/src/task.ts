// F07 (task → branch → draft PR) wire types. These are additive records with no v1 predecessor in this
// repository, so there is nothing to adapt: the task tables are created by the `task-execution` migration and
// every stored row is written and read through these schemas.
//
// The shapes mirror the feature guide, with two deliberate renames kept from §5 of the guide: `baseHash` is the
// content-tree hash (`baseContentHash`) beside the `baseCommitHash` it was exported from, and `oracleHash` splits
// into the oracle hashed at base and at the candidate, because the whole point of F07-A1 is that they are two
// different runs of the same test file.
import { z } from "zod";

const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = uint.min(1);
const ids = z.array(id).max(10000);
const timestamp = z.iso.datetime();

/** One code change. A proposer returns these, never files, patches or shell commands. */
export const EditOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("REPLACE_SPAN"), file: id, baseHash: hash, start: uint, end: uint,
    expected: z.string().max(200_000), newText: z.string().max(200_000), why: z.string().min(1).max(2000),
  }).strict().refine((e) => e.end >= e.start, "span end precedes its start"),
  z.object({ op: z.literal("CREATE_FILE"), file: id, content: z.string().max(200_000), why: z.string().min(1).max(2000) }).strict(),
  z.object({ op: z.literal("DELETE_FILE"), file: id, baseHash: hash, why: z.string().min(1).max(2000) }).strict(),
]);

export const OracleRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TEST"), testId: id, file: id }).strict(),
  z.object({ kind: z.literal("SCRIPT"), handle: id, command: z.array(id).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("STACK_TRACE"), trace: z.string().min(1).max(100_000) }).strict(),
]);

export const TaskSpecSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20_000),
  kind: z.literal("FIX_DEFECT"),
  repositoryId: id,
  baseRef: z.string().min(1).max(300),
  acceptance: z.array(z.object({ id, text: z.string().min(1).max(2000), oracle: OracleRefSchema.optional() }).strict()).min(1).max(50),
  constraints: z.object({
    allowedPaths: z.array(z.string().min(1).max(400)).max(200),
    forbiddenPaths: z.array(z.string().min(1).max(400)).max(200),
    maxFilesChanged: positive.max(200),
    maxDiffLines: positive.max(200_000),
    allowNewDependencies: z.literal(false),
    /** The explicit authorisation the guide requires before an existing test file may be edited at all; absent is "no". */
    allowTestEdits: z.boolean().optional(),
  }).strict(),
  authorisedOperations: z.array(z.enum(["READ", "EDIT", "RUN_TESTS_ISOLATED", "CREATE_BRANCH", "PUBLISH_DRAFT"])).max(8),
  budgets: z.object({ modelTokens: uint.max(2_000_000), runWallMs: positive.max(3_600_000), investigationSteps: positive.max(64) }).strict(),
  linkedIssue: z.object({ repository: id.optional(), number: positive }).strict().optional(),
}).strict();

export const PatchBindingSchema = z.object({
  schemaId: z.literal("task.v1.patchBinding"),
  taskId: id,
  repositoryId: id,
  baseCommitHash: z.string().regex(/^[a-f0-9]{7,64}$/),
  baseContentHash: hash,
  candidateContentHash: hash,
  diffHash: hash,
  originalOracleHash: hash,
  candidateOracleHash: hash,
  validationPlanHash: hash,
  environmentHash: hash,
  isolation: z.enum(["LOCAL_PERMISSION_MODEL", "CONTAINER", "VM_BACKED"]),
  runManifestIds: ids,
  propertyChangeReviewId: id.nullable().optional(),
  changes: z.array(z.object({ file: id, kind: z.enum(["ADDED", "MODIFIED", "DELETED"]), added: uint, removed: uint }).strict()).max(500),
}).strict();

export const RoleRunSchema = z.object({
  role: z.enum(["BASELINE", "ORACLE_ORIGINAL_ON_CANDIDATE", "CANDIDATE_SUITE", "STATIC_CHECK", "ORACLE_PRESERVATION"]),
  mandatory: z.boolean(),
  status: z.enum(["PASSED", "FAILED", "INCOMPLETE", "INFRA_FAILED", "BUDGET_STOPPED", "CANCELLED", "NOT_APPLICABLE"]),
  passed: uint, failed: uint,
  outcomes: z.array(z.object({ name: id, state: z.enum(["PASS", "FAIL", "SKIP", "TODO", "FLAKY"]) }).strict()).max(20_000),
  output: z.string().max(20_000),
  omissions: z.array(z.string().max(500)).max(20),
}).strict();

export const TaskVerdictSchema = z.object({
  schemaId: z.literal("task.v1.verdict"),
  id,
  taskId: id,
  candidateIndex: uint,
  bindingHash: hash,
  state: z.enum(["PASSED_DEFINED_GATES", "REVIEWABLE_WITH_LIMITS", "FAILED", "INCOMPLETE", "BLOCKED"]),
  runs: z.array(RoleRunSchema).max(20),
  oracleState: z.enum(["ORIGINAL_PRESERVED", "PROPERTY_CHANGE_PENDING_REVIEW", "PROPERTY_CHANGE_REVIEWED", "NO_ORACLE"]),
  unresolved: z.array(z.string().max(1000)).max(50),
  createdBy: id,
  createdAt: timestamp,
}).strict();

export type EditOperation = z.infer<typeof EditOperationSchema>;
export type OracleRef = z.infer<typeof OracleRefSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type PatchBinding = z.infer<typeof PatchBindingSchema>;
export type RoleRun = z.infer<typeof RoleRunSchema>;
export type TaskVerdict = z.infer<typeof TaskVerdictSchema>;
