// The MVP's pass/fail gate (spec S5 "MVP demo bar"), executable. Run with `npm run eval`.
// It measures: all six demo steps pass; median synthesis time; and zero silently-wrong provenance in what is displayed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createProvider, resolveModel, StubProvider } from "@cie/model";
import type { CallContext, Claim, ModelProvider, ViewSpec } from "@cie/schema";
import { routerFor, type RouterModel } from "./llm-router.ts";
import { Service } from "./service.ts";
import { Store } from "./store.ts";
import { WorkerClient } from "./worker.ts";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const ctx = (): CallContext => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), actor: { principalId: "eval", tenantId: "local", sessionId: "eval" }, deadlineMs: Date.now() + 120_000, traceId: "eval" });

export interface StepResult { id: number; name: string; pass: boolean; detail: string; ms: number }
export interface DemoBarReport { provider: string; steps: StepResult[]; medianSynthesisMs: number; maxSynthesisMs: number; provenanceViolations: string[]; passed: boolean }

/** Every displayed element must be traceable, and traceable to something that actually says what is claimed. */
export function provenanceAudit(svc: Service, view: ViewSpec, claims: Record<string, Claim>): string[] {
  const rev = svc.store.revision(view.revision)!;
  const bad: string[] = [];
  const check = (what: string, ids: string[], needs: "static" | "any") => {
    if (ids.length === 0) { bad.push(`${what}: cites no evidence`); return; }
    for (const id of ids.slice(0, 6)) {
      const ev = svc.store.evidence(rev.id, id);
      if (!ev) { bad.push(`${what}: evidence ${id} does not exist`); continue; }
      if (needs === "static" && !ev.class.startsWith("STATIC") && ev.class !== "HISTORY") bad.push(`${what}: shown as fact but evidence is ${ev.class}`);
      const r = svc.resolveEvidence(rev, ev);
      if (r.state !== "CURRENT") bad.push(`${what}: evidence ${id} is ${r.state}`);
    }
  };
  const label = new Map(view.nodes.map((n) => [n.id, n]));
  for (const e of view.edges) {
    const name = `edge ${label.get(e.fromNodeId)?.label ?? e.fromNodeId}→${label.get(e.toNodeId)?.label ?? e.toNodeId}`;
    if (e.displayMode === "FACT") {
      if (e.claimId) bad.push(`${name}: shown as FACT but backed by a model/pipeline claim`);
      check(name, e.evidenceIds, "static");
      // A call edge's evidence must actually mention the callee.
      if (e.kind === "calls") {
        const target = label.get(e.toNodeId)?.label.split(".").pop() ?? "";
        const text = e.evidenceIds.slice(0, 3).map((id) => svc.resolveEvidence(rev, svc.store.evidence(rev.id, id)!).snippet).join(" ");
        if (target && !text.includes(target)) bad.push(`${name}: evidence does not mention "${target}"`);
      }
    } else if (e.displayMode === "INFERENCE" || e.displayMode === "HYPOTHESIS") {
      const c = e.claimId ? claims[e.claimId] ?? svc.store.getClaim(e.claimId) : undefined;
      if (!c) bad.push(`${name}: shown as ${e.displayMode} without a claim`);
      else if (c.gates.length !== 5) bad.push(`${name}: claim did not pass through all five gates`);
      else if (c.displayMode === "HIDDEN") bad.push(`${name}: a withheld claim is displayed`);
      check(name, e.evidenceIds, "any");
    }
  }
  for (const n of view.nodes) {
    if (n.role === "state" || n.role === "symptom") { check(`node ${n.label}`, n.evidenceIds, "any"); continue; }
    check(`node ${n.label}`, n.evidenceIds, "any");
    for (const cid of n.claimIds) { const c = claims[cid] ?? svc.store.getClaim(cid); if (c?.displayMode === "HIDDEN") bad.push(`node ${n.label}: backed by a withheld claim`); }
  }
  // A matrix is a second drawing of the same facts and claims, so it obeys the same rules as nodes and edges.
  if (view.matrix) {
    const rows = new Map(view.matrix.rows.map((r) => [r.id, r])), cols = new Map(view.matrix.cols.map((c) => [c.id, c]));
    for (const ax of [...view.matrix.rows, ...view.matrix.cols]) if (ax.evidenceIds.length) check(`matrix ${ax.label}`, ax.evidenceIds, "any");
    for (const cell of view.matrix.cells) {
      const name = `cell ${rows.get(cell.row)?.label ?? cell.row} × ${cols.get(cell.col)?.label ?? cell.col}`;
      if (!rows.has(cell.row) || !cols.has(cell.col)) { bad.push(`${name}: refers to a row or column that does not exist`); continue; }
      if (!view.matrix.states[cell.state]) bad.push(`${name}: state ${cell.state} is not explained`);
      if (cell.displayMode === "FACT") {
        if (cell.claimId) bad.push(`${name}: shown as FACT but backed by a model/pipeline claim`);
        check(name, cell.evidenceIds, "static");
      } else if (cell.displayMode === "INFERENCE" || cell.displayMode === "HYPOTHESIS") {
        const c = cell.claimId ? claims[cell.claimId] ?? svc.store.getClaim(cell.claimId) : undefined;
        if (!c) bad.push(`${name}: shown as ${cell.displayMode} without a claim`);
        else if (c.gates.length !== 5) bad.push(`${name}: claim did not pass through all five gates`);
        else if (c.displayMode === "HIDDEN") bad.push(`${name}: a withheld claim is displayed`);
        check(name, cell.evidenceIds, "any");
      }
    }
  }
  return bad;
}

function need(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> { const t = performance.now(); const r = await fn(); return [r, Math.round(performance.now() - t)]; }

export async function runDemoBar(opts: { provider?: ModelProvider; dir?: string; router?: RouterModel | null } = {}): Promise<DemoBarReport> {
  const provider = opts.provider ?? new StubProvider();
  const work = opts.dir ?? mkdtempSync(join(tmpdir(), "cie-demobar-"));
  if (!opts.dir) process.once("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });
  const repo = join(work, "payments-app");
  execFileSync("bash", [join(ROOT, "scripts_make_demo_repo.sh"), repo], { stdio: "pipe" });
  const dbPath = join(work, "eval.db");
  const steps: StepResult[] = [];
  const synth: number[] = [];
  const violations: string[] = [];
  const claimsOf = (cs: Claim[]) => Object.fromEntries(cs.map((c) => [c.draft.id, c]));

  const w1 = new WorkerClient();
  const svc = new Service(new Store(dbPath), w1, provider);
  svc.router = opts.router ?? null;
  const run = async (id: number, name: string, fn: () => Promise<string>) => {
    const t = performance.now();
    try { const detail = await fn(); steps.push({ id, name, pass: true, detail, ms: Math.round(performance.now() - t) }); }
    catch (e) { steps.push({ id, name, pass: false, detail: (e as Error).message, ms: Math.round(performance.now() - t) }); }
  };

  try {
    const ing = await svc.ingestRepository(ctx(), { repoPath: repo });
    need(ing.ok, "index failed");
    const revision = ing.ok ? ing.value.id : "";
    if (provider.hosted) { svc.setEgress(ctx(), { repoRoot: repo, allow: true }); }
    await svc.extractConcepts(ctx(), { revision });

    // The auth map is shown on the small auth fixture so step 1 can be compared with the payments views.
    const authSvc = new Service(new Store(":memory:"), new WorkerClient(), provider);
    authSvc.router = opts.router ?? null;
    const authRepo = join(ROOT, "fixtures/sample-repo");
    await authSvc.ingestRepository(ctx(), { repoPath: authRepo });
    if (provider.hosted) authSvc.setEgress(ctx(), { repoRoot: authRepo, allow: true });

    let q3View: ViewSpec | null = null;
    await run(3, "“Why could this balance become incorrect?” → invariant map with writers, tx paths and a non-obvious async path", async () => {
      const [r, ms] = await timed(() => svc.ask(ctx(), { question: "Why could this balance become incorrect?", revision })); synth.push(ms);
      need(r.ok, "ask failed"); const v = r.value.view; q3View = v;
      need(v.formId === "CausalGraph" && v.meta?.kind === "invariant", `expected an invariant CausalGraph, got ${v.formId}`);
      const writers = v.nodes.filter((n) => n.role === "writer");
      need(writers.length >= 3, `expected ≥3 writers, got ${writers.length}`);
      need(writers.some((n) => (n.notes ?? []).join(" ").includes("outside a transaction")), "no non-transactional writer found");
      const hidden = writers.find((n) => (n.notes ?? []).join(" ").includes("asynchronous"));
      need(hidden, "no writer reached through an async hand-off");
      violations.push(...provenanceAudit(svc, v, claimsOf(r.value.claims)));
      return `${writers.length} writers; non-obvious async path to ${hidden!.label}`;
    });

    await run(1, "“Show me how authentication works” → a map at a different abstraction than the balance question", async () => {
      const [r, ms] = await timed(() => authSvc.ask(ctx(), { question: "Show me how authentication works" })); synth.push(ms);
      need(r.ok, "ask failed"); const v = r.value.view;
      need(v.formId === "SemanticMap", `expected SemanticMap, got ${v.formId}`);
      need(q3View && q3View.formId !== v.formId, "not visibly question-relative: same form as the balance view");
      need(v.nodes.length >= 5 && v.groups.some((g) => g.kind === "concept"), "map lacks grouped structure");
      const authRev = authSvc.store.latestRevision()!.id;
      const sample = r.value.view.nodes.find((n) => n.claimIds.length === 0 && n.displayMode === "FACT");
      need(sample, "no deterministic fact node"); void authRev;
      violations.push(...provenanceAudit(authSvc, v, claimsOf(r.value.claims)));
      return `${v.nodes.length} symbols in ${v.groups.filter((g) => g.kind === "concept").length} concept groups (${v.formId})`;
    });

    await run(2, "“Show me everything that could cause a payment to fail” → causal graph with ≥1 failure mode nobody expected, every edge citable", async () => {
      const [r, ms] = await timed(() => svc.ask(ctx(), { question: "Show me everything that could cause a payment to fail", revision })); synth.push(ms);
      need(r.ok, "ask failed"); const v = r.value.view;
      need(v.formId === "CausalGraph" && v.meta?.kind === "failure", `expected a failure CausalGraph, got ${v.formId}`);
      const sites = v.nodes.filter((n) => n.role === "failure-site");
      const surprising = sites.filter((n) => (n.notes ?? []).join(" ").includes("async"));
      need(sites.length >= 4, `expected ≥4 failure sites, got ${sites.length}`);
      need(surprising.length >= 1, "no failure mode reachable only through an async hand-off");
      need(v.edges.every((e) => e.evidenceIds.length > 0), "an edge cites no evidence");
      violations.push(...provenanceAudit(svc, v, claimsOf(r.value.claims)));
      return `${sites.length} failure modes; non-obvious: ${surprising.map((n) => n.label).join(", ")}`;
    });

    let hyp: ViewSpec | null = null;
    const trace = `FraudRejectedError: acct-9 over limit
    at checkFraud (${repo}/src/payments/fraud.ts:5:18)
    at charge (${repo}/src/payments/payment-service.ts:10:3)
    at createPayment (${repo}/src/api/payments-controller.ts:6:11)
    at Layer.handle (/usr/lib/node_modules/express/lib/router/layer.js:95:5)`;
    await run(4, "Seeded exception → hypothesis graph with ranked suspects + evidence; two steering turns work", async () => {
      const t0 = performance.now();
      const r = await svc.converse(ctx(), { text: trace, revision }); synth.push(Math.round(performance.now() - t0));
      need(r.ok && r.value.kind === "view" && r.value.view.formId === "HypothesisGraph", "trace did not open a hypothesis graph");
      const v = r.value.view; hyp = v;
      const suspects = v.nodes.filter((n) => n.role === "suspect");
      need(suspects.length >= 3 && suspects.every((s) => s.factors?.length === 6 && s.evidenceIds.length > 0), "suspects are not ranked with six cited factors");
      need(suspects.some((s) => s.hypothesisState === "SUPPORTED"), "no suspect is supported by stack + throw site");
      violations.push(...provenanceAudit(svc, v, claimsOf(r.value.claims)));
      const first = suspects.sort((a, b) => a.rank! - b.rank!)[0];
      const s1 = await svc.converse(ctx(), { text: `ignore ${first.label}`, view: v });
      need(s1.ok && s1.value.kind === "view" && !s1.value.view.nodes.some((n) => n.label === first.label) && s1.value.view.version === v.version + 1, "“ignore X” did not re-rank");
      const next = s1.ok && s1.value.kind === "view" ? s1.value.view.nodes.find((n) => n.role === "suspect")! : first;
      const s2 = await svc.converse(ctx(), { text: `why do you suspect ${next.label}?`, view: s1.ok && s1.value.kind === "view" ? s1.value.view : v });
      need(s2.ok && s2.value.kind === "explanation" && s2.value.explanation.evidence.length > 0, "“why do you suspect Y?” gave no cited answer");
      return `${suspects.length} suspects; ignored ${first.label}, then explained ${next.label}`;
    });

    await run(5, "Select any element → “why are you showing this?” answers with citations; inferred edges are distinguishable", async () => {
      need(hyp, "needs step 4");
      const node = hyp!.nodes.find((n) => n.role === "suspect")!;
      const r = await svc.converse(ctx(), { text: "why are you showing this?", view: hyp!, selection: [node.id] });
      need(r.ok && r.value.kind === "explanation", "no explanation");
      const ex = r.value.kind === "explanation" ? r.value.explanation : null;
      need(ex && ex.evidence.length > 0 && ex.claims.length > 0, "answer has no citations");
      const modes = new Set(hyp!.edges.map((e) => e.displayMode));
      need(modes.has("FACT") && (modes.has("INFERENCE") || modes.has("HYPOTHESIS")), "inferred edges are not visually distinguishable from facts");
      return `cited ${ex!.evidence.length} evidence item(s); edge modes: ${[...modes].join(", ")}`;
    });

    await run(6, "Kill the session; return tomorrow → “continue the payment investigation” restores state and reports what changed", async () => {
      need(hyp, "needs step 4");
      const saved = svc.saveWorkspace(ctx(), { name: "Payment failure investigation", expectedVersion: 0, revision: hyp!.revision, state: { question: hyp!.question, view: hyp, claims: [], selection: [], explanation: null, events: [], messages: [{ role: "user", text: "paste", at: "" }] } });
      need(saved.ok, "save failed");
      // Someone changes the repository while the session is closed.
      const ledger = join(repo, "src/ledger/ledger.ts");
      writeFileSync(ledger, readFileSync(ledger, "utf8").replace("account.balance += delta;", "account.balance = Math.max(0, account.balance + delta);"));
      execFileSync("git", ["-C", repo, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", "Hotfix: guard negative balances"], { stdio: "pipe" });
      w1.close();
      // A brand-new process: new worker, new Service, same database file.
      const w2 = new WorkerClient();
      try {
        const svc2 = new Service(new Store(dbPath), w2, provider);
        svc2.router = opts.router ?? null;
        const c = await svc2.converse(ctx(), { text: "continue the payment investigation", view: null });
        need(c.ok && c.value.kind === "resume", "did not resume the investigation");
        const id = c.ok && c.value.kind === "resume" ? c.value.workspaceId : "";
        const o = svc2.openWorkspace(ctx(), { workspaceId: id });
        need(o.ok && o.value.state.view?.id === hyp!.id && (o.value.state.messages?.length ?? 0) === 1, "saved state was not restored exactly");
        const ch = await svc2.changesSince(ctx(), { workspaceId: id });
        need(ch.ok && ch.value.changed && ch.value.files.changed.includes("src/ledger/ledger.ts"), "did not report the changed file");
        need(ch.ok && ch.value.commits.some((x) => x.subject.startsWith("Hotfix") && x.author === "Sam"), "did not report the new commit");
        return ch.ok ? ch.value.summary : "";
      } finally { w2.close(); }
    });
  } finally { w1.close(); }

  const sorted = [...synth].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  steps.sort((a, b) => a.id - b.id);
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  const passed = steps.length === 6 && steps.every((s) => s.pass) && violations.length === 0 && median < 10_000 && max < 30_000;
  return { provider: `${provider.name}/${provider.model}`, steps, medianSynthesisMs: median, maxSynthesisMs: max, provenanceViolations: violations, passed };
}

export function formatReport(r: DemoBarReport): string {
  const lines = [`MVP demo bar · provider ${r.provider}`, ""];
  for (const s of r.steps) lines.push(`${s.pass ? "PASS" : "FAIL"}  ${s.id}. ${s.name}\n      ${s.detail}  (${s.ms} ms)`);
  lines.push("", `synthesis time: median ${r.medianSynthesisMs} ms (target < 10000), slowest ${r.maxSynthesisMs} ms (the model-backed map question; the causal and hypothesis forms are deterministic)`);
  lines.push(`provenance violations: ${r.provenanceViolations.length}${r.provenanceViolations.length ? "\n  - " + r.provenanceViolations.slice(0, 10).join("\n  - ") : ""}`);
  lines.push("", r.passed ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A one-shot eval run, with no persisted choice of its own: whatever `ollama list` reports first, each time.
  const resolved = await resolveModel(null);
  if (resolved.note) console.warn(resolved.note);
  const { provider, note } = await createProvider({ which: process.env.CIE_PROVIDER, model: resolved.model });
  if (note) console.warn(note);
  const router = routerFor(resolved.model);
  const report = await runDemoBar({ provider, router });
  console.log(formatReport(report));
  process.exit(report.passed ? 0 : 1);
}
