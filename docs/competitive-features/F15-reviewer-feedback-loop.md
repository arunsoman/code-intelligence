# F15 — Reviewer feedback loop: per-repository mutes and ranking weights

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §3–§4; modifies the ranking in `F11-blast-radius-pr-check.md` §7.2–7.4. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree.
Priority P1 (it decides whether F11 survives its first installs). First deliverable: reviewer commands that mute a kind of item for a repository, recorded in an auditable, replayable log.

---

## 1 Purpose, user experience and status

### 1.1 Why

F11 names noise as its main adoption risk: a few wrong or trivial comments get a bot uninstalled. Review bots address this by learning from reviewer reactions. CIE has a verdict ledger and a calibration gate for *claims* (`claims.ts`, 20 labelled verdicts per claim class before any confidence is shown), but nothing connects reviewer reactions on a PR comment to what the next comment shows.

This design adds that connection without adding a learned model. The "learning" is a deterministic, bounded function of a visible label log, so a team can see why the comment changed and reverse it.

### 1.2 Two different questions (the central design point)

| Label | Question | Feeds |
|---|---|---|
| **Correct / Incorrect** | Is this claim true of the code? | The existing claim ledger and calibration (`C18/verdict`), exactly as today |
| **Useful / Noise** | Was this worth a reviewer's attention? | The new ranking weights and mutes only |

A true claim can be noise ("`logger` now calls `format`"), and a false claim can look useful. Mixing the two would corrupt claim calibration with taste, and corrupt ranking with correctness disputes. They are separate labels in separate stores.

### 1.3 The experience

On an impact comment, a reviewer replies:

```
/cie noise 2          # item 2 was not worth surfacing
/cie useful 1
/cie wrong 3          # claim 3 is incorrect (goes to the claim ledger)
/cie mute MODULE_COUPLING          # stop surfacing this kind in this repository
/cie mutes            # list what is muted, by whom, since when
/cie unmute MODULE_COUPLING
```
The next comment's footer states the state in one line: "Ranking: default (0 labels) · 1 kind muted by @alex (14 Sep) — list". A muted item is not deleted: it is counted under "N muted items" so silence is never confused with absence.

### 1.4 What "done" means

1. Every change to what a repository sees is attributable to named labels and a named actor, and reversible with one command.
2. Recomputing the weights from the label log on another machine gives identical weights (§7.3).
3. Claim calibration counts are unchanged by useful/noise labels, and ranking is unchanged by correct/incorrect labels (§7.1).
4. A safety-class item cannot be silently muted away (§7.5).

### 1.5 Status

Proposed. Needs F14's command grammar for per-item labels; comment-level reactions alone are a weak signal (§7.2).

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** command labels; comment-level reaction ingestion as a weak signal; per-repository mutes with scope and optional expiry; bounded per-kind weight adjustment; a label log; footer disclosure; a share-page view of labels and weights; reset.

**Non-goals:** model training, fine-tuning or embedding learning of any kind; per-user personalisation; cross-repository sharing of labels; automatic muting from silence or from a PR's later fixes; changing a gate policy from feedback (the F02 gate stays policy-driven); editing a committed file in the repository.

**First delivery boundary:** mute/unmute and noise/useful commands, the log, and the footer. Weights come after real labels exist (slice 3).

---

## 3 Current state in this repository

### 3.1 What exists

| Capability | Where |
|---|---|
| Human verdicts (CONFIRM/REFUTE) per claim, stored with the principal and counted per claim class | `store.ts:290` `addVerdict`, `verdictCounts(claimClass)`; `C18/verdict` |
| A calibration gate that shows no confidence below 20 labelled verdicts per class; Wilson interval | `claims.ts` `CALIBRATION_MIN_LABELS`, `wilson` |
| Roles: viewer / editor / owner; an approver role for alarms; confirmers must be distinct authorised principals | `collab.ts`, `claim-ledger.ts:55–90` |
| Labels from the system or a script marked synthetic and never counted as expert labels | `evaluation.ts` header |
| Reviewer feedback on CIE's draft PRs: classified by fixed rules, redacted excerpt only, one record per external event id, out-of-order safe | `feature/review-feedback.ts` |
| Waivers that change who and until when but never hide a finding | `pr-gate.ts` |
| Every threshold carries a calibration status | convention in `Concept_Hierarchy_Implementation_Plan.md` §0, F11 §7.2 |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | No reading of reactions or replies on analysis comments; review-feedback is scoped to draft PRs CIE published | `feature/review-feedback.ts` header |
| G2 | The claim verdict models truth only; there is no usefulness label | `Verdict` kinds in schema (CONFIRM / REFUTE) |
| G3 | No per-repository mute or weight store | no module found |
| G4 | `GitHubTransport` has no way to list reactions on a comment | `pr-publish.ts` interface |
| G5 | Ranking in F11 is fixed weights; nothing can change them | F11 §7.2 |
| G6 | No rule for which feedback counts (distinct principals, bot exclusion, PR author weighting) outside the alarm-approver logic | `claim-ledger.ts` covers alarms only |

### 3.3 Not verified

- Whether reviewers will use commands at all; reactions are far more common. §14 measures it.
- The shape of the reactions API per forge (F19).
- Whether comment-level reactions carry any signal beyond "the bot commented".

---

## 4 Architecture and ownership

| Component | Responsibility |
|---|---|
| C18 Claim ledger | Receives correct/incorrect only; unchanged |
| C29 Collaboration | Roles that may label, mute and unmute |
| C12 Salience / F11 ranking | Consumes weights and mutes |
| C17 Evaluation | Marks label provenance (human / synthetic); publishes label counts and noise rate |
| C30 Exports | Footer, list command, share page |
| C04 Connectors | Reads reactions and replies (via F14 / F19 transport) |
| C03 Access | Who may see the log (counts for denied scope) |
| C31 Storage | Retention of the label log |

---

## 5 Reconciliation with existing contracts

- `C18/verdict` stays the only path to claim calibration. A `wrong N` command is translated to a REFUTE verdict on the claim behind item N, by a principal who passes the same authorisation as today.
- Usefulness labels get their own table and operation; they never call `addVerdict`.
- Mutes and weights are applied inside the F11 ranking step as inputs, recorded in the report's `rank.factors` (a muted kind appears as factor `MUTE`), so "why not?" can explain a suppression.
- The footer uses the same "uncalibrated / calibrated" vocabulary as F11.

---

## 6 Data model

```typescript
interface UsefulnessLabel { id: string; repositoryId: string; itemKind: ImpactItemKind | string; itemId: string; analysisId: string;
  label: "USEFUL" | "NOISE"; principalId: string; role: "viewer" | "editor" | "owner"; source: "COMMAND" | "REACTION";
  isPrAuthor: boolean; at: string; provenance: "HUMAN" | "SYNTHETIC" }

interface MuteRule { id: string; repositoryId: string; kind: string; scope: { type: "REPOSITORY" | "PATH_PREFIX" | "SYMBOL"; value?: string };
  createdBy: string; createdAt: string; expiresAt?: string; reason?: string; revokedBy?: string; revokedAt?: string }

interface KindWeight { repositoryId: string; kind: string; weight: number; labels: { useful: number; noise: number; principals: number };
  status: "default" | "uncalibrated-adjusted"; computedFromLogHash: string }
```

Tables in the existing SQLite store: `usefulness_labels`, `mute_rules`, `kind_weights` (derived, rebuildable). The label log is append-only; a retraction is a new row.

---

## 7 Algorithms and rules

### 7.1 Separation

`noise`, `useful` write to `usefulness_labels`. `wrong`, `right` write a verdict through `C18/verdict`. A single command never writes to both, and there is a test that claim calibration counts do not move on usefulness labels (F15-A2).

### 7.2 What counts

1. A label counts only from a human principal with at least `viewer` role on the repository; bot accounts are excluded.
2. One live label per `(principal, itemKind, repository, analysis)`; a newer one replaces it in the derived counts but stays in the log.
3. Comment-level reactions: 👍 and 👎 on the impact comment are recorded as `source: REACTION` with `itemKind: "COMMENT"` and never change per-kind weights; they feed only the overall noise-rate display. (A reaction cannot say which item it refers to.)
4. The PR author's labels are recorded and shown separately; they do not count toward the distinct-principal minimum.
5. "Resolved in a later push" is an observation, not a label, and is not used in v1 (a consequence can disappear for unrelated reasons).

### 7.3 Weight function

For repository *r* and kind *k*, with `u` useful and `n` noise labels from at least `P` distinct non-author principals (default `P = 2`) and `u + n ≥ MIN_FEEDBACK` (default 10, `uncalibrated`):

```
rate  = lower bound of the Wilson interval for u / (u + n)     (reuses wilson())
weight = clamp(0.5 + rate, 0.5, 1.5)
```
Below the minimum, `weight = 1.0` and status is `default`. The function is pure and depends only on the label log, so it is replayable; `computedFromLogHash` records the log it was computed from. Weight changes are bounded to one step of at most 0.25 per recompute, so a few angry reviews cannot swing ranking.

### 7.4 Mutes

A `MuteRule` removes matching items from `surfaced` into a counted `muted` list. Creating a mute needs `editor` role; scope `REPOSITORY` needs `owner`. An optional `expiresAt` (default 90 days) prevents forgotten mutes. A mute never changes what is stored in `suppressed`, so `why-not` still explains it.

### 7.5 Safety floor

Item kinds in a declared safety-class list (initially `TRANSACTION_BYPASS`, `TESTS_LOST`, and any kind F11 marks as safety-relevant) cannot be muted at path or symbol scope by an `editor`, only by an `owner`, and a muted safety item is shown as a one-line count with its kind ("1 muted item of kind TRANSACTION_BYPASS") rather than disappearing entirely. This is a stated rule that the footer reproduces; it is not hidden policy.

### 7.6 Disclosure

Every comment footer states: ranking status (default or adjusted from N labels), the number of muted items and kinds, and a link to the log. The share page lists every label and mute with actor and date.

### 7.7 Reset

`/cie reset-ranking` (owner) appends a reset marker; weights return to default; labels remain in the log.

---

## 8 API contracts

New operations: `C17/recordUsefulness {itemId, label}` (mutating); `C29/setMute {kind, scope, expiresAt?}` and `C29/clearMute {id}` (mutating); `C17/getFeedbackState {repositoryId}` → labels counts, weights, mutes, status (read-only); `C17/recomputeWeights {repositoryId}` (mutating, derived data only). Commands in F14's grammar map onto these. Transport addition (F19): `listReactions(commentId)`.

---

## 9 States and lifecycles

Weight status: `default` → `uncalibrated-adjusted` when the minimums are met → `default` on reset. Mute: Active → Expired | Revoked. Labels are immutable rows.

---

## 10 Authorization, egress, threat model

1. **Who may label, mute.** By role, as in §7.4. Role lookup uses the forge permission of the commenter mapped to CIE roles (decision D2).
2. **Brigading.** A single person cannot move a weight (distinct-principal minimum); a mute is scoped, expiring and attributable; a safety-class mute has a floor.
3. **Poisoning through comment text.** Only the command and an integer or kind token are parsed; free text in the comment is not stored beyond a redacted, length-limited reason on a mute.
4. **No egress.** No model is involved; the footer and share page contain counts, kinds, principal names and dates. Whether principal names may appear in a public repository's comment is decision D3 (the history features already treat contributor names as a granted capability: `C26/grantContributorNames`).
5. **Retention.** The log is bounded and retained under the store's lifecycle (C31); deleting the repository deletes its labels.

---

## 11 Freshness, idempotency, recovery

Commands are idempotent per `(comment id, content hash)` (F14 §11). Weights are derived and rebuilt from the log after a crash or schema change. Reports record which feedback state they were ranked under, so an old report is explainable after weights change.

---

## 12 Interface specification

Footer copy: "Ranking: default — no feedback yet" or "Ranking adjusted from 23 labels by 4 reviewers (uncalibrated) · 1 kind muted · log". Never "learned" or "trained". The help text names the commands. The share page shows a table: kind, useful, noise, principals, weight, status, muted-by.

---

## 13 Performance and bounded work

Recompute is a bounded aggregate over one repository's labels; cap the log read per recompute (default 10,000 rows) and disclose truncation. Command handling is constant time.

---

## 14 Evidence plan

1. **Usage first (before slice 3).** In the first installs, count how many reviewers use commands versus reactions. If almost none use commands, per-item weights will never fill; the design then falls back to mutes only, which still reduce noise.
2. **Does it reduce noise.** Compare the rate of NOISE labels per surfaced item before and after the first mute on a repository. Report counts with denominators; small numbers get small claims.
3. **Does it hide real problems.** Track muted-then-regretted events (an owner unmutes within 30 days) as a lower bound on over-muting. This is a proxy, not a measure.
4. What this cannot establish: that fewer comments means better review. That needs a defect measure, as in F11 §14.

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | Specify the safety-class list; inventory F11 item kinds; choose `MIN_FEEDBACK` and `P` provisionally | NEW (decision record) |
| S1 | `mute_rules`, `usefulness_labels`, operations, commands (needs F14 grammar), footer | NEW `feedback.ts` + EXISTING_EXTEND (`collab.ts`, F11 ranking) |
| S2 | Reaction ingestion as weak signal; share-page view; reset | NEW + EXISTING_EXTEND (transport) |
| S3 | Weight function and replay test, after labels exist | NEW (pure function) + EXISTING_REUSE (`wilson`) |

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F15-A1 | Replaying the label log on a fresh store gives identical weights and `computedFromLogHash` |
| F15-A2 | Usefulness labels do not change `verdictCounts`; verdicts do not change ranking |
| F15-A3 | One principal's labels cannot move a weight; the PR author's labels do not count toward `P` |
| F15-A4 | Bot-account labels are excluded |
| F15-A5 | A muted item is counted in `muted`, still explainable by `why-not`, and never deleted from `suppressed` |
| F15-A6 | An `editor` cannot mute a safety-class kind at path/symbol scope; an `owner` can, and the comment still shows the count |
| F15-A7 | Weight change per recompute is bounded to 0.25 and clamped to [0.5, 1.5] |
| F15-A8 | Mute expiry and revoke work; expired mutes are reported |
| F15-A9 | Footer states ranking status and muted counts exactly as stored; a mutated footer is rejected |
| F15-A10 | Comment-level reactions never change per-kind weights |
| F15-A11 | Free text in a command is not stored beyond the redacted, length-limited mute reason |
| F15-A12 | Reset returns weights to default and leaves the log intact |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Where mutes live: CIE's store, or a committed `.cie/feedback.json` | Store for local-first; CI mode reads a committed file the team maintains, because CIE never writes to the working tree. Decide before the CI runner ships |
| D2 | Mapping forge permissions to CIE roles | Write → editor; admin → owner; read → viewer |
| D3 | Principal names in public comments | Off by default; counts only |
| D4 | `MIN_FEEDBACK` and `P` | Start at 10 and 2 as `uncalibrated`; revisit from usage data |
| D5 | Safety-class list | Decide in S0 from the F11 kinds |
