# F17 — Ticket and acceptance-criteria compliance for a PR

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §3–§4; reuses the requirements machinery of `Prompt-to-feature.md`. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree.
Priority P2. First deliverable: for a PR that links a GitHub issue, a per-criterion table stating which criteria the change touches, which have a linked test, and which CIE could not link — never "met".

---

## 1 Purpose, user experience and status

### 1.1 Why

One competitor builds its review around checking a PR against its Jira ticket. Reviewers ask "does this do what the ticket asked?" far more than "is there a null check?". CIE already turns free text into structured requirements and acceptance criteria for the feature pipeline, with a rule that is exactly right for this use: the model proposes, code decides, a requirement is trusted only when its words are found in the source it cites, and a criterion whose expected outcome came from a model can never make anything "verified".

No automatic check can establish that a change *meets* a criterion. What it can do honestly is show which criteria the change touches, which have test evidence, and which it could not link to anything, and show changes that no criterion explains.

### 1.2 The experience

```
## CIE — ticket check · #482 → issue #431 "Make commit transactional"       head a19a978
5 criteria found in the ticket · 3 touched by this change · 2 with a linked test · 1 not linkable · 1 not checkable

| # | Criterion (from the ticket)                       | Touched by the change            | Test evidence                          | Status           |
|---|---------------------------------------------------|----------------------------------|----------------------------------------|------------------|
| 1 | commit rolls back on failure                       | `commit` (modified)              | commit.test › "rolls back" (static link) | EVIDENCED (static) |
| 2 | insufficient funds is rejected                    | `adjustBalance` (modified)       | none linked                            | TOUCHED, NO TEST   |
| 3 | audit entry written                                | no changed code names it         | —                                      | NOT LINKED         |
| 4 | page should feel fast                              | —                                | —                                      | NOT CHECKABLE      |
| 5 | emails sent after commit                           | `notify` (unchanged)             | —                                      | NOT LINKED         |

Changes the ticket does not explain: `src/audit/log.ts` (modified)
"Not linked" means CIE found no connection by name or call path. It does not mean the criterion is unmet. A reviewer can mark a criterion as confirmed: /cie confirm 3
```

### 1.3 What "done" means

1. Every row states its basis (name match, call path, static test link) and no row says "met" or "passes" (§7.4).
2. The criteria are those written in the ticket, extracted by a stated rule, with grounding computed by code (§7.2).
3. Ticket and PR text are treated as untrusted data and never reach a model as instructions (§10).
4. A confidential ticket is not quoted into a public pull request (§10.3).

### 1.4 Status

Proposed. GitHub issues first (the forge already exists); Jira and Linear are a later slice.

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** linking a PR to tickets; reading a ticket; extracting criteria; mapping criteria to changed code and tests; per-criterion status; changes not explained by any criterion; reviewer confirmation as a recorded attestation; a Jira connector (later).

**Non-goals:** deciding that a PR satisfies a ticket; blocking a merge (a gate condition `TICKET_LINKED` may exist but is advisory by default); writing to tickets (no comments, transitions or field edits in the first release); inferring criteria the ticket does not contain; scoring ticket quality.

**First delivery boundary:** GitHub issue links, deterministic criterion extraction, name and call-path mapping, static test links.

---

## 3 Current state in this repository

### 3.1 What exists

| Capability | Where |
|---|---|
| Read and write one GitHub issue, labels, comments, through an injected `gh` runner | `feature/issue-forge.ts` `IssueForge.getIssue` |
| Issue lookup by number for release scope | `release-scope.ts` `lookupIssue`; `C32/lookupIssue` |
| Requirement normalisation: the model proposes, ids renumbered deterministically, grounding computed from the cited source, vague terms and non-atomic statements become findings, ungrounded requirements stay PROPOSED | `feature/requirements.ts` (`grounding`, `checkDraft`, `VAGUE_TERMS`, `normalizeRequirements`) |
| Acceptance criteria with an oracle origin; a criterion backed only by generated expected outcomes can never be verified; human confirmation as a recorded decision | `feature/types.ts` `AcceptanceCriterion`; `feature/acceptance.ts` |
| Conflict, gap and mismatch findings between requirements and the repository | `feature/conflicts.ts`, `feature/finding-proposer.ts` |
| Name resolution of words to indexed entities | `mentions.ts` |
| Static test links with the basis always named; coverage never claimed without an artefact | `feature/test-links.ts` |
| A read-only forge connector type that permits `GET` only and marks records untrusted | `connectors.ts` `Transport`, `PullRequest.untrusted` |
| Issue-trail projection with an allowlist, public/private visibility, and a fail-closed leak guard | `feature/issue-trail.ts` |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | No linking of a PR to the ticket it addresses | none; `PullRequest` has title and body only |
| G2 | No Jira or Linear connector | grep for "jira" returns nothing; README line 247 states issues and tickets have no connector in the UI |
| G3 | The normaliser expects a *request* for a feature, with a contract and obligations; a ticket's existing checklist is not parsed as criteria | `requirements.ts` is model-driven |
| G4 | `Transport` allows only `GET`; Linear's API and some Jira operations need `POST` | `connectors.ts` `HttpRequest.method: "GET"` |
| G5 | No per-criterion report for a PR; test links are computed for a candidate, not for a PR | `feature/test-links.ts` `relatedTests(request, candidate)` |
| G6 | No rule for what ticket text may appear in a PR comment | none |

### 3.3 Not verified

- How well `resolveMentions` links ordinary-language criteria ("emails sent after commit") to code; likely poorly. S0 measures it.
- Jira Cloud versus Server API differences and authentication options. They must be checked against current vendor documentation before slice 4.
- Whether `normalizeRequirements` can be run without the rest of the feature contract flow.

---

## 4 Architecture and ownership

| Component | Responsibility |
|---|---|
| C04 Connectors | Ticket reads: GitHub (existing forge), Jira/Linear (new, later); untrusted-record validation and quarantine |
| C23 History, semantic PR | Link detection; per-criterion mapping to the change set |
| C15 / feature requirements | Criterion extraction and grounding (reuse) |
| C16 Claim gates | Row status wording gate; basis required |
| C29 Collaboration | Reviewer confirmation and attestation |
| C30 Exports | Table rendering, visibility-aware egress |
| C03 Access, egress | Visibility rule; secrets handling for connectors |

Flow: PR → link detection → ticket fetch → criteria extraction → map to change set and test links → status per row → table in the comment (a section of the F11 comment, own sub-marker) → reviewer confirmations.

---

## 5 Reconciliation with existing contracts

- Criteria use the existing `AcceptanceCriterion` shape with `oracleOrigin: "USER_EXAMPLE"` only when the ticket's own words state the expected outcome; otherwise the criterion has no oracle and is shown without one.
- Grounding is the existing `grounding()` score: a criterion not found in the ticket text it cites is never shown as a ticket criterion.
- A reviewer's `confirm` is recorded like a decision under authority (`feature/acceptance.ts` pattern) and is displayed as "confirmed by @x", not as proof.
- The table is a section of the F11 impact comment, to respect the shared comment budget (study §7).
- `IssueForge` is reused unchanged for GitHub; a `TicketSource` interface wraps it so Jira can implement the same shape.

---

## 6 Data model

```typescript
interface TicketRef { system: "GITHUB" | "JIRA" | "LINEAR"; key: string; url?: string; linkedBy: "PR_BODY" | "PR_TITLE" | "BRANCH" | "COMMIT"; closing: boolean }

interface TicketCriterion { id: string; ticketKey: string; text: string; origin: "CHECKLIST" | "SECTION" | "GIVEN_WHEN_THEN" | "PROPOSED_BY_MODEL";
  grounding: number; checkable: boolean; terms: string[]; oracleOrigin?: "USER_EXAMPLE" }

interface CriterionRow { criterionId: string; touched: { entityId: string; change: string; basis: "NAME_MATCH" | "CALL_PATH" }[];
  tests: { testId: string; basis: "STATIC_IMPORT" | "CALL_PATH_DEPTH" | "NAMED_IN_CRITERION"; coverageEvidence: boolean }[];
  status: "EVIDENCED_STATIC" | "TOUCHED_NO_TEST" | "NOT_LINKED" | "NOT_CHECKABLE" | "CONFIRMED_BY_REVIEWER";
  confirmations: { principalId: string; at: string }[] }

interface TicketReport { analysisId: string; tickets: TicketRef[]; criteria: TicketCriterion[]; rows: CriterionRow[];
  unexplainedChanges: { path: string; entityId?: string }[]; gaps: string[]; visibility: "PRIVATE" | "PUBLIC_OR_UNKNOWN" }
```

Stored as part of the F11 `ImpactReport` canonical JSON plus a `ticket_confirmations` table.

---

## 7 Algorithms and rules

### 7.1 Link detection

From PR title, body, branch name and commit messages: GitHub forms (`#123`, `owner/repo#123`, "closes/fixes/resolves #123"); Jira-style keys only when the project key is in a configured allowlist (a bare `[A-Z]+-\d+` also matches `UTF-8` and `ISO-9660`). A candidate link is confirmed by a successful fetch; a failed fetch is a gap, not a guess. Closing keywords set `closing: true`.

### 7.2 Criterion extraction (deterministic first)

In order, stopping at the first rule that yields criteria: (1) Markdown task-list items under a heading matching `acceptance|criteria|definition of done`; (2) any task-list items in the body; (3) Given/When/Then triples; (4) a bullet list under such a heading. Each criterion's `grounding` is computed against the ticket text by the existing `grounding()` function. If none of the rules yields criteria, the report says "no explicit criteria found in the ticket" and lists no rows. A model may propose criteria from prose only through `normalizeRequirements`, and those stay `PROPOSED_BY_MODEL`, are marked as such in the table and never counted in the headline numbers.

### 7.3 Checkability

A criterion with no code-shaped terms and no terms that resolve to indexed entities is `checkable: false` ("page should feel fast"). It is shown, labelled not checkable by static analysis, and never given a status that implies an assessment.

### 7.4 Mapping and status

1. `terms` come from `candidateWords`/`codeShaped`; resolve against the head index with `resolveMentions` under the access policy.
2. `touched`: resolved entities that appear in the change set (`NAME_MATCH`), or entities reached from a changed entity within the same call-depth bound as F11 (`CALL_PATH`), the basis printed.
3. `tests`: static links from `relatedTests` generalised to a PR change set; tests added or modified in the PR whose names or assertion text share terms with the criterion (`NAMED_IN_CRITERION`); `coverageEvidence` true only when a coverage artefact for the head covers the touched lines.
4. Status: `EVIDENCED_STATIC` (touched and a linked test exists) · `TOUCHED_NO_TEST` · `NOT_LINKED` (nothing found) · `NOT_CHECKABLE` · `CONFIRMED_BY_REVIEWER`.
5. There is no status named "met", "passed" or "satisfied". The legend says: "Evidenced (static) means a linked test reaches the touched code; it does not mean the test passed or that the criterion is satisfied."

### 7.5 Unexplained changes

Changed entities and files with no resolved term in any criterion, aggregated by module as in F13 §7.5. The section states that this compares names, and that refactors and test-only changes are excluded.

### 7.6 Reviewer confirmation

`/cie confirm <n>` (F14 grammar) by a user with `editor` role records an attestation with the actor and time; the row shows "confirmed by @x" and keeps its machine status visible next to it. A confirmation is not proof (consistent with `claims.ts`).

### 7.7 Honest-label gate

`checkTicketRow(row)` rejects: a status without a basis; wording such as "met", "complete", "satisfies"; a row with `PROPOSED_BY_MODEL` counted in the headline; a quoted criterion not found in the ticket text.

---

## 8 API contracts

`C23/getTicketReport {analysisId}` (read-only). `C29/confirmCriterion {analysisId, criterionId}` (mutating, role-checked). `C04/fetchTicket {ref}` (read-only; used internally). Transport: `TicketSource.fetch(ref)` returning an untrusted record. A new advisory gate condition `TICKET_LINKED` (default off) uses the existing policy validation path.

---

## 9 States and lifecycles

Report state follows F11. Ticket fetch states reuse `SourceState` (`HEALTHY`, `EXPIRED`, `RATE_LIMITED`, `UNREACHABLE`). An edited ticket after analysis is detected by its updated-at on the next run and the report says which version of the ticket it used.

---

## 10 Authorization, egress, threat model

1. **Read-only.** No ticket writes in the first release. The `GET`-only transport type enforces this for Jira until a justified change (G4).
2. **Credentials.** Connector tokens are read from the environment variable named in configuration at call time and never stored or logged, following `gh.ts` and `connectors.ts`. In CI they come from the CI secret store.
3. **Confidentiality.** A private ticket tracker feeding a public repository's PR would publish ticket text. The comment quotes criterion text only when `transport.visibility()` is private and the ticket system is the repository's own issues; otherwise it shows criterion numbers, statuses and counts without text, and says why. A public-repository PR linking a Jira ticket shows no ticket key by default (decision D2).
4. **Injection.** Ticket text, PR text and comments are untrusted and are never given to a model as instructions. Where a model proposes criteria, the text reaches it as a quoted block, its output goes through `checkDraft` and grounding, and it cannot change a status.
5. **Escaping.** All interpolated ticket text is escaped as in F13 §10.3.
6. **Denied paths** are counted, not named.
7. **Authorisation to confirm** is by role, as in F15 §7.4.

---

## 11 Freshness, idempotency, recovery

Bound to the head and to the ticket's updated-at. Re-delivery updates the same section. A moved head recomputes; confirmations attach to a criterion id derived from the ticket key and normalised criterion text, so an unchanged criterion keeps its confirmation across pushes and a changed criterion loses it (stated in the comment).

---

## 12 Interface specification

Table as in §1.2, with a legend that always includes the "not linked is not unmet" sentence. Counts line first. "Confirmed by @x" appears beside the machine status, never replacing it. A not-checkable row says "not checkable by static analysis" in words.

---

## 13 Performance and bounded work

One ticket fetch per linked ticket (cap 3 tickets per PR), cache by ticket updated-at; at most 15 criteria per ticket shown (the rest counted); mapping uses the F11 call-depth bound. Cut items are named.

---

## 14 Failure modes

| Failure | Behaviour |
|---|---|
| Link points to a missing or forbidden ticket | Gap: "ticket not readable"; no guess |
| Ticket has no explicit criteria | "No explicit criteria found"; no model invention |
| Ordinary-language criterion names nothing in code | NOT LINKED or NOT CHECKABLE, never a guess |
| Several tickets linked | Separate tables, capped |
| Token expired | `EXPIRED` state shown; analysis continues without the section |
| Ticket edited after analysis | Next run uses the new version and says so |
| Public repo with private tracker | Counts and statuses only (§10.3) |

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | On 20 real PRs with linked issues, run extraction and mapping by hand; record how often rows are right, and reviewer usefulness | NEW (spike) |
| S1 | Link detection, `TicketSource` over `IssueForge`, deterministic extraction, `TicketReport`, `checkTicketRow` | NEW `ticket-check.ts` + EXISTING_REUSE (`issue-forge.ts`, `requirements.ts`, `mentions.ts`) |
| S2 | PR-level test mapping, unexplained changes, comment section with visibility rule | EXISTING_EXTEND (`test-links.ts`, F11 renderer) |
| S3 | Reviewer confirmation, advisory gate condition | EXISTING_EXTEND (`collab.ts`, `pr-gate.ts`) |
| S4 | Jira connector (read-only), tracker visibility rules | NEW; verify API against current vendor docs first |

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F17-A1 | No row uses "met", "passed" or "satisfies"; every row names its basis |
| F17-A2 | A criterion not present in the ticket text is never shown as a ticket criterion (grounding) |
| F17-A3 | `UTF-8` and `ISO-9660` in a PR body are not links without an allowlisted project key |
| F17-A4 | A ticket with no explicit criteria yields "no explicit criteria", not invented rows |
| F17-A5 | `PROPOSED_BY_MODEL` criteria are labelled and excluded from headline counts |
| F17-A6 | A non-checkable criterion is shown as such and receives no assessment status |
| F17-A7 | Public repository with a private tracker: no criterion text and no ticket key in the comment |
| F17-A8 | Ticket text containing `@user`, `#1`, `<!--` and instruction-like text cannot ping, link, forge a marker or reach a model as instructions |
| F17-A9 | `confirm` needs `editor` role; the machine status stays visible beside the confirmation |
| F17-A10 | Edited criterion loses its confirmation; unchanged criterion keeps it |
| F17-A11 | Expired credential yields `EXPIRED` and the rest of the comment still posts |
| F17-A12 | Static test link is `coverageEvidence: false` unless a coverage artefact covers the touched lines |
| F17-A13 | Unexplained-changes list excludes test-only and rename-only changes and states it compares names |
| F17-A14 | The Jira transport cannot issue a write (type and test) |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Jira in the first release | No; GitHub issues first |
| D2 | Show ticket keys in public PRs for private trackers | No by default |
| D3 | Allow model-proposed criteria | Only labelled and excluded from headline counts; revisit after S0 |
| D4 | Advisory gate condition `TICKET_LINKED` | Include, default off |
| D5 | Extend `Transport` beyond `GET` for Linear | Not until a read-only path is shown to be impossible |
