import type { ChartId, CompiledChart, ChartDiagnostics, Claim, ViewSpec } from "@cie/schema";
/** Legacy compilers share ViewSpec. The adapter pins and checks its capability identity. */
export function checkedResult<K extends ChartId>(id: K, result: { view: ViewSpec; claims: Claim[]; diagnostics: ChartDiagnostics }): CompiledChart<K> {
  const actual = result.view.params?.chartId;
  if (actual != null && actual !== id) throw new Error(`Compiler ${id} returned ${actual}`);
  return { ...result, view: { ...result.view, params: { ...result.view.params, chartId: id } } };
}
