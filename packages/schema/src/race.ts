import { z } from "zod";

/** Replay result classes are the C27 ladder subset that a runnable artifact may claim.
 *  NARRATIVE is deliberately absent: a replay is never prose. */
export const RACE_RESULT_CLASSES = ["MODEL_PREDICTION", "VALIDATED_MODEL_PREDICTION", "MEASURED_EXPERIMENT"] as const;
export type RaceResultClass = (typeof RACE_RESULT_CLASSES)[number];

export const RaceScenarioSchema = z.enum(["baseline", "timeout", "saturation", "retry-storm"]);
export type RaceScenario = z.infer<typeof RaceScenarioSchema>;

/** A deterministic twin run: request lifecycles across stations, sampled and bounded.
 *  Ordering is simulated-model time, not observed production timing. */
export const RaceSpecSchema = z.object({
  schemaVersion: z.literal("race.v1"),
  ordering: z.literal("simulated-model"),
  resultClass: z.enum(RACE_RESULT_CLASSES),
  runId: z.string().max(64),
  seed: z.string().max(64),
  modelSpec: z.string().max(64),
  subject: z.string().max(200),
  scenario: RaceScenarioSchema,
  params: z.object({
    arrivalRatePerSec: z.number().positive().max(1000),
    durationSec: z.number().positive().max(300),
    timeoutMs: z.number().positive().max(60000).optional(),
    faultProbability: z.number().min(0).max(1).optional(),
  }).strict(),
  stationIds: z.array(z.string().max(80)).max(12),
  requests: z.array(z.object({
    requestId: z.string().max(80),
    outcome: z.enum(["SUCCESS", "ERROR", "TIMEOUT", "CANCELLED"]),
    latencyMs: z.number().nonnegative(),
    retries: z.number().int().nonnegative(),
    spans: z.array(z.object({
      stationId: z.string().max(80),
      attempt: z.number().int().nonnegative(),
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
      waitMs: z.number().nonnegative(),
      event: z.enum(["SERVICE", "TIMEOUT", "FAULT"]),
    }).strict()).max(16),
  }).strict()).max(60),
  metrics: z.object({
    offered: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    timedOut: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    throughput: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    errorRate: z.number().min(0).max(1),
    utilisation: z.record(z.string(), z.number()),
    peakQueue: z.record(z.string(), z.number()),
  }).strict(),
  /** Findings derived deterministically from the run; each links to the claim that carries it. */
  claims: z.array(z.object({
    claimId: z.string().max(80),
    kind: z.enum(["timeout-rate", "saturation", "retry-amplification", "contention", "baseline-healthy"]),
    text: z.string().max(400),
    stationId: z.string().max(80).optional(),
  }).strict()).max(12),
  gaps: z.array(z.string().max(300)).max(12),
}).strict();
export type RaceSpec = z.infer<typeof RaceSpecSchema>;
