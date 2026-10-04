// F05 §7.9 — the minimum presentation-binding path (guide §15): before any metric is displayed as measured, every
// rendered metric item is bound to a registered wording template of a stated claim class, a population hash, a window,
// a unit and an uncertainty where one exists. The verifier refuses items that would let a modelled number appear as a
// measured one (F05-A5), let window-overlap claims read as causal or per-request (F05-D8), or cite an artifact that
// does not exist. The renderer draws only verified items; a rejected one becomes an explicit placeholder with reasons.
import type { MetricClaimClass, MetricItem, PresentationCheckItem, ProfileDiagnostic, SampleKind } from "@cie/schema";
export type { MetricItem };
import { createHash } from "node:crypto";

/** How strong each claim class is; a template moving classes must move at least one version (§7.9.1). */
const CLASS_STRENGTH: Record<MetricClaimClass, number> = { MODELED: 0, ESTIMATED: 1, OBSERVED_TRACE: 2, POPULATION_OVERLAP: 3, MEASURED_PROFILE: 4 };
export function claimStrength(c: MetricClaimClass): number { return CLASS_STRENGTH[c]; }

export interface MetricTemplateInput { id: string; version: number; claimClass: MetricClaimClass; text: string }

const templateHash = (t: { id: string; version: number; claimClass: MetricClaimClass; text: string }) =>
  createHash("sha256").update(`${t.id}\n${t.version}\n${t.claimClass}\n${t.text}`).digest("hex").slice(0, 32);

/** Immutable per id+version: the same identity with different content is refused, like a stored gate policy (F02). */
export class TemplateRegistry {
  private byKey = new Map<string, MetricTemplateInput & { hash: string }>();
  register(t: MetricTemplateInput): MetricTemplateInput & { hash: string } {
    if (!t.id || !/^[a-z0-9.:-]{3,80}$/.test(t.id)) throw new Error("a metric template needs an id of letters, digits and dashes");
    if (!Number.isInteger(t.version) || t.version < 1) throw new Error(`template "${t.id}" needs a positive integer version`);
    if (!t.text.trim()) throw new Error(`template "${t.id}" needs wording`);
    if (templateProblems(t).length) throw new Error(`template ${t.id}@${t.version} carries wording its claim class may not use`);
    const hash = templateHash(t);
    const prior = this.byKey.get(`${t.id}@${t.version}`);
    if (prior) {
      if (prior.hash !== hash) throw new Error(`template ${t.id}@${t.version} is already registered with different content; templates are immutable — register a new version instead`);
      return prior;
    }
    this.byKey.set(`${t.id}@${t.version}`, { ...t, hash });
    return this.byKey.get(`${t.id}@${t.version}`)!;
  }
  of(id: string, version: number): (MetricTemplateInput & { hash: string }) | null {
    return this.byKey.get(`${id}@${version}`) ?? null;
  }
  all(): (MetricTemplateInput & { hash: string })[] { return [...this.byKey.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version); }
}

/**
 * The built-in wording set. Each says what it is good for:
 *  - measured items cite artifact(s) and never a cause;
 *  - population items speak of the window, never of one request;
 *  - a modeled item exists so F10-style outputs have a home that can never wear measured wording.
 */
export function builtinTemplates(): MetricTemplateInput[] {
  return [
    { id: "profile.hotspot.self", version: 1, claimClass: "MEASURED_PROFILE", text: "measured {kind} samples: {share} of the population sits in {name}" },
    { id: "profile.hotspot.total", version: 1, claimClass: "MEASURED_PROFILE", text: "measured {kind} samples: {share} pass through {name}" },
    { id: "profile.window.population", version: 1, claimClass: "POPULATION_OVERLAP", text: "during this window, the service's {kind} was spent mostly in {name}" },
    { id: "profile.window.coverage", version: 1, claimClass: "POPULATION_OVERLAP", text: "{ratio} of expected samples were collected; absolute values may underestimate it" },
    { id: "profile.trace.exemplar", version: 1, claimClass: "OBSERVED_TRACE", text: "one sampled trace took {duration}: a slow member of the sampled population, maybe not the slowest" },
    { id: "profile.modeled.note", version: 1, claimClass: "MODELED", text: "modelled, not measured: {statement}" },
  ];
}

/** Words that would make a claim read stronger than its class; a registered template containing them is refused. */
const FORBIDDEN: { pattern: RegExp | ((text: string) => RegExp | null); cls: MetricClaimClass; why: string }[] = [
  { pattern: /\bcaused?\b|\bbecause\b|\bdue to\b/i, cls: "POPULATION_OVERLAP", why: "a population overlap is not a cause" },
  { pattern: /\bthis request\b/i, cls: "POPULATION_OVERLAP", why: "samples are labelled only to the population; saying this request would be wrong (F05-D8)" },
  { pattern: /\bcaused?\b|\bbecause\b/i, cls: "MEASURED_PROFILE", why: "a profile measures where samples fall; it does not establish causes" },
  { pattern: (t) => { const rest = t.replace(/not\s+measured/g, ""); const m = /\bmeasured\b/i.exec(rest); return m ? new RegExp("\\bmeasured\\b", "i") : null; }, cls: "MODELED", why: 'a modelled number must never dress itself as a measurement (F05-A5); the words "not measured" are the one allowed mention' },
  { pattern: /\bproven\b|\bguaranteed\b/i, cls: "MEASURED_PROFILE", why: "a profile shares an observed population of samples, not a proof" },
];

export function templateProblems(t: MetricTemplateInput): ProfileDiagnostic[] {
  const out: ProfileDiagnostic[] = [];
  for (const f of FORBIDDEN) if (t.claimClass === f.cls) {
    const re = typeof f.pattern === "function" ? f.pattern(t.text) : f.pattern;
    const m = re?.exec(t.text);
    if (m) out.push({ code: "UNSAFE_WORDING", message: `${t.id}@${t.version}: "${m[0]}" — ${f.why}` });
  }
  return out;
}

// ---------------------------------------------------------------- items and the verifier

export interface MetricItemInput {
  locator: string; templateId: string; templateVersion: number;
  value: number; unit: string; basis: MetricClaimClass;
  populationHash: string; window: { fromNs: number; toNs: number }; sampleCount: number;
  artifactHash?: string; populationValue?: number; uncertainty?: { lower: number; upper: number };
  caveatIds?: string[]; certificateId?: string;
}

export function metricItem(i: MetricItemInput): MetricItem {
  return {
    itemId: "mi:" + createHash("sha256").update([i.locator, i.templateId, i.templateVersion, i.value, i.unit, i.basis, i.populationHash, i.window.fromNs, i.window.toNs, i.sampleCount].join("|")).digest("hex").slice(0, 24),
    locator: i.locator,
    claimId: i.certificateId ?? null,
    templateId: i.templateId, templateVersion: i.templateVersion,
    certificateId: i.certificateId ?? null,
    value: i.value, unit: i.unit, basis: i.basis,
    populationHash: i.populationHash, window: { fromNs: i.window.fromNs, toNs: i.window.toNs },
    sampleCount: i.sampleCount, populationValue: i.populationValue ?? null,
    artifactHash: i.artifactHash ?? null,
    uncertainty: i.uncertainty ?? null,
    caveatIds: [...(i.caveatIds ?? [])],
  };
}

export function manifestHash(items: MetricItem[]): string {
  return "mf:" + createHash("sha256").update(JSON.stringify([...items].map((i) => ({ ...i, itemId: "" })).sort((a, b) => a.locator.localeCompare(b.locator)))).digest("hex").slice(0, 32);
}

export interface VerificationContext {
  templateOf(id: string, version: number): { claimClass: MetricClaimClass } | null;
  artifactExists(hash: string | null): boolean;
  unitOfArtifact(hash: string | null): string | null;
  populationOf(hash: string): { sampleCount: number; window: { fromNs: number; toNs: number } } | null;
  evidenceExists(rev: string, id: string): boolean;
  revision: string;
}

/**
 * Checks per renderable item (spec §7.9.3):
 *  1. the template exists and the item's basis matches the template's claim class — a modeled item through a measured
 *     template is refused here, not merely mislabelled downstream (F05-A5);
 *  2. a measured item is traceable to an artifact whose hash exists, with the artifact's own declared unit;
 *  3. the value fits its population and the population hash resolves;
 *  4. cited evidence exists in the shown revision;
 *  5. population-overlap items carry the correlation-grade caveat.
 * A rejected item is answered with its reasons so the renderer can draw the explicit "unverified" placeholder.
 */
export function verifyMetricPresentation(items: MetricItem[], cx: VerificationContext): PresentationCheckItem[] {
  return items.map((it) => {
    const reasons: string[] = [];
    const tpl = cx.templateOf(it.templateId, it.templateVersion);
    if (!tpl) reasons.push(`template ${it.templateId}@${it.templateVersion} is not registered`);
    else if (tpl.claimClass !== it.basis) reasons.push(`basis ${it.basis} does not match the template's claim class ${tpl.claimClass}: a modelled number can never appear as a measured one (F05-A5)`);
    if (it.basis === "MEASURED_PROFILE") {
      if (!it.artifactHash) reasons.push("a measured item must cite the profile artifact hash it came from");
      else if (!cx.artifactExists(it.artifactHash)) reasons.push(`profile artifact ${it.artifactHash.slice(0, 12)} is not in this store; the measured claim is not traceable`);
      else {
        const declared = cx.unitOfArtifact(it.artifactHash);
        if (declared && it.unit !== declared && it.unit !== "share") reasons.push(`unit "${it.unit}" is not the artifact's declared unit (${declared})`);
      }
    }
    if (it.basis === "POPULATION_OVERLAP") {
      if (!it.caveatIds.some((c) => c.startsWith("grade:"))) reasons.push("a window-overlap claim must carry the correlation grade as a caveat (F05-D8)");
      if (/this request/i.test(it.locator)) reasons.push("population wording must not name this request");
    }
    const pop = cx.populationOf(it.populationHash);
    if (it.populationHash && !pop) reasons.push(`population ${it.populationHash.slice(0, 12)} is unknown in this store`);
    if (pop) {
      if (it.populationValue !== null && Number.isFinite(it.populationValue) && (it.value < -1e-9 || it.value > it.populationValue + 1e-9)) reasons.push("the value does not fit inside its population total");
      if (pop.window.fromNs > it.window.toNs || pop.window.toNs < it.window.fromNs) reasons.push("the item's window is not inside its population's window");
    }
    if (it.certificateId && !cx.evidenceExists(cx.revision, it.certificateId)) reasons.push(`cited evidence ${it.certificateId.slice(0, 12)} does not exist in this revision`);
    if (!Number.isFinite(it.value)) reasons.push("the value is not a finite number");
    return { itemId: it.itemId, verdict: reasons.length ? ("REJECTED" as const) : ("VERIFIED" as const), reasons };
  });
}

/** All metric kinds are siblings: the selector uses this to know which kinds a store can offer today (F05-A3). */
export const SAMPLE_KINDS: SampleKind[] = ["CPU", "WALL", "ALLOC_SPACE", "ALLOC_OBJECTS", "INUSE_SPACE", "INUSE_OBJECTS", "LOCK_CONTENTION", "OTHER"];