import { CHART_REGISTRY, ChartDescriptorSchema } from "@cie/schema";
import { CHART_MODULES } from "./registry.generated.ts";
// Fail at module load before serving a request, in production as well as development.
for (const [id, plugin] of Object.entries(CHART_MODULES)) {
  const descriptor = ChartDescriptorSchema.parse(plugin.descriptor);
  if (JSON.stringify(descriptor) !== JSON.stringify(ChartDescriptorSchema.parse(CHART_REGISTRY[id as keyof typeof CHART_REGISTRY]))) throw new Error(`${id}: stale plugin catalogue; run npm run plugins:generate`);
  if (descriptor.id !== id) throw new Error(`Plugin identity mismatch: ${id}`);
  if (plugin.status === "available" && typeof plugin.compile !== "function") throw new Error(`${id}: compiler missing`);
  if ((descriptor.compiler === "missing") !== (plugin.status === "unavailable")) throw new Error(`${id}: inconsistent availability`);
}
export { CHART_MODULES };
