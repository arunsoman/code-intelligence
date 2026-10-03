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

The forms that place their own elements (journey, lineage, diff, archaeology, trust, race, counterfactual, ownership, atlas, policy) keep their layout; level of detail applies to the maps (V1–V3, V9, V12).

## Zoom, concepts, signals and keyboard
Semantic zoom, **L0–L6**: **L0 system** (the whole thing as one node, with the external packages it depends on) → **L1 domains** (intermediate abstractions the model proposes over the concepts; each is a claim that must be grounded, and when none exist L1 falls back to concepts rather than inventing one) → **L2 concepts** → **L3 files** → **L4 key symbols** → **L5 all symbols** → **L6 detail** (roles, notes, edge labels; double-click for the code). Levels change after a zoom settles (with different enter/exit thresholds, so they never flicker). Choosing a level with the stepper or in chat fits the view to it; zooming by gesture never moves the camera. Selection and identity survive every level.

**Concept cards** are a versioned store: every extraction is an immutable version, with a diff against the previous one. You can judge each card (Confirm / Dispute / Refute); a refuted card stops influencing ranking, and the model's own "high/medium/low" is compared against your verdicts so you can see whether it means anything (it abstains until ≥5 are judged).

**Runtime and test signals.** Paste a stack trace, or let a running app report exceptions with `@cie/reporter` (`installReporter()`); they land in an **Exceptions** inbox (repeats collapse into one entry with a count) and make the code they touch hotter in ranking. Traces from Node/Chrome, Firefox/Safari, async and constructor frames, browser dev servers (Vite/webpack, `file://`, Windows paths) are parsed; frames map to code by line and fall back to the function name. Coverage (lcov, Istanbul JSON) and test results (JUnit XML, Jest/Vitest JSON) found in the repository are attached to symbols as evidence; failing tests and low coverage appear as counter-arguments and make the code they exercise hotter. **Pin / Boost / Demote** any element (drawer buttons, or "pin X" / "boost X" / "demote X" / "reset X" in chat); overrides persist per repository.

**Keyboard and screen readers.** The canvas is one tab stop: arrow keys move between elements (an announcement says what each is, how it is known, and how many links it has), Enter inspects, Space selects, E opens the code, +/− change the level, O opens a **text outline** that lists every element and link in words, Escape clears the selection. Nothing relies on colour alone.

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
npm test          # Rust worker tests + 108 TypeScript tests
npm run eval      # the six-point MVP demo bar, as an executable gate, with the real configured model
```
`npm run eval` checks all six demo steps, median synthesis time (< 10 s), and **zero silently-wrong provenance**: every displayed edge and node is re-checked against stored evidence (a "calls" edge's evidence must actually mention the callee; nothing shown as Fact may be backed by a claim; every inferred element must have gone through all five checks).

Measured here: every visual passes the provenance audit; all six demo steps pass with `ollama/gpt-oss:120b-cloud`, 0 provenance violations, map questions in ~3 s (hosted) / ~30 ms (offline); a real 32k-line repo indexes in 0.7 s.

## Layout
- `crates/worker` — Rust: tree-sitter parsing for TypeScript, Rust, and Rust-dialect Nirdosha v2 `.nir`; cross-file resolution, throw/write/transaction/async-topic facts, Nirdosha screen macros, test symbols, and git history. Length-prefixed JSON over stdio.
- `packages/schema` — contract types and the registry of model-output schemas.
- `packages/model` — provider interface, schema-checking gateway, Ollama provider, offline stub.
- `packages/core` — SQLite store, idempotent journal, salience, claim gates, conversation router, egress policy, audit, HTTP gateway, demo-bar eval. `src/forms/` has one builder per visual (shared analysis in `analysis.ts` and `common.ts`); `src/visuals.ts` is the catalogue that picks a form from a question; `src/gitinfo.ts` reads history, authors, CODEOWNERS and comments.
- `apps/web` — React + cytoscape: canvas, conversation, claim cards, concept browser, visuals gallery, terrain view, folder picker. `src/graph.ts` holds the testable view logic (layouts, zoom, verdicts).
- `extensions/vscode` — the editor bridge.

## What is not verified or not done (honestly)
- The **VS Code extension** is type-checked and its logic unit-tested, but has **not been run inside a real VS Code**; the server side is tested end to end with simulated events.
- **Accessibility** was checked with an automated axe-core audit (0 violations on the empty app, maps, explanations with claim cards and code, the outline, concept browser, the visuals gallery, and the journey, counterfactual, ownership, policy and terrain views) and by computing every colour pair (all ≥ 4.5:1 in both themes). It has **not been tested with a real screen reader**, and automated audits catch only part of what matters. In the swim-lane forms a transaction bracket is shown as a double border on the node, not a surrounding box, because a node can have only one parent.
- **Calibrated confidence** needs human verdicts; with none, every claim says "not estimated". The spec's reviewer study (≥8 experts, ≥60% preferring it) is a human study and has not been run.
- **Visual-specific limits:**
  - V4 follows the order calls appear in their caller's source; loops, branches and retries are not modelled.
  - V5 matches reads and writes by field *name*, so two unrelated fields with the same name are conflated.
  - V6 compares the text of each symbol between two *indexed* revisions, so a pure variable rename counts as a change, and it needs the earlier revision to have been indexed.
  - V7 uses commits and code comments only; pull requests, tickets and incident records are not connected.
  - V9 is reported data, not live telemetry: there are no latencies, rates, queue depths or sampling information, no time scrubber beyond the window buttons, and no comparison of two windows.
  - V10 reads no locks, queues or scheduler settings; V11 simulates only removal, not moving, merging or making code asynchronous.
  - V12 has line coverage only (no branch coverage, flakiness or mutation resistance); "semantic" gaps are judged from test names and files.
  - V13 has no review latency, on-call or ticket data; V14 needs concept cards extracted for the *current* revision.
  - V16 cannot yet plan a route across the terrain or compare terrains over time.
- **Exceptions** arrive only from a pasted trace or from `@cie/reporter` in a Node or browser app; there is no tracing/OpenTelemetry ingestion, and a trace from a language other than TypeScript is not mapped. Coverage and test results are read from files the project's own tooling produced earlier (stale ones are flagged); nothing is run.
- Static analysis supports **TypeScript, Rust, and Rust-dialect Nirdosha v2 `.nir`**. Rust/Nirdosha resolves crate/self/super and `#[path]` modules plus direct imported/same-file calls; trait dispatch, generic resolution, macro expansion, and calls through values remain fog. The retired native Nirdosha language is intentionally unsupported. Async joins currently apply to TypeScript literal topic strings.
- Hosted-model answers vary between runs; the gates, not the model, decide what is displayed. The new forms are deterministic and do not use the model at all.
- Wheel-driven zoom was verified with dispatched wheel events and the stepper with clicks, not a physical trackpad.
- Indexing re-reads everything each time; fine at tested scale (32 kLOC in 0.7 s), untested near 500 kLOC. No authentication (single local user).
