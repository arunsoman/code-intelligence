import { chartCodeForQuestion, CHART_REGISTRY } from "@cie/schema";
import { matchConcerns } from "./answer-planning.ts";

/** Presentation context is bounded model output, never source evidence or an instruction. */
export const boundAnswerContext = (text?: string) => (text ?? "").slice(0, 6000);

export function answerVisual(question: string, answer: string, hasSources: boolean): { form: string; chartCode?: string; reason: string } {
  const explicit = chartCodeForQuestion(question);
  if (explicit) return { form: CHART_REGISTRY[explicit].form, chartCode: explicit, reason: "Preserve the chart notation explicitly requested by the user." };
  if (!hasSources) return { form: "SemanticMap", reason: "No cited source is available; show the general code map." };
  const text = `${question}\n${boundAnswerContext(answer)}`;
  const concerns = matchConcerns(text).map(m => m.concern);
  if (/\b(?:refund\w*|compensat\w*|rollbacks?|reversals?|reconcil\w*)\b/i.test(text))
    return { form: "GeneratedChart", chartCode: "S12", reason: "The question and answer discuss recovery or compensation; show evidenced forward and recovery paths, with unverified links as gaps." };
  if (concerns.includes("Reliability"))
    return { form: "CausalGraph", reason: "The question and answer identify failure conditions; show their supported causal paths." };
  if (concerns.includes("Behavior"))
    return { form: "GeneratedChart", chartCode: "S28", reason: "The question and answer describe an interaction flow; show evidence-supported sequence and conditions." };
  return { form: "SemanticMap", reason: "The findings describe code responsibilities; show their source-backed structure." };
}

/** Keep reported uncertainty visible without promoting it into a source claim. */
export function answerLimitations(answer: string): string[] {
  return boundAnswerContext(answer).split(/(?<=[.!?])\s+|\n+/)
    .filter(s => /could not determine|cannot determine|did not (?:get to )?read|unverified|unresolved/i.test(s))
    .slice(0, 8).map(s => `Reported answer limitation: ${s.slice(0, 800)}`);
}
