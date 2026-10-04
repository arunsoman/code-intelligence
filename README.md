# Code Intelligence — MVP ("The Questionable Map")

A developer asks a question about an unfamiliar TypeScript, Rust or Nirdosha v2 repository and gets a **view generated for that question** (one of sixteen forms, below), in which every element says how it is known: **Fact** (statically proven), **Inference** (derived from cited evidence), **Hypothesis** (cannot be proven from the code alone) or **Fog** (static analysis could not resolve it). Nothing is shown without evidence you can click, and the system says "I can't determine this" rather than guess.

Built from `Unified_Code_Intelligence_Product_Specification` (the S5 MVP definition, plus S1/S2 requirements it does not contradict) and `Code_Intelligence_Component_API_Contracts` v1.1. Excluded, as every source excludes them: intent→code generation, general counterfactual simulation (the MVP supports removal-only impact analysis), agent mode, live runtime adapters, PR view, multi-repo, JetBrains.

## What it does

| Question you ask | What you get |
|---|---|
| "Show me how authentication works" | **SemanticMap**: relevant code grouped by responsibility, with semantic zoom |
| "Show me everything that could cause a payment to fail" | **CausalGraph (failure)**: operation → … → failure sites, each cited; async-only failures flagged as hypotheses |
| "Why could this balance become incorrect?" | **CausalGraph (invariant)**: every writer of the field, transactional or not, and the async paths that reach them |
| *paste a stack trace* | **HypothesisGraph**: ranked suspects with a six-factor breakdown; "ignore X" and "why do you suspect Y?" steer it live |
| select elements → "why are these connected?" | A cited explanation that went through all five claim checks |
| "why are you showing this?" / "why isn't X shown?" | The salience factors, or the specific reason X was left out |
| "continue the payment investigation" | Restores the saved investigation (including the conversation) and reports what changed in the repository since |

The **Investigations** button opens the C22 hypothesis board. Create an investigation with a question and optional stack trace, then use **Run next checks** to run a bounded wave of read-only checks. The board compares observations against hypotheses, highlights discriminating evidence, shows assessment reasons and source citations, and updates every 1.5 seconds. Pause/resume controls and saved investigations are available in the same panel. Investigations belong to the current saved workspace, or to the repository when no workspace is open, and remain pinned to their original code revision. Priority is not probability; missing, stale, rejected and retracted assessments are labeled separately from contradictions. Hypothesis editing, evidence attachment, scope steering and finalization remain API operations.

## The sixteen visuals
The question you ask picks the form, or choose one from **Visuals** in the header, which shows what each answers, what it needs, and whether it can be shown for this repository right now. Every form obeys the same contract: every element cites evidence you can open, nothing inferred is drawn as fact, and what could not be determined is listed under "gaps". An automated audit (`provenanceAudit`) checks this for every form in the tests.

| | Form | Ask something like | What you see |
|---|---|---|---|
| V1 | Intent-relative architecture map | "Show me how authentication works" | Relevant code grouped by responsibility, with semantic zoom L0–L6 |
| V2 | Causal hypothesis graph | *paste a stack trace* | Ranked suspects with a six-factor breakdown; "ignore X", "why do you suspect Y?" |
| V3 | Failure-space map | "Show me everything that could cause a payment to fail" / "Why could this balance become incorrect?" | Failure sites, or every writer of a field, each cited; async-only ones flagged |
| V4 | Transaction journey | "Walk me through createPayment" | Swim lanes by module, steps in call order, decision diamonds where it can fail, async hand-offs |
| V5 | Data lineage and mutation | "Who reads and writes balance?" | The data at the centre, writers left, readers right, transaction boundary, order-of-application risks |
| V6 | Semantic diff timeline | "What changed since the last index?" | Before and after side by side, a "what this means" list (new failure mode, transaction removed, test meaning changed, concept affected), and the commits behind it |
| V7 | Archaeology chain | "Why is adjustBalance not transactional?" | The commits that touched those lines, oldest first, beside the comments in the code that still bind it |
| V8 | Trust-boundary and privilege map | "Who can reach adjustBalance and what stops them?" | Walls between outside and inside, the gates that can refuse a request, protected state, unprotected paths as hypotheses |
| V9 | Runtime overlay | "What has been going wrong in the last 7 days?" | Reported exceptions and failing tests tinted onto the structure; window buttons |
| V10 | Concurrency and race windows | "Where can balance race?" | One lane per execution path touching the data, transaction flags, flagged interleaving windows citing both statements |
| V11 | Counterfactual overlay | "What if we remove the ledger module?" | Today's code solid, the removal ghost-outlined, consequences attached (broken callers, dropped events, protection lost, writers gone, tests that break) |
| V12 | Test-confidence map | "How well tested are our operations?" | Operations against the tests that reach them, with coverage, failing tests, and properties no test asserts |
| V13 | Ownership and knowledge | "Who owns what and where is the bus factor 1?" | Files under their owner (CODEOWNERS, else de facto), tinted by how thin or stale the knowledge is |
| V14 | Implicit-concept atlas | "Show the implicit concepts" | Concept cards pinned onto the code that implements them, scatter, and where enforcement is missing |
| V15 | Policy enforcement map | "Which policies are enforced and where are the gaps?" | Each rule solid (enforced in code) or hollow (convention only), what it governs, and routes that get around it |
| V16 | Change-risk terrain | "Where is it risky to change things?" | A relief map of files tinted by a composite of coupling, churn, incidents, test gaps and thin knowledge; the formula is shown and the weights are sliders |

How the more inferential ones stay honest:
- **Gates and policies (V8, V15)** are proposed from code that can *throw a refusal*; a name alone is never enough. An "unprotected" or "escape" route is a hypothesis shown with its counter-argument (frameworks, proxies and configuration are invisible to static analysis).
- **Race windows (V10)** show that interleaving is *possible*, never that it happened.
- **Counterfactuals (V11)** are hypotheses by construction; "no consequence found" is a displayed outcome, not a claim of safety. Only *removal* is simulated.
- **Ownership (V13)**: de facto owners are inferences that need someone who knows to confirm them; a person cannot be matched to a team from git, so no "mismatch" is claimed.
- **Terrain (V16)** is labelled a composite and never a fact; missing data counts as a neutral value and is drawn hatched.
- **Archaeology (V7)** adds no model narration: events are commits, constraints are comments, and "which commit introduced it" is only a claim.

The forms that place their own elements (journey, lineage, diff, archaeology, trust, race, counterfactual, ownership, atlas, policy) keep their own structure (swim lanes, owner columns, zones) but are post-processed by the layout pass below; level of detail applies to the maps (V1–V3, V9, V12).

## Zoom, concepts, signals and keyboard
Semantic zoom, **L0–L6**: **L0 system** (the whole thing as one node, with the external packages it depends on) → **L1 domains** (intermediate abstractions the model proposes over the concepts; each is a claim that must be grounded, and when none exist L1 falls back to concepts rather than inventing one) → **L2 concepts** → **L3 files** → **L4 key symbols** → **L5 all symbols** → **L6 detail** (roles, notes, edge labels; double-click for the code). Levels change after a zoom settles (with different enter/exit thresholds, so they never flicker). Choosing a level with the stepper or in chat fits the view to it; zooming by gesture never moves the camera. Selection and identity survive every level.

**Concept cards** are a versioned store: every extraction is an immutable version, with a diff against the previous one. You can judge each card (Confirm / Dispute / Refute); a refuted card stops influencing ranking, and the model's own "high/medium/low" is compared against your verdicts so you can see whether it means anything (it abstains until ≥5 are judged).

**Runtime and test signals.** Paste a stack trace, or let a running app report exceptions with `@cie/reporter` (`installReporter()`); they land in an **Exceptions** inbox (repeats collapse into one entry with a count) and make the code they touch hotter in ranking. Traces from Node/Chrome, Firefox/Safari, async and constructor frames, browser dev servers (Vite/webpack, `file://`, Windows paths) are parsed; frames map to code by line and fall back to the function name. Coverage (lcov, Istanbul JSON) and test results (JUnit XML, Jest/Vitest JSON) found in the repository are attached to symbols as evidence; failing tests and low coverage appear as counter-arguments and make the code they exercise hotter. **Pin / Boost / Demote** any element (drawer buttons, or "pin X" / "boost X" / "demote X" / "reset X" in chat); overrides persist per repository.

**Keyboard and screen readers.** The canvas is one tab stop: arrow keys move between elements (an announcement says what each is, how it is known, and how many links it has), Enter inspects, Space selects, E opens the code, +/− change the level, O opens a **text outline** that lists every element and link in words, Escape clears the selection. Nothing relies on colour alone.

## Drawing: layout and chart types

Every map goes through one layout pass (`apps/web/src/arrange.ts`) that picks the algorithm from the *shape* of the view, then routes edges around nodes. Only positions and edge waypoints change, never claims, evidence or display modes.

| Shape of the view | Algorithm (source) |
|---|---|
| Grouped levels L0–L3 | Fruchterman & Reingold 1991 force layout, seeded from the form's own positions, then node-overlap removal in the style of Dwyer, Marriott & Stuckey 2005 |
| Forms whose columns are layers (failure-space, hypotheses, trust, test confidence, policy, lineage…) and one-lane journeys | Sugiyama, Tagawa & Toda 1981: dummy nodes for long edges, median/barycenter sweeps with adjacent transposition (Eades & Wormald 1994), size-aware coordinates by isotonic regression (a simpler stand-in for Brandes & Köpf 2002) |
| Owner columns (V13) | Tall columns wrap into sub-columns; rows reordered by median sweeps then swap search on the real crossing count |
| Swim lanes (journey, race) | Lanes permuted to cut crossings; large multi-lane journeys use columns by call depth |
| Any edge that would cross a node | Same-column links become margin arcs; otherwise a shortest path over a visibility graph of padded node corners (the basis of Kieffer et al. 2014) |
| Terrain (V16) | Squarified treemap (no overlaps by construction) |

**Measured, not eyeballed** (`apps/web/src/layoutmetrics.ts`, `apps/web/test/layout.test.ts`): for all fifteen node-link forms at levels 0–6 on the demo repository the tests require **zero node overlaps and zero edges drawn through an unrelated node**. Edge crossings are held to a per-form ceiling that can only go down (V2 ≤ 7, V5 ≤ 7, V13 ≤ 6, V15 ≤ 6, V11 ≤ 4, V14 ≤ 3, V4/V10/V8 ≤ 2, V12 ≤ 1, others 0). `node apps/web/test/layout-report.ts` prints the numbers per form and level; `REPO=/path node apps/web/test/layout-report.ts` runs it on any indexed repository.

What it does **not** do: crossings are minimised, not eliminated. Dense graphs have crossings no layout can remove: on a real 152-file repository a 41-step journey with 68 call edges (shared helpers called from many places) still has about a hundred. Planarization (Hopcroft–Tarjan, Tamassia), multilevel force layout (Walshaw, FM³, sfdp: these views are tens of nodes) and edge bundling (Holten 2006) are not implemented. The ownership map's import links are drawn faint until you select a file, because they are context, not the answer; they are excluded from the crossing count and listed in the outline.

**Chart types, revalidated against the question each answers:** node-link maps suit V1–V3, V5, V8, V9, V11 and V14; swim lanes suit V4 and V10 (a sequence across actors); side-by-side suits V6; a timeline suits V7; a treemap suits V16; owner columns suit V13 (its import links are context, so they are faint until you select a file).

**V12 and V15 are matrices.** Both are many-to-many relations (behaviours × tests, routes × rules), where a graph cannot avoid crossings and a grid can. Each is built on the server beside its graph, so every cell goes through the same claim gates and the same provenance audit as a node or edge (a cell shown as a fact cites static evidence and no claim; an inference or hypothesis cell cites a claim that passed all five gates). The **Matrix / Graph** switch above the view shows either drawing of the same result.

- **V15** rows are routes (entry point → state it changes), columns are rules. ✓ enforced (an inference: proposed from where the code throws), ✕ can get around (the route's own hypothesis claim, naming every check it skips), ○ held by convention, blank means no relation found. Rows with the most ways around come first, with a plain-words count.
- **V12** rows are behaviours (with confidence in words and a tint), columns are the tests that reach them and the properties a test should assert. A test cell is static fact: the fill is the share of the behaviour's functions the test reaches by parsed calls (four deep), ✗ marks a currently failing test. Reaching code is not asserting its behaviour, and the legend says so. ✓ means a test name mentions the property (an inference from names), ? means none does (a hypothesis).
- The grid is a real table with row and column headers: one tab stop, arrow keys move between cells, every cell has a spoken label ("route, rule: can get around. Hypothesis."), and the glyph, border style (solid fact, dashed inference, dotted hypothesis) and words carry meaning, never colour alone. axe-core reports zero violations on both.
- Matrix cells can be chosen as "these" for your next message: a click inspects a cell, **Space** or **Shift-click** adds it to the selection, and each chosen cell appears as a chip in the chat (a cell stands for the code of its row and its column; an empty cell can be chosen too, to ask why nothing is there).
- Limits: the semantic-diff, atlas and ownership forms stay as they are.

## Choosing the view: how a question is read
A small local language model reads the question; there are no patterns (regular expressions) in the routing. `packages/core/src/llm-router.ts` shows the model a closed list of labels (the 16 kinds of view, plus only the conversational requests that make sense right now: zoom, pin, "why isn't X shown", ignore… need a map or a selection), the eight labelled example questions nearest to the one asked (character n-gram similarity, so a misspelt word still lands near its neighbours), and asks for one label plus the name the user mentioned. The daemon constrains the label to the list, temperature is 0, and the name is matched against the code afterwards, never trusted. The view says which model read it and offers the nearest other readings as buttons. A choice you make (the gallery, or a button) is never second-guessed. A pasted stack trace is recognised by the trace parser, not by the model.
- **Model**: `qwen3:0.6b` through the local Ollama daemon by default. Name another with `--router-model <name>` (`./scripts_dev.sh --router-model llama3.2:1b`, or `node packages/core/src/server.ts --router-model llama3.2:1b`), or with `CIE_ROUTER_MODEL`; the argument wins. `--router-model off` (or `CIE_ROUTER=off`) disables it. A model that is not installed, or is hosted, is replaced by the default and the server log says so. A hosted (`:cloud`) model is refused, because the question would leave the machine. Install with `ollama pull qwen3:0.6b`.
- **No model, or no answer**: the general architecture map, marked *low* confidence, with the reason stated ("No router model is configured…") and the gallery to pick another view. Nothing is guessed in its place.

Which model? Measured on the 164 distinct labelled questions in `packages/core/test/route-sets.ts`, each asked as written and with typing mistakes added by a seeded generator (swapped, dropped, doubled and neighbouring-key letters, lower case, filler), 95% intervals, CPU only (`docs/eval-tiny-models.json`, `scripts/eval-tiny-models.ts`):

| router | as written | with typos | per question |
|---|---|---|---|
| SmolLM2 135M / 360M | 10% / 13% | 9% / 13% | 0.5–1.2 s |
| gemma3 270M | 8% | 7% | 4 s |
| qwen2.5 0.5B | 46% | 39% | 1 s |
| llama3.2 1B | 51% | 47% | 1.5 s |
| qwen3 0.6B, one fixed example per label | 71% | 64% | 1.1 s |
| **qwen3 0.6B, nearest examples (shipped)** | **81%** [74–86] | **71%** [64–78] | 4 s |
| *the old regex + similarity router, for comparison* | *89%* | *63%* | *instant* |

So the SmolLM2 and Gemma 270M sizes cannot do this task at all (near chance for 16 labels). The shipped model is **worse than the old rules on clean wording (81% vs 89%, though that 89% includes questions the rules were tuned on) and better when the typing is bad (71% vs 63%)**, at a cost of about four seconds per question on CPU instead of microseconds. About one question in five is still read as the wrong view, which is why the reading is always shown with the other readings one click away. The retrieved examples are kept apart from the evaluation questions (a test fails if one leaks). `route-live.test.ts` runs the real model on a sample when it is installed (14/18 on its last run); everything else is tested with a scripted router, so the suite does not need Ollama.

## Background jobs (indexing and concept extraction)
Both can take minutes, so they run as jobs (C07): the call returns at once, the side panel shows what the job is doing and how far along, and **Cancel** works. Jobs wait in a queue and run one at a time (there is one parser process); they are stored, so the list survives a page reload.
- **Cancel before the result is being saved**: stops now. A model call in flight is abandoned and its answer is dropped; the parser process is ended and replaced (its in-memory parse cache goes with it, so the next index is a full parse). Nothing was written, so there is nothing to undo; concept claims are written together with the cards, in one step at the end.
- **Cancel while saving**: refused, with the reason, and the job finishes whole. Stopping then would leave half a result.
- **A server restart** marks a job it interrupted as failed ("nothing from the interrupted run was saved"). Jobs cannot resume; run them again.
- Each model call in a job gets its own deadline; before, the request that started extraction set one deadline for all chunks.
- Limits: while the repository is being hashed for the incremental pass (synchronous, bounded) a cancel waits for it to finish; the rest of the progress is phases and chunk counts, not a percentage of the parse.

## The 32 components and their acceptance ledger
Every component of `Code_Intelligence_Component_API_Contracts.md` has its acceptance suite written out as items in `docs/ledger.json`; an item is **done** only when named tests prove it (`ledger.test.ts` fails if a named test does not exist). `node scripts/status.ts -v` prints the state. At the time of writing: **165 of 167 items done, 2 blocked, 0 open**. The two blocked items are the ones whose acceptance criterion is *people*, not code: held-out labels by ≥ 8 independent experts, and a task-completion study with real participants. The machinery for both (label store, held-out split, synthetic-label rule, expert-coverage report, study analysis with intervals) is built and tested; generated data is marked synthetic and is never reported as either.

| Where | What |
|---|---|
| `packages/core/src/claims.ts`, `claim-ledger.ts` | five gates; append-only claim event ledger, lifecycle transition matrix (illegal moves are rejected), historical replay, alarm eligibility (deterministic proof or two authorised confirmations) |
| `c22/` | hypothesis and agentic investigation engine (generations, leases, steering, runtime batches, tombstones) |
| `graph.ts`, `embeddings.ts`, `retrieval.ts` | graph projection, hybrid retrieval with access policy and token budget |
| `context.ts`, `interactions.ts` | developer context stream with memory tiers and persona lenses (a lens never hides a safety fact); interaction catalogue I-01…I-20 as typed commands |
| `workspaces.ts`, `collab.ts` | event-sourced investigations (undo/redo, checkpoints, conflicts); sharing without widening access, handover with access gaps counted not shown, shared concept corrections |
| `registry.ts`, `history.ts` | stable identities across renames, splits, merges and branches; semantic change sets, archaeology, review threads that survive merges |
| `indexer.ts`, `artifacts.ts`, `connectors.ts` | change impact through reverse dependencies with a generation fence, parity with a clean index; routes, migrations, queues and flags as declarations of intent; forge connector with pagination, rate limits, credential expiry, quarantine and signed webhooks |
| `runtime.ts`, `security.ts` | runtime signals joined to code with graded exactness (missing marker, bad timestamps, sampling, reordering, revision mismatch, backpressure, replay); versioned security rules, alarm gate, invariant checks that never say "proven" |
| `defect/`, `defect-local.ts`, `scenarios.ts`, `changes.ts`, `exports.ts` | defect/performance detectors and local adapters; counterfactual scenarios; visual-intent change proposals validated in an isolated copy; evidence-faithful exports and signed webhooks |
| `evaluation.ts` | planted-failure suites, confidence-bin intervals, paired regression test between models, release gate on the model in use |
| `migrations.ts`, `events.ts`, `storage.ts`, `ops.ts`, `tenants.ts`, `access.ts`, `redact.ts` | ordered reversible migrations, transactional outbox, backup/restore/GC/deletion propagation, health and release gates, per-tenant stores, access policy |

Gateway operations are grouped by component under `/api/v1/components/{C}/{op}` (and `/api/v2/components/C22/{op}`); see `makeOps` in `server.ts`.

## Trust model (the part that is easy to get wrong)
- **Five claim checks** on every claim: *evidence* (every citation exists and is current), *consistency* (the asserted path is re-verified against the stored graph), *counter-argument* (unresolved calls, async hand-offs, missing tests, plus an adversarial model pass), *calibration* (a confidence band only after ≥20 human verdicts for that claim class — otherwise it abstains and says so), *display* (the single rule that picks Fact / Inference / Hypothesis / Withheld).
- A model-authored claim **never displays as Fact**, and your **Confirm never upgrades it to proof**. **Refute** hides it and marks everything derived from it stale.
- Model output is schema-checked and dropped if it cites evidence outside what was retrieved. Dynamic calls stay **fog**; they are never guessed.
- **Hosted models are opt-in per repository.** Until you approve, the offline model answers. When approved, secret-looking names are removed first, git history (authors, messages, commit ids) is never sent, and every send is written to a hash-chained local **audit log** (header → "Audit log").

## Run it
```
cargo build --release                 # Rust worker (tree-sitter indexer)
npm install && npm run web:build
npm start                             # http://127.0.0.1:4317 (loopback only)
./scripts_make_demo_repo.sh           # a git-backed payments app at .cie/demo/payments-app, with history
```
In the UI: **Browse…** to pick a repo → **Index** → ask. Try the demo repo with the three example prompts, then paste a stack trace (see `packages/core/test/helpers.ts` → `traceFor`). `./scripts_dev.sh [--fresh]` restarts the server.

### Models
Default: the **local Ollama daemon** serving a **remote `:cloud` model** (`gpt-oss:120b-cloud`). Offline fallback: a deterministic stub that reasons only over the graph.

| Variable | Default | |
|---|---|---|
| `CIE_PROVIDER` | `ollama` | `ollama` or `stub` |
| `CIE_OLLAMA_MODEL` | `gpt-oss:120b-cloud` | any installed model |
| `CIE_OLLAMA_THINK` | `low` | reasoning effort (`low`/`medium`/`high`/`off`); `low` keeps answers at a few seconds |
| `CIE_OLLAMA_URL` | `http://127.0.0.1:11434` | daemon address |

If Ollama is down or the model is missing, the server logs why and uses the stub (the header chip shows which is active).

### Nirdosha v2 source semantics
`.nir` always receives ordinary Rust indexing. For Nirdosha-specific declarations, install the Nirdosha-owned `nirdosha-source-ir` binary on `PATH`, or set `CIE_NIRDOSHA_SOURCE_IR=/absolute/path/to/nirdosha-source-ir`. CIE invokes it once per repository and consumes only schema `nirdosha.source-ir/1`; procedural macros are never expanded or executed during indexing. The resulting guard, role, purpose, route, store, policy, workflow, approval and capability references retain exact source evidence.

### VS Code
`extensions/vscode` sends **file path + line numbers only** (never contents) for open file, selection and breakpoints to the local server; what you are looking at then appears as an editor chip in the conversation and is pinned into your next question. Evidence cards have "Open in VS Code" links. Build with `npm run build:ext`, then "Developer: Install Extension from Location".

## Verify it
```
node scripts/status.ts -v   # the acceptance ledger
npm test          # Rust worker tests + the TypeScript tests (incl. real-browser keyboard and accessibility-tree tests; they need /usr/bin/google-chrome-stable and skip without it)
npm run eval      # the six-point MVP demo bar, as an executable gate, with the real configured model
```
`npm run eval` checks all six demo steps, median synthesis time (< 10 s), and **zero silently-wrong provenance**: every displayed edge and node is re-checked against stored evidence (a "calls" edge's evidence must actually mention the callee; nothing shown as Fact may be backed by a claim; every inferred element must have gone through all five checks).

Measured here: every visual passes the provenance audit; all six demo steps pass with `ollama/gpt-oss:120b-cloud`, 0 provenance violations, map questions in ~3 s (hosted) / ~30 ms (offline); a real 32k-line repo indexes in 0.7 s.

## Layout
- `crates/worker` — Rust: tree-sitter parsing for TypeScript, Rust, and Rust-dialect Nirdosha v2 `.nir`; cross-file resolution, throw/write/transaction/async-topic facts, Nirdosha screen macros, test symbols, and git history. Length-prefixed JSON over stdio.
- `packages/schema` — contract types and the registry of model-output schemas.
- `packages/model` — provider interface, schema-checking gateway, Ollama provider, offline stub.
- `packages/core` — SQLite store, idempotent journal, salience, claim gates, conversation router (a small local model), egress policy, audit, HTTP gateway, demo-bar eval. `src/forms/` has one builder per visual (shared analysis in `analysis.ts` and `common.ts`); `src/visuals.ts` is the catalogue of visuals, `src/llm-router.ts` reads a question with the local router model; `src/gitinfo.ts` reads history, authors, CODEOWNERS and comments.
- `apps/web` — React + cytoscape: canvas, conversation, claim cards, concept browser, visuals gallery, terrain view, folder picker. `src/graph.ts` holds the testable view logic (zoom, verdicts, aggregation); `src/layout.ts`, `src/arrange.ts` and `src/layoutmetrics.ts` hold the layout algorithms, the per-view algorithm choice and the quality metrics.
- `extensions/vscode` — the editor bridge.

## What is not verified or not done (honestly)
- The **VS Code extension** is type-checked and its logic unit-tested, but has **not been run inside a real VS Code**; the server side is tested end to end with simulated events.
- **Accessibility** was checked with an automated axe-core audit (0 violations on the empty app, maps, explanations with claim cards and code, the outline, concept browser, the visuals gallery, and the journey, counterfactual, ownership, policy and terrain views) and by computing every colour pair (all ≥ 4.5:1 in both themes). There has been **no real screen-reader testing and no trackpad testing** (pinch-zoom is only exercised through the browser's wheel events), and automated audits catch only part of what matters. In the swim-lane forms a transaction bracket is shown as a double border on the node, not a surrounding box, because a node can have only one parent.
- **Calibrated confidence** needs human verdicts; with none, every claim says "not estimated". The spec's reviewer study (≥8 experts, ≥60% preferring it) is a human study and has not been run.
- **Visual-specific limits:**
  - V4 follows the order calls appear in their caller's source. Conditions, else branches, loops and retry loops are read from the source's structure and marked on the step; whether a branch is taken or how often a loop runs is not known.
  - V5 files reads and writes by `receiver.field` where the receiver is written in the code, so two fields with the same name on different receivers are kept apart; two instances of one class, or a field reached through an alias, are still one.
  - V6 compares the text of each symbol between two *indexed* revisions, so a pure variable rename counts as a change, and it needs the earlier revision to have been indexed.
  - V7 uses commits and code comments only in the UI. A forge connector (`connectors.ts`) can read pull requests and C23 archaeology quotes them, but it is an API, not yet a screen, and issues/tickets/incidents have no connector.
  - V9 shows recorded exceptions, tests, trace exports and attributed runtime envelopes. Open **Replay recorded runtime** to choose a local-time window, scrub or play/pause cumulative span observations, and highlight observed/error nodes while preserving the map. Replay uses ingested C24 envelopes (Insights → Runtime); indexed aggregate trace exports and pasted exceptions are not replayable. Sampling and attribution gaps remain visible. There is no live daemon, comparison of two windows, or automatic zoom morphing.
  - The map footer summarizes Fact/Inference/Hypothesis/Fog display categories and stale elements; these percentages are not confidence scores. **High contrast** in the header persists a locally stored preference and updates the canvas palette too.
  - V10 reads no locks, queues or scheduler settings; V11 simulates only removal, not moving, merging or making code asynchronous.
  - V12 has line coverage only (no branch coverage, flakiness or mutation resistance); "semantic" gaps are judged from test names and files.
  - V13 has no review latency, on-call or ticket data; V14 needs concept cards extracted for the *current* revision.
  - V16 cannot yet plan a route across the terrain or compare terrains over time.
- **Exceptions** arrive from a pasted trace or from `@cie/reporter` in a Node or browser app. OpenTelemetry-style spans can be posted to the C24 API; Java, Python and Go stack traces (and Node's) are parsed and mapped onto the repository's files, including traces from a deployed copy under another path. Coverage and test results are read from files the project's own tooling produced earlier (stale ones are flagged); nothing is run.
- Static analysis supports **TypeScript, Java (incl. Spring Boot), Go, Python, Rust, and Rust-dialect Nirdosha v2 `.nir`**. Java, Go and Python resolve imports, same-package references and calls through a *declared* receiver type (Java fields/parameters, Go receivers and typed struct fields, annotated Python parameters); interface-typed calls resolve to the interface's declaration, never to one implementation, and anything without a stated type (`getattr`, maps of functions, untyped Python attributes, generics, reflection, Spring bean wiring by name) stays fog. Spring `@Transactional`, `@KafkaListener`/`@RabbitListener`/`@JmsListener`, template sends and `@*Mapping` routes, Flask/FastAPI decorators, `net/http` and gin/chi handlers, JUnit/`go test`/pytest tests are recognised. The defect, performance, lifecycle and security-rule detectors read **TypeScript, Rust, Java, Go and Python**: lock-order inversions (Java `ReentrantLock`/`synchronized`/`readLock()`, Go `sync.Mutex` with `defer`, Python `with lock:`/`acquire`), one-query-per-element loops and comprehensions, I/O under a lock, unclosed streams/files/connections/response bodies/tickers/thread pools/locks, secrets in logs (including f-strings and `${}`), and state changes reachable without an authorisation check (`@PreAuthorize`, `@login_required`, `requireAuth(...)` are understood as guards). Lock names are scoped to their class, package or module. Real tools back them up on reviewed sources: `go test -race`, the JVM's own deadlock report via `jcmd`, and a Python `faulthandler` hang watchdog. Not covered: Kotlin/Scala, Java/Go/Python data-race detection beyond what `go test -race` shows, taint flow (a secret reaching a log through a variable that is renamed), framework-level authorisation configured outside the code (a Spring `SecurityFilterChain`, gateway rules), and Python's GIL-hidden races. As everywhere, no finding is not safe. Java build files, Go modules and Python virtualenvs are not read (`vendor`, `venv`, `__pycache__`, `.gradle` are skipped). Earlier text on Rust: Rust/Nirdosha resolves crate/self/super and `#[path]` modules plus direct imported/same-file calls; trait dispatch, generic resolution, macro expansion, and calls through values remain fog. The retired native Nirdosha language is intentionally unsupported. Async joins currently apply to TypeScript literal topic strings.
- Hosted-model answers vary between runs; the gates, not the model, decide what is displayed. The new forms are deterministic and do not use the model at all.
- Wheel-driven zoom was verified with dispatched wheel events and the stepper with clicks, not a physical trackpad.
- Indexing hashes every file each time and re-parses only what changed. **Parser memory grows with the repository (about 0.2 MB per file; 1,500 files peaked at ~290 MB)**. It is not streamed: the bound is an enforced ceiling (`CIE_WORKER_RSS_MB`, default 2048) that fails an over-large index cleanly and saves nothing. Untested near 500 kLOC.
- **Identity**: the local UI is single-user. Tenancy (a database and parser per tenant, a trusted-transport identity hook), per-principal source access and sharing are implemented and tested, but the web UI has no sign-in and does not yet expose sharing, handover, security findings or the evaluation registry.
- **Fixtures are authored, not captured.** The forge-connector exchanges follow the documented list-pulls contract (Link pagination, rate-limit headers, 401/429/5xx) but were written by hand: capturing them needs a real account. The security rules are small and have known blind spots (an aliased logger evades the PII-in-logs rule; the evaluation suite measures this).
- **Real-world checks that automation cannot give**: a real screen-reader session, the VS Code and JetBrains extensions inside the real IDEs, and the two human studies above. What *is* automated: a headless Chrome driven over the DevTools protocol completes a whole investigation with keyboard events only (the page counts pointer events: zero) and the browser's computed accessibility tree is asserted for names, roles, live regions and per-element state in words.
