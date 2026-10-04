// C17: measuring the system against things whose answer is known, and saying how sure the measurement is. Every metric carries an
// interval; a run is tied to the model and code that produced it; a change of model is not trusted until it has been measured; labels
// made by the system or by a script are marked synthetic and never counted as expert labels; and a study with no participants is not a study.
import { createHash } from "node:crypto";
import { StubProvider } from "@cie/model";
import type { ModelProvider } from "@cie/schema";
import { wilson } from "./claims.ts";
import { Security } from "./security.ts";
import type { Service } from "./service.ts";
import type { Store } from "./store.ts";

export const MIN_EXPERTS = 8;
export const MIN_BIN = 10;
export const MIN_PARTICIPANTS = 20;

export interface Item { id: string; expected: boolean; predicted: boolean }
export interface Interval { value: number | null; lower: number; upper: number; n: number }
export interface Metrics { precision: Interval; recall: Interval; accuracy: Interval; tp: number; fp: number; fn: number; tn: number }
export interface Run { id: string; suite: string; suiteVersion: number; model: string; codeVersion: string; metrics: Metrics; items: Item[]; synthetic: boolean; at: string }

const iv = (k: number, n: number): Interval => ({ value: n ? k / n : null, ...wilson(k, n), n });
export function metricsOf(items: Item[]): Metrics {
  const tp = items.filter((i) => i.expected && i.predicted).length, fp = items.filter((i) => !i.expected && i.predicted).length;
  const fn = items.filter((i) => i.expected && !i.predicted).length, tn = items.filter((i) => !i.expected && !i.predicted).length;
  return { precision: iv(tp, tp + fp), recall: iv(tp, tp + fn), accuracy: iv(tp + tn, items.length), tp, fp, fn, tn };
}

/** Exact two-sided McNemar test on paired outcomes: how likely is a split this uneven if the two runs were equally good? */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  const lg = (x: number): number => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  for (let i = 0; i <= k; i++) p += Math.exp(lg(n) - lg(i) - lg(n - i) - n * Math.log(2));
  return Math.min(1, 2 * p);
}

export interface Suite { id: string; version: number; title: string; synthetic: boolean; run: (svc: Service, ctx: { model: string }) => Promise<Item[]> }

// Seeds are read off the fixture's own code, not off any model's output: every error class it throws, every topic it both publishes and
// subscribes, the two fields it writes outside a transaction, and its top-level modules. The absent ones appear nowhere in it.
const THROWN = ["CaptureFailedError", "CardDeclinedError", "DuplicateRequestError", "FraudRejectedError", "GatewayTimeoutError", "InsufficientFundsError"];
const SEED_CONCEPTS: { id: string; kind: string; title: RegExp; present: boolean }[] = [
  ...THROWN.map((e) => ({ id: `failure:${e}`, kind: "failure-mode", title: new RegExp(e), present: true })),
  { id: "workflow:payment.capture.requested", kind: "workflow", title: /payment\.capture\.requested/, present: true },
  { id: "workflow:refund.requested", kind: "workflow", title: /refund\.requested/, present: true },
  { id: "invariant:balance", kind: "invariant", title: /balance/i, present: true },
  { id: "invariant:held", kind: "invariant", title: /held/i, present: true },
  { id: "capability:ledger", kind: "capability", title: /ledger/i, present: true },
  { id: "capability:payments", kind: "capability", title: /payments/i, present: true },
  { id: "capability:refunds", kind: "capability", title: /refunds/i, present: true },
  { id: "absent:kubernetes", kind: "capability", title: /kubernetes|autoscal/i, present: false },
  { id: "absent:blockchain", kind: "domain-concept", title: /blockchain|ledger of tokens/i, present: false },
  { id: "absent:oauth", kind: "capability", title: /oauth|single sign/i, present: false },
  { id: "absent:email", kind: "workflow", title: /email|smtp/i, present: false },
  { id: "absent:failure-timeout-db", kind: "failure-mode", title: /DatabaseConnectionError/, present: false },
];
/** Model-dependent: which of the seeded business concepts does extraction find, and which absent ones does it wrongly invent? */
export const SEEDED_CONCEPTS: Suite = {
  id: "seeded-concepts", version: 1, title: "Seeded business concepts", synthetic: false,
  async run(svc) {
    const rev = svc.store.latestRevision()!;
    const r = await svc.extractConcepts({ requestId: "eval", idempotencyKey: "eval-" + Math.random(), actor: { principalId: "eval", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 120_000, traceId: "eval" }, { revision: rev.id });
    const cards = r.ok ? r.value.cards : [];
    return SEED_CONCEPTS.map((s) => ({ id: s.id, expected: s.present, predicted: cards.some((c) => c.kind === s.kind && s.title.test(c.title)) }));
  },
};

/** Rule-based: planted leaks and authorisation gaps against safe look-alikes. Independent of any model. */
export const PLANTED_SECURITY: Suite = {
  id: "planted-security", version: 1, title: "Planted leaks and authorisation gaps", synthetic: false,
  async run(svc) {
    const rev = svc.store.latestRevision()!;
    const found = new Security(svc.store).analyze({ revision: rev.id });
    const flagged = (rule: string, fn: string) => found.some((f) => f.ruleId === rule && new RegExp(`\\b${fn}\\b`).test(f.summary));
    const truth: [string, string, boolean][] = [
      ["R-PII-LOG", "registerUser", true], ["R-PII-LOG", "legacyExport", true], ["R-PII-LOG", "ping", false], ["R-PII-LOG", "updateProfileHandler", false], ["R-PII-LOG", "deleteAccountHandler", false],
      ["R-AUTHZ-GAP", "deleteAccountHandler", true], ["R-AUTHZ-GAP", "updateProfileHandler", false], ["R-AUTHZ-GAP", "registerUser", false], ["R-AUTHZ-GAP", "ping", false],
    ];
    return truth.map(([rule, fn, expected]) => ({ id: `${rule}:${fn}`, expected, predicted: flagged(rule, fn) }));
  },
};

export class Evaluator {
  readonly store: Store;
  readonly codeVersion: string;
  constructor(store: Store, codeVersion = "dev") { this.store = store; this.codeVersion = codeVersion; }

  async runSuite(svc: Service, suite: Suite, model: ModelProvider | { name: string; model: string }): Promise<Run> {
    const label = `${model.name}/${model.model}`;
    const items = await suite.run(svc, { model: label });
    const run: Run = { id: "run:" + createHash("sha256").update(suite.id + label + Date.now() + Math.random()).digest("hex").slice(0, 12), suite: suite.id, suiteVersion: suite.version, model: label, codeVersion: this.codeVersion, metrics: metricsOf(items), items, synthetic: suite.synthetic, at: new Date().toISOString() };
    this.store.db.prepare("insert into eval_runs values (?,?,?,?,?,?,?,?,?)").run(run.id, run.suite, run.suiteVersion, run.model, run.codeVersion, JSON.stringify(run.metrics), JSON.stringify(run.items), run.synthetic ? 1 : 0, run.at);
    return run;
  }
  runs(suite?: string): Run[] { return (this.store.db.prepare("select * from eval_runs order by at, id").all() as any[]).filter((r) => !suite || r.suite === suite).map((r) => ({ id: r.id, suite: r.suite, suiteVersion: r.suite_version, model: r.model, codeVersion: r.code_version, metrics: JSON.parse(r.metrics), items: JSON.parse(r.items), synthetic: !!r.synthetic, at: r.at })); }

  /** Same suite, two runs, paired by item: is B worse than A by more than chance? */
  compare(a: Run, b: Run, alpha = 0.05) {
    if (a.suite !== b.suite || a.suiteVersion !== b.suiteVersion) return { comparable: false as const, reason: "the runs are of different suites or suite versions" };
    const bm = new Map(b.items.map((i) => [i.id, i]));
    let aOnly = 0, bOnly = 0; const changed: string[] = [];
    for (const x of a.items) { const y = bm.get(x.id); if (!y) continue; const ac = x.predicted === x.expected, bc = y.predicted === y.expected; if (ac && !bc) { aOnly++; changed.push(`${x.id}: right before, wrong now`); } if (!ac && bc) bOnly++; }
    const p = mcnemar(aOnly, bOnly);
    const dropped = (b.metrics.accuracy.value ?? 0) < (a.metrics.accuracy.value ?? 0) || (b.metrics.recall.value ?? 0) < (a.metrics.recall.value ?? 0);
    return { comparable: true as const, worseOnly: aOnly, betterOnly: bOnly, pValue: p, regression: dropped && aOnly > bOnly && p < alpha, possibleRegression: dropped && aOnly > bOnly && p >= alpha, changed, note: dropped && p >= alpha ? "worse on this sample, but the difference is within what chance produces: the suite is too small to tell" : "" };
  }

  /** What may be said about the model currently in use. */
  modelStatus(current: { name: string; model: string }, suite: string) {
    const label = `${current.name}/${current.model}`;
    const mine = this.runs(suite).filter((r) => r.model === label).at(-1) ?? null;
    const last = this.runs(suite).at(-1) ?? null;
    return { model: label, evaluated: !!mine, lastRun: mine?.id ?? null, status: mine ? "EVALUATED" as const : last ? "UNMEASURED_MODEL" as const : "NEVER_EVALUATED" as const, note: mine ? "" : `${label} has not been run against ${suite}; earlier results describe ${last?.model ?? "nothing"}.` };
  }
  /** A release is allowed only with a measurement of the model in use that clears the suite's bar. */
  releaseGate(current: { name: string; model: string }, suite: string, bar: { minRecall: number; minPrecision: number }) {
    const s = this.modelStatus(current, suite);
    if (!s.evaluated) return { pass: false, reason: s.note };
    const r = this.runs(suite).find((x) => x.id === s.lastRun)!;
    const rec = r.metrics.recall.lower, prec = r.metrics.precision.lower;
    // The lower end of the interval must clear the bar: a lucky small sample does not pass.
    return rec >= bar.minRecall && prec >= bar.minPrecision ? { pass: true, reason: "" } : { pass: false, reason: `recall ${pct(r.metrics.recall)} and precision ${pct(r.metrics.precision)} (lower bounds ${rec.toFixed(2)} and ${prec.toFixed(2)}) do not clear ${bar.minRecall}/${bar.minPrecision}` };
  }

  // ------------------------------------------------------------------ calibration
  addLabel(l: { subject: string; claimClass: string; predictedConfidence: number | null; outcome: boolean; labeler: string; synthetic?: boolean }) {
    const id = "lbl:" + createHash("sha256").update([l.subject, l.labeler, l.claimClass].join("|")).digest("hex").slice(0, 12);
    // Held out by a fixed rule on the subject, so the same item is held out every time and never used to fit anything.
    const held = parseInt(createHash("sha256").update("heldout|" + l.subject).digest("hex").slice(0, 8), 16) % 10 < 3 ? 1 : 0;
    this.store.db.prepare("insert or replace into eval_labels values (?,?,?,?,?,?,?,?,?)").run(id, l.subject, l.claimClass, l.predictedConfidence, l.outcome ? 1 : 0, l.labeler, l.synthetic ? 1 : 0, held, new Date().toISOString());
  }
  labels(opts: { heldOut?: boolean } = {}) { return (this.store.db.prepare("select * from eval_labels order by id").all() as any[]).filter((r) => opts.heldOut === undefined || !!r.held_out === opts.heldOut).map((r) => ({ subject: r.subject as string, claimClass: r.claim_class as string, confidence: r.predicted_confidence as number | null, outcome: !!r.outcome, labeler: r.labeler as string, synthetic: !!r.synthetic, heldOut: !!r.held_out })); }

  /** Stated confidence against what happened, in bins, each with its own interval; a bin too small to say anything says so. */
  calibration(opts: { heldOut?: boolean; bins?: number } = {}) {
    const bins = opts.bins ?? 5;
    const ls = this.labels({ heldOut: opts.heldOut }).filter((l) => l.confidence !== null);
    const out = Array.from({ length: bins }, (_, i) => {
      const lo = i / bins, hi = (i + 1) / bins;
      const inBin = ls.filter((l) => l.confidence! >= lo && (i === bins - 1 ? l.confidence! <= hi : l.confidence! < hi));
      const ok = inBin.filter((l) => l.outcome).length, n = inBin.length;
      const w = wilson(ok, n), mean = n ? inBin.reduce((a, l) => a + l.confidence!, 0) / n : null;
      const enough = n >= MIN_BIN;
      return { range: [lo, hi] as [number, number], n, observed: n ? ok / n : null, lower: w.lower, upper: w.upper, meanStated: mean, enough, verdict: !enough ? "TOO_FEW" as const : mean! > w.upper ? "OVERCONFIDENT" as const : mean! < w.lower ? "UNDERCONFIDENT" as const : "CONSISTENT" as const };
    });
    const used = out.filter((b) => b.enough);
    const ece = used.length ? used.reduce((a, b) => a + (b.n / used.reduce((s, x) => s + x.n, 0)) * Math.abs((b.observed ?? 0) - (b.meanStated ?? 0)), 0) : null;
    return { labels: ls.length, bins: out, ece, note: used.length ? "" : `no bin has ${MIN_BIN} labels yet, so no calibration is claimed` };
  }

  /** How many different people have labelled, and whether that is enough to call the labels expert-validated. Synthetic labels never count. */
  expertCoverage() {
    const real = this.labels().filter((l) => !l.synthetic);
    const people = new Set(real.map((l) => l.labeler));
    return { labels: this.labels().length, realLabels: real.length, syntheticLabels: this.labels().length - real.length, experts: people.size, required: MIN_EXPERTS, expertValidated: people.size >= MIN_EXPERTS, heldOutReal: real.filter((l) => l.heldOut).length, note: people.size >= MIN_EXPERTS ? "" : `${people.size} of the ${MIN_EXPERTS} labelers the protocol requires have contributed; the held-out set is not expert-validated yet.` };
  }

  // ------------------------------------------------------------------ studies
  recordStudy(s: { name: string; protocol: string; participants: { id: string; task: string; completed: boolean; seconds: number }[]; synthetic?: boolean }) {
    const id = "study:" + createHash("sha256").update(s.name + JSON.stringify(s.participants)).digest("hex").slice(0, 10);
    this.store.db.prepare("insert or replace into eval_studies values (?,?,?,?,?)").run(id, s.name, s.protocol, JSON.stringify({ participants: s.participants, synthetic: !!s.synthetic }), new Date().toISOString());
    return id;
  }
  studyReport(id: string) {
    const r = this.store.db.prepare("select name, protocol, json from eval_studies where id = ?").get(id) as any;
    if (!r) return null;
    const { participants, synthetic } = JSON.parse(r.json) as { participants: { id: string; task: string; completed: boolean; seconds: number }[]; synthetic: boolean };
    const people = new Set(participants.map((p) => p.id));
    const done = participants.filter((p) => p.completed);
    const t = done.map((p) => p.seconds).sort((a, b) => a - b);
    const valid = !synthetic && people.size >= MIN_PARTICIPANTS;
    return { name: r.name, participants: people.size, attempts: participants.length, completion: iv(done.length, participants.length), medianSeconds: t.length ? t[Math.floor(t.length / 2)] : null, status: synthetic ? "SYNTHETIC_DATA" as const : valid ? "VALID_STUDY" as const : "TOO_FEW_PARTICIPANTS" as const, note: synthetic ? "These records are generated to exercise the analysis; they are not a study." : valid ? "" : `${people.size} participants; the protocol needs ${MIN_PARTICIPANTS} before any completion rate is reported as a finding.` };
  }
}
const pct = (i: Interval) => (i.value === null ? "n/a" : `${Math.round(i.value * 100)}%`);

/** A deliberately worse model, for proving the regression check catches a degraded one: it drops what it was asked to find. */
export class DegradedProvider implements ModelProvider {
  readonly name = "degraded"; readonly model = "drops-cards"; readonly hosted = false;
  private inner = new StubProvider();
  async generate(req: Parameters<ModelProvider["generate"]>[0]) {
    const out: any = await this.inner.generate(req);
    if (req.schemaId === "concepts.v1") out.cards = out.cards.filter((_: unknown, i: number) => i % 3 === 0);
    return out;
  }
}
