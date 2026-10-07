# System study for F11–F19

Version 0.1 · 7 October 2026 · Evidence document supporting F11–F19

Method: the source was read directly (file and line references below), at commit `b5f099c` plus the uncommitted working tree of that day (release-scope and release-form files were modified and uncommitted). Nothing was executed except `ls`, `grep`, `wc` and `sed`. "Exists" means the code was read; it does **not** mean it was run, and several modules were read only at their header and exported signatures. "Not verified" marks what was not read.

This study replaces the first-pass gap list in the earlier competitor comparison. That list came from keyword searches and was partly wrong: the prompt-to-feature pipeline in `packages/core/src/feature/` already holds a GitHub issue forge, review-feedback ingestion, a CI/security forge and a dependency review. The corrected picture is in §4.

---

## 1 What the system is

| Layer | Contents | Evidence |
|---|---|---|
| Core service | One `Service` class (2,318 lines) exposing typed operations grouped by component (`C01`–`C32`), a SQLite store, a job scheduler, a Rust worker client | `packages/core/src/service.ts`, `store.ts`, `jobs.ts`, `worker.ts` |
| Gateway | Loopback-only HTTP, `POST /api/v1/components/{C}/{op}`; identity from an injected `identify()` hook, never from the body; 8 MB body cap; mutating operations require an `Idempotency-Key`; one `Service` per tenant behind `TenantHost` | `server.ts` (255 lines), `tenants.ts` |
| Result contract | `ApiResult<T>` with `metadata.completeness`, `metadata.warnings`, and typed error codes mapped to HTTP statuses (`BUDGET_EXCEEDED` 429, `FORBIDDEN` 403, `PROVIDER_UNAVAILABLE` 503, …) | `server.ts`, `packages/schema/src/index.ts:64–79` |
| Analysis | Index of TypeScript, Rust and Nirdosha v2; fact graph; semantic diff; sixteen visual forms; salience; hypothesis engine; counterfactual twin; defect detectors | `indexer.ts`, `graph.ts`, `history.ts`, `forms/*`, `salience.ts`, `c22/`, `twin-*.ts`, `defect*.ts` |
| Claims | Five gates (grounding, consistency, adversarial, calibration, display); a ledger; human verdicts with a minimum of 20 labels per claim class before any confidence is shown | `claims.ts`, `claim-ledger.ts` |
| PR | Per-PR analysis job, versioned gate policy, idempotent status/comment publisher bound to the head commit | `pr-analysis.ts`, `pr-gate.ts`, `pr-publish.ts` |
| Generation | Prompt-to-feature: requirements → contract → exact byte-edit candidate → validation → draft PR; never merges | `feature/*` (about 70 files) |
| Chat | A model that calls read-only tools and may cite only ids those tools showed it; bounded to 8 turns, 14 calls | `chat-agent.ts`, `chat-tools.ts`, `chat-plan.ts` |
| Models | Gateway with per-repository egress opt-in, secret scrubbing, budget and audit; Ollama and stub providers; a closed-list router for small local models | `packages/model/`, `service.ts:660`, `llm-router.ts` |
| Clients | React web app (`apps/web`), VS Code extension (`extensions/vscode`, loopback only), exception reporter package | `apps/web/src`, `extensions/vscode/src`, `packages/reporter` |
| Evidence of testing | 164 test files in `packages/core/test`; a ledger (`docs/ledger.json`) where an item is "done" only when named tests back it | `docs/ledger.json`, `scripts/ledger.py` |

## 2 Constraints every F11–F19 design must respect

These are properties of the existing system, not preferences of these documents.

1. **Evidence or abstention.** Every displayed claim has a class (Fact, Inference, Hypothesis, Fog) and resolvable evidence. A model-authored claim never displays as Fact, and a human confirmation is a verdict, not proof (`claims.ts` header). New features must route through the same gates or state why they do not.
2. **Outside text is data.** Pull requests, issues, comments and retrieved code are untrusted; they are shown and cited, never followed (`connectors.ts` marks records `untrusted: true`; `feature/authority.ts` `guardRetrievedText`; `feature/finding-proposer.ts` system prompt).
3. **Egress is decided by code.** Model calls go through the gateway with a per-repository opt-in (`service.ts:660`); generation routes are allowed under `LOCAL_ONLY` only for literal loopback endpoints (`feature/model.ts:65`); outgoing issue and PR text is built from an allowlist and refused, not altered, if it looks like a secret (`feature/issue-trail.ts` `guardOutgoing`).
4. **Never merge, approve, or write a protected branch.** The only forge writes today are statuses, comments, issue edits for issues CIE opened, and create-draft-PR (`pr-publish.ts`, `gh-forge.ts`, `feature/issue-forge.ts`).
5. **Local models are small.** The project policy is to use only Ollama models already installed and never pull one (project memory: `feedback_no-model-pulls`; minimal tier `llama3.2:1b`, measurement in `docs/eval-tiny-models.json`). Any feature that needs fluent prose from a model must have a deterministic path that is acceptable without one.
6. **Revision binding.** Results are bound to exact revisions; a moved head makes a result stale and it is superseded, never silently reused (`pr-analysis.ts`, `pr-publish.ts`).
7. **Access control withholds by count.** Denied paths are never named, only counted (`access.ts`).
8. **Honest labels.** "No findings" never means "safe"; calibration is "uncalibrated" until measured; every threshold carries a status.
9. **Forge access is `gh` only today.** Authentication reads a token at call time from the `gh` CLI and never stores it (`gh.ts`).

## 3 Seam inventory (what new features plug into)

| Seam | Where | Shape | Used by |
|---|---|---|---|
| Operation table | `server.ts:45–128` | `{ mutating, run(ctx, body) }` per `C{n}/{op}` | F12 (tool adapter), every new operation |
| Chat tool registry | `chat-tools.ts:107` (`CHAT_TOOLS`) | name, description, JSON schema, handler returning text plus cited ids | F12 (seed of the MCP tool set), F14 |
| PR analysis job | `pr-analysis.ts` `PrAnalysis` | base/head checkout, index, `history.compare`, findings, tests, decision | F11, F13, F14, F16, F17 |
| Semantic diff | `history.ts:85–160` | consequences, blast radius, test impact, gaps | F11, F13, F17 |
| Gate and policy | `pr-gate.ts` | versioned, hash-addressed policy; pure `evaluate()` | F11, F15, F17 |
| Publisher transport | `pr-publish.ts:22` `GitHubTransport` | head lookup, visibility, status, find/post/update comment | F11, F13, F14, F16, F19 |
| Draft-PR forge | `defect-workflow.ts:24` `DraftForge` | resolve, find, createDraft | F16, F19 |
| Issue forge | `feature/issue-forge.ts` `IssueForge` | read/create/update one issue, comments, labels | F17, F19 |
| CI forge | `feature/ci-forge.ts` `CiForge` | reviews, check runs, Dependabot, CodeQL, workflows, releases (read-only) | F15, F19 |
| Review source | `feature/review-feedback.ts` `ReviewSource` | review, comment and inline events on CIE's draft PRs | F14, F15 |
| Forge ingest and webhooks | `connectors.ts` `ForgeConnector` (`receiveWebhook`); `service.ts:1258` `C04/ingestWebhook` | validated, quarantining ingest; HMAC-verified (`sha256=` signature header, secret from `CIE_WEBHOOK_SECRET`), replay-safe via `ext_deliveries`; the PR handler accepts `pull_request` opened/synchronize/reopened only and finds the local clone by origin remote | F11, F14, F15, F19 |
| Verdict ledger | `store.ts:290` `addVerdict`, `C18/verdict` | CONFIRM/REFUTE by principal and claim class | F15 |
| Isolated execution | `isolated-exec.ts` | copy tree, apply byte-exact edits, typecheck, run tests under Node's permission model, tree diff, hash | F16, F18 |
| Candidate engine | `feature/candidate.ts`, `generate.ts` | model-proposed edits become byte-exact edits that are re-checked | F16, F18 |
| Requirements and acceptance | `feature/requirements.ts`, `acceptance.ts`, `conflicts.ts` | structured requirements, acceptance criteria, conflict findings | F17 |
| Static test links | `feature/test-links.ts`, `testartifacts.ts` | explicit and static links; coverage never claimed without an artefact | F17, F18 |
| Model adapter | `feature/model.ts` | routes, budgets, egress check, recorded runs | F13, F17, F18 |
| Grounded composer | `answer.ts` | sentences composed from the same material as a view; names what the picture shows and how sure each part is | F13 |
| Access policy | `access.ts` | denied prefixes, counted not named | all |
| Roles | `collab.ts` (`viewer`/`editor`/`owner`), `claim-ledger.ts` (`alarm-approver`) | who may confirm or approve | F15 |

## 4 Corrected gap map

For each capability a competitor has, what already exists and the real gap. This is the basis of the F12–F19 scopes.

| Capability | Building blocks that exist | Real gap | Design |
|---|---|---|---|
| Agent-facing context (MCP) | Operation table; `CHAT_TOOLS` with schemas and cited-id discipline; loopback gateway; `identify()` hook; `ApiResult` completeness/warnings | No MCP server; no tool adapter; no handling of index staleness when an agent edits files | F12 |
| PR summary and walkthrough | `history.compare`; `answer.ts` grounded composer; changed-file list in `PrAnalysisView` | No natural-language summary of a PR; `view().changes` is returned empty (`pr-analysis.ts:1015`) | F13 |
| Chat inside the PR thread | `chat-agent.ts`; comment find/post/update; HMAC-verified webhook intake `C04/ingestWebhook` (handles `pull_request` events only); `ReviewSource` | No handling of `issue_comment` / review-comment events; no per-PR chat scope (head revision, changed set); no reply path with injection controls | F14 |
| Learning from reviewer reactions | Verdict ledger with calibration gate; roles; `review-feedback.ts` (classifies feedback on CIE's *draft PRs*) | No reaction/reply ingestion on analysis comments; no per-repository mutes or weights; nothing connects verdicts to PR ranking | F15 |
| One-click suggested fix | Finding→candidate→validation→draft-PR pipeline; byte-exact edits; isolated validation | The publisher has no inline-review-comment call, so no `suggestion` blocks; no rule for which validated candidates are small enough to suggest | F16 |
| Ticket / acceptance compliance | `IssueForge.getIssue`; requirements and acceptance extraction; `conflicts.ts`; `mentions.ts`; static test links; release-scope issue lookup | No PR→ticket linking; no Jira or Linear connector (grep for "jira" returns nothing); no per-criterion evidence report | F17 |
| Test generation | `toFeatureEdits` with `CREATE_FILE`; `runTestsIn` in a permission-restricted scratch tree; "reproduce the failure twice" precedent in `defect-workflow.ts:295`; `test-links.ts` | No generator for tests; no acceptance rule for a generated test; TypeScript-only runner | F18 |
| Other forges | A `forge` discriminator already on `PullRequestRef` and `PrRef`; the seams listed in §3 are interfaces | Every implementation is `gh`-backed; no GitLab, Bitbucket or Azure DevOps transport; no capability matrix | F19 |

## 5 What was not verified

- How a forge would actually reach the webhook handler. `C04/ingestWebhook` is an ordinary operation on a loopback-only gateway that takes the signature headers and raw body inside a JSON request (`service.ts:1263`), so GitHub cannot POST to it directly. Whether a documented relay or tunnel exists was not found. (An earlier draft of this study said no webhook route was found; that was wrong. The handler exists but is not directly reachable.)
- Runtime behaviour: nothing was run. Timings, memory and accuracy are all unmeasured.
- The Rust crates (`crates/worker`, `crates/defect-harness`) were not read beyond their names.
- How the web app's PR panel (`PrPanel.tsx`) consumes `PrAnalysisView`.
- Any forge API detail for GitLab, Bitbucket or Azure DevOps. Those contracts must be checked against current vendor documentation before F19 is built.
- Support for test execution outside Node. `runTestsIn` is Node-based.

## 6 Dependency order

```
F19 forge abstraction ───────────────────────────────┐ (portable form of everything below; GitHub ships first)
F11 impact report ──► F13 PR summary ──► F14 PR-thread chat
        │                                   ▲
        ├──► F15 feedback loop ─────────────┘ (mutes and weights feed ranking in F11/F13)
        └──► F16 suggested fixes ◄── F18 test generation (a fix is more convincing with a failing-then-passing test)
F12 MCP server (independent; gains value from F11 tools)
F17 ticket compliance (independent of F11; reuses requirements machinery; shares the comment surface)
```

Recommended order: F12 and F11 slices 0–2 in parallel (no shared files), then F13, F15, F17, F14, F18, F16, and F19 last for non-GitHub forges. F19's *interface extraction* should happen early and quietly, behind the existing GitHub implementation, so later work does not hard-code `gh`.

## 7 Shared risks

1. **One comment surface, many features.** F11, F13, F14, F15, F16 and F17 all write to a pull request. Without a shared budget they will produce several noisy comments. The shared rule: one bot identity, a bounded number of comments per PR, and sections inside one updatable comment where possible (decision in F13 §17).
2. **Tiny local models.** Prose quality from `llama3.2:1b` is limited. F13, F14, F17 and F18 are therefore designed deterministic-first, with a model only phrasing or proposing, and every model output re-checked.
3. **Injection through the comment surface.** A PR author controls titles, branch names, file names, symbol names, commit messages and comment text. F13, F14, F16 and F17 each have a threat model for this.
4. **Unmeasured value.** None of these features has evidence that it increases adoption or catches defects. Each document states what would be measured first.
