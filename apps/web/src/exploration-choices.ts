import { CHART_REGISTRY, type ChartId, type ResponseManifest } from "@cie/schema";
export interface ExplorationChoice { label: string; code: string; form: string; concern: string; disabled: boolean; reason?: string }
/** Semantic navigation uses the same availability contract as response tabs. */
export function explorationChoices(kind: string, manifest?: ResponseManifest | null): ExplorationChoice[] {
  const structure: ChartId = ["class", "interface", "type", "enum"].includes(kind) ? "S16" : "S23";
  const codes: ChartId[] = [structure, "S21", "S28", "S9", "S24", "S12"];
  const choices: ExplorationChoice[] = codes.map(code => {
    const d = CHART_REGISTRY[code], status = manifest?.views.find(v => v.code === code);
    return { code, form: d.form, label: d.name, concern: d.concern.toLowerCase(), disabled: status?.status === "unavailable", reason: status?.reason };
  });
  const concurrency = manifest?.views.find(v => v.code === "V10");
  if (concurrency) choices.push({ code: "V10", form: concurrency.form, label: concurrency.label, concern: "concurrency", disabled: concurrency.status === "unavailable", reason: concurrency.reason });
  return choices;
}
