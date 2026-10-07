# F11 — Blast Radius: the cited impact check on every pull request

Detailed design · Version 0.1 · 7 October 2026 · Proposed specification (nothing in this document is built yet)

Source: `Competitive_Features_Component_Implementation_Guide.md` §3, §14–§17, and `F02-pr-analysis-and-quality-gates.md`. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree of that day; every "exists" claim below names the file it was read in.
Priority P1 (distribution). First deliverable: one idempotent PR comment, generated from data CIE already computes, that states what the change could break, what is untested, and what CIE could not determine, with every line cited.

---

## 1 Purpose, user experience and status

### 1.1 Why this feature exists

CIE's strength is that it will not state anything without evidence you can open, and says "I can't determine this" instead of guessing. Today a developer only meets that after installing the product, indexing a repository and asking a question. A pull request comment is seen by every reviewer without anyone opening anything, so it is the one surface where the product can be *encountered*. F11 turns the existing semantic-diff, test-impact and risk machinery into that comment.

This is a **distribution wedge, not a new analysis engine**. The first slice must mostly connect results that already exist and are currently discarded (§3.2, gaps G1–G2). Any claim that this feature will make the product spread among developers is a hypothesis; §14 states how to test it before more is built.

### 1.2 The experience

| Reviewer asks | The comment delivers |
|---|---|
| "What can this PR break?" | Up to N ranked consequences ("`createPayment` now reaches `adjustBalance`, which writes `balance` outside a transaction"), each with a Fact / Inference / Hypothesis label and a link to the cited code |
| "What is untested?" | Changed symbols whose tests no longer reach them, and changed lines with no recorded coverage |
| "How far does it reach?" | Dependents per changed symbol, the files they live in, and which of them are hotspots or thinly owned |
| "What does CIE not know here?" | A **Fog** section: dynamic calls, unresolved framework wiring, languages or files not analysed, evidence that did not finish |
| "Why this and not something else?" | A "why not?" link per section that opens the in-app explanation (salience factors, or the specific reason an item was left out) |

Sketch of the comment (copy is normative in §12; layout is not):

```
## CIE blast radius — head a19a978                                   analysed 2 min ago · TypeScript 41/41 files
3 things worth a reviewer's attention (of 11 found; 8 below the noise threshold — why?)

1. INFERENCE  createPayment now reaches adjustBalance, which writes `balance` outside a transaction.   [evidence ▸]
2. FACT       payments.test › "rolls back on failure" no longer reaches commit().                       [evidence ▸]
3. HYPOTHESIS Two paths now write `balance` with no shared lock (race window, not an observed race).   [evidence ▸]

Reach: 4 changed symbols → 37 dependents in 9 files · 2 files are change-risk hotspots · 1 file has a single recent author
Not determined (Fog): 2 dynamic calls under src/queue/ · no coverage artefact for the head commit
Not a safety verdict. No finding is not "safe". Details and "why not?": <review page>
```

When nothing meets the threshold the check **does not comment** (§7.4). Silence is a designed outcome.

### 1.3 What "done" means for the user

1. Installing the check in a repository takes one workflow line plus, optionally, one policy file; no account, and no source text leaves the CI runner (§10).
2. On a real pull request the comment appears within the budget in §13, is updated in place on each push, and is superseded, never duplicated, when the head moves.
3. Every consequence in the comment carries a claim class and a resolvable citation. A comment line without one cannot be produced (§7.6).
4. On a held-out set of historical pull requests with a known later defect, the measured precision and recall of the surfaced items are published with their denominators (§14). The product does not describe the comment as accurate beyond that evidence.

### 1.4 Status

Proposed. Slice 0 (§15) must run before any other slice, because it decides whether the rest is worth building.

---

## 2 Scope, non-goals and first delivery boundary

### 2.1 In scope

- A **PR impact report** assembled from existing analyses over one base and one head (§7.1), ranked and thresholded (§7.3–7.4).
- A **comment renderer** with an enforced honest-label contract (§7.6, §12).
- A **headless runner** that executes the existing pipeline inside a forge CI job from a single command, so the check can be installed from a workflow file (§4.3).
- An **in-app share page** for one analysis, reachable from the comment, with the "why not?" explanations (§12.1).
- **Policy**: which sections run, the noise threshold, the maximum comment length, silence rules (§7.4), stored through the existing versioned gate-policy mechanism.
- A **retrospective evaluation harness** over historical pull requests (§14).

### 2.2 Non-goals (first release)

- No merge, approval, auto-fix or change request. The comment informs; the existing F02 gate remains the only blocking mechanism and F11 adds no blocking condition by default (§7.5).
- No new analysis engine. Where a section needs analysis that does not exist (§3.2, G5) it is a later slice, not a prerequisite.
- No model is required to produce or rank any consequence. A model may be used only to phrase text that is then re-checked against its citations; see decision D3.
- No hosted multi-tenant service, public gallery or badge in the first release (decision D5).
- No languages beyond those the index already supports (TypeScript, Rust, Nirdosha v2). Unsupported files are reported as Fog, not skipped silently.

### 2.3 First delivery boundary

Slices 0–2 in §15: the retrospective evaluation, the wiring of already-computed consequences/test-impact/blast-radius into the PR view, and the new comment renderer posted through the existing publisher. The Action/headless runner (slice 3) follows. Race, counterfactual, ownership and terrain sections (slice 4) are explicitly after.

---

## 3 Current state in this repository

### 3.1 What exists (observed)

| Capability | Where |
|---|---|
| Per-PR analysis job: checkout of base and head from the base repository, indexing, comparison, findings with baseline matching, test and coverage evidence, stale-head rejection | `packages/core/src/pr-analysis.ts` (`PrAnalysis`) |
| Semantic diff between two revisions: `CALL_ADDED/REMOVED`, `MODULE_COUPLING`, `TRANSACTION_BYPASS`, `TRANSACTION_RESTORED`, `WRITE_REACH_CHANGED`, `NEW_CYCLE`, `NEW_EXTERNAL_DEPENDENCY`, `ERROR_PATH_ADDED`, `TESTS_LOST`, each as a claim with evidence ids | `packages/core/src/history.ts` `compare()` (lines ~93–160); called from the PR job at `pr-analysis.ts:482` |
| Per-changed-symbol dependents (depth ≤ 4, test nodes excluded) with files | `history.ts:151` (`blastRadius`) |
| Per-changed-symbol test impact: tests lost, gained, unchanged | `history.ts:152–156` (`testImpact`) |
| Versioned, hash-addressed gate policy; pure `evaluate()`; waivers that never hide a finding | `packages/core/src/pr-gate.ts` |
| A `BLAST_RADIUS` gate condition | `pr-gate.ts:138` — informational only |
| Idempotent comment/status publication bound to the exact head; find-before-create; stale head ⇒ `STALE_REVISION`; only rule ids, counts, paths and line numbers leave | `packages/core/src/pr-publish.ts` |
| Updatable PR comment with disclosure section | `pr-gate.ts` `gateCommentText()` |
| Claim classes and display gates; provenance audit for visual forms | `claims.ts`, `claim-ledger.ts`, `visuals.ts`, README "sixteen visuals" |
| Race-window candidates (V10), removal counterfactual (V11), test-confidence (V12), ownership (V13), change-risk terrain (V16) | `twin-races.ts`, `twin-*.ts`, `overlays.ts`, `hotspots.ts` — per-revision, **not** wired to a PR (to be confirmed per symbol in the work package, §3.3) |
| A PR panel in the web app | `apps/web/src/PrPanel.tsx` |
| Forge access through the authenticated `gh` CLI | `gh.ts`, `gh-forge.ts`, `pr-publish.ts` (`githubRestTransport`) |
| Benchmark-script pattern for offline evaluation | `scripts/f01-bench.ts`, `scripts/f06-bench.ts` |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | The PR view returns empty `consequences`, `blastRadius`, `testImpact` and `gaps`, although the comparison that produces them has already run in the same job. The most valuable data is computed and then discarded. | `pr-analysis.ts:1015` (`changes: { files, consequences: [], blastRadius: [], testImpact: [], gaps: [] }`) against `history.ts:160` |
| G2 | The PR comment has no section for consequences, test impact or reach. Blast radius reaches the gate only as one integer, the maximum dependent count. | `pr-gate.ts` `gateCommentText()`; `pr-analysis.ts:784` |
| G3 | The only gate use of blast radius is informational and passes whenever evidence exists, so it can never warn. | `pr-gate.ts:138–143` |
| G4 | There is no way to run CIE inside a forge CI job. Publication assumes a locally running server and a developer's `gh` login. No workflow file or action definition exists in the repository. A webhook handler does exist (`C04/ingestWebhook`, `service.ts:1258`: HMAC-verified, replay-safe, handles `pull_request` opened/synchronize/reopened only and maps the repository by its local origin remote), but the gateway listens on loopback only and expects the signature headers and raw body wrapped in a JSON request, so GitHub cannot deliver to it directly; it is usable only behind a relay or tunnel the user sets up. | `pr-publish.ts` (`ghAuthToken`); `service.ts:1257–1305`; `server.ts:20` (`HOST = "127.0.0.1"`); no `.github/` directory; `package.json` scripts |
| G5 | Race windows, removal counterfactuals, ownership and terrain are not computed per pull request. Whether their inputs can be built from a base/head pair is unverified. | §3.3 |
| G6 | Nothing ranks consequences by importance or suppresses low-value ones. The F02 comment lists every introduced finding. A noisy first comment is the main adoption risk. | `gateCommentText()` lists all `introduced` |
| G7 | The "why was this shown / why not" explanation exists only inside the application; a PR comment cannot link to it. | `salience.ts`, `answer.ts`; no PR-scoped route |
| G8 | There is no measurement of how often the surfaced consequences correspond to real later defects. Every threshold would ship unmeasured. | no benchmark for PR consequences in `scripts/` or `docs/` |
| G9 | The publisher's egress rule ("rule ids, counts, paths and line numbers; no code text") does not say whether symbol names count. F11 comments need entity names to be readable. | `pr-publish.ts` header comment |

### 3.3 Not verified

These must be settled by locating the actual symbols and running them, as the guide requires (§16), before slices that depend on them:

- Whether `twin-races.candidateRaceWindows` can take its `writes`, `handoffs` and `lockOrders` from a changed-symbol set rather than a whole repository.
- Whether the ownership, terrain and test-confidence views have a per-revision function callable without the HTTP layer.
- The cost of `PrAnalysis` on a large repository inside a CI runner's time limit (no measurement exists).
- Whether `history.compare()` output is stable enough across runs that a comment diff between pushes is meaningful (ordering and ids use hashes of kind and text, which looks stable but is untested for this purpose).

---

## 4 Architecture and ownership

### 4.1 Responsibilities

| Component | Responsibility in F11 |
|---|---|
| C23 History, semantic PR | Owns the impact report: expose `compare()` output through the PR view; add the ranking input fields (§7.2) |
| C16 Claim verifier and display gates | Gate every comment line: claim class, citation resolvable, caveat present. Reject a line that fails (§7.6) |
| C18 Claim ledger | Store the report's claims bound to analysis id and head; supersede on push |
| C25 / C26 Security, concurrency analysis | Later slice: provide race-window candidates for the changed set |
| C27 Counterfactual | Later slice: removal consequences when a PR deletes a symbol or module |
| C12 Salience | Provide "why this / why not" for a ranked item and a suppressed item |
| C19 / C20 Representation and canvas | Compile the share page; reuse the review view components |
| C30 Exports and notifications | Publish and update the comment; length limits; stale supersession |
| C03 Authorization, egress | Decide what a comment may contain (G9); withhold denied paths by count |
| C07 Scheduler | Prioritise the current head; cancel superseded analyses |
| C17 Evaluation | Own the retrospective harness and the published denominators (§14) |
| C32 Operations, release | Package the headless runner; version the report schema; migration |
| C01 Client shells | Command-line entry for the runner; PR panel changes |

### 4.2 Data flow

```
forge event (push to PR)  ─►  headless runner  ─►  PrAnalysis (existing)  ─►  history.compare (existing)
                                                         │
                                                         ▼
                                         ImpactReport builder (NEW, C23)
                                          ├─ consequences  (EXISTING data, currently dropped)
                                          ├─ reach         (EXISTING data, currently dropped)
                                          ├─ test impact   (EXISTING data, currently dropped)
                                          ├─ fog / gaps    (EXISTING data, currently dropped)
                                          └─ later: races, removals, ownership, terrain
                                                         ▼
                                      rank + threshold  (NEW, §7.3–7.4)
                                                         ▼
                                  honest-label gate  (EXISTING C16, new rule set §7.6)
                                                         ▼
                              comment renderer (NEW)  ─►  GitHubCheckPublisher (EXISTING, extended)
```

### 4.3 Where it runs

The decision that most affects trust and adoption is where analysis executes. Recommendation (decision D1): **inside the repository's own CI runner**, started by one command, with the existing in-memory index, so source text never leaves infrastructure the team already trusts. This matches the product's local-first posture and needs no hosted service. A hosted mode is a later, separate decision.

Constraints that follow:

- The runner needs the base and head commits; the PR job already handles forks by fetching through base repository refs (`pr-analysis.ts`), so that logic is reused.
- Credentials: use the CI-provided token with the minimum scope (comments and statuses on the one repository). The existing transport reads a token at call time and never stores it; keep that property. A fork's pull request must not be given write credentials (§10).
- No model runtime is assumed in CI. Everything in slices 0–3 is deterministic.

---

## 5 Reconciliation with existing contracts

- **F02 is extended, not replaced.** The gate decision, policy, waivers and publication receipts keep their contracts. F11 adds an `impact` object to the PR analysis view and a second comment marker (`<!-- cie-gate:impact-comment -->`) so the gate comment and the impact comment update independently. Whether the two should be one comment is decision D2.
- **`PrAnalysisView.changes`** already has the exact fields (`consequences`, `blastRadius`, `testImpact`, `gaps`). Populating them is a compatible change; no schema break.
- **`GateConditionType`** gains nothing in the first release. Any new blocking behaviour requires a new, explicitly configured condition (§7.5) and a policy version bump, per the existing "unknown condition type is rejected at validation" rule.
- **Claim classes**: F11 uses the existing four (Fact, Inference, Hypothesis, Fog). It adds no fifth class.
- **Egress rule** (G9) needs a written amendment, not a silent reinterpretation (decision D4).

---

## 6 Data model

### 6.1 Identity

One impact report per PR analysis id (`analysisId`, already unique per base/head/policy/analyzer-set). A new push produces a new analysis; the earlier report is marked superseded and its comment is updated, not deleted.

### 6.2 Types (proposed, `@cie/schema`)

```typescript
type ImpactItemKind =
  | "CONSEQUENCE" | "TEST_IMPACT" | "REACH" | "RACE_WINDOW" | "REMOVAL" | "OWNERSHIP" | "TERRAIN" | "FOG";

interface ImpactItem {
  id: string;                       // stable: hash of kind + subject + text, as history.ts already does
  kind: ImpactItemKind;
  claimClass: "FACT" | "INFERENCE" | "HYPOTHESIS" | "FOG";
  text: string;                     // one sentence; produced by a template, never free text from a model
  subjectEntityIds: string[];
  evidenceIds: string[];            // non-empty unless claimClass === "FOG"
  citations: { path: string; startLine: number; endLine: number }[];
  rank: { score: number; factors: { name: string; value: number; weight: number }[] };
  calibration: "uncalibrated" | "calibrated";   // every score starts "uncalibrated"
  suppressed?: { reason: "BELOW_THRESHOLD" | "DUPLICATE" | "PATH_WITHHELD" | "LENGTH_BUDGET" };
}

interface ImpactReport {
  analysisId: string; headHash: string; baseHash: string;
  generatedAt: string; schemaVersion: 1;
  surfaced: ImpactItem[];           // what the comment shows
  suppressed: ImpactItem[];         // what it did not show, and why (feeds "why not?")
  reach: { changedSymbols: number; dependents: number; files: number; hotspotFiles: number; thinOwnershipFiles: number };
  coverage: { languages: { id: string; analysedFiles: number; skippedFiles: number }[]; evidenceComplete: boolean };
  fog: ImpactItem[];
}
```

### 6.3 Persistence

A single `impact_reports` table keyed by `analysisId` holding the canonical JSON and its hash, in the existing SQLite store (`store.ts`; the repository has one storage engine). The publication receipt table already records what was posted; add the report hash to the receipt so a comment can be traced to the exact report that produced it.

---

## 7 Algorithms and rules

### 7.1 Building the report

1. Run `PrAnalysis` as today. After `history.compare(base, head)` (`pr-analysis.ts:482`), keep the whole `ChangeSet`, not only the three aggregates now extracted at lines 777–784.
2. Map each `Consequence` to an `ImpactItem` (`CONSEQUENCE`), preserving `claimId`, `evidenceIds` and `displayMode`. Class mapping is fixed: a consequence derived from stored facts of both revisions is `FACT` only if every hop is statically proven; otherwise `INFERENCE`; anything crossing an async hand-off or dynamic call is `HYPOTHESIS`. The mapping is a table in code with a test per kind; it is not a heuristic.
3. Map each `testImpact` entry with `lost.length > 0` to `TEST_IMPACT`. Map entries with changed lines and no recorded coverage to a `FOG` item ("no coverage evidence for these lines"), never to a pass.
4. Build `reach` from `blastRadius`, joined with hotspot and ownership facts when present.
5. Build `fog` from `ChangeSet.gaps`, the analyzer records already stored (`analyzers[].coverage.skippedFiles`), and `unresolved.dynamicCalls`.

### 7.2 Ranking

A transparent weighted sum, shown in the "why?" view, consistent with the product's existing terrain and salience practice. Initial factors, all `uncalibrated`:

| Factor | Meaning |
|---|---|
| kind severity | `TRANSACTION_BYPASS` > `TESTS_LOST` > `NEW_CYCLE` > `ERROR_PATH_ADDED` > `MODULE_COUPLING` > `CALL_ADDED/REMOVED` |
| reach | normalised dependent count of the subject |
| test gap | subject has no covering test on the head |
| history | subject lies in a hotspot lineage (F06 data) |
| certainty | `FACT` > `INFERENCE` > `HYPOTHESIS` (a hypothesis may rank high only through reach and severity, and is always labelled) |

Weights are declared in one table with a calibration status, as the concept-hierarchy plan already requires of every new threshold. No weight is described as validated until §14 has run.

### 7.3 Deduplication

Two items with the same subject and kind collapse. A consequence that restates a dependency already implied by a higher-ranked item (same entity pair, lower-severity kind) is suppressed with `DUPLICATE` and kept in `suppressed` so "why not?" can explain it.

### 7.4 Thresholding and silence

- Show at most `maxItems` (default 3) items at or above `minScore`; list the count of the rest.
- If none meet the threshold, post **nothing** on a first analysis, and on later pushes update an existing comment to say the earlier items no longer apply.
- A repository may set `alwaysComment: true` for a minimal "nothing notable; N items below threshold" comment.
- Both defaults are `uncalibrated` and must be chosen from the §14 data, not by taste.

### 7.5 Interaction with the gate

F11 adds no blocking condition. A repository may opt in by adding a new, explicit gate condition (for example `NO_UNTESTED_TRANSACTION_BYPASS`) through a policy version; the existing evaluator treats it like any other and the INCOMPLETE/FAIL semantics are unchanged. Until then the impact comment is advisory.

### 7.6 The honest-label gate for comment lines

The renderer cannot emit a line unless it passes a pure function, `checkImpactLine(item)`, which rejects:

1. a non-FOG item with no resolvable evidence id;
2. a claim class stronger than the stored claim's `displayMode` allows (a hypothesis rendered as fact);
3. any sentence containing causal or certainty wording the template set does not contain ("will break", "causes", "safe", "verified");
4. an item whose citation path is under a prefix the commenting principal may not read (counted, never named; see `deniedPrefixes` in the existing publisher);
5. a section lacking its caveat line.

The text of every line comes from a closed template set keyed by `kind`. This mirrors the existing rule that a comment states what is true in one revision and not the other and never that one thing caused another (`history.ts` comment at `claim()`), and it is what the presentation-mutation release check (guide §17) tests.

---

## 8 API contracts

New or changed operations, registered in the existing operation table (`server.ts`, `svc.prOps`):

| Operation | Mutating | Purpose |
|---|---|---|
| `C23/getImpactReport` `{analysisId}` → `ImpactReport` | no | Read the report for the share page and the "why not?" view |
| `C23/explainImpactItem` `{analysisId, itemId}` → ranked factors, or the suppression reason | no | Backs "why this / why not" |
| `C30/previewImpactComment` `{analysisId}` → `{ markdown, reportHash }` | no | Render without publishing; used by dry-run and tests |
| `C30/publishImpactComment` `{analysisId, idempotencyKey}` → `PublicationReceipt` | yes | Post or update the comment; same grant and stale-head checks as the gate comment |

`C23/getPrAnalysis` additionally returns the populated `changes` object (closes G1) and `impact?: ImpactReport`.

The headless entry point is a command, not an HTTP service:

```
cie pr-check --repo . --base <sha> --head <sha> --pr <n> [--dry-run] [--policy .cie/pr-policy.json]
```

It exits 0 when it posted, updated or deliberately stayed silent, and non-zero only for a tool failure; it never fails the CI job on findings (§7.5).

---

## 9 States and lifecycles

Report states follow the PR analysis states already defined in F02 §9.1 (`QUEUED → RUNNING → COMPLETE | INCOMPLETE | FAILED`, plus `SUPERSEDED`). Publication states follow F02 §9.2. F11 adds one rule: a report built from an `INCOMPLETE` analysis is published only with the incompleteness stated first, never as a complete report with a footnote.

---

## 10 Authorization, egress, GitHub writes

1. **Reads** reuse the PR job's checkout from base-repository refs; a fork's head never needs the fork's credentials (existing behaviour).
2. **Writes** are one comment and, optionally, one status, through the existing grant-checked, find-before-create publisher. Nothing that can merge, approve, dispatch a workflow or write a protected branch is added.
3. **Fork pull requests** receive a read-only run: the CI token on a fork-triggered event has no write scope, so the runner must produce the comment text as a job artefact or step summary instead of posting. This is a requirement, not a nicety, and is test F11-A8.
4. **Egress**: the comment may contain symbol names, paths, line numbers, counts and claim classes; it may not contain source text, string literals, secrets or model output not produced by the template set. This amends the rule in `pr-publish.ts` (decision D4). Paths under denied prefixes are counted, not named.
5. **Hostile pull requests**: an attacker-controlled path, symbol name or commit message appears in a Markdown comment. All interpolated text must be escaped for Markdown and for GitHub mention syntax (`@user`, `#123`, HTML comments) so a PR cannot make the bot ping people or forge the marker. Test F11-A9.
6. **Telemetry**: none. The runner makes no network call except to the forge it was started for.

---

## 11 Freshness, cancellation, idempotency, recovery

- A push while analysis is running cancels it and supersedes the report; late writes are rejected at every commit point, as in `pr-analysis.ts`.
- The comment is found by its marker and updated; repeated webhook or workflow delivery produces no second comment (F11-A4).
- If publication fails after analysis succeeded, the report stays stored and the next run republishes by idempotency key.
- Crash during analysis: resumable through the existing job record; no partial report is ever posted.

---

## 12 Interface specification

### 12.1 Surfaces

1. **The PR comment** (primary). Plain Markdown, no images, readable when collapsed in a notification.
2. **The share page** for one analysis in the existing web app (`PrPanel.tsx`): the full surfaced and suppressed lists, factors, and the "why not?" explanations. It is read-only and must work for a reader who has no repository open.
3. **The command-line dry run**, printing exactly the Markdown that would be posted.

### 12.2 Copy rules (the honest-label rules for this feature)

- Lead with the count and the claim class, never with a score.
- Every item states its class in capitals before the sentence.
- Never "will", "causes", "safe", "verified", "bug". Use "now reaches", "no longer reaches", "can now throw".
- A Hypothesis states what static analysis cannot see ("frameworks, proxies and configuration are invisible to static analysis").
- The comment ends with the fixed line "Not a safety verdict. No finding is not *safe*."
- The suppressed count is always shown, with a "why?" link, so silence is never mistaken for thoroughness.

### 12.3 States

Analysing · Complete · Incomplete (stated first) · Superseded by a newer push · Nothing notable (only with `alwaysComment`) · Failed to analyse (a visible, short comment naming the tool failure, never a green mark).

### 12.4 Accessibility

Status words are text, not colour or emoji alone. The share page reuses the existing keyboard and screen-reader conventions (`a11y.ts`) and passes the same accessibility checks as the other panels.

---

## 13 Performance and bounded work

Provisional budgets, to be replaced by measurements from slice 0:

| Item | Budget |
|---|---|
| Time from push to comment on a repository of ~2k files | ≤ 5 minutes on a standard CI runner |
| Items analysed per PR | bounded by the existing neighbourhood depth (4) and `MAX_FINDINGS_PER_RULE` |
| Comment length | ≤ 8 KB; overflow items move to the share page and are counted |
| Memory | in-memory index only; no persistent store required in CI |

When a budget is exhausted the report says which sections were cut. A silent partial report is a defect.

---

## 14 Evidence plan: does this deserve to be built further?

The adoption hypothesis is unmeasured, and so is the accuracy of the surfaced items. Both are tested before slice 3.

**14.1 Retrospective harness** (slice 0, `scripts/f11-retro.ts`, patterned on `f01-bench.ts`):

1. Assemble a corpus of historical pull requests in repositories of the supported languages with a known later consequence: a revert, a hotfix referencing the PR, or an incident. Record the repository, the base and head hashes, the tool versions and the selection rule. Select the rule before looking at results.
2. Include a matched control set of pull requests with no later consequence, chosen by a stated rule, so precision can be computed.
3. For each, run the pipeline and record the surfaced items.
4. Two reviewers independently label, blind to the tool's output, whether a surfaced item corresponds to the later consequence; disagreements are reported, not resolved silently.
5. Report: items per PR, the fraction of consequence PRs where at least one surfaced item matches, the fraction of control PRs that would have produced a comment (the noise rate), and the denominators. Small corpora get small claims.

**14.2 Decision rule** (written before the run): proceed to slice 3 only if the noise rate on controls is below a limit the owner sets in advance and at least some consequence PRs are matched. If matches are near zero, the correct outcome is to stop and revisit the ranking or the premise, not to tune thresholds until the numbers look good.

**14.3 What this does not establish**: virality. Developer sharing behaviour needs real installs. After slice 3, track: installs, comments left in place after 30 days (not disabled), and reviewer reactions, for a small number of consenting repositories. Report these as observations.

---

## 15 Delivery slices and work packages

Classification per the guide: EXISTING_REUSE, EXISTING_EXTEND, NEW, NOT_NEEDED. "Demonstrated result" must use a real repository and real pull requests, not only authored fixtures.

| Slice | Contents | Classification | Demonstrated result |
|---|---|---|---|
| **S0** Retrospective evaluation | Corpus selection, harness, labelling sheet, report (§14) | NEW (`scripts/f11-retro.ts`, report under `docs/`) | Published report with denominators and corpus hashes |
| **S1** Populate the view | Keep the full `ChangeSet` in `PrAnalysis`; return `consequences`, `blastRadius`, `testImpact`, `gaps` in `view()`; add `reach` and `fog` assembly | EXISTING_EXTEND (`pr-analysis.ts:777–784, 1015`, `history.ts`) | `C23/getPrAnalysis` on a real PR returns non-empty `changes` matching `history.compare` |
| **S2** Impact comment | `ImpactReport` types, ranking, dedupe, thresholding, `checkImpactLine`, template set, renderer, publisher extension, second marker | NEW (`impact-report.ts`, `impact-render.ts`) + EXISTING_EXTEND (`pr-publish.ts`, `pr-gate.ts`) | Dry-run Markdown for a real PR; posted to a scratch repository |
| **S3** Headless runner | `cie pr-check` command, fork read-only mode, CI token handling, workflow template | NEW (`packages/core/src/cli/pr-check.ts` or `scripts/`) + EXISTING_REUSE (`pr-analysis.ts` checkout logic) | One workflow line running on a real repository and posting one comment |
| **S4** More sections | Race windows, removal counterfactual, ownership, terrain per PR, each only after its §3.3 question is answered | EXISTING_EXTEND per component | Each section demonstrated on a PR that exercises it, with its own Fog statement |
| **S5** Share page and "why not?" | `explainImpactItem`, PR-scoped read-only page, links from the comment | EXISTING_EXTEND (`PrPanel.tsx`, `salience.ts`) + NEW route | Page opened from a posted comment by a reader with no local repository |

Deferred and undecided (D5): a README badge, a public gallery of analysed open-source pull requests, and a paste-a-PR-URL hosted demo. Each raises hosting, abuse and reputation questions about analysing other people's code in public, so each needs its own decision.

---

## 16 Test plan and acceptance

Tests use real inputs where the feature claims real behaviour; synthetic cases are negative controls. Each completed item is recorded against its component in `docs/ledger.json` only when backed by a passing test, per the project rule that "done" means ledger items backed by tests.

| ID | Check |
|---|---|
| F11-A1 | Push a new head between analysis and publication: the old report is superseded and never posted as current |
| F11-A2 | A mandatory analyzer times out: the comment states INCOMPLETE first; it is never rendered as complete |
| F11-A3 | Every non-Fog line has a resolvable evidence id; deleting an evidence row makes `checkImpactLine` reject the line |
| F11-A4 | Repeated workflow delivery for one head creates exactly one comment |
| F11-A5 | Presentation mutation: change a Hypothesis to render as Fact, remove a caveat, insert "will break" — each is rejected by `checkImpactLine` |
| F11-A6 | Nothing above threshold: no comment on first analysis; an existing comment is updated to say earlier items no longer apply |
| F11-A7 | A denied path is counted, never named, in the comment and the share page |
| F11-A8 | Fork-triggered run has no write scope and produces the Markdown as an artefact instead of posting |
| F11-A9 | A PR with a symbol or file name containing `@user`, `#1`, `<!--` and Markdown control characters cannot ping, link, or forge the marker |
| F11-A10 | `history.compare` consequences map to classes by the fixed table; a test per consequence kind |
| F11-A11 | Population mutation: add changed files the analyzer skips; the Fog count and the denominator change visibly |
| F11-A12 | Budget exhaustion: sections cut are named; the report is not silently partial |
| F11-A13 | Dry-run output is byte-identical to what the publisher would post for the same report hash |
| F11-A14 | Gate comment and impact comment update independently; neither overwrites the other's marker |
| F11-A15 | The retrospective report exists, names its corpus and decision rule, and the shipped defaults match what it supports |

---

## 17 Failure modes

| Failure | Behaviour |
|---|---|
| False positive on a first install | Highest adoption risk. Mitigations: threshold from §14, silence by default, "why not?" and a one-line way to mute a kind per repository |
| Misleading Fact label | Prevented by the fixed class table and `checkImpactLine`; a mislabel is a defect with a regression test, not a tuning matter |
| Analysis too slow for CI | Budgets in §13; sections cut and named; never a missing comment without explanation |
| Unsupported language or file | Counted as Fog with the file count; never skipped silently |
| Comment lengthens over time | Hard 8 KB cap, overflow to share page |
| Token with excess scope | Runner requests only comment/status; documented in the workflow template |
| Reviewer reads silence as approval | Fixed closing line; suppressed count always shown |

---

## 18 Component change summary

| Component | Files (existing unless marked NEW) | Change |
|---|---|---|
| C23 | `pr-analysis.ts`, `history.ts`, `impact-report.ts` (NEW) | Retain `ChangeSet`; populate `changes`; build, rank, dedupe, threshold the `ImpactReport` |
| C16 | `pr-gate.ts`, `claims.ts` | `checkImpactLine`; class mapping table; optional new opt-in condition type |
| C18 | `claim-ledger.ts`, `store.ts`, `migrations.ts` | `impact_reports` table, supersession, report hash on receipt; migration |
| C30 | `pr-publish.ts`, `impact-render.ts` (NEW) | Second marker, template renderer, Markdown/mention escaping, length cap, dry-run |
| C03 | `access.ts`, `security.ts`, `pr-publish.ts` | Egress amendment (D4); denied-prefix counting in the new comment; fork read-only |
| C07 / C32 | `jobs.ts`, `ops.ts`, `scripts/` | Cancel superseded runs; headless `cie pr-check`; workflow template; versioned schema |
| C12 | `salience.ts`, `answer.ts` | `explainImpactItem` for surfaced and suppressed items |
| C19 / C20 | `visuals.ts`, `apps/web/src/PrPanel.tsx` | Share page; surfaced/suppressed lists; factor display |
| C25 / C26 / C27 (S4) | `twin-races.ts`, `twin-*.ts`, `overlays.ts` | Per-PR inputs for race, removal sections after §3.3 is answered |
| C17 | `scripts/f11-retro.ts` (NEW), `docs/` | Retrospective harness and published report |
| `@cie/schema` | `packages/schema/src/index.ts` | `ImpactItem`, `ImpactReport`, populated `changes` |
| C01 | `packages/core/src/server.ts` | Register the four operations |

---

## 19 Decisions to settle before implementation

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Runner location | Inside the repository's CI runner; hosted mode deferred |
| D2 | One comment or two (gate + impact) | Two markers, independently updated; revisit if reviewers find two noisy |
| D3 | May a model phrase any text | No in the first release; deterministic templates only. If later allowed, only through the existing model gateway with every output re-checked by `checkImpactLine`, and only with models already installed locally |
| D4 | Egress amendment for symbol names | Allow symbol names, paths, lines, counts, classes; forbid source text and literals; record the rule change in `pr-publish.ts` and the security notes |
| D5 | Badge, gallery, hosted paste-a-URL demo | Out of the first release; decide after §14.3 observations |
| D6 | Corpus and labellers for §14 | Owner to name repositories and two independent labellers before S0 starts |
| D7 | Noise limit for the decision rule (§14.2) | Owner to set before the run, in writing |
| D8 | Whether to add an opt-in blocking condition | Not in the first release |
