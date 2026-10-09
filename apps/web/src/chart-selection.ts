/** Gallery visual codes (V*) are forms; only registered chart codes select a chart contract. */
export function selectedChartId(chart: { code: string; formId: string }): string | undefined {
  return /^S\d+$/.test(chart.code) ? chart.code : chart.formId === "GeneratedChart" ? "generic" : undefined;
}
