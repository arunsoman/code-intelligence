# Response workspace implementation

Base: `14b32f262f18ca0a3c1152c35cb2eb3e0e07f343`.

## Implemented

- `response.v1` adds a validated, versioned response manifest to successful C19 asks and C15 conversations. It groups generated views, answer sections, semantic references, evidence references, limitations, and a deterministic chart portfolio around one question and revision.
- Chart families map structural, behavioral, data, state, reliability, concurrency, and quality questions to related notation choices. The existing query planner still selects and resolves the primary view. Portfolio classification uses explicit, versioned rules, rather than a second LLM recommendation call.
- The middle area has accessible chart tabs, an initial subset of up to four related choices, grouped **More views**, and an **All views** catalog inside the same response. Already generated analysis views remain available. Other charts generate on demand. Unsupported compilers and unavailable native views show a reason and cannot be selected.
- **Generate all relevant views** runs sequentially; manual generation permits at most two concurrent requests. Cancel aborts browser requests and invalidates their completion tokens; it does not promise cancellation of work already running on the server.
- Each completion must match the response, revision, request attempt, and requested notation. Fallback charts cannot silently replace the chosen tab. Only an active tab's result replaces the visible drawing. Closed tabs retain cached specs.
- Tabs preserve selection, matrix selection, display mode, terrain weights, context level, camera, and lens configuration in memory. Selection crosses views through indexed entity identity. Up to 30 navigation frames support Back. A new repository or conversation clears this workspace.
- A selected element exposes five exploration choices: structure, calls, data, concurrency, and recovery; plus source and open-ended explanation. These requests carry the source revision, subject, and entity seeds. Source requires a single entity. Chat Back and Zoom Out use history, and Zoom In opens the semantic choice surface. Lens magnification remains a separate interaction.
- Typed chart projection now retains unambiguous indexed entity references, and directory grouping references for package/module/component views, instead of discarding all entity identity.
- The fisheye reads actual rendered edge colors, dotted/dashed/solid styles, source/target arrow shapes and independent arrow fills. New lenses honor reduced-motion preferences. Its existing geometry and inverse hit testing remain intact.
- Answer sections can highlight their associated entities in the active chart. **Highlight response evidence** highlights chart elements with evidence references. **Export response** downloads the manifest and open view specs as JSON.
- Rust setup first reuses existing compilers, make, curl and CA certificates; it sources an installed per-user Rust environment before deciding whether rustup needs installation.

## Important boundaries

This is the response workspace and navigation foundation, not completion of every diagram engine described in the consolidated specification.

- Existing chart compilers and renderers are reused. C4, sequence, activity, ER, state and reliability notation fidelity has not been fully repaired. S29 remains explicitly unsupported. A catalog entry marked requestable is not a claim that the repository contains sufficient evidence; generation can return partial results or fail.
- Primary intent classification still uses the existing query planner. The portfolio rules do not implement a new trained intent classifier, the entire 34-intent catalog, or a canonical architecture-to-code containment model.
- Exploration offers the same five concern choices for an eligible node; it does not yet preflight evidence availability for every choice or provide flow-specific choice menus.
- Entity identity is retained only for unambiguous name matches and deliberate directory groups. Unmatched/synthetic nodes cannot navigate to source. No new static extractors or runtime trace collection were added.
- Section references identify the view's supporting entities/evidence collectively; they are not sentence-level entailment proofs. Highlighting is an aid to navigation, not proof of each LLM assertion.
- Tab state/history is in memory. Refresh persistence, split-view comparison, semantic breadcrumbs, disk-backed caches, and lens center restoration remain future work. Export is JSON; there is no new import or image export UI.
- Changing repository/revision context clears the response workspace rather than offering mixed-revision charts.
- Browser cancellation suppresses stale results locally; server-side generation cancellation and a shared cost budget require backend work.

## Validation

- `npm run typecheck`: passed.
- `npm run web:build`: passed. Existing dependency annotations, CSS syntax and bundle-size warnings remain.
- `bash scripts/setup-dev.sh`: passed; Rust and Cargo 1.97.1 detected.
- `node --test apps/web/test/response-workspace.test.ts apps/web/test/fisheye.test.ts packages/core/test/query-context.test.ts`: 12 passed, 0 failed, including conversation integration.
- Rust `cargo test`: passed, 88 unit tests plus doc-test checks.
- Existing `chart-creator` / `chart-rendering` tests: 8 passed, 26 failed. Untouched HEAD has the same 26 failing test names. These failures remain unresolved and constrain notation fidelity.
- No browser executable was available in this environment, so interactive browser validation was not performed. Keyboard focus, layout, tab switching, history and source navigation need a browser smoke test before release.

## Recommended next changes

1. Repair the baseline chart-contract failures and add strict notation/evidence gates for each advertised chart.
2. Add architecture containment and explicit flow identity, then generate evidence-aware component/flow choices and breadcrumbs from those models.
3. Persist the workspace with revision checks; add browser interaction tests for tab camera restoration, stale completion isolation, cancellation and Back.
4. Add sentence-level finding references and shared semantic selection across graph, matrix, sequence and source surfaces.
5. Add true lifelines/fragments, swimlanes/fork-join, ER cardinality, state transitions and C4 boundaries; keep runtime ordering distinct from static possibilities.
6. Add optional split comparison and fisheye eligibility rules for timing and quantitative charts, where distortion would change interpretation.
