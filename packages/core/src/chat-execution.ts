import type { ApiResult, CallContext, ChatAnalysisResult, ConverseResult } from "@cie/schema";
import type { ChatPlan } from "./chat-plan.ts";
import type { Service } from "./service.ts";
import type { RevisionRow } from "./store.ts";
import { revisionIndex } from "./salience.ts";
import { projectDescription, projectProfile } from "./profile.ts";
import { isNonProductionFile, moduleTests } from "./module-tests.ts";
import { redactBuilt } from "./redact.ts";
import { policyFor } from "./access.ts";

/** Execute a validated plan against one revision. Completed results survive a
 * failed step; a missing dependency is never replaced with a guessed subject. */
export async function executeChatPlan(svc: Service, ctx: CallContext, rev: RevisionRow, plan: ChatPlan, currentSubject?: string, pins?: string[]): Promise<ApiResult<ConverseResult>> {
  const results: ChatAnalysisResult[] = [], warnings: string[] = [];
  const access = policyFor(svc.store, rev.repoRoot);
  for (const step of plan.steps) {
    const title = step.tool === "overview" ? "Project overview" : step.tool === "risk" ? "Change risk" : step.tool === "tests" ? "Tests" : step.form!;
    const record: ChatAnalysisResult = { tool: step.tool, title, status: "complete", message: "", claims: [] };
    if (Date.now() >= ctx.deadlineMs) { results.push({ ...record, status: "skipped", message: "The request deadline was reached before this analysis could start." }); continue; }
    // Sequential context: a test lookup with no explicit scope consumes the
    // latest risk result, even when the small planner omits fromStep. Failed
    // risk results are retained here, so we cannot accidentally use an old view.
    const lastRisk = step.tool === "tests" && !step.subject ? results.findLastIndex((r) => r.tool === "risk") : -1;
    const dependencyIndex = step.fromStep ?? (lastRisk >= 0 ? lastRisk : undefined);
    const dependency = dependencyIndex !== undefined ? results[dependencyIndex] : undefined;
    if (dependencyIndex !== undefined && (dependency?.status !== "complete" || !dependency.subject)) {
      results.push({ ...record, status: "skipped", message: `Step ${dependencyIndex + 1} did not provide a subject; this dependent analysis was not run.` }); continue;
    }
    const subject = dependency?.subject ?? step.subject ?? (step.tool === "tests" ? currentSubject : undefined);
    try {
      if (step.tool === "tests" && subject) {
        const built = redactBuilt(svc.store, rev, moduleTests(svc.store, rev, step.question, subject));
        record.view = built.view; record.claims = built.claims; record.subject = built.view.params?.subject as string;
        const links = built.view.nodes.filter((n) => n.role === "test");
        record.message = [built.view.caption, ...links.slice(0, 12).map((n) => `• ${n.file}${n.kind !== "file" ? ` — ${n.label}` : ""} (${n.badge})`), ...(links.length > 12 ? [`Open the Tests view for ${links.length - 12} more displayed links.`] : []), ...built.view.gaps].join("\n");
      } else {
        let seeds: string[] | undefined;
        if (step.tool === "overview") {
          const idx = revisionIndex(svc.store, rev.id);
          seeds = svc.store.entities(rev.id).filter((e) => ["function", "method", "class"].includes(e.kind) && !access.denied(e.file)).sort((a, b) => (idx.degree.get(b.entityId) ?? 0) - (idx.degree.get(a.entityId) ?? 0) || a.entityId.localeCompare(b.entityId)).slice(0, 30).map((e) => e.entityId);
        }
        const r = await svc.ask(ctx, { question: step.question, revision: rev.id, form: step.tool === "overview" ? "SemanticMap" : step.tool === "risk" ? "ChangeRisk" : step.tool === "tests" ? "TestConfidence" : step.form, kind: step.kind, subject, seeds, pins, ...(step.tool === "overview" ? { level: 1 } : {}) });
        if (!r.ok) throw new Error(r.error.message);
        warnings.push(...r.metadata.warnings);
        record.view = r.value.view; record.claims = r.value.claims;
        record.message = r.value.view.caption;
        if (step.tool === "overview") {
          // Profile prose includes folder names, so run it through the same access
          // redaction as the visual before adding it to the conversation.
          const profile = redactBuilt(svc.store, rev, { view: { ...r.value.view, caption: [projectDescription(svc.store, rev.repoRoot), projectProfile(svc.store, rev.id).text].filter(Boolean).join("\n") }, claims: [...r.value.claims] });
          record.message = `${profile.view.caption}\n${record.message}\n${r.value.view.gaps.join("\n")}`;
        }
        if (step.tool === "risk") {
          const terrain = r.value.view.terrain;
          if (!terrain?.cells.length) throw new Error("There are no accessible source files to rank.");
          const weights = terrain.factors;
          const total = weights.reduce((n, f) => n + f.weight, 0);
          const score = (c: typeof terrain.cells[number]) => weights.reduce((n, f) => n + f.weight * (c.factors[f.id] ?? 0.5), 0) / total;
          const ranked = terrain.cells.filter((c) => !isNonProductionFile(c.file) && !access.denied(c.file)).sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file));
          const top = ranked[0];
          if (!top) throw new Error("There are no production source files to rank.");
          record.subject = top.file;
          record.message = `Highest-ranked source file: ${top.file} — composite change-risk score ${(score(top) * 100).toFixed(1)}/100. Here “module” means one source file; this is not a module-directory ranking or a probability of failure.\n${weights.map((f) => `${f.label}: ${top.raw[f.id]} (weight ${f.weight})`).join("; ")}.\n${top.note ?? ""}\n${terrain.formula}`;
          if (ranked[1] && Math.abs(score(ranked[1]) - score(top)) < 1e-9) record.message += "\nMultiple files tie for first place; the file path breaks the tie.";
          r.value.view.params = { ...r.value.view.params, chatSubject: top.file };
        } else if (subject) record.subject = subject;
      }
      if (record.subject && access.denied(record.subject)) throw new Error("The selected subject is not accessible.");
      svc.store.audit(ctx.actor.principalId, "chat.tool", rev.id, { tool: step.tool, form: step.form, status: "complete" });
      results.push(record);
    } catch (e) {
      results.push({ tool: step.tool, title, status: "failed", message: (e as Error).message, claims: [] });
    }
  }
  const partial = results.some((r) => r.status !== "complete" || r.view?.gaps.length);
  return { ok: true, value: { kind: "analysis", results, message: results.map((r, i) => `${i + 1}. ${r.title}${r.status !== "complete" ? ` (${r.status})` : ""}\n${r.message}`).join("\n\n") }, metadata: { requestId: ctx.requestId, revision: rev.id, completeness: partial ? "PARTIAL" : "COMPLETE", warnings: [...new Set(warnings)] } };
}
