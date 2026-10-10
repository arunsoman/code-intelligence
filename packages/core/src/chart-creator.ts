// Compatibility facade: existing callers retain their API; typed v2 dispatch is generated.
export * from "./chart-compilers.ts";
import { ChartOutputV2, type ChartId, type ChartModule, type ChartCompileInput } from "@cie/schema";
import { compileLegacyChartPlan } from "./chart-compilers.ts";
import { CHART_MODULES } from "./plugins/charts/index.ts";
const modules: { [K in ChartId]: ChartModule<K> } = CHART_MODULES;
function compileRegistered<K extends ChartId>(id: K, input: ChartCompileInput<K>) {
  const plugin = modules[id];
  if (plugin.status === "unavailable") throw new Error(`${id}: ${plugin.reason}`);
  return plugin.compile(input);
}
export function compileChartPlan(o: Parameters<typeof compileLegacyChartPlan>[0]): ReturnType<typeof compileLegacyChartPlan> {
  if (o.chartId) {
    if (!(o.chartId in modules)) throw new Error(`No compiler registered for selected chart ${o.chartId}`);
    const requested = modules[o.chartId as ChartId];
    if (requested.status === "unavailable") throw new Error(`${o.chartId}: ${requested.reason}`);
  }
  if (!("contractVersion" in o.plan) || o.plan.contractVersion !== "chart.v2") return compileLegacyChartPlan(o);
  const plan = ChartOutputV2.parse(o.plan);
  const id = o.chartId ?? plan.chartId;
  if (!(id in modules)) throw new Error(`No compiler registered for selected chart ${id}`);
  if (id !== plan.chartId) throw new Error(`Requested ${id}, but received a ${plan.chartId} plan`);
  const result = compileRegistered(plan.chartId, { ...o, chartId: plan.chartId, plan });
  const descriptor = modules[plan.chartId].descriptor;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (![descriptor.name, ...descriptor.aliases].some(alias => normalize(alias) === normalize(plan.chartType))) {
    const warning = `Model chart type "${plan.chartType}" disagrees with selected ${descriptor.name}; the selected typed contract was used.`;
    result.view.gaps.push(warning);
    if (result.diagnostics.gaps !== result.view.gaps) result.diagnostics.gaps.push(warning);
  }
  return result;
}
