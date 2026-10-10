import { z } from "zod";
export const ErSpecSchema = z.object({
  schemaVersion: z.literal("er.v1"),
  tables: z.array(z.object({ nodeId: z.string(), columns: z.array(z.object({
    name: z.string(), type: z.string().optional(), isPrimaryKey: z.boolean().optional(), isForeignKey: z.boolean().optional(), references: z.string().optional(), isNullable: z.boolean().optional(), isUnique: z.boolean().optional(), evidenceIds: z.array(z.string()),
  }).strict()).max(60) }).strict()).max(40),
  relationships: z.array(z.object({ edgeId: z.string(), cardinality: z.enum(["1:1","1:N","N:M"]), cardinalityBasis: z.literal("plan-inferred"), fkColumn: z.string().optional(), reason: z.string().optional() }).strict()).max(80),
}).strict();
export type ErSpec = z.infer<typeof ErSpecSchema>;
export function erColumnLabel(c: ErSpec["tables"][number]["columns"][number]): string {
  return [c.name, c.type ? `: ${c.type}` : "", c.isPrimaryKey ? "PK?" : "", c.isForeignKey ? `FK? → ${c.references ?? "unknown"}` : "", c.isUnique ? "UNIQUE?" : "", c.isNullable === true ? "NULL?" : c.isNullable === false ? "NOT NULL?" : ""].filter(Boolean).join(" ");
}
