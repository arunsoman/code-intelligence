# Implementation Guide — Code Explainer: Query, Intent, Chart & Zoom System

**Source spec:** `~/Downloads/Code_Explainer_Query_Chart_System.md` (v1.0), copied into this plan (§A) so no other document is needed.
**Status of this doc:** executable work plan. Every file path, symbol name, and line reference below is from the current repo state (`git log HEAD` at time of writing). Work packages WP0–WP10, in dependency order. WP0 (two-layer context: session + active chart context) is the substrate everything stateful reads; WP4 registers the S29 contract only (compiler deferred, §6/D4); tests ride with every package (the full §11 suite is WP8's sweep); WP9 deletions go last.
**Reviewer invariants (never break these):** `docs/chart-rendering-requirements.md` §3 (chartId preservation, evidence gating, honest gaps) and `docs/chart-parity-and-completion.md` ("dedicated vs partial" status labels must stay accurate in UI copy).

---

## 0. One-paragraph summary

Add a **closed, 34-intent query system** (spec §3) with a **dedicated classifier** (spec §6) that returns numeric confidence and a `new_intent` alert below 0.75, route every intent to a **registry-declared primary chart** (all of which already exist as `S1–S28` / `V1–V19`, with one chart — `S29` Control-Flow Graph — registered but compiler-deferred behind a CFG analyzer, §6/D4), replace the client-side ±1 camera zoom with a **server-side chart zoom stack with breadcrumb** (spec §4), and attach a **lettered choice menu** (spec §5) to every rendered view. Remove the free-form "design any chart" path so the "no orphan views" rule holds.

---

## 1. Current state — exact facts you will build on

| Fact | Where today |
|---|---|
| Chat entry point | `packages/core/src/service.ts` → `Service.converse()` (lines ~2517–2643). Gate order: `explicitChartCode(text)` (alias regex) → `looksLikeTrace` → chat-agent/plan → `readText()` label router → `switch (intent.type)` |
| Intent union | `packages/core/src/llm-router.ts` `type Intent` (lines ~18–30): `resume`, `whyShown`, `whyHidden`, `ignore/restore/whySuspect`, `pin/unpin/boost/demote`, `overview`, `zoom {direction: in|out|overview}`, `connected`, `investigate`, `ask {route}` |
| Label router | `readText()` (llm-router.ts ~315–348): `candidateLabels()` = `FORM_LABELS` (~17 form labels) + `INTENT_LABELS` (screen-dependent). Weak match → **silent fallback** `{type:"ask", route:{source:"default", confidence:"low", form:"SemanticMap"}}` (`fallback()` at ~316). No numeric confidence, no `new_intent` |
| Model transport | `OllamaRouter.choose()` — constrained-decoding JSON `{label, target}` (local), tool-call (hosted) |
| Conversation identity | **None.** `C15/converse` takes no session id; the client owns the transcript (`apps/web/src/App.tsx:473` re-sends `messages.slice(-6)` every call). C12 sessions are bare string keys into `ctx_events` — no registry, owner or lifecycle (`interactions.ts:11` takes `session: string` as-is). Closest anaphora precedent: `interactions.ts` `followUp()` (I-07 "relate") — pronoun regex → `snap.referent` → `<2 referents ⇒ NEEDS_CLARIFICATION`, never a guess |
| Chart ids & registry | `packages/schema/src/index.ts`: `ChartId` S1–S28+`generic` (~303–309), `CHART_ALIASES` (~860), `CHART_REQUIRED_KINDS`/`CHART_REPO_KINDS`/`CHART_FORMS` (~935+), `CHART_REGISTRY` (~928), `chartCodeForQuestion()` (~941) |
| Chart v2 typed contracts | `packages/schema/src/index.ts` `chartV2Base` (~322) + per-chart variants S3,S4/S9,S7,S8,S10,S11,S12,S13,S14,S15,S16,S17,S18,S19,S20,S21,S22,S23,S24,S25,S26,S27,S28 (~333–791); generic fallback variants for S1,S2,S5,S6 (~794–797, `ChartOutputV2GenericFallback`) |
| Chart compiler | `packages/core/src/chart-creator.ts`: `CHART_CREATOR_PROMPT_V2` (~29–52), cache (`chartPlanCacheKey`/`cachedChartPlan`/`rememberChartPlan`), `legendEntriesForChartId()` (~110–250), per-chart `compile*V2()` functions (~250–1081) |
| Chart request path | `service.ts` `ask()` (~1814) → `askView()` (~1842): `route.form==="GeneratedChart" && req.chartCode` → bundle → cache → `chartCreatorRequest()` → `compileChartPlan()`. Non-chart path → form builders |
| Form builders (V-views) | `packages/core/src/visuals.ts` `VISUALS` (V1–V19) + `packages/core/src/forms/*.ts` (20 builders) |
| Catalog endpoint | `service.ts` `visuals()` (~2059) → `catalog()` in visuals.ts; web: `apps/web/src/VisualsGallery.tsx` (`C19/visuals`) |
| Post-answer chart ranking | `service.ts` `recommendCharts()` (~2066, op `C19/recommendCharts`), `OllamaRouter.recommendCharts()` |
| Zoom today | `ConverseResult {kind:"zoom", direction}` (schema ~1112) → `App.tsx:496` `setLevel(level±1)` → `graph.ts MAX_LEVEL=6` semantic levels **within one view**. Server never rebuilds anything. Also `interactions.ts:107–108` (same behavior), `context.ts:116` (`ZOOM` event stores numeric level) |
| Breadcrumb / zoom history | **None.** `context.ts` `ContextSnapshot.zoomLevel` is a single number |
| Choice menus | **None anywhere** in web or core |
| Converse result kinds | `schema/src/index.ts` `ConverseResult` (~1104–1120): `analysis`, `view`, `explanation`, `resume`, `zoom`, `message` |
| Server op registry | `packages/core/src/server.ts` (~60–100): `"C15/converse"`, `"C19/visuals"`, `"C19/ask"`, `"C19/recommendCharts"`, etc. |
| Classifier eval harness | `scripts/eval-tiny-models.ts` + `docs/eval-tiny-models.json` (existing pattern to extend) |
| Tests that lock behavior today | `packages/core/test/route.test.ts` (+ `route-sets.ts`, `route-live.test.ts`, `scripted-router.ts`), `chart-creator.test.ts`, `chart-rendering.test.ts`, `apps/web/test/e2e/zoom.test.ts`, `apps/web/test/api.test.ts`, `packages/core/test/interactions.test.ts`-equivalent zoom assertions in `apps/web/test/e2e/*` (levels.ts helpers) |

**What already satisfies the spec (do NOT re-build):** typed chart.v2 contracts; chartId preservation + rejection of mismatched plans (`validateChartIdNotChanged`, `matchingChartPlan` in service.ts:96); cache keys that include chartId (`chartPlanCacheKey`); evidence gating in every `compile*V2`; the S1–S28 catalog (all spec charts except CFG, see §2 map); mention resolution for "zoom into X" subjects (`packages/core/src/mentions.ts` `resolveMentions`, already called in chat-agent + converse).

---

## 2. Chart catalog map (spec §2 → CIE codes) — bake this into the registry

Every spec chart id gets a stable CIE code. Existing multiplexed codes stay; their gallery copy gains the catalog numbers (deviation D3). The only catalog chart that is a *primary* chart of a supported query yet lacks a dedicated view is #29 (CFG): its `S29` **contract is registered, but the compiler is deferred** behind a CFG analyzer (§6, deviation D4) — query 12 routes to the documented S2 approximation meanwhile.

| Spec # | Chart | CIE code | Status | Action |
|---:|---|---|---|---|
| 1 | UML Class Diagram | `S16` | dedicated | none |
| 2 | UML Component Diagram | `S1` | partial | keep; honest gallery copy (already so) |
| 3 | UML Package Diagram | `S17` | dedicated | none |
| 4 | UML Deployment Diagram | `S1` | partial | keep; gallery copy notes S1 approximation |
| 5 | Hexagonal / Ports & Adapters | `S1`, `S15` | partial | keep; gallery copy |
| 6 | Layered Architecture | `S22` | dedicated | none |
| 7 | C4 — Context | `S27` | dedicated | none |
| 8 | Dependency / Module Graph | `S23` | dedicated | none |
| 9 | UML Activity Diagram | `S2` | partial | keep; gallery copy notes approximation |
| 10 | UML Communication Diagram | `S18` | dedicated | none |
| 11 | UML Timing Diagram | `S3` | partial | keep; gallery copy |
| 12 | UML Interaction Overview | `S19` | dedicated | none |
| 13 | UML Use Case Diagram | `S6` | partial | keep; gallery copy |
| 14 | BPMN | `S7` | dedicated | none |
| 15 | Swimlane Flowchart | `S2` | partial | keep; gallery copy |
| 16 | Event Storming / Event Modeling | `S8` | dedicated | none |
| 17 | ER Diagram | `S9` (repo-wide), `S4` (ledger-style) | dedicated | none |
| 18 | Data Flow Diagram | `S10` | dedicated | none |
| 19 | Data Lineage | `V5` (DataLineage) | dedicated | none |
| 20 | Decision Table | `S11` | dedicated | none |
| 21 | State Transition Table | `S24` | dedicated | none |
| 22 | Race Condition Timeline | `V10` (RaceWindow) | **Partial** — parity doc: a race-window map is not a timeline; time-ordered interleaving missing | keep; gallery copy must state the approximation; no new chart work |
| 23 | Petri Net | — (S3 approximation) | no dedicated view | **defer** (see D3): never a primary chart of any of the 34 queries; add to parity doc as "partial via S3" |
| 24 | Saga / Compensation Graph | `S12` | dedicated | none |
| 25 | Outbox Pattern Diagram | `S13` | dedicated | none |
| 26 | FMEA / Compensation Matrix | `S25` exists; doc's closest-view column predates it and maps `S12` saga / `S11` decision table | **Partial** — FMEA rows, severity/occurrence/detection/risk-priority fields missing | keep; gallery copy honest; WP10 reconciles the doc's closest-view column with S25's existence |
| 27 | Idempotency Matrix | `S14` | dedicated | none |
| 28 | Call Graph | `S21` | dedicated | none |
| 29 | **Control Flow Graph** | `S2` / `S7` approximations; `S29` registered, compiler missing | Partial | **contract registered, compiler DEFERRED behind a CFG analyzer** — §6, deviation D4 |
| 30 | CRC Cards | `S20` | dedicated | none |
| 31 | DI / Wiring Diagram | `S15` | dedicated | none |
| 32 | Test Traceability Matrix | `S5` / `V12` (TestConfidence) | dedicated | none |
| 33 | Metrics / Telemetry Dashboard | `S26` exists; doc maps `V9` runtime overlay / `V17` profile | **Partial** — general dashboard (named metrics, units, windows, aggregation) missing | keep; WP10 reconciles the doc row with S26 |
| 34 | Threat Model / DFD w/ Trust Boundaries | `S10` + `V8` (TrustBoundary) | partial | keep; gallery copy |
| 35 | Flame Graph / Profiling Chart | `V17` (TraceLinkedProfile) | **Partial** — V17 is trace-linked, not an aggregated flame graph | keep; gallery copy must state the approximation |

Registry metadata updates in `packages/schema/src/index.ts` (S29 = **register-only**, see §6 / deviation D4):
- `CHART_IDS`/`ChartId`: add `"S29"`; `CHART_NAMES.S29 = "Control flow graph"`; `CHART_ALIASES.S29 = ["control flow graph", "cfg", "control flow diagram"]`; `CHART_FORMS.S29 = "GeneratedChart"`; `CHART_REQUIRED_KINDS.S29 = ["function", "method"]`.
- Do **NOT** add `S29` to `SPECIALIZED_CHARTS` / `PROJECTED_CHARTS` / `OFFLINE_DERIVED_CHARTS`, and no prompt hint: `CHART_REGISTRY.S29.compiler` stays the existing type's `"missing"` value — the gallery greys it with its existing "chart compiler is not implemented yet" reason, and `askView` short-circuits the same way. No model call, no compile function in this plan.

**Label rule (reviewer ruling #1, accepted):** statuses in the table above are copied verbatim from `docs/chart-parity-and-completion.md`. Where a doc row looks stale (its closest-view column for #26/#33 predates S25/S26), the fix is made ONCE in the doc by WP10 and both places re-checked — never by quietly upgrading a plan label to "dedicated".

---

## 3. Query-intent registry (spec §3, verbatim) — this becomes `packages/schema/src/intents.ts`

Create `packages/schema/src/intents.ts`. This file is the single source of truth for the 34 intents; `llm-router.ts`, `service.ts`, and `zoom-map.ts` all import it. Paste these tables exactly (CIE codes substituted for catalog numbers; both kept so gallery copy and registry stay cross-checkable):

```ts
// packages/schema/src/intents.ts (NEW FILE)
export const QUERY_SECTIONS = ["A","B","C","D","E","F","G","H"] as const;
export type QuerySection = typeof QUERY_SECTIONS[number];

export interface QueryIntent {
  id: number;                 // 1–34, stable forever (do NOT renumber; zoom map + tests key off these)
  intent: string;             // exact intent text from the spec — classifier output must echo it verbatim
  section: QuerySection;      // A–H from the spec's table
  query: string;              // the canonical example query shown to users
  primaryChartIds: string[];  // CIE chart codes, in priority order; first is the default render
  zoomInLeadsTo: number[];    // spec "Typical zoom-in leads to" — query ids
  /** How the subject ("Zoom into [X]") is bound: resolved against mentions before building. */
  subject: "none" | "repo" | "moduleOrService" | "dataModelOf" | "action" | "flow" | "method" | "entity" | "classOrMethod" | "item";
}

export const QUERY_INTENTS: Record<number, QueryIntent> = { /* filled below */ };
```

Paste this registry (columns: id → intent text / section / primary CIE chart / zoom-leads / subject binding):

| id | intent (exact string for classifier) | sec | primaryChartIds (CIE) | zoomInLeadsTo | subject |
|---:|---|---|---|---|---|
| 1 | Understand the overall purpose and scope of the system | A | `["S27"]` | `[2,3]` | `repo` |
| 2 | Grasp the major building blocks and how they fit together | A | `["S1","S22"]` | `[4,5,8]` | `repo` |
| 3 | Learn the package/folder layout and logical grouping | A | `["S17"]` | `[4,5]` | `repo` |
| 4 | See inter-module coupling and dependency direction | A | `["S23"]` | `[5,23]` | `repo` |
| 5 | Dive deeper into one specific part of the architecture | A | `["S16","S1"]` | `[23,10,14]` | `moduleOrService` |
| 6 | Locate the starting point of execution | A | `["S21"]` | `[14,15]` | `repo` |
| 7 | Understand the persistent data model | B | `["S9","S4"]` | `[8,19]` | `repo` |
| 8 | Trace how information moves from input to storage/output | B | `["S10","V5"]` | `[14,15]` | `action` |
| 9 | Examine the data structures owned by a specific component | B | `["S9"]` | `[19,20]` | `dataModelOf` |
| 10 | Understand the end-to-end business process | C | `["S2","S2","V4"]` | `[11,12,16,17]` | `action` |
| 11 | See the exact order of interactions between components | C | `["S28","S18"]` | `[14,15]` | `flow` |
| 12 | Explore all branches and decision points inside a method | C | `["S2"]` | `[16,17]` | `method` |
| 13 | Identify the main interactions the system offers to actors | C | `["S6"]` | `[10]` | `repo` |
| 14 | Go deeper into a specific piece of behavior | C | `["S21","S2"]` | `[12,15,16]` | `method` |
| 15 | Get a detailed, sequential explanation of implementation | C | `["S2"]` | `[16,17]` | `method` |
| 16 | Understand the lifecycle and valid transitions of an entity | D | `["S24","S3"]` | `[17,18]` | `entity` |
| 17 | Discover the business rules and guard conditions | D | `["S11"]` | `[18,22]` | `flow` |
| 18 | Examine the exact conditions that control branching | D | `["S11","S29"]` | `[22]` | `flow` |
| 19 | Assess concurrency safety and protective mechanisms | E | `["V10"]` | `[20,21]` | `repo` |
| 20 | Verify safe retry behavior and duplicate handling | E | `["S14"]` | `[21]` | `repo` |
| 21 | Understand failure handling and rollback strategies | E | `["S12","S25"]` | `[22]` | `repo` |
| 22 | Dive into the exact recovery or rollback sequence | E | `["S12","S2"]` | `[20,21]` | `flow` |
| 23 | Reveal the internal call structure and collaborators | F | `["S21"]` | `[14,15]` | `repo` |
| 24 | Understand responsibilities and dependencies of a class | F | `["S20"]` | `[23,25]` | `classOrMethod` |
| 25 | See how components are assembled and injected | F | `["S15"]` | `[4,23]` | `repo` |
| 26 | Inspect the actual source and low-level logic | F | `["S16","S29"]` | `[15,17]` | `classOrMethod` |
| 27 | Map tests to important behaviors and guarantees | G | `["S5","V12"]` | `[10,19]` | `repo` |
| 28 | Know which runtime signals indicate health or problems | G | `["S26"]` | `[]` | `repo` |
| 29 | Identify expensive operations for optimization | G | `["V17"]` | `[14,15]` | `repo` |
| 30 | Understand trust zones and potential attack surfaces | G | `["V8","S10"]` | `[2,8]` | `repo` |
| 31 | Go one level deeper into a specific element | H | `[]` (computed by zoom-map) | `[5,9,14,18,22,26]` | `item` |
| 32 | Return to the previous higher-level context | H | `[]` (breadcrumb pop) | `[]` | `none` |
| 33 | Reset to the top-level architecture | H | `["S27","S1","S17"]` | `[]` | `repo` |
| 34 | Explore a related concern of the current item (data / state / concurrency / failure) | H | `[]` (side-zoom map) | `[7,8,9,16,17,18,19,20,21,22]` | `item` |

Note duplicated entries in `primaryChartIds` (e.g. 10 `["S2","S2","V4"]`) are intentional: index 0 = swimlane-style journey (S2), index 1 = activity reading of S2, index 2 = native V4 TransactionJourney fallback. Deduplicate at use sites (`chartForIntent` below returns `[...new Set(ids)]`).

Derived helpers, same file:

```ts
export const MAX_INTENT_ID = 34;
export const intentById = (id: number): QueryIntent => { const q = QUERY_INTENTS[id]; if (!q) throw new Error(`unknown intent ${id}`); return q; };
export const chartForIntent = (id: number): string | undefined =>
  [...new Set(intentById(id).primaryChartIds.filter((c) => c.startsWith("S")))][0];
export const formForIntent = (id: number): string | undefined =>
  intentById(id).primaryChartIds.find((c) => c.startsWith("V"));
```

### 3.1 Classifier output schema + prompt (spec §6)

Same file:

```ts
export const INTENT_CLASSIFIER_SCHEMA = z.union([
  z.object({ intent_id: z.number().int().min(1).max(34), intent: z.string(), confidence: z.number().min(0).max(1), target: z.string().max(300).optional() }).strict(),
  z.object({ intent_id: z.literal("new_intent"), intent: z.string().min(1).max(200), confidence: z.number().min(0).max(1), reason: z.string().min(1).max(300), target: z.string().max(300).optional() }).strict(),
]);
export type IntentClassification = z.infer<typeof INTENT_CLASSIFIER_SCHEMA>;
export const INTENT_CONFIDENCE_THRESHOLD = 0.75;
// `target` is optional in the schema (non-subject intents legitimately omit it) but REQUIRED in
// practice for subject-bearing ids (5, 9, 12, 14, 18, 22, 24, 26, 31, 34): the router treats a
// missing target there as "model gave no subject" and falls through to the §3.2.1 tier ladder.
// It is never trusted unless it echoes a ledger label or a resolveMentions name
// (confirm-only rule, §3.2.3/§3.2 item 4).
```

`INTENT_CLASSIFIER_PROMPT` — **committed here in full; the implementation no longer depends on the Downloads file** (origin: spec §6, with the deviations below). Ship as a template; `{INTENT_MENU}` is rendered from `QUERY_INTENTS` at load (one line per intent: `"<id>. [<section>] <intent> (chart <code>)"`), so menu and prompt can never drift:

```text
You are an Intent Classifier for a Code Explainer tool.

Your only job is to analyze the user's question and map it to the single best matching intent from the list below.

### Existing Intents (use the exact ID and name)
{INTENT_MENU}

### Output Rules (strict)

- If you can match the question to one of the intents above with confidence >= 0.75, output exactly:
{"intent_id": <number>, "intent": "<exact intent text>", "confidence": <0.00-1.00>, "target": "<the code element the message names (e.g. 'Zoom into X', 'the data model of Y'), or "" when none>"}
- If confidence is below 0.75, output exactly:
{"intent_id": "new_intent", "intent": "<short clear description of the new intent you detected>", "confidence": <0.00-1.00>, "reason": "<one sentence why it doesn't fit existing intents well>", "target": "<named element or "">"}
- If the message refers to something by it/that/this/'the same' and names no code element, set `target` to the exact label of the most recent suitable referent supplied in `referents`. If referents are ambiguous, return intent_id "new_intent" with reason "ambiguous reference".
- If the message is a command about the map on screen (pin X, why is X hidden, boost X, explain the selection) or a pasted stack trace, output {"intent_id": "new_intent", "intent": "map command or stack trace", "confidence": 0.0, "reason": "not a repository query"} — the deterministic gate normally intercepts these before you.
- Never invent an intent_id that is not in the list above (except "new_intent").
- Never output anything else (no explanations, no markdown, no extra keys).
- Always return valid JSON.
```

The three deviations from the downloaded spec's prompt, already incorporated above (also recorded in the file header comment):
- **D1a** — the `"target"` field on both outcome branches (the spec's schema lacked it; without it, subject-bearing intents 5, 9, 12, 14, 18, 22, 24, 26, 31, 34 cannot bind). Grounded precedent: `OllamaRouter.choose()` already returns `{label, target}`, and `strip()` + `resolveMentions` already do the matching.

### 3.2 Anaphora — messages that refer to something by "it" / "that" (deviation D1c)

The classifier must see what earlier turns established, or "zoom into it" is unanswerable. Grounding that already exists — do not build a coreference engine, wire these:

- `packages/core/src/context.ts` (C12) already persists per-session context events (`FOCUS`, `SELECT`, `QUERY`, `ACTION`) and `ContextSnapshot` already carries `focus: string | null`, `selection: string[]`, `referent: string[]`, `recentQueries: string[]`, `frequent: Record<string, number>`. The `"REFERENT"` ActionName and its snapshot case literally exist today; nothing populates them from the chat path.
- `service.ts converse()` already receives the live `req.view` and `req.selection` ("Selection chips are referents" per its doc comment) — current-screen antecedents are available at dispatch time without any new plumbing.
- WP6's breadcrumb stack records one frame per rendered view — but frames now embed **typed `ReferentRecord`s** (§3.2 items 1–1b, §7), so labels, kinds, levels and revisions are all available to the resolver.
- The chat agent already computes which entities an answer relied on: `cited` (post `env.seen` filtering) in `chat-agent.ts`.

Mechanism (all in WP3/WP6):

1. **Typed referent records (NEW, `packages/schema/src/intents.ts`).** `ContextSnapshot.referent: string[]` cannot carry what the resolver rules need (label to echo, kind to rank by, level to scope same-level candidates, revision to detect staleness) — and `BreadcrumbFrame` as first drafted (label only) had the same hole. One record per antecedent:

```ts
export interface ReferentRecord {
  entityId: string;    // index entity id (mentions.ts / store ids)
  label: string;       // display name — the classifier `target` echoes exactly this
  kind: string;        // class | function | module | file | table … (store entity kinds)
  level: 0|1|2|3|4|5;  // zoom-map level (§7) of the view that made this salient
  turnSeq: number;     // conversation turn counter — recency-ranking input
  rev: string;         // revision id captured against — staleness check
  source: "selection" | "focus" | "view-render" | "answer-cite" | "breadcrumb";
}
export const ReferentLedgerV1 = z.object({ v: z.literal(1), referents: z.array(ReferentRecord).max(12) }).strict();
```

1b. **Storage — the active chart context is the single ledger (§3.3, deviation D2).** Referents are stored ONLY as the versioned `ReferentLedgerV1` block inside the session's `ActiveChartContext` (§3.3); no `LEDGER` event kind is added to `context.ts` — two stores for one truth would drift. C12's FOCUS/SELECT events stay exactly what they are today: client-gesture INPUTS, merged by the render path when it writes the context, and the resolver still reads only the active context. Producers only *write*, always inside the turn's completion tx (§3.5): render paths (`asView`/`asChoices`) write view-render records and merge focus/selection; chat-agent answer completion writes its top-5 `cited` ids as `answer-cite` records; breadcrumb frames embed the same records (§7). Readers assert `v === 1` and discard unknown versions (reject-not-guess). Record payloads are ids/labels only, so minimisation never needs to touch them. No active context (stateless or pre-first-render) → empty referents → tier ladder hands off to clarification.

1c. **Clarification is its own ConverseResult variant (NEW, `packages/schema/src/index.ts`)** — ambiguity must not piggyback on `view`/`message` fields, and `newIntent` must stop bundling three different situations:

```ts
| { kind: "clarify"
    message: string;      // one honest sentence: what was detected and why it can't proceed
    options: Choice[];    // lettered; every option carries a fully-formed re-send question
    origin: "ambiguous-referent" | "unsupported-query" | "stale-referent";
    /** origin "unsupported-query" only — the spec's new_intent alert payload */
    detected?: { intent: string; confidence: number; reason: string };
    suggestions?: string[]; }
```

Boundary rule: `kind:"message"` stays for operational feedback ("Pinned X", "nothing to zoom out to"); everything that needs the user to disambiguate or rephrase is `kind:"clarify"`. `newIntent` ceases to be a standalone result: an unsupported query IS `clarify {origin:"unsupported-query", detected, suggestions}` (the spec's alert, same payload), an ambiguous pronoun IS `clarify {origin:"ambiguous-referent"}`, and map commands never reach the classifier at all — the deterministic gate intercepts them (§4 item 5).
2. **Referent resolution is a preprocessing step in `query-router.ts`**, before subject binding (see §5):
   a. If `resolveMentions()` found exact names in the message → **names always outrank pronouns**; anaphora resolution does not run (a user saying "zoom into it — I mean ReserveService" binds to the name).
   b. Otherwise, if the message contains an anaphoric marker (`/\b(it|its|it's|that|this|those|them|the (latter|former|same)|the above|the previous)\b/i`) AND intent 5/9/12/14/18/22/24/26/31/34 needs a subject → run the tier ladder (§3.2.1): names are already bound by step (a); else take the highest-ranked `ReferentRecord` from the ACTIVE chart context (§3.3) — tier 3: top record whose `level` matches the context's current level, then selection chips > focus > breadcrumb top > answer-cite records (all merged into that context by the producers). Echo its exact `label` as `target`; carry `level`/`kind`/`rev` through — they are the ranking inputs (§3.2.3) and the staleness key.
   c. If the ledger is empty (sessions predating LEDGER events) or every candidate fails the staleness check (`record.rev` ≠ current revision, or its entity id not CURRENT in the bundle — C12 drops QUERY **text** past the working window but ids/labels survive; staleness is decided by `rev`, not event age) → **do not guess**: `kind:"clarify"`, `origin:"stale-referent"`, with the honest note *"that was before the last re-index; name it again"*.
   d. If ≥2 ledger entries could be "it" (e.g. two modules both rendered this session and the message disambiguates neither) → **ambiguous-reference clarification**, not a guess: return `kind:"clarify"`, `origin:"ambiguous-referent"` (§3.2 1c), options lettered A–… (each candidate's `question` = the original query + the candidate name, so the re-send resolves to a name — permanently), plus the mandatory "Something else" option. This matches spec §5 (user stays in control) and reuses the choice-menu rendering; it is a new result kind, not a field on `view`/`message`.
3. **Classifier input (deviation D1c).** `RouterModel.classify(req)` takes `{question, intentMenu, referents: {label, kind, level, source}[]}` — derived from the ACTIVE chart context's referents as loaded in §8 step 0 (invalidation already applied). The prompt gains one rule: *"If the message uses it/that/this/'the same' and names no code element, set `target` to the exact `label` of the most recent suitable referent. If referents are ambiguous, return `new_intent` with `reason: "ambiguous reference"`."* **Confirm-only rule:** the model's `target` is trusted only when it echoes a ledger label verbatim (or a `resolveMentions` name); anything else is treated as unresolved and the ladder/menu decides. A local tiny model still gets the deterministic tier fallback regardless (mirrors the existing `similarForm()` local-match pattern in `readText()`).
4. **Honesty rule (repo invariant).** If resolution comes only from the local heuristic fallback (no classifier run, or model refused), the `because` string says *"resolved 'it' to <label> from the last shown view"* — matching how `similarForm` and `matchName` already disclose their provenance. Never silently guess; the message text may name the guess so the user can correct it.

What is explicitly out of scope (record in the plan): multi-hop coreference chains ("the first one", "the service we discussed before the data-model question") and pronouns resolved against un-shown history. Failure mode for all of these: clarification menu, never a wrong render.

### 3.3 Two layers of context (deviation D2 — prerequisite for §3.2)

```
ConversationSession (chat history — identity, transcript, lifecycle)
  ├─ transcript: every turn, append-only (display + audit only)
  └─ ActiveChartContext (exactly one per session)
       ├─ repoRoot + revision              ← where the chart work is rooted
       ├─ subject + chartCode + level      ← what is on screen
       ├─ referents (≤12 ReferentRecord)   ← the ONLY thing "it" may resolve against
       └─ zoom breadcrumb (≤6 frames)
```

**Problem, verified:** `C15/converse` takes no conversation id (`service.ts` ~2519: `{ text, view?, selection?, revision?, pins?, history? }`); the transcript is client-owned (`apps/web/src/App.tsx:473` re-sends `history: messages.slice(-6)` every call); C12 `ctx_events` sessions are bare string keys with no registry, owner, or lifecycle. §3.2's per-conversation referents therefore have nothing to key to — and a single flat session ledger would let chart references from a finished topic steer a new one. Precedent to generalize: `interactions.ts` `followUp()` (I-07) binds "they/them" against `snap.referent` and clarifies below 2 candidates.

**Rule: the conversation is a server-owned aggregate with two layers; three roles stay separate.**

| Role | Component | Owns |
|---|---|---|
| Session manager (NEW, mechanical) | `packages/core/src/chat-session.ts` | identity, lifecycle, transcript, chart-context transitions (open/close on topic and revision), `buildModelContext()` — never interprets content |
| Resolver | `query-router.ts` `resolveReferent()` (§3.2.1) | the pronoun decision against the ACTIVE chart context only — never stores |
| Classifier / agent | `llm-router.ts` / `chat-agent.ts` | reading the message / prose — receive only the compiled `ModelContext` (active context + ≤6 recent turns) |

**Schema + storage (NEW; types in `packages/schema/src/intents.ts`, tables in `packages/core/src/migrations.ts` per the existing `create table if not exists` pattern):**

```ts
export interface ChatSession {
  sessionId: string;          // server-minted crypto.randomUUID(), unguessable
  actorPrincipal: string; tenantId: string;   // from CallContext.actor; checked on EVERY call
  state: "open" | "archived";
  seq: number;                // turn counter, seq-continuity discipline of ctx_events
  createdAt: string; lastActiveAt: string;
}
export interface ActiveChartContext {
  id: string; state: "active" | "closed";
  openedAtSeq: number; closedReason?: "topic" | "revision-invalidated";
  repoRoot: string; revision: string;         // where this chart work is rooted
  subject?: string; chartCode?: string; level: 0|1|2|3|4|5;  // what is on screen
  referents: ReferentRecord[];                // ≤12, versioned as ReferentLedgerV1 (§3.2)
  breadcrumb: BreadcrumbFrame[];              // ≤6, most recent last
  recentIntents: { intentId: number; label: string; target: string; chartCode?: string }[];  // ≤5 — how this context came to be (audit)
}
export interface ChatTurn { sessionId: string; seq: number; role: "user" | "assistant"; text: string; state: "pending" | "complete" | "failed"; attempt: number; intentId?: number; chartCode?: string; viewId?: string; at: string }
```

- Tables `chat_sessions`, `chat_turns` (pending-first protocol, §3.5), `chat_chart_contexts` (one `active` row per session, enforced in tx; closed rows kept ≤20 for audit). Transcript text passes the C12 minimisation gate (`detectSecret` in `policy.ts`) before insert.
- Retention reuses `getPolicy()`'s `RetentionPolicy`: idle turns tier to digest-only (`minimised` counters like `applyMemoryTierPolicy`); session/context rows stay (seq continuity is never gapped).
- **Access:** every call re-checks actor + tenant; mismatch → `ACCESS_DENIED` (foreign-tenant → `NOT_FOUND`, deliberately indistinguishable).

**Topic transitions (routing rule 3) — deterministic, model-free.** Decided AFTER the router resolves a subject, by set membership, never by a model:
- The resolved subject is already in the ACTIVE context's referents/subject → **keep** the context (breadcrumb grows).
- The message names a DIFFERENT module/subject (mentions resolve; none in the active context) or a repo-wide intent with a new subject → **close** (reason "topic") + open a fresh `ActiveChartContext`: it carries repoRoot/revision/pins ONLY — referents and breadcrumb start empty, so old chart references cannot steer the new request; the transcript is untouched (history remains visible).
- Intent 33 ("show the high-level view again") is by definition a fresh context.
- Zoom-in/out/side-zooms (intents 31/32/34) never open a new context — they mutate the active one.
- Every close is audited (`svc.store.audit`, closedReason + seq) so "why did it forget my subject" is answerable from the trace.

**API:**

- `C15/openSession {revision?} → { sessionId, seq, revision }` (new op in `server.ts`) — creates the session AND its first (empty-subject) `ActiveChartContext`. `C15/closeSession {sessionId}` → archived; later calls → `NOT_FOUND`.
- `C15/converse` req gains `sessionId?: string`: present → load + checks; server transcript authoritative, client `history` ignored (forged/stale-history vector closed); absent → **stateless mode**: routing identical, but referents/breadcrumb empty with a loud metadata warning — *"conversation identity not provided: 'it' references and zoom breadcrumbs are unavailable"*. Old clients, old tests: unchanged.
- Web: one session per conversation UI; `openSession` on first message or resume; pass `sessionId` on every converse (replaces the `history:` argument).

**`buildModelContext(activeContext, recentTurns): ModelContext`** — structured, deterministic, never model-written (the invariant): the model receives **the active chart context plus a small recent-turn window and nothing else** (older transcript turns exist only in `chat_turns` for display and audit; no routing path may read them):

```ts
export interface ModelContext {
  turns: { role: "user" | "assistant"; text: string }[];  // ≤6, ≤1500 chars — the ONLY transcript the model sees
  chart: {                                                // the active chart context, verbatim
    repoRoot: string; revision: string; subject?: string; chartCode?: string; level: number;
    referents: ReferentRecord[]; breadcrumb: BreadcrumbFrame[];
  };
  // ~2400-char serialized budget; truncations counted (minimised/truncated in metadata)
}
```

`readText()`/`classify()` and `runChatAgent` consume a `ModelContext` from §8 item 0 onward. WP0 ships `chat-session.ts` (CRUD, chart-context transitions, pending-first turn protocol, `buildModelContext`, sweep-on-access) and the two ops; nothing else grows session logic elsewhere.

### 3.4 Revision changes & repository switching (part of deviation D2)

Step 0 of the gate order (§8) applies this BEFORE routing — the reviewer's rule: invalidate old entity references before routing against the new revision:

- **Re-index, same repository:** the session and transcript **continue**; the ACTIVE chart context's `revision` advances to the current index in the step-0 tx, and its **referents are invalidated at that moment** — cleared from the active set (kept in a bounded `previouslyCleared` note, ≤12, purely for the audit/warning line) — while the breadcrumb frames stay as intent + question pairs whose *questions* remain routable on the fresh index (frames are not cached views; `viewId`s are display history). Routing therefore sees an EMPTY referent set: a pronoun after a re-index goes to clarify with the "before the last re-index" note, never to a stale-entity build. Warning: "Repository was re-indexed since your last message; N earlier references were cleared."
- **Repository switch (different `repoRoot` reaching a session):** explicit refusal, never silent: `kind:"message"` — "This conversation belongs to <repo>. Open a new conversation to continue on this repository." No silent anything; `openSession` remains the ONLY session creator (the no-implicit-creation rule already tested). The old session stays open with its transcript intact until closed or aged out.
- **Revision picker mid-session (UI switch to an older revision):** same rule as re-index — continue, invalidate, audit records the move.

### 3.5 Turn protocol: pending-first, model call outside the transaction (part of deviation D2)

Grounding: the `idempotency(key, payload_hash, receipt)` table exists (`store.ts:65`) and the header is enforced for mutating ops (`server.ts:179/197`) — but `C15/converse` is registered `mutating: false`, so conversation turns bypass it. The turn protocol makes converse's durability explicit, using `ChatTurn` rows (§3.3) rather than the generic table:

1. **Turn start — SHORT tx:** append the turn row `(sessionId, seq, idempotencyKey, payloadHash, state:"pending", attempt)` and advance seq; commit. No locks held beyond this.
2. **Model call — OUTSIDE any tx:** classifier/routing/chart generation/agent run with zero transactional state held. A crash here leaves a PENDING row and **no side effects** — by construction, because every state mutation (referents, breadcrumb, chart-context open/close, response text) is applied only in the completion tx.
3. **Completion — SHORT tx:** store response + `state:"complete"` + ALL chart-context side effects atomically.
4. **Retry with the same turn key** (`App.tsx` keeps the key until the response is acknowledged; retries re-send it, never a fresh one):
   - `complete` → **replay the saved response verbatim** — no model call, no duplicate assistant turn.
   - `pending` and FRESH (createdAt within `deadlineMs + 90s` grace AND same server process) → another attempt may be in flight → `VERSION_CONFLICT` (retryable; the client backs off and retries the SAME key).
   - `pending` and STALE (past the grace window, or the process restarted) → **recovery rule:** attempt N+1 (short tx: attempt++, fresh timestamp), re-run outside tx, complete in tx #2. Same seq, same key, zero duplicated side effects — they never existed.
   - Same key + different payloadHash → `CONFLICT`; the client mints a new turn.
5. Retention: receipts age out with the session policy; an aged-out turn re-executes as a new turn (documented, not an error).
6. Seq and the turn key do different jobs: **seq is ORDER** (one in-flight turn per session; a second concurrent key → `VERSION_CONFLICT`), **the key is REPLAY**.

---

## 4. Router changes — `packages/core/src/llm-router.ts`

WP2. Keep every existing legacy `Intent` variant and `INTENT_LABELS` (pin/boost/whyHidden/connected are map controls the spec doesn't cover — they stay).

1. Extend the union (`type Intent`, ~line 18):
```ts
| { type: "query"; intentId: number; confidence: number; target?: string }
| { type: "mapCommand"; label: string; target: string }   // produced by the deterministic gate (item 5, step 2); same shape the legacy label router returns
| { type: "newIntent"; detected: string; confidence: number; reason: string; origin: "ambiguous-referent" | "unsupported-query" }
```
2. `RouterModel` interface: add `classify?(req: { question: string; intentMenu: string; referents: { label: string; kind: string; level: number; source: string }[] }): Promise<IntentClassification | null>` — referents derive from the ACTIVE chart context loaded in step 0 (§3.3), post-invalidation.
3. `OllamaRouter.classify()`: same fetch pattern as `choose()`; local model → `format: INTENT_CLASSIFIER_SCHEMA` zod-JSON-schema equivalent (build a plain JSON-schema object mirroring it, like `recommendCharts` does); hosted → tool-call wrapper. `num_predict: 200`.
4. `ScriptRouter.classify()`: script values may be `IntentClassification` too; treat bare numbers as `{intent_id: n, intent: QUERY_INTENTS[n].intent, confidence: 1.0}`.
5. `readText()` order becomes (and WP6 moves the CALL above the chat-agent branch — §8 item 0 — so classification is never bypassed by `converse()`):
   1. `looksLikeTrace` → `investigate` (unchanged, first — traces are not questions).
   2. **Deterministic map-command gate — no model:** `nearest(text, mapCommandLabels)` over the existing `INTENT_EXEMPLARS` bank (same `HashEmbedder` as `similarForm`), same thresholds (score ≥ 0.32, margin ≥ 0.10). Hit → return the same legacy intent object the model path returns for that label (reuse the existing tail mapping); `target` from the label's exemplar convention. "pin charge" now resolves with zero model calls. Miss → step 3. (Guard: the gate only ever returns map-command labels, never a form label, so it cannot swallow repo questions like "how do I fix the boost logic" — that wording matches no map-command exemplar.)
   3. If `model.classify` exists and `!formsOnly`: run classifier (ledger referents attached). 1–34 id → `{type:"query", …}`. `new_intent` whose reason matches the map-command clause (belt-and-braces only; step 2 should have caught it) → legacy label router. `new_intent` otherwise → `{type:"newIntent", detected, confidence, reason, origin: reason-includes-"ambiguous-reference" ? "ambiguous-referent" : "unsupported-query"}` — user-visible clarify, NO SemanticMap fallback.
   4. Legacy label-router path unchanged — the fallback for installations without `classify` (older stub models, existing tests) and for a classifier that refuses.
6. Delete `FORM_LABELS.GeneratedChart`'s "a chart type… that is not in the gallery" phrasing → replace with `"a named standard chart or diagram type (S1–S29)"` (the free-design exit is removed; see WP6 deletions). Keep the label itself: it is the compilation form for all S-codes.

---

## 5. Intent → view dispatcher — new `packages/core/src/query-router.ts`

WP3. New file. Two exported functions, in this order of use:

```ts
/** §3.2 — the ONLY anaphora resolver of record (§3.2.1). Pure; no model call inside.
 * Returns a typed ReferentRecord winner, "ambiguous" (caller must surface the clarify menu
 * with origin "ambiguous-referent"), or null (caller hands to clarification; stale candidates
 * — record.rev ≠ current revision or entity not CURRENT — are excluded and reported). */
export function resolveReferent(text: string, ledger: ReferentRecord[], currentView?: ViewSpec | null, selection?: string[]): ReferentRecord | "ambiguous" | null;
```

and then:

```ts
export interface QueryPlan {
  intentId: number;
  chartCode?: string;        // S-code → GeneratedChart pipeline
  form?: string;             // V-form → built-in builder
  question: string;          // the user's text, possibly enriched with the resolved subject
  subject?: string;          // resolved file/entity name for subject-bearing intents
  because: string;
}
export function planQuery(
  intentId: number, target: string | undefined,
  mentions: { resolved: { text: string; matches: { entityId: string; name: string; file: string; kind: string }[] }[]; unresolved: string[] },
): QueryPlan | null   // null → caller must alert new_intent / ask for clarification
```

Rules (all grounded in existing machinery — do not invent new matching):
- Subject resolution for `moduleOrService|dataModelOf|action|flow|method|entity|classOrMethod|item`: reuse `resolveMentions()` output. Exact-name match wins (`m.matches[0]`); else if `resolved` has any match whose `kind` fits the intent (`method`↔function/method; `entity`↔state-bearing entity from S3/S24 fixtures; `moduleOrService`→ reuse `namedComponentFolder()` from chat-agent.ts — move it to query-router.ts and import it in chat-agent.ts to avoid duplication). No match → return `null` with `because: "the named element is not in this codebase"`.
- `repo`-subject intents ignore target/mentions.
- Question string: for subject intents, `question = subject` if resolved (this matches the existing seed-question practice in chat-agent.ts: the element's own name is a sharper retrieval question than the full sentence), else the raw text.
- Intent 6 (entry point): find seed via `svc.store.entities(rev.id)` filter `name in ("main","index","app","server","Application","App")` kinds function/method/class — same approach S21 already uses for roots (see `chat-tools.ts` read_module / calls-evidence).

---

## 6. `S29` Control-Flow Graph — contract registered, compiler **deferred** (deviation D4, WP4)

**Why deferred (reviewer ruling #2, accepted):** branch-condition facts and call/throw facts do **not** determine basic blocks, fall-through edges, joins, loop back-edges, or exception paths. A `compileCfgV2()` built only on them (the original plan) would produce plausible-but-invented topology — a direct violation of the chart-rendering requirements ("Never invent relationships") and the parity doc's warning that notation must not be presented as implemented. A real CFG requires a new analyzer that extracts basic-block structure from the AST — an indexing-project feature deliberately out of this plan's scope.

Contract (paste into `packages/schema/src/index.ts` after the `S25` variant):

```ts
/** S29 — control flow graph */
const ChartOutputV2Cfg = z.object({
  ...chartV2Base,
  chartId: z.literal("S29"),
  blocks: z.array(z.object({
    id: z.string().max(200), label: z.string().max(200),
    kind: z.enum(["entry","exit","statement","decision"]), evidenceIds: z.array(z.string()).max(20),
  }).strict()).max(60),
  jumps: z.array(z.object({
    from: z.string().max(200), to: z.string().max(200),
    kind: z.enum(["fallthrough","branchTrue","branchFalse","jump","exceptionExit"]),
    label: z.string().max(200).optional(), evidenceIds: z.array(z.string()).max(20),
  }).strict()).max(120),
}).strict();
```

Add to the `ChartOutputV2` discriminated union. **Nothing emits this contract yet; the type is registered so a future compiler slots in without a breaking change.**

**What WP4 does (0.25d):** (1) register the contract above; (2) registry metadata per §2 (id/name/aliases/form + `compiler: "missing"`, no `SPECIALIZED_CHARTS`/`OFFLINE_DERIVED_CHARTS` membership); (3) the honest-routing short-circuit: `askView` on a `compiler === "missing"` chart returns the existing "chart compiler is not implemented yet" reason with NO model call and NO generic-chart fallback (that path is deleted, §10); (4) parity copy: #29 stays "Partial (S2; S7)" per the report.

**Routing consequence:** intents 12/15 keep `primaryChartIds ["S2"]` (the parity doc's own closest-view mapping — S2/S7 are documented approximations); when the analyzer lands, `S29` becomes their first entry and level 4's second chart (§7).

**Future-analyzer gate (recorded, not built):** the compiler activates only when `packages/core`'s indexer emits CFG facts per function-like entity — basic-block boundaries; edges for fall-through, both branch directions, joins, loop back-edges, and exception exits — each evidence-backed. Until then `compileCfgV2`, the `S29` prompt hint, and "Allowed chartId values: S1–S29" in `CHART_CREATOR_PROMPT_V2` are all deliberately NOT written — the prompt's allowed-value list stays `S1–S28, generic` in this plan.

---

## 7. Zoom map + choice menus — new `packages/core/src/zoom-map.ts` (WP5)

Implements spec §4/§5 over CIE codes:

```ts
export const ZOOM_LEVELS: { level: 0|1|2|3|4|5; chartIds: string[]; label: string }[] = [
  { level: 0, chartIds: ["S27"],          label: "Whole system + external actors" },
  { level: 1, chartIds: ["S1","S17"],     label: "Major modules / services" },
  { level: 2, chartIds: ["S16","S23"],    label: "Classes / services inside a module" },
  { level: 3, chartIds: ["S21","S20"],    label: "Methods & collaborators" },
  { level: 4, chartIds: ["S2"],     label: "Detailed behavior of one method" },   // S29 joins when its analyzer ships (§6/D4)
  { level: 5, chartIds: ["SOURCE"],       label: "Actual implementation (deepest)" },
];
export const SIDE_ZOOMS: { concern: string; intentId: number; chartIds: string[] }[] = [
  { concern: "data model",   intentId: 9,  chartIds: ["S9"] },
  { concern: "state",        intentId: 16, chartIds: ["S24","S3"] },
  { concern: "concurrency",  intentId: 19, chartIds: ["V10"] },
  { concern: "failure",      intentId: 21, chartIds: ["S12","S25"] },
  { concern: "decisions",    intentId: 18, chartIds: ["S11"] },
  { concern: "tests",        intentId: 27, chartIds: ["S5","V12"] },
  { concern: "performance",  intentId: 29, chartIds: ["V17"] },
];
export function zoomLevelOf(chartIdOrForm: string): number;         // V5,V10,V17 → 2 (projected maps)
export function zoomInTargets(view: ViewSpec, nodeId: string): { intentId: number; chartId: string; question: string }[];  // by node kind: class→S16/S21, method→S29/S21, module→S17/S23, system→S27/S1...
export function choicesFor(view: ViewSpec, focusNodeId: string | undefined): Choice[]; // ≤6, ends with {key:"F", label:"Something else…"}; categories per spec §5 tables (service vs method vs data focus)
export function sideZoomChoices(view: ViewSpec): Choice[];
```

`Choice` and breadcrumb types go in `packages/schema/src/index.ts`:

```ts
export interface Choice { key: "A"|"B"|"C"|"D"|"E"|"F"; label: string; /** fully-formed text the client re-sends via converse */ question: string; intentId?: number; chartCode?: string; }
export interface BreadcrumbFrame {
  referent: ReferentRecord;   // the typed anchor: entityId, label, kind, level, turnSeq, rev (§3.2) — NOT a bare label
  intentId: number; chartCode: string; question: string; viewId: string;
}
```

Key rule to enforce (write as a test assertion): **every `zoomInTargets`/`Choice.question` must resolve to intent 1–34 and a chart that exists in `CHART_REGISTRY`** — no orphan views. Depth rule: the level-4 chart (`S2`) offers source deep-link as its single zoom-in (`question` = the method name, handled by the existing `C11/conceptCode` code view; when S29's analyzer ships, §6/D4, S29 joins level 4 and shares the rule); level 5 has no zoom-in.

---

## 8. Service integration — `packages/core/src/service.ts` (WP6)

0. **Reorder `converse()` — the routing decision moves ABOVE the chat-agent branch.** Today's order (`runChatAgent` first, `readText()` after, chart-rank after that) makes any classifier placed inside `readText()` bypassable for every `converse`-capable router. New gate order:
   0. **Session + chart-context resolution (§3.3/§3.4):** `sessionId` present → load `ChatSession` (actor/tenant check, `NOT_FOUND`/`ACCESS_DENIED`) + its ACTIVE `ActiveChartContext`; run the §3.4 reconciliation FIRST (revision changed → invalidate the context's referents, mark breadcrumb frames reference-stale, advance revision — all BEFORE any routing); run the §3.5 pending-turn replay/recovery check; treat the server transcript as authoritative (client `history` ignored). Absent → **stateless mode**: ephemeral in-memory chart context, loud warning attached, routing otherwise identical. Everything below reads referents/breadcrumb from this step only.
   1. `explicitChartCode(text)` — unchanged (explicit chart pick → chart path).
   2. `looksLikeTrace(text)` — unchanged → investigate.
   3. **Deterministic map-command gate** — `readText()` step 2 (exemplar similarity, no model).
   4. **`model.classify`** with ledger referents attached → `"query"` / `"newIntent"{origin}` readings.
   5. Legacy `readText()` label path — fallback when the classifier/model is missing or refuses.
   6. **`runChatAgent` LAST — demoted from router to prose writer.** It runs only for (a) query intents whose question wants prose alongside the chart (the visual is already decided; `AgentRequest` gains `predecidedView?: ViewSpec`, and `chat-agent.ts`'s default-map fallback — "if (!env.results.some(r => r.view))" — attaches the router's view instead of building `SemanticMap`; its system prompt gains "the visual is already decided; do not build views"), and (b) unsupported-query clarifies (best-effort prose attempt with the clarify alert still attached — the agent only adds words, never a visual). Map commands, traces and explicit chart picks never reach the agent. The model context the agent receives is `buildModelContext(session)` (§3.3) — the client-supplied `history` is used only in stateless mode.

Map the (now pre-classified) intents in the existing `switch (intent.type)`:

   - `case "query":` → `const plan = planQuery(intent.intentId, intent.target, resolveMentions(...));`
     - `plan===null` → `kind:"message"`: *"I couldn't find \u201c{target}\u201d in this codebase."*
     - `chartCode=plan.chartCode` → same path as today's `case "ask"` with `chartCode` (call `this.ask(..., {chartCode})`), then **attach menu**: result becomes `asChoices(r, intentId)`.
     - `form=plan.form` (V-views) → call the form path exactly as `executeChatPlan`/`analysis` does (reuse `visualByForm` + `C19/ask` form plumbing in `askView`).
     - intent 26 (`Inspect the actual source`): `chartCode:"S16"` + `answer` carrying `C11/conceptCode` content; subject required.
     - intent 31 (zoom into item): route through **zoom-map** (below), not `planQuery`.
   - `case "newIntent"` → one switch target; `origin` decides the `kind:"clarify"` shape (§3.2 1c): unsupported-query → `{kind:"clarify", message, origin:"unsupported-query", detected:{intent, confidence, reason}, suggestions: nearest3(text)}` (`nearest3` = existing `llm-router.nearest(text, FORM_LABELS)` top-3 labels rendered as suggested questions, never auto-rendered); ambiguous-referent → the `resolveReferent()` menu: `{kind:"clarify", origin:"ambiguous-referent", options: ledger candidates lettered, each option's question = original query + candidate label}` + mandatory "Something else". Map commands never arrive here (deterministic gate, item 0.3).
2. **Zoom becomes server-side navigation** (replaces `case "zoom"` returning a bare `{kind:"zoom"}`):
   - `zoomIn {target}`: focus node = exact label/entityRefs match in current `view` (same exact/endsWith matching as the `pin` case at ~2605). `zoomInTargets(view, focus.id)` from zoom-map. Render the **first target's** chart via the intent path above; push `BreadcrumbFrame` (current view+intent) onto the per-conversation breadcrumb store; response: `kind:"view"` + `menu` of remaining targets as `Choice[]` + `breadcrumb`.
   - `zoomOut`: pop breadcrumb; re-render previous intent/chart from the stored `question`; response with its choice menu.
   - `{direction:"overview"}` (intent 33): render `S27`. Keep `kind:"zoom"` ONLY for this reset case so `App.tsx` legacy path stays functional.
   - Breadcrumb store: extend `ContextSnapshot` (`packages/core/src/context.ts`): `zoomLevel: number|null` stays (compat with `interactions.ts:107`), add `breadcrumb: BreadcrumbFrame[]` persisted via the existing `action:"ZOOM"` event — encode `value` as `JSON.stringify({breadcrumb})` when present (readers that `Number(e.value)` must branch on `typeof e.value === "string"`; update `context.ts:116` and `packages/model/src/stub.ts`/any `ZOOM` readers — `rg -n 'ZOOM' packages/ apps/` to catch all).
   - `interactions.ts:107–108` (C21 followUp zoom): leave numeric-level behavior; it is the on-canvas semantic zoom, not chat navigation. Add a code comment saying so.
3. **`asChoices(r, intentId)`** helper: wraps an ask() result → `{kind:"view", view, claims, message, menu: choicesFor(view, focusNodeId), breadcrumb}` (schema: add `menu?` and `breadcrumb?` to the `view` variant ONLY — additive; ambiguity/clarification is its own `kind:"clarify"` variant (§3.2 1c), never fields bolted onto `message`).
3b.1 **Ownership (§3.2.1) — exactly one resolver of record.** `resolveReferent()` in `query-router.ts` is the ONLY component allowed to bind a pronoun. Everyone else only *produces* antecedents; nobody else interprets them:

- **Producers (write-side, no interpretation):** render paths (`asView`/`asChoices` — view render + cite ids), chat agent (answer `cited` ids), web client (FOCUS/SELECT via existing `C21/resolve`), zoom navigation (breadcrumb frames, WP6).
- **Consumer/decider (read-side):** `resolveReferent()` — the responsibility ladder below, deterministic except for one step.
- **Tie-breaker of last resort: the user**, via the `kind:"clarify"` result (§3.2 1c). **The model never decides a pronoun binding.** It may only *confirm* a deterministic candidate (echo its label as `target`, D1c) or return `ambiguous` / `new_intent`. Rationale: the local router model is a 0.6B-class model (see `docs/eval-tiny-models.json`) — precisely the component least reliable at coreference, and the repo invariant (never silently guess) forbids using it as the decider.

Resolution ladder (first stage that yields a winner WINS; each stage's failure is an explicit handoff to the next):

| # | Stage | Owner | Input | Yields | On failure |
|---|---|---|---|---|---|
| 1 | Name binding | `resolveMentions()` (mentions.ts) — NOT anaphora | raw text | target entity | no names → hand off if anaphoric marker present, else normal path |
| 2 | Current-screen binding | `resolveReferent` tier A | req.view + req.selection + focus | the focused/selected node | no selection/focus → tier 3 |
| 3 | Same-level recency (last turn) | `resolveReferent` tier B | ACTIVE chart context's referents (§3.3), restricted to the context's current level | top if UNIQUE at that level | tie → tier 4; empty → tier 5 |
| 4 | Cross-level explicit binding | user (menu) | ledger frames at other levels, labeled with level | user's menu pick (their reply names the element → becomes tier 1) | user declines → clarification, no render |
| 5 | Clarification | `converse()` | `kind:"clarify"` (options + "Something else") | — | — |

3b.2 **Multiple "its" at various levels (§3.2.2) — the ledger is level-scoped, not a flat last-pointer.** Structure: one frame per rendered turn `{entityId, label, kind, level (from zoom-map `zoomLevelOf(chartCode)`), turnSeq, source}`. Rules:

- "it" normally binds to the current level: the subject of the topmost frame whose `level` equals the level of the current/just-rendered view.
- Zooming down then back up keeps each level's own subject intact (the ledger IS the breadcrumb: `BreadcrumbFrame` embeds its `ReferentRecord`, §7 — one structure, no second stack).
- Switching levels is always an **explicit** act (zoom-in on a named element, zoom-out, side-zoom). A bare "it" never silently hops levels — a pronoun from an older level surfaces only through the tier-4 menu, labeled by level, e.g. **A. ReserveService (class view)** vs **B. the reserve flow (method detail)**.
- Two "it"s inside one message binding to different referents ("zoom into it and then show its data model") = **two subjects in one message** — out of scope by design (the 34-query set is single-subject); reply with the clarification menu asking them to split it. The single-subject forms in `intents.ts` (`subject: "item"` etc.) make this a schema-level assertion, not an ad-hoc rule.

3b.3 **Ambiguity arbitration (§3.2.3) — margin rule + fixed candidate ranking.** When tier 3 finds n>1 same-level candidates they are ranked by a fixed score, reused from the existing idiom in `readText()` (`similarForm`: `best.score - next.score < 0.10` → no pick): `score = recency(turnSeq, halved per older turn) + sameLevel·2 + kindMatchesIntent·2 + selectionBoost·1.5 + C12 frequent count`. Top-1 wins **only if** it beats runner-up by ≥ the same 0.10 margin; otherwise tier 4 (menu). Two special collisions get file-qualified labels in the menu (they are real ambiguity, not anaphora):

- Same-name classes in different files (mentions.ts already yields several matches — the `pin` case in `service.ts` shows the exact/endsWith pool matching precedent; menu options append `(file path tail)`).
- Ledger `rev` ≠ the current revision id, or the entity id not CURRENT in the bundle (ledger older than the last re-index) → stale, excluded, honest note: *"that was before the last re-index; name it again."* (`ReferentRecord.rev`, §3.2, is the authoritative check — event age is not.)

All arbitration is pure and unit-testable — no model call inside `resolveReferent()`. The classifier's D1c role stays confirmation-only: if the model's `target` echoes a ledger label, proceed; if it echoes something else or `ambiguous`, drop to the menu. Log every binding through the existing audit (`svc.store.audit(... "chat.tool" ...)` pattern) with `{resolvedFrom: source, confidence: "heuristic"|"confirmed"}` so a wrong binding is diagnosable from the trace.
4. **Default starting views (spec §7)**: in `converse()` when there is no view and no revision yet → unchanged error. When a revision exists:
   - intent 1 / 33 → `overview()` modified: instead of forced `SemanticMap`, render `S27` (C4 context) then `S1` as the second result (`results` array already supports multiple analyses via chat-agent shapes — simplest: `ask()` twice, concat `ChatAnalysisResult[]`).
   - intent 2 → `S1`; intent 3 → `S17`; single-file subject present → `S16` + `S21` pair.
   - Keep the existing SemanticMap fallback **only** behind intent-null + no new_intent (legacy no-model path).
5. **`recommendCharts()`**: keep the endpoint (insights panel uses it) but the option list passed by web must now exclude the deleted generic category (WP7) — web passes options, so only a web-side filter changes (see WP8).
6. **Catalog copy** (`visuals.ts` V-entries and `VisualsGallery.tsx` SYSTEM_CHARTS): add spec catalog numbers, e.g. S1 blurb gains `Covers catalog types 2 (component), 4 (deployment), 5 (hexagonal) — partial approximations; see chart-parity-and-completion.md`. Do not claim dedicated where the parity doc says partial (reviewer invariant).

---

## 9. Web changes (WP7)

1. **`apps/web/src/App.tsx`**:
   - `case "view"` (~489): if `v.menu?.length` → store `lastMenu` state; render breadcrumb chips (`v.breadcrumb`). Clicking chip i → `send(breadcrumb[i].question)` (converse), chips after current hidden.
   - New: `kind:"clarify"` handling in ChatPanel — `origin === "unsupported-query"`: banner with the detected intent + confidence + reason + suggestion chips (each re-sends its text via converse); `origin === "ambiguous-referent"` / `"stale-referent"`: option buttons with the same lettered-menu UI as `view.menu` (+ "Something else"). No auto-render, no silent fallback. Map commands need no new UI: they resolve deterministically server-side (gate) and return legacy result kinds.
   - `case "zoom"` (~496): keep, but only the server sends `{direction:"overview"}` now; change handler to `setLevel(DEFAULT_LEVEL)` + re-ask C4 context? — No: server already returns the rendered S27 as a `view`. Reduce the case to just `setFitTick` + message (no ±1 for `in`/`out`; drop them from the union if server no longer emits — **verify `rg -n '"zoom"' packages/core/src/service.ts`**, only the overview emit must remain).
   - Letter-key handling: menu clicks send `question` (not the letter); letters are display-only labels. If user types "A" in chat with `lastMenu` present → map to its `question` client-side. No server state needed.
2. **`apps/web/src/ChatPanel.tsx`**: render `menu` as a list of buttons beneath the assistant message (`A. {label}`); render breadcrumb strip above the canvas (reuse existing panel chips CSS, `styles.css` `.chip`); new `.choice-menu` + `.breadcrumb` styles (extend `zoom.css`).
3. **`apps/web/src/VisualsGallery.tsx`**: group the SYSTEM_CHARTS list under the spec §2 family headers (Structural / Behavioral / Data / Concurrency / Code-level / Quality) using the §2 map table; per-entry catalog numbers; delete the "All 35 standard diagram types are covered" sentence and replace with per-status labels (dedicated/partial per `docs/chart-parity-and-completion.md`).
4. **`apps/web/src/api.ts`**: no signature changes (types flow from `@cie/schema`). If `C15/classify` (debug op, optional) is added in `server.ts`, add a thin `classify()` helper for the eval UI only.

---

## 10. Deletions (WP9 — do LAST, after the full §11 suite (WP8) passes)

| # | What to delete | File(s) | Why |
|---|---|---|---|
| 1 | `ChartOutput` (chart.v1) schema + `SCHEMA_CHART` export + v1 branches in `chart-creator.ts` (`chartPlanCacheKey` else-branch, `ChartOutput.safeParse` paths, v1 `chartCreatorRequest`) | `packages/schema/src/index.ts`, `packages/core/src/chart-creator.ts`, fix compile sites in `service.ts` (`callModel<ChartOutput>` → `<ChartOutputV2>`) | v2 covers every chart; two pipelines invite silent divergence. Spec: every chart must come from the typed registry |
| 2 | `"generic"` ChartId + `ChartOutputV2Generic` + `ChartOutputV2GenericFallback` usages (S1,S2,S5,S6 keep their standard path via v1→ replaced by explicitly-typed generic variants for those four ids only, if any compile site needs them — otherwise delete all four fallback consts) | `packages/schema/src/index.ts`, `chart-creator.ts` `CHART_CREATOR_PROMPT_V2` "Allowed chartId values" | "No orphan views": free-designed generic charts are removed; S29 completes coverage |
| 3 | Free-design exemplars `"draw a sankey diagram…", "make a chart type that is not in the gallery", "create a custom visual…"` | `packages/core/src/route-exemplars.ts` `EXEMPLARS.GeneratedChart` | Same rule |
| 4 | `INTENT_LABELS.zoomIn/zoomOut` + `EXEMPLARS`/`INTENT_EXEMPLARS` for them + `Intent {type:"zoom", direction}` variants for in/out | `packages/core/src/llm-router.ts`, `route-exemplars.ts`, `service.ts` case | Replaced by intents 31/32; keep `new_intent` fall-through so legacy `zoomIn` messages still classify (the classifier prompt's map-command clause) |
| 5 | `case "zoom"` ±1 handling in `App.tsx:496` (after #4) | `apps/web/src/App.tsx` | Server-side navigation replaces camera nudge |
| 6 | `docs/eval-*` only if superseded — **do not delete**; add `docs/eval-intent-classifier.json` alongside | — | n/a |

Each deletion needs its regression test flipped (see WP10) before the code removal lands — delete in one commit per row, `npm test` green between commits.

---

## 11. Tests (WP8) — every work package carries its own tests; the full suite here gates WP9

New/updated files:
1. `packages/core/test/intent-classifier.test.ts` (NEW):
   - **All 34 canonical queries** (spec §3 table, exact query strings): via `ScriptRouter.classify` fixtures → assert `intent.type==="query"`, correct `intentId`, and `chartForIntent(id)` resolves to a `CHART_REGISTRY` entry.
   - Confidence: ≥0.75 passes; 0.74 → `kind:"clarify"` with `origin:"unsupported-query"` and `detected` populated (no view built).
   - **Map-command gate (deterministic):** "pin charge", "why not ledger", "zoom out" resolve with a spy model recording ZERO `classify` calls; a repo question whose words resemble a command ("how do I fix the boost logic") must NOT hit the gate (classifier runs; gate vocabulary excludes form labels).
   - **Classifier target validation (confirm-only):** subject-bearing id (5,9,12,14,18,22,24,26,31,34) with `target` omitted → ladder fallback, not a crash; `target` echoing a ledger label verbatim → used; `target` naming a NON-ledger element → ignored, clarify menu. (This is the D1c contract: the model confirms, it never decides.)
   - **Ledger versioning:** LEDGER event with `v:1` accepted and rebuilt by `snapshotAt`; `v:2` literal → discarded with a warning line, never parsed opportunistically; a session with zero LEDGER events yields an empty ledger → tier-5 clarify, not a crash.
   - Map-command leak: "pin charge", "why not ledger" must NOT become query intents (regression for the classifier prompt clause).
   - **Anaphora (§3.2):** two-turn scripts — (i) "show me ReserveService" → "zoom into it": assert referent resolves to ReserveService and the target view keeps that subject in `view.params.chatSubject`; (ii) "show the ledger module" → "show the data model" → "zoom into it": assert "it" binds to the data model (most recent ledger entry), not the module; (iii) two equally-recent modules then "zoom into it": assert `kind:"clarify"` with `origin:"ambiguous-referent"`, no view built; (iv) empty ledger then "explain it": assert clarification message, no silent SemanticMap; (v) name-plus-pronoun ("zoom into it — I mean BatchService"): assert the NAME wins (`mentions.ts` outranks), regression in `route.test.ts`.
   - **Multi-level anaphora (§3.2.2):** show ReserveService (class, level 2) → drill to its S29 flow (level 4) → "zoom out" → "zoom into it": assert binds to ReserveService (level-scoped ledger), NOT the method frame; then from a method view say "it" referencing the class above → assert tier-4 menu with level-labeled options (A. ReserveService (class view), B. the reserve flow (method detail)); pick one → assert the reply resolves by name (tier 1) and ledger updates.
   - **Arbitration (§3.2.3):** two same-level candidates with margin ≥0.10 → deterministic single winner, no menu; margin <0.10 → menu. Same-name two-class collision → menu with file-qualified options. Stale ledger entry (re-indexed since) → excluded with honest note. Confirm-only classifier: model target ≠ ledger label → menu, never the model's pick.
   - **Sessions (§3.3/§3.4/§3.5):** `openSession` mint → referents persist across turns (same `sessionId`) → `closeSession` → `NOT_FOUND`; wrong actor → `ACCESS_DENIED`/`NOT_FOUND` (foreign-tenant indistinguishable); secret pasted → withheld (`detectSecret`, mirrors QUERY events); 200-turn session → `buildModelContext` ≤ budget AND still ≤6 turns (older turns are transcript-only). **Topic transitions:** "show me BookkeepingService" → "show me the billing module" → context re-opened (`closedReason:"topic"`, referents empty); old-context element NOT resolvable by "it" (menu/clarify, never a stale bind); transcript intact; "zoom into it" immediately after a topic change without a new subject → clarify, not the OLD context. **Revision invalidation:** re-index mid-session → step 0 clears referents before routing → "it" → clarify + "before the last re-index" note, no stale-entity build; breadcrumb zoom-out still works (question re-routed on the fresh index). **Pending protocol (§3.5):** kill the model call mid-turn → row stays `pending`, ZERO side effects (referents/breadcrumb unchanged); retry same key while fresh-pending → `VERSION_CONFLICT` retryable; retry after grace/simulated restart → recovery re-execution, same seq, attempt+1, no duplicate assistant turn, chart-context effects applied exactly once; same key + different body → `CONFLICT`. **Stateless mode:** no `sessionId` → routing works, referents empty, warning present; `sessionId` unknown → `NOT_FOUND` (no implicit creation); client `history` + server transcript both supplied → server wins (forged-history vector dead).
2. `packages/core/test/zoom-map.test.ts` (NEW):
   - For every chart at every level: `zoomInTargets` non-empty (except level 5), each target's chart exists, each target's intentId ∈ 1–34 (**orphan rule**).
   - `choicesFor` ≤6 entries, last = "Something else…", categories match spec §5 (service → A: method flow, B: data, C: concurrency, D: failure, E: decisions, F: else; method → A: step-by-step, B: decision, C: state, D: race, E: compensation, F: tests + else; data → A: full ER, B: readers/writers, C: lifecycle + else).
   - Breadcrumb roundtrip: zoom in ×3 → frames length 3 with descending levels; zoomOut ×3 → back to level-0 chart.
3. `packages/core/test/chart-creator.test.ts`: S29 is schema-accepted by the `ChartOutputV2` union and `CHART_REGISTRY.S29.compiler === "missing"`; `askView` on S29 returns the honest not-implemented error with NO model call and NO generic fallback. (Compiler tests — blocks/jumps evidence gates, cache-key version bump, legend entries — ship WITH the deferred compiler, §6.)
4. `packages/core/test/route.test.ts`: extend, don't break — existing assertions for legacy labels stay green (WP2 keeps them); add: unknown question + no classifier → **legacy fallback unchanged**; with classifier → `clarify` (origin "unsupported-query").
5. `apps/web/test/e2e/zoom.test.ts`: menu click → new chart renders → breadcrumb visible → "Zoom out" restores; `test/e2e/levels.ts` helpers unchanged; add: session created on first message, `sessionId` present in every converse payload, breadcrumb survives page reload (server-side transcript), refresh mid-zoom-stack resumes at the same breadcrumb.
6. `packages/core/test/service.test.ts` (or `server.test.ts` where converse flows live): default starting views — "what does this whole repo do" → S27 view in results[0], S1 in results[1].

Run gates per work package: `npm run typecheck && npm test` (mono-command at repo root builds cargo + all TS suites).

---

## 12. Work-package order, deps, estimates

| WP | Scope (§ refs) | Depends on | Est. |
|---|---|---|---|
| WP0 | NEW — two-layer context (§3.3–3.5): `chat_sessions`/`chat_turns`/`chat_chart_contexts` migrations; `chat-session.ts` (CRUD, topic + revision transitions, pending-first turn protocol + recovery, `buildModelContext`, retention sweep); `C15/openSession` + `C15/closeSession`; `converse` `sessionId` (stateless mode + actor checks); web session + per-turn-key plumbing (App.tsx) | none | 2d |
| WP1 | `schema/src/intents.ts` (registry + prompt + schemas) | none | 0.5d |
| WP2 | `llm-router.ts` classify + intent variants; keep legacy green | WP1 | 1d |
| WP3 | `query-router.ts` planQuery + subject resolution | WP0, WP1 | 1d |
| WP4 | `S29` contract registration + honest-routing short-circuit (§6/D4); NO compiler build | none | 0.25d |
| WP5 | `zoom-map.ts` levels/targets/side-zooms/choices | WP1 | 1d |
| WP6 | `service.ts` integration (gate reorder + agent demotion, converse switch, ledger events, asChoices, overview) | WP0–WP5 | 2.5d |
| WP7 | web: App.tsx, ChatPanel.tsx, VisualsGallery.tsx, styles; recommendCharts option filter | WP6 | 2d |
| WP8 | Cross-cutting test sweep (§11 as a whole; route-sets/route-live expectation updates). Per-package tests were NOT deferred; this row only runs the assembled suite | WP0–WP7 | 0.5d |
| WP9 | deletions §10 (one commit per row) | all previous + green tests | 0.5d |
| WP10 | docs: re-baseline `chart-rendering-requirements.md`, `README.md`; reconcile `docs/chart-parity-and-completion.md` (status columns verbatim + its #26/#33 closest-view column with S25's/S26's existence); write `docs/eval-intent-classifier.json` | WP2, WP8 | 0.5d |

Definition of done: all 34 spec queries answered end-to-end with intent-classified chart + choice menu + working zoom-in/out/breadcrumb via chat; `new_intent` alert shown for out-of-scope questions (no silent SemanticMap); zero orphan views (test-enforced); the referent ledger and zoom breadcrumb resolve **only** inside a server-owned `ChatSession` (stateless callers get the degrade-loudly warning, never a silently empty ledger); chart.v1/generic path deleted; typecheck+tests green; parity docs updated with S29 and honest status labels.

---

## Appendix A — the spec, embedded (so this plan is self-contained)

### A.1 Chart catalog (spec §2, with CIE codes resolved per §2 of this plan)
Structural: 1 UML Class (`S16`), 2 UML Component (`S1`), 3 UML Package (`S17`), 4 UML Deployment (`S1`), 5 Hexagonal/Ports & Adapters (`S1`/`S15`), 6 Layered Architecture (`S22`), 7 C4 Context (`S27`), 8 Dependency/Module Graph (`S23`).
Behavioral: 9 UML Activity (`S2`), 10 UML Communication (`S18`), 11 UML Timing (`S3`), 12 UML Interaction Overview (`S19`), 13 Use Case (`S6`), 14 BPMN (`S7`), 15 Swimlane (`S2`), 16 Event Storming (`S8`).
Data: 17 ER (`S9`/`S4`), 18 DFD (`S10`), 19 Data Lineage (`V5`), 20 Decision Table (`S11`), 21 State Transition Table (`S24`).
Concurrency/Reliability: 22 Race Timeline (`V10`), 23 Petri Net (S3 approx.), 24 Saga/Compensation (`S12`), 25 Outbox (`S13`), 26 FMEA (`S25`), 27 Idempotency Matrix (`S14`).
Code-level: 28 Call Graph (`S21`), 29 Control Flow Graph (`S29` NEW), 30 CRC Cards (`S20`), 31 DI Wiring (`S15`).
Quality/Ops: 32 Test Traceability (`S5`/`V12`), 33 Metrics Dashboard (`S26`), 34 Threat Model (S10+V8), 35 Flame/Profiling (`V17`).

### A.2 The 34 queries (spec §3) — see the registry table in §3 of this plan for ids, charts, zoom targets, and subjects. Query examples verbatim:
A: 1 "What does this whole repo / project do?" · 2 "Show me the high-level architecture / components" · 3 "How is the codebase structured / organized?" · 4 "Show me the modules / services and their dependencies" · 5 "Zoom into [Module / Service / Package]" · 6 "What is the main entry point / how does the app start?"
B: 7 "What are the main entities / database tables?" · 8 "How does data flow through the system / this feature?" · 9 "Zoom into the data model of [Service / Module]"
C: 10 "Walk me through what happens when [action]" · 11 "Show the sequence / communication of this flow" · 12 "What are the possible paths / control flow of this method?" · 13 "Draw the use cases this system supports" · 14 "Zoom into the [method / function / flow]" · 15 "Explain this method step-by-step / line-by-line"
D: 16 "What are the states of [entity] and how do they change?" · 17 "Under what conditions does this succeed / fail?" · 18 "Zoom into the decision logic / guards of this flow"
E: 19 "Are there race conditions? How are they handled?" · 20 "Is this operation idempotent? What happens on retry?" · 21 "How does the system recover / compensate on failure?" · 22 "Zoom into the failure / compensation path"
F: 23 "Who calls whom / show the call graph of this" · 24 "What does this class collaborate with?" · 25 "How is dependency injection / wiring done?" · 26 "Zoom into the implementation of [class / method]"
G: 27 "Which tests cover the critical paths / invariants?" · 28 "What metrics / telemetry should I watch?" · 29 "Where are the performance hotspots?" · 30 "What are the security / trust boundaries?"
H: 31 "Zoom into [item]" · 32 "Zoom out / Go back / Show parent view" · 33 "Show me the high-level view again" · 34 "Zoom into the data / state / concurrency / failure side of this"

### A.3 Zoom levels (spec §4) → CIE codes
Level 0 `S27` → 1 `S1|S17` → 2 `S16|S23` → 3 `S21|S20` → 4 `S2|S29` → 5 source view (`C11/conceptCode`). Side zooms: data `S9` · state `S24/S3` · concurrency `V10` · failure `S12/S25` · decisions `S11` · tests `S5/V12` · perf `V17`.
Key rule: every zoom-in must land on a supported query (1–34). No orphan views.

### A.4 Choice menus (spec §5): confirm context → show primary chart → lettered menu ≤6 incl. "Something else"; breadcrumb kept for reliable zoom-out. Category templates per focus type as given in §11 test 2.

### A.5 Intent classifier (spec §6): the canonical prompt text is **committed in §3.1** (template + `{INTENT_MENU}` rendered from `QUERY_INTENTS` — implementation reads this plan only); output strict JSON; confidence ≥ 0.75 else `new_intent` with `reason`; never invent ids; never output prose. Deviations D1a (target field), D1b (chart codes in the menu lines) and the map-command clause are incorporated in the §3.1 template. The Downloads file is cited as origin only.

### A.6 Default starting views (spec §7): whole repo → `S27` + `S1`; single complex service/file → `S16` + `S21`; "what does this do?" → `S27` or high-level activity (`S2`); specific flow → `S2`/swimlane; data → `S9`; reliability → `S24`+`S14`.

### A.7 Design-doc combination (spec §8): for a complex flow produce the minimal set `S27, S28, S2, S9, S24, S14, S5` (structure, behavior, data, concurrency guarantees, test coverage). Ship as a downloadable/generated artifact in `packages/reporter/src/index.ts` (one new export, e.g. `flowDesignDocPack(viewHistory)`) — small, optional, non-blocking for WPs 1–9.

### A.8 Example interaction (spec §9): "What does this whole repo do?" → S27 · "Zoom into the Bookkeeping service" → S16/S20 + menu · "A" → S21/S2 of `reserve` · "Zoom into the balance check" → S29 · "Show the race condition handling" → V10 · "Zoom into the compensation path" → S12 · "Zoom out" → breadcrumb pop. Every step inside intents 1–34.