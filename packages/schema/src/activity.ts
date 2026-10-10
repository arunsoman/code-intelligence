import { z } from "zod";
export const ActivitySpecSchema = z.object({
 schemaVersion: z.literal("activity.v1"), basis: z.literal("inferred-static"),
 steps: z.array(z.object({ nodeId: z.string(), shape: z.enum(["process","decision","event","state","external"]), lane: z.string().optional() }).strict()).max(40),
 links: z.array(z.object({ edgeId: z.string(), relationshipKind: z.string(), annotation: z.string().optional() }).strict()).max(80),
}).strict();
export type ActivitySpec = z.infer<typeof ActivitySpecSchema>;
