import { z } from "zod";
export const StateSpecSchema = z.object({
  schemaVersion: z.literal("state.v1"),
  states: z.array(z.object({ nodeId: z.string(), initial: z.boolean(), final: z.boolean() }).strict()).max(60),
  transitions: z.array(z.object({ edgeId: z.string(), trigger: z.string(), guard: z.string().optional(), forbidden: z.boolean(), replay: z.boolean(), basis: z.literal("plan-inferred") }).strict()).max(120),
}).strict();
export type StateSpec = z.infer<typeof StateSpecSchema>;
export function stateTransitionLabel(t: StateSpec["transitions"][number]): string {
  return [t.forbidden ? "FORBIDDEN?" : "", t.replay ? "REPLAY?" : "", t.trigger, t.guard ? `[${t.guard}]` : ""].filter(Boolean).join(" ");
}
