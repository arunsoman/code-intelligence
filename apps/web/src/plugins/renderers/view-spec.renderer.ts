import type { RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
export const id = "view-spec" as const;
export default {
  id, description: "Existing graph geometry, with matrix and terrain surfaces retained by the workspace.",
  render,
  textAlternative(view) {
    return [view.caption, ...view.nodes.map((n) => n.label), ...view.edges.map((e) => `${e.fromNodeId} ${e.label ?? e.kind} ${e.toNodeId}`), ...view.gaps].join("\n");
  },
} satisfies RendererModule<typeof id, Rendered>;
