# Empty / blank chart report
_Generated from screenshots in `/tmp/cie-chart-screenshots/` — run 2026-10-09_

## Fix status

The screenshots below are the pre-fix baseline. The changes listed here have compile checks, but the screenshot run has not been repeated yet.

- **Offline elements without evidence:** typed chart elements are now matched to exact indexed symbols or their source directory. Those matches render as dashed inferences with an explanation; they are not presented as source-proven chart roles. Offline state, decision, package, module, call, interaction, and context plans now carry evidence or get this compiler fallback. S15 bindings, S19 call flows, and S23 cross-directory dependencies are built from indexed relationships.
- **Empty charts:** generated charts and route maps with no renderable nodes now show their caption and evidence gaps in the canvas instead of leaving an unexplained blank area. S4 remains empty for the TypeScript-only fixture because it has no persisted table declarations; S26 remains empty when no metric facts are indexed.
- **S1/S6 request failures:** chart requests now catch unexpected chart-path exceptions, log the request ID, chart ID, and error, and return a partial diagnostic chart view instead of the generic server 500. The screenshots do not contain the original exception, so its exact trigger still needs the next server log entry to identify.
- **Offline scope:** S21 explicitly seeds a named function or method from the question, including an isolated root. S25 uses indexed `throws` facts as failure candidates rather than treating every method as a failure. S26 no longer labels arbitrary functions and fields as metrics.
- **Repository chart evidence:** S11 now reads explicit branch-condition AST facts (and legacy path-condition facts); S17 builds source-directory packages and cross-package import links; S25 retrieves repository-wide throw sites and labels same-function compensation calls as candidates; S26 retrieves metric declarations such as OpenTelemetry `createCounter("name")`; S27 uses only recognizable infrastructure/provider client imports as possible external systems and labels the deployment link as unproven. S4 retrieves JPA table/column entities repository-wide, but still correctly has no ER entities when the source declares no persistence mapping.
- **Prerequisites and zoom:** V6, V9, V14, and V17 still require their documented data; V13 still needs zooming for file detail. V18 now displays its “no framework routes” explanation in the canvas for the route-free fixture.

The offline matches are explicitly marked as inferences because a class or function being present in source does not prove it is a use case, state, metric, or architectural role. Missing repository data remains a gap rather than fabricated diagram content.

Each entry below is a chart whose canvas area was **completely blank** (zero visible
nodes/edges/cells) when the screenshot was taken.  Charts that rendered *something* —
even a single node, a partial diagram or a graceful "no data" message — are not listed.

Three distinct root causes appear:

| Cause | Short label used below |
|---|---|
| The offline (stub) model cannot derive notation-specific structure; it found 0 source items | **Offline / 0 items** |
| A `STORAGE_FAILURE: internal error` from the server prevented the chart from being built | **Server error** |
| The chart requires data the payments-repo fixture does not contain (missing prerequisites) | **Missing data** |

---

## Blank charts

### S1 — C4 container / component architecture
**Status in test run:** FAIL (timed out)\
**Root cause:** Server error

The conversation panel shows `STORAGE_FAILURE: internal error` in red for the S1 turn.
The view header says *"0 drawn nodes and edges"* and the canvas is empty.  The offline
model attempted to generate the layout but the server rejected its output before anything
could be stored or drawn.  No nodes or edges were ever written to the canvas.

---

### S3 — BatchId lifecycle state machine
**Status in test run:** PASS (screenshot taken after `waitFor` succeeded on the badge)\
**Root cause:** Offline / 0 items

The view header reads: *"BatchId lifecycle state machine · Offline S3 (state machine)
diagram: 15 state(s), 15 transition(s) from indexed call relationships."*  That sounds
like data was found, but the evidence status footer says **"0 drawn nodes and edges"** and
the canvas is blank.  The offline model declared 15 states yet produced no renderable
nodes — the state-machine renderer requires a hosted model to emit the actual node/edge
JSON; the offline path only counts items and reports them in the caption without drawing
them.

---

### S4 — Ledger and entry relationships (ER diagram)
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Ledger and entry relationships · Offline S4 (ER diagram) diagram: 0
table(s) from indexed symbols."*  The payments-repo fixture uses plain TypeScript objects
and functions — there are no SQL table declarations or ORM model classes that the indexer
can recognise as ER tables.  With 0 tables extracted the renderer has nothing to place,
so the canvas is blank.

---

### S6 — Use case diagram
**Status in test run:** FAIL (timed out)\
**Root cause:** Server error

The `waitFor` condition for S6 checks for the gallery entry name in `document.body.innerText`
after the chart is shown.  The conversation panel shows a `STORAGE_FAILURE: internal
error` response for the S6 question ("Show the payments use case diagram").  The server
rejected the offline model's output and stored nothing; the canvas contains 0 nodes and 0
edges, so the wait condition never matched.

---

### S11 — Decision table
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Decision table · Offline S11 (decision table) diagram: 0 condition(s) from
indexed symbols. Rules and outcomes are not derived offline."*  The offline model found
zero decision-table conditions in the fixture.  The payments-repo does not have explicit
`if/else` chains that the indexer classifies as decision-table conditions, so there is
nothing to render.

---

### S12 — Saga / compensation graph
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Saga / compensation graph chart · Offline S12 (saga) diagram: 3 step(s)
from indexed symbols. Edges and compensation steps are not derived offline."*  Three saga
steps were found but the offline model cannot derive the edges or compensation steps that
connect them — those require a hosted model.  With no edges the graph renderer produces a
blank canvas.

---

### S13 — Outbox pattern topology
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Outbox pattern topology chart · Offline S13 (outbox) diagram: 18 element(s)
from indexed symbols. Flows and pollers are not derived offline."*  18 symbols were found
but the flows and poller relationships — the edges that make the topology meaningful —
require a hosted model.  Without edges the layout engine has nothing to place.

---

### S14 — Idempotency matrix
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Idempotency matrix chart · Offline S14 (idempotency matrix) diagram: 2
operation(s), 2 scenario(s). The offline model can only arrange statically indexed facts,
so notation-specific details a hosted model could judge are left as gaps rather than
invented."*  Operations and scenarios were identified but the matrix cells (idempotency
verdicts per cell) are notation-specific judgements the offline model cannot make.  The
matrix is blank.

---

### S15 — DI wiring diagram
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"DI wiring diagram chart · Offline S15 (DI wiring) diagram: 3 component(s)
from indexed symbols. Bindings and cycles are not derived offline."*  Three components
were identified but the injection bindings between them (the edges) require a hosted
model.  No edges means a blank canvas.

---

### S17 — UML package diagram
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"UML package diagram chart · Offline S17 (package diagram): 0 package(s)
from directory structure. Dependencies are not derived offline."*  The offline extractor
found zero packages.  The payments-repo uses flat `src/payments/`, `src/ledger/` etc.
directories but these are not decorated with any package-declaration syntax the indexer
recognises as UML packages, so nothing is drawn.

---

### S18 — UML communication diagram
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"UML communication diagram chart · Offline S18 (communication diagram): 2
participant(s), 2 message(s). The offline model can only arrange statically indexed
facts."*  Two participants and two messages were found, but the numbered-message layout
and link routing for a communication diagram require a hosted model to assign sequence
numbers and positions.  The canvas is blank.

---

### S19 — UML interaction overview
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"UML interaction overview chart · Offline S19 (interaction overview): 5
frame(s). The offline model can only arrange statically indexed facts."*  Five frames were
identified but the interaction-overview notation — decision frames, sequence-flow connectors
— requires a hosted model to compose.  The canvas is blank.

---

### S20 — CRC cards
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"CRC cards chart · Offline S20 (CRC cards): 2 card(s). The offline model
can only arrange statically indexed facts."*  Two class cards were found but the
responsibility and collaborator text that fills each card is a judgement the offline model
cannot make.  The canvas is blank even though two cards exist in the data model.

---

### S21 — Call graph
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Call graph chart · Offline static call graph: 2 function(s), 1 resolved
call edge(s). … 0 drawn nodes and edges."*  Two functions and one edge were indexed but
the renderer produced nothing.  The question asked for a call graph *rooted at
`createPayment`* — the offline model resolved only 1 edge from the full graph yet the
renderer still drew 0 nodes.  This suggests the root-node seeding step failed silently: a
`createPayment` symbol exists in the index but the call-graph builder could not match it
to the requested root name in the offline path.

---

### S22 — Layered architecture
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Layered architecture chart · Offline S22 (layered architecture): 3 layer(s),
3 component(s). … 0 drawn nodes and edges."*  Three layers and three components were
identified but the offline model cannot assign components to layers or draw dependency
edges between layers — those are hosted-model judgements.  Canvas blank.

---

### S23 — Dependency / module graph
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Dependency / module graph chart · Offline S23 (module graph): 1 module(s).
Dependencies are not derived offline."*  Only one module was extracted (the entire repo
collapsed to a single module) and no dependency edges can be derived offline.  With a
single unconnected node the layout engine produces a blank canvas.

---

### S24 — State transition table
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"State transition table chart · Offline S24 (state transition table): 5
state(s), 0 event(s)."*  Five states were found but zero events/transitions — without
events there are no table rows to draw.  The offline extractor cannot infer which events
connect which states without a hosted model.

---

### S25 — FMEA / compensation matrix
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"FMEA / compensation matrix chart · Offline S25 (FMEA): 0 failure mode(s)."*
The offline model found zero failure modes in the fixture.  FMEA failure modes are a
hosted-model classification; the offline path cannot identify them from static call
relationships alone.

---

### S26 — Metrics / telemetry map
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"Metrics / telemetry map chart · Offline S26 (metrics): 0 metric(s)."*
The payments-repo fixture does not contain any metric-emission calls that the indexer
recognises (e.g. `counter.inc()`, `histogram.observe()`, `meter.record()`).  With 0
metrics there is nothing to draw.

---

### S27 — C4 context diagram
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"C4 context diagram chart · Offline S27 (C4 context): 0 element(s)."*
The C4 context level requires identification of the system boundary, its human users and
external systems — judgements the offline model cannot make from call-graph facts alone.
0 elements extracted, canvas blank.

---

### S28 — UML sequence diagram
**Status in test run:** PASS\
**Root cause:** Offline / 0 items

View header: *"UML sequence diagram chart · Offline S28 (sequence diagram): 8
participant(s), 12 message(s)."*  Eight participants and 12 messages were found but
the evidence status footer reports **"0 drawn nodes and edges"** and the canvas is blank.
The sequence-diagram renderer requires lifeline and fragment layout from a hosted model;
the offline path records the items but cannot produce the swimlane-style canvas output.

---

### V6 — Semantic diff timeline
**Status in test run:** PASS (screenshot captured showing the Visuals gallery modal)\
**Root cause:** Missing data (expected — greyed out in gallery)

V6 requires two separately indexed revisions of the repository to produce a before/after
diff.  Only one revision was indexed during the test run.  The gallery entry was greyed
out (`unavailable`) so the test fell back to screenshotting the gallery itself; no diff
canvas was ever attempted.

---

### V9 — Runtime overlay
**Status in test run:** PASS (screenshot captured showing the Visuals gallery modal)\
**Root cause:** Missing data (expected — greyed out in gallery)

V9 requires recorded runtime exceptions or ingested trace data.  None were present in
the test environment (the `@cie/reporter` was not running and no exceptions were pasted).
The gallery entry was greyed out; the test screenshotted the gallery itself.

---

### V13 — Ownership map
**Status in test run:** PASS\
**Root cause:** Offline / minimum data (L0 only)

The canvas shows a single box labelled *"system (14)"* — the entire 14-file repo collapsed
to the L0 system node.  This is technically not blank, but no owner columns or file nodes
are visible.  The ownership view was screenshotted at the default zoom level (L0 · System)
where all 14 files aggregate into one node.  No CODEOWNERS file exists in the
payments-repo fixture, so de-facto owners were inferred from git; at L0 all files collapse
under one system box.  Zooming to L3 would reveal file-level detail.

---

### V14 — Implicit-concept atlas
**Status in test run:** PASS (screenshot captured showing the Visuals gallery modal)\
**Root cause:** Missing data (expected — greyed out in gallery)

V14 requires concept cards to have been extracted for the current revision (a separate
`concepts` job).  No concept-extraction job was run during the test, so the gallery entry
was greyed out and the test screenshotted the gallery.

---

### V17 — Trace-linked profile
**Status in test run:** PASS (screenshot captured showing the Visuals gallery modal)\
**Root cause:** Missing data (expected — greyed out in gallery)

V17 requires an ingested performance profile (pprof, v8 cpuprofile, or folded stacks).
None were ingested during the test run.  Gallery entry greyed out; gallery screenshotted.

---

### V18 — Framework route map
**Status in test run:** PASS\
**Root cause:** Missing data (no framework routes in fixture)

View header: *"No framework routes were found in this revision."*  The canvas is blank.
The payments-repo fixture uses plain function calls without a recognised HTTP framework
decorator (`@Get`, `router.get(…)`, `app.post(…)`, etc.), so the indexer found 0 routes.
This is an honest "no data" result, not an error.

---

## Summary table

| Chart | Canvas | Root cause |
|---|---|---|
| S1  | blank | Server error (`STORAGE_FAILURE`) |
| S3  | blank | Offline model: found items, cannot draw them without a hosted model |
| S4  | blank | Offline / 0 items: fixture has no ORM/SQL table declarations |
| S6  | blank | Server error (`STORAGE_FAILURE`) |
| S11 | blank | Offline / 0 items: no decision-table conditions extracted |
| S12 | blank | Offline / 0 edges: saga edges require hosted model |
| S13 | blank | Offline / 0 edges: outbox flows require hosted model |
| S14 | blank | Offline: matrix cells require hosted model judgement |
| S15 | blank | Offline / 0 edges: DI bindings require hosted model |
| S17 | blank | Offline / 0 items: no UML package declarations in fixture |
| S18 | blank | Offline: communication-diagram layout requires hosted model |
| S19 | blank | Offline: interaction-overview frames require hosted model |
| S20 | blank | Offline: CRC card content requires hosted model |
| S21 | blank | Offline: root-node seeding of `createPayment` failed silently |
| S22 | blank | Offline: layer assignment requires hosted model |
| S23 | blank | Offline / 1 module, no edges: dependency derivation requires hosted model |
| S24 | blank | Offline / 0 events: transition events require hosted model |
| S25 | blank | Offline / 0 items: FMEA failure-mode classification requires hosted model |
| S26 | blank | Offline / 0 items: no metric-emission calls in fixture |
| S27 | blank | Offline / 0 items: C4 context elements require hosted model |
| S28 | blank | Offline: sequence-diagram lifeline layout requires hosted model |
| V6  | gallery | Missing data: needs two indexed revisions |
| V9  | gallery | Missing data: needs runtime exception data |
| V13 | L0 only | No owner breakdown at default zoom; no CODEOWNERS file |
| V14 | gallery | Missing data: needs concept cards extracted first |
| V17 | gallery | Missing data: needs an ingested performance profile |
| V18 | blank   | Missing data: no HTTP framework decorators in fixture |

## Remaining verification and data requirements

The old screenshots do not establish why S1 and S6 threw. Repeat those requests and inspect the structured `[chart]` log entry by request ID if the fallback view appears; it now records the underlying exception. Then refresh the screenshots to confirm the response is no longer a server error.

The screenshot run predates the latest repository-wide retrieval and chart derivation changes; rerun it to confirm which of S11, S17, S25, S26, and S27 gain evidence-backed content in this fixture. S4 still needs actual ORM or schema declarations. S26 still needs metric declarations such as a named instrumentation creation call; a fixture with no metric instrumentation should keep the no-data gap. S27 can show a repository boundary and recognizable imported infrastructure/provider clients, but source imports alone cannot prove deployed users or runtime connections.

V6, V9, V14, and V17 still need a second revision, runtime exception data, concept cards, and an ingested profile respectively. V13 needs zooming to reveal file-level detail. V18 needs a repository with recognized framework routes if the test should show route nodes rather than the no-routes explanation.

The original summary table above records the pre-fix screenshot results; it is not a post-fix test result.
