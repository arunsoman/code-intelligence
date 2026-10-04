# Code-Validator Report: §11 Semantic Zoom Model + §12 Visual/Conversational Interaction

## Implementation tracker — updated 2026-10-04

This tracker supersedes the original audit's status for the items below. The original audit is retained as a baseline; its repeated “not implemented” and “no code changes” statements describe the earlier review, not this implementation batch.

- [x] **DONE — Recorded runtime replay controls** (§12 Runtime→Visual, §20, UC-10, TemporalReplay): RuntimeOverlay now offers a local-time window, keyboard-accessible scrubber, play/pause and clear controls. Recorded observations and errors highlight existing map nodes without changing positions, camera, selection or provenance styles. Counts, unattributed spans, sampling and attribution warnings are visible. Stale responses are ignored; failed requests clear prior highlights. Runtime envelopes now populate the map, and replay/window queries respect the selected lower time bound. Files: [RuntimeReplay.tsx](apps/web/src/RuntimeReplay.tsx), [Canvas.tsx](apps/web/src/Canvas.tsx), [runtime.ts](packages/core/src/runtime.ts), [runtime form](packages/core/src/forms/runtime.ts).
  - **Still open:** live anomaly pulses, animated breakpoint anchors, automatic abstraction morphing, cross-service trace stitching and replay of indexed aggregate trace exports. Playback is cumulative by span start time, not a simulation of currently executing spans. The map retains its baseline heat; replay highlights only code already drawn, and the accompanying list includes other attributed code.
- [x] **DONE — Per-view epistemic display summary** (§27): the map footer counts and shows percentages for Fact, Inference, Hypothesis and Fog, plus stale elements. It follows the drawn graph or selected matrix representation; terrain reports view-node status. Hidden elements are excluded. This is explicitly a display-category summary, not a calibrated confidence score or a breakdown by evidence-source class. Files: [EpistemicSummary.tsx](apps/web/src/EpistemicSummary.tsx), [epistemic.ts](apps/web/src/epistemic.ts), [App.tsx](apps/web/src/App.tsx).
- [x] **DONE — Explicit high-contrast mode** (§27): a keyboard-accessible toggle persists the preference locally and updates both HTML and Cytoscape colors. Contrast auditing now covers light, dark and high-contrast palettes. Existing reduced-motion behavior remains. Files: [App.tsx](apps/web/src/App.tsx), [Canvas.tsx](apps/web/src/Canvas.tsx), [styles.css](apps/web/src/styles.css), [a11y.ts](apps/web/src/a11y.ts).

- [x] **DONE — Investigation board, first UI release** (§14, §22, UC-09, UC-34, ACH comparison): the **Investigations** button opens persisted C22 investigations for the current saved workspace or repository. Users can create an investigation from a question, selected code and optional stack trace; run bounded waves of up to eight read-only checks; pause/resume; and reopen saved investigations. The board shows hypothesis states, freshness, disputes, priority reasons, predictions, assumptions, source citations, check progress, budgets and coverage gaps. An observations × hypotheses matrix distinguishes support, contradiction, neutral/inconclusive results, unassessed/rejected evidence, stale assessments and retractions. Discriminating rows support one candidate and contradict another; correlation groups remain visible. It polls committed state every 1.5 seconds, ignores superseded reads, clears details on access/read failure and recovers on successful reads. The new `C22/getDetails` read respects engine access revocation. Files: [InvestigationPanel.tsx](apps/web/src/InvestigationPanel.tsx), [comparison logic](apps/web/src/investigation.ts), [engine detail read](packages/core/src/c22/engine.ts).
  - **Still open:** hypothesis creation/editing, evidence attachment, scope steering, finalization/reopening and experiment proposals from this UI; these remain API operations. This release is a comparison board with polling, not a live graph projected onto the main canvas. The saved-investigation picker shows the most recent 100 entries for its workspace.
- [x] **DONE — Test-confidence and runtime overlays on the stable graph layout** (§29, §30 modality toggle, §59 ConfidenceOverlay): the map can independently toggle test and runtime signal layers without rebuilding the view or changing graph positions. Test markings summarize up to three static caller hops, mapped failing tests and available line coverage; runtime markings use attributed ingested spans/errors in a 24-hour, 7-day or 30-day window. Clicking a marked code node adds the overlay summary and accessible evidence to its inspector. Unknown or unavailable signals remain gray; the UI states that static links can miss unresolved calls, line coverage is not correctness, and no spans does not establish non-execution. The read endpoint caps requests at 2,000 IDs and filters restricted entities/evidence. Files: [map overlay aggregation](apps/web/src/mapoverlays.ts), [overlay query](packages/core/src/overlays.ts), [Canvas.tsx](apps/web/src/Canvas.tsx), [App.tsx](apps/web/src/App.tsx).
  - **Still open:** data-flow, trust and churn layers; arbitrary test-assertion confidence fused onto any map; overlays on matrix/terrain; live telemetry, payload/latency, animation, and richer per-test links. Runtime counts represent ingested/attributed envelopes, not a live stream. Access filtering and unavailable IDs are deliberately combined into a coarse “withheld or unavailable” notice.

**Investigation batch validation:** core and web typechecks and production build passed. **48 distinct targeted tests passed, zero skipped**: 45 C22/board/comparison/accessibility/browser tests plus three existing keyboard and runtime-replay browser regressions. Browser checks cover create → pause → resume → execute → inspect evidence → receive another client's observation → reload/reopen, and access/read-failure clearing and recovery. Engine coverage includes revocation, concurrency, stale evidence and the read-only HTTP detail endpoint.

Investigation test commands: `node --test packages/core/test/c22.test.ts apps/web/test/investigation.test.ts apps/web/test/board.test.ts apps/web/test/a11y.test.ts apps/web/test/e2e/investigations.test.ts`; `node --test apps/web/test/e2e/investigations.test.ts apps/web/test/e2e/keyboard.test.ts apps/web/test/e2e/runtime-replay.test.ts`.

**First batch validation:** core typecheck, web typecheck and production web build passed. **55 targeted tests passed, zero skipped**, covering C24, visualization forms, graph behavior, summary calculations, three-theme accessibility, the keyboard investigation workflow and browser replay (including out-of-order replies, error recovery, camera/position preservation and contrast persistence). The web typecheck also exposed a missing label mapping for existing investigation/defect job kinds; that mapping is now complete in `JobBar.tsx`.

Commands: `npm run typecheck`; `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit`; `npm run web:build`; `node --test packages/core/test/c24.test.ts packages/core/test/visuals.test.ts apps/web/test/epistemic.test.ts apps/web/test/graph.test.ts apps/web/test/a11y.test.ts apps/web/test/e2e/runtime-replay.test.ts apps/web/test/e2e/keyboard.test.ts`.

---

**Scope:** Reviewed the PRD sections against the current implementation. No code was changed.  
**Key files inspected:**

- `apps/web/src/graph.ts`, `arrange.ts`, `layout.ts`, `Canvas.tsx`
- `packages/core/src/visuals.ts`, `viewspec.ts`, `retrieval.ts`, `context.ts`, `concepts.ts`, `interactions.ts`, `service.ts`, `changes.ts`, `runtime.ts`, `forms/runtime.ts`
- `extensions/vscode/src/extension.ts`, `events.ts`
- `README.md` and `Unified_Code_Intelligence_Product_Specification (1).html`

---

## 1. Executive verdict

**Not everywhere, and not exactly as written.**  
The codebase already implements large parts of both sections, but several requirements are only partial or missing. The system can:

- produce question-relative architecture maps,
- zoom through fixed abstraction levels,
- explain selected nodes with per-edge citations,
- interpret visual gestures as intents without mutating code,
- bridge editor selection/breakpoints into the view,
- turn confirmed intents into isolated, validated code proposals.

What it **cannot** yet do:

- invent dynamic intermediate zoom levels (e.g., “L2.5 security ladder”),
- morph/animate transitions between levels,
- compose zoom levels from cached concept cards,
- transform the same map into an invariant/threat overlay,
- pulse map regions on live log anomalies or show animated replay anchors,
- guarantee full coverage outside the supported static-analysis surface.

---

## 2. §11 Semantic Zoom Model — requirement-by-requirement

| Req | PRD intent | Current state | Evidence / files |
|-----|-----------|---------------|------------------|
| **(a) lens-consistency** | L2→L3 expansion must follow semantic-memory realizers; unresolved cases marked | **Partial** | `apps/web/src/graph.ts` aggregates by `concept`/`cluster` groups at levels 1–2 and by `file` groups at level 3. However, the groups used for aggregation are produced per-question by `compileView` (`packages/core/src/viewspec.ts`), not read from a persisted “domain→component” semantic memory. Unresolved calls are marked as `FOG` via `unresolvedBy`/`unresolvedCalls`, but missing realizers are not explicitly flagged as a separate lens-consistency gap. |
| **(b) dynamic intermediate levels** | LLM may invent levels (e.g., L2.5 policy-enforcement points) or re-weight the ladder per persona | **Not implemented** | The zoom ladder is hard-coded: `LEVELS = [System, Domains, Concepts, Files, Key symbols, All symbols, Detail]` in `apps/web/src/graph.ts:9-16` with fixed `ENTER`/`LEAVE` thresholds (`graph.ts:20-31`). Persona lenses (`packages/core/src/context.ts:150-170`) only reweight salience; they do not change the abstraction ladder. |
| **(c) zoom = question-relative** | Same gesture yields different content under a different task frame | **Implemented** | `packages/core/src/service.ts:911` (`ask`) routes the question, runs `retrieveForQuestion` with question terms/lens/pins (`retrieval.ts:70-90`), and `compileView` builds groups/edges from that bundle. The demo bar explicitly asserts question-relative behavior (`demobar.ts:138`). |
| **(d) animated transitions preserving object identity** | Every transition animates so the human maintains object identity | **Partial / missing** | Identity is preserved: selection/focus survive re-renders (`Canvas.tsx:195-230`, `graph.ts:244` `selectedAggregates`), and the camera is preserved via `cameraPolicy: "PRESERVE"`. But Cytoscape elements are **rebuilt** on each level, not morphed; there is no explicit tween/animation between zoom states. |
| **(e) cached concept-card composition** | Each level is a retrieval of cached concept cards, not re-synthesis | **Partial / missing** | Concept cards are extracted, cached, versioned and merged (`packages/core/src/concepts.ts:50-90`; store tables hold them). They are used for salience scoring (`retrieval.ts` passes `store.concepts(revision)`). But `compileView` (`viewspec.ts`) builds its groups from fresh model output per question, not from cached cards. Only `V14 ConceptAtlas` (`forms/atlas.ts`) actually pins cached concept cards onto code. |

### Cross-language note
Semantic zoom is only as good as the indexer. The README and `service.ts`/worker support TypeScript, Rust, Nirdosha v2, Java, Go, Python, but dynamic calls, reflection, interface dispatch, generics, Spring wiring by name, etc. stay `FOG`. So the model is **not universally possible on every codebase**—it degrades cleanly where analysis is incomplete.

---

## 3. §12 Visual + Conversational Interaction (Bidirectional Protocol)

| Exchange | PRD example | Current state | Evidence / files |
|----------|-------------|---------------|------------------|
| **Text→Visual** | “Show me how authentication works” → L2–L4 map, salience-filtered | **Implemented** | `Service.ask` (`service.ts:911`) routes the question, retrieves, and compiles a `SemanticMap`. The form catalogue (`visuals.ts:23-70`) has builders for 13 specialised forms. |
| Text→Visual (transform same map) | “Now show where sessions can outlive their owners” → same map + invariant overlay + threat edges | **Not implemented as an overlay** | Changing the question currently rebuilds a new `ViewSpec` via `ask`. There is no “overlay lens” that adds invariant/threat edges onto the existing map. Invariants and threats are separate forms (`CausalGraph`, `TrustBoundary`, `PolicyMap`). |
| **Visual→Text** | Select 5 nodes → “Why are these connected?” → per-edge provenance + citations | **Implemented** | `I-07` in `interactions.ts:133` calls `Service.explain` (`service.ts:1030`), which produces claims, citations, and an adversarial challenge pass. `I-06` handles “why am I seeing this?” (`interactions.ts:126`, `service.ts:1071`). |
| **Visual→Visual** | Drag `Payment Validation` between `Risk Engine` and `PaymentService` → intent interpretation, not mutation | **Implemented** | `I-12` (`interactions.ts:170`) calls `ChangeEngine.interpretDrag` (`changes.ts:150`). It returns options and never edits code. The core invariant is documented in `changes.ts:15-20`. |
| **Code→Visual** | Editor selection → auto-focus + partial L5 expansion; breakpoint → animation anchor in flow views | **Partial** | VS Code extension sends `SELECTION`/`BREAKPOINT` events (`extensions/vscode/src/extension.ts:35-55`). `I-17`/`I-19` in `interactions.ts:217-235` turn them into context events and a `RuntimeOverlay`. Partial L5 focus works via `ask` with `seeds`. But there is no visible “animation anchor” that plays along a flow view; breakpoints are represented as runtime-overlay hotspots, not animated anchors. |
| **Runtime→Visual** | Attach trace → timeline replay; log anomaly pulses region; failed test pins red evidence node on hypothesis graph | **Partial** | Runtime ingestion + attribution + replay APIs exist (`packages/core/src/runtime.ts:120-300`). The `RuntimeOverlay` form (`forms/runtime.ts`) projects exceptions/failing tests/ingested spans onto the structure with heat. However, live “pulse on anomaly” is not wired in the UI, and the timeline replay UI is not exposed (only the `C24/replay` API exists). `I-20` (`interactions.ts:238`) opens a hypothesis investigation from a pasted trace. |
| **Visual→Proposed-Code** | Only after intent card confirmed | **Implemented (gated)** | `ChangeEngine` (`changes.ts`) interprets intents, creates `DRAFT` proposals, validates them in an isolated copy, and requires approval via `C28/approve` (`service.ts:557`). `I-12`/`I-13`/`I-14`/`I-15` all return `writesCode: false` intent cards first. |

---

## 4. What “possible everywhere?” means in practice

| “Everywhere” interpretation | Answer |
|------------------------------|--------|
| **Every part of the current codebase** | Mostly yes for the MVP scope, with the gaps above. |
| **Every programming language / repo shape** | No. Supported languages are listed in the README; dynamic/untyped constructs remain `FOG`. |
| **Every abstraction level the PRD names (Product, Architecture, Domain, Components, Behaviour, Code, Implementation)** | Partially. The code has 7 zoom levels, but they map differently (`System/Domains/Concepts/Files/Key symbols/All symbols/Detail`) and are not yet aligned to the PRD’s exact L0–L6 labels or content sources. |
| **Every interaction in §12** | Core exchanges work; overlays, animations, and live runtime pulsing do not. |

---

## 5. Summary blockers if you want full §11/§12 fidelity

1. **Zoom ladder is static** — add persona-specific / question-specific intermediate levels.  
2. **No transition animation** — currently rebuilds Cytoscape elements; need morphing between renderings.  
3. **Zoom levels are not cached concept-card compositions** — `compileView` re-synthesises groups per question.  
4. **No overlay transformation of an existing map** — security/invariant questions switch forms instead of overlaying edges.  
5. **Runtime→Visual is API-first** — need UI-side timeline replay, anomaly pulse, and animated breakpoint anchors.  
6. **Language/static-analysis ceiling** — for “everywhere” coverage, the worker needs richer resolution for Java/Go/Python and dynamic patterns.

No code changes were made.

---

# Part 2 — Validator Report: §13 Visual Manipulation through §27 UX Requirements

**Scope:** Continuation of the code validation against PRD sections 13–27. No code was changed.  
**Additional files inspected:**

- `packages/core/src/changes.ts`, `c22/engine.ts`, `c22/broker.ts`, `c22/types.ts`, `c22/reducer.ts`
- `packages/core/src/forms/hypothesis.ts`, `counterfactual.ts`, `diffview.ts`, `archaeology.ts`, `trust.ts`, `runtime.ts`, `terrain.ts`
- `packages/core/src/history.ts`, `workspaces.ts`, `claims.ts`, `claim-ledger.ts`, `policy.ts`, `redact.ts`, `access.ts`, `tenants.ts`
- `apps/web/src/a11y.ts`, `App.tsx`, `MatrixView.tsx`, `Outline.tsx`, `VisualsGallery.tsx`
- `packages/core/src/evaluation.ts`, `defect/perf.ts`

---

## 6. §13 Visual Manipulation as an Intent Specification Interface

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Interpret, never mutate** | **Implemented** | `ChangeEngine.interpretDrag` (`changes.ts:100`) returns `READY` only when one meaning exists, otherwise `NEEDS_CLARIFICATION` or `REJECTED`. It never edits files. The broader invariant is in `changes.ts:15-20`: “nothing here ever writes to the repository.” |
| **Full UC-22 flow: drag → reading → alternates → intent card → refine → approve → branch/draft PR/test plan** | **Partial** | Drag interpretation exists, and the change engine can build a `ChangeProposal` (`changes.ts:140`) with affected code, tests, risks and limits. However, the current `interpretDrag` only maps **call-site changes** (add/delete calls). It does **not** model “risk evaluation gates payment validation” as a domain/architecture-level intent, nor does it produce branches, draft PRs, or test plans automatically. Those would be downstream of `C28/propose` + `C28/validate` + `C28/exportPatch` (`service.ts:545-560`), but the PR-level automation is not wired. |
| **Learnable gesture vocabulary: reparent, lasso+pull-apart, draw-arrow, drag-onto-boundary** | **Partial** | The interaction catalogue covers `I-12` drag, `I-13` sequence reorder, `I-14` consolidation, `I-15` extraction (`interactions.ts:170-200`). These are concrete code-level intents, not the higher-level architectural vocabulary the PRD describes. There is no **reparenting** of groups or **drawing arrows** on the canvas in the current UI (only box-select and Cytoscape tap/drag for panning). |
| **Ambiguity is a feature** | **Implemented** | `interpretDrag` returns multiple `DragOption` objects with labels and `because` text (`changes.ts:110-118`). `I-12` surfaces them as a clarification (`interactions.ts:171-176`). |

**Verdict:** The “interpret, never mutate” invariant is real, but the UC-22 **full product fantasy** (architecture-level intent → branch + PR + test plan) is only partially present. What exists is a robust code-level intent interpreter and isolated validation pipeline.

---

## 7. §14 Debugging as Visual Hypothesis Exploration (UC-09)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Hypothesis graph with ✓/?/✕/… stages along failure path** | **Partial** | `forms/hypothesis.ts:26` builds a `HypothesisGraph` with a symptom node and ranked suspect nodes. Suspects have `hypothesisState: "SUPPORTED" | "OPEN"`. There is no explicit `REFUTED` or `UNEXPLAINED` node state in the graph builder; elimination is done via `Service.steer` (`service.ts:1015`) which rebuilds the view with an `ignored` set. |
| **Evidence attachments with provenance; ranked by likelihood with reasoning** | **Implemented** | Each suspect node carries `claimIds`, `evidenceIds`, `factors`, `score`, `rank` and `notes` (`forms/hypothesis.ts:104`). `Service.whySuspect` (`service.ts:1114`) returns the ranking factors. The `ClaimCard` UI shows the five gates. |
| **“Why do you suspect balance?” → evidence drawer** | **Implemented** | Routed as `whySuspect` (`service.ts:1111-1120`) and rendered in the evidence drawer (`App.tsx:558-620`). |
| **New logs/tests/verdicts update graph live** | **Partial** | `Service.steer` allows ignore/restore of suspects (`service.ts:1015-1030`). `refreshView` (`service.ts:1002`) rebuilds with current data. Runtime events can be posted via `I-20` (`interactions.ts:238`), but automatic live update (a new exception arriving and re-ranking an open investigation) is not wired in the UI loop. |
| **Persisted as investigation (§23)** | **Implemented** | The C22 engine (`c22/engine.ts`) stores investigations, hypotheses, observations, assessments, steps, attempts and events. `WorkspaceLog` (`workspaces.ts`) persists visual reasoning sessions. |
| **Competing-hypothesis discipline (ACH)** | **Partial** | The C22 engine has explicit hypotheses, predictions, observations and assessments (`c22/engine.ts:49`, `c22/reducer.ts`). The simple pasted-trace hypothesis graph (`forms/hypothesis.ts`) does not yet show discrimination between competing hypotheses; it shows a symptom + ranked suspects. Full ACH UI is in the C22 design doc but not exposed as a primary screen. |

**Verdict:** The durable investigation backbone exists and is sophisticated, but the **default pasted-trace view is a ranked-suspect graph**, not the full ACH matrix the PRD describes.

---

## 8. §15 Architecture Exploration (UC-01/04/06/21/24)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Question-driven architecture views** | **Implemented** | `Service.ask` + `visuals.ts` catalogue maps questions to 16 forms (`SemanticMap`, `CausalGraph`, `Counterfactual`, `ChangeRisk`, etc.). |
| **Declared vs. discovered structure, mismatches flagged (UC-26)** | **Partial** | `viewspec.ts:95-120` can build domain clusters from model output, but there is no explicit “declared vs. discovered mismatch” finding type or community-detection pass in the current builders. |
| **Semantic blast radius — behavior-level** | **Partial** | `Counterfactual` form (`forms/counterfactual.ts`) handles removal-only impact. `ChangeEngine` and `indexer.computeImpact` exist. The analysis is mostly reference/caller-level; deeper behavior-level consequences (new failure modes, invariant risks) are only produced when the model is available and the question is phrased accordingly. |
| **Feature location across layers** | **Implemented** | Retrieval uses keyword, semantic, concept-card and graph factors (`retrieval.ts:70-90`) to locate relevant symbols across files. |
| **Decoupling cost analysis** | **Not implemented** | No dedicated decoupling-cost metric or view exists. |
| **Counterfactual splits** | **Partial** | `buildCounterfactual` (`forms/counterfactual.ts`) supports removal counterfactuals. Moving/merging/async counterfactuals are listed as not implemented in the README. |

**Verdict:** Many building blocks are present, but UC-26-style architectural mismatch findings and decoupling-cost analysis are missing.

---

## 9. §16 Security Analysis

### As a feature family (privilege/egress/policy maps)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Privilege/egress maps: identity → boundary → op → data** | **Implemented** | `buildTrust` (`forms/trust.ts:28`) produces trust-boundary/privilege maps. `buildPolicy` (`forms/trust.ts:82`) produces policy-enforcement matrices. |
| **Inferred enforcement points** | **Implemented** | Trust map proposes gates from `throws` facts and marks unprotected paths as hypotheses (`forms/trust.ts`). |
| **PII flow with egress candidates** | **Partial** | Security analysis (`security.ts`) has PII-in-logs and egress rules. The feature-family maps do not yet draw explicit PII-flow/egress candidate edges. |
| **Policy-vs-implementation drift** | **Partial** | `PolicyMap` shows routes vs. rules and flags escape routes. Drift detection between declared policy files and code is not a separate screen. |
| **Nothing marked “secure”** | **Implemented** | README and forms explicitly say findings are candidates; no finding does not mean safe. Trust-boundary unprotected paths are hypotheses. |

### As product security

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Tenant-isolated indexes** | **Implemented** | `TenantHost` (`tenants.ts:40`) gives each tenant its own DB file and parser process; nothing shared. |
| **Secrets/PII redaction before cloud inference** | **Implemented** | `policy.ts` defines secret regexes; `scrubBundle` removes them before hosted-model egress; `service.ts:349-357` audits the redaction. |
| **Policy knobs per repo (on-prem/cloud/runtime-never-leaves-VPC)** | **Partial** | `egress.policy.allow/deny` (`service.ts:742`) controls whether a repo may use hosted models. Runtime data governance is API-level, not exposed as fine-grained per-repo policy knobs in the UI. |
| **Audit log of every model call and context** | **Implemented** | `service.ts:349-357` writes `egress.approved`/`egress.denied` with purpose, destination, payload hash, redactions. `auditLog` endpoint (`service.ts:746`) exposes the chain. |
| **No cross-tenant learning** | **Implemented** | Tenancy stores and services are isolated; embeddings are tenant-keyed. |

**Verdict:** Product-security fundamentals are solid. Feature-family security maps exist but are not yet as rich as the PRD’s full vision (PII-flow edges, drift detection).

---

## 10. §17 Performance Analysis

### Feature (UC-12)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Profile/trace + code → performance hypothesis map (N+1, chatty hops, serial awaits, lock contention)** | **Partial** | `defect/perf.ts` and `defect-performance.ts` detect N+1, chatty service hops, serial awaits, lock contention. The results are exposed through the defect workflow, not yet as a primary visual map form. |
| **Each hypothesis linked to evidence and code to change** | **Partial** | Findings cite evidence and entities; the defect workflow links to code. A full “performance hypothesis graph” form is not in the 16-form catalogue. |

### System budgets (§29)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Re-render on existing spec < 300 ms** | **Implemented (measured)** | README states map questions in ~30 ms (offline) / ~3 s (hosted). The web layer re-renders with Cytoscape incremental updates where possible. |
| **New view synthesis p50 < 8 s, p95 < 20 s with streaming progress** | **Partial** | Jobs UI (`JobBar.tsx`) shows progress and cancellation. The README reports ~3 s for hosted map questions. Streaming progress messages are not explicit in the current ask flow. |
| **Incremental re-extraction after save < 30 s** | **Not verified** | `indexer.ts` supports incremental indexing, but no explicit “save → <30 s re-extraction” measurement is documented. |
| **Cold index 100 kLOC < 45 min** | **Not verified** | README notes 32 k-line repo indexes in 0.7 s in the demo; 100 kLOC performance is untested and bounded by `CIE_WORKER_RSS_MB`. |

**Verdict:** Performance detectors exist but are not a first-class visual form. System budget claims are partially measured and partially aspirational/unverified.

---

## 11. §18 Code Archaeology (UC-15)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **“Why does this ugly code exist?” → causal history chain** | **Partial** | `buildArchaeology` (`forms/archaeology.ts:20`) joins git history with code comments/constraints. `history.ts` provides archaeology, change sets, review threads. |
| **Incident references from tickets/PRs/comments** | **Partial** | `forms/archaeology.ts` uses commits and code comments. The README explicitly says issues/tickets/incidents have **no connector** yet. Forge connector exists as an API (`connectors.ts`) but is not wired to archaeology screen. |
| **Every link cited (commit, PR, ticket)** | **Partial** | Commit links are cited; PR/ticket links are not because no connector exists. |
| **“What if removed?” / “Is original reason still valid?”** | **Partial** | Counterfactual removal works (`forms/counterfactual.ts`). Validity-of-original-reason is not automated. |

**Verdict:** Archaeology is implemented for commit+comment history, but the full multi-source (tickets, PRs, incidents) knowledge-preservation artifact is not wired.

---

## 12. §19 Change / PR Visualization (UC-16)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Review PR as conceptual change with architecture-level before/after + risk flags** | **Partial** | `buildDiff` (`forms/diffview.ts:14`) builds a semantic diff between two indexed revisions. It can show affected endpoints and tests. |
| **Diff mapped through semantic memory (which concept cards changed)** | **Partial** | Diff view compares symbols between revisions; concept-card change mapping is not explicit. |
| **Consequence propagation over substrate** | **Partial** | `indexer.computeImpact` and `history.assessChangeImpact` exist. The diff view does not yet run full impact propagation automatically. |
| **File diff one click away, never hidden** | **Implemented** | Code evidence cards always link to source spans; the UI never hides the raw diff. |

**Verdict:** Semantic diff exists but is not yet the full PR-review conceptual-change surface the PRD describes.

---

## 13. §20 Runtime Visualization

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Trace → code-stitched temporal replay with scrubber** | **Partial** | `Runtime.replay` (`runtime.ts:250`) provides deterministic replay by cursor. The `C24/replay` API exists (`service.ts`). There is **no UI scrubber** for temporal replay in the web app; `RuntimeOverlay` only has static window buttons. |
| **Map highlights live spans, morphs to deepest relevant abstraction** | **Partial** | `forms/runtime.ts` projects attributed spans/heat onto the static structure. It does not morph abstraction levels as the scrubber moves. |
| **Cross-service causality stitches queues/topics** | **Partial** | Static async-flow edges are shown. Runtime stitching of trace segments across queues is not implemented. |
| **Degrades gracefully when runtime absent** | **Implemented** | `forms/runtime.ts` explicitly gaps when no runtime data is present and falls back to static structure. |

**Verdict:** Runtime attribution and replay APIs are present, but the **visual temporal replay UI** is missing.

---

## 14. §21 Counterfactual Architecture (UC-21)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Dual-layer view: current solid vs. hypothetical (dashed-glow + SPECULATIVE watermark)** | **Partial** | `forms/counterfactual.ts:23` implements removal counterfactuals with ghost/dashed styling. The README says only **removal** is simulated; moving, merging, making async, Redis disappearing, 10× traffic are not. |
| **Inferred consequences as annotated, provenance-tagged claims with confidence bands** | **Partial** | Consequences are attached to the counterfactual view. Full confidence bands per consequence are not displayed. |
| **No speculative element aggregates into “fact” summary** | **Implemented** | Counterfactual nodes are styled as hypotheses/ghosts; legend says they are speculative. The claim pipeline never upgrades a model/speculative claim to FACT (`claims.ts:180`). |

**Verdict:** Removal-only counterfactuals work and are visually honest. The broader “what if…” space (async, traffic, infra loss) is not implemented.

---

## 15. §22 Agentic Investigation (UC-34)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Goal mode: system runs plan → retrieve → analyze → grow visual model → re-plan loop** | **Implemented** | C22 `InvestigationEngine` (`c22/engine.ts:49`) is explicitly designed for this loop: hypotheses, read-only tool plans (`broker.ts`), step attempts, steering (`steerInvestigation` at `engine.ts:980`), and completion reports. |
| **Mid-flight steering (“ignore reporting service”) instantly constrains search and re-plans** | **Implemented** | `steerInvestigation` supports `Prioritize`, `AddScope`, `NarrowScope`, `ExcludeCheck`, etc. (`engine.ts:980-1040`). |
| **Findings accumulate as hypothesis-graph nodes with evidence** | **Implemented** | Hypotheses, observations and assessments are stored and versioned; the canvas workspace can be resumed. |
| **Termination when goal satisfied or budget exhausted** | **Implemented** | `policy.maxPlanSteps`, `policy.maxActiveHypotheses`, `policy.readTimeoutMs` enforce budgets; completion report marks `StopReason`. |

**Verdict:** The agentic investigation engine is the most fully realized part of these sections. The main gap is **UI exposure**: the C22 APIs exist but the default user-facing flow is still the simpler pasted-trace hypothesis graph.

---

## 16. §23 Visual Memory (UC-33)

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Persistent visual reasoning workspaces** | **Implemented** | `WorkspaceLog` (`workspaces.ts`) stores views, selection, pins, notes, hypotheses and claim IDs as an append-only event log with undo/redo. |
| **Day-2 “continue investigation” with change detection** | **Partial** | `WorkspaceLog.resume` (`workspaces.ts`) returns stale/unavailable evidence anchors. The README says continuing an investigation is supported and reports what changed since. However, automatic detection of “new commits touching suspected regions” is partial. |
| **Team-shareable; confirmed findings feed provenance ledger** | **Partial** | `collab.ts` supports sharing workspaces and confirming shared concepts. Confirmed claims go through `applyVerdict` (`claims.ts:220`) and feed the ledger. The web UI does not yet expose sharing. |

**Verdict:** Durable workspaces and collaboration infrastructure exist; UI exposure of sharing is incomplete.

---

## 17. §24 Evidence / Provenance Model

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Evidence codes: STATIC, DERIVED-STATIC, RUNTIME, TEST, HISTORY, DOC, LLM-INFERRED, USER-CONFIRMED, USER-ASSERTED, SPECULATIVE** | **Partial** | Evidence refs have a `class` field; `claims.ts` and forms use `RUNTIME`, `TEST`, `STATIC`, etc. The full 10-code taxonomy is in the schema but not all are produced by current forms. |
| **Visual grammar defaults per evidence type** | **Implemented** | `Canvas.tsx:16-95` maps `displayMode` to line styles: `FACT` solid, `INFERENCE` dashed, `HYPOTHESIS` dotted, `FOG` double. Heat, ghost, runtime hotness, and stale styles exist. |
| **Every element carries evidence list clickable to source** | **Implemented** | `ViewNode`/`ViewEdge` carry `evidenceIds`; `App.tsx:558-620` renders evidence cards with source links. |
| **“Why shown?” / “Why hidden?” on every element** | **Implemented** | `Service.whyShown` (`service.ts:1071`) and `I-09` why-hidden (`interactions.ts:151`) are wired. The UI exposes these via context actions. |
| **LLM-INFERRED → USER-CONFIRMED promotion workflow** | **Implemented** | `applyVerdict` with `CONFIRM` upgrades a claim’s state to `CONFIRMED` (but display stays `INFERENCE` — never FACT) (`claims.ts:180`, `claim-ledger.ts`). |
| **Disputes surfaced, not silently overwritten** | **Implemented** | `applyVerdict` refuses stale versions, preserves verdict history, and marks dependents `STALE` on refutation (`claims.ts:250`). |

**Verdict:** The provenance model is one of the strongest implemented areas. The main gap is full visual grammar differentiation for all 10 evidence codes (some are collapsed into display modes).

---

## 18. §25 Hallucination Controls

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Grounded composition: LLM may reference only SKM entity IDs; renderer validates schema + referential integrity** | **Implemented** | `compileView` (`viewspec.ts`) drops inferred edges referencing unknown entities; `broker.ts:64` refuses unknown entity IDs; schema gateway validates model output (`packages/model/src/gateway.ts`). |
| **Verifier pass: second model checks asserted relations against evidence** | **Implemented** | `Service.explain` (`service.ts:1030`) runs an adversarial `CHALLENGE` model pass on claims; `withChallenge` re-runs gates (`claims.ts:200`). |
| **Citation-first narrative: no claim without citation set** | **Implemented** | `gateClaim` rejects claims with no evidence (`claims.ts:60`). `modelText` strips claims of certainty/links (`claims.ts` helper). |
| **Ephemerality default; inferred views expire unless saved** | **Partial** | Views are ephemeral by default unless saved to a workspace. There is no automatic expiration policy for unsaved inferred views. |
| **Calibrated display + abstention** | **Implemented** | `calibrationGate` (`claims.ts:140`) requires ≥20 human verdicts; otherwise confidence is `NOT_ESTIMATED`. The UI says so. |
| **Regression evaluation on expert-validated ground truth** | **Partial** | `Evaluator` (`evaluation.ts`) runs planted-failure suites and seeded-concepts suites. The README says human expert studies are blocked (not yet run). |
| **User promotion loop as guardrail data** | **Implemented** | Verdicts are stored and used for calibration; refuted claims hide derived content. |

**Verdict:** Layered defenses are real and tested. Automatic ephemerality and full expert benchmark coverage are the gaps.

---

## 19. §26 Permissions / Privacy

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Role-based view scoping (salary/PII-adjacent concepts restricted)** | **Partial** | `AccessPolicy` (`access.ts`) supports denied file prefixes. Per-concept role-based restriction is not implemented. |
| **Per-repo policy: cloud vs. on-prem inference** | **Partial** | `egress.policy.allow/deny` (`service.ts:742`) controls hosted-model use per repo. Finer-grained “semantic extraction on-prem; synthesis in cloud” knobs are not separate. |
| **Ingestion-time redaction of secrets/PII** | **Partial** | Egress redaction is implemented (`policy.ts`, `service.ts:349`). Ingestion-time redaction into the store is not implemented. |
| **Runtime data governed separately from code data** | **Implemented** | Runtime APIs (`runtime.ts`) are separate from indexing; tenant isolation applies to both. |
| **Full audit trail of who saw which synthesized view with which evidence** | **Implemented** | `store.audit` logs every operation (`service.ts`); `auditLog` endpoint returns hash-chained events. |
| **Enterprise deployment modes (SaaS, VPC, fully on-prem)** | **Partial** | Tenancy and loopback-only default (`server.ts`) support on-prem/VPC. SaaS multi-tenant deployment is API-ready but not packaged. |

**Verdict:** Core privacy/audit/tenant infrastructure is solid. Fine-grained role-based concept scoping and ingestion-time redaction are missing.

---

## 20. §27 UX Requirements

| PRD requirement | Current state | Evidence / files |
|-----------------|---------------|------------------|
| **Keyboard-accessible and screen-reader-annotated canvas at L≥4** | **Implemented** | `Canvas.tsx` supports arrow keys, Enter, Space, E, +/-, Escape, O. `graph.ts:282` `outline()` produces a text rendering. `a11y.ts` audits live region, keyboard help, and contrast. |
| **Provenance glanceable: legend one keystroke away; per-panel epistemic summary** | **Partial** | Legend is always shown (`App.tsx:549`). A per-panel “60% static / 25% runtime / 15% inferred” summary is not computed or displayed. |
| **“Why shown?” / “why hidden?” on every element via context menu and ? hover** | **Partial** | Available through chat/commands and selection actions; a universal context menu / ? hover on every node is not visible in the current React components. |
| **Zoom transitions preserve object identity (animated morph, not swap)** | **Partial** | Identity preserved (selection/focus/camera), but elements are rebuilt, not morphed. No motion-reduction-aware morph. |
| **Progressive disclosure tuned per persona; manual override always available** | **Implemented** | Persona lenses (`context.ts:150`) reweight salience; manual pin/boost/demote overrides exist (`service.ts:985`). |
| **Dark/light; low-vision modes; motion-reduction mode** | **Partial** | `styles.css` has `prefers-color-scheme: dark` and `prefers-reduced-motion: reduce`. No explicit low-vision/high-contrast mode beyond the default contrast audit. |
| **Latency honesty: streaming synthesis with progress, cancellable** | **Partial** | Jobs show progress and can be cancelled (`JobBar.tsx`). The `ask` flow does not stream synthesis phases; it returns a complete view after retrieval/model/build. |

**Verdict:** Accessibility and keyboard control are strong. Animated morphing, runtime-style progress streaming, and per-panel epistemic summaries are missing.

---

## 21. Cross-cutting verdict for §13–27

**What is already real:**

- Durable, versioned investigations (C22 + workspaces).
- Five-gate claim pipeline with grounding, consistency, adversarial challenge, calibration, and display rules.
- Tenant isolation, egress redaction, and audit trail.
- Question-driven form catalogue covering architecture, security, runtime, counterfactual, archaeology, change risk.
- Code-level visual intent interpretation that never mutates.
- Keyboard-navigable canvas with text outline and screen-reader annotations.

**What is still aspirational or partial:**

- Full architecture-level intent vocabulary (reparent, draw-arrow, drag-across-boundary) and automatic branch/PR/test-plan generation.
- Animated zoom morphs and overlay transformations of existing maps.
- Full ACH-style hypothesis comparison UI for pasted traces.
- Live runtime anomaly pulsing and a temporal replay scrubber UI.
- Removal-only counterfactuals; broader “what if” scenarios not implemented.
- Multi-source archaeology (tickets, PRs, incidents).
- Per-concept role-based scoping and ingestion-time PII redaction.
- Per-panel epistemic summaries and streamed synthesis progress.
- Full expert-validated regression benchmark suite.

**Bottom line:** The implementation is a credible, honest MVP that covers the **structural and epistemic backbone** of §13–27. The remaining work is mostly **UI surfacing** and **widening the analysis surface**, not adding fundamental new subsystems.

No code changes were made.

---

# Part 3 — Validator Report: PART VI LLM-Native Use-Case Catalogue (UC-01–UC-36)

**Scope:** Validate each of the 36 use cases in the LLM-native catalogue against current code. No code was changed.  
**Additional files inspected:**

- `Code_Intelligence_Component_API_Contracts.md` (use-case/component mapping tables)
- `packages/core/src/forms/journey.ts`, `runtime.ts`, `counterfactual.ts`, `diffview.ts`, `archaeology.ts`, `trust.ts`, `terrain.ts`, `testconf.ts`, `race.ts`, `atlas.ts`
- `packages/core/src/visuals.ts`, `router.ts`
- `packages/core/src/c22/engine.ts`, `defect/perf.ts`, `evaluation.ts`
- `apps/web/src/App.tsx`, `Canvas.tsx`

---

## 22. Family A — Intent-relative understanding

### UC-01 · Intent-Relative Semantic Map — Now
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Show me how authentication works” → SemanticMap at L2–L4, salience tiers | **Implemented** | `Service.ask` (`service.ts:911`) routes to `SemanticMap`; `compileView` (`viewspec.ts`) builds abstraction groups; salience tiers applied (`retrieval.ts:70`). |
| Persona-relative | **Partial** | Lenses (`context.ts:150`) reweight salience; the abstraction ladder itself is not persona-specific (see §11b). |
| Refinements reshape, zoom is question-relative | **Implemented** | `ask` with a refinement rebuilds the view with new question terms; demo bar asserts question-relative behavior (`demobar.ts:138`). |
| 3-bullet narrative + citations | **Implemented** | View caption + claim cards + evidence drawer. |

**Verdict:** Core flagship proof is present.

---

### UC-02 · Failure Causal Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Show me everything that could cause payment to fail” → AND/OR gates, runtime weights | **Partial** | `CausalGraph` form exists (`forms/causal.ts`) but the current implementation is a static failure-space map, not an AND/OR gate graph with runtime-frequency weights. Runtime overlay (`forms/runtime.ts`) can tint hot regions but is not fused into causal gates. |
| “Assume Risk Engine is down” → re-light | **Partial** | Counterfactual assumptions can be asked via `Counterfactual` form, but live assumption toggles on a causal graph are not implemented. |

**Verdict:** Foundation exists; AND/OR combinatorics and runtime-frequency weighting are not implemented.

---

### UC-03 · Invariant Violation Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Why could this balance become incorrect?” → central invariant, writers, tx boundaries, async eventual markers | **Partial** | `DataLineage` (`forms/lineage.ts`) maps writers/readers; `CausalGraph` with `kind: "invariant"` builds invariant graphs. Full violation mechanisms (non-idempotent retries, concurrent updates, reconciliation gaps) are not automatically modeled. |
| Promote suspected invariant to USER-CONFIRMED | **Implemented** | Claim pipeline supports verdicts (`claims.ts:220`). |

**Verdict:** Partial — invariant nodes and writers exist, but violation-mechanism taxonomy is shallow.

---

### UC-04 · Semantic Blast Radius — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “What would break if I remove this class?” → behavioral consequences beyond references | **Partial** | `Counterfactual` form (`forms/counterfactual.ts`) supports removal impact. It lists broken callers, dropped events, lost tests. Behavioral/invariant/SLA consequences rely on model output and are not systematically generated. |
| Convert to change plan (UC-22) | **Partial** | `ChangeEngine` can propose edits for call-site changes (`changes.ts`), but converting a full blast-radius result into a staged plan is not wired. |

**Verdict:** Reference-level blast radius works; behavioral-level consequence taxonomy is shallow.

---

### UC-05 · Cross-Layer Journey — Now
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Show me the path from this UI button to the database” → stitched swimlane | **Partial** | `TransactionJourney` (`forms/journey.ts`) stitches code-level journeys across modules. It does not explicitly bridge UI components → API routes → ORM models → DB schema; the journey stops at resolved function-level edges. Framework-convention inferences (e.g., route handlers) are partial and language-specific. |

**Verdict:** Works for backend/service journeys; full UI→DB cross-layer stitching is limited by language/framework support.

---

### UC-06 · Feature Location — Now
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Where is discount stacking implemented end-to-end?” → concept↔code across naming drift | **Partial** | Concept extraction and `ConceptAtlas` (`forms/atlas.ts`) pin concept cards onto code. Cross-naming-drift matching (discount/promo/markdown/adjustment) depends on model extraction quality and is not guaranteed; user confirmation loop exists (`I-08` verdicts). |

**Verdict:** Implemented in concept layer, but precision is model-dependent.

---

### UC-07 · Onboarding Narrative — Now
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Explain this repo as if I joined today” → guided L0→L2 tour with archaeology snippets | **Not implemented** | No dedicated onboarding tour mode. A generic SemanticMap at low level can be generated, but there is no persisted onboarding curriculum, quiz loop, or adaptive depth. |

**Verdict:** Not implemented as a first-class use case.

---

### UC-08 · Incident Relevance Collapse — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| 3 AM: “Show me only what matters to fixing this exception” | **Partial** | A pasted trace builds a focused `HypothesisGraph` (`forms/hypothesis.ts`) with ranked suspects and collapsed context. Runtime overlay can tint hot regions. There is no explicit “incident relevance collapse” mode that fuses recent deploys + anomalies + task intent into a single auto-collapsed map. |
| “Why did you hide these?” → salience reasons | **Implemented** | `Service.whyShown` (`service.ts:1071`) and `I-09` why-hidden (`interactions.ts:151`). |

**Verdict:** Close via pasted-trace investigation; full multi-signal collapse is not wired.

---

## 23. Family B — Debugging & runtime

### UC-09 · Hypothesis Workspace (Living Investigation) — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Proposing, ranking, revising, eliminating hypotheses from heterogeneous evidence | **Implemented** | C22 `InvestigationEngine` (`c22/engine.ts`) is built for this. Workspaces (`workspaces.ts`) persist hypothesis states. |
| Reasoning, not rendering | **Implemented** | Engine enforces model proposes but cannot grant authority (`c22/engine.ts:9`, `broker.ts:31-38`). |

**Verdict:** The core is real; UI exposure of the full ACH board is limited.

---

### UC-10 · Trace-to-Code Temporal Replay — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Attach trace, scrubber drives morphing map | **Partial** | `Runtime.replay` (`runtime.ts:250`) and `C24/replay` API exist. No UI scrubber; `RuntimeOverlay` is static window-based. |
| Live spans glow, payload/latency overlays | **Partial** | Heat overlays exist; payload/latency overlays only when trace export facts are present. |

**Verdict:** Backend replay exists; UI temporal scrubber and morphing abstraction are missing.

---

### UC-11 · Cross-Service Causality Stitching — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Re-join story across queues/topics using schemas/logs | **Partial** | Static `async-flow` edges are shown in journey and causal forms. Runtime stitching of trace segments across queues is not implemented. |

**Verdict:** Static async edges present; runtime cross-service stitching missing.

---

### UC-12 · Performance Hypothesis Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Profile/trace + code → N+1, chatty hops, serial awaits, lock contention | **Partial** | `defect/perf.ts` and `defect-performance.ts` detect these patterns. Not exposed as a primary visual form in the 16-form catalogue. |
| Ranked hypotheses with mechanisms and fixes | **Partial** | Findings cite evidence and code, but no LLM-authored “fix sketch” is produced in the main UI. |

**Verdict:** Detectors exist; performance hypothesis visual form is missing.

---

### UC-13 · Concurrency & Race Map — Research-leaning
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Shared mutable state, locks, awaits, candidate interleavings | **Partial** | `RaceWindow` form (`forms/race.ts`) exists. It shows execution paths touching shared state and transaction brackets. Full interleaving animation and repro sketches are not implemented. |
| “What if these two run together?” animation | **Not implemented** | No interleaving animation in UI. |

**Verdict:** Static race-window map exists; dynamic interleaving simulation is not implemented.

---

### UC-14 · Semantic Breakpoints / Invariant Watch — Research
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Pause/alert when ledger invariant violated anywhere | **Not implemented** | No instrumentation generation or live invariant watch. The closest is runtime overlay and exception reporting. |

**Verdict:** Not implemented.

---

## 24. Family C — History & change

### UC-15 · Code Archaeology — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Why does this ugly code exist?” → causal history chain | **Partial** | `Archaeology` form (`forms/archaeology.ts`) and `History.archaeology` (`history.ts`) join commits with code comments. Multi-source (incidents, tickets, PRs) not wired; README says no ticket/incident connector. |
| Every link cited (commit/PR/ticket) | **Partial** | Commits cited; PRs/tickets not because no connector. |

**Verdict:** Commit+comment archaeology works; full multi-source chain is missing.

---

### UC-16 · Conceptual PR Diff — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Review PR as architecture-level before/after + risk flags | **Partial** | `SemanticDiff` form (`forms/diffview.ts`) exists. Concept-card-level diff mapping is partial; consequence propagation is API-level (`indexer.computeImpact`) not automatic in the diff view. |

**Verdict:** Semantic diff exists but not yet full architecture-review surface.

---

### UC-17 · Migration Progress Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “How far along is v2-payments-API migration?” → adoption heat, stragglers | **Not implemented** | No `MigrationMap` form or migration-progress builder. |

**Verdict:** Not implemented.

---

### UC-18 · Refactoring Journey Plan — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Plan extraction of notifications into a service, as safe stages” → staged journey with guard checklist | **Partial** | `ChangeEngine` supports extraction proposals (`I-15`, `changes.ts`) with interfaces and risks. No explicit staged journey plan with per-stage verification/rollback checklist. |

**Verdict:** Extraction intent works; full staged journey plan with guards is missing.

---

### UC-19 · Architecture Evolution Movie — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Show how architecture changed over 3 years” → epochs + morphing map | **Not implemented** | No `EvolutionTimeline` form. Historical concept extraction is not sampled/archived. |

**Verdict:** Not implemented.

---

### UC-20 · Regression Archaeology — Research-leaning
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Which change most plausibly introduced this behavior?” | **Not implemented** | No dedicated regression archaeology form. CausalGraph/C22 could be repurposed, but no ranked historical suspect scoring exists. |

**Verdict:** Not implemented.

---

## 25. Family D — Design & counterfactual

### UC-21 · Counterfactual Architecture — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “What if we split the monolith / Redis disappears / 10× traffic?” → dual-layer speculative view | **Partial** | `Counterfactual` form (`forms/counterfactual.ts`) supports removal-only. Moving/merging/async/infra-loss scenarios not implemented (README confirms). |

**Verdict:** Removal counterfactuals only.

---

### UC-22 · Visual Intent Compilation — Near-term (post-MVP)
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Gesture → change plan with risks and open questions | **Partial** | `ChangeEngine.interpretDrag` (`changes.ts:100`) interprets drag as call-site intent; ambiguity surfaced. Architecture-level intents (reparent, draw-arrow, drag-across-boundary) and automatic branch/PR/test-plan generation are not implemented. |

**Verdict:** Code-level intent interpretation exists; full visual intent compilation is not implemented.

---

### UC-23 · Cohesion & Extraction Proposal — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Lasso region → “Could this become one service?” → implicit interface + couplings | **Partial** | `I-15` extraction intent (`interactions.ts:190`) produces interfaces, shared data, and risks. Semantic cohesion scoring and automatic interface discovery are shallow. |

**Verdict:** Extraction proposal exists but is not deeply semantic.

---

### UC-24 · Decoupling Cost Analysis — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Drag two services apart → costed decoupling plan | **Not implemented** | No dedicated decoupling-cost form or visual gesture. |

**Verdict:** Not implemented.

---

### UC-25 · Design Review Canvas — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Shared annotated canvas over proposal layer, evidence-based challenges, ADR draft | **Not implemented** | No shared design-review canvas; sharing is limited to workspaces (`collab.ts`) and not exposed in UI. |

**Verdict:** Not implemented.

---

## 26. Family E — Implicit knowledge & governance

### UC-26 · Implicit Concept Mining — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Show concepts that exist in code but are nowhere declared” → declared vs. discovered, drift flags | **Partial** | `ConceptAtlas` (`forms/atlas.ts`) pins extracted concepts onto code. Explicit declared-vs-discovered mismatch finding and drift flags are not implemented. |

**Verdict:** Concept extraction exists; governance-style drift detection is missing.

---

### UC-27 · Invariant & Enforcement-Point Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Which code enforces no-negative balances, and where is it missing?” | **Partial** | `PolicyMap` (`forms/trust.ts:82`) shows routes vs. rules and escape routes. `TrustBoundary` shows gates. Explicit invariant→enforcement-point coverage with exhaustive write-path enumeration is not implemented. |

**Verdict:** Partial — policy/trust maps exist but not full invariant enforcement coverage.

---

### UC-28 · Security Privilege & Egress Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Where could customer PII escape?” / paths from anonymous request to privileged op | **Partial** | `TrustBoundary` form (`forms/trust.ts:28`) maps identity→boundary→op→data. PII egress candidate edges are not explicitly drawn; security analysis has PII-in-logs rule but no flow-map egress visualization. |

**Verdict:** Trust-boundary map exists; explicit PII egress flow map is missing.

---

### UC-29 · Documentation Drift Map — Now
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Where do docs and code disagree?” → ranked drift inventory | **Not implemented** | No documentation drift form or doc ingestion/comparison pipeline. |

**Verdict:** Not implemented.

---

### UC-30 · Ownership Reality Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Who actually owns payments knowledge?” → de facto ownership, bus-factor | **Implemented** | `Ownership` form (`forms/ownership.ts`) shows declared vs. de-facto ownership with bus-factor heat. History-based inference is present. |

**Verdict:** Implemented.

---

### UC-31 · Uncertainty / Debt Terrain — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Where is our understanding weakest?” → epistemic weakness terrain | **Partial** | `ChangeRisk` terrain (`forms/terrain.ts`) composites coupling, churn, incidents, test gaps, thin knowledge. It does not self-report where the concept layer itself is thin or explicitly label epistemic weakness. |

**Verdict:** Risk terrain exists; explicit epistemic-debt / meta-signal terrain is partial.

---

## 27. Family F — Roles, memory, agency

### UC-32 · Persona-Relative Re-Representation — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Translate system into security ladder identity→boundary→privilege→data, etc. | **Partial** | Lenses (`context.ts:150`) reweight salience but do not change the abstraction ladder. No persona-specific ladders implemented. |

**Verdict:** Partial — salience personas exist, but re-representation ladders do not.

---

### UC-33 · Visual Investigation Memory — Now
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Persisted visual reasoning workspaces; resume with change detection | **Implemented** | `WorkspaceLog` (`workspaces.ts`) persists views, selection, pins, notes, hypotheses, claim IDs. Resume reports stale/unavailable anchors. |

**Verdict:** Implemented.

---

### UC-34 · Agentic Investigation with Mid-Flight Steering — Post-MVP
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| Autonomous multi-step semantic investigation with goal-directed planning and interruption | **Implemented** | C22 engine supports hypotheses, read-only tool plans, step attempts, steering (`engine.ts:980`), budgets, and termination reports. |
| Canvas as agent's working state, visible live | **Partial** | Engine state is stored; live streaming of intermediate steps to the web canvas is not implemented. |

**Verdict:** Engine is real; live visual canvas of agent progress is missing.

---

### UC-35 · Environment / Config Behavioral Diff — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “Why does checkout behave differently in staging?” → behavioral delta map | **Not implemented** | No config/environment diff form. The runtime/exception overlays are static-window, not config-comparison. |

**Verdict:** Not implemented.

---

### UC-36 · Test-Confidence Map — Near-term
| PRD requirement | Current state | Evidence |
|-----------------|---------------|----------|
| “What do tests actually prove about payments?” → semantic coverage overlay | **Implemented** | `TestConfidence` form (`forms/testconf.ts`) and matrix view (`MatrixView.tsx`) show behaviours × tests with assertion-level citations and gap list. |

**Verdict:** Implemented.

---

## 28. Aggregate verdict for UC-01–UC-36

### Implemented (core present)
- **UC-01** Intent-Relative Semantic Map
- **UC-09** Hypothesis Workspace (backend)
- **UC-30** Ownership Reality Map
- **UC-33** Visual Investigation Memory
- **UC-34** Agentic Investigation Engine (backend)
- **UC-36** Test-Confidence Map

### Partially implemented
- UC-02 Failure Causal Map
- UC-03 Invariant Violation Map
- UC-04 Semantic Blast Radius
- UC-05 Cross-Layer Journey
- UC-06 Feature Location
- UC-08 Incident Relevance Collapse
- UC-10 Trace-to-Code Temporal Replay (backend)
- UC-11 Cross-Service Causality Stitching (static)
- UC-12 Performance Hypothesis Map (detectors)
- UC-13 Concurrency & Race Map
- UC-15 Code Archaeology
- UC-16 Conceptual PR Diff
- UC-18 Refactoring Journey Plan
- UC-21 Counterfactual Architecture (removal only)
- UC-22 Visual Intent Compilation (code-level)
- UC-23 Cohesion & Extraction Proposal
- UC-26 Implicit Concept Mining
- UC-27 Invariant & Enforcement-Point Map
- UC-28 Security Privilege & Egress Map
- UC-31 Uncertainty / Debt Terrain
- UC-32 Persona-Relative Re-Representation

### Not implemented
- UC-07 Onboarding Narrative
- UC-14 Semantic Breakpoints / Invariant Watch
- UC-17 Migration Progress Map
- UC-19 Architecture Evolution Movie
- UC-20 Regression Archaeology
- UC-24 Decoupling Cost Analysis
- UC-25 Design Review Canvas
- UC-29 Documentation Drift Map
- UC-35 Environment / Config Behavioral Diff

### Summary
Out of 36 use cases, **6 are substantially implemented**, **21 are partial**, and **9 are not yet implemented**. The MVP is honest about its scope: it covers the structural backbone (semantic maps, hypothesis engine, investigation memory, test confidence, ownership) and leaves many of the more specialized or UI-heavy use cases for later iterations.

No code changes were made.

---

# Part 4 — Validator Report: PART VII Borrowed-Domain Synthesis

**Scope:** Validate each borrowed-domain concept from Part VII against the current implementation. No code was changed.  
**Files inspected:**

- `apps/web/src/TerrainView.tsx`, `App.tsx`, `Canvas.tsx`, `graph.ts`, `arrange.ts`
- `packages/core/src/forms/runtime.ts`, `counterfactual.ts`, `archaeology.ts`, `diffview.ts`, `terrain.ts`, `race.ts`, `trust.ts`, `testconf.ts`
- `packages/core/src/c22/engine.ts`, `reducer.ts`, `broker.ts`
- `packages/core/src/visuals.ts`, `context.ts`, `retrieval.ts`

---

## 29. Cartography / GIS — Layered maps, choropleths, isolines

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **GIS-style toggled overlays over one stable spatial layout** (data-flow, trust, churn, coverage) | UC-28, UC-31, UC-36; spatial memory aid | **Partial** | The base graph now has independent test-confidence and recorded-runtime signal toggles which decorate the drawn nodes without changing layout. Data-flow, trust and churn overlays and matrix/terrain support remain absent; switching forms still creates a separate view. See the implementation tracker above. |
| **Terrain view: elevation = importance, shading = risk, valleys = under-tested** | UC-31 | **Implemented** | `TerrainView` (`apps/web/src/TerrainView.tsx`) and `ChangeRisk` form (`forms/terrain.ts`) render files as a treemap/relief map with heat = composite risk. The “under-tested backwater” is represented by files with low coverage/thin knowledge. |

**Verdict:** Terrain and two stable-graph signal layers are implemented; the full GIS-style layer set remains incomplete.

---

## 30. Medical imaging — Multi-modal fusion, contrast agents, slicing axis

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Static graph (CT) + runtime evidence (MRI) fused in one canvas with modality toggle** | UC-10, UC-12 | **Partial** | `RuntimeOverlay` (`forms/runtime.ts`) overlays reported exceptions/failing tests onto the static structure. It is a single fused view, not a modality toggle. Trace-driven “contrast injection” (highlighting a trace path through the structure) is not animated. |
| **Slice the system along any axis: by request, data entity, time, persona** | UC-01, UC-32 | **Partial** | Questions can filter by topic (`retrieveForQuestion`), personas reweight salience (`context.ts:150`), and journeys slice by operation (`forms/journey.ts`). A unified “slice along an axis” control is not exposed. |

**Verdict:** Runtime overlay exists; modality toggle and explicit slicing UI do not.

---

## 31. Systems biology — Pathway diagrams (activation / inhibition / catalysis / guards)

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Relation vocabulary beyond “calls”: activates / inhibits / guards / catalyzes** | UC-02, UC-27 | **Partial** | Edges have `kind` and `label` (`calls`, `reaches`, `async-flow`, `may-explain`, `implemented at`, `missing at`, `exit`, `depends-on`). However, the specific biology-derived vocabulary (`activates`, `inhibits`, `guards`, `catalyzes`) is not produced. Trust-boundary maps use `gate`/`unprotected-path` semantics (`forms/trust.ts`), which is closest to “guards.” |

**Verdict:** Rich edge types exist but the exact systems-biology vocabulary is not adopted.

---

## 32. Causal inference — DAGs, do-calculus, confounders

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Explicit `may_cause` edges vs. observed correlation** | UC-02, UC-21 | **Partial** | `CausalGraph` (`forms/causal.ts`) uses static call edges and failure sites; the PRD’s semantic `may_cause` edges are not explicitly generated. Counterfactuals are removal-only, not true do-operations. |
| **“Intervene” gestures (e.g., “what if Redis disappears”)** | UC-21 | **Partial** | Counterfactual form supports removal via natural-language query (`forms/counterfactual.ts:12`). Interactive “intervene” toggles on a causal graph are not implemented. |
| **Confounder flags where two failure sources co-occur** | UC-02 | **Not implemented** | No confounder detection in `CausalGraph` or C22 engine. |

**Verdict:** Causal forms exist but are not yet true causal-inference diagrams.

---

## 33. Genomics — Genome-browser tracks, sequence alignment

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Stacked temporal tracks over code regions: commits, incidents, deploys, coverage-over-time** | UC-15, UC-19 | **Not implemented** | `Archaeology` form (`forms/archaeology.ts`) shows commits per symbol, not stacked tracks across the codebase. Evolution movie is not implemented (UC-19). |
| **Align two implementations by semantic correspondence** | UC-17, UC-21 | **Not implemented** | No semantic alignment view for current-vs-deleted service or v1-vs-v2 API. Semantic diff compares two indexed revisions but does not align by semantic correspondence. |

**Verdict:** Not implemented.

---

## 34. Network science — Centrality, community detection

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Declared modules vs. discovered communities; mismatches surfaced as accidental architecture** | UC-26 | **Partial** | `compileView` (`viewspec.ts:95-120`) can build model-proposed domain clusters over file/concept groups. There is no explicit declared-vs-discovered community-detection pass or “accidental architecture” finding type. Force layout (`apps/web/src/layout.ts`) does community-like spatial grouping but not formal community detection. |

**Verdict:** Partial — inferred clusters exist, but mismatch surfacing is not a feature.

---

## 35. Intelligence analysis — Analysis of Competing Hypotheses (ACH)

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Hypothesis matrix × evidence; discriminating evidence visually emphasized** | UC-09, UC-34 | **Implemented (backend)** | C22 engine (`c22/engine.ts`) is explicitly structured around competing hypotheses, predictions, discriminating checks, observations, and assessments (`c22/reducer.ts`). The simple pasted-trace `HypothesisGraph` (`forms/hypothesis.ts`) does not render the full ACH matrix; that UI would be built on top of C22. |

**Verdict:** The intellectual spine is implemented in the engine; UI matrix visualization is missing.

---

## 36. Control rooms — Alarm hierarchy, situation awareness, salience discipline

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Alarm-style salience tiers with why-shown on every deviation** | UC-08, CE-7 | **Implemented** | Four salience tiers (`CRITICAL`, `RELEVANT`, `CONTEXT`, `HIDDEN`) with per-element `factors` and `whyShown` (`service.ts:1071`). Runtime hotness and failing tests boost elements (`context.ts:150-170`). |

**Verdict:** Implemented.

---

## 37. Game UI — Fog of war, quest markers, minimap

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Unexplored regions fogged per-user; current task as quest marker; minimap = L0 capability map** | UC-07, UC-31; onboarding delight | **Not implemented** | No per-user exploration fog. The L0 system view exists (`graph.ts` aggregation to `agg:system`) but is not used as a minimap. No quest-marker UI for current task. |

**Verdict:** Not implemented.

---

## 38. Digital twins — Live state sync + what-if simulation

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Twin reflects runtime; counterfactuals become simulations, not LLM sketches** | R4 | **Not implemented** | Runtime ingestion (`runtime.ts`) exists but there is no live digital-twin sync. Counterfactuals are LLM/static sketches, not simulations. Isolated experiments (`defect-isolation.ts`) can run code, but not as a system-wide twin. |

**Verdict:** Not implemented.

---

## 39. XAI — Saliency maps, explanation artifacts

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **“Why shown” overlays as saliency visualization for the relevance model** | §24, UC-08 | **Implemented** | `Service.whyShown` (`service.ts:1071`) lists salience factors per element. Evidence drawer shows the underlying evidence. The `a11y.ts` contrast/label audit supports inspectability. |

**Verdict:** Implemented.

---

## 40. Temporal visualization — Braid diagrams, river confluences

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Concurrent request interleavings as braided strands; queue fan-out as river confluences** | UC-13 | **Not implemented** | `RaceWindow` (`forms/race.ts`) shows parallel lanes and transaction brackets. Braid/river visual metaphors are not used. |

**Verdict:** Not implemented.

---

## 41. Archaeology (real) — Stratigraphy

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **History rendered as strata per code region: epochs, each annotated with incident/driver** | UC-15, UC-19 | **Not implemented** | `Archaeology` form is a vertical timeline of commits for one symbol, not stratified layers across the codebase with incident/driver annotations. |

**Verdict:** Not implemented.

---

## 42. Flight decks — Checklists bound to state

| Borrowed concept | PRD instantiation | Current state | Evidence |
|------------------|-------------------|---------------|----------|
| **Refactoring journeys as state-bound checklists; step can’t be marked done until guard evidence is green** | UC-18 | **Partial** | `ChangeEngine` validates proposals in an isolated copy (`changes.ts` validation). However, there is no checklist UI bound to refactoring stages with per-stage guard evidence. |

**Verdict:** Validation exists; checklist UI does not.

---

## 43. Aggregate verdict for Part VII borrowed-domain synthesis

### Implemented concepts
- **Cartography terrain** (elevation = conceptual importance/risk).
- **Control-room salience discipline** (tiers + why-shown).
- **XAI saliency / explanation overlays** (why-shown + evidence).
- **ACH intellectual spine** (C22 backend).

### Partially implemented
- Medical-imaging fusion (`RuntimeOverlay` as single fused view, no modality toggle).
- Medical-imaging slicing axis (questions/personas/journeys, no unified slice control).
- Systems-biology relation vocabulary (rich edge kinds, not the exact `activates/inhibits/guards/catalyzes` set).
- Causal inference DAGs (`CausalGraph` static, not true causal edges / do-operations).
- Network-science community detection (inferred clusters, no declared-vs-discovered mismatch findings).
- Flight-deck checklists (isolated validation, no checklist UI).

### Not implemented
- GIS-style layer toggles over a stable layout.
- Genome-browser temporal tracks.
- Sequence alignment of implementations.
- Game-UI fog of war / quest markers / minimap.
- Digital twins / live state sync / simulation-backed counterfactuals.
- Temporal braid/river concurrency visualizations.
- Archaeological strata view.

### Bottom line
The implementation selectively borrows the metaphors that are easiest to ground in the existing architecture (terrain, salience tiers, explanation overlays, ACH backend). The more UI-heavy or simulation-heavy metaphors (layer toggles, digital twins, genome tracks, game fog, braid diagrams) are absent. This matches the MVP’s emphasis on **epistemic honesty and structural analysis** over **visual delight and interactive simulation**.

No code changes were made.

---

# Part 5 — Validator Report: PART VIII Visualization Catalogue (18 Archetypes)

**Scope:** Validate the 18 visualization archetypes in Part VIII against current implementation. No code was changed.  
**Files inspected:**

- `packages/core/src/visuals.ts`
- `packages/core/src/forms/` (all form builders)
- `apps/web/src/App.tsx`, `Canvas.tsx`, `arrange.ts`, `graph.ts`, `TerrainView.tsx`, `MatrixView.tsx`, `Outline.tsx`

---

## 44. SemanticMap

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** concepts/components and typed relations at chosen abstraction | **Implemented** | `compileView` (`viewspec.ts`) builds nodes from symbols, edges from `calls`/`inferredEdges`, groups from concepts/clusters. |
| **Grammar:** spatial clusters, typed edges, salience tiers, provenance line styles | **Implemented** | `graph.ts:109-200` aggregates by concept/file; `Canvas.tsx:16-95` maps `displayMode` to line styles; salience tiers via `retrieval.ts`. |
| **Interaction:** zoom, expand/collapse, select-as-referent, overlay lenses | **Partial** | Zoom and select-as-referent are implemented (`Canvas.tsx`, `interactions.ts`). Overlay lenses (data/trust/churn/coverage) are not; switching forms rebuilds the view. |
| **Zoom:** L0→L6 lens-consistent expansion | **Partial** | Seven levels exist (`graph.ts:9-16`) but are not aligned to PRD labels/content sources; lens-consistency is partial (§11a). |
| **Context:** fully question-relative | **Implemented** | `Service.ask` rebuilds per question (`service.ts:911`). |
| **Provenance:** full grammar | **Implemented** | Every element has `displayMode`, `evidenceIds`, `claimIds`; claim cards show five gates. |

**Verdict:** Core map implemented; overlay lenses and exact PRD zoom ladder are missing.

---

## 45. CausalGraph

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** causal/gating relations with AND/OR failure combinatorics | **Partial** | `forms/causal.ts:60` builds a failure-space graph with operations → throw sites. AND/OR gate nodes and inhibitory edges are not generated. |
| **Grammar:** gate nodes, blunt-ended inhibitory edges, runtime-frequency weights | **Not implemented** | No gate nodes or inhibitory edges. Runtime overlay exists but is not fused into causal graph edges. |
| **Interaction:** assumption toggles re-light paths; hypothesis pinning | **Partial** | Counterfactual assumptions can be asked via `Counterfactual` form; live re-lighting toggles are not implemented. Pasting a trace opens a `HypothesisGraph`. |
| **Zoom:** L2→L4 | **Partial** | All forms render at level 5 by default; levels 3–5 vary by aggregation. |
| **Provenance:** causal edges LLM-INFERRED by default, dashed unless trace-observed | **Partial** | Causal/failure edges are mostly static `FACT` or `HYPOTHESIS` for async; no explicit “trace-observed” upgrade. |

**Verdict:** Failure-space map exists; true AND/OR causal graph with gates is missing.

---

## 46. HypothesisGraph

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** investigation state with ✓/?/✕/… statuses, evidence attachments, ranking | **Partial** | `forms/hypothesis.ts` builds a ranked-suspect graph with `hypothesisState: SUPPORTED | OPEN`. No explicit `REFUTED` or `UNEXPLAINED` statuses in the graph; elimination is via ignore list. |
| **Grammar:** status colors, evidence chips, discrimination highlighting | **Partial** | Evidence chips and status colors exist. Discrimination highlighting (ACH matrix) is not rendered. |
| **Interaction:** attach evidence, ask “why suspect X?”, confirm/eliminate | **Implemented** | `whySuspect` (`service.ts:1114`), verdicts (`claims.ts:220`), `steer` ignore/restore (`service.ts:1015`). |
| **Zoom:** L3↔L5 | **Partial** | Default level 5; aggregation handles L3-ish views. |
| **Context:** bound to persisted investigation | **Implemented** | `WorkspaceLog` (`workspaces.ts`) and C22 engine (`c22/engine.ts`) persist investigations. |

**Verdict:** Ranked-suspect graph implemented; full ACH discrimination matrix is missing.

---

## 47. JourneyTrace

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** end-to-end path across layers/services incl. async hops | **Partial** | `TransactionJourney` (`forms/journey.ts`) builds code-level swimlane journeys. “Across layers” (UI→API→service→ORM→DB) is not fully stitched; async hops are shown with `async-flow` edges. |
| **Grammar:** swimlanes, mailbox glyphs, per-hop artifact links | **Partial** | Swimlanes exist. Mailbox glyphs and per-hop artifact links are not rendered. |
| **Interaction:** expand hop, pin moments, overlay data | **Partial** | Nodes can be selected; overlay data not implemented. |
| **Zoom:** L3→L6 per-hop | **Partial** | All at level 5; semantic zoom aggregation can produce L3-ish views. |

**Verdict:** Transaction journey map implemented; full cross-layer JourneyTrace with mailbox glyphs is missing.

---

## 48. TemporalReplay

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** execution over time, morphing abstraction | **Not implemented (UI)** | `Runtime.replay` API (`runtime.ts:250`) provides deterministic replay. No web UI scrubber or morphing abstraction. |
| **Grammar:** scrubber, live-span glow, payload/latency overlays, anomaly markers | **Partial** | Payload/latency overlays appear when trace-export facts exist; no scrubber or animated live-span glow. |
| **Context:** requires attached trace; degrades to JourneyTrace | **Partial** | API exists; UI degradation not needed because UI replay is missing. |

**Verdict:** Backend replay exists; the TemporalReplay visual archetype is not implemented in the UI.

---

## 49. LineageMap (data)

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** data entity flows: producers, transformers, stores, consumers, egress | **Partial** | `DataLineage` (`forms/lineage.ts`) maps writers and readers of a field with transaction boundaries. Producers/transformers/stores/consumers/egress taxonomy is not explicit. |
| **Grammar:** entity-centric layout, boundary membranes, direction-weighted flows | **Partial** | Entity (field) at center, writers left, readers right; transaction region membrane exists. Direction-weighted flows are not weighted by volume. |
| **Interaction:** “who writes this field?”, egress drills | **Partial** | Field selection via question works; egress drill-down is not implemented. |
| **Zoom:** field ↔ column ↔ payload ↔ PII class | **Not implemented** | Single field-level view only. |

**Verdict:** Writer/reader lineage map implemented; full data-flow taxonomy and zoom ladder are missing.

---

## 50. PrivilegeMap

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** identity → boundary → privileged op → sensitive data | **Partial** | `TrustBoundary` (`forms/trust.ts:28`) maps entry → gate → protected state. Identity layer is abstract (“outside”) because real traffic identities are not available (`trust.ts:78`). |
| **Grammar:** boundary membranes, lane structure, enforcement badges, missing-enforcement flags | **Implemented** | Zones (`outside`, `gate`, `inside`, `data`), gate nodes, unprotected-path hazard nodes, policy matrix with escape routes. |
| **Interaction:** assumption toggles (“endpoint made public”), audit export | **Not implemented** | No interactive assumption toggle on boundaries; audit narrative exists via security API but not as export from the map. |
| **Zoom:** identity → role check → code → data | **Partial** | Single-level view; semantic zoom can aggregate but not to identity/role levels. |

**Verdict:** Trust-boundary/privilege map implemented; identity zoom and interactive assumptions are missing.

---

## 51. InvariantMap

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** invariant + all violation/enforcement paths | **Partial** | `CausalGraph` with `kind: "invariant"` (`forms/causal.ts:155`) shows a central field node with writer rings and transaction boundaries. It does not explicitly model enforcement points or violation mechanisms. |
| **Grammar:** central invariant node, writer rings, tx-boundary arcs, async eventual markers | **Partial** | Central field node and writer rings exist; tx region exists; async eventual markers are notes/edges, not explicit visual glyphs. |
| **Interaction:** retry/interleaving simulations, enforcement-point proposals | **Not implemented** | No simulation or enforcement-point proposal UI. |

**Verdict:** Invariant writer graph exists; full InvariantMap with simulations/proposals is missing.

---

## 52. StateMachineMap (inferred)

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** implicit entity state machines | **Not implemented** | No `StateMachineMap` form. Concept extraction can identify workflows, but no explicit inferred-state-machine visualizer exists. |
| **Grammar:** states as regions, transitions as edges, sources cited | **Not implemented** | — |
| **Interaction:** “which code sets this state?”, conflict flags | **Not implemented** | — |

**Verdict:** Not implemented.

---

## 53. ConcurrencyMap

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** actors, shared state, locks, interleaving hazards | **Partial** | `RaceWindow` (`forms/race.ts`) shows execution paths touching shared state with transaction brackets and interleaving hazards. |
| **Grammar:** lanes, lock-token glyphs, hazard edges, braid strands | **Partial** | Lanes and hazard edges exist; lock-token glyphs and braid strands are not rendered. |
| **Interaction:** pairwise interleaving animation, repro sketches | **Not implemented** | No interleaving animation or repro-sketch generation. |

**Verdict:** Static race-window map exists; full ConcurrencyMap animation is missing.

---

## 54. TerrainMap (churn/risk/uncertainty)

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** components with elevation = importance, color/fog = risk/weakness | **Implemented** | `ChangeRisk` form (`forms/terrain.ts`) + `TerrainView` (`apps/web/src/TerrainView.tsx`) render a relief/treemap with composite risk and tunable weights. |
| **Grammar:** contour shading, fog density, signal-source popovers | **Partial** | Treemap cells tinted by risk; fog noted for thin data. Popovers show evidence on selection. |
| **Interaction:** region select → task list; “de-fog plan” | **Partial** | Region selection works; no automatic “de-fog plan” generation. |
| **Zoom:** L1↔L3 | **Partial** | Terrain is file-level; aggregation to higher levels is not explicit. |

**Verdict:** Terrain implemented; de-fog plan and multi-level terrain are partial.

---

## 55. EvolutionTimeline

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** architectural epochs and transitions | **Not implemented** | No `EvolutionTimeline` form. Historical concept extraction is not sampled/archived. |

**Verdict:** Not implemented.

---

## 56. CounterfactualSplit

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** current vs. hypothetical architecture + inferred consequences | **Partial** | `Counterfactual` form (`forms/counterfactual.ts`) shows current code solid and removed target ghost-outlined with consequences. Split-pane dual layer is not used. |
| **Grammar:** dual layer / split pane, dashed-glow hypothetical, SPECULATIVE watermark, confidence bands | **Partial** | Hypothetical nodes use dashed/ghost styling; no split pane, glow, watermark, or confidence bands in UI. |
| **Interaction:** “commit to this” → routes to UC-18/22 planning | **Partial** | Counterfactual consequences can be inspected; converting to a change plan is not wired. |

**Verdict:** Counterfactual overlay exists; full split-pane planning handoff is missing.

---

## 57. ConceptDiff

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** conceptual change of PR/commit-range + consequences | **Partial** | `SemanticDiff` (`forms/diffview.ts`) compares two indexed revisions side by side with commit list and affected endpoints. Concept-card-level diff mapping is partial. |
| **Grammar:** before/after mini-maps, consequence ledger | **Partial** | Before/after nodes exist; consequence ledger is not as rich as PRD describes. |
| **Interaction:** item → code diff; flag false consequence (trains model) | **Partial** | Evidence cards link to code; no “flag false consequence” workflow. |

**Verdict:** Semantic diff exists; full conceptual PR diff is partial.

---

## 58. CapabilityMatrix

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** business capabilities × system components, heat = strength/duplication | **Not implemented** | No `CapabilityMatrix` form. `ConceptAtlas` maps concepts to code but not as a capabilities × components matrix. |

**Verdict:** Not implemented.

---

## 59. ConfidenceOverlay

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** test-assertion confidence over any map | **Partial** | Test-to-code reachability, failing test status and available line coverage can now decorate an existing graph, alongside the standalone `TestConfidence` matrix/graph. Assertion-level confidence over arbitrary maps is still not fused into this overlay. |
| **Grammar:** green/yellow/red heat + assertion citations | **Implemented** | Matrix cells use glyphs/colors and cite assertions. |
| **Interaction:** gap → test sketch | **Partial** | Gaps are shown; automatic test-sketch generation is not implemented. |

**Verdict:** A basic test-signal overlay now decorates arbitrary graph views; the assertion-level confidence overlay and gap-to-test sketch remain open.

---

## 60. OwnershipLinkChart

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** concepts ↔ people; declared vs. de facto | **Implemented** | `Ownership` form (`forms/ownership.ts`) shows files under owners with declared vs. de-facto styles and bus-factor heat. |
| **Grammar:** link chart, declared (badged) vs. inferred (dashed), bus-factor heat | **Implemented** | Owner columns, import links drawn faint, heat from thin knowledge. |
| **Interaction:** departure simulation | **Not implemented** | No interactive departure simulation. |

**Verdict:** Ownership map implemented; departure simulation missing.

---

## 61. UncertaintyFog

| PRD field | Current state | Evidence |
|-----------|---------------|----------|
| **Encoded:** TerrainMap + self-reported model confidence | **Partial** | `ChangeRisk` terrain shows fog for thin data. Self-reported model confidence (concept-layer thinness) is not explicitly rendered on the terrain. |

**Verdict:** Partial — fog exists for data gaps, not for model epistemic weakness.

---

## 62. Aggregate verdict for Part VIII

### Implemented archetypes (core present)
1. **SemanticMap**
2. **HypothesisGraph** (ranked-suspect form)
3. **JourneyTrace** (`TransactionJourney`)
4. **LineageMap** (`DataLineage`)
5. **PrivilegeMap** (`TrustBoundary`)
6. **InvariantMap** (`CausalGraph` invariant form)
7. **ConcurrencyMap** (`RaceWindow`)
8. **TerrainMap** (`ChangeRisk`)
9. **ConfidenceOverlay** (`TestConfidence` as standalone)
10. **OwnershipLinkChart** (`Ownership`)
11. **CounterfactualSplit** (`Counterfactual` overlay)
12. **ConceptDiff** (`SemanticDiff`)

### Not implemented archetypes
13. **TemporalReplay** — backend replay only, no UI scrubber/morphing.
14. **StateMachineMap** — no inferred state-machine visualizer.
15. **EvolutionTimeline** — no architectural-epochs view.
16. **CapabilityMatrix** — no capabilities × components matrix.
17. **UncertaintyFog** — fog for data gaps only, not model confidence.

### Cross-cutting gaps
- Overlay lenses (data/trust/churn/coverage) on a stable layout are not implemented.
- Interactive assumption toggles on causal/security maps are missing.
- Animated transitions / morphing between abstraction levels are missing.
- Split-pane dual-layer views for counterfactuals/diffs are missing.
- Most archetypes stop at one zoom level rather than supporting the PRD’s full zoom ladders.

### Bottom line
The MVP implements **12 of the 18 archetypes in some form**, but only a handful are complete against the PRD spec. The missing pieces are largely **UI/interaction depth** (scrubbers, animations, overlays, split panes, simulations) and **a few entirely new forms** (state-machine map, evolution timeline, capability matrix). The structural/provenance foundation is strong enough to support these additions.

No code changes were made.

---

# Part 6 — Validator Report: End-State Vision (“From maps to twin… the continuous semantic model was the product all along”)

**Scope:** Validate the end-state trajectory statement against the current implementation. No code was changed.  
**Files inspected:**

- `packages/core/src/runtime.ts`, `c22/engine.ts`, `changes.ts`, `workspaces.ts`, `claims.ts`, `claim-ledger.ts`, `store.ts`
- `apps/web/src/App.tsx`, `Canvas.tsx`
- `README.md` (explicit limits and future-state notes)

---

## 63. The four trajectory claims

### 63.1 “From maps to twin — runtime adapters make the semantic model stateful”

| End-state claim | Current state | Evidence |
|-----------------|---------------|----------|
| Runtime adapters continuously update the semantic model with traces, flags, deploys, incidents | **Partial** | `Runtime` (`runtime.ts`) ingests spans, records deployment markers, attributes spans to code, and supports window/replay queries. However, this is an **API-level intake and query system**, not a continuously updated live twin synced to the web canvas. The README explicitly says: “V9 in the UI is reported data… Span ingestion with sampling, timestamps and replay exists as an API, with no screen and no live daemon.” |
| The map becomes a view of the system, not just code | **Partial** | `RuntimeOverlay` (`forms/runtime.ts`) projects exceptions and failing tests onto the static structure. It does not yet show live system state or animate as the system runs. |

**Verdict:** Intake and attribution infrastructure exist; live twin UI does not.

---

### 63.2 “From counterfactual to simulation — R4's simulation backing turns speculation into executed prediction”

| End-state claim | Current state | Evidence |
|-----------------|---------------|----------|
| “What if Redis disappears” becomes an executed prediction with empirical confidence | **Not implemented** | `Counterfactual` form (`forms/counterfactual.ts`) supports **removal-only** counterfactuals as static/LLM sketches. The README says: “V11 simulates only removal, not moving, merging or making code asynchronous.” There is no shadow-traffic or synthetic-schedule simulation backing. |
| Empirical confidence bands on speculative consequences | **Partial** | Claim pipeline supports `HYPOTHESIS`/`INFERENCE` display modes and calibration (`claims.ts`), but not empirical simulation-backed confidence. |

**Verdict:** Simulation-backed counterfactuals are not implemented.

---

### 63.3 “From intent cards to intent-level engineering — manipulating the twin compiles intent into staged, guarded, test-carrying changes”

| End-state claim | Current state | Evidence |
|-----------------|---------------|----------|
| Gesture → plan → PR loop | **Partial** | `ChangeEngine` (`changes.ts`) interprets drag gestures as call-site intents and produces isolated, validated change proposals (`DRAFT` → validation → approval → patch export). However, it only handles code-level call-site changes (`ADD_CALL`, `DELETE_CALL`, `RENAME`, etc.). Architecture-level intents (drag boundary, pin invariant, split capability) are not interpreted, and no PR is generated automatically. |
| Staged, guarded, test-carrying changes | **Partial** | Proposals are validated in an isolated copy with compile and test checks (`changes.ts` validation). Guards are present as limits and validation reasons, but not as state-bound checklists. |

**Verdict:** Code-level intent pipeline exists; architecture-level intent engineering and automatic PR generation are missing.

---

### 63.4 “From personal memory to institutional mind — the provenance ledger becomes the organization's verified knowledge graph”

| End-state claim | Current state | Evidence |
|-----------------|---------------|----------|
| Provenance ledger as organizational knowledge graph | **Partial** | Claims, verdicts, and investigations are persisted (`claims.ts`, `claim-ledger.ts`, `workspaces.ts`, `c22/engine.ts`). Verdicts train calibration and refutations propagate staleness (`claims.ts:250`). Team sharing and concept confirmation exist in `collab.ts`. However, the web UI does not expose cross-team knowledge browsing, audit narratives are API-only, and the ledger is not presented as an institutional “mind” searchable across history. |
| Onboarding, audits, reviews, post-mortems all read from and write to the same living model | **Partial** | Some forms (Ownership, Archaeology, TrustBoundary, TestConfidence) produce outputs useful for these activities, but there is no unified workflow surface. The onboarding narrative use case (UC-07) is not implemented; post-mortem/incident workflows are partial. |
| Key-person risk collapses because tribal knowledge is addressable | **Partial** | `Ownership` form surfaces de-facto ownership and bus-factor risk; `Archaeology` links commits to constraints. The full “addressable tribal knowledge” vision requires multi-source archaeology and searchable investigation memory, which are partial. |

**Verdict:** Durable provenance and memory exist; institutional-wide knowledge graph UI and write-back workflows are partial.

---

## 64. “The end-state test” — new engineer asks, “What would break if we made this synchronous?”

| What the test asks for | Current capability | Gap |
|------------------------|--------------------|-----|
| Understand the proposed change in natural language | `Service.ask` can parse questions; `Counterfactual` handles “remove X” | Cannot yet interpret “make this synchronous” as a specific counterfactual operation. |
| Trace the affected paths statically | Static call graph + async-flow edges exist | Fine-grained async→sync transformation analysis is not implemented. |
| Pull in runtime history and current behavior | Runtime ingestion and replay API exist | Not fused into the counterfactual answer automatically. |
| Evidence-grade every claim | Five-gate claim pipeline exists | Simulation/empirical evidence for the specific change is absent. |
| Show the system's own history at relevant points | Archaeology form exists | Multi-source history (incidents, PRs, tickets) not wired. |
| Present reasoning visibly at every claim | Claim cards + whyShown exist | Reasoning for the specific async→sync transformation is not generated. |

**Verdict:** The end-state test is **not yet passable**. The pieces exist in fragments, but they are not integrated into a single question→evidence-graded answer flow for design-level changes.

---

## 65. Aggregate verdict on the end-state vision

### What is already built (foundations)
- **Runtime intake and attribution** API (`runtime.ts`).
- **Durable claim ledger** with human verdicts, calibration, and staleness propagation (`claims.ts`, `claim-ledger.ts`).
- **Investigation engine** for competing hypotheses and mid-flight steering (`c22/engine.ts`).
- **Workspace memory** for visual reasoning sessions (`workspaces.ts`, `collab.ts`).
- **Isolated change validation** pipeline (`changes.ts`).
- **Question-driven semantic maps** with provenance (`compileView`, `visuals.ts`).

### What the end-state needs that is missing
- **Live digital twin UI** — continuous sync of runtime state to the canvas.
- **Simulation-backed counterfactuals** — shadow traffic, synthetic schedules, empirical confidence.
- **Architecture-level intent compiler** — drag boundaries, pin invariants, split capabilities into staged plans.
- **Unified institutional knowledge surface** — searchable, cross-functional, reading and writing the same model.
- **Natural-language design-change interpreter** — “make this synchronous” → specific counterfactual/scenario.

### Bottom line
The end-state vision is **not implemented**, but the codebase has laid the epistemic and structural foundations needed to build it. The trajectory from “maps” to “twin” is credible because the durable substrate (claims, runtime intake, investigations, workspaces, change validation) already exists. The remaining work is the **integration layer** that fuses these into a live, simulatable, intent-compilable system model — and the UI that makes it feel like a twin rather than a collection of separate forms.

No code changes were made.

---

# Part 7 — Strategic Analysis: Exposing Cartograph as an MCP Server

**Scope:** A concrete architectural and strategic analysis of exposing the Cartograph Engine as a Model Context Protocol (MCP) server. This section connects the code findings in Parts 1–6 to a distribution and product strategy. No code was changed.  
**Files referenced for mapping:**

- `packages/core/src/service.ts` — the typed operation layer
- `packages/core/src/server.ts` — current HTTP wrapper
- `packages/core/src/viewspec.ts`, `apps/web/src/graph.ts:282` — ViewSpec and text outline rendering
- `packages/core/src/concepts.ts`, `retrieval.ts`, `salience.ts` — SKM concept layer
- `packages/core/src/c22/engine.ts`, `workspaces.ts`, `collab.ts` — durable investigations and memory
- `packages/core/src/changes.ts` — intent planning and isolated validation
- `packages/core/src/claims.ts`, `claim-ledger.ts`, `access.ts`, `tenants.ts`, `policy.ts`, `redact.ts` — provenance, audit, governance
- `packages/core/src/runtime.ts` — runtime intake and attribution
- `packages/core/src/evaluation.ts` — evaluation/registry infrastructure

---

## 66. Framing: MCP is a surface, not the product

The most important architectural clarification is that **Cartograph Engine** (context + semantic knowledge model + reasoning + memory) and **Cartograph Canvas** (the visual interface) are separable. MCP is the protocol through which the Engine serves consumers that are **not** the Canvas — most importantly, other agents.

For humans, the right output is a rendered ViewSpec.  
For agents, the right output is a **ContextSpec** — a distilled, provenance-tagged, structured context object.

Same engine. Same semantic model. Two projections. The product thesis — “compute the right representation for what is being asked” — turns out to be channel-independent. MCP is simply the channel where the consumer is an LLM rather than a human retina.

This is supported by the existing architecture: `Service` (`service.ts`) is already a typed operation layer; `server.ts` is just one HTTP wrapper around it. Rewriting or augmenting the wrapper to speak MCP leaves the Engine untouched.

---

## 67. Strategic advantages of an MCP surface

### 67.1 Distribution: ride the hosts instead of building frontends

The MVP plan required a VS Code extension and a web canvas — two frontends before the core thesis is proven. An MCP server plugs Cartograph into Claude Code, Cursor, Copilot agent mode, Windsurf, Gemini CLI, and every future host with **zero UI integration work**.

- **One server replaces N IDE plugin SDKs.** IDE-specific plugin maintenance was a real line item in the roadmap; MCP collapses it.
- **Time-to-first-value drops to minutes.** `claude mcp add cartograph`, not “install our extension, learn our canvas.”
- **Host churn is de-risked.** If a host dies, the Engine, SKM, and investigation memory survive.

The existing HTTP server already listens on loopback only (`server.ts:202`), which shows the product is already local-first. MCP stdio fits that posture exactly.

### 67.2 Agents become consumers — the semantic layer as planning intelligence

Today, coding agents understand code by brute-force reading: dozens of grep-and-read cycles, re-deriving architecture each time, with no memory and no verification. Cartograph as MCP replaces that with **precomputed, entity-resolved, provenance-tagged intelligence as tool calls**:

- Before modifying `PaymentService`, an agent calls `get_blast_radius("PaymentService")` and receives behavior-level consequences with citations — not a reference list it must interpret.
- An agent debugging calls `get_failure_modes("why can this payment fail")` and receives a ranked hypothesis structure with evidence refs.
- **Every improvement to the SKM immediately improves every agent in the org**, and every human confirmation in the ledger improves them all again. The defensibility flywheel in Part XI now compounds across human and machine consumers.

This is supported by: concept extraction (`concepts.ts`), salience scoring (`salience.ts`), retrieval (`retrieval.ts`), and the claim pipeline (`claims.ts`) — all cacheable per revision and already producing citeable outputs.

### 67.3 Clean division of labor for the intent→code pipeline (UC-22)

The PRD's riskiest flagship feature — visual manipulation → intent card → plan → implementation — carried generation risk because it implied building codegen infrastructure. MCP dissolves that:

- **Cartograph plans; the host agent executes.** Cartograph produces the verified intent card: affected code, new interfaces, test plan, risks, ambiguities. The host agent — which already has edit, run-test, and git tools — implements it.
- The verification loop closes: after the agent's edits, `get_conceptual_diff()` confirms whether the implementation actually realized the intent.

This is supported by `ChangeEngine` (`changes.ts`), which already produces validated plans and isolated patches, and explicitly **never writes to the repository** (`changes.ts:15-20`).

### 67.4 A cheap path to agentic investigation (UC-34)

The PRD classified autonomous investigation as research-leaning, largely because of loop-control risk. Via MCP, an external general-purpose agent drives the loop: it calls `start_investigation(goal)`, iterates through `expand_hypothesis` / `attach_evidence` / `get_invariant_map`, and steers itself — while the user watches and redirects in the host's chat.

The **visual model on the Canvas updates in real time** if the Canvas connects to the same session. You get steerable, interruptible agentic investigation **without owning the agent loop**, which removes most of the research risk from UC-34.

This is supported by the C22 engine (`c22/engine.ts`) and `WorkspaceLog` (`workspaces.ts`), which already persist investigation state across turns.

### 67.5 Hallucination control through the protocol itself

Layer-1 defense from Part XI — grounded composition, LLM may only reference SKM entity IDs — extends naturally:

- Host agents cannot hallucinate architecture if verified facts are cheaper than guessing. `query()` returns cited, provenance-tagged context that beats what the agent would reconstruct from raw reads.
- **Elicitation** maps to the promotion workflow: the server asks the user through the host's native UI, “I've inferred this invariant — confirm?” The `LLM-INFERRED → USER-CONFIRMED` promotion happens regardless of surface. The ledger compounds across every consumer.
- Tool annotations (`readOnlyHint`) and the least-privilege server split let orgs grant agents exactly as much epistemic write access as they trust.

This is supported by the existing claim pipeline (`claims.ts`), verdict system (`applyVerdict`), access policy (`access.ts`), redaction (`redact.ts`, `policy.ts`), and tenant isolation (`tenants.ts`).

### 67.6 The server owns the session — cross-host, cross-surface continuity

MCP servers are long-lived per-project processes with their own state. The Engine becomes the authoritative store for CDC, hypothesis graphs, and investigations:

- **Investigation memory survives host conversations.** UC-33 Day-2 resumption works even if Day 1 happened in a different client.
- **One session, many surfaces:** start in Claude Code, inspect on the Canvas, answer a PR-review bot from the same state.
- **Live model updates propagate** via MCP resource subscriptions: code changes → region invalidation → notification → every subscribed client shows “model updated.”

This is supported by `WorkspaceLog` and `InvestigationEngine`, which already persist event-sourced state.

### 67.7 Token and cost economics

A comprehension question costs an unaugmented agent 20–50 file reads and thousands of tokens of re-derivation. The SKM's hierarchical concept cards are precomputed, compact, and cached. Serving **distilled context instead of raw files** means:

- lower cost per comprehension task,
- agent context windows preserved for the actual work,
- consistency — the agent reasons from the same verified facts the human's Canvas shows.

This is supported by `retrieveForQuestion` with `tokenBudget` (`retrieval.ts`), concept-card caching (`concepts.ts`), and the existing salience truncation logic.

### 67.8 Governance as a single choke point

Privacy, audit, and redaction requirements from §26 get enforced once, centrally, for every consumer:

- Redaction, tenant scoping, and policy tiers apply at the server regardless of host.
- Every tool call is discrete and loggable; the audit trail is a native byproduct.
- **Local-first deployment** (stdio on the laptop/VPC) keeps code and the concept layer in-environment, pairing with the on-prem inference option.

This is supported by `TenantHost` (`tenants.ts`), `policy.ts`, `redact.ts`, `access.ts`, and the audit chain in `service.ts`.

### 67.9 Evaluation becomes tractable

Discrete, schema-validated tool calls are a far better evaluation surface than UI interactions. The §35.5 research problem — “how do we benchmark representation usefulness?” — gets a rigorous subset for free: *given incident X, do the tool results support the correct hypothesis within N calls?* Every model, index, or extraction change can be regression-tested as tool-call traces.

This is supported by `Evaluator` (`evaluation.ts`) and the existing planted/seeded suites.

---

## 68. Concrete mapping to existing CIE components

| MCP layer | Existing CIE component | Change required |
|---|---|---|
| **Transport** | `packages/core/src/server.ts` (HTTP) | Rewrite or wrap to read JSON-RPC from stdin and write to stdout. Optionally keep HTTP for the Canvas. |
| **Tool dispatch** | `Service` methods (`service.ts`) | Map each tool name to a `Service` call or internal function. Most methods already accept typed JSON and return typed JSON. |
| **ContextSpec compiler** | `ViewSpec` builders + `outline()` in `graph.ts:282` | **New work.** Build a module that distills a `ViewSpec` into a model-optimized ContextSpec with narrative, entity list, relations, citations, open questions, and `next_actions`. |
| **Reference resolution** | `queryTerms` + entity lookup | Wrap into `resolve_reference`. Disambiguation is already partially handled by `retrieveForQuestion`. |
| **Read tools** | `Service.ask`, `explain`, `whyShown`, `visuals`, `investigate` | Map to `query`, `explain_element`, `why_shown`, `get_failure_modes`, etc. |
| **Investigation tools** | `InvestigationEngine` (`c22/engine.ts`) | Expose `start_investigation`, `get_investigation_state`, `expand_hypothesis`, `attach_evidence`, `steer_investigation`, `close_investigation`, `resume_investigation`. |
| **Intent/plan tools** | `ChangeEngine` (`changes.ts`) | Expose `propose_intent`, `refine_intent`, `generate_change_plan`, `verify_realization`. Ensure plans never become silent code writes. |
| **Resources** | `Store` queries for concepts, evidence, claims, investigations, views | Add URI scheme: `skm://concepts/{id}`, `skm://investigations/{id}`, `skm://views/{id}`, `skm://evidence/{id}`, `skm://claims/{id}`. |
| **Prompts** | Existing form examples + router vocabulary | Add prompt templates: `onboard-me`, `review-pr-conceptually`, `why-does-this-exist`, `investigate-incident`, `audit-pii-egress`, `plan-extraction`. |
| **Elicitation** | Claim verdict workflow (`claims.ts:220`) | Use MCP server-initiated messages or host-native UI to ask for invariant/boundary/ownership/intent confirmations. |
| **Progress streaming** | `JobRunner` (`jobs.ts`) | Map to MCP `notifications/progress` for indexing, concept extraction, and long synthesis. |
| **Governance/audit** | `TenantHost`, `policy.ts`, `redact.ts`, `claim-ledger.ts` | Apply at the server boundary; no change to policy logic. |

---

## 69. Suggested minimal viable MCP server (first cut)

A useful first version can be built with a small subset of tools, then expanded:

| Tool | Maps to existing CIE operation | Purpose |
|---|---|---|
| `bootstrap()` | `Service` capabilities + store status | Tells the agent what is indexed and how to speak to the server. |
| `set_task_frame(question, constraints)` | Context write via `interactions.ts` | Narrows the model for the session. |
| `resolve_reference(ref)` | `queryTerms` + entity lookup | Turns messy input into canonical handles. |
| `query(question, depth, token_budget, epistemic_floor)` | `Service.ask` | One-call comprehension: returns ContextSpec. |
| `explain_element(ent_id, aspects)` | `Service.explain` + concept cards | Returns a cited concept card for an entity. |
| `get_blast_radius(ent_id, change_kind)` | `Counterfactual` / impact analysis | Behavior-level consequences before editing. |
| `get_failure_modes(phenomenon)` | `buildFailureGraph` / `buildInvariantGraph` | Ranked causal paths for debugging. |
| `start_investigation(goal)` + `get_investigation_state(inv_id)` | `InvestigationEngine` | Durable agentic debugging. |
| `attach_evidence(hyp_id, evidence_ref)` | C22 evidence attachment | Updates hypothesis ranking. |
| `why_shown(element_id)` | `Service.whyShown` | Inclusion rationale for any element. |
| `read_evidence(evidence_uri)` | Evidence resolution | Returns code snippet / log line / commit. |

Resources: `skm://repo/overview`, `skm://concepts/{id}`, `skm://investigations/{id}`, `skm://views/{id}`, `skm://evidence/{id}`, `skm://claims/{id}`.

Prompts: `onboard-me`, `review-pr-conceptually`, `why-does-this-exist`, `investigate-incident`.

This alone makes CIE usable from Claude Desktop without the web UI.

---

## 70. Profiled tool exposure to avoid the 40-tool swamp

| Profile | Tools exposed | For |
|---|---|---|
| **minimal** | ~10 tools: `bootstrap`, `set_task_frame`, `resolve_reference`, `query`, `explain_element`, `get_blast_radius`, `get_failure_modes`, `get_investigation_state`, `attach_evidence`, `why_shown` | General coding agents |
| **standard** | minimal + structural semantics, change/history, investigation write, epistemics (~24 tools) | Architecture and security agents |
| **full** | everything (~45 tools) | Agentic investigation, security audit, Canvas-adjacent hosts |

Consolidation rules:
- One parameterized tool replaces sibling variants (`query` replaces ~15 question-variants).
- `propose_intent` uses a `gesture` enum instead of separate tools.
- `epistemic_floor` is a parameter rather than parallel “verified-only” variants.
- `next_actions` in every result replaces discoverability tools.

**Deliberately not exposed:** raw file reads (host has its own), any code-writing tool (host executors own mutation), arbitrary graph-query escape hatches (curated primitives keep provenance enforceable), and direct Canvas control (Canvas connects to the session API; MCP only carries `canvas_ref` and ViewSpec resources).

---

## 71. New concerns that do not exist today

| Concern | Why it matters for MCP |
|---|---|
| **Tool descriptions** | The host picks tools based on name + description. Tight descriptions prevent wrong calls. |
| **JSON Schema per tool** | MCP requires it. Existing Zod schemas in `packages/schema` are a head start. |
| **Context window pressure** | A `ViewSpec` with 200 nodes is fine for Cytoscape but huge for a model. Summarization and pagination (`depth`, `token_budget`) are required. |
| **No human-in-the-loop by default** | The model may call `propose_intent` → `generate_change_plan` in one turn. Existing approval gating must be explicit in the tool contract. |
| **Progress streaming** | Long indexing/model calls need MCP `notifications/progress`. |
| **Multi-tenant identity** | Today identity is `local-user`. Under MCP the host may pass a token or session. Reuse `TenantHost` or keep local single-user mode. |
| **Prompt-injection from repo content** | A malicious dependency's comments could carry instructions. Read/write split and treating repo content as data are mandatory. |
| **Sampling delegation** | MCP lets the server ask the host model to do work. This could replace some Ollama calls but changes cost/egress assumptions. |

---

## 72. Honest limits — what MCP cannot carry

1. **Visual interaction does not survive.** Lasso, drag-to-reparent, semantic zoom, provenance visual grammar (dashed-vs-solid encoding), and the intent-gesture vocabulary are unexpressible through tool calls. If Cartograph were only an MCP server, it would collapse into the thing the PRD was designed to avoid: a repo-chat with better grounding.
2. **Agent ergonomics are a design discipline.** Generic agents use tools badly unless tools are named, scoped, and result-shaped for them. ContextSpec formatting becomes its own craft.
3. **New attack surface.** Tool results derived from repo content are a prompt-injection vector. Read/write server separation and content-as-data treatment are mandatory.
4. **UI-extension standards are young.** MCP Apps / MCP-UI / vendor variants are still settling. Build behind capability negotiation, never assume.
5. **Commoditization risk inverts.** The transport is a commodity and will be copied. The moat must remain the provenance ledger, entity-resolved concept layer, and interaction history — all of which MCP strengthens but the protocol itself confers nothing.

---

## 73. The real gap: ContextSpec is not ViewSpec

The most important new work is not the protocol wrapper. It is the **ContextSpec compiler** — a module that turns a `ViewSpec` into a model-native structured context object.

A ContextSpec must include:

- A **narrative summary** (the caption, expanded for readability).
- A **typed entity list** with roles, provenance codes, and citations.
- A **relation list** with edge kind and provenance.
- **Open questions** and **gaps** from the view.
- **`next_actions`** — the 2–4 most useful follow-up tool calls.
- An optional **`canvas_ref`** for hosts that can open the visual view.

Existing building blocks:
- `outline()` in `apps/web/src/graph.ts:282` renders a map as structured text.
- `ViewSpec` already carries `nodes`, `edges`, `groups`, `gaps`, `legend`, `system`, `caption`, `question`, `route`.
- `Claim` objects carry `displayMode`, `confidence`, `counterArgument`, `gates`, `verdicts`.

But these are fragments. A true ContextSpec needs:
- Hierarchical summarization (do not dump 200 entities).
- Citation compression (cite once, link resources).
- Explicit `next_actions` generation from the view shape.
- Persona/depth adaptation.

This is the design work that sits between the Engine and the MCP protocol.

---

## 74. Worked trace: an agent meets the duplicate-payment bug

This trace shows how the proposed MCP surface behaves in practice:

```
agent → bootstrap()
        → "repo indexed 14 min ago; 3 open investigations; duplicate-payment investigation exists"

agent → resume_investigation("inv-7")
        → hypotheses: provider-retry (?), callback-race (?), UI-double-submit (✕)
        → "commit 4f2e1 touched retry config since last visit"

agent → set_task_frame("is the retry fix complete?", goal="verify")

agent → get_failure_modes("duplicate charge", epistemic_floor="STATIC")
        → 4 paths; provider-retry now carries RUNTIME prov:
          3 timeouts in prod logs this week

agent → attach_evidence("h_retry", "log://prod/2024-11-02/timeout-8812")
        → hypothesis graph re-ranked
        → UI-double-submit elimination re-confirmed

agent → get_invariant_map("balance")
        → idempotency key enforced at ledger write ✓ STATIC
        → enforcement missing on refund path (LLM_INFERRED)

host elicits: "Enforcement gap on refund path — confirm?"
        → user confirms via host UI

agent → confirm_claim("c-114")
        → ledger write; downstream 2 cards updated

agent → verify_realization("plan-3", working_tree)
        → retry fix realized for payments
        → refund path not covered by plan

agent → propose_intent("extend idempotency enforcement to refund path")
        → intent card: 3 code sites, 1 new interface method, 2 tests
        → ambiguity: sync vs. queue-based dedup

result → canvas_ref: "skm://views/v-512"
        → the human's Canvas shows the updated hypothesis graph and intent card
```

Eight tool calls. The agent never opened a file. Every claim is citable. One new organizational fact entered the ledger. The human sees it on the Canvas live.

---

## 75. Verdict

**Exposing the Engine as an MCP server is the correct second surface — and arguably the right first one for the market wedge.** It buys distribution, agent composability, a de-risked path to the two riskiest flagships (intent→code and agentic investigation), protocol-native grounding and governance, and org-scale flywheel effects — at near-zero frontend cost.

The non-negotiable architectural consequence: **the Canvas must remain a first-class client over the same session and API.** The MCP server is how the semantic model meets the agent ecosystem; the Canvas is how it meets the human's spatial and gestural intelligence.

**The product is the Engine. MCP and Canvas are the two projections of it** — one for machines answering questions, one for humans who think with their hands.

No code changes were made.
