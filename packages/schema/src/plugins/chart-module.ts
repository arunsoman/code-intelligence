import { z } from "zod";
import type { AnalysisBatch, FormId, ChartId, ChartOutputV2, ChartDiagnostics, Claim, EvidenceBundle, ModelRunRef, ViewRoute, ViewSpec } from "../index.ts";
export const CONCERNS = ["Structure", "Behavior", "Data", "State and rules", "Reliability", "Concurrency", "Quality", "Other views"] as const;
export type Concern = typeof CONCERNS[number];
export type RendererId = "view-spec" | "sequence" | "er" | "state" | "activity";
/** Declared retrieval vocabulary, not a worker coverage or proof guarantee. */
export const RETRIEVAL_KINDS = ["class", "interface", "enum", "field", "method", "function", "module", "package", "crate", "workspace", "table", "column"] as const;
export type RetrievalKind = typeof RETRIEVAL_KINDS[number];
export const ChartDescriptorSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), form: z.string().min(1), version: z.number().int().positive(),
  compiler: z.enum(["standard", "specialized", "projected", "missing"]), offline: z.enum(["derived", "gap"]),
  aliases: z.array(z.string()), requiredKinds: z.array(z.enum(RETRIEVAL_KINDS)), requiredAcrossRepository: z.array(z.enum(RETRIEVAL_KINDS)),
  concern: z.enum(CONCERNS), renderer: z.enum(["view-spec", "sequence", "er", "state", "activity"]), questionAnswered: z.string().min(1),
  description: z.string(), example: z.string(), needs: z.array(z.string()),
}).strict();
export type ChartDescriptor<K extends ChartId = ChartId> = Omit<z.infer<typeof ChartDescriptorSchema>, "id" | "form" | "aliases" | "requiredKinds" | "requiredAcrossRepository" | "needs"> & {
  readonly id: K; readonly form: FormId; readonly aliases: readonly string[]; readonly requiredKinds: readonly RetrievalKind[];
  readonly requiredAcrossRepository: readonly RetrievalKind[]; readonly needs: readonly string[];
};
/** Retrieval kinds are hints, not proof of diagram semantics or runtime behavior. */
export interface ChartCompileInput<K extends ChartId> {
  plan: ChartOutputV2 & { chartId: K }; bundle: EvidenceBundle;
  rev: { id: string; repoRoot: string; gitHead: string | null; createdAt: string; analyzerVersion: string; diagnostics: AnalysisBatch["diagnostics"]; fileCount: number };
  question: string; route: ViewRoute; chartId?: K; run?: ModelRunRef;
  diag?: { provider?: string; model?: string; cacheHit: boolean; schemaValidationPassed: boolean; fallbackReason?: string };
}
export interface CompiledChart<K extends ChartId> {
  view: ViewSpec & { params: Record<string, string | number | boolean> & { chartId: K } };
  claims: Claim[]; diagnostics: ChartDiagnostics;
}
export type ChartModule<K extends ChartId = ChartId> = {
  readonly descriptor: ChartDescriptor<K>;
} & ({ readonly status: "available"; compile(input: ChartCompileInput<K>): CompiledChart<K> }
  | { readonly status: "unavailable"; readonly reason: string; compile?: never });
export interface RendererModule<R extends RendererId, Geometry> {
  readonly id: R; readonly description: string;
  render(view: ViewSpec, level: number, positions: Map<string, { x: number; y: number }>, stale: Set<string>): Geometry;
  textAlternative(view: ViewSpec): string;
}
