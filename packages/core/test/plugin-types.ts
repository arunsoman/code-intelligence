// Type-level conformance: these errors must remain errors during npm run typecheck.
import type { ChartDescriptor, ChartModule, CompiledChart } from "@cie/schema";
import { descriptor } from "../src/plugins/charts/s28.chart.ts";
// @ts-expect-error A capability cannot silently change its registered identity.
const wrong: ChartDescriptor<"S9"> = descriptor;
// @ts-expect-error An available chart must implement compile.
const missing: ChartModule<"S28"> = { descriptor, status: "available" };
declare const sequence: CompiledChart<"S28">;
// @ts-expect-error A sequence compiler result is not an ER compiler result.
const mismatched: CompiledChart<"S9"> = sequence;
void wrong; void missing; void mismatched;
