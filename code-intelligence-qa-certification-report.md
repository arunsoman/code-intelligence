# QA Certification Report — arunsoman/code-intelligence

> Pre-release certification run: adversarial, reproduction-gated, duplicate-checked.
> Part 1 is the certification report; Part 2 contains 8 ready-to-file GitHub issue drafts
> (issue creation was blocked in the test environment — no credentials — so each draft below
> is final-form text: paste the title into GitHub, copy the body verbatim).


---


# Part 1 — Certification Report


**Commit tested:** `5ec061b5f4e8528b46a1aeca932766dd807e6bb3` (main, "fix(deps): make the Maven comparator a total order and unbreak the purl test")
**Date:** 2026-10-05 · **Tester:** adversarial QA certification run

## Environment

| Piece | Version / detail |
|---|---|
| Node | v24.21.0 |
| Rust | cargo/rustc 1.99.0 (installed for this run) |
| Ollama | v0.12.6 (local tarball install, loopback :11434) |
| Model | the selected local model (router + synthesis; `CIE_PROVIDER=ollama`) |
| Browser | Playwright Chromium 143.0.7499.4, viewport 1440×900 (headless) |
| OS | Linux x86_64, 4 GB RAM sandbox |
| Repos indexed | CIE itself (462 files) and `.cie/demo/payments-app` (14 files) |

## LLM Quality Gate — PASS (7/7)

| Gate item | Result |
|---|---|
| Ollama installed | PASS — v0.12.6, local tarball (sudo install refused; tarball was the documented remediation) |
| Ollama service running | PASS — `GET /api/version` → 200 |
| Minimal model installed | PASS — the selected local model (522 MB) |
| Direct model invocation | PASS — `/api/generate` `done_reason: stop` |
| Code Intelligence configured for Ollama | PASS — server log: `model: ollama/<selected model>; router: the selected model` |
| Application can reach Ollama | PASS — `/healthz` model check: "ollama/<selected model>: no recent failure" |
| Real UI → Backend → Ollama → UI round trip | PASS — UI ask produced `route.source: "model"` views; ~10–20 s synthesis latency observed; one transient `PROVIDER_UNAVAILABLE` degraded honestly to deterministic facts with a visible Note |

## Numbers

| Metric | Count |
|---|---|
| Capabilities exercised (capability-map rows) | 46 |
| Browser scenarios executed | 31 |
| API scenarios executed | 21 (+ 8 follow-up verifications) |
| Automated tests executed | full worker Rust suite (44) + TypeScript core/model/web/reporter suites (several hundred; browser-e2e subset skipped without chrome-stable) |
| Defects discovered | 8 (7 new-defect candidates + test-suite failure cluster) |
| New GitHub issues created | **0 — BLOCKED (no GitHub credentials in this environment; 8 ready-to-file drafts prepared)** |
| Duplicates found during detection | 3 candidates re-classified after search (#12, #42, closed #48/#52) |
| Defects not filed | see table below |

## Defect table

| # | Severity | Component | Defect | Reproduction | Evidence | Draft |
|---|---|---|---|---|---|---|
| 1 | **High** | Web UI / Profiles | Clicking **Profiles** blanks the entire app (React crash; server returns bare array for `C04/listProfileArtifacts`, panel reads `.artifacts` off it) | 3/3 | uncaught errors "reading 'find'"/"reading 'length'"; `#root` emptied; screenshots 41-* | `issues/01` |
| 2 | **Medium-High** | Retrieval / V1 | "Give me an overview of the whole project" collapses to the 2 functions named `project` (Fog, 0 edges) on a 462-file repo; 453 candidates left out | 4/4 API, 1/1 UI | ask JSON, `STOP` word list + seed logic in `retrieval.ts` | `issues/02` |
| 3 | **Medium** | Router / converse | Misread-as-overview answers with a map captioned for a question the user never asked (hard-coded `"Give me an overview of the whole project"`); turn looks silently ignored | 4/4 API, 3/3 UI | converse response bodies, `service.ts` overview branch | `issues/03` |
| 4 | **Medium** | Canvas fit / a11y | After automatic fit, a node can be 94 % clipped below the canvas (2.7 of 47 px visible) with no off-screen notice (counter sees only fully-hidden elements) | 2/2 | renderedBoundingBox measurements, screenshot 25 | `issues/04` |
| 5 | **Medium** | Canvas a11y | Clicking the canvas does not focus it (Cytoscape mousedown preventDefault) — arrow navigation silently dead until Tab | 3/3 | `document.activeElement === BODY`; announcement works after explicit focus | `issues/05` |
| 6 | **Low-Med** | Gateway / API | Wrong-type request bodies → `500 STORAGE_FAILURE (retryable)` instead of 400 (C19/ask, C24/reportException); oversized body → TCP reset, no 413 | 2/2 each | curl transcripts in draft | `issues/06` |
| 7 | **Low** | Web UI / console | Cytoscape mapping-warning spam per node per render (`pie-1/pie-2-background-size` on generic `node` selector) | every render | console transcripts, `Canvas.tsx:93` | `issues/07` |
| 8 | **High (repo health)** | Tests | `npm test` red on clean checkout: Rust incremental-reuse test fails 3/3 in suite (passes 3/3 solo; global parse-cache interference) + `task-flow` FORBIDDEN-vs-PROVIDER_UNAVAILABLE disagreement + `profile-flow` MISMATCH (env-sensitive) | 3/3, 2/2, 2/2 | npm-test.log, ts-test.log, index.rs:1022, execution.ts:983 vs task-flow.test.ts:407 | `issues/08` |

## Coverage table

| Component | Coverage | Result | Notes |
|---|---|---|---|
| Server start / healthz | full | PASS | DB schema v32, parser, model, disk checks |
| Ollama integration (router + synthesis) | full | PASS | 7/7 gate; misroutes themselves tracked as #12-class |
| Repository browse / index (small + large) | full | PASS | 14-file and 462-file indexes; delta/unchanged fast path observed |
| Background jobs (concepts) | full | PASS | enqueue → SUCCEEDED; Idempotency-Key dedup returned stored job |
| Conversation ask (16 forms sampled via gallery + router) | high | PASS with defects #2/#3 | explanations, claim cards, "N candidates left out" honesty |
| Stack trace → HypothesisGraph | full | PASS | correct suspect mapping, "✓ Supported" flag, six-factor text |
| Selection → "these" → explanation | full | PASS | claim card, evidence cards, 5-checks link, verdict buttons |
| Semantic zoom V1 (quantitative) | full | PASS | hysteresis <10px coarser / >16px finer, re-fit to 11.5px, zero off-screen, cycles stable |
| Semantic zoom V2/V3 (stepper presence) | sampled | **Doc drift** | README promises levels for V1–V3/V9/V12; V2/V3 render no stepper → covered by existing open issue #42, not filed |
| Canvas fit / off-screen notice | targeted | **FAIL** | defect #4 |
| Keyboard & screen-reader affordances | targeted | **FAIL** | defect #5; arrow announcements excellent once focused |
| Header panels (9) | full | 8/9 PASS | Profiles = defect #1; Tasks/Campaigns/Insights/Investigations/Audit log/Hotspots/Defects/PR render healthy |
| Hotspots (C26) | full | PASS | 45 commits, 50 ranked files, excluded-commit ledger shown |
| Exceptions inbox (C24) | full | PASS | repeats collapse (2×), Investigate/Dismiss present |
| Concept extraction + catalogue gating | full | PASS | needs-two-revisions / needs-exceptions states honest |
| Search (Ctrl+K) | partial | PASS (open, mode UI) | results execution covered by API suite instead |
| API gateway adversarial | full | 17/21 strict | defect #6; traversal/dns-rebind/idempotency/concurrency all held |
| Double-click Send / refresh mid-synthesis / rapid context switch | full | PASS | disabled-button guard; clean restore after reload |
| High contrast, persistence | full | PASS | aria-pressed set; conversation restored server-side |
| Repo test suite (`npm test`) | full | **FAIL** | defect #8 |
| Un-tested | — | — | VS Code extension in real IDE (documented gap, #39); hosted `:cloud` model (refused by design offline); real trackpad/screen reader (documented, #39); `npm run eval` demo bar (needs stable hosted model); V16 terrain weights UI, Replay runtime (needs ingested envelopes) |

## Blockers

1. **GitHub issue creation impossible from this environment.** No `gh` CLI, no `GITHUB_TOKEN`/`GH_TOKEN`, no credential helpers (`~/.git-credentials`, `~/.netrc`, `~/.config/gh` absent), and `api.github.com` unauthenticated core quota is 0 from this shared IP. Issue creation requires authenticated POSTs by GitHub API design. **Remediation:** set `GITHUB_TOKEN` (repo scope) in the environment, then file each draft with `gh issue create --title "$(head -1 draft)" --body-file <(tail -n +2 draft)` or via the API — drafts are final-form text.
2. Ollama default `gpt-oss:120b-cloud` refused by design (hosted); all model testing used the documented local fallback model. No blocker for the gate.

## Defects investigated and NOT filed (with reasons)

| Observation | Reason not filed |
|---|---|
| "Why are these connected?" answered with a single-element why-shown explanation | Router misread → existing open issue #12 (router accuracy); graceful cited answer given |
| Transient `PROVIDER_UNAVAILABLE` during synthesis | Degrades honestly with a visible Note and deterministic facts (by design) |
| Cytoscape wheel-sensitivity console warning | Explicit config choice, library advisory |
| V2/V3 lack level steppers despite README | Documentation drift → existing open issue #42 |
| DP05/DP06/DP14 TS test failures; Go/Java adapter catalogue failure | Toolchain-dependent in this sandbox (go, loom fetch, tsan, sandbox privs); accounted in issue draft 08 |
| Insights "56 symbols" class stale-revision quirks | Already fixed upstream (#50 closed); current builds restore correctly |

## Remaining high-risk areas

- The F05 profile surface: UI crash (#01 draft) + `profile-flow` test MISMATCH + existing open gaps (#71, #72) suggest the vertical is the least-integrated slice.
- Retrieval seed semantics (`queryTerms`/`STOP`): the name-collision failure (#02 draft) generalizes to any question word that is also an identifier; other question forms inherit it via `converse`.
- The global parse cache (`PARSE_CACHE` keyed by relative path) is correct for content-addressed parsing but leaks state across calls in ways tests (and possibly long-running servers with multiple repos) assert on — see #08 draft.

**Bottom line:** the core product (indexing, claims, provenance, semantic zoom, hotspots, investigations, API contract enforcement) is solid and unusually honest about gaps; the failing `npm test`, the Profiles crash, and the overview/name-collision collapse are the three findings that most need upstream attention before a release.


---


# Part 2 — Ready-to-File Issue Drafts (8)


Each draft below was deduplicated against all 78 open/closed issues in the repository
before drafting, and reproduced at least twice (rates noted inside each draft).
Labels use the repository's existing label set. Suggested file order: 01, 08 first
(highest impact), then 02, 03, 04, 05, 06, 07.


---


## Draft 01 — `01-profiles-panel-blanks-app.md`

**Title (for the GitHub issue title field):** Opening the Profiles panel blanks the entire app (React crash; C04/listProfileArtifacts returns an array, the panel reads `.artifacts` off it)


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
Clicking **Profiles** in the header unmounts the whole React tree. The page becomes empty (`#root` has no children), every other header button disappears, and the only recovery is a full page reload. Two uncaught errors reach the console, both from the same render.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main), local Ollama `ollama/<selected model>`, DB schema v32
- Chromium 143 (Playwright), viewport 1440×900, Linux
- One repository indexed (462 files); happens with the demo repository too

Steps to reproduce
1. Start the server (`npm start`), open http://127.0.0.1:4317, index any repository.
2. Click **Profiles** in the header.
3. The page goes blank.

Expected
The profile panel opens (empty state: "Nothing imported yet…").

Actual
The entire app unmounts. `document.querySelector('#root').children.length === 0`; body text length 0. Uncaught page errors:

```
Cannot read properties of undefined (reading 'find')
Cannot read properties of undefined (reading 'length')
```

Reproducibility: 2/2 fresh sessions (and once more in a panel sweep, 3/3 total).

Where it comes from
The gateway returns the artifact list as a bare array, and the panel reads a property that does not exist on it:

```
$ curl -s -X POST .../api/v1/components/C04/listProfileArtifacts -d '{}'
{"ok":true,"value":[], ...}          # value is an array
```

`apps/web/src/ProfilePanel.tsx` (the mount effect):

```ts
const r = await call<{ artifacts: ArtifactView[] }>("C04", "listProfileArtifacts", {});
if (live.current && r.ok) { const a = (r.value).artifacts; setArtifacts(a); ... }
```

`r.value` is the array itself, so `a` is `undefined`; the first render that reads `artifacts.length === 0` (ProfilePanel.tsx:132) throws "reading 'length'", and `artifacts.find(...)` (ProfilePanel.tsx:105) throws "reading 'find'". `profiles-analysis.ts` `listArtifacts()` returns `ProfileIngestView[]` directly, so the two sides disagree on the wrapper. React unmounts the tree because the throw happens during render.

Suspected fix (one side or the other, not both): return `{ artifacts }` from the op, or use the array as-is in the panel. The same wrapper mismatch should be checked for the sibling profiling ops (`queryHotspots`, `profileEndpoints`, `compareProfiles`).

Impact
The only entry point to the F05 profile workflow (import, hotspots, correlation, comparison) is a button that destroys the session. Any user who clicks it once loses the map, the conversation and any unsaved investigation state.
````


---


## Draft 02 — `02-overview-name-collision.md`

**Title (for the GitHub issue title field):** An overview question collapses to the two functions whose name collides with a word of the question — "Give me an overview of the whole project" shows 2 of 462 files


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
"Give me an overview of the whole project" produced a map with exactly two isolated Fog nodes: the two functions in the repository literally named `project` (`crates/worker/src/regexfind.rs#project`, `packages/core/src/graph.ts#project`). On a 462-file repository the overview shows 0.4 % of the code, no edges, and both nodes are Fog. The same question on the 14-file demo repository — which happens to contain no `project` identifier — shows 16 symbols. Which code an overview shows therefore depends on an accidental identifier collision.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main), `ollama/<selected model>`
- Chromium 143, viewport 1440×900; repository: code-intelligence itself (462 files, rev `wt-c9d0379b94b41b5d`)

Steps to reproduce
1. Index a repository that contains a function named `project` (code-intelligence itself qualifies).
2. Ask: *Give me an overview of the whole project.*
3. The map shows two nodes labelled "project"; the footer counts "453 candidate(s) left out".

Expected
An overview is scoped to the whole repository (as on the demo repository: 16 relevant symbols, layered groups). A word like "project" in the question must not become the filter that decides what the overview contains.

Actual
Response (4/4 identical via the API):

```
caption: 2 symbols relevant to "Give me an overview of the whole project".
nodes: n:function:crates/worker/src/regexfind.rs#project  (display: FOG, members: 0)
       n:function:packages/core/src/graph.ts#project      (display: FOG, members: 0)
edges: 0        hidden: "dropped to fit the evidence budget for the model" (…)
```

Reproducibility: 4/4 API calls, 1/1 UI session; 0/4 on the demo repository (no `project` identifier there).

Where it comes from
`packages/core/src/retrieval.ts`:

- Line 11 — the stop-word list has no entry for "project" (nor "overview", "whole", "give"), so `queryTerms("Give me an overview of the whole project")` yields `["give","overview","whole","project"]`.
- `retrieveForQuestion` seeds candidates by `TASK_MATCH > 0`. Only the two `project` functions match any question word, so they are the only seeds; nothing else is retrieved.
- The isolation demotion ("isolated: nothing calls it and it calls nothing, so a name match alone counts for less", ×0.55) is gated on `connectedSeedExists` — with no connected seed it never fires, so the two Fog functions keep the top of the ranking.

`view.hidden` shows the rest of the map was dropped for the evidence budget, not because it was irrelevant. Related surface: the conversational `overview` branch (service.ts `converse`, `case "overview"`) hard-codes this exact question text (see my companion issue about the hard-coded overview caption), so the same collapse also powers "overview" readings of other questions.

Impact
On any repository that happens to have an identifier named after a common English word in a question ("project", "test", "run", "main", "overview"), the flagship first question a newcomer asks returns a near-empty map of fog. The honesty scaffolding around it (counts, "candidates left out") is correct, but the result defeats the purpose of the view, and it varies by accident of naming rather than by repository size or structure.
````


---


## Draft 03 — `03-overview-hardcoded-caption.md`

**Title (for the GitHub issue title field):** A question misread as "overview" answers with a map captioned for a question the user never asked, so the turn looks ignored


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
When the router model reads a question as the conversational intent `overview`, the server builds the map from the hard-coded question text *"Give me an overview of the whole project"* and returns that as the answer. The view therefore carries a caption quoting a question the user did not ask, and — when the current view is already the overview — the map does not change at all. The user sees their question disappear with no visible effect and no indication of what happened.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main), `ollama/<selected model>`
- Chromium 143, viewport 1440×900; repository: code-intelligence itself (462 files)

Steps to reproduce
1. Index a repository; ask *Give me an overview of the whole project* (or simply have any view open).
2. Ask: *Show me how authentication works.*
3. Observe the caption above the map and the map itself.

Expected
Either the reading is what the user asked (an intent-relative map of authentication), or the visible answer states what was read and shows it — the way view readings do ("I read this as: … the selected model read this as …", with alternative readings one click away).

Actual
4/4 identical runs (C15/converse, temperature 0):

```
kind: "view"
caption: 2 symbols relevant to "Give me an overview of the whole project".
route.because: the selected model read this as "SemanticMap" …
assistant message: "You asked about the project as a whole. …"
```

The assistant message does say "You asked about the project as a whole", so the reading is disclosed once in the conversation — but the view's caption and `view.question` quote text the user never typed, the map is unchanged from the previous overview, and there are no alternative-reading buttons to recover with one click. In the browser the whole turn is easy to read as "the app ignored my question" (observed 3/3 UI sessions; during one of them a transient `PROVIDER_UNAVAILABLE` note also appeared, which is separate and handled honestly).

Where it comes from
`packages/core/src/service.ts`, `converse()`:

```ts
case "overview": return overview("You asked about the project as a whole.");
```

and `overview()` calls

```ts
const r = await this.ask(ctx, { question: "Give me an overview of the whole project", revision: rev.id, seeds, level: 1 });
```

so the user's own words never reach the view; `ask()` re-routes the hard-coded text through the router and stores the resulting route/caption on the view. The view id is `hash(rev.id, question)`, so on the already-overview state the returned view is byte-identical to the open one. Suggested direction: keep the user's question in `view.question` (the overview branch can pass the real text through and only use the seeds/level), or render the reading disclosure with alternative readings the way misread view forms do.

Related
The underlying misread ("Show me how authentication works" → overview intent) is router accuracy (#12). This issue is about what the product does *after* a misread: it replaces the user's words with its own in the visible record.

Impact
The first example question in the README ("Show me how authentication works") is the easiest way to hit this on a repository without `authentication` identifiers. Combined with the overview collapse (companion issue), the user gets a 2-node fog map captioned with a question they did not ask — the product's own "nothing is guessed, everything is attributed" bar is visibly not met by this turn.
````


---


## Draft 04 — `04-partial-clip-no-notice.md`

**Title (for the GitHub issue title field):** After the automatic fit, a node can be almost entirely outside the canvas (94 % clipped) with no "off-screen" notice, because the counter only sees fully hidden elements


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
On the L1 overview of a 462-file repository, one of the two drawn nodes is cut by the canvas bottom edge: only 2.7 px of its 47 px box is visible. The "N of M elements off-screen — Bring into view" notice does not appear, because the visibility check counts only elements whose box is *entirely* outside the viewport. A node that is 94 % invisible produces no hint, and the user sees an unexplained sliver behind the evidence footer.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main), `ollama/<selected model>`
- Chromium 143, viewport 1440×900 (canvas 740×529), repository: code-intelligence itself (462 files, rev `wt-c9d0379b94b41b5d`)

Steps to reproduce
1. Index code-intelligence itself; ask *Give me an overview of the whole project* (or open the L1 overview any other way).
2. Look at the bottom edge of the canvas, behind the "Evidence status" bar.

Expected
After a fit, every drawn element is either fully inside the viewport with a small margin, or counted by the off-screen notice with "Bring into view". A sliver of a node is neither.

Actual (measured, not eyeballed)
Rendered bounding boxes against the canvas height (529 px), read from the live Cytoscape instance right after the landing fit:

```
node                              top      bottom   visible
agg:dir:crates/worker/src         241.0    288.0    47/47 px
agg:dir:packages/core/src         526.3    573.3      2.7/47 px   (44.2 px clipped, 5.7 % visible)
```

Off-screen notice: absent ("0 of 2" by the current definition); screenshot attached. Reproduced 2/2 sessions with the same revision.

Where it comes from
- `apps/web/src/Canvas.tsx` `refresh()`: `const boxes = …renderedBoundingBox(); const v = visibility(boxes, c.width(), c.height())` — and `visibility()` (graph.ts) counts an element as off-screen only when its box is entirely outside. A partial clip of any size is invisible to the counter.
- The camera-side counterpart is the fit path (`fitReadable`/fit anchoring, the same area that issue #48 fixed for level changes): the clamp keeps text readable but nothing re-checks afterwards that the fitted bounding box is fully inside with a margin.

This is the residual gap behind the closed issues #48 ("new levels can land outside the viewport") and #52 ("triggers the off-screen notice"): the notice itself now exists, but its definition of "off-screen" (fully hidden) misses the case where most of an element is off-screen. A threshold (for example "less than half the box visible ⇒ counted") would close the gap without re-introducing #52's noise.

Impact
With two nodes the map looks broken but salvageable-by-luck (the second node is easy to miss entirely); with denser graphs the same blind spot hides arbitrary amounts of content at every level without any affordance to bring it back.

Attachment
`25-overview-large-repo.png` (node sliver behind the footer).
````


---


## Draft 05 — `05-canvas-click-no-focus.md`

**Title (for the GitHub issue title field):** Clicking the canvas does not move focus to it, so arrow-key navigation silently does nothing until the user presses Tab


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
The canvas advertises "The canvas is one tab stop: arrow keys move between elements…". Tab does land on it, but a mouse click does not — after clicking the map, `document.activeElement` is still `BODY`, and pressing the arrow keys does nothing, with no indication that keyboard navigation is inactive. The cause is Cytoscape's own `mousedown` handling preventing the default focus, so the host div's `tabIndex` never engages on click.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main)
- Chromium 143, viewport 1440×900; any map (Failure-space map used)

Steps to reproduce
1. Open any map.
2. Click once on the canvas (on empty space or a node).
3. Press ArrowRight / ArrowDown.

Expected
The canvas is one tab stop, and the natural mouse-then-keyboard sequence works: clicking the map moves focus to it (browsers do this for elements with `tabindex`), and the arrows start moving between elements with the announcement.

Actual
`document.activeElement` remains `BODY` after the click; arrow presses produce no announcement and no visual change. After an explicit `host.focus()` (or a Tab press) the same keys work immediately, announcing e.g. *"charge, step, fog, some calls unresolved, 6 outgoing and 1 incoming links, not selected"*. Reproduced 3/3 attempts.

Where it comes from
`apps/web/src/Canvas.tsx` renders `<div className="canvas" tabIndex={0} role="application" onKeyDown={onKeyDown} …>` and never calls `host.current.focus()`; Cytoscape calls `preventDefault()` on the container's `mousedown` (its standard text-selection guard), which suppresses the default focus-on-click. The repository's own keyboard e2e suite never clicks before keying (it drives keyboard-only with zero pointer events), so this path is untested.

Suggested fix: in the canvas host's `onMouseDown` (capture, before Cytoscape), call `host.current.focus()` — or focus in the first `click` handler; one line, and mouse-then-keyboard works as the README describes.

Impact
Keyboard users who touch the mouse once (click a node, then decide to arrow around) get a dead keyboard with no explanation — the exact "silently unusable" failure mode the a11y work elsewhere in the README is careful to avoid. Screen-reader users following focus are affected most: the announcement live region stays silent regardless of keys pressed.
````


---


## Draft 06 — `06-wrong-types-500-storage-failure.md`

**Title (for the GitHub issue title field):** Request bodies with wrong JSON types crash handlers into `500 STORAGE_FAILURE (retryable)` instead of a 4xx validation error


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
Sending a JSON body whose fields have the wrong type reaches the handler and throws, and the gateway's catch-all turns that into `500 {code: "STORAGE_FAILURE", retryable: true}`. A client mistake is reported as a retriable server-side storage failure — wrong status code, wrong error code, wrong retry advice, and wrong signal for anyone monitoring logs.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main)

Steps to reproduce
```
curl -s -X POST http://127.0.0.1:4317/api/v1/components/C19/ask \
  -H 'content-type: application/json' -d '{"question": 12345}'
```
```
curl -s -X POST http://127.0.0.1:4317/api/v1/components/C24/reportException \
  -H 'content-type: application/json' -d '{"trace": 42}'
```

Expected
`400 INVALID_SCHEMA` with a per-field message, the way correct-shaped but out-of-range input is already handled ("question must be 1–1000 characters").

Actual (2/2 each)
```
500 {"ok":false,"error":{"code":"STORAGE_FAILURE","message":"internal error","retryable":true}, …}
```
The server log is silent about the underlying error; the exception is swallowed by the gateway's generic catch (`server.ts`: `catch (e) { return send(res, 500, { code: "STORAGE_FAILURE", … }) }`). `(req.question ?? "").trim()` throws on a number; `reportException` similarly dereferences the string-typed trace.

Where it comes from
There is no type validation in front of the handlers — the schema gates live on model output, not on request bodies — and the single catch-all cannot distinguish client errors from storage faults. Adjacent evidence from the same sweep: an oversized (> 8 MB) body is likewise answered with a TCP reset instead of a 413, because `readBody` destroys the request without sending a response.

Suggested direction: either validate the body against the per-op shapes before dispatch (the op table already knows each op), or at minimum catch handler throws per-op, log the error, and map obvious type errors to `400 INVALID_SCHEMA, retryable: false`. Sending a real 413 before destroying an oversized connection would close the adjacent gap.

Impact
Every automated client, VS Code extension or `@cie/reporter` integration that sends a malformed field gets "internal error, retryable" and retries — producing load and noise that then hides real storage failures. The honesty bar the project sets for displayed claims deserves to extend to error reporting.

Note
The rest of the adversarial API sweep passed cleanly on this commit: unknown ops/components → 404, wrong content-type → 415, invalid JSON → 400, missing Idempotency-Key on mutating ops → 400 (v1 and v2), nonexistent revision → 404, regex mode validation, the non-loopback Host guard → 403, path traversal stays inside the SPA fallback, and 4 concurrent identical ingests dedupe to one run.
````


---


## Draft 07 — `07-cytoscape-mapping-warnings.md`

**Title (for the GitHub issue title field):** Every map render spams the console with Cytoscape mapping warnings (`pie-1-background-size` on elements without the data field)


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
Rendering any map writes one Cytoscape warning per drawn node, twice over (`pie-1-background-size` / `pie-2-background-size`), because the overlay pie mappings are registered on the generic `node` selector while only overlay-tinted nodes carry the data fields. A 27-element view produces ~27 console warnings per render; with the browser devtools open the warnings dominate the console during every zoom-driven re-render.

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main)
- Chromium 143; demo repository, Failure-space map (27 drawn nodes and edges)

Steps to reproduce
1. Open any map with the devtools console visible.
2. Ask any question that renders a map (or zoom so the view re-renders).

Expected
Style mappings are scoped so that elements without the data field are not mapped — the console stays usable as the first place a user (and the project's own browser tests) look for errors.

Actual
```
Do not assign mappings to elements without corresponding data (i.e. ele
`n:function:src/ledger/ledger.ts#reserve` has no mapping for property
`pie-1-background-size` with data field `testOverlaySize`); try a
`[testOverlaySize]` selector to limit scope to elements with `testOverlaySize` defined
```
…repeated for `pie-2-background-size` / `runtimeOverlaySize`, for every node. Cytoscape even names the fix in the message.

Where it comes from
`apps/web/src/Canvas.tsx` (style array):
```ts
{ selector: "node", style: { "pie-size": "100%", "pie-1-background-color": muted,
  "pie-1-background-size": "data(testOverlaySize)",
  "pie-2-background-color": inf, "pie-2-background-size": "data(runtimeOverlaySize)" } },
```
The selector should be `[testOverlaySize]` / `[runtimeOverlaySize]` (separate rules), as the warning suggests, or the data fields should default on every node. No user-visible behaviour is wrong — the overlays render correctly — which is why this is filed at low severity: it is console noise, but it is noise on every render of every map, and it buries genuine page errors during ad-hoc testing.

Impact
Devtools noise that scales with graph size and re-renders; makes console-based debugging (and the wheel-sensitivity warning already present) harder to use as signal.
````


---


## Draft 08 — `08-npm-test-fails-worker-suite.md`

**Title (for the GitHub issue title field):** `npm test` fails on a clean checkout: one Rust test fails 3/3 in the full worker suite (passes 3/3 alone), and two TypeScript tests disagree with the committed code


**Body (paste verbatim below the line):**


^^^^^^ copy from here ^^^^^^


````markdown
Summary
On commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main, clean clone, no local changes), `npm test` aborts at its first step — `cargo test` — because `index::incremental_tests::reindexes_unchanged_content_from_the_previous_hashes_and_reports_reuse` fails whenever it runs with the rest of the worker suite and passes whenever it runs alone. After bypassing that, the TypeScript suite adds two further deterministic failures in which the committed tests and the committed code disagree (`profile-flow`, `task-flow`).

Environment
- commit 5ec061b5f4e8528b46a1aeca932766dd807e6bb3 (main), clean clone
- Rust 1.99.0, Node v24.21.0, Linux

Steps to reproduce
```
cargo test -p worker --bin worker                                # FAILS
cargo test -p worker --bin worker reindexes_unchanged            # PASSES
```

Expected
`npm test` — the documented verify command — is green on main.

Actual (3/3 full-suite runs, 3/3 solo runs)

```
failures:

---- index::incremental_tests::reindexes_unchanged_content_from_the_previous_hashes_and_reports_reuse stdout ----

thread '…' panicked at crates/worker/src/index.rs:1022:9:
only b.ts reused: incremental: 2 of 2 file(s) unchanged since the previous revision; their parses were reused

test result: FAILED. 43 passed; 1 failed
```

The third phase of the test edits `a.ts` on disk, marks it stale in the passed ChangeSet, and expects the reuse diagnostic to say "1 of 2". Under the full suite it says "2 of 2 unchanged" — the edit is not seen. In isolation the same code sees it every time.

Where it comes from (suspected, evidence-backed)
- The parse cache is process-global: `static PARSE_CACHE: OnceLock<Mutex<ParseCache>>` (crates/worker/src/index.rs:46), keyed by `CacheKey(rel, content_hash)` — the path *relative to the repo root*.
- Several other tests in the same binary index directories that contain files with the **same relative names** (`a.ts`, `b.ts`) and, for the delta family (`cie-delta-{name}-{pid}`, index.rs:1162), overlapping contents, while this test's directory is `cie-incr-{pid}` (index.rs:992). All tests share one process and one cache.
- The reuse/unchanged diagnostic is computed from state that those concurrent tests mutate (cache entries and revision state for the same rel keys), so its message — which the test asserts on — depends on test order/scheduling. The shared temp-dir naming (`{pid}`) shows the tests already assume cross-test isolation that the global cache does not provide.

Suggested direction: scope the parse cache key by repo root (or a per-index session id), or make the reuse diagnostic derive purely from the passed ChangeSet and the worktree rather than any process-global state; then the test is deterministic in both settings.

Impact
Every CI run of the documented verify command is red at step one, which both blocks the suite's later stages (the TypeScript tests never run as part of `npm test`) and trains contributors to ignore failures — the opposite of what the "has failing test" label process in this tracker is for.

Second failure (TypeScript, deterministic serially and in parallel): `task-flow.test.ts` "F07 command surface"

```
packages/core/test/task-flow.test.ts:407
AssertionError: expected { code: 'FORBIDDEN' } to strictly equal 'PROVIDER_UNAVAILABLE'
```

The test publishes with `grantId: "grant:none"` and no forge configured, expecting the forge refusal (`PROVIDER_UNAVAILABLE`, "refused rather than simulated"). `publishDraftPR` (packages/core/src/execution.ts:983) checks the publication grant before any forge is consulted, and `"grant:none"` matches no stored grant, so the call is refused earlier with `FORBIDDEN` ("the grant does not bind this candidate and branch"). Either the check order moved after the test was written or the test needs a real grant to reach the forge check; as committed, the two disagree. Reproduced 2/2.

Third failure (TypeScript, environment-sensitive, reported for completeness): `profile-flow.test.ts:90` "full chain (A1 + D2)" — a real `--cpu-prof` run ingested through the F05 chain binds with state `MISMATCH` where the test expects `MATCHED` (2/2, Node v24.21.0). No external tool is needed for this one; it may be Node-version-sensitive, and it is consistent with the F05 profile surface also being broken in the UI (companion issue about the Profiles panel). The remaining three failures in this environment (DP05 Loom, DP06 ThreadSanitizer, DP14 hostile-stress sandbox, and the Go/Java adapter catalogue asserting `go.race-detector.local` availability) need real toolchains (`go`, loom crate fetch, tsan targets, sandbox privileges) and are plausibly environment gaps rather than product defects; they are listed so the total is accounted for: 1 Rust + 6 TypeScript failing tests observed on this commit in this environment.
````
