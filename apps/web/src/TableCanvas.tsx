import { useEffect, useRef } from "react";
import type { CanvasProps } from "./Canvas.tsx";
import { attachElementFisheye, LENS_DEFAULTS } from "./fisheye.ts";
import { tableCellNode } from "./table-cell.ts";
export function TableCanvas(input: CanvasProps) {
 const host=useRef<HTMLDivElement>(null),scroll=useRef<HTMLDivElement>(null);
 const table=input.rendered.table!;
 const context=input.chartId==="S26"?"Declared metric metadata · No live values · Unknown means evidence is missing":input.chartId==="S20"?"Static responsibilities and collaborators · Unknown does not mean none":"Static interpretation · Unknown means evidence is missing";
 useEffect(()=>{if(!host.current)return;const lens=attachElementFisheye(host.current,".table-cell");return ()=>lens.dispose();},[input.viewKey]);
 useEffect(()=>{if(scroll.current){scroll.current.scrollLeft=-(input.initialState?.pan.x??0);scroll.current.scrollTop=-(input.initialState?.pan.y??0);}},[input.viewKey]);
 return <div ref={host} className="typed-table chart-lens-host">
  <div className="typed-table-key"><button onClick={input.onOpenOutline}>Text outline</button><span>{context} · Click a cell for citations</span></div>
  <div ref={scroll} className="typed-table-scroll" onScroll={e=>input.onState?.({zoom:1,pan:{x:-e.currentTarget.scrollLeft,y:-e.currentTarget.scrollTop},lens:input.initialState?.lens??LENS_DEFAULTS})}>
   <table aria-label={input.caption}>
    <caption><details><summary>{input.caption.split(" · ")[0]}</summary>{input.caption}</details></caption>
    <thead><tr><th scope="col">{table.rowTitle}</th>{table.columns.map(c=><th scope="col" key={c.id}>{c.label}</th>)}</tr></thead>
    <tbody>{table.rows.map(row=><tr key={row.id} className={input.selected.has(row.nodeId)?"selected":""}>
     <th scope="row">{row.label}</th>
     {table.columns.map(column=>{const cell=row.cells.find(c=>c.columnId===column.id)??{columnId:column.id,text:"Unknown",status:"unknown" as const,evidenceIds:[]};return <td key={column.id}><button data-lens-label={cell.text} className={`table-cell ${cell.status} ${cell.status==="unknown"?"m-fog":cell.status==="conflict"?"m-hypothesis":"m-inference"}`} aria-label={`${row.label}, ${column.label}: ${cell.text}. ${cell.status}. ${cell.evidenceIds.length} citations.`} onClick={e=>{
      const n=tableCellNode(input.rendered,row,column,cell);if(!n)return;
      if(e.shiftKey||e.ctrlKey||e.metaKey)input.onSelectNodes([...new Set([...input.selected,n.id])]);else input.onTapNode(n);
     }}>{cell.text}<small>{cell.status} · {cell.evidenceIds.length} citations</small></button></td>;})}
    </tr>)}</tbody>
   </table>
   {!table.rows.length&&<p role="status">No rows with current evidence are available.</p>}
   {table.rows.length>0 && !table.columns.length && <p role="status">No columns with current evidence are available. Row declarations are shown; values remain unknown.</p>}
  </div>
 </div>;
}
