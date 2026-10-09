// Prints layout quality for every form at the levels a user can reach. Run: node apps/web/test/layout-report.ts
import { VISUALS } from "../../../packages/core/src/visuals.ts";
import { ctx, demoRepo, setup, traceFor } from "../../../packages/core/test/helpers.ts";
import { basePositions, effectiveView, render } from "../src/graph.ts";
import { arrange } from "../src/arrange.ts";
import { measure } from "../src/layoutmetrics.ts";

const { svc, worker, revision } = await setup(undefined, process.env.REPO ?? demoRepo());
if (!process.env.REPO) await svc.buildConceptHierarchy(ctx(), { revision });
const out: string[] = [];
let totals = { nodeOverlaps: 0, edgeThroughNode: 0, edgeCrossings: 0 };
for (const v of VISUALS.filter((x) => x.formId !== "ChangeRisk") ) {
  const r = await svc.ask(ctx(), { question: v.example, revision, form: v.formId } as any);
  if (!r.ok) { out.push(`${v.code} ${v.formId}: ${r.error.message}`); continue; }
  const claims = Object.fromEntries(r.value.claims.map((c: any) => [c.draft.id, c]));
  const { view, stale } = effectiveView(r.value.view, claims);
  const pos = basePositions(view);
  for (const level of [1, 3, 5, 6]) {
    const m = measure(arrange(render(view, level, pos, stale), view, level));
    totals.nodeOverlaps += m.nodeOverlaps; totals.edgeThroughNode += m.edgeThroughNode; totals.edgeCrossings += m.edgeCrossings;
    out.push(`${v.code} ${v.formId.padEnd(18)} L${level}  nodes ${String(m.nodes).padStart(3)} edges ${String(m.edges).padStart(3)}  overlaps ${m.nodeOverlaps}  edge-through-node ${m.edgeThroughNode}  crossings ${m.edgeCrossings}`);
    if (process.env.DETAIL && m.detail.length) for (const d of m.detail) out.push(`      ${d}`);
  }
}
console.log(out.join("\n")); console.log("TOTAL", JSON.stringify(totals));
worker.close();
