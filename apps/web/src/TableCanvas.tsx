import { useEffect, useRef } from "react";
import type { CanvasProps } from "./Canvas.tsx";
import { attachElementFisheye, LENS_DEFAULTS } from "./fisheye.ts";
import { tableCellNode } from "./table-cell.ts";
export function TableCanvas(input: CanvasProps) {
 const host=useRef<HTMLDivElement>(null),scroll=useRef<HTMLDivElement>(null);
 const table=input.rendered.table!;
 useEffect(()=>{if(!host.current)return;const lens=attachElementFisheye(host.current,".table-cell");return ()=>lens.dispose();},[input.viewKey]);
 useEffect(()=>{if(scroll.current){scroll.current.scrollLeft=-(input.initialState?.pan.x??0);scroll.current.scrollTop=-(input.initialState?.pan.y??0);}},[input.viewKey]);
 return <div ref={host} className="typed-table chart-lens-host">
  <p className="typed-table-key">Static interpretation · Unknown means evidence is missing · Click a cell to inspect its citations</p>
  <div ref={scroll} className="typed-table-scroll" onScroll={e=>input.onState?.({zoom:1,pan:{x:-e.currentTarget.scrollLeft,y:-e.currentTarget.scrollTop},lens:input.initialState?.lens??LENS_DEFAULTS})}>
   <table aria-label={input.caption}>
    <caption>{input.caption}</caption>
    <thead><tr><th scope="col">{table.rowTitle}</th>{table.columns.map(c=><th scope="col" key={c.id}>{c.label}</th>)}</tr></thead>
    <tbody>{table.rows.map(row=><tr key={row.id} className={input.selected.has(row.nodeId)?"selected":""}>
     <th scope="row">{row.label}</th>
     {table.columns.map(column=>{const cell=row.cells.find(c=>c.columnId===column.id)??{columnId:column.id,text:"Unknown",status:"unknown" as const,evidenceIds:[]};return <td key={column.id}><button className={`table-cell ${cell.status} ${cell.status==="unknown"?"m-fog":"m-inference"}`} aria-label={`${row.label}, ${column.label}: ${cell.text}. ${cell.status}. ${cell.evidenceIds.length} citations.`} onClick={e=>{
      const n=tableCellNode(input.rendered,row,column,cell);if(!n)return;
      if(e.shiftKey||e.ctrlKey||e.metaKey)input.onSelectNodes([...new Set([...input.selected,n.id])]);else input.onTapNode(n);
     }}>{cell.text}<small>{cell.status} · {cell.evidenceIds.length} citations</small></button></td>;})}
    </tr>)}</tbody>
   </table>
   {!table.rows.length&&<p role="status">No rows with current evidence are available.</p>}
  </div>
 </div>;
}
