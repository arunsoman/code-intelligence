import { z } from "zod";

export const QUERY_SECTIONS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type QuerySection = typeof QUERY_SECTIONS[number];

export interface QueryIntent {
  id: number;
  intent: string;
  section: QuerySection;
  query: string;
  primaryChartIds: string[];
  zoomInLeadsTo: number[];
  subject: "none" | "repo" | "moduleOrService" | "dataModelOf" | "action" | "flow" | "method" | "entity" | "classOrMethod" | "item";
}

export const QUERY_INTENTS: Record<number, QueryIntent> = {
  1: { id: 1, intent: "Understand the overall purpose and scope of the system", section: "A", query: "What does this system do?", primaryChartIds: ["S27"], zoomInLeadsTo: [2, 3], subject: "repo" },
  2: { id: 2, intent: "Grasp the major building blocks and how they fit together", section: "A", query: "Show me the high-level architecture", primaryChartIds: ["S1", "S22"], zoomInLeadsTo: [4, 5, 8], subject: "repo" },
  3: { id: 3, intent: "Learn the package/folder layout and logical grouping", section: "A", query: "How is the code organized?", primaryChartIds: ["S17"], zoomInLeadsTo: [4, 5], subject: "repo" },
  4: { id: 4, intent: "See inter-module coupling and dependency direction", section: "A", query: "Show me the module dependencies", primaryChartIds: ["S23"], zoomInLeadsTo: [5, 23], subject: "repo" },
  5: { id: 5, intent: "Dive deeper into one specific part of the architecture", section: "A", query: "Tell me more about the [X] module", primaryChartIds: ["S16", "S1"], zoomInLeadsTo: [23, 10, 14], subject: "moduleOrService" },
  6: { id: 6, intent: "Locate the starting point of execution", section: "A", query: "Where does the application start?", primaryChartIds: ["S21"], zoomInLeadsTo: [14, 15], subject: "repo" },
  7: { id: 7, intent: "Understand the persistent data model", section: "B", query: "Show me the database schema", primaryChartIds: ["S9", "S4"], zoomInLeadsTo: [8, 19], subject: "repo" },
  8: { id: 8, intent: "Trace how information moves from input to storage/output", section: "B", query: "How does data flow for [X]?", primaryChartIds: ["S10", "V5"], zoomInLeadsTo: [14, 15], subject: "action" },
  9: { id: 9, intent: "Examine the data structures owned by a specific component", section: "B", query: "What data does [X] manage?", primaryChartIds: ["S9"], zoomInLeadsTo: [19, 20], subject: "dataModelOf" },
  10: { id: 10, intent: "Understand the end-to-end business process", section: "C", query: "How does [X] work from end-to-end?", primaryChartIds: ["S2", "S2", "V4"], zoomInLeadsTo: [11, 12, 16, 17], subject: "action" },
  11: { id: 11, intent: "See the exact order of interactions between components", section: "C", query: "Show me the sequence for [X]", primaryChartIds: ["S28", "S18"], zoomInLeadsTo: [14, 15], subject: "flow" },
  12: { id: 12, intent: "Explore all branches and decision points inside a method", section: "C", query: "What are the logic paths in [X]?", primaryChartIds: ["S2"], zoomInLeadsTo: [16, 17], subject: "method" },
  13: { id: 13, intent: "Identify the main interactions the system offers to actors", section: "C", query: "What are the main use cases?", primaryChartIds: ["S6"], zoomInLeadsTo: [10], subject: "repo" },
  14: { id: 14, intent: "Go deeper into a specific piece of behavior", section: "C", query: "Explain how [X] is implemented", primaryChartIds: ["S21", "S2"], zoomInLeadsTo: [12, 15, 16], subject: "method" },
  15: { id: 15, intent: "Get a detailed, sequential explanation of implementation", section: "C", query: "Step through the logic of [X]", primaryChartIds: ["S2"], zoomInLeadsTo: [16, 17], subject: "method" },
  16: { id: 16, intent: "Understand the lifecycle and valid transitions of an entity", section: "D", query: "What are the states of [X]?", primaryChartIds: ["S24", "S3"], zoomInLeadsTo: [17, 18], subject: "entity" },
  17: { id: 17, intent: "Discover the business rules and guard conditions", section: "D", query: "What rules govern [X]?", primaryChartIds: ["S11"], zoomInLeadsTo: [18, 22], subject: "flow" },
  18: { id: 18, intent: "Examine the exact conditions that control branching", section: "D", query: "Why does [X] branch here?", primaryChartIds: ["S11", "S29"], zoomInLeadsTo: [22], subject: "flow" },
  19: { id: 19, intent: "Assess concurrency safety and protective mechanisms", section: "E", query: "Is [X] thread-safe?", primaryChartIds: ["V10"], zoomInLeadsTo: [20, 21], subject: "repo" },
  20: { id: 20, intent: "Verify safe retry behavior and duplicate handling", section: "E", query: "How are retries handled for [X]?", primaryChartIds: ["S14"], zoomInLeadsTo: [21], subject: "repo" },
  21: { id: 21, intent: "Understand failure handling and rollback strategies", section: "E", query: "What happens if [X] fails?", primaryChartIds: ["S12", "S25"], zoomInLeadsTo: [22], subject: "repo" },
  22: { id: 22, intent: "Dive into the exact recovery or rollback sequence", section: "E", query: "Show me the rollback flow for [X]", primaryChartIds: ["S12", "S2"], zoomInLeadsTo: [20, 21], subject: "flow" },
  23: { id: 23, intent: "Reveal the internal call structure and collaborators", section: "F", query: "What does [X] call?", primaryChartIds: ["S21"], zoomInLeadsTo: [14, 15], subject: "repo" },
  24: { id: 24, intent: "Understand responsibilities and dependencies of a class", section: "F", query: "What is the role of [X]?", primaryChartIds: ["S20"], zoomInLeadsTo: [23, 25], subject: "classOrMethod" },
  25: { id: 25, intent: "See how components are assembled and injected", section: "F", query: "How is [X] wired up?", primaryChartIds: ["S15"], zoomInLeadsTo: [4, 23], subject: "repo" },
  26: { id: 26, intent: "Inspect the actual source and low-level logic", section: "F", query: "Show me the code for [X]", primaryChartIds: ["S16", "S29"], zoomInLeadsTo: [15, 17], subject: "classOrMethod" },
  27: { id: 27, intent: "Map tests to important behaviors and guarantees", section: "G", query: "How is [X] tested?", primaryChartIds: ["S5", "V12"], zoomInLeadsTo: [10, 19], subject: "repo" },
  28: { id: 28, intent: "Know which runtime signals indicate health or problems", section: "G", query: "What metrics track [X]?", primaryChartIds: ["S26"], zoomInLeadsTo: [], subject: "repo" },
  29: { id: 29, intent: "Identify expensive operations for optimization", section: "G", query: "Where are the bottlenecks in [X]?", primaryChartIds: ["V17"], zoomInLeadsTo: [14, 15], subject: "repo" },
  30: { id: 30, intent: "Understand trust zones and potential attack surfaces", section: "G", query: "What are the security boundaries for [X]?", primaryChartIds: ["V8", "S10"], zoomInLeadsTo: [2, 8], subject: "repo" },
  31: { id: 31, intent: "Go one level deeper into a specific element", section: "H", query: "Zoom into [X]", primaryChartIds: [], zoomInLeadsTo: [5, 9, 14, 18, 22, 26], subject: "item" },
  32: { id: 32, intent: "Return to the previous higher-level context", section: "H", query: "Go back", primaryChartIds: [], zoomInLeadsTo: [], subject: "none" },
  33: { id: 33, intent: "Reset to the top-level architecture", section: "H", query: "Show me the overall system again", primaryChartIds: ["S27", "S1", "S17"], zoomInLeadsTo: [], subject: "repo" },
  34: { id: 34, intent: "Explore a related concern of the current item (data / state / concurrency / failure)", section: "H", query: "Show me the [concern] of [X]", primaryChartIds: [], zoomInLeadsTo: [7, 8, 9, 16, 17, 18, 19, 20, 21, 22], subject: "item" },
};

export const MAX_INTENT_ID = 34;
export const intentById = (id: number): QueryIntent => {
  const q = QUERY_INTENTS[id];
  if (!q) throw new Error(`unknown intent ${id}`);
  return q;
};
export const chartForIntent = (id: number): string | undefined =>
  [...new Set(intentById(id).primaryChartIds.filter((c) => c.startsWith("S")))][0];
export const formForIntent = (id: number): string | undefined =>
  intentById(id).primaryChartIds.find((c) => c.startsWith("V"));

export const INTENT_CLASSIFIER_SCHEMA = z.union([
  z.object({
    intent_id: z.number().int().min(1).max(34),
    intent: z.string(),
    confidence: z.number().min(0).max(1),
    target: z.string().max(300).optional(),
  }).strict(),
  z.object({
    intent_id: z.literal("new_intent"),
    intent: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(300),
    target: z.string().max(300).optional(),
  }).strict(),
]);

export type IntentClassification = z.infer<typeof INTENT_CLASSIFIER_SCHEMA>;
export const INTENT_CONFIDENCE_THRESHOLD = 0.75;

export const ReferentRecordSchema = z.object({
  entityId: z.string().min(1),
  label: z.string().min(1).max(300),
  kind: z.string().min(1).max(80),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  turnSeq: z.number().int().nonnegative(),
  rev: z.string().min(1).max(200),
  source: z.enum(["selection", "focus", "view-render", "answer-cite", "breadcrumb"]),
}).strict();
export type ReferentRecord = z.infer<typeof ReferentRecordSchema>;

export const ReferentLedgerV1 = z.object({
  v: z.literal(1),
  referents: z.array(ReferentRecordSchema).max(12),
}).strict();

export interface BreadcrumbFrame {
  referent: ReferentRecord;
  intentId: number;
  chartCode: string;
  question: string;
  viewId: string;
}

export interface Choice {
  key: "A" | "B" | "C" | "D" | "E" | "F";
  label: string;
  question: string;
  intentId?: number;
  chartCode?: string;
}
