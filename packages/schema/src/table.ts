import { z } from "zod";
export const TableSpecSchema = z.object({
 schemaVersion: z.literal("table.v1"), basis: z.literal("interpreted-static"), rowTitle: z.string(),
 columns: z.array(z.object({ id: z.string(), label: z.string() }).strict()).max(42),
 rows: z.array(z.object({ id: z.string(), nodeId: z.string(), label: z.string(),
  cells: z.array(z.object({ columnId: z.string(), text: z.string(), status: z.enum(["interpreted", "unknown", "conflict"]), evidenceIds: z.array(z.string()) }).strict()).max(42)
 }).strict()).max(100)
}).strict().superRefine((table,ctx)=>{
 const columns=new Set(table.columns.map(c=>c.id));
 if(columns.size!==table.columns.length)ctx.addIssue({code:"custom",message:"Duplicate table column IDs"});
 if(new Set(table.rows.map(r=>r.id)).size!==table.rows.length || new Set(table.rows.map(r=>r.nodeId)).size!==table.rows.length)ctx.addIssue({code:"custom",message:"Duplicate table row identities"});
 for(const row of table.rows){
  if(row.cells.length!==columns.size || new Set(row.cells.map(c=>c.columnId)).size!==columns.size)ctx.addIssue({code:"custom",message:"Each row must supply exactly one cell per column"});
  for(const cell of row.cells){
   if(!columns.has(cell.columnId))ctx.addIssue({code:"custom",message:"Cell references an unknown column"});
   if(cell.status==="unknown" ? cell.evidenceIds.length>0 : cell.evidenceIds.length===0)ctx.addIssue({code:"custom",message:"Known cells require citations; unknown cells must not borrow evidence"});
  }
 }
});
export type TableSpec = z.infer<typeof TableSpecSchema>;
