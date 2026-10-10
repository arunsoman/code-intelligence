import { nativeConcerns } from "./answer-planning.ts";
import { planResponse } from "./plugins/steps/index.ts";
import { createHash } from "node:crypto";
import { CHART_REGISTRY, ResponseManifestSchema, type ChartId, type ResponseManifest, type ResponseView, type ViewSpec } from "@cie/schema";
import type { CatalogEntry } from "./visuals.ts";

// Native forms keep their existing catalogue; chart concerns come exclusively from plugins.
const concernOf = (code: string) => CHART_REGISTRY[code as ChartId]?.concern ?? nativeConcerns[code] ?? "Other views";
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
export const viewCode = (view: ViewSpec, catalog: CatalogEntry[]) => typeof view.params?.chartId === "string"
  ? view.params.chartId : catalog.find((x) => x.formId === view.formId)?.code ?? view.formId;

/** A deterministic portfolio over validated views. Availability means requestable, not proven evidence coverage. */
export function responsePortfolio(input: { views: ViewSpec[]; catalog: CatalogEntry[]; question: string; evidenceKinds?: Record<string, number>; responseId?: string; context?: { scope: "subject" | "repository"; subject?: string; seeds?: string[] } }): ResponseManifest {
  const first = input.views[0];
  if (!first || input.views.some((v) => v.revision !== first.revision)) throw new Error("A response portfolio needs views from one revision");
  const question = input.question.slice(0, 1000);
  const responseId = input.responseId ?? `response:${hash(first.revision + question + input.views.map((v) => v.id).join("|"))}`;
  const refs = [...new Map(input.views.flatMap((v) => v.nodes.flatMap((n) => n.entityRefs.map((id) => [id, { id, label: n.label, kind: n.kind }] as const)))).values()];
  const primaryCode = viewCode(first, input.catalog);
  const descriptors: ResponseView[] = [];
  const subject = input.context?.subject ?? (typeof first.params?.subject === "string" ? first.params.subject : undefined);
  const scope = input.context?.scope ?? (first.params?.scope === "subject" || subject ? "subject" as const : "repository" as const);
  const seeds = scope === "subject" ? [...new Set(input.context?.seeds?.length ? input.context.seeds : first.nodes.flatMap((n) => n.entityRefs))].slice(0, 40) : [];
  const planning = planResponse({ question, primaryCode, views: input.views, catalog: input.catalog, scope, subject, evidenceKinds: input.evidenceKinds, availability: new Map() });
  const relevant = new Set([primaryCode, ...planning.plan!.supportingCodes]);
  const add = (code: string, form: string, label: string, available: boolean, reason?: string, view?: ViewSpec) => {
    const id = `${responseId}:${hash(code + (view?.id ?? ""))}`;
    descriptors.push({ id, code, form, label, concern: concernOf(code), questionAnswered: view?.question ?? `${CHART_REGISTRY[code as ChartId]?.questionAnswered ?? question} — Topic: ${question}`,
      subject: typeof view?.params?.subject === "string" ? view.params.subject : subject, seeds,
      scope, primary: descriptors.length === 0, relevant: !!view || relevant.has(code),
      status: view ? view.gaps.length ? "partial" : "ready" : available ? "available" : "unavailable",
      reason: view ? view.gaps[0] : reason, ...(view ? { viewId: view.id } : {}) });
  };
  for (const view of input.views) {
    const code = viewCode(view, input.catalog);
    const label = CHART_REGISTRY[code as ChartId]?.name ?? input.catalog.find((x) => x.code === code)?.name ?? view.route?.name ?? view.formId;
    add(code, view.formId, label, true, undefined, view);
  }
  const existing = new Set(descriptors.map((d) => d.code));
  for (const chart of Object.values(CHART_REGISTRY)) {
    if (chart.id === "generic" || existing.has(chart.id)) continue;
    const availability = planning.availability.get(chart.id)!;
    add(chart.id, chart.form, chart.name, availability.available, availability.reason);
  }
  for (const native of input.catalog) {
    if (existing.has(native.code) || native.formId === "GeneratedChart") continue;
    const available = native.available && native.formId !== "HypothesisGraph";
    add(native.code, native.formId, native.name, available, native.formId === "HypothesisGraph" ? "Start this investigation by pasting a stack trace." : native.reason);
  }
  return ResponseManifestSchema.parse({ schemaVersion: "response.v1", policyVersion: "portfolio.v3", plan: planning.plan, responseId,
    revision: first.revision, question, interpretation: first.route?.because ?? first.formReason ?? "Related views use this question and revision.",
    subjectRefs: refs, primaryViewId: descriptors[0]!.id, views: [...descriptors.filter(d => d.viewId), ...planning.plan!.supportingCodes.flatMap(code => descriptors.filter(d => d.code === code && !d.viewId)), ...descriptors.filter(d => !d.viewId && !planning.plan!.supportingCodes.includes(d.code))],
    sections: input.views.map((v, i) => ({ id: `${responseId}:section:${i}`, label: descriptors[i]!.label,
      text: v.answer ?? v.caption, entityRefs: [...new Set(v.nodes.flatMap((n) => n.entityRefs))],
      evidenceIds: [...new Set([...v.nodes, ...v.edges].flatMap((n) => n.evidenceIds))] })),
    limitations: [...new Set(input.views.flatMap((v) => v.gaps))] });
}
