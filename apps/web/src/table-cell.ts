import type { DisplayMode, TableSpec } from "@cie/schema";
import type { Rendered, RenderNode } from "./graph.ts";
export function tableCellDisplayMode(status: TableSpec["rows"][number]["cells"][number]["status"]): DisplayMode {
 return status==="unknown"?"FOG":status==="conflict"?"HYPOTHESIS":"INFERENCE";
}
export function tableEvidenceElements(table: TableSpec) { return table.rows.flatMap(row=>row.cells.map(cell=>({displayMode:tableCellDisplayMode(cell.status)}))); }
/** Keep selection tied to the row while inspection exposes only this cell's evidence. */
export function tableCellNode(rendered: Rendered, row: TableSpec["rows"][number], column: TableSpec["columns"][number], cell: TableSpec["rows"][number]["cells"][number]): RenderNode | undefined {
 const base=rendered.nodes.find(n=>n.id===row.nodeId);
 if(!base?.node)return undefined;
 const label=`${row.label} · ${column.label}`;
 return {...base,label,evidenceIds:cell.evidenceIds,displayMode:tableCellDisplayMode(cell.status),node:{...base.node,label,evidenceIds:cell.evidenceIds,displayMode:tableCellDisplayMode(cell.status),notes:[cell.text,`Cell status: ${cell.status}. Static interpretation; not runtime proof.`],file:"",entityRefs:[]}};
}
