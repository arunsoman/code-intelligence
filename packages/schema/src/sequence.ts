import { z } from "zod";
export const SequenceSpecSchema = z.object({
  schemaVersion: z.literal("sequence.v1"), ordering: z.literal("inferred-static"),
  participantIds: z.array(z.string()).max(20),
  messages: z.array(z.object({ edgeId: z.string(), order: z.number().int().positive(), kind: z.enum(["sync", "async", "return", "self"]), fragmentId: z.string().optional() }).strict()).max(120),
  fragments: z.array(z.object({ id: z.string(), kind: z.enum(["alt", "opt", "loop", "exception", "par"]), condition: z.string().optional(), evidenceIds: z.array(z.string()) }).strict()).max(20),
}).strict();
export type SequenceSpec = z.infer<typeof SequenceSpecSchema>;
