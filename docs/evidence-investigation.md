# Evidence investigation: first implementation slice

Base: `3d5f9df`. This patch builds the first operational slice of the shared investigation architecture. It does not implement the entire roadmap.

## Result

Subject-scoped model retrieval now binds a named subject before sampling. It expands an access-filtered, revision-bound static neighborhood and attempts bounded source recovery. Written answers and chart requests consume the same enriched EvidenceBundle. Views expose a typed `evidenceInvestigation` report and a compact coverage status; gaps remain in the existing expandable panel.

The concrete seed-loss bug is fixed: hierarchy navigation retains caller-provided subjects instead of replacing them. Bound roots rank first and survive token trimming ahead of recovered context. Pins remain retrieval context; the service passes explicit subject seeds separately.

## Contracts

`InvestigationReport` records goal, binding candidates, roots, outcome, budgets, counts, timings and typed gaps. Outcomes are supported, partial, ambiguous and unbound. Supported means the bounded static investigation has no recorded gaps; it does not establish exhaustive runtime behavior or repository-wide absence.

`EvidenceBundle.investigation` accompanies the shared model input. `ViewSpec.evidenceInvestigation` is separate from the existing exception-investigation field. No database migration is required.

Timing fields stay in diagnostics and view metadata, but are excluded from model payloads and their content-derived cache keys. Elapsed-time noise therefore does not invalidate chart caches.

## Recovery

Indexed expansion follows calls, asynchronous hand-offs and outgoing containment; incoming calls supply limited entry context. Source recovery uses TypeScript's parser and binding checker through a virtual compiler host. The host reads only indexed, access-permitted files through Service.resolveEvidence and verifies source freshness. It cannot read arbitrary compiler filesystem paths or execute repository code.

Recovered relationships cover direct named function declarations and constant arrow/function-expression bindings, including resolvable relative import aliases. Each relationship cites its actual call-site span. It is a possible static call, not proof of order, invocation frequency or successful execution. New relationships are request-local; their evidence references are stored so evidence drawers can resolve them. They are not silently written back as permanent indexed relationships.

Shadowed parameters, reassigned functions, unknown object dispatch, unresolved external calls and unsupported languages remain gaps. Anonymous callback calls are not attributed to the enclosing function. A byte chunk split through a UTF-8 character is conservatively rejected rather than parsed as corrupted source.

Defaults: 64 investigated entities, depth 3, 8 source files, 128,000 source bytes, and a 1,500 ms cooperative investigation budget. The source compiler may load imported files; those count against the same limits. Individual synchronous parser/checker operations cannot be forcibly preempted, so maxMs is a cooperative bound rather than a hard execution deadline.

## Answer safeguards

The source-answer path prioritizes the bound entry point in its offline fallback. If model statements omit all bound roots, that fallback replaces them. A conservative wording guard rejects the known unsupported exclusivity, universal and diagram-impossibility claims in both statements and limits. This is not a general natural-language proof system; broader claim validation remains pending.

Access redaction also filters the new view report. Token trimming reports investigated entities missing from the model context. Reported recovery counts describe the investigation, not a promise that every recovered edge survived the model's context budget.

## Validation

Run setup before worker-dependent tests:

```bash
bash scripts/setup-dev.sh
node --test packages/core/test/investigation.test.ts packages/core/test/retrieval.test.ts packages/core/test/architecture-question.test.ts packages/core/test/native-table-retrieval.test.ts
npm run typecheck
```

New tests use a real worker-indexed repository, then deliberately remove indexed edges. They exercise subject resolution, import aliases, constant helpers, parameter shadowing, mutable bindings, stale source, denied access, budgets, token omission, shared model evidence and rejection of the example unsupported claim. Existing retrieval tests cover distractors, source access and notation requirements.

## Remaining architecture slices

- Better semantic subject discovery and interactive ambiguity choices; this slice uses conservative symbol/file matching and explicit subjects.
- Targeted refresh into a new revision. Stale files currently produce refresh gaps; no source from a different revision is mixed into the answer.
- Dispatch/registration resolution, other-language recovery, control-flow ordering and runtime observations.
- Canonical findings/answer model with structural claim validation. Prose and chart generation still make separate model requests over the same evidence.
- Typed query algebra with union, intersection, directional difference and three-state membership.
- Persisted question-wide snapshots reused across later view requests, dependency invalidation and investigation checkpoints.
- Shared orchestration across specialized causal/runtime tools and the agent's raw tool reads. Subject-scoped model retrieval is integrated first; this patch does not claim every specialized route uses the engine.
- Full performance baselines and chart availability derived from coverage obligations.

The existing concept-hierarchy prerequisite remains in place. Ambiguity and missing source now have typed outcomes; the UI does not yet implement candidate-selection or refresh buttons.

## Proposed G6 visualization migration (not implemented in this patch)

G6 can replace Cytoscape for graph rendering and provide the default layout backend in place of ELK. Keep the evidence engine and DiagramSpec independent of that choice: visualization consumes supported findings; it does not determine whether a relationship is true.

Introduce a GraphSurface adapter translating stable entity/evidence IDs, nodes, edges, groups, selection and camera state into G6 data. A LayoutPolicy selects deterministic hierarchical layouts for directed dependencies/calls, grid for disconnected classes, and tree layouts for containment. Force layouts should be an explicit exploration mode rather than the default for architectural answers. Measure nested groups, edge routing, labels and stable positioning against the existing fixtures before removing ELK; retain it temporarily as an optional custom layout if those cases regress.

Preserve the captured-element hover lens rather than replacing it with geometric fisheye distortion. Preserve normal wheel zoom before lens activation, source/evidence clicks, keyboard navigation, text alternatives, tab camera restoration and exports. Sequence, concurrency and other notation-specific views need custom placement rules; native tables should remain native tables. A common renderer does not imply a common layout algorithm.

Start with dependency and call graphs behind the adapter, then migrate architecture and class views after screenshot and interaction checks. Compare Canvas and SVG rendering with realistic label density and graph sizes. Acceptance requires readable labels, valid relationship endpoints, no group overlap, equivalent selection/evidence actions, accessible alternatives and measured performance. The migration is a separate patch from evidence investigation.

References: https://github.com/antvis/G6, https://g6.antv.antgroup.com/en/manual/layout/overview, https://g6.antv.antgroup.com/en/manual/further-reading/renderer.
