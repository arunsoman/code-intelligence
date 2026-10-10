import { CHART_REGISTRY, type ChartId, type ViewSpec } from "@cie/schema";
import { RENDERERS } from "./registry.generated.ts";
for (const [id, renderer] of Object.entries(RENDERERS)) {
  if (renderer.id !== id || typeof renderer.render !== "function" || typeof renderer.textAlternative !== "function") throw new Error(`Invalid renderer contract: ${id}`);
}
export function rendererForView(view: ViewSpec) {
  return RENDERERS[CHART_REGISTRY[view.params?.chartId as ChartId]?.renderer ?? "view-spec"];
}
