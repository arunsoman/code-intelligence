# F16 — Validated inline fix suggestions

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §3–§4; extends F02 and F07 (`F02-pr-analysis-and-quality-gates.md`, `F07-task-to-branch-to-pr-execution.md`). Repository evidence observed at commit `b5f099c` plus the uncommitted working tree.
Priority P2. First deliverable: on request, an inline review comment containing a one-click `suggestion` for a finding introduced by the PR, only when a validated, single-hunk fix exists.

---

## 1 Purpose, user experience and status

### 1.1 Why

Review bots attach a suggested change the author can apply with one click. CIE can already produce a fix for some findings: a candidate (byte-exact edits) validated in isolation and published as a **draft pull request** (`defect-workflow.ts`, `feature/publish.ts`). A draft PR is the right unit for a large change and the wrong one for a three-line fix on a PR already under review. The gap is the small, in-place, human-applied form.

### 1.2 The experience

A finding introduced by the PR has a fix candidate that passed validation. The reviewer writes `/cie suggest 2` (F14 grammar), or the repository has opted into automatic suggestions for that kind. CIE posts one inline review comment, anchored to the lines it changes:

````
**Suggested change** — for finding SEC-017 (introduced by this PR) · bound to head a19a978

```suggestion
    if (amount <= 0 || amount > balance) throw new InsufficientFunds();
```

Validated within the recorded checks: type-check (no new diagnostics) · 14 tests run, 14 passed · finding no longer present on re-analysis · no new findings introduced.
Not checked: behaviour under concurrency · tests outside the 14 · production data. This is a suggestion; applying it is your decision.
````

The author applies it with the forge's "Commit suggestion" button. CIE never pushes to the PR's branch.

### 1.3 What "done" means

1. A suggestion is only ever posted for a candidate whose validation record is bound to the exact head, and the comment states which checks ran and which did not (§7.4).
2. The suggested text is byte-identical to the validated edit (§7.3).
3. No suggestion is posted for a high-impact path, a dependency change, a file deletion, or an edit that weakens an existing test (§7.2).
4. When the head moves, the suggestion is marked superseded in place (§11).

### 1.4 Status

Proposed. Needs the inline-comment transport (§3.2 G1) and, for fuller validation, F18 for a failing-then-passing test.

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** eligibility rules; a suggestion builder from an existing validated candidate; one inline review comment per suggestion inside a single review submitted as a comment; on-demand trigger first, per-kind automatic trigger later; outcome observation when the suggestion is applied; per-PR cap.

**Non-goals:** committing to or pushing the PR branch; approving, requesting changes or merging; multi-file or multi-hunk suggestions (those stay draft PRs under F07); suggestions generated for findings the PR did not introduce; model-written suggestions that bypass candidate validation; refactors, style rewrites and "improvements" with no finding behind them.

**First delivery boundary:** on-demand, TypeScript, findings that already have a validated candidate.

---

## 3 Current state in this repository

### 3.1 What exists

| Capability | Where |
|---|---|
| Findings introduced by a PR, fingerprinted and baseline-matched | `pr-analysis.ts`, `pr-gate.ts` |
| Finding → fix candidate → validation → draft PR, never merging | `defect-workflow.ts` (`DraftForge`, `prBody`); `feature/publish.ts` |
| Byte-exact edits with a stale check, a typecheck that ignores moved positions, a baseline-versus-head diagnostic comparison, tests under Node's permission model | `isolated-exec.ts` (`applyTextEdits`, `typecheckDir`, `compareDiagnostics`, `runTestsIn`) |
| Model-proposed edits turned into byte-exact edits and re-checked by the candidate engine | `feature/generate.ts`, `feature/candidate.ts` |
| Tier classification that forces extra scrutiny for auth, migrations, dependencies, CI, config | `feature/tiers.ts` |
| Dependency and lockfile review | `feature/dependencies.ts` |
| Fail-closed leak guard on outgoing text | `feature/issue-trail.ts` `guardOutgoing`; `feature/redact.ts` |
| Gate condition that the original oracle is preserved | `pr-gate.ts` `ORACLE_PRESERVED` |
| Eligibility computed from evidence bound to the exact candidate | `feature/validation.ts` (`computeEligibility`, per `README.md`) |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | `GitHubTransport` offers status and issue-style comments only; there is no inline review comment, no `suggestion` block, no review submission | `pr-publish.ts:22` interface |
| G2 | No rule decides which validated candidates are small enough to suggest | none |
| G3 | Candidates are produced for the defect and feature pipelines, not requested for an arbitrary PR finding | `defect-workflow.ts` header (what share of PR finding kinds has a fix is not verified) |
| G4 | Nothing observes whether a suggestion was applied | none |
| G5 | The leak guard and fence handling are built for issue and PR text, not for code placed inside a Markdown code fence | `guardOutgoing` |
| G6 | Validation covers TypeScript via `runTestsIn` and `typecheckDir`; other languages' checks are not verified | `isolated-exec.ts` |

### 3.3 Not verified

- Which finding kinds from the security and defect detectors currently produce candidates, and how often a candidate is a single hunk.
- Each forge's rule for where a suggestion may be anchored (GitHub restricts suggestions to lines inside the PR diff); the contract must be checked against current vendor documentation before building (F19).

---

## 4 Architecture and ownership

| Component | Responsibility |
|---|---|
| C28 Change proposal | Produce and validate the candidate for a finding (existing); expose `prepareSuggestion` |
| C16 Claim / gate | `computeEligibility` for the candidate; the suggestion gate in §7.2 |
| C25 / C26 Detectors | Re-run on the patched tree to prove the finding is gone and none introduced |
| C30 Exports | Build and post the inline review comment; supersede on push |
| C03 Access, egress | Denied paths never suggested; visibility-aware text |
| C23 History | Detect application of the suggestion on the next head |
| F14 | `/cie suggest <n>` command |
| F19 | Inline-comment transport per forge |

Flow: finding → candidate (existing) → validate on head tree in a scratch copy → suggestion gate → render → inline comment → observe next head.

---

## 5 Reconciliation with existing contracts

- A suggestion is a **projection of an existing validated candidate**, not a new candidate type. The candidate id and validation hash are stored with the posting, so `verifyBinding` semantics from F02 apply.
- The candidate must be created against the **PR head** as its base. A candidate validated against another base is ineligible.
- The draft-PR path remains for anything that fails §7.2; the suggestion reply may link to it ("too large to suggest; a draft PR can be prepared").
- The label vocabulary matches `README.md`: "VERIFIED WITHIN THE SCOPE OF THE RECORDED VALIDATION", never "fixed".

---

## 6 Data model

```typescript
interface SuggestionRecord {
  id: string; analysisId: string; findingId: string; candidateId: string; validationHash: string;
  headHash: string; path: string; startLine: number; endLine: number; replacementHash: string;
  checks: { name: string; outcome: "PASSED" | "FAILED" | "NOT_RUN"; detail: string }[];
  state: "PREPARED" | "POSTED" | "SUPERSEDED" | "APPLIED" | "DISMISSED" | "FAILED";
  externalId?: string; idempotencyKey: string; postedAt?: string; observedAt?: string;
}
```
Table `suggestions` in the existing store; the posting is tied to the existing publication receipt model (`PublicationReceipt`, kind `COMMENT`).

---

## 7 Algorithms and rules

### 7.1 Candidate for a PR finding

For an introduced finding, ask the existing pipeline for a candidate based on the head tree. If none exists or generation is unavailable, reply "no validated fix is available for this finding" and offer nothing else. A model may help propose edits only through the candidate engine, which re-checks quoted text and rejects ambiguity (`feature/generate.ts`).

### 7.2 Suggestion gate (all must hold)

1. The candidate's base equals the PR head hash.
2. One file, one contiguous replacement, at most `maxLines` (default 10) lines changed.
3. The file is not under a high-impact pattern (`classifyTier` returns not T2 for the path) and the edit adds no dependency, install script, workflow or configuration change.
4. No file is created, renamed or deleted.
5. The edit does not remove or weaken an existing test or assertion (checked against the gate's oracle-preservation logic; a test file edit is ineligible in the first release).
6. The anchored line range lies within lines the forge allows for review comments on this PR (verified per forge, F19).
7. The path is not under a prefix the principal cannot see.

Failing any rule yields a stated reason in the reply, not silence.

### 7.3 Validation on the head tree

Run in a scratch copy using existing helpers: apply the edit with the stale check; type-check and compare diagnostics against the head's baseline (no new diagnostics); run the tests that reach the changed symbol (static links from `test-links.ts`; all tests if the set is empty and the suite is small), requiring no new failures; re-run the detector that raised the finding on the patched tree and require that the finding is gone and no new finding appears. Any check that cannot run is recorded `NOT_RUN` with the reason and appears in the comment under "Not checked". Failures of any run check stop the suggestion.

### 7.4 Rendering

The suggestion body is generated from the validated replacement bytes, never from model text. The code fence is longer than any backtick run inside the replacement. The check list is printed from the validation record. The fixed caveat line is always present.

### 7.5 Posting

All suggestions for one request go in a single review submitted as a plain comment (never approve or request changes), one inline comment per suggestion, capped per PR (default 3) so the review stays one notification. On-demand is the default; automatic suggestions are an opt-in per finding kind in policy.

### 7.6 Outcome observation

On the next analysed head, if the replaced lines match the suggested text, the record becomes `APPLIED`; if the head moved and the lines changed otherwise, `SUPERSEDED`. These are observations; they are not used to rank (F15 §7.2 rule 5).

---

## 8 API contracts

`C28/prepareSuggestion {analysisId, findingId}` → `SuggestionRecord` or an ineligibility reason (read-only apart from the scratch run). `C30/publishSuggestion {suggestionId, idempotencyKey}` → receipt (mutating, grant-checked, find-before-create). `C23/getSuggestions {analysisId}` (read-only). Transport (F19): `submitReview(pr, headSha, comments[], event: "COMMENT")`, `updateReviewComment(id, body)`, `findReviewComment(pr, marker)`.

---

## 9 States and lifecycles

`PREPARED → POSTED → APPLIED | SUPERSEDED | DISMISSED`; `FAILED` when posting fails. A suggestion for a head that is no longer current is never posted.

---

## 10 Authorization, egress, threat model

1. **No write to the PR branch.** The only writes are a review comment bundle. The author applies the change.
2. **Never approve or request changes.** The review event is fixed to `COMMENT`; a test asserts the transport refuses other events.
3. **Egress.** Suggestion text is source code, so it can only go where the PR's own audience already sees the repository. The leak guard runs over the final text and refuses on a secret-like match; the replacement is never altered.
4. **Injection into the comment.** The replacement is attacker-influenced (it derives from the PR's own code). It is placed in a fence longer than any backtick run it contains; surrounding prose is template text with escaped substitutions (F13 §10.3).
5. **Supply chain.** Dependency, install-script and config edits are ineligible by rule.
6. **Denied paths.** Never suggested, counted in the reply.
7. **Forks.** A fork-triggered run lacks write scope; the suggestion is written to a step summary instead (F11 §10.3).

---

## 11 Freshness, cancellation, idempotency, recovery

One posting per `(findingId, headHash, replacementHash)`. A push marks open suggestions `SUPERSEDED` and updates the comment body to say so, keeping the old text visible as history. A crash after validation but before posting reposts from the stored record after checking by marker.

---

## 12 Interface specification

Copy: "Suggested change", the finding id, the head, the check list including "Not checked", and the fixed caveat. Never "fixes", "resolves", "safe", "verified" without the scope phrase. The reply to an ineligible request names the rule that failed.

---

## 13 Performance and bounded work

Validation runs under the existing isolation budget (the test runner default is 120 seconds, `isolated-exec.ts`). Per request: one candidate, one validation. Per PR: at most 3 posted suggestions. A request that cannot finish in the budget reports `NOT_RUN` checks and posts nothing unless the mandatory checks (type-check, finding gone) ran.

---

## 14 Failure modes

| Failure | Behaviour |
|---|---|
| No candidate exists for the finding | Reply says so; no draft is created implicitly |
| Candidate larger than the limit | Reply names the rule; offers a draft PR (F07) on request |
| Anchor line outside the forge's allowed range | Ineligible with reason |
| Tests could not run | `NOT_RUN` shown; posted only if mandatory checks ran |
| Head moved during validation | Discarded as stale |
| Replacement contains a backtick fence | Longer fence used |
| Forge rejects the inline anchor | `FAILED` with the forge's reason; nothing partial posted |

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | Inventory which finding kinds yield a candidate and how often it is a single hunk; measure on 20 real PRs | NEW (script) |
| S1 | Eligibility gate, head-bound validation wrapper, record, render with fence handling | NEW `suggestions.ts` + EXISTING_REUSE (`isolated-exec.ts`, `defect-workflow.ts`, `tiers.ts`) |
| S2 | Inline review transport and publisher, supersession, outcome observation | EXISTING_EXTEND (`pr-publish.ts`) + F19 |
| S3 | `/cie suggest` command; opt-in automatic kinds | EXISTING_EXTEND (F14, policy) |

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F16-A1 | A candidate whose base is not the PR head is ineligible |
| F16-A2 | Multi-hunk, multi-file, file-creating, file-deleting and test-editing candidates are ineligible with a named reason |
| F16-A3 | An edit under a T2 path or touching a dependency, script or workflow is ineligible |
| F16-A4 | The posted text is byte-identical to the validated replacement; a mutated replacement is rejected before posting |
| F16-A5 | A replacement containing triple and quadruple backticks renders without breaking the fence |
| F16-A6 | New type diagnostics or a failing test stops the suggestion |
| F16-A7 | The finding must be gone and no new finding present on re-analysis |
| F16-A8 | `NOT_RUN` checks appear under "Not checked"; mandatory checks not run block posting |
| F16-A9 | The review event is always `COMMENT`; the transport refuses approve/request-changes |
| F16-A10 | Push after posting: suggestion marked superseded in place; no suggestion for a stale head |
| F16-A11 | A secret-like string in the replacement makes the posting refuse, unaltered |
| F16-A12 | Denied path never suggested; counted |
| F16-A13 | Re-delivery creates no second inline comment |
| F16-A14 | Per-PR cap of three holds; the rest are listed in one line |
| F16-A15 | Applied suggestion is observed on the next head and recorded `APPLIED`; it does not alter ranking |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | On-demand or automatic | On-demand first; automatic per kind only after S0 and F15 data |
| D2 | `maxLines` | 10, `uncalibrated`; revisit from S0 |
| D3 | Allow edits to test files | No in the first release |
| D4 | Suggest for findings not introduced by the PR | No |
| D5 | Languages | TypeScript only until other runners are verified |
