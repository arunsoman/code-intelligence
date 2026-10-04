import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewSpec } from "@cie/schema";
import { VISUALS } from "../src/visuals.ts";
import { validateView } from "../src/validate.ts";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

async function allForms() {
  const repo = demoRepo();
  const t = await setup(undefined, repo);
  await t.svc.extractConcepts(ctx(), { revision: t.revision });
  t.svc.reportException(ctx(), { trace: traceFor(repo), source: "api-server" });
  const views: { code: string; view: ViewSpec; claims: any[] }[] = [];
  for (const v of VISUALS) {
    const question = v.formId === "HypothesisGraph" ? traceFor(repo) : v.example;
    const r = await t.svc.ask(ctx(), { question, revision: t.revision });
    if (!r.ok) continue;
    views.push({ code: v.code, view: r.value.view, claims: r.value.claims });
  }
  return { ...t, views };
}

test("form-plugin conformance: every registered form compiles to a spec that passes the same validator", async () => {
  const { worker, svc, views } = await allForms();
  const forms = new Set(views.map((v) => v.view.formId));
  assert.ok(forms.size >= 12, `only ${[...forms]} built`);
  for (const { code, view, claims } of views) {
    const bad = validateView(svc.store, view, { claims });
    assert.deepEqual(bad, [], `${code} ${view.formId}: ${bad.map((b) => `${b.code} ${b.where}: ${b.message}`).join("; ")}`);
  }
  worker.close();
});

test("invalid evidence reference: a spec citing evidence that is not stored, or an element citing none, does not validate", async () => {
  const { worker, svc, views } = await allForms();
  const { view, claims } = views.find((v) => v.view.formId === "SemanticMap")!;
  const mutated: ViewSpec = JSON.parse(JSON.stringify(view));
  const n = mutated.nodes.find((x) => x.evidenceIds.length)!;
  n.evidenceIds = ["ev:does-not-exist"];
  const e = mutated.edges.find((x) => x.displayMode === "FACT")!;
  e.evidenceIds = [];
  const codes = validateView(svc.store, mutated, { claims }).map((x) => x.code);
  assert.ok(codes.includes("EVIDENCE_UNKNOWN"));
  assert.ok(codes.includes("EVIDENCE_MISSING"));
  const dangling: ViewSpec = JSON.parse(JSON.stringify(view));
  dangling.edges[0].toNodeId = "n:ghost";
  assert.ok(validateView(svc.store, dangling, { claims }).some((x) => x.code === "DANGLING_EDGE"));
  worker.close();
});

test("a hypothesis cannot be shown as fact, and groups cannot invent members, lose parents or form cycles", async () => {
  const { worker, svc, views } = await allForms();
  const { view, claims } = views.find((v) => v.view.formId === "SemanticMap" && v.claims.length)!;
  const m: ViewSpec = JSON.parse(JSON.stringify(view));
  const inferred = m.edges.find((e) => e.claimId)!;
  const cl = claims.find((c) => c.draft.id === inferred.claimId)!;
  const forged = claims.map((c) => (c === cl ? { ...c, displayMode: "HYPOTHESIS" as const } : c));
  inferred.displayMode = "FACT";
  assert.ok(validateView(svc.store, m, { claims: forged }).some((x) => x.code === "HYPOTHESIS_AS_FACT"));
  const g: ViewSpec = JSON.parse(JSON.stringify(view));
  g.groups[0].childNodeIds.push("n:invented");
  g.groups[0].parentGroupId = "g:nowhere";
  const codes = validateView(svc.store, g, { claims }).map((x) => x.code);
  assert.ok(codes.includes("GROUP_MEMBER_UNKNOWN") && codes.includes("GROUP_PARENT_UNKNOWN"));
  const cyc: ViewSpec = JSON.parse(JSON.stringify(view));
  cyc.groups = [{ ...cyc.groups[0], id: "g:a", parentGroupId: "g:b" }, { ...cyc.groups[0], id: "g:b", parentGroupId: "g:a" }];
  assert.ok(validateView(svc.store, cyc, { claims }).some((x) => x.code === "GROUP_CYCLE"));
  worker.close();
});

test("persona safety: a spec that hides code a failure points at is rejected, and real lens-built views never do", async () => {
  const { worker, svc, views } = await allForms();
  const hot = views.flatMap((v) => v.view.nodes).find((n) => (n.factors?.find((f) => f.factor === "RUNTIME_HOTNESS")?.normalizedScore ?? 0) >= 0.5);
  assert.ok(hot, "a hot node exists in some built view");
  const { view, claims } = views.find((v) => v.view.nodes.includes(hot!))!;
  const m: ViewSpec = JSON.parse(JSON.stringify(view));
  m.nodes.find((n) => n.id === hot!.id)!.tier = "HIDDEN";
  assert.ok(validateView(svc.store, m, { claims }).some((x) => x.code === "DANGEROUS_FACT_HIDDEN"));
  for (const lens of ["newcomer", "reviewer", "oncall"]) {
    const r = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision: views[0].view.revision, lens });
    if (r.ok) assert.deepEqual(validateView(svc.store, r.value.view, { claims: r.value.claims }).filter((x) => x.code === "DANGEROUS_FACT_HIDDEN"), [], lens);
  }
  worker.close();
});
