# Chart parity and completion status

**Purpose:** explain how the chart gallery compares with the 35 sample chart types, define “supported,” and list the work needed for complete parity.

**Scope:** the gallery in `apps/web/src/VisualsGallery.tsx` and built-in visuals in `packages/core/src/visuals.ts`. This is a capability map, not a claim that every chart will contain data for every repository. The detailed implementation requirements are in [`chart-rendering-requirements.md`](chart-rendering-requirements.md).

## What “supported” means

“Supported” can mean several different things, so this document uses these labels:

- **Dedicated representation:** the chart has its own typed data contract and chart-specific compilation/rendering path. That establishes a real capability, but does not by itself mean full UML, BPMN, or other standard conformance.
- **Partial / approximation:** a related view can show some of the same information, but it omits important notation or semantics from the sample type.
- **No dedicated view:** the gallery has no chart designed for that sample type. A generic graph may still be able to show related facts.
- **Evidence-limited:** the chart capability exists, but the indexed repository or mock fixture does not contain enough evidence to populate it. An honest empty state or listed gap is expected; inventing data is not support.

For **full parity**, each sample type needs a dedicated, documented representation with the expected elements, relationships, labels, and rules; evidence and gap handling; and a populated fixture that demonstrates the notation. A chart being selectable, returning a valid response, or drawing generic nodes and arrows does not meet that bar. “Supported” also does not mean the product can infer facts absent from the repository.

## Current parity against the 35 samples

The “closest current view” column identifies the best match in the current gallery. A match can be approximate; it does not imply standards conformance.

| # | Sample chart type | Closest current view | Parity | What remains for full parity |
|---:|---|---|---|---|
| 1 | UML Class Diagram | S16 UML class diagram | Dedicated representation | Verify attributes, operations, visibility, interfaces, inheritance, and relation kinds across language fixtures. |
| 2 | UML Component Diagram | S1 architecture | Partial | Add explicit component/provided-interface/required-interface semantics and UML dependency notation. |
| 3 | UML Package Diagram | S17 UML package diagram | Dedicated representation | Verify package membership and dependency extraction across supported languages and workspace layouts. |
| 4 | UML Deployment Diagram | S1 architecture | Partial | Add deployment nodes, execution environments, artifacts, and deployment relationships. |
| 5 | Hexagonal / Ports & Adapters | S1 architecture; S15 DI wiring | Partial | Distinguish domain core, ports, adapters, and direction of dependency explicitly. |
| 6 | Layered Architecture | S22 layered architecture | Dedicated representation | Verify layer assignments, order, dependency direction, and reported violations against fixtures. |
| 7 | C4 Context | S27 C4 context diagram | Dedicated representation | Verify people/system/external-system roles and labeled relationships without promoting unsupported actors to facts. |
| 8 | Dependency / Module Graph | S23 dependency/module graph | Dedicated representation | Verify compile-time, runtime, and test-only dependency extraction and cycle handling. |
| 9 | UML Activity Diagram | S2 transaction journey | Partial | Add UML activity actions, control/object flows, fork/join and activity-final semantics. |
| 10 | UML Communication Diagram | S18 UML communication diagram | Dedicated representation | Verify numbered message order, participants, sync/async/return kinds, and evidence links. |
| 11 | UML Timing Diagram | S3 state machine | Partial | Add time axis, lifelines/state changes, and measured or explicitly modeled timing. |
| 12 | UML Interaction Overview | S19 UML interaction overview | Dedicated representation | Verify interaction frames, references, decisions, and guarded control-flow with populated fixtures. |
| 13 | UML Use Case Diagram | S6 use-case view | Partial | Add native actor, use-case, system-boundary, and include/extend/generalization notation. |
| 14 | BPMN | S7 BPMN | Dedicated representation | Complete notation coverage and verify pools/lanes, event/gateway distinctions, message flows, and compensation behavior against fixtures. |
| 15 | Swimlane Flowchart | S2 transaction journey | Partial | Add general-purpose lanes and cross-lane flow rules; current view is centered on an operation journey. |
| 16 | Event Storming / Event Modeling | S8 event-storming | Dedicated representation | Demonstrate all supported bands and roles (commands, events, policies, aggregates, read models, external systems) with a populated fixture. |
| 17 | ER Diagram | S4 ledger relationships; S9 ER | Dedicated representation | Validate schema parsing and cardinality/key/nullability fidelity across migrations, ORM declarations, composite keys, and absent-FK cases. |
| 18 | Data Flow Diagram | S10 DFD | Dedicated representation | Complete context/level-1 views and verify named payload flows, process balance, and sync/async/persisted distinctions. |
| 19 | Data Lineage | V5 data lineage | Dedicated representation | Confirm source/sink, transformation, and transaction-boundary coverage for supported languages and data sources. |
| 20 | Decision Table | S11 decision table | Dedicated representation | Verify rule/value/action semantics, uncovered combinations, and evidence attached to each condition and outcome. |
| 21 | State Transition Table | S24 state transition table | Dedicated representation | Verify current state, event, guard, next state, forbidden cases, and explicit unknown combinations. |
| 22 | Race Condition Timeline | V10 race-window map | Partial | Add a time-ordered interleaving view for concurrent actors and shared state; a race-window map is not a timeline. |
| 23 | Petri Net | S3 state machine | Partial | Add places, transitions, tokens, and marking semantics. State nodes and arrows do not establish Petri-net behavior. |
| 24 | Saga / Compensation Graph | S12 saga | Dedicated representation | Verify trigger-to-compensation links, retries, irreversible steps, and missing-compensation reporting with fixtures. |
| 25 | Outbox Pattern Diagram | S13 outbox topology | Dedicated representation | Verify transaction boundaries, delivery states, retries, and consumers; only claim atomicity when source evidence proves it. |
| 26 | FMEA / Compensation Matrix | S12 saga; S11 decision table | Partial | Add FMEA rows and fields for failure mode, effects, severity, occurrence, detection, risk priority, and mitigation. |
| 27 | Idempotency Matrix | S14 idempotency matrix | Dedicated representation | Verify replay scenarios, key scope, mechanism, and outcomes across sequential, concurrent, and partial-failure cases. |
| 28 | Call Graph | S21 call graph | Dedicated representation | Verify resolved static call edges, ownership, call-site evidence, and unresolved-call gaps. |
| 29 | Control Flow Graph | S2; S7 | Partial | Add basic blocks and branch/merge edges at code level, with a clear distinction between static control flow and runtime traces. |
| 30 | CRC Cards | S20 CRC cards | Dedicated representation | Verify responsibility and collaborator evidence; avoid inferring ownership from names alone. |
| 31 | DI / Wiring Diagram | S15 DI wiring | Dedicated representation | Verify qualifiers, scopes, factories, unresolved bindings, and cycles against framework-specific fixtures. |
| 32 | Test Traceability Matrix | S5 test-guarantee; V12 test-confidence | Dedicated representation | Keep reachability separate from assertions and verified guarantees; demonstrate test-to-requirement links and evidence states. |
| 33 | Metrics / Telemetry Dashboard | V9 runtime overlay; V17 trace-linked profile | Partial | Add a general metrics dashboard with named metrics, units, time windows, aggregation, and provenance. Exceptions/profiles are narrower inputs. |
| 34 | Threat Model / DFD with Trust Boundaries | V8 trust-boundary + S10 DFD | Partial | Combine DFD flows with trust zones, assets, threats, and controls in one model. The current trust map and DFD are separate views. |
| 35 | Flame Graph / Profiling Chart | V17 trace-linked profile | Partial | Add a classic aggregated stack flame graph, with sample counts/weights and provenance. V17 is a trace-linked profile view, not a flame graph. |

### Reading the status

The gallery now includes dedicated representations for many sample families, including UML class/package/communication/interaction views, BPMN, event modeling, ER, DFD, decision tables, state transition tables, call/module graphs, layered architecture, CRC cards, sagas, outbox, idempotency, DI wiring, C4 context, data lineage, and test traceability. This is **not full one-to-one parity with all 35 samples**: several types still have only an approximation or omit important semantics. “Dedicated representation” does not promise complete standards conformance; see the remaining-work column and the requirements document.

Some charts can render with no domain elements when the repository provides no suitable evidence. For example, the current offline fixture does not provide schema evidence for the ER view, so an empty/gap result does not mean the ER renderer is missing. It means populated ER output has not been demonstrated with that fixture. The same distinction applies to runtime, test, profile, and framework-specific data.

The gallery now claims that all 35 standard diagram types are covered. Treat that as catalog coverage, not full notation parity: the count includes approximations and related views. Keep the mapping and wording aligned with the status definitions above.

## Work needed to complete parity

1. **Agree on the catalog.** Decide which of the 35 samples are product commitments, which should remain explicitly partial, and whether any should be removed or renamed. Keep the gallery descriptions aligned with actual notation.
2. **Close the no-view and approximation gaps.** Prioritize UML class, package, deployment, activity/communication/timing/interaction, state-transition table, Petri net, race timeline, FMEA, call graph, CFG, CRC, general telemetry dashboard, combined threat-model DFD, and flame graph. For every approximation retained, state its boundary in the UI.
3. **Complete typed contracts and renderers.** Use chart-specific data structures and visual symbols. Ensure the renderer preserves semantics such as cardinality, guards, message ordering, token flow, lanes, risk values, and timing where the chart requires them. Avoid treating layout or a prompt as evidence.
4. **Improve indexing and evidence.** Parse the repository sources needed by each chart (for example, schema migrations for ERDs, framework bindings for DI, test assertions for traceability, and profile samples for profiling). Show unsupported file formats and missing evidence as explicit gaps.
5. **Prove each chart with fixtures.** Give every committed chart type at least one populated fixture, plus edge cases for missing/ambiguous evidence. Capture rendered examples and check that labels, symbols, relationships, and gap states are readable. A screenshot of a blank evidence-limited view is useful for empty-state coverage, but it does not prove populated notation parity.
6. **Audit the end-to-end path.** Confirm selected chart ID survives request, cache, compilation, refresh, and display. Confirm evidence links work and that a failed or unsupported plan keeps the requested chart selected while explaining the limitation.
7. **Publish accurate completion claims.** Update the gallery’s coverage count only after the mapping and fixtures meet the agreed definition. Describe any standard subset explicitly rather than calling an approximation fully supported.

## Completion checklist

A sample chart type is complete when all of these are true:

- Its scope and notation subset are named in the gallery.
- Its data contract represents the required elements and relationships directly.
- Its compiler validates evidence, endpoints, constraints, and required semantics, and reports omissions as gaps.
- Its renderer uses distinguishable notation and provides a readable legend/text alternative.
- A populated fixture renders the expected cases, and an insufficient-evidence fixture renders an honest explanation.
- The selected chart type and evidence survive refresh and inspection.
- The gallery-to-sample mapping and any aggregate parity count are reviewed and accurate.

“Supported” should therefore be read as **implemented to the stated scope and able to render evidence-backed content**. Full parity is the stricter checklist above; availability for a particular repository additionally depends on indexed evidence and required inputs.
