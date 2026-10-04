// F10 — a deterministic native adapter for tests and for the demo reference service.
// It applies the intervention to the twin model, generates the fixture's arrivals, simulates, and returns
// per-request outcomes. It is not a real service: it exists so the whole pipeline (pairing, generator
// checks, comparison, G4) can be exercised reproducibly. A real service implements the same interface.
import type { OutcomesRecord, RunRole } from "@cie/schema";
import { createHash } from "node:crypto";
import { generateArrivals } from "./twin-workload.ts";
import { applyIntervention } from "./twin-model.ts";
import { simulate } from "./twin-kernel.ts";
import type { NativeAdapter, NativeRunRequest, NativeRunResult } from "./twin-experiment.ts";

export interface FakeBehaviorArgs { role: RunRole; requestId: string; index: number; operation: string; latencyMs: number; outcome: OutcomesRecord["outcome"] }
export interface FakeAdapterOptions {
  /** Force the generator to saturate, so a run is rejected and counted (F10-D6/D7). */
  forceSaturation?: boolean;
  forceInstrumented?: boolean;
  generatorDelayMs?: (args: FakeBehaviorArgs) => number;
  /** Override a request's outcome or latency to engineer a candidate that drops work or a wrong structure. */
  behavior?: (args: FakeBehaviorArgs) => Partial<{ outcome: OutcomesRecord["outcome"]; latencyMs: number; correctnessPassed: boolean }>;
  maxRequests?: number;
  seedSuffix?: string;
}
export function createDeterministicNativeAdapter(options: FakeAdapterOptions = {}): NativeAdapter {
  return {
    id: "cie.twin.fake-native",
    version: "1",
    async run(request: NativeRunRequest): Promise<NativeRunResult> {
      const spec = applyIntervention(request.modelSpec, request.intervention.class, request.intervention.parameters);
      const seed = `${request.seed}${options.seedSuffix ?? ""}`;
      const generated = generateArrivals(request.workload, request.multiplier, seed, { maxRequests: options.maxRequests ?? 200_000 });
      const warmupMs = request.workload.warmupSec * 1000;
      const perRequest = simulate(spec, generated.requests, {
        seed, maxEvents: 2_000_000, maxSimTimeMs: request.workload.durationSec * 1000 * 1.5, warmupMs,
      });
      const byId = new Map(perRequest.perRequest.map((r) => [r.requestId, r]));
      const outcomes: OutcomesRecord[] = [];
      let index = 0;
      for (const arrival of generated.requests) {
        if (arrival.atMs < warmupMs) continue;
        const terminal = byId.get(arrival.requestId);
        const latency = terminal?.latencyMs ?? request.workload.durationSec * 1000;
        const base: FakeBehaviorArgs = { role: request.role, requestId: arrival.requestId, index: index++, operation: arrival.operation, latencyMs: latency, outcome: terminal?.outcome ?? "CANCELLED" };
        const override = options.behavior?.(base) ?? {};
        const generatorDelay = options.generatorDelayMs?.(base) ?? 0;
        const intendedAtMs = arrival.atMs;
        const sentAtMs = intendedAtMs + generatorDelay;
        const finalLatency = override.latencyMs ?? latency;
        outcomes.push({
          requestId: arrival.requestId, operation: arrival.operation,
          intendedAtMs, sentAtMs, completedAtMs: sentAtMs + finalLatency,
          outcome: override.outcome ?? base.outcome,
          errorClass: (override.outcome ?? base.outcome) === "TIMEOUT" ? "TIMEOUT" : (override.outcome ?? base.outcome) === "ERROR" ? "INJECTED_FAULT" : undefined,
          retryCount: terminal?.retries ?? 0,
          intendedLatencyMs: intendedAtMs + generatorDelay + finalLatency - intendedAtMs,
          observedLatencyMs: finalLatency,
          generatorDelayMs: generatorDelay,
          correctnessPassed: override.correctnessPassed ?? true,
          instrumented: options.forceInstrumented ?? false,
        });
      }
      const scheduledRatePerSec = request.multiplier * (request.workload.arrival.ratePerSec ?? generated.requests.length / Math.max(1, request.workload.durationSec));
      const achievedRatePerSec = options.forceSaturation ? scheduledRatePerSec * 0.6 : generated.requests.length / Math.max(1, request.workload.durationSec);
      return {
        outcomes, instrumented: options.forceInstrumented ?? false,
        environmentHash: hashOf(request.environment), buildHash: request.buildHash,
        workloadHash: generated.workloadHash, oracleHash: hashOf({ oracle: "twin.oracle.v1" }),
        scheduledRatePerSec, achievedRatePerSec,
      };
    },
  };
}

const hashOf = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
