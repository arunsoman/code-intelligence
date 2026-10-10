/** Trusted build-time extensions; deterministic synchronous answer planning. */
export interface WorkflowStep<Ctx> {
  readonly id: string;
  readonly after?: readonly string[];
  readonly before?: readonly string[];
  appliesTo?(ctx: Ctx): boolean;
  run(ctx: Ctx): void;
}
