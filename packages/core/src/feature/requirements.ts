// Task 2.I — requirement normalisation (spec §6; PF-005, PF-006, PF-007; AT-04, AT-05).
// The model proposes (task 1.G); code decides what is trusted:
//   * ids are renumbered deterministically (R1.., AC1.., A1..) so a re-run of the same output has the same ids
//   * a requirement is ACTIVE/USER only when its words are actually found in the source it cites; otherwise it stays a PROPOSED assumption
//   * vague terms ("fast", "secure", "all"), non-atomic statements and missing permission rules become findings, never silent choices
//   * an assumption is material (needs a decision) or low-impact (visible, reversible, progress continues); never auto-promoted
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { loadAuthority, authorityPolicyHash } from "./authority.ts";
import { rawHash } from "./canon.ts";
import { loadFeatureConfig } from "./config.ts";
import { contractHashOf, contractIdOf } from "./decisions.ts";
import { FeatureError } from "./errors.ts";
import { applyBlocking, findingId, opt, saveFindings, scopeOfKind } from "./findings.ts";
import { snapshotOf } from "./intake.ts";
import { eventFor } from "./lifecycle.ts";
import { FeatureModelAdapter, type ContextArtifact } from "./model.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { Store } from "../store.ts";
import type { Assumption, FeatureContract, FeatureContractDraft, FeatureRecord, Id, Outcome, Requirement, RequirementFinding, SourceRef } from "./types.ts";

export const GROUNDING_THRESHOLD = 0.5;
const STOP = new Set(["that", "this", "with", "from", "have", "will", "shall", "must", "should", "when", "then", "than", "into", "their", "there", "which", "while", "each", "every", "only", "also", "been", "being", "were", "your", "they", "them", "does", "would", "could", "about", "such", "other", "these", "those", "user", "users", "system", "feature"]);
const words = (t: string): string[] => (t.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ""));

/** Share of the requirement's content words that appear in the source text (0..1). Computed by code; a model cannot claim it. */
export function grounding(requirement: string, source: string): number {
  const need = [...new Set(words(requirement))]; if (!need.length) return 0;
  const have = new Set(words(source)); return need.filter((w) => have.has(w)).length / need.length;
}

interface Vague { re: RegExp; kind: "AMBIGUITY" | "GAP"; rule: string; impact: "HIGH" | "MEDIUM" | "LOW"; why: string; options: [string, string][] }
export const VAGUE_TERMS: Vague[] = [
  { re: /\b(all|every|any|everyone|everything|entire)\b/i, kind: "AMBIGUITY", rule: "scope-all", impact: "HIGH", why: "\"all\" has no stated scope (the requester's own data, one tenant, or the whole system)", options: [["own", "All records the requester is allowed to see"], ["tenant", "All records in the current tenant"], ["system", "All records in the system (needs global access)"]] },
  { re: /\b(fast|quick(ly)?|instant(ly)?|real[- ]time|low[- ]latency|responsive)\b/i, kind: "AMBIGUITY", rule: "vague-performance", impact: "MEDIUM", why: "performance is stated without a measurable criterion", options: [["measure", "State the metric, workload and limit (for example p95 latency for a stated row count)"], ["no-claim", "Make no performance claim for this feature"]] },
  { re: /\b(secure(ly)?|safe(ly)?|protected|compliant)\b/i, kind: "AMBIGUITY", rule: "vague-security", impact: "HIGH", why: "security is stated without a checkable property", options: [["property", "Name the property (who can read, what is logged, what is encrypted)"], ["policy", "Point to the policy this must satisfy"]] },
  { re: /\b(large|huge|big|small|many|few|scalable|at scale)\b/i, kind: "AMBIGUITY", rule: "vague-size", impact: "MEDIUM", why: "a size is stated without a number", options: [["number", "State the expected and the maximum size"]] },
  { re: /\b(easy|simple|intuitive|user[- ]friendly|robust|reliable|efficient|appropriate|reasonable|as needed|etc\.?|and so on)\b/i, kind: "AMBIGUITY", rule: "vague-quality", impact: "LOW", why: "a quality word has no observable meaning", options: [["observable", "Describe the observable behaviour that would show it"]] },
  { re: /\b(always|never)\b/i, kind: "AMBIGUITY", rule: "vague-absolute", impact: "MEDIUM", why: "an absolute cannot be verified; its conditions and exceptions are not stated", options: [["conditions", "State the conditions under which it must hold, and the exceptions"]] },
];
const SENSITIVE_ACTION = /\b(export|download|email|e-mail|send|share|publish|delete|remove|refund|pay|payment|transfer|approve|invite|impersonat\w*)\b/i;
const MODAL = /\b(must|shall|should|will|needs? to|has to)\b/gi;

export interface NormalizeDeps { fs: SqliteFeatureStore; store: Store; adapter?: (requestId: Id) => FeatureModelAdapter }
const CTX_FILES = 10, CTX_BYTES = 200_000;

function contextFor(repoRoot: string, refs: SourceRef[]): ContextArtifact[] {
  if (!Array.isArray(refs) || refs.length > CTX_FILES) throw new FeatureError("INVALID_SCHEMA", `at most ${CTX_FILES} source references`);
  const root = realpathSync(repoRoot); const out: ContextArtifact[] = [];
  for (const r of refs) {
    if (!r || typeof r.locator !== "string" || !r.locator.startsWith("repo:")) throw new FeatureError("INVALID_SCHEMA", "only repository files (repo:path) can be read as sources here");
    const rel = r.locator.slice(5);
    if (!rel || isAbsolute(rel) || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) throw new FeatureError("INVALID_SCHEMA", `unsafe source path in ${r.artifactId}`);
    let real: string; try { real = realpathSync(resolve(root, rel)); } catch { throw new FeatureError("NOT_FOUND", `source ${rel} does not exist`); }
    if (real !== root && !real.startsWith(root + sep)) throw new FeatureError("FORBIDDEN", `source ${rel} resolves outside the repository`);
    if (!lstatSync(real).isFile()) throw new FeatureError("INVALID_SCHEMA", `source ${rel} is not a file`);
    const bytes = readFileSync(real); if (bytes.length > CTX_BYTES) throw new FeatureError("RESOURCE_LIMIT", `source ${rel} is larger than ${CTX_BYTES} bytes`);
    const text = bytes.toString("utf8"); if (rawHash(text) !== r.contentHash) throw new FeatureError("STALE_REVISION", `${rel} changed since it was referenced`);
    out.push({ ref: r, text });
  }
  return out;
}

/** The deterministic checks over a drafted contract. Pure; the same contract always yields the same findings. */
export function checkDraft(contract: Pick<FeatureContract, "requirements" | "acceptance" | "assumptions">, sourceOf: (r: Requirement) => string): { findings: RequirementFinding[]; ungrounded: Id[] } {
  const findings: RequirementFinding[] = []; const ungrounded: Id[] = [];
  const add = (f: Omit<RequirementFinding, "id" | "status" | "blockingTaskIds" | "sourceRefs" | "detector" | "scope"> & { rule: string; key: string; status?: RequirementFinding["status"]; scope?: string }, sourceRefs: SourceRef[]) => {
    const { key, status, scope, ...rest } = f; findings.push({ ...rest, id: findingId(f.rule, key, ...f.requirementIds), status: status ?? "POTENTIAL", blockingTaskIds: [], sourceRefs, detector: "DETERMINISTIC", scope: scope ?? scopeOfKind(f.kind) });
  };
  for (const r of contract.requirements) {
    const g = grounding(r.text, sourceOf(r)); r.grounding = Number(g.toFixed(2));
    if (g < GROUNDING_THRESHOLD) { ungrounded.push(r.id); add({ kind: "GAP", requirementIds: [r.id], explanation: `${r.id} is not supported by the source it cites: only ${Math.round(g * 100)}% of its content words appear there, so it stays a proposed assumption until a person confirms it.`, rule: "ungrounded", key: "g", impact: "HIGH", witness: `"${r.text.slice(0, 120)}"`,
      options: [opt("confirm", "Confirm this requirement (records who accepted it)", "business"), opt("drop", "Remove this requirement from the contract", "business")] }, [r.source]); }
    const texts: [string, string][] = [[r.id, r.text], ...contract.acceptance.filter((a) => a.requirementIds.includes(r.id)).map((a) => [a.id, `${a.scenario}. ${a.expectedOutcome}`] as [string, string])];
    for (const v of VAGUE_TERMS) {
      const hitIn = texts.find(([, t]) => v.re.test(t)); if (!hitIn) continue;
      const m = v.re.exec(hitIn[1])![0];
      add({ kind: v.kind, requirementIds: [r.id], explanation: `${hitIn[0]}: ${v.why} ("${m}").`, rule: v.rule, key: m.toLowerCase(), impact: v.impact, witness: `"${hitIn[1].slice(0, 140)}"`, options: v.options.map(([id, d]) => opt(id, d, "business")) }, [r.source]);
    }
    const modals = (r.text.match(MODAL) ?? []).length;
    if (modals > 1 || /;\s*\S/.test(r.text)) add({ kind: "AMBIGUITY", requirementIds: [r.id], explanation: `${r.id} states more than one obligation, so it cannot be met or tested as one unit.`, rule: "compound", key: "c", impact: "LOW", witness: `"${r.text.slice(0, 140)}"`, options: [opt("split", "Split it into one requirement per obligation (the original statement is kept as the source)", "business")] }, [r.source]);
  }
  const sensitive = contract.requirements.filter((r) => SENSITIVE_ACTION.test(r.text) && r.type !== "ACCESS");
  if (sensitive.length && !contract.requirements.some((r) => r.type === "ACCESS")) add({ kind: "GAP", requirementIds: sensitive.map((r) => r.id), explanation: `No permission rule is stated for ${sensitive.map((r) => `${r.id} (${SENSITIVE_ACTION.exec(r.text)![0]})`).join(", ")}: who may do this, and over which data?`, rule: "missing-access-rule", key: "m", impact: "HIGH", scope: "access",
    options: [opt("role", "Name the roles that may perform it", "access"), opt("existing", "Reuse the permission that already guards the existing equivalent action", "access")] }, sensitive.map((r) => r.source));
  return { findings, ungrounded };
}

const MATERIAL = /\b(permission|access|role|tenant|delete|remove|retention|export|email|send|payment|refund|price|limit|threshold|privacy|personal|encrypt|audit|compliance|migration|schema|external|third[- ]party|api contract)\b/i;
/** PF-007/AT-05: material unknowns need a decision; low-impact reversible ones are visible assumptions and work continues. */
export function classifyAssumption(a: Assumption, affected: readonly Requirement[]): "MATERIAL" | "LOW_IMPACT" {
  if (!a.reversible || MATERIAL.test(a.text) || affected.some((r) => ["ACCESS", "DATA", "INVARIANT", "INTEGRATION"].includes(r.type))) return "MATERIAL";
  return "LOW_IMPACT";
}

export async function normalizeRequirements(d: NormalizeDeps, actor: Id, i: { requestId: Id; sourceRefs: SourceRef[]; assessmentId: Id; signal?: AbortSignal }): Promise<Outcome<FeatureContractDraft>> {
  const rec = d.fs.getRequest(i.requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (rec.state !== "CONTRACTING") throw new FeatureError("ILLEGAL_TRANSITION", `requirements are normalised after discovery; the request is ${rec.state}`);
  if (!rec.assessment || rec.assessment.id !== i.assessmentId) throw new FeatureError("STALE_REVISION", "the repository assessment changed or does not exist; run discovery again");
  if (snapshotOf(d.store, rec.repositoryId).contentRootHash !== rec.source.contentRootHash) throw new FeatureError("STALE_REVISION", "the repository changed since discovery; run it again");
  if (!rec.promptRef.text) throw new FeatureError("INVALID_SCHEMA", "the request has no prompt text to normalise");
  const context = contextFor(rec.repositoryId, i.sourceRefs ?? []);
  let auth; try { auth = loadAuthority(rec.repositoryId, loadFeatureConfig(rec.repositoryId).authorityFile); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `authority or feature configuration is invalid: ${(e as Error).message}`); }
  const egress = loadFeatureConfig(rec.repositoryId).egress;
  const adapter = d.adapter?.(rec.requestId) ?? new FeatureModelAdapter(d.fs, rec.requestId, { egress });
  const gen = await adapter.generate({ prompt: rec.promptRef.text, context, authorityPolicyHash: authorityPolicyHash(auth), actor, signal: i.signal, draftOnly: true });
  if (gen.status !== "COMPLETE" || !gen.value) return { status: gen.status === "STALE" ? "STALE" : gen.status === "CANCELLED" ? "CANCELLED" : "FAILED", evidenceIds: gen.evidenceIds, diagnostics: [...gen.diagnostics, "no contract was recorded; deterministic request work is unaffected"] };

  // ---- renumber deterministically and rewrite every reference
  const draft = gen.value.draft.contract;
  const rmap = new Map(draft.requirements.map((r, n) => [r.id, `R${n + 1}`])), amap = new Map(draft.acceptance.map((a, n) => [a.id, `AC${n + 1}`])), smap = new Map(draft.assumptions.map((a, n) => [a.id, `A${n + 1}`]));
  const R = (id: string) => rmap.get(id) ?? id, A = (id: string) => amap.get(id) ?? id;
  const sources = [{ ref: { artifactId: rec.promptRef.artifactId, contentHash: rec.promptRef.contentHash, version: "1", locator: "prompt" }, text: rec.promptRef.text }, ...context];
  const textOfSource = (r: Requirement): string => sources.find((s) => s.ref.contentHash === r.source.contentHash && s.ref.locator === r.source.locator)?.text ?? rec.promptRef.text!;
  const requirements: Requirement[] = draft.requirements.map((r) => ({ ...r, id: R(r.id), dependsOn: r.dependsOn.map(R), acceptanceIds: draft.acceptance.filter((a) => a.requirementIds.includes(r.id)).map((a) => A(a.id)) }));
  const acceptance = draft.acceptance.map((a) => ({ ...a, id: A(a.id), requirementIds: a.requirementIds.map(R) }));
  const assumptions: Assumption[] = draft.assumptions.map((a) => ({ ...a, id: smap.get(a.id) ?? a.id, affectedIds: a.affectedIds.map(R) }));
  const { findings, ungrounded } = checkDraft({ requirements, acceptance, assumptions }, textOfSource);
  for (const r of requirements) if (!ungrounded.includes(r.id)) { r.origin = "USER"; r.status = "ACTIVE"; }
  const material: Id[] = [];
  for (const a of assumptions) if (classifyAssumption(a, requirements.filter((r) => a.affectedIds.includes(r.id))) === "MATERIAL") {
    material.push(a.id);
    findings.push({ id: findingId("material-assumption", a.id, a.text), kind: "GAP", requirementIds: a.affectedIds, sourceRefs: [], scope: scopeOfKind("GAP"), explanation: `${a.id} is an assumption the request does not settle and that could change what is built: "${a.text.slice(0, 140)}".`, witness: a.rationale ? a.rationale.slice(0, 140) : undefined, status: "POTENTIAL", blockingTaskIds: [], detector: "DETERMINISTIC", rule: "material-assumption", impact: "HIGH",
      options: [opt("accept", "Accept the assumption as stated (recorded with who accepted it)", "business"), opt("change", "State a different rule", "business")] });
  }

  const cur = d.fs.getRequest(rec.requestId)!;
  const version = cur.contractVersion + 1;
  const body: Omit<FeatureContract, "hash"> = { schemaVersion: 1, id: contractIdOf(rec.requestId), version, requestId: rec.requestId, snapshot: rec.source, requirements, acceptance, assumptions, obligationIds: [...new Set(findings.map((f) => f.id))].sort(), authorityPolicyHash: authorityPolicyHash(auth) };
  const contract: FeatureContract = { ...body, hash: contractHashOf(body) };
  const stale: Id[] = [];
  for (const c of d.fs.listCandidates(rec.requestId)) if (c.status === "MATERIALIZED" || c.status === "PLANNED") { d.fs.putCandidate({ ...c, status: "STALE" }, eventFor(cur, "VerificationInvalidated", actor, { before: c.bindingHash, rationale: `the contract was re-derived (version ${version})` })); stale.push(c.id); }
  const after = d.fs.getRequest(rec.requestId)!;
  d.fs.updateRequest(rec.requestId, after.version, { ...after, contract, contractVersion: version, workspace: { ...after.workspace, contractHash: contract.hash, candidateHash: stale.length ? undefined : after.workspace.candidateHash, workspaceVersion: after.workspace.workspaceVersion + 1 } },
    eventFor(cur, "ContractVersionCreated", actor, { before: cur.contract?.hash, after: contract.hash, rationale: `version ${version}: ${requirements.length} requirement(s), ${acceptance.length} criteria, ${findings.length} finding(s); ${requirements.filter((r) => r.status === "ACTIVE").length} grounded in the source` }));
  saveFindings(d.fs, rec.requestId, actor, findings, new Set(["ungrounded", "scope-all", "vague-performance", "vague-security", "vague-size", "vague-quality", "vague-absolute", "compound", "missing-access-rule", "material-assumption"]), "normalisation");
  const state = applyBlocking(d.fs, rec.requestId, actor);
  return { status: "COMPLETE", value: { schemaVersion: 1, id: `draft:${contract.hash.split(":").pop()!.slice(0, 24)}`, contract, findingIds: findings.map((f) => f.id) }, evidenceIds: gen.evidenceIds,
    diagnostics: [...gen.diagnostics, ...(stale.length ? [`${stale.length} candidate(s) built from the previous contract are stale`] : []), ...(material.length ? [`${material.length} assumption(s) need a decision before work that depends on them`] : []), ...(state.blocked.length ? [`${state.blocked.length} task(s) are held by open items; ${state.independent.length} independent task(s) continue`] : [])] };
}
