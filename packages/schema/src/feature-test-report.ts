import { z } from "zod";

/** Local results are diagnostic input, never trusted execution evidence. Commands are labels, not executable instructions. */
export const FeatureTestReportSchema = z.object({
  format: z.literal("feature-test-report.v1"),
  requestId: z.string().min(1).max(200), candidateHash: z.string().min(1).max(200), baseRevision: z.string().min(1).max(200),
  command: z.string().min(1).max(1000), environment: z.string().min(1).max(1000),
  exitCode: z.number().int().min(0).max(255),
  failures: z.array(z.object({ name: z.string().min(1).max(500), message: z.string().min(1).max(8000) }).strict()).max(100),
  output: z.string().max(32000).default(""),
}).strict().superRefine((v, c) => {
  if (v.exitCode === 0 && v.failures.length) c.addIssue({ code: "custom", message: "A report with failures must have a nonzero exit code" });
});
export type FeatureTestReport = z.infer<typeof FeatureTestReportSchema>;
