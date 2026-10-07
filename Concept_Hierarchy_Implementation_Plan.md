# Concept hierarchy: implementation plan

Status: implementation plan, not yet built. Companion to the design discussion that produced it (two-axis hierarchy: architectural containment + semantic specialization, PDG-based motif mining, anchored incremental updates, LLM used only for naming). This is a file/function manifest for a single implementation push, to be reviewed once written, not pseudocode to transcribe literally.

## 0. Infra decisions made to fit this repo (read before writing code)

These are judgment calls needed to turn the design into something that fits this codebase instead of a generic description. Follow them unless you have a reason not to — if you deviate, say so when asking for review.

1. **Language scope: TypeScript only for v1.** All packages in this repo are TS. `config.languages = ["typescript"]`. The code should not hard-code TS assumptions where avoidable, but nothing else needs implementing now.
2. **PDG source: the `typescript` compiler API, not a new parser dependency.** `@cie/core/package.json` already lists `typescript` as a dependency (currently used in `changes.ts` for `ts.createProgram` diagnostics only). Build CFG/dominators by walking `ts.SourceFile` ASTs directly — there is no existing CFG/SSA infra to reuse, this is genuinely new code, but no new npm package is needed.
3. **Storage: SQLite tables in `store.ts`, not LMDB.** The design doc mentions LMDB for PDGs; this repo has one storage engine (better-sqlite3, see `store.ts`) and everything else — `concepts`, `claims`, `jobs` — lives there. Add new tables there instead of introducing a second storage engine.
4. **NMF and FCA are stubbed, not built, in this push.** Per the phased rollout agreed earlier: ship tier-1 exact-hash concept matching and explicit composition rules only. Define the `nmfFoldIn`/`buildFcaLattice` function *signatures* so later work slots in without a redesign, but their bodies can throw `"not implemented"` or return trivial results. Do not spend this push's budget on NMF/FCA.
5. **`groupingFeature` (the directory/import-cohesion/shared-types/co-change weighted signal for grouping files between module and package level) is dropped for v1.** It was never resolved which axis owns it, and it risks re-merging the two axes we just finished separating. Axis B (semantic concepts + cross-package links) carries "what groups of files work together" instead. Revisit only if real usage shows a gap.
6. **Naming calls bypass the claim-gating pipeline entirely.** `nameSemanticConcepts`/`nameArchitecturalConcepts` go through `runModel`/`callModel` for budget and egress enforcement only — no `gateClaim`, no evidence citation, because they assert nothing. This matches the design's own rule ("LLM only names, never claims").
7. **Every new threshold is declared with an explicit calibration status** (`"uncalibrated"`), per the self-audit discussion. No threshold ships described as validated.

---

## 1. New module: `packages/core/src/concept-hierarchy/`

A new directory, matching the existing convention for large components (`src/c22/`, `src/c24/`, `src/defect/`).

### `concept-hierarchy/config.ts`
- `export const CONCEPT_CONFIG` — the full config object (motif size limits, FCA bounds, NMF k, thresholds, batch sizes).
- `export const PARAMETER_STATUS: Record<string, { value: unknown; status: "uncalibrated" | "conventional-untested" | "verified"; note: string }>` — the audited parameter table from the design discussion (`T_stable`, `T_histogram`, `T_high`, `T_mid`, `M_high`, `E_low`, `E_mid`, `maxMotifSize`, `maxAttributes`, `fcaSupportThreshold`, `k`, `fullRebuildThreshold`, `batchSize`). Every one of these starts `"uncalibrated"`.
- `export const MOTIF_PATTERNS` — the generic, domain-agnostic catalog decided earlier: `"guarded-write" | "loop-accumulate" | "resource-acquire-release" | "retry-loop" | "error-handling-block" | "state-transition" | "validation-check" | "cache-lookup" | "paired-call" | "conditional-call"`. (`"increment"`/`"debit"`/`"credit"` are *not* in this list — they are specializations of `guarded-write` discovered by composition rules, not hand-authored motifs.)

### `concept-hierarchy/types.ts`
Internal working types not exposed outside this module (the persisted/public ones go in `@cie/schema`, see §2):
- `Pdg`, `BasicBlock`, `ControlEdge`, `DataEdge`, `GuardEdge`, `LoopInfo`
- `Motif`, `CanonicalMotif`
- `ArchNode` (`{ id, kind: "repo"|"package"|"module"|"class"|"function", children, parentId }`), `ArchTree`

### `concept-hierarchy/pdg.ts` — Phase 1
- `buildAllPdgs(store: Store, revision: string, repoRoot: string, previous?: PdgIndex): PdgIndex`
  - For each non-file/non-test entity, resolve its source text from `entity.spans` + the file on disk (same byte-range-read pattern `changes.ts` already uses), reuse `previous`'s PDG when `bodyHash` is unchanged.
- `buildPdg(entity: Entity, sourceText: string): Pdg`
- `buildControlFlowGraph(sourceFile: ts.SourceFile, node: ts.Node): Cfg` — hand-written: walk statements, branch on `if`/`for`/`while`/`switch`/`try`, build basic blocks and control edges. (No existing code to build on — this is the one genuinely new piece of program-analysis infrastructure in the whole plan.)
- `foldBasicBlocks(cfg: Cfg): Cfg`
- `convertToSsa(cfg: Cfg): Ssa` — scoped to local variables only; do not attempt whole-program SSA.
- `buildDataFlowGraph(ssa: Ssa): DataEdge[]`
- `extractGuardEdges(cfg: Cfg): GuardEdge[]` — dominator analysis (standard iterative dominator algorithm over the CFG).
- `extractAssertions(sourceFile: ts.SourceFile): Condition[]` — look for `assert(...)`, `invariant(...)`, or project-specific assertion calls; configurable list, not hard-coded to one name.
- `extractLoops(cfg: Cfg): LoopInfo[]`
- `pdgSignature(pdg: Pdg): string` — hash of sorted node/edge kinds + degree sequence, used for motif-extraction memoization.

### `concept-hierarchy/motifs.ts` — Phase 2
- `extractAllMotifs(pdgIndex: PdgIndex, previous?: MotifIndex): MotifIndex`
- One extractor per generic pattern in `MOTIF_PATTERNS`:
  `extractGuardedWriteMotifs`, `extractLoopAccumulateMotifs`, `extractResourceLifecycleMotifs` (open/close, lock/unlock, begin/commit pairs), `extractRetryLoopMotifs`, `extractErrorHandlingMotifs`, `extractStateTransitionMotifs`, `extractValidationCheckMotifs` (early-return-on-invalid-input), `extractCacheLookupMotifs`, `extractPairedCallMotifs`, `extractConditionalCallMotifs` — each `(pdg: Pdg) => Motif[]`.
- `computeCardinality(motif: Motif, pdg: Pdg): { reads: number; writes: number }`
- `motifRawSignature(motif: Motif): string`

### `concept-hierarchy/canonicalize.ts` — Phase 3
- `canonicalizeAll(motifs: Motif[], previous?: Map<string, CanonicalMotif>): CanonicalMotif[]`
- `canonicalize(motif: Motif): CanonicalMotif`
- `inferRoles(motif: Motif): Record<string, string>` — constraint propagation to fixpoint.
- `normalizeOps(pattern: string, bindings: Record<string, string>): string`
- `abstractConstants(normalized: string): string`
- `buildSparseFeatures(symbolic: string): SparseVector`

### `concept-hierarchy/semantic-concepts.ts` — Phases 4 + 6
- `identifyConcepts(canonical: CanonicalMotif[], store: ConceptStore, previous?: SemanticConcept[]): { concepts: SemanticConcept[]; tier: ("matched"|"ambiguous"|"new")[] }`
  - Tier 1 (hash match) implemented. Tier 2 (NMF) calls into the stub below and is **disabled by config flag** for this push.
- `nmfFoldIn(v: SparseVector, w: Matrix): number[]` — **stub**: throw if called while `CONCEPT_CONFIG.nmf.enabled` is false.
- `trainOrUpdateNmf(featureMatrix: Matrix, k: number): Matrix` — **stub**, same guard.
- `buildHierarchy(concepts: SemanticConcept[], previous?: SemanticLattice): SemanticLattice`
  - `applyCompositionRules(concepts)` — implemented: the generic rules (`guarded-write` with `op: sub` → `debit`-shaped specialization, `op: add` → `credit`-shaped; two complementary specializations with matching delta → `transfer`-shaped; `resource-acquire-release` with unmatched release → candidate leak). These are *structural* rules over canonical motifs, not hand-named business concepts — naming is still the LLM's job in Phase 7.
  - `buildFcaLattice(concepts)` — **stub**, disabled by config flag.
  - `incrementalUpdate(prevLattice, newLattice, concepts)` — implemented for composition-rule edges only.

### `concept-hierarchy/invariants.ts` — Phase 5
- `detectInvariants(concept: SemanticConcept, pdgIndex: PdgIndex): Invariant[]`
- `commonDominatingGuards(writes: Write[]): Condition[]`
- `detectBound(acc: Accumulator, pdg: Pdg): Condition | null`
- `conservationInvariants(pdg: Pdg): Invariant[]`
- `export const LANGUAGE_SOUNDNESS_TIER: (construct: "explicit-assertion"|"guard-intersection"|"guard-intersection-across-await"|"guard-intersection-closure-write"|"guard-intersection-dynamic-property"|"conservation-pair", lang: "typescript") => "verified"|"supported"|"speculative"`
  - Implements the table from the design discussion exactly: explicit assertion → `verified`; guard intersection with no closure/await/dynamic-write interference → `supported`; guard intersection crossing `await`, written-to by a closure, or involving dynamic property access → `speculative`. `detectInvariants` must call this for every invariant it proposes and tag `tier` accordingly — never hard-code `"verified"`.

### `concept-hierarchy/architecture.ts` — Phase 5.5 (Axis A)
- `buildArchitecturalTree(store: Store, revision: string, repoRoot: string): ArchTree`
  - Repo node from root `package.json` name. Package nodes from each `packages/*/package.json` (and `apps/*`, `extensions/*` per the workspaces glob). Module nodes = one per source file (TS's real module boundary — no namespace level, no directory heuristic; see decision §0.5). Entity nodes from existing `store.entities(revision)`.
- `deriveArchitecturalConcepts(archTree: ArchTree, store: Store, revision: string): ArchConcept[]`
- `exportSurfaceFor(moduleNode: ArchNode, sourceFile: ts.SourceFile): ExportSurface` — walk top-level `export` declarations.
- `exportSurfaceForPackage(pkgNode: ArchNode, moduleSurfaces: ExportSurface[]): ExportSurface` — resolve transitively from the package's declared entry point (`package.json#exports` / `index.ts`).
- `detectEntryPoints(moduleNode: ArchNode): EntryPoint[]` — look for HTTP route registrations / CLI command definitions if present; return `[]` otherwise (library packages are expected to have none — this is optional, per design decision to generalize "contract" to "export surface").

### `concept-hierarchy/cross-axis.ts` — Phase 5.6
- `linkSemanticToArchitectural(concepts: SemanticConcept[], archConcepts: ArchConcept[]): LinkEdge[]` — `instantiates-in` edges only, no naming here.
- `findCrossPackageConcepts(concepts: SemanticConcept[], archTree: ArchTree): CrossPackageConcept[]`
- `distribution(concept: SemanticConcept, archTree: ArchTree): Record<string, number>` — per-package instance counts.

### `concept-hierarchy/fingerprint.ts` — Phase 7 support (anchoring)
- `fingerprint(node: ArchConcept | SemanticConcept): string`
- `jaccard(a: Set<string>, b: Set<string>): number`
- `histogramShift(prev: Histogram, curr: Histogram): number`
- `exportSurfaceChanged(prev: ExportSurface, curr: ExportSurface): boolean`
- `shouldRename(node, prevFingerprint, currFingerprint): boolean` — implements the exact rule from the design discussion (unchanged fingerprint → false; Jaccard above `T_stable` → false; export surface changed → true; histogram shift below `T_histogram` → false; else → true).

### `concept-hierarchy/naming.ts` — Phase 7
- `nameSemanticConcepts(concepts: SemanticConcept[], lattice: SemanticLattice, cache: NamingCache, ctx: CallContext, service: Service): Promise<void>`
  - Cache key: `conceptId + canonicalMotifHash + modelVersion + promptVersion`. Calls the model only on a cache miss, through `service.callModel`-equivalent with the new `NAME_CONCEPT` purpose (see §3). No evidence bundle — just the concept's canonical form + member names + sibling names.
- `nameArchitecturalConcepts(archConcepts: ArchConcept[], semanticConcepts: SemanticConcept[], previousState: ArchConcept[] | null, cache: NamingCache, ctx: CallContext, service: Service): Promise<void>`
  - Bottom-up `postOrder` traversal exactly as specified in the design: leaf nodes renamed only if `shouldRename`; interior nodes renamed if their own fingerprint changed, or a child's name changed *and* the aggregated histogram shift exceeds `T_histogram`; otherwise the cached name is reused untouched.

### `concept-hierarchy/incremental.ts` — top-level orchestrator (Phase 0/12)
- `buildOrUpdateConceptHierarchy(service: Service, ctx: CallContext, store: Store, revision: string, control?: JobControl): Promise<ConceptHierarchyResult>`
  - Diffs entities since the prior revision (reuse the `symbolHash`-comparison pattern already in `service.ts`'s `extractConcepts`, §5.1521-1546, rather than inventing a second diffing mechanism).
  - If changed fraction > `CONCEPT_CONFIG.incremental.fullRebuildThreshold`: rebuild all phases from scratch.
  - Otherwise: call phases 1–7 in order, threading the previous revision's result through every phase so each phase's own memoization/anchoring (already specified per-phase above) does the incremental work — this function does not re-implement anchoring itself, it just sequences the phases and passes `previous`.

---

## 2. Schema additions: `packages/schema/src/index.ts`

Add alongside the existing `ConceptCard`/`ConceptsOutput` section:

- `export interface SemanticConcept { id: Id; kind: (typeof CARD_KINDS)[number]; canonicalMotifHash: Hash; instances: Id[]; invariants: Invariant[]; name?: string; parentIds: Id[]; childIds: Id[]; status: "new"|"matched"|"ambiguous" }`
- `export interface Invariant { predicate: string; scope: string | Id[]; evidenceIds: Id[]; tier: "verified"|"supported"|"speculative" }`
- `export interface ArchConcept { id: Id; kind: "repo"|"package"|"module"|"class"|"function"; exports: ExportSurface; imports: string[]; entryPoints: EntryPoint[]; contracts: string[]; name?: string; fingerprint: Hash }`
- `export interface ExportSurface { types: string[]; functions: string[]; constants: string[]; reExports: string[] }`
- `export interface EntryPoint { kind: string; signature: string }`
- `export interface CrossPackageConcept { id: Id; semanticConceptId: Id; participants: Id[]; contracts: string[] }`
- Two new **narrow** output schemas, registered in `OUTPUT_SCHEMAS`:
  ```ts
  export const SCHEMA_NAME_CONCEPT = "name-concept.v1";
  export const NameConceptOutput = z.object({ name: z.string().max(60) }).strict();
  export const SCHEMA_NAME_ARCH = "name-arch.v1";
  export const NameArchOutput = z.object({ name: z.string().max(60), oneLineSummary: z.string().max(200).optional() }).strict();
  ```
- Extend `ModelRequest.purpose` union with `"NAME_CONCEPT" | "NAME_ARCH"`.

## 3. Model-layer additions: `packages/model/src/ollama.ts`

- Add two `task()` branches:
  - `purpose === "NAME_CONCEPT"` → `"Return only a short name (1-3 words) for this code pattern, given its canonical form and member names. No claims. No evidence citation. Naming only."`
  - `purpose === "NAME_ARCH"` → `"Return only a short name (1-3 words) and, if useful, a one-sentence summary for this part of the repository, given its export surface, the semantic concepts found inside it, and its dependencies. No claims. No evidence citation. Naming only."`
- These requests should use a **lighter bundle** than `compact()` builds today — just the concept/node's own summary fields, not the full entities/relationships/facts bundle. Add a `compactForNaming(req)` helper rather than reusing `compact()`, since naming calls carry no evidence and don't need relationship/fact payloads.
- No change needed to `gateway.ts` — `runModel` already validates against whatever `OUTPUT_SCHEMAS[req.schemaId]` is.

## 4. Store additions: `packages/core/src/store.ts`

New tables (next to the existing `concepts`/`concept_versions` block, same style):
```sql
create table if not exists pdgs(revision text not null, entity_id text not null, body_hash text not null, json text not null, primary key(revision, entity_id));
create table if not exists semantic_concepts(revision text not null, id text not null, json text not null, primary key(revision, id));
create table if not exists semantic_concept_versions(repo_root text not null, version integer not null, revision text not null, created_at text not null, json text not null, primary key(repo_root, version));
create table if not exists arch_nodes(revision text not null, id text not null, json text not null, primary key(revision, id));
create table if not exists cross_axis_links(revision text not null, semantic_concept_id text not null, arch_node_id text not null, kind text not null, primary key(revision, semantic_concept_id, arch_node_id, kind));
create table if not exists naming_cache(cache_key text primary key, name text not null, json text not null, created_at text not null);
```
New accessor methods, mirroring the existing `replaceConcepts`/`concepts`/`conceptVersions`/`conceptVersion` group exactly:
- `replaceSemanticConcepts(rev, concepts): number`, `semanticConcepts(rev): SemanticConcept[]`, `semanticConceptVersions(repoRoot)`, `semanticConceptVersion(repoRoot, version)`
- `replaceArchNodes(rev, nodes): void`, `archNodes(rev): ArchConcept[]`
- `replaceCrossAxisLinks(rev, links): void`, `crossAxisLinks(rev): LinkEdge[]`
- `namingCacheGet(key: string): { name: string; json: unknown } | null`, `namingCacheSet(key, name, json): void`

## 5. Service additions: `packages/core/src/service.ts`

- `async buildConceptHierarchy(ctx: CallContext, req: { revision?: string }, control?: JobControl): Promise<ApiResult<ConceptHierarchyResult>>` — same shape as `extractConcepts` (job-controlled, `control.checkpoint()`/`control.progress()` per phase, `control.commit()` before persisting, audited as `"concept-hierarchy.build"`). Delegates to `concept-hierarchy/incremental.ts`'s `buildOrUpdateConceptHierarchy`.
- `conceptHierarchy(ctx: CallContext, req: { revision?: string; version?: number }): ApiResult<ConceptHierarchyView>` — read-only, mirrors `conceptStore`.
- Import `buildOrUpdateConceptHierarchy` from the new module; no changes needed to `callModel` itself — it already handles any `ModelRequest.purpose`.

## 6. Tests to add: `packages/core/test/`

One test file per module, matching the existing one-file-per-concern style (`concepts.test.ts`, `claims.test.ts`):
- `pdg.test.ts` — CFG/dominator correctness on small hand-written TS fixtures (if/loop/try shapes with known dominator sets).
- `motifs.test.ts` — one fixture per generic motif pattern, assert it fires and doesn't fire on a near-miss.
- `canonicalize.test.ts` — two structurally-equivalent motifs with different variable names canonicalize to the same hash; two different motifs do not.
- `semantic-concepts.test.ts` — tier-1 hash matching across revisions; composition rules produce `transfer`-shaped specialization from two complementary `guarded-write` motifs with matching delta.
- `invariants.test.ts` — one case per `LANGUAGE_SOUNDNESS_TIER` row, asserting the tier downgrade actually happens for `await`/closure/dynamic-property cases.
- `architecture.test.ts` — run against this repo itself: assert the tree has one node per real workspace package and one module node per real `.ts` file; assert `exportSurfaceFor` matches real `export` statements in a known file.
- `cross-axis.test.ts` — a concept instancing in two packages is found as a `CrossPackageConcept`; a single-package concept is not.
- `fingerprint.test.ts` — identical summary ⇒ no rename; export-surface change ⇒ rename; internal-only change below threshold ⇒ no rename.
- `naming.test.ts` — cache hit skips the model call (assert via a stub provider's call count); cache miss calls it once per batch.
- `concept-hierarchy-incremental.test.ts` — end-to-end: build on revision A, make a one-line edit, build on revision B, assert most nodes keep identical names/ids and only the touched region changes (this is the test that actually proves the anchoring discipline works, not just that it's specified).

---

## 7. Build order (even as "one push," implement top-down so each piece is checkable against something real)

1. `config.ts`, `types.ts` (no logic, just compiles).
2. `pdg.ts` — the one genuinely new infra piece. Get this right first; everything else depends on it.
3. `motifs.ts`, `canonicalize.ts`, `semantic-concepts.ts` (tier-1 + composition rules only), `invariants.ts`.
4. `architecture.ts`, `cross-axis.ts` — independent of 2–3, can be built in parallel.
5. `fingerprint.ts`, `naming.ts` — depends on both 3 and 4 existing.
6. Schema additions (§2), model-layer additions (§3) — needed before `naming.ts` can compile against real types; do these alongside step 5.
7. Store additions (§4), service additions (§5) — wiring, last.
8. `incremental.ts` — the orchestrator; last, since it calls everything above.
9. Tests, written alongside each numbered step above, not batched at the end.

## 8. What I'll check on review

- Every threshold actually reads from `PARAMETER_STATUS`/`CONCEPT_CONFIG` rather than being a literal re-typed in logic.
- No invariant is tagged `"verified"` except via `LANGUAGE_SOUNDNESS_TIER`'s explicit-assertion path.
- Naming calls (`naming.ts`) never call `gateClaim` and never appear in the `claims`/`verdicts` tables.
- The incremental end-to-end test actually demonstrates bounded blast radius on a one-line edit, not just that the code runs.
- `architecture.ts`'s tree, run against this repo, matches the real package/file layout — not a hand-picked fixture.
