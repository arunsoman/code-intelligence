import { TableSpecSchema, type RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
export const id = "table" as const;
export default {
 id, description: "Native rule, reliability, responsibility and metric tables with cell-level evidence.",
 render(view, _level, positions, stale) {
  const parsed=TableSpecSchema.safeParse(view.table);
  const base=render(view,5,positions,stale);
  return parsed.success ? {...base,table:parsed.data} : base;
 },
 textAlternative(view) {
  const parsed=TableSpecSchema.safeParse(view.table);
  if(!parsed.success)return [view.caption,...view.nodes.map(n=>n.label),...view.gaps].join("\n");
  return [view.caption,"Static interpretations; unknown values are not negative facts.",...parsed.data.rows.map(row=>`${row.label}: ${row.cells.map(cell=>`${parsed.data.columns.find(c=>c.id===cell.columnId)?.label??cell.columnId}: ${cell.text} (${cell.status})`).join("; ")}`),...view.gaps].join("\n");
 }
} satisfies RendererModule<typeof id, Rendered>;
