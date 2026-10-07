# F19 — Forge abstraction and GitLab, Bitbucket and Azure DevOps support

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §3–§4. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree. No vendor API for any forge other than GitHub was consulted for this document; every non-GitHub contract below is a requirement to verify, not a fact.
Priority P3 for new forges; P1 for the interface extraction behind GitHub, which should happen early so F11, F13, F14, F16 and F17 do not harden around `gh`.

---

## 1 Purpose, user experience and status

### 1.1 Why

The leading review bot works across GitHub, GitLab, Bitbucket and Azure DevOps. CIE runs only against GitHub: every forge-facing implementation shells out to the `gh` CLI or calls the GitHub REST API. Teams on other forges cannot use the PR features at all, and every new feature in F11–F18 adds more GitHub-specific code unless the seams are made explicit first.

### 1.2 The experience

For a repository whose `origin` is a GitLab project, the developer or CI job runs the same commands as for GitHub (`cie pr-check`, F11) and gets the same cited comment on the merge request. Where the forge cannot do something, the comment says what was substituted:

```
CIE blast radius — head a19a978 · GitLab merge request !482
Capabilities on this forge: comment ✓ · status ✓ · inline suggestion ✗ (shown as a diff block) · reactions ✗ (use /cie noise 2)
```

### 1.3 What "done" means

1. All existing GitHub behaviour is unchanged by the extraction, proved by the existing test suites (§16 A1).
2. A second forge passes the same contract tests as GitHub, run against **captured real exchanges** as well as scripted ones (§16 A6).
3. Every degraded capability is stated in the output rather than silently dropped (§7.4).
4. No credential is stored; each forge's token is read at call time, as for `gh` today (§10).

### 1.4 Status

Proposed. S1 (interface extraction) has no user-visible change.

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** a forge identity model; a capability-based interface composed from the existing seams; a capability matrix with disclosed degradation; per-forge authentication, transport, webhook verification and CI templates; migration of identifiers; contract tests.

**Non-goals:** forges other than GitHub, GitLab, Bitbucket Cloud and Azure DevOps; merging, approving or any write beyond what GitHub already allows (statuses, comments, draft PRs, review comments under F16); a hosted multi-forge service; repository hosting migration tools; supporting a forge feature that cannot be verified from vendor documentation and a captured exchange.

**First delivery boundary:** S1 (extraction, GitHub only), then GitLab as the first additional forge (S2–S3). Bitbucket and Azure DevOps follow only after GitLab proves the interface.

---

## 3 Current state in this repository

### 3.1 What exists

| Seam | Where | Shape |
|---|---|---|
| Publisher transport | `pr-publish.ts:22` `GitHubTransport` | head lookup, visibility, status, find/post/update comment |
| Draft-PR forge | `defect-workflow.ts:24` `DraftForge`; `gh-forge.ts` `GhDraftForge` | resolve, find, createDraft |
| Issue forge | `feature/issue-forge.ts` `IssueForge`, `GhIssueForge` | read/create/update one issue, comments, labels |
| CI forge | `feature/ci-forge.ts` `CiForge`, `GhCiForge` | reviews, checks, Dependabot, code scanning, workflows, releases (read-only) |
| Review source | `feature/review-feedback.ts` `ReviewSource`, `GhReviewSource` | review/comment/inline events |
| Read connector | `connectors.ts` `ForgeConnector`, `Transport` (GET only) | validated ingest of PRs, rate-limit and expiry states |
| Injected command runner | `gh-forge.ts` `GhRunner` | arguments as an array, never a shell string; tests inject scripted runners |
| A `forge` field on PR references | `PullRequestRef.forge`, `PrRef.forge`, publication receipts | a string, currently always `"github"` |
| Failure classification onto a common vocabulary | `gh-forge.ts` `classifyGhFailure` (EXPIRED, RATE_LIMITED, UNREACHABLE, NOT_FOUND, REFUSED) | reusable vocabulary |
| Tests that run without a network | `pr-flow.test.ts`, `ci-forge.test.ts`, `gh.test.ts`, `pr-gate.test.ts` | scripted GitHub |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | Authentication is the `gh` CLI only; no other forge's credential mechanism | `gh.ts` `ghAuthToken`, `ghAuthStatus` |
| G2 | The origin-URL parser accepts exactly `host/owner/repo` (two path segments), so a GitLab subgroup project (`group/sub/project`) and an Azure DevOps URL (`org/project/_git/repo`) return null | `gh.ts:44–52` regexes |
| G3 | `"github"` is hard-coded in publication receipts, the PR-analysis default and the webhook handler | `pr-publish.ts:178, 180, 294`; `service.ts:1177, 1301` |
| G4 | Source ids are `gh:owner/repo`, which cannot represent a nested namespace or a non-GitHub host | `gh.ts` `ensureGhForgeConnector` |
| G5 | The webhook intake verifies GitHub's HMAC header and handles GitHub event names | `service.ts:1257–1305` |
| G6 | API paths, headers (`x-github-api-version`) and status semantics are embedded in the transport | `gh.ts` `ghTransport`; `pr-publish.ts` `githubRestTransport` |
| G7 | At least eight files call or wrap `gh` directly | `gh.ts`, `gh-forge.ts`, `service.ts`, `campaign-runner.ts`, `feature/ci-forge.ts`, `feature/issue-forge.ts`, `feature/review-feedback.ts` (and tests) |
| G8 | Terminology is GitHub's throughout (pull request, number, check run). Other forges use different words and identifiers | UI and schema strings |
| G9 | The README states that forge fixtures are authored by hand, not captured, because capturing needs a real account | `README.md` (limits section) |

### 3.3 Not verified

- Every non-GitHub API: endpoints, authentication options, rate limits, webhook verification, inline comment anchoring, suggestion support, status versus check semantics, and self-hosted differences.
- The CLI tools other forges offer, and whether they expose a usable token.
- How `service.ts` and `campaign-runner.ts` use `gh` beyond the transports above.

---

## 4 Architecture and ownership

```
          Forge (capabilities, §6)
   ┌────────┬────────┬────────┬────────┬────────┐
 comments statuses  review   draftPR  issues   ci   webhooks
   │        │        │        │        │        │       │
   └──── GitHub adapter (existing code, moved behind the interface) ────┘
   └──── GitLab adapter (new)  ·  Bitbucket adapter (later)  ·  Azure adapter (later)
```

| Component | Responsibility |
|---|---|
| C04 Connectors | Forge identity, detection, adapters, webhook verification, failure vocabulary |
| C30 Exports | Publisher uses capabilities, discloses degradation |
| C03 Access, egress | Per-forge host allowlist, token handling |
| C32 Operations | CI templates per forge, packaging, migration |
| C17 Evaluation | Contract suite and captured-fixture registry |

---

## 5 Reconciliation with existing contracts

- The existing interfaces (`GitHubTransport`, `DraftForge`, `IssueForge`, `CiForge`, `ReviewSource`) are **kept and renamed or aliased**, not rewritten. They become the capability interfaces; the `Gh*` classes become the GitHub adapter. Behaviour must not change in S1.
- `PullRequestRef.forge` becomes a typed `ForgeKind` (`"github" | "gitlab" | "bitbucket" | "azure"`); `"github"` stays the default so stored rows remain valid.
- Source ids move from `gh:owner/repo` to `{kind}:{host}/{namespace…}/{project}`; the old form remains an accepted alias and is migrated lazily (decision D2).
- The failure vocabulary (`EXPIRED`, `RATE_LIMITED`, `UNREACHABLE`, `NOT_FOUND`, `REFUSED`) is the contract every adapter maps onto; UI and policy code do not see forge-specific errors.
- The egress and untrusted-text rules (study §2) apply unchanged to every adapter.

---

## 6 Data model

```typescript
type ForgeKind = "github" | "gitlab" | "bitbucket" | "azure";

interface ForgeIdentity {
  kind: ForgeKind; host: string; port?: number;
  namespace: string[];            // ["group","sub"] for GitLab; ["org","project"] for Azure; ["owner"] for GitHub
  project: string;                // repository name
  apiBase: string;                // derived, or configured for self-hosted
  selfHosted: boolean;
}

type CapabilityState = "SUPPORTED" | "EMULATED" | "UNSUPPORTED";
interface ForgeCapabilities {
  comment: CapabilityState; commentReply: CapabilityState; status: CapabilityState; checkRun: CapabilityState;
  inlineComment: CapabilityState; suggestion: CapabilityState; reactions: CapabilityState;
  draftPr: CapabilityState; issues: CapabilityState; ciRead: CapabilityState; webhookVerify: CapabilityState;
  notes: Partial<Record<keyof ForgeCapabilities, string>>;   // what an EMULATED capability is emulated with
}
```
`ForgeCapabilities` is a static table per adapter, asserted by contract tests, and is carried in the F11 report so the renderer can disclose it. A `forge_identity` mapping replaces ad-hoc slug parsing; a configured list `forges: [{host, kind, apiBase?}]` covers self-hosted installations.

---

## 7 Algorithms and rules

### 7.1 Detection

Parse the `origin` URL into a `ForgeIdentity`: `ssh://`, `git@host:path`, `https://host[:port]/path`, with any number of path segments, optional `.git`, optional credentials stripped. Kind comes from (1) the configured host list, then (2) the well-known public hosts. An unknown host is **not guessed**: the result is "unknown forge; configure `forges`", and PR features are disabled with that reason.

### 7.2 Capability use

Callers ask `forge.capabilities`, never the kind. A caller that needs an unsupported capability uses the documented substitute and sets a disclosure string; it never branches on `kind === "gitlab"` (a lint-style test greps for it, §16 A4).

### 7.3 Authentication

Per adapter, in this order: an explicit environment variable named in configuration; the forge's own CLI session if one exists; the CI-provided job token. The token is read at call time and never stored or logged, matching `gh.ts`. A missing or expired token is the existing `EXPIRED` state.

### 7.4 Degradation disclosure

Every report carries `capabilities` and a list of substitutions in effect, rendered as one line at the top of the comment ("suggestions not supported on this forge; shown as a diff block"). A capability marked `EMULATED` has a stated emulation and a test.

### 7.5 Webhooks

Each adapter supplies a verifier for its forge's scheme (header names and algorithm differ by forge; for GitLab I understand it uses a shared secret token header rather than an HMAC, which must be verified against current documentation) and an event normaliser that maps forge events to CIE's `PrEvent` (opened, updated, comment, review) before any shared logic runs. `C04/ingestWebhook` becomes forge-aware by dispatching to the adapter; GitHub's behaviour is unchanged.

### 7.6 Identifiers and terminology

Internally keep `prNumber`/`iid` as `prNumber` with `forge` qualifying it; display strings use the forge's own word ("pull request", "merge request") from a small table. The review page and comments are generated from that table.

### 7.7 Contract tests

One shared suite exercises every capability against any adapter using (a) a scripted transport (the existing injected-runner pattern) and (b) captured real exchanges stored as fixtures with a capture record (date, account type, tool version). A capability may be marked `SUPPORTED` only if a captured exchange exists for it (§16 A6).

---

## 8 API contracts

New: `C04/detectForge {repoPath}` → `ForgeIdentity` or the reason for none (read-only); `C04/forgeCapabilities {repositoryId}` → `ForgeCapabilities` (read-only). Changed (additive): `C23/analyzePullRequest` accepts and validates `forge`; `C04/ingestWebhook` accepts an adapter selector. CLI: `cie forge-check` prints the detected identity, capabilities and token status (never the token).

---

## 9 States and lifecycles

Forge connection states reuse `SourceState` (`HEALTHY`, `PARTIAL`, `EXPIRED`, `RATE_LIMITED`, `UNREACHABLE`, `NEVER_RUN`). A repository with an unknown forge is in a distinct `UNCONFIGURED` state that the UI shows with the fix.

---

## 10 Authorization, egress, threat model

1. **Host allowlist.** Requests go only to the host named by the repository's detected or configured identity. Redirects to another host are refused. This blocks a malicious `origin` URL or a poisoned config from pointing the bot's token elsewhere (server-side request forgery).
2. **Token handling.** Read at call time from the named variable, CLI or job token; never stored, logged or placed in an error message. Error text passes the existing redaction.
3. **Least privilege.** Each adapter documents the minimum token scope for comments and statuses; the CI templates request only that.
4. **Self-hosted TLS.** Certificate validation stays on; a configured custom CA is allowed, disabling verification is not.
5. **Webhook authenticity.** A forge's webhook is accepted only if its verifier passes; an unsigned or unverifiable delivery is refused, as today.
6. **Fork and cross-repository PRs.** Each forge's model for forks differs (write scope on fork-triggered runs, secret availability). The F11 §10.3 rule applies: no write credentials on a fork-triggered run; the result goes to a job summary.
7. **Untrusted text** from any forge is `untrusted: true` and handled as in study §2.

---

## 11 Freshness, cancellation, idempotency, recovery

Idempotency is by marker as today, with the marker format forge-neutral. The head-moved check (`resolvePrHead`) is a required capability on every adapter; an adapter that cannot provide it cannot publish. Rate-limit handling reuses the `RATE_LIMITED` resume-from-cursor behaviour.

---

## 12 Interface specification

The capability line at the top of each comment (§1.2); forge-correct terminology; the review page shows the forge, host and the capability table. CLI `forge-check` output is plain text with one line per capability and its state.

---

## 13 Performance and bounded work

No new heavy work. Detection is a string parse plus an optional host lookup. Rate limits are per forge and honoured through the existing state machine. All adapters share the existing page-size and retry bounds in `connectors.ts`.

---

## 14 Failure modes

| Failure | Behaviour |
|---|---|
| Unknown self-hosted host | `UNCONFIGURED`; PR features off; message names the config key |
| Subgroup or `_git` URL | Parsed by the new detector; previously returned null |
| Capability unsupported | Documented substitute plus one-line disclosure |
| Forge rate limit | `RATE_LIMITED`, idempotent retry |
| Token expired | `EXPIRED`; analysis proceeds, publication waits |
| Webhook unverifiable | Refused, nothing applied |
| Forge API changes under a pinned adapter | Contract tests fail in CI; capability downgraded until fixed |
| Redirect to another host | Refused |

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | Choose the first additional forge; verify its API contract against current vendor documentation; obtain a real test account; capture a minimal set of real exchanges | NEW (decision record, fixtures) |
| S1 | Introduce `ForgeIdentity`, `ForgeKind`, capability interfaces and the adapter registry; move `Gh*` code behind them; new URL parser with subgroup and `_git` support; no behaviour change | EXISTING_EXTEND (`gh.ts`, `gh-forge.ts`, `pr-publish.ts`, `feature/*-forge.ts`, `service.ts`, `campaign-runner.ts`) |
| S2 | GitLab adapter: comments, status, head lookup, draft MR, read connector | NEW `forges/gitlab.ts` |
| S3 | GitLab webhook verifier and event normaliser; CI template; capability matrix and disclosure line | NEW + EXISTING_EXTEND (`C04/ingestWebhook`) |
| S4 | Inline comment and review capabilities per adapter (for F16) | NEW per adapter |
| S5 | Bitbucket Cloud and Azure DevOps adapters, one at a time, each with captured fixtures | NEW |

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F19-A1 | After S1, the existing `pr-flow`, `ci-forge`, `gh`, `pr-gate` and feature-pipeline suites pass unchanged |
| F19-A2 | URL parsing: `git@host:a/b.git`, `https://host:8443/a/b/c/d.git`, `ssh://git@host/a/b`, Azure `https://dev.azure.com/org/proj/_git/repo`, credentials stripped, `.git` optional; unknown host returns "configure forges", not a guess |
| F19-A3 | Source ids round-trip; a legacy `gh:owner/repo` id resolves to the same repository |
| F19-A4 | No code outside an adapter branches on `forge === "<kind>"`; callers use capabilities (a grep test) |
| F19-A5 | An unsupported capability yields the documented substitute and a disclosure string in the report |
| F19-A6 | A capability is `SUPPORTED` only if a captured real exchange exists for it; each fixture has a capture record |
| F19-A7 | The failure vocabulary maps from each adapter's errors; no forge-specific error reaches policy code |
| F19-A8 | A redirect to a different host is refused; the token is never sent to it |
| F19-A9 | Tokens never appear in logs, errors, receipts or stored rows (a test greps the store and audit log) |
| F19-A10 | An unverifiable webhook is refused for every adapter; a replayed delivery is not applied twice |
| F19-A11 | `resolvePrHead` is required: an adapter without it cannot publish |
| F19-A12 | The same F11 report renders on GitHub and GitLab with only the capability line and terminology differing |
| F19-A13 | Self-hosted TLS verification cannot be disabled by configuration |
| F19-A14 | Stored rows with `forge = "github"` remain valid after migration |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | First additional forge | GitLab, because of self-hosted demand among teams that cannot use a cloud bot; confirm with real prospects before committing |
| D2 | Source-id migration | Lazy, keep `gh:` as an alias indefinitely |
| D3 | Self-hosted configuration location | `forges` list in CIE configuration, not inferred |
| D4 | Real accounts for fixture capture | Owner provides a test account per forge before its S0 completes |
| D5 | When to extract the interfaces | Immediately (S1), before F11–F17 add more `gh` coupling |
