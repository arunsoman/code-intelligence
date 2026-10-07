# D001 — Declaration authority

**Status:** Accepted product-policy baseline, 2026-10-06
**Origin:** GitHub issue #98, decision 1
**Unblocks:** #94 and #88

Declarations are evidence-bearing decisions. A missing or unverifiable authority binding never silently weakens a gate: the affected result remains **REVIEW ONLY** (or blocked where policy forbids execution), with the missing authority named.

| Declaration | Permitted declarer | UX and audit behavior |
|---|---|---|
| Confirm a generated acceptance criterion | Requester / feature owner | Per criterion; keep generated text and confirmed text; record actor, time and rationale/decision link. |
| Edit an expected outcome | Requester / feature owner | Allowed as a new audited decision; preserve prior versions and invalidate dependent candidate/validation evidence. |
| `REPRESENTATIVE` environment | Principal bound to validation authority | Requester alone cannot self-certify unless explicitly bound. Show principal and binding. |
| Dependencies `AVAILABLE` | Validation authority | Show evidence/source and actor. Missing binding or unavailable dependency keeps the gate incomplete. |
| Test data `SYNTHETIC` | Requester may declare | Record declaration and actor. |
| Test data `AUTHORIZED_REDACTED` | Data/security authority | Require an explicit scoped binding and authorization reference. |
| Performance not applicable | Performance/release authority | Record scope and rationale; show “Not measured — performance declared not applicable by [principal]” and do not present it as a pass. |
| T1 operational note | Requester drafts; reviewer confirms | Draft is not a confirmed operational decision until reviewer confirmation is recorded. |
| T2 release/revert plan | Release authority | Require an explicit scoped binding; review approval does not grant deployment authority. |

### UI contract

The Validate stage groups acceptance decisions, environment representative status, dependency availability, test-data declaration, performance outcome and the computed result. Each row shows state, declarer/binding and evidence or rationale. Deliver groups the T1 operational note, T2 release/revert plan and publication authority. The final eligibility state is derived by the gate; UI declarations cannot directly set VERIFIED.

Every write checks the current authority binding at commit time. Revocation, missing authority, stale decision version or an edited expected outcome invalidates dependent evidence. Store principal identities as configuration; this decision does not invent or bind a real person.
