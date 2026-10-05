// Task 2.I — conflicts and constraints (spec §8; PF-010, PF-011, PF-013; AT-02, AT-03, AT-06).
// Pipeline order (§8.2): deterministic checks first; a model may PROPOSE more, but only code can CONFIRM, and only with a witness.
// Every contradiction passes an APPLICABILITY check: two statements about different tenants, roles or periods may both be true
// (AT-03), so they are not reported. Failure to find a conflict is never described as proof of consistency.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asSet, canonHash, defineSchema, rawHash, type Canon } from "./canon.ts";
import { ConfigError } from "./config.ts";
import { FeatureError } from "./errors.ts";
import { applyBlocking, findingId, opt, saveFindings, scopeOfKind } from "./findings.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord, FindingKind, Id, Outcome, Requirement, RequirementFinding, SourceRef } from "./types.ts";

const NEG = /\b(must not|shall not|should not|may not|cannot|can't|cannot ever|never|not allowed|not permitted|prohibited|forbidden|denied|disallow(?:ed)?|no one)\b/i;
const UNIVERSAL = /\b(all|every|any|entire|everything|everyone|global(?:ly)?|unfiltered|whole)\b/i;
const RESTRICT = /\b(only|filtered|subset|own|current|matching|limited to|restricted to|scoped|their own|just)\b/i;
const NOISE = new Set(["must", "shall", "should", "will", "never", "only", "allowed", "permitted", "allow", "allows", "able", "user", "users", "system", "feature", "have", "with", "that", "this", "from", "into", "the", "and", "for", "are", "not", "may", "can", "all", "every", "any", "entire", "everything", "everyone", "global", "unfiltered", "whole", "filtered", "subset", "own", "current", "matching", "limited", "restricted", "scoped", "their", "just", "cannot", "prohibited", "forbidden", "denied", "disallowed", "permission"]);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
const content = (t: string): Set<string> => new Set((t.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !NOISE.has(w)).map(stem));
const jaccard = (a: Set<string>, b: Set<string>): number => { const inter = [...a].filter((x) => b.has(x)).length; const uni = new Set([...a, ...b]).size; return uni ? inter / uni : 0; };
const numbers = (t: string): { n: number; unit: string }[] => [...t.matchAll(/\b(\d[\d,.]*)\s*(%|ms|s|seconds?|minutes?|hours?|days?|rows?|records?|mb|gb|kb|items?|requests?|attempts?|retries)?\b/gi)].map((m) => ({ n: Number(m[1]!.replace(/,/g, "")), unit: (m[2] ?? "").toLowerCase().replace(/s$/, "") })).filter((x) => Number.isFinite(x.n));

/** A statement compared by the detector: a requirement of this contract, or a line of a related source (policy, PRD). */
export interface Statement { id: string; text: string; actors: string[]; source: SourceRef; origin: "REQUIREMENT" | "RELATED"; locator: string }
const ROLES = /\b(admin(?:istrator)?|support|member|auditor|finance|manager|owner|guest|viewer|editor|operator|customer|merchant|agent)s?\b/gi;
const TENANT = /\b(?:tenant|org(?:anization)?|workspace|account)\s+([A-Za-z0-9_-]{1,32})\b/gi;
const PERIOD = /\b(Q[1-4]|20\d\d|19\d\d|monthly|weekly|daily|yearly|annual(?:ly)?|before \w+ \d{1,2}|after \w+ \d{1,2})\b/gi;
/** Who and when a statement is about. Different non-empty populations mean the statements may both be true. */
export function population(s: Pick<Statement, "text" | "actors">): Set<string> {
  const out = new Set<string>(s.actors.map((a) => `actor:${a.toLowerCase()}`));
  for (const m of s.text.matchAll(ROLES)) out.add(`actor:${m[1]!.toLowerCase()}`);
  for (const m of s.text.matchAll(TENANT)) if (!/^(is|has|can|may|must|only|own|id|data)$/i.test(m[1]!)) out.add(`tenant:${m[1]!.toLowerCase()}`);
  for (const m of s.text.matchAll(PERIOD)) out.add(`when:${m[1]!.toLowerCase()}`);
  return out;
}
export type Applicability = "SAME" | "DIFFERENT" | "UNKNOWN";
export function applicability(a: Pick<Statement, "text" | "actors">, b: Pick<Statement, "text" | "actors">): Applicability {
  const pa = population(a), pb = population(b);
  if (!pa.size && !pb.size) return "SAME";
  if (!pa.size || !pb.size) return "UNKNOWN";
  const sameKinds = (k: string) => [...pa].filter((x) => x.startsWith(k)).length && [...pb].filter((x) => x.startsWith(k)).length;
  for (const k of ["tenant:", "when:", "actor:"]) if (sameKinds(k) && ![...pa].some((x) => x.startsWith(k) && pb.has(x))) return "DIFFERENT";
  return [...pa].every((x) => pb.has(x)) && [...pb].every((x) => pa.has(x)) ? "SAME" : "UNKNOWN";
}

export const fromRequirement = (r: Requirement): Statement => ({ id: r.id, text: r.text, actors: r.actorIds, source: r.source, origin: "REQUIREMENT", locator: `${r.id} (${r.source.locator})` });
/** Statements of a related source: each line that states an obligation, with its line number as the locator. */
export function statementsOf(ref: SourceRef, text: string): Statement[] {
  return text.split("\n").flatMap((line, n) => /\b(must|shall|should|never|always|only|cannot|may not|not allowed|required|prohibited|forbidden)\b/i.test(line) && line.trim().length > 12 ? [{ id: `src:${ref.locator}:${n + 1}`, text: line.trim().replace(/^[-*#>\d.)\s]+/, ""), actors: [], source: ref, origin: "RELATED" as const, locator: `${ref.locator}:${n + 1}` }] : []);
}

export interface Candidate { rule: string; kind: FindingKind; a: Statement; b: Statement; confirmed: boolean; explanation: string; witness: string; impact: "HIGH" | "MEDIUM"; options: ReturnType<typeof opt>[] }
const quote = (s: Statement) => `"${s.text.slice(0, 140)}" (${s.locator})`;

/** Every pair of statements, checked by the deterministic rules. Pure and symmetric: the order of the inputs cannot change the result. */
export function compareStatements(statements: readonly Statement[]): { candidates: Candidate[]; compatible: string[] } {
  const candidates: Candidate[] = []; const compatible: string[] = [];
  for (let i = 0; i < statements.length; i++) for (let j = i + 1; j < statements.length; j++) {
    const a = statements[i]!, b = statements[j]!; if (a.origin === "RELATED" && b.origin === "RELATED") continue;
    const [x, y] = a.origin === "REQUIREMENT" ? [a, b] : [b, a]; // requirement first, so witnesses read "request versus source"
    const sim = jaccard(content(x.text), content(y.text)); if (sim < 0.34) continue;
    const app = applicability(x, y); const negX = NEG.test(x.text), negY = NEG.test(y.text);
    const pair = `${x.id}|${y.id}`;
    const opposed = negX !== negY, universalVsRestrict = (UNIVERSAL.test(x.text) && RESTRICT.test(y.text) && !UNIVERSAL.test(y.text)) || (UNIVERSAL.test(y.text) && RESTRICT.test(x.text) && !UNIVERSAL.test(x.text));
    const nx = numbers(x.text), ny = numbers(y.text);
    const numeric = nx.length && ny.length && nx.some((p) => ny.some((q) => p.unit === q.unit && p.n !== q.n && p.unit !== "")) && sim >= 0.5;
    if (!(opposed && sim >= 0.5) && !universalVsRestrict && !numeric) {
      if (sim >= 0.85 && negX === negY && x.origin === "REQUIREMENT") candidates.push({ rule: "duplicate", kind: "DUPLICATE", a: x, b: y, confirmed: false, explanation: `${x.id} and ${y.locator} say nearly the same thing; link them and reconcile any difference instead of building it twice.`, witness: `${quote(x)} ≈ ${quote(y)}`, impact: "MEDIUM", options: [opt("link", "Treat them as one requirement and keep both sources", "business"), opt("keep-both", "Keep them separate because they differ in a way the text does not show", "business")] });
      continue;
    }
    if (app === "DIFFERENT") { compatible.push(`${pair}: about different ${[...population(x)].find((p) => !population(y).has(p))?.split(":")[0] ?? "populations"}; both can hold`); continue; }
    const confirmed = app === "SAME";
    const rule = opposed ? "direct-contradiction" : universalVsRestrict ? "scope-contradiction" : "numeric-contradiction";
    candidates.push({ rule, kind: "CONTRADICTION", a: x, b: y, confirmed, impact: "HIGH",
      explanation: `${x.id} and ${y.locator} ${opposed ? "require opposite things" : universalVsRestrict ? "disagree about how much is covered (everything versus a restricted set)" : "state different limits"}${confirmed ? "" : ", but it is not clear they are about the same people or period, so this is only a possible conflict"}.`,
      witness: `${quote(x)} versus ${quote(y)}`, options: [opt("clarify-scope", "Clarify which one applies to whom and when", "business"), opt("amend-request", "Amend this request to agree with the existing statement", "business"), opt("revise-existing", "Revise the existing statement through its owner", "policy"), opt("dismiss", "Dismiss as a false finding, with a reason", "business")] });
  }
  // §8.1 NFR tension is a tradeoff, never a logical contradiction
  const unbounded = statements.find((s) => s.origin === "REQUIREMENT" && /\b(arbitrar(y|ily)|unbounded|unlimited|any size|no limit)\b/i.test(s.text));
  const bounded = statements.find((s) => s !== unbounded && /\b(immediate(ly)?|instant(ly)?|synchronous(ly)?|within \d+\s*(ms|s|seconds?)|memory (limit|bound)|bounded (memory|resources?))\b/i.test(s.text));
  if (unbounded && bounded) candidates.push({ rule: "nfr-tension", kind: "TRADEOFF", a: unbounded, b: bounded, confirmed: false, impact: "MEDIUM", explanation: `${unbounded.id} allows any size while ${bounded.locator} bounds time or resources: both can be met only with a stated trade-off (a size limit, paging or a background job). This is a choice, not a logical contradiction.`, witness: `${quote(unbounded)} versus ${quote(bounded)}`,
    options: [opt("limit", "State a maximum size", "business"), opt("background", "Run it as a background job with a download link", "business"), opt("accept", "Accept the risk with an owner and a revisit trigger", "performance")] });
  return { candidates, compatible };
}

export const toFinding = (c: Candidate, detector: "DETERMINISTIC" | "MODEL" = "DETERMINISTIC"): RequirementFinding => ({
  id: findingId(c.rule, c.a.id, c.b.id), kind: c.kind, requirementIds: [c.a, c.b].filter((s) => s.origin === "REQUIREMENT").map((s) => s.id), sourceRefs: [c.a.source, c.b.source], scope: scopeOfKind(c.kind),
  explanation: c.explanation, witness: c.witness, status: c.confirmed && detector === "DETERMINISTIC" ? "CONFIRMED" : "POTENTIAL", blockingTaskIds: [], options: c.options, detector, rule: c.rule, impact: c.impact });

// ------------------------------------------------------------------------------------------------ model proposals (never confirmed)

export interface ProposedFinding { kind: FindingKind; requirementIds: Id[]; explanation: string; witness?: string }
export type FindingProposer = (input: { requirements: Requirement[]; related: Statement[] }, signal?: AbortSignal) => Promise<ProposedFinding[]>;

/** Model concerns are POTENTIAL no matter what the model says; references must exist; and the same applicability check applies. */
export function acceptProposals(proposed: readonly ProposedFinding[], requirements: readonly Requirement[]): { findings: RequirementFinding[]; dropped: string[] } {
  const byId = new Map(requirements.map((r) => [r.id, r])); const findings: RequirementFinding[] = []; const dropped: string[] = [];
  const kinds: FindingKind[] = ["CONTRADICTION", "AMBIGUITY", "GAP", "TRADEOFF", "ACCESS_CONFLICT", "INVARIANT_VIOLATION", "DEPENDENCY_GAP", "IMPLEMENTATION_MISMATCH", "DUPLICATE", "TERMINOLOGY", "CHANGE_IMPACT"];
  for (const p of proposed.slice(0, 20)) {
    const refs = p.requirementIds.map((id) => byId.get(id));
    if (!kinds.includes(p.kind) || !p.requirementIds.length || refs.some((r) => !r) || typeof p.explanation !== "string" || !p.explanation.trim()) { dropped.push(`ignored a proposal that names no real requirement (${p.requirementIds.join(",") || "none"})`); continue; }
    if (refs.length === 2 && applicability(fromRequirement(refs[0]!), fromRequirement(refs[1]!)) === "DIFFERENT") { dropped.push(`dropped ${p.requirementIds.join(" vs ")}: the two are about different populations and can both hold`); continue; }
    findings.push({ id: findingId("model", p.kind, ...p.requirementIds, p.explanation.slice(0, 80)), kind: p.kind, requirementIds: p.requirementIds, sourceRefs: refs.map((r) => r!.source), scope: scopeOfKind(p.kind), explanation: p.explanation.trim().slice(0, 400), witness: p.witness?.trim().slice(0, 300) || undefined,
      status: "POTENTIAL", blockingTaskIds: [], options: [opt("clarify", "Clarify which reading is intended", "business"), opt("dismiss", "Dismiss as a false finding, with a reason", "business")], detector: "MODEL", rule: "model", impact: "MEDIUM" });
  }
  return { findings, dropped };
}

// ------------------------------------------------------------------------------------------------ the operation

export interface ConflictDeps { fs: SqliteFeatureStore; repoRoot: (rec: FeatureRecord) => string; proposer?: FindingProposer }
function load(d: ConflictDeps, actor: Id, contractHash: string): FeatureRecord {
  for (const rec of d.fs.listRequests(undefined, 1000)) if (rec.createdBy === actor && rec.contract?.hash === contractHash) return rec;
  throw new FeatureError("NOT_FOUND", "no contract with that hash");
}
const bounded = (rec: FeatureRecord, ref: SourceRef): string => {
  if (!ref.locator.startsWith("repo:")) throw new FeatureError("INVALID_SCHEMA", "only repository files (repo:path) can be compared");
  const rel = ref.locator.slice(5); if (!rel || rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) throw new FeatureError("INVALID_SCHEMA", `unsafe path ${rel.slice(0, 40)}`);
  const f = join(rec.repositoryId, rel); if (!existsSync(f)) throw new FeatureError("NOT_FOUND", `related source ${rel} does not exist`);
  const text = readFileSync(f, "utf8"); if (text.length > 400_000) throw new FeatureError("RESOURCE_LIMIT", `related source ${rel} is too large`);
  if (rawHash(text) !== ref.contentHash) throw new FeatureError("STALE_REVISION", `${rel} changed since it was referenced`); return text;
};
const COVERED = new Set(["direct-contradiction", "scope-contradiction", "numeric-contradiction", "nfr-tension", "duplicate", "model"]);

export async function detectSemanticConflicts(d: ConflictDeps, actor: Id, i: { contractHash: string; relatedSourceRefs: SourceRef[]; signal?: AbortSignal }): Promise<Outcome<RequirementFinding[]>> {
  const rec = load(d, actor, i.contractHash); const contract = rec.contract!;
  if (!Array.isArray(i.relatedSourceRefs) || i.relatedSourceRefs.length > 10) throw new FeatureError("INVALID_SCHEMA", "at most 10 related sources");
  const related = i.relatedSourceRefs.flatMap((ref) => statementsOf(ref, bounded(rec, ref)));
  const statements = [...contract.requirements.filter((r) => r.status !== "SUPERSEDED").map(fromRequirement), ...related];
  const { candidates, compatible } = compareStatements(statements);
  const findings = candidates.map((c) => toFinding(c));
  const diagnostics = compatible.map((c) => `compatible: ${c}`);
  if (d.proposer) {
    try { const got = acceptProposals(await d.proposer({ requirements: contract.requirements, related }, i.signal), contract.requirements); findings.push(...got.findings.filter((f) => !findings.some((x) => x.id === f.id))); diagnostics.push(...got.dropped); }
    catch (e) { diagnostics.push(`the model-assisted pass did not complete (${String((e as Error).message ?? e).slice(0, 80)}); deterministic checks are unaffected`); }
  } else diagnostics.push("no model-assisted pass was configured; only the deterministic checks ran");
  const covered = new Set<string>(COVERED);
  const after = saveFindings(d.fs, rec.requestId, actor, findings, covered, "conflict detection"); applyBlocking(d.fs, rec.requestId, actor);
  diagnostics.push("not finding a conflict is not proof that the requirements are consistent");
  return { status: "COMPLETE", value: findings.map((f) => after.findings?.find((x) => x.id === f.id) ?? f), evidenceIds: [rec.contract!.hash], diagnostics };
}

// ------------------------------------------------------------------------------------------------ constraints (policies and invariants)

export interface Policy { id: string; kind: "ACCESS_DENY"; actors: string[]; resource: string; text: string; terms: string[] }
export interface Invariant { id: string; text: string; forbids: string[] }
export interface Constraints { policies: Policy[]; invariants: Invariant[] }
const PolicySchema = defineSchema<Policy>("pf.Policy", "1", (p) => ({ id: p.id, kind: p.kind, actors: asSet(p.actors.map((a) => a.toLowerCase())) as Canon, resource: p.resource, text: p.text, terms: asSet(p.terms) as Canon }));
export const policyHashOf = (p: Policy): string => canonHash(PolicySchema, p);

/** `.cie/constraints.json`: access policies and invariants a requirement may not contradict. Strict, like every other repository setting. */
export function loadConstraints(repoRoot: string): Constraints {
  const file = join(repoRoot, ".cie", "constraints.json"); const empty: Constraints = { policies: [], invariants: [] };
  if (!existsSync(file)) return empty;
  let raw: any; try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ConfigError(".cie/constraints.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(".cie/constraints.json must be an object");
  for (const k of Object.keys(raw)) if (!["policies", "invariants"].includes(k)) throw new ConfigError(`unknown constraints setting ${k}`);
  const strs = (v: unknown, what: string) => { if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) throw new ConfigError(`${what} must be a list of non-empty strings`); return v as string[]; };
  const ids = new Set<string>();
  const policies = (raw.policies ?? []).map((p: any, n: number): Policy => {
    if (!p || typeof p !== "object") throw new ConfigError(`policy ${n} must be an object`);
    for (const k of Object.keys(p)) if (!["id", "kind", "actors", "resource", "text", "terms"].includes(k)) throw new ConfigError(`policy ${p.id ?? n}: unknown key ${k}`);
    if (typeof p.id !== "string" || !/^[\w.:-]{1,64}$/.test(p.id) || ids.has(p.id)) throw new ConfigError(`policy ${n}: a unique id is required`); ids.add(p.id);
    if (p.kind !== "ACCESS_DENY") throw new ConfigError(`policy ${p.id}: kind must be ACCESS_DENY`);
    if (typeof p.resource !== "string" || !p.resource.trim() || typeof p.text !== "string" || !p.text.trim()) throw new ConfigError(`policy ${p.id}: resource and text are required`);
    return { id: p.id, kind: "ACCESS_DENY", actors: strs(p.actors, `policy ${p.id} actors`), resource: p.resource, text: p.text, terms: strs(p.terms ?? [], `policy ${p.id} terms`) };
  });
  const invariants = (raw.invariants ?? []).map((v: any, n: number): Invariant => {
    if (!v || typeof v !== "object") throw new ConfigError(`invariant ${n} must be an object`);
    for (const k of Object.keys(v)) if (!["id", "text", "forbids"].includes(k)) throw new ConfigError(`invariant ${v.id ?? n}: unknown key ${k}`);
    if (typeof v.id !== "string" || !/^[\w.:-]{1,64}$/.test(v.id) || ids.has(v.id)) throw new ConfigError(`invariant ${n}: a unique id is required`); ids.add(v.id);
    if (typeof v.text !== "string" || !v.text.trim()) throw new ConfigError(`invariant ${v.id}: text is required`);
    const forbids = strs(v.forbids, `invariant ${v.id} forbids`); if (!forbids.length) throw new ConfigError(`invariant ${v.id}: forbids needs at least one phrase`);
    return { id: v.id, text: v.text, forbids };
  });
  return { policies, invariants };
}

export function checkAgainstConstraints(requirements: readonly Requirement[], c: Constraints, invariantIds: readonly Id[] = []): RequirementFinding[] {
  const out: RequirementFinding[] = [];
  for (const r of requirements) {
    if (r.status === "SUPERSEDED") continue; const neg = NEG.test(r.text); const text = r.text.toLowerCase();
    for (const p of c.policies) {
      const actorHit = p.actors.some((a) => r.actorIds.some((x) => x.toLowerCase() === a.toLowerCase()) || new RegExp(`\\b${a.toLowerCase().replace(/[^a-z0-9]/g, "")}s?\\b`).test(text.replace(/[^a-z0-9 ]/g, "")));
      const resourceHit = [...content(p.resource)].filter((w) => content(r.text).has(w)).length >= Math.min(2, content(p.resource).size) || p.terms.some((t) => text.includes(t.toLowerCase()));
      if (actorHit && resourceHit && !neg) out.push({ id: findingId("access-policy", r.id, p.id), kind: "ACCESS_CONFLICT", requirementIds: [r.id], sourceRefs: [r.source], scope: "access", explanation: `${r.id} gives ${p.actors.join("/")} access that policy ${p.id} denies.`, witness: `"${r.text.slice(0, 140)}" (${r.id}) versus policy ${p.id}: "${p.text}"`,
        status: "CONFIRMED", blockingTaskIds: [], options: [opt("amend-request", "Amend the request so it respects the policy", "business"), opt("change-policy", "Change the policy through its owner", "access"), opt("scope-down", "Narrow the access (fewer fields, own tenant only)", "access")], detector: "DETERMINISTIC", rule: "access-policy", impact: "HIGH" });
    }
    for (const v of c.invariants) {
      if (invariantIds.length && !invariantIds.includes(v.id)) continue;
      const phrase = v.forbids.find((f) => text.includes(f.toLowerCase())); if (phrase && !neg && /\b(allow|permit|may|can|let|support|enable)\b/i.test(r.text))
        out.push({ id: findingId("invariant", r.id, v.id), kind: "INVARIANT_VIOLATION", requirementIds: [r.id], sourceRefs: [r.source], scope: "policy", explanation: `${r.id} would allow "${phrase}", which invariant ${v.id} forbids.`, witness: `"${r.text.slice(0, 140)}" (${r.id}) versus invariant ${v.id}: "${v.text}"`, status: "CONFIRMED", blockingTaskIds: [],
          options: [opt("amend-request", "Amend the request so the invariant still holds", "business"), opt("revise-invariant", "Revise the invariant through its owner", "policy")], detector: "DETERMINISTIC", rule: "invariant", impact: "HIGH" });
    }
  }
  return out;
}

export async function checkRequirementConstraints(d: ConflictDeps, actor: Id, i: { contractHash: string; policyHashes: string[]; invariantIds: Id[] }): Promise<Outcome<RequirementFinding[]>> {
  const rec = load(d, actor, i.contractHash); const contract = rec.contract!;
  let constraints: Constraints; try { constraints = loadConstraints(d.repoRoot(rec)); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `.cie/constraints.json is invalid: ${(e as Error).message}`); }
  if (!Array.isArray(i.policyHashes) || !Array.isArray(i.invariantIds)) throw new FeatureError("INVALID_SCHEMA", "policyHashes and invariantIds must be lists");
  const current = new Map(constraints.policies.map((p) => [policyHashOf(p), p.id]));
  const unknown = i.policyHashes.filter((h) => !current.has(h)); if (unknown.length) throw new FeatureError("STALE_REVISION", `${unknown.length} policy hash(es) do not match the repository's current policies; reload them`);
  const missing = i.invariantIds.filter((id) => !constraints.invariants.some((v) => v.id === id)); if (missing.length) throw new FeatureError("NOT_FOUND", `no such invariant: ${missing.join(", ")}`);
  const scoped: Constraints = { policies: i.policyHashes.length ? constraints.policies.filter((p) => i.policyHashes.includes(policyHashOf(p))) : constraints.policies, invariants: constraints.invariants };
  const findings = checkAgainstConstraints(contract.requirements, scoped, i.invariantIds);
  saveFindings(d.fs, rec.requestId, actor, findings, new Set(["access-policy", "invariant"]), "constraint check"); const blocking = applyBlocking(d.fs, rec.requestId, actor);
  return { status: "COMPLETE", value: findings, evidenceIds: [contract.hash], diagnostics: [`${scoped.policies.length} polic(ies) and ${i.invariantIds.length || constraints.invariants.length} invariant(s) checked`, `${blocking.blocked.length} task(s) blocked, ${blocking.independent.length} independent task(s) continue`, "code and conventions cannot authorise broader access than a policy allows"] };
}
