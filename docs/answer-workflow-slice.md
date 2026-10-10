# Answer workflow and predictable exploration

Apply `answer-workflow-incremental.patch` after all three earlier patches. No worker schema or lockfile change is required.

## Response contract

`portfolio.v3` adds an optional structured `plan`: classified intent, concerns, chosen primary notation, at most three supporting notations, scope, subject, and evidence preflight status. Old v1/v2 manifests remain valid. The primary already selected by the existing query/LLM router is preserved; this slice makes supporting-view planning deterministic, rather than replacing that router.

Three trusted build-time workflow plugins implement interpretation, indexed-entity preflight, and ranking. Drop a `*.step.ts` file in `packages/core/src/plugins/steps`, export a literal `id` and a default `WorkflowStep<PlanningContext>`, then run `npm run plugins:generate`. Ordering uses `after`/`before`; duplicates, missing dependencies and cycles fail before a stage runs. Generated registration is checked by typecheck/build/CI.

Ranking covers one available perspective per detected concern before filling additional slots. Small explicit notation preferences favor general ER, sequence, dependency and state views; remaining choices use concern metadata and deterministic numeric ordering. The tab strip opens primary plus up to three supporting charts. The full catalog stays accessible, and generation remains lazy and bounded to two concurrent requests.

## Evidence availability

The service obtains a grouped indexed entity-kind inventory for the exact response revision, without loading every entity into memory. The planner marks a chart unavailable when none of its declared alternative retrieval kinds exists; missing compiler/native prerequisites still take precedence. Already generated views are retained, including explicitly requested empty views and their gaps.

The preflight is repository-wide, conservative and limited to indexed entity presence. It does not establish subject-specific relevance, completeness, runtime interaction order, concurrency safety or semantic evidence. Missing inventories are reported as not checked. Compiler gaps and provenance remain authoritative after generation. Fresh indexing is needed to reflect newly imported sources.

## Navigation and interaction

Exploration choices vary the structure view by selected element kind and offer calls, sequence, data, state, reliability and native concurrency where available. Unavailable choices are disabled with explanatory tooltips; keyboard choices obey the same constraints. Source access remains available for a single source entity.

Back restores the prior active tab and saved selection, level, draw mode, weights, zoom, pan and lens state. Pending history requests become retryable, with attempt increments; revision/response/epoch checks continue rejecting late completions.

## Boundaries

This is the response-planning workflow, not a migration of every operation in `service.ts`. Query routing, evidence extraction and compiler execution remain existing paths. Dedicated diagram renderers, async execution plugins, Rust extractor registration, subject-specific evidence probes and full behavioral evidence contracts are later slices. Fisheye behavior is unchanged from the preceding patch.
