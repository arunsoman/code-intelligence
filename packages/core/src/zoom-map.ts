import type { ViewSpec } from "../../schema/src/index.ts";
import type { BreadcrumbFrame, Choice, ReferentRecord } from "../../schema/src/intents.ts";

export const ZOOM_LEVELS = [
  { level: 0, chartIds: ["S27"], label: "Whole system + external actors" },
  { level: 1, chartIds: ["S1", "S17"], label: "Major modules / services" },
  { level: 2, chartIds: ["S16", "S23"], label: "Classes / services inside a module" },
  { level: 3, chartIds: ["S21", "S20"], label: "Methods & collaborators" },
  { level: 4, chartIds: ["S2"], label: "Detailed behavior of one method" },
  { level: 5, chartIds: ["SOURCE"], label: "Actual implementation (deepest)" },
] as const;

export const SIDE_ZOOMS = [
  { concern: "data model", intentId: 9, chartIds: ["S9"] },
  { concern: "state", intentId: 16, chartIds: ["S24", "S3"] },
  { concern: "concurrency", intentId: 19, chartIds: ["V10"] },
  { concern: "failure", intentId: 21, chartIds: ["S12", "S25"] },
  { concern: "decisions", intentId: 18, chartIds: ["S11"] },
  { concern: "tests", intentId: 27, chartIds: ["S5", "V12"] },
  { concern: "performance", intentId: 29, chartIds: ["V17"] },
] as const;

export function zoomLevelOf(chartIdOrForm: string): number {
  for (const { level, chartIds } of ZOOM_LEVELS) {
    if ((chartIds as readonly string[]).includes(chartIdOrForm)) return level;
  }
  return 0;
}

export function zoomInTargets(view: ViewSpec, nodeId: string): { intentId: number; chartId: string; question: string }[] {
  // This logic is simplified for implementation; in a real system it would look at the node's entity kind
  // For now, we provide a generic "Dive deeper" option if not at level 5
  if (view.level >= 5) return [];
  return [{ intentId: 31, chartId: "S21", question: `Zoom into ${nodeId}` }];
}

export function choicesFor(view: ViewSpec, focusNodeId: string | undefined): Choice[] {
  const choices: Choice[] = [];

  if (focusNodeId) {
    choices.push({
      key: "A",
      label: "Zoom into this element",
      question: `Zoom into ${focusNodeId}`,
      intentId: 31,
    });
  }

  choices.push({
    key: "F",
    label: "Something else…",
    question: "Something else…",
  });

  return choices;
}

export function sideZoomChoices(view: ViewSpec): Choice[] {
  return SIDE_ZOOMS.map((sz, i) => ({
    key: (["A", "B", "C", "D", "E", "F", "G"][i] as any),
    label: `Explore ${sz.concern}`,
    question: `Show me the ${sz.concern} of the current item`,
    intentId: sz.intentId,
    chartCode: sz.chartIds[0],
  }));
}
