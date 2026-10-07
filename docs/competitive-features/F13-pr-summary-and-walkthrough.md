# F13 — PR summary and reading-order walkthrough

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §3–§4; builds on `F11-blast-radius-pr-check.md`. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree.
Priority P2. First deliverable: a deterministic, cited "what changed and where to start reading" section at the top of the PR comment, with no model required.

---

## 1 Purpose, user experience and status

### 1.1 Why

A PR summary and walkthrough is the most visible feature of the leading review bots: reviewers read it before anything else. CIE already has the underlying facts (`history.compare`, entity-level change kinds, test impact) and a grounded text composer (`answer.ts`), but produces no PR-level prose. It also holds a property the others cannot easily claim: the summary can be **checked against the code**, so it can say what the description mentions that the code does not touch, and what the code touches that the description never mentions.

The local model is small (project policy: installed Ollama models only). The design is therefore deterministic-first. A model may not be needed at all.

### 1.2 The experience

```
## What this PR changes                                           head a19a978 · analysed 2 min ago
11 files · 4 modules · 6 functions modified, 2 added, 1 deleted · 3 test files
Touches high-impact areas: auth/ (1 file), migrations/ (1 file)                       [why this label?]

### Start here (suggested reading order)
1. src/payments/commit.ts — `commit` now opens a transaction (modified)           ← the change the others depend on
2. src/payments/ledger.ts — `adjustBalance` gains an insufficient-funds guard (modified)
3. src/payments/api.ts — callers updated (2 call sites)
4. tests/commit.test.ts — 2 tests added, 1 test no longer reaches `commit()`

### The description versus the change
Author's description: "Make commit transactional; add insufficient-funds guard" (quoted, unverified)
- Changed but not mentioned in the description: `src/audit/log.ts` (modified)
- Mentioned but not changed: "retry on timeout"
```

Every line is derived from stored facts; every symbol links to its location. Nothing is a model's opinion about intent.

### 1.3 What "done" means

1. On a real PR the summary appears with the F11 comment (same marker, same update-in-place) and never exceeds its length budget.
2. Every sentence is produced from a template keyed to a fact kind (§7.2); a sentence with no backing fact cannot be rendered.
3. The description-versus-change check reports both directions and states that it matches names, not meaning (§7.5).
4. The reading order is reproducible: the same base and head give the same order on any machine (§7.4).

### 1.4 Status

Proposed. Depends on F11 slice 1 (the PR view returns its `changes` data).

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** counts and grouping of changed entities; high-impact-area flags; a reading order; test-change lines; the description-versus-change check; an optional call-change diagram; length budget; share-page expansion.

**Non-goals:** editing the PR title or description (the author's text is theirs; decision D2); stating the author's intent in CIE's own voice; a model-written narrative in the first release; line-by-line review comments (that is F11's items and F16's suggestions); commit-by-commit summaries.

**First delivery boundary:** the section above without the diagram, using only stored facts.

---

## 3 Current state in this repository

### 3.1 What exists

| Capability | Where |
|---|---|
| Entity-pair comparison with change kinds (ADDED, MODIFIED, DELETED, RENAMED) and text-diff counts | `history.ts` `compare()` (`entities`, `textDiff`); `diff-local-rename.test.ts` |
| Consequences, blast radius, test impact for a PR | `history.ts:93–160`, `pr-analysis.ts:482` |
| Changed-file list on the PR view | `PrAnalysisView.changes.files` |
| High-impact path classification (documentation / ordinary / auth, migrations, dependencies, CI, config) | `feature/tiers.ts` `classifyTier` |
| Name resolution of code-shaped words against the index, exact and fuzzy, with unresolved words listed | `mentions.ts` `resolveMentions` |
| Grounded text composer that orders points by importance and hedges by claim class | `answer.ts` |
| PR title and body ingest, marked untrusted | `connectors.ts` `PullRequest` |
| Dependency, lockfile and install-script review | `feature/dependencies.ts` |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | The PR view returns an empty `changes.consequences`, `blastRadius`, `testImpact` and `gaps` | `pr-analysis.ts:1015` (shared with F11 G1) |
| G2 | No PR-level prose or grouping exists; `answer.ts` composes from a `ViewSpec`, not a `ChangeSet` | `answer.ts` header |
| G3 | `classifyTier` is used for the feature pipeline only; the PR comment does not flag high-impact areas | `feature/tiers.ts` |
| G4 | No ordering of changed files for reading | no module found |
| G5 | `resolveMentions` runs on questions; it has not been applied to PR descriptions | `mentions.ts` |
| G6 | The PR comment (`gateCommentText`) has no top-of-comment overview | `pr-gate.ts` |

### 3.3 Not verified

- How well `resolveMentions` fuzzy matching behaves on prose PR descriptions (it was designed for short questions); needs a measured false-match rate.
- Whether `RENAMED` is produced for the PR path or only for local diffs.

---

## 4 Architecture and ownership

| Component | Responsibility |
|---|---|
| C23 History, semantic PR | Build `PrSummary` from the retained `ChangeSet` |
| C19 Representation | Order and group; produce the diagram spec |
| C16 Claim gates | `checkSummaryLine`: every sentence backed by a fact kind |
| C30 Exports | Render into the PR comment's first section; length budget |
| C03 Access | Denied paths counted, not named |
| C12 Salience | Reuse importance ordering for the reading order tie-break |

Data flow: `ChangeSet` (F11 S1) → `PrSummary` builder → template renderer → F11 comment section (same marker) and share page.

---

## 5 Reconciliation with existing contracts

- The summary is a **section of the F11 impact comment**, not a third comment, to respect the shared comment budget (study §7, risk 1). It has its own `<!-- cie-summary -->` sub-marker inside the comment so tests can find it.
- It adds `PrSummary` to the F11 `ImpactReport` (`summary?: PrSummary`); no change to the F02 gate comment.
- Claim classes: counts and change kinds are Fact (read from stored facts of both revisions); reading order and "start here" are Inference (a stated rule, not a proof); the description check is Inference, always labelled as name matching.

---

## 6 Data model

```typescript
interface PrSummary {
  schemaVersion: 1;
  counts: { files: number; modules: number; added: number; modified: number; deleted: number; renamed: number; testFiles: number };
  highImpact: { area: string; files: number; reason: string; patternId: number }[];   // from classifyTier patterns
  readingOrder: { rank: number; path: string; entityIds: string[]; note: string; why: ReadingFactor[] }[];
  tests: { added: number; removed: number; lostReach: string[] };
  description: {
    authorText: string;                // verbatim excerpt, escaped, marked unverified
    changedNotMentioned: { path: string; entityId?: string }[];
    mentionedNotChanged: { phrase: string }[];
    matchedBy: "NAME_MATCH";           // the only basis in the first release
  } | null;
  budget: { renderedBytes: number; truncated: boolean; omitted: number };
}
type ReadingFactor = { name: "DEPENDED_ON" | "ENTRY_POINT" | "CHANGE_SIZE" | "HIGH_IMPACT"; value: number };
```

No new tables; the summary is part of the stored `ImpactReport` canonical JSON (F11 §6.3).

---

## 7 Algorithms and rules

### 7.1 Grouping and counts

Counts come directly from `compare().entities`. Modules use the same module derivation as `overview.ts`. Counts are Fact and are never rounded or described with "about".

### 7.2 Sentences are templates over facts

A closed set of templates keyed by fact kind, for example `ENTITY_MODIFIED`, `ENTITY_ADDED`, `CALL_SITES_UPDATED`, `TEST_ADDED`, `TEST_LOST_REACH`. The text for a changed function names the symbol and the *structural* difference taken from `history.compare` (for example "now opens a transaction", "gains a guard that can throw") only when a consequence of that kind exists for it; otherwise the line is just "modified". The summary never describes behaviour it has no consequence record for.

### 7.3 High-impact areas

Run `classifyTier`'s pattern list over the changed paths and report each hit with its pattern id and reason. The comment says "touches", not "risky". The mapping from pattern id to a reader-facing label lives in one table.

### 7.4 Reading order

A pure function of the changed set and the call graph, with a fixed tie-break (path, then entity id):

1. Changed entities that other changed entities depend on come first (so a reader meets the definition before its callers).
2. Then changed entry points (routes, exported API) in the order of dependents.
3. Then the remaining source files, by descending change size.
4. Tests last, grouped under the source they exercise (`testImpact`).
5. High-impact files are pinned to a visible "also read" line, not reordered, so the order stays explainable.

The factors are shown in the share page ("why this order?"). All are `uncalibrated`; a reader may find a different order better, and the comment says the order is a suggestion.

### 7.5 Description versus change

1. Take the PR title and body as untrusted text; strip code fences and quoted replies.
2. `resolveMentions` the remaining text against the head index with the denied-path policy applied.
3. `changedNotMentioned`: changed entities and files with no mention in the text (module-level aggregation so one helper function does not generate noise; renames and test-only changes excluded).
4. `mentionedNotChanged`: code-shaped phrases that resolve to entities which are not in the changed set; unresolved phrases are listed separately and never claimed as missing.
5. The section states: "This compares names in the description with names in the change. It does not understand meaning, and a short description can be accurate without naming everything."

Suppression: if the description is empty or shorter than a threshold, the section says "no description to compare" and lists nothing.

### 7.6 Honest-label gate

`checkSummaryLine(line)` rejects: a sentence with no fact kind; any intent verb attributed to CIE ("this PR fixes", "aims to"); a counts line that disagrees with the stored counts; and any line over the budget. The author's text is only ever shown inside a quoted block labelled "Author's description (unverified)".

### 7.7 Optional diagram (slice 3)

A graph of changed call edges (added solid, removed dashed) for at most 12 nodes, rendered as a fenced diagram only if it fits the budget; node labels are escaped; the caption says "static call edges between changed functions; dynamic calls are not shown".

---

## 8 API contracts

`C23/getPrSummary {analysisId}` → `PrSummary` (read-only). `C30/previewImpactComment` (F11) includes the section. No new publish operation. The share page reads the same object.

---

## 9 States and lifecycles

Follows the F11 report lifecycle. A summary built from an INCOMPLETE analysis states that first and omits the reading order if the call graph for the changed set did not finish (a wrong order is worse than none).

---

## 10 Authorization, egress, threat model

1. No model call in the first release, so no egress.
2. Denied paths are counted, never named, in counts, reading order and the description check.
3. The PR title and body are attacker-controlled. They are only shown escaped inside a quoted block; they are never interpolated into a sentence template; `@mentions`, `#refs`, HTML comments and Markdown control characters are neutralised so the section cannot ping users or forge a marker.
4. Symbol and file names are also attacker-controlled and are escaped the same way, including inside any diagram label.
5. The author's description is never executed or followed; it is not passed to a model.
6. If a model is added later (decision D1), it may only choose among pre-built sentences or phrase one sentence per fact; every output is re-checked by `checkSummaryLine` against its fact.

---

## 11 Freshness, idempotency

Rebuilt for each analysis; replaced in the same comment on a push. A summary for a superseded head is not left in place. Rendering is deterministic: the same report hash renders byte-identical Markdown.

---

## 12 Interface specification

Placement: first section of the F11 comment, collapsed after the first screen if long. Copy rules: counts as numbers; verbs describe structure ("now calls", "gains a guard that can throw"); no "improves", "fixes", "refactors"; "Start here" is labelled a suggestion; the description check carries its limit sentence. Accessible text, no emoji-only status.

---

## 13 Performance and bounded work

Built from data already computed; the added cost is the reading-order sort and one `resolveMentions` pass. Budget: summary under 3 KB rendered; at most 12 reading-order lines (the rest counted and moved to the share page); at most 5 lines each in the two description lists. Cut sections are named.

---

## 14 Failure modes

| Failure | Behaviour |
|---|---|
| Very large PR (hundreds of files) | Counts and high-impact areas only; reading order limited to top 12; the rest counted |
| Empty or boilerplate description | "No description to compare"; no lists |
| Fuzzy name match is wrong | Labelled name matching; list capped; a muted kind (F15) removes it per repository |
| Rename detected as delete plus add | Counted as such if the index cannot pair them; stated in `gaps` |
| Call graph incomplete | Reading order omitted, reason stated |
| Docs-only PR | Single line "documentation only" from the T0 rule |

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | Run the description check and reading order by hand on 20 real PRs; record false matches and reviewer usefulness | NEW (spike script) |
| S1 | `PrSummary` builder, counts, high-impact areas, templates, `checkSummaryLine` | NEW `pr-summary.ts` + EXISTING_REUSE (`history.ts`, `tiers.ts`) |
| S2 | Reading order and description-versus-change | NEW + EXISTING_REUSE (`mentions.ts`, `salience.ts`) |
| S3 | Diagram, share-page expansion, "why this order?" | NEW + EXISTING_EXTEND (`PrPanel.tsx`) |

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F13-A1 | Counts equal `compare()` entity counts for a fixture PR; a mutated count is rejected by `checkSummaryLine` |
| F13-A2 | A changed function with no consequence record is described only as "modified", never with behaviour wording |
| F13-A3 | Reading order is identical across two runs and two machines for the same base and head |
| F13-A4 | A changed file in a denied prefix is counted, never named |
| F13-A5 | A PR title containing `@user`, `#1`, `<!--`, backticks and Markdown links produces no ping, link or marker forgery |
| F13-A6 | Description naming a symbol that was not changed appears in `mentionedNotChanged`; an unresolved phrase appears separately and is not claimed missing |
| F13-A7 | Empty description yields "no description to compare" |
| F13-A8 | A sentence with intent wording ("fixes", "aims to") attributed to CIE is rejected |
| F13-A9 | An INCOMPLETE analysis is stated first and the reading order is omitted when the call graph is incomplete |
| F13-A10 | Size budget: a large PR renders under the budget and names what was cut |
| F13-A11 | A docs-only PR renders the documentation-only line |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | May a model phrase any sentence | No in the first release; revisit with measured quality of the installed local model |
| D2 | May CIE edit the PR description | No. Only the bot's own comment is written |
| D3 | Summary inside the F11 comment or a separate comment | Inside, to keep one comment surface; revisit if length forces a split |
| D4 | Minimum description length for the comparison | Choose from S0 data, not by taste |
| D5 | Include the diagram | Only after S0 shows reviewers use it |
