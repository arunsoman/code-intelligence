# Chart rendering requirements

**Status:** requirements for bringing the System-design charts gallery (S1–S15) up to its published descriptions.  
**Scope:** chart selection, evidence-backed chart data, notation-specific rendering, and verification. This is based on the current catalogue in `apps/web/src/VisualsGallery.tsx` and the chart pipeline in `packages/core/src/chart-creator.ts`.

## 1. Problem and goal

The gallery currently exposes fifteen system-design chart choices. Two choices use existing native views: S2 uses `TransactionJourney`, and S5 uses `TestConfidence`. The other choices use `GeneratedChart`, which currently compiles an LLM plan into the same generic node-and-edge canvas. Its schema has five general node shapes and no chart-specific structures for table columns, key constraints, transition guards, BPMN event types, decision rules, or similar notation.

As a result, a chart title can promise a particular notation while the drawing only shows code entities connected by arrows. In addition, the offline model stub always produces a call-flow plan, so it cannot satisfy chart-specific requests. These limitations must be visible and must not be described to users as a complete ERD, BPMN diagram, or other formal chart.

The goal is for every gallery choice to:

1. Render the notation and information promised by its name and description.
2. Ground every repository-specific assertion in current indexed evidence.
3. Show unavailable information as a gap instead of inventing it.
4. Preserve the user's explicitly selected chart type through routing, model generation, caching, rendering, and refresh.
5. Remain inspectable, accessible, readable, and useful when evidence is incomplete.

## 2. Current audited state

| Code | Chart | Current renderer | Required outcome |
|---|---|---|---|
| S1 | C4 container / component architecture | Generic generated graph | C4 element types, system/container boundaries, technology and relationship labels |
| S2 | Reserve fast-path sequence / swimlane | Native `TransactionJourney` | Keep the native journey; add sequence lifelines/messages and explicit sequence semantics or describe it only as a swimlane journey |
| S3 | BatchId lifecycle state machine | Generic generated graph with a state node style | Explicit states, initial/final markers, guarded transitions and idempotent repeats |
| S4 | Ledger and entry relationships | Generic generated graph | Ledger-specific persistence model plus debit/credit and idempotency write behavior |
| S5 | Test-guarantee matrix | Native `TestConfidence` matrix | Show invariant/test relationships and distinguish reachability, apparent assertion, and verified assertion |
| S6 | Use case diagram | Generic generated graph | Actor, use-case, system-boundary, and association notation |
| S7 | BPMN process diagram | Generic generated graph with generic event/decision styles | BPMN event/task/gateway/flow types, lanes, and compensation behavior |
| S8 | Event storming / event modeling | Generic generated graph | Separate commands, domain events, policies, aggregates, read models, and external systems |
| S9 | Entity-relationship diagram | Generic generated graph | Tables/entities, attributes, keys, constraints, foreign keys, and cardinalities |
| S10 | Data flow diagram | Generic generated graph | External entities, processes, data stores, and named data flows |
| S11 | Decision table | Generic generated graph | A real decision table with conditions, rules, actions, and uncovered combinations |
| S12 | Saga / compensation graph | Generic generated graph | Forward actions, failure triggers, compensations, retries, and missing-compensation gaps |
| S13 | Outbox pattern topology | Generic generated graph | Transactional write boundary, outbox store, poller, delivery states, retries, and consumers |
| S14 | Idempotency matrix | Generic generated graph | Operation-by-replay matrix with outcome and enforcing mechanism |
| S15 | DI wiring diagram | Generic generated graph | Components, injection points, bound implementations, qualifiers/scopes, and evidenced gaps |

The current `ChartOutput` contract only represents a chart name, generic layout, entity nodes, and relationship edges. It cannot carry most of the details in the required outcome column. The generated-chart layout pass also previously replaced model-provided positions; that position-loss defect has been fixed and has a regression test. The rest of this document defines the remaining work.

## 3. Cross-cutting requirements

### 3.1 Explicit chart selection

- Each gallery entry must send a stable chart identifier and contract version, in addition to the editable question. A chart type must not be inferred only from free-form prompt wording.
- The server must preserve the selected chart identifier in the request, route, generated plan, saved view metadata, and response.
- The model must follow the selected chart contract. It may report that evidence is insufficient, but it must not silently change the requested type.
- A chart cache key must include the selected chart identifier, contract version, evidence bundle identity, and question. A plan produced for one chart type must never be reused for another.
- The rendered title and legend must name the selected chart type. If the model returns a conflicting type, reject or normalize the plan and report a validation warning; do not silently relabel a generic graph.

### 3.2 Typed chart data

- Replace the single weakly typed generated plan with validated, chart-specific data contracts. A discriminated union should cover the chart families in this document while retaining a generic evidence graph only as an explicitly named fallback.
- Every node, edge, attribute, condition, state, event, assertion, and table cell that makes a repository claim must carry evidence references appropriate to that claim.
- Validate every evidence ID against the current revision and access policy before a chart is compiled. Reject fabricated IDs, stale evidence, unknown entity IDs, and edges whose endpoints or relationship do not match the indexed relationship.
- Preserve evidence links through compilation into the view and expose them in the existing inspect/details flow. Clicking a chart fact must open its supporting code, schema, test, or document location.
- Distinguish source facts from derived layout. Layout may be proposed by a model; a model-proposed layout must not turn an unsupported relation into a fact.
- Any inferred relation must be explicitly marked as inferred, rendered with a non-solid treatment and a text label, and accompanied by the reason and evidence that supports the inference. If that basis is absent, omit the relation and list the gap.
- Do not invent runtime ordering, transactions, database constraints, test assertions, event delivery, or dependency bindings. Static source order and call edges must be named as static evidence.
- A chart with incomplete data must render the supported subset and provide a visible “Gaps and limits” section. A chart with no support must show a clear empty state and reason, not a misleading empty canvas.
- Keep the current resource limits (bounded node/edge counts) or define and validate equivalent per-chart limits. Truncation must be disclosed in the view.

### 3.3 Rendering and interaction

- Implement chart-family renderers with notation-specific visual primitives. Do not use one generic node shape for different semantic roles when the notation distinguishes them.
- The rendered geometry must respect validated chart-specific positions and relationships. Automatic layout may avoid overlaps and route edges, but must not erase meaningful sequence, state, rule, or data-flow ordering.
- Use labels, shape, line style, and text in addition to color to communicate meaning. Include a visible legend for all notation symbols and relation styles.
- Provide zoom, pan, selection, details, evidence links, and a text outline for every chart. The text outline must describe participants/elements, relation direction, labels, and relevant statuses in reading order.
- Keyboard navigation must reach every element and relation detail. Use accessible names that include the notation role and relation label.
- For narrow viewports, allow scrolling or a readable table/list alternative. Do not shrink labels below the application's readable minimum to force the whole chart into view.
- Chart refresh after indexing must invalidate stale generated plans when the revision or evidence bundle changes.

### 3.4 Model and offline behavior

- The chart prompt must include the selected chart contract, required semantic elements, allowed evidence fields, and explicit rules for marking unknowns.
- The output schema validator is authoritative; a prompt alone is not a correctness boundary.
- The offline stub must either produce a valid chart-specific fixture from supplied evidence or return a typed “unsupported offline” result. It must not return `call-flow` for every chart request.
- When the model is unavailable or output fails validation, keep the requested chart selected and show the limitation. Do not fall back to a different chart while leaving the requested title in place.
- Record structured diagnostics for chart ID, contract version, provider/model, cache hit/miss, schema validation result, number of supplied entities/relationships/evidence, accepted and omitted elements, gaps, and fallback reason. Do not log source contents, secrets, or full prompts by default.

## 4. Chart-specific requirements

### S1 — C4 container / component architecture

**Elements and relationships**

- Represent people/users, software systems, containers, components, and external systems as distinct element types. A container may be a service, application, worker, database, cache, queue, or other executable/deployable boundary when supported by evidence.
- Draw system and container boundaries as labeled nested regions. Components must be placed inside their owning container when ownership is known.
- Show Redis, MySQL, and other stores as data-store elements with their technology names, not as ordinary classes. Label each technology only when source/configuration evidence names it.
- Label directed relationships with the operation, protocol, event/topic, or data purpose supported by evidence. Distinguish synchronous calls from asynchronous messages.
- Do not infer deployment topology from package layout alone. If environment/deployment configuration is absent, show a gap rather than claiming a deployment diagram.

**Acceptance criteria**

- A fixture with API → service → Redis and service → MySQL renders two distinct store/container types and separate labeled relations.
- Nested boundaries remain visible at fit zoom and in the text outline.
- An unrecognized class does not automatically become a C4 container; it is shown as a component or omitted with a reason.

### S2 — Reserve fast-path sequence / swimlane

**Elements and ordering**

- Retain the native `TransactionJourney` behavior that shows source-backed steps, conditions, failures, transaction regions, and asynchronous hand-offs.
- Add an explicit sequence representation: participants/lifelines, ordered messages, message direction and label, activation spans where derivable, return messages where present, and fragments for `alt`, `opt`, `loop`, and exception/compensation paths.
- Determine the order from static calls and source control-flow. Label this as static control-flow; do not imply observed runtime timing.
- Preserve lanes by participant or module and show calls crossing lanes with an unambiguous direction.
- If the evidence supports only call ordering, render a swimlane journey and disclose that lifeline/activation detail is unavailable instead of calling it a complete UML sequence diagram.

**Acceptance criteria**

- A fixture for reserve shows request entry, Redis reserve, persistence, success, insufficient-balance, and DB-sync compensation paths in their evidenced order.
- Branch fragments and return/failure messages have distinct, labeled styles.
- A long sequence remains navigable and has a readable text outline that follows message order.

### S3 — BatchId lifecycle state machine

**Elements and transitions**

- Represent transaction states separately from code functions. Include initial and terminal markers where evidenced.
- Represent each transition with source state, target state, trigger/operation, guard, and evidence. Use self-transitions or explicit replay annotations for idempotent repeats.
- Include reserve, post, rollback, failure, compensation, and retry transitions only when supported by source or tests.
- Distinguish a forbidden transition (for example rollback after post) from a transition whose behavior is unknown.
- Show state coverage gaps explicitly. Do not treat method names as proof that a persisted lifecycle state exists.

**Acceptance criteria**

- A state-machine fixture distinguishes pending/reserved, posted, and rolled-back states; it shows only supported transitions and duplicate-call behavior.
- Repeated reserve/post/rollback behavior appears as an evidenced replay/self-transition or as an explicit unknown.
- Transition guards and outcomes can be inspected and open their evidence.

### S4 — Ledger and entry relationships

**Elements and data semantics**

- Show persisted ledger tables/entities separately from write operations and service components.
- Show entry identity fields, batch identifier, account/wallet reference, amount, direction/debit-credit side, and other columns only when schema or write evidence supports them.
- Represent the double-entry relationship as the evidenced pair or set of balanced entries. Do not assert balancing if the source does not enforce it.
- Show `INSERT IGNORE` as an idempotent insert behavior only when the actual SQL and unique key/constraint are evidenced. Show the `batchId + "_0"` behavior as a key transformation with its source evidence.
- If table schema is not available, present a “ledger write flow” rather than labeling the view an ERD. List missing schema details.

**Acceptance criteria**

- A fixture with SQL DDL and writer code renders the ledger table, supported columns/keys, entry writes, unique/idempotency behavior, and batch ID transformation.
- Double-entry semantics are distinct from table relationships and are not inferred from two insert calls alone.
- Missing columns, constraints, or balance checks appear as gaps.

### S5 — Test-guarantee matrix

**Axes and cell meanings**

- Rows represent named invariants/guarantees or explicitly labeled behaviors. Columns represent tests.
- Cell states must distinguish at least: test asserts invariant, test exercises/reaches code only, failing test, test result unknown, and no evidence found.
- A test name or file name alone may support “appears related,” but must never be rendered as proof of an assertion.
- When assertion-level analysis is unavailable, say so and keep the cell at a weaker state. Link each claim to the test source or result evidence.
- Include untested invariants as visible gaps. Do not turn an empty cell into a claim that a test does not exist unless the repository scan is sufficiently complete and its scope is stated.

**Acceptance criteria**

- Fixtures distinguish a test that reaches `reserve` from one that asserts no double reserve or no lost update.
- A failing result remains distinct from an assertion or coverage signal.
- Every cell's accessible label states the invariant, test, relation, evidence level, and result where known.

### S6 — Use case diagram

- Represent actors as actor symbols, use cases as use-case ovals, and use a labeled system boundary.
- Draw associations from an evidenced caller/role to an evidenced operation. External services may be actors only when the integration is evidenced.
- Show authorization/guard evidence as a constraint or note connected to the use case it protects.
- Do not infer human roles from method names or package names. Unknown actor identity is a gap.
- Acceptance: a caller-to-`reserve` example distinguishes an authenticated principal, service caller, and external provider when each is supported; unauthorized/unconfirmed relationships are not drawn as facts.

### S7 — BPMN process diagram

- Represent start, intermediate, and end events distinctly; tasks as tasks; XOR/AND gateways with explicit gateway labels; sequence flows with direction; and message flows separately.
- Show pools/lanes for distinct participants when supported. Show compensation actions attached to the action/failure trigger they compensate.
- Encode conditions on outgoing gateway flows. If a branch condition is unknown, label it unknown and disclose the gap.
- Do not imply actual BPMN execution semantics from a generic call graph.
- Acceptance: fixtures render reserve success, insufficient-funds end, persistence failure, and compensating cancel/rollback as distinct BPMN elements with correct flow types.

### S8 — Event storming / event modeling

- Separate commands (imperative), domain events (past tense), policies/process reactions, aggregates, read models, and external systems into visually distinct element types and labeled bands.
- Order events only when code, topic, or state-transition evidence supports the ordering. Async relationships must be labeled as asynchronous.
- Display event/topic names and the code location that emits or consumes them. A class name alone is not an event.
- Acceptance: a fixture containing command handling, emitted event, consumer, and read-model update shows those roles separately; an unobserved event or ownership link is omitted with a gap.

### S9 — Entity-relationship diagram

- Represent each persisted table/entity with a named box containing supported attributes. Mark primary keys, foreign keys, unique constraints, nullability, and types using explicit text/symbols and a legend.
- Represent relationships with correct cardinality and optionality at both ends, using crow's-foot or equivalent standard notation. Label the FK columns that implement the relationship.
- Distinguish declared foreign keys from inferred/application-level relationships. Inferred links must be dashed and named as inferred; never draw them with the same confidence as a declared constraint.
- Support a scoped diagram (module/schema/table selection) and disclose when the repository-wide diagram is truncated.
- Index schema sources needed for this view: migrations/DDL, ORM entity declarations, and relevant schema/configuration forms. If the indexer cannot parse a source form, report that limitation.
- Acceptance: fixtures cover one-to-one, one-to-many, many-to-many via join table, nullable FK, composite key, unique key, and schema with no FK declarations. Cardinality and keys must match the fixture; no ORM/property relation alone may be presented as a database constraint.

### S10 — Data flow diagram

- Represent external entities, processes, data stores, and data flows using distinct DFD shapes.
- Label each flow with the data object or payload moving along it, not merely the function name. Show direction and whether the flow is synchronous, asynchronous, or persisted when known.
- Give processes stable names/identifiers and support context and level-1 views. Every process must have at least one input and output unless an evidenced source/sink is documented.
- Distinguish Redis, relational DB, queue/outbox, and external provider stores/services when evidenced.
- Acceptance: a reserve flow fixture distinguishes the request, validation/reservation processes, Redis balance data, transaction persistence, ledger writes, and provider interaction. A call edge without data evidence must not be presented as a named data flow.

### S11 — Decision table

- Render a real table, not a graph whose nodes happen to be arranged in rows and columns.
- Use columns for rules and rows for conditions/actions, or another conventional decision-table orientation with clear headers. Show condition values (true/false/any), action outcome, and rule identifier.
- Include evidenced rules only. Mark combinations not covered by source as unknown/uncovered; do not enumerate them as actual code behavior.
- Link each condition/action cell to the branch or test evidence that supports it.
- Acceptance: a reserve fixture shows existing-state replay, insufficient balance, successful reservation, and persistence-failure compensation as separate rules with the correct outcomes; uncovered combinations are explicitly labeled.

### S12 — Saga / compensation graph

- Show forward actions and compensating actions as different node or edge types, with a clear direction and legend.
- Connect each compensation to its forward action and triggering failure condition. Distinguish rollback from retry, refund, and cancellation.
- Show irreversible/committed steps and the point after which compensation is unavailable when source supports it.
- Missing compensation must be a labeled gap. Do not infer a compensation merely because a method named `rollback` exists.
- Acceptance: fixtures prove the DB-sync failure path invokes cancel, a later rollback path releases a reservation, and a posted transaction cannot be rolled back; missing or unverified paths are not drawn as complete.

### S13 — Outbox pattern topology

- Show the writer/transaction, outbox store/table, poller/consumer, message/event, and downstream handler as separate elements.
- Mark the transaction boundary and claim atomic write behavior only if the same transaction is evidenced.
- Show delivery states, retry/lease/dead-letter handling, and idempotent consumer behavior only when implemented and evidenced.
- Distinguish polling from push delivery and synchronous callbacks from asynchronous processing.
- Acceptance: fixtures include transactional outbox write, poller, successful delivery, retry/failure state, and consumer. The chart must not claim “exactly once” from polling or idempotent inserts alone.

### S14 — Idempotency matrix

- Rows identify operations; columns identify replay scenarios (same request ID, same batch ID, concurrent duplicate, retry after partial failure) or use the inverse orientation with clear headers.
- Each cell states observed outcome, idempotency mechanism, key scope, and evidence. Distinguish idempotent response, no-op, duplicate rejection, and unknown behavior.
- Include the affected persistence key/unique constraint when present. State whether the guarantee is local to one service/store or spans the full workflow.
- Acceptance: reserve, post, and rollback fixtures distinguish sequential duplicate, concurrent duplicate, and partial-failure retry. An invariant is not claimed from test names alone.

### S15 — Dependency-injection wiring diagram

- Represent component/class, provided interface, injected dependency, and concrete binding as distinct items or labeled relations.
- Label constructor, field, parameter, factory, or framework-based injection where statically evidenced. Include qualifiers, scopes, and configuration keys where available.
- Show cycles only when a cycle exists in the resolved binding graph. Do not report a missing binding from an incomplete index or omitted module.
- An unresolved dependency must be labeled unresolved with the search/index scope; it must not be shown as a confirmed binding.
- Acceptance: fixtures cover constructor injection, interface-to-implementation binding, qualifier, factory/provider binding, optional dependency, and circular dependency. The displayed graph matches the resolved binding declarations.

## 5. Verification requirements

### 5.1 Automated contract tests

- Add schema tests for every chart-specific output variant, including malformed output, unknown evidence, stale evidence, wrong endpoints, invalid enum values, oversized plans, and missing required notation elements.
- Add compiler tests for every chart: input plan → validated `ViewSpec`/typed visual model, including gaps and evidence preservation.
- Add renderer tests for symbol identity, relation line styles, text labels, legends, order, geometry, and correct use of the explicit positions.
- Add test fixtures for all chart entries S1–S15. The existing generic “every form” layout test does not count as coverage for all chart notations.
- Keep tests for no overlap, no edge-through-node, readable labels, keyboard navigation, and evidence-link inspectability. Set per-chart crossing limits where crossings are meaningful.
- Add a test proving the offline stub does not label every chart as `call-flow` and that unsupported chart types return an explicit limitation.
- Add cache tests proving different chart IDs/contracts cannot reuse each other's plans and a new evidence bundle invalidates old plans.

### 5.2 Visual verification

- Maintain one deterministic fixture per chart with a known expected structure.
- Capture rendered browser output at desktop and narrow viewport sizes for each fixture. Review snapshots for actual notation semantics, not only successful mounting.
- Include empty/incomplete evidence cases, large diagrams, and long labels.
- Verify keyboard and screen-reader text alternatives for every fixture.
- A chart is complete only when its semantic, evidence, rendering, accessibility, and failure-state checks pass. A generic node graph with a chart-specific caption does not pass.

## 6. Delivery sequence

1. **Stop false labeling:** make chart selection explicit, make the offline fallback honest, separate chart contract/version in caching, and expose structured diagnostics.
2. **Build schema ingestion:** index persistence schemas and key constraints needed by S4/S9; improve assertion-level test evidence for S5/S14.
3. **Add typed plans and renderers:** implement notation families and their evidence validation, beginning with S9 ERD, S4 ledger, S2 sequence, S3 state machine, and S5 test-guarantee matrix.
4. **Implement remaining diagrams:** S1, S6–S8, and S10–S15 according to their requirements above.
5. **Verify each chart:** complete automated fixtures, browser screenshots, accessibility checks, and gallery copy review. Update availability text so partially supported types are not presented as complete.

## 7. Definition of done

- Every S1–S15 selection produces the selected chart type or a clearly labeled evidence limitation; it never silently becomes a different chart.
- Each chart satisfies its chart-specific acceptance criteria and has deterministic positive, partial-evidence, and unsupported fixtures.
- All claims and relation labels have valid evidence links or are visibly marked as inferred/unknown.
- The chart's visual notation, accessible text alternative, legend, and details panel agree with one another.
- The offline path is deterministic and honest, the online path is schema-validated, and cached plans are type/revision safe.
- The gallery's names, descriptions, examples, and availability states match what the implementation can actually render.
