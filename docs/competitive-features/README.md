# Competitive features: detailed design set

Version 1.0 · 4 October 2026 · Proposed implementation specifications

This directory splits `Competitive_Features_Component_Implementation_Guide.md` (the **guide**) into ten detailed, self-contained design documents, one per feature. Each document takes the guide's component table and public contract for its feature and turns them into something a team can build from: current repository evidence, data model, algorithms, API, state machines, interface specification, failure modes, tests, work packages and open decisions.

## The experiences these designs aim at

| User asks | Product should deliver | Primary design | Supporting designs |
|---|---|---|---|
| "Where is this API used?" | Exact references, callers and relevant repositories, with unresolved cases disclosed | [F01](F01-cross-repository-search-and-navigation.md) | F04 (package identity), F06 (history of a symbol) |
| "Is this PR safe?" | Changed-code findings, affected dependencies, test results and an actionable gate decision | [F02](F02-pr-analysis-and-quality-gates.md) | F03, F04, F06, F07 |
| "Why is this endpoint slow?" | Trace → profile → source line, with measured CPU, wait or allocation evidence | [F05](F05-trace-linked-continuous-profiling.md) | F01 (source line), F10 |
| "What should we refactor first?" | Hotspots ranked using change frequency, code health and impact | [F06](F06-historical-hotspots-and-change-coupling.md) | F01, F05 |
| "Is this dependency risky?" | Affected versions, dependency paths, licence concerns and remediation options | [F04](F04-dependency-vulnerability-and-licence-scanning.md) | F03 (reachability), F07 |
| "Fix this across our services." | Reviewable per-repository patches, validation results and tracked PRs | [F08](F08-coordinated-multi-repository-changes.md) | F07, F01, F04 |

Two further designs support the experiences above and the confirmed canvas defects:

| Design | Why it exists |
|---|---|
| [F03](F03-deterministic-data-flow-and-taint-analysis.md) | Gives "is this PR safe?" and "is this dependency risky?" a path-level, evidence-bound answer instead of a name match |
| [F07](F07-task-to-branch-to-pr-execution.md) | The single-repository execution path that F02 gates and F08 multiplies |
| [F09](F09-readable-semantic-zoom.md) | The confirmed readability defects (issue #48) and the camera behaviour every visual in the other designs depends on |
| [F10](F10-bounded-workflow-digital-twin.md) | Bounded what-if experiments, built on the isolation runner that already exists |

## Reading order and delivery order

The guide's delivery order is preserved: P0 F09; P1 F01, F02, F07 (with F03/F04 as integrations); P2 F05, F06; P3 F08, F10. Build the small shared foundation first (identity, jobs, evidence binding), then F09 independently, then one real defect and one PR end to end.

## Conventions used in every document

- **Evidence status.** Statements about the current repository carry a file reference and were observed at commit `8b07b5e`. Anything not read is marked *not verified*. Nothing in these documents is a measured capability. Numerical targets are proposals until measured.
- **Reuse classification.** Every function is labelled `EXISTING_REUSE`, `EXISTING_EXTEND`, `NEW` or `NOT_NEEDED`, as the guide's work-package template requires.
- **Reconciliation.** The guide's pseudocode types (`Context`, `Outcome<T>`, `SnapshotRef`) are *not* the repository's types. Each document includes a mapping onto what exists (`CallContext`, `ApiResult<T>`, `revision` ids, `EvidenceRef`, `ResolutionKind`, `ErrorCode`) and proposes additive extensions rather than a second contract.
- **Honest labels.** "No results" never means "no defects"; a tool finding is not a proof; a measured value needs a run manifest; unsupported coverage is disclosed rather than hidden.
- **Acceptance IDs** (`F0x-A#`) come from the guide. Additional design-level checks use `F0x-D#` and are listed separately.

## Shared repository facts the designs rely on

These were read in the repository and are referenced by several documents.

| Fact | Where | Consequence |
|---|---|---|
| One parser process; jobs run one at a time | `packages/core/src/jobs.ts`, `worker.ts` | Multi-repository and history work need either a worker pool or explicit queueing and priority (F01, F06, F08) |
| Gateway operations are `POST /api/v1/components/{C}/{op}`; mutating operations require an `Idempotency-Key` | `packages/core/src/server.ts` (`makeOps`) | New operations follow the same registry and idempotency rule |
| `ApiResult<T>` carries `metadata.completeness` (`COMPLETE`/`PARTIAL`/`UNKNOWN`) and `ErrorCode` includes `STALE_REVISION`, `EVIDENCE_STALE`, `BUDGET_EXCEEDED`, `INSUFFICIENT_EVIDENCE` | `packages/schema/src/index.ts` | The guide's `COMPLETE/PARTIAL/FAILED/CANCELLED/STALE` statuses map onto this plus `ErrorCode`; they are not a new envelope |
| Resolution is graded `PARSED` / `RESOLVED` / `OBSERVED` / `UNRESOLVED`; dynamic calls stay unresolved | `packages/schema/src/index.ts`, `crates/worker/src/language.rs` | Precise navigation adds a *basis* beside this grade; it does not replace it |
| The GitHub connector (`ForgeConnector` over `ghTransport`) is read-only (`method: "GET"`) and authenticates through the `gh` CLI | `connectors.ts`, `gh.ts` | Statuses, checks, comments, branches and PRs need a write capability on the same connector (F02, F07, F08); see "The GitHub connector" below |
| Draft PR publication with grants, stale-head checks and find-then-create idempotency already exists for defect fixes | `defect-workflow.ts` (`publishPullRequest`, `DraftForge`) | F02/F07/F08 extend this, they do not rebuild it |
| `ChangeEngine` never writes to the repository; there is deliberately no apply operation | `changes.ts` | Branch creation and push need a separate, explicitly authorised path (F07) |
| Git history is read file-by-file with `--no-renames` | `gitinfo.ts` | Rename-aware history (F06) is new work |
| Per-tenant database file and parser process | `tenants.ts` | Cross-repository features operate within one tenant; cross-tenant search is out of scope |
| The `RunManifest`, `PatchValidation`, `PrPublication` schemas exist in the defect pipeline with their own shapes | `packages/schema/src/defect.ts` | The guide's `RunManifest`/`PatchBinding` must be reconciled with these (see F07 and F10) |
| `docs/ledger.json` defines done as items backed by named tests | `docs/ledger.json`, `ledger.test.ts` | Each feature adds ledger items; a feature is not done until named tests exist |

## The GitHub connector

The product has **one** source-host connector: **GitHub**. There is no multi-forge abstraction; GitLab and Bitbucket are non-goals. The existing class names `ForgeConnector` and `DraftForge` stay as they are (they are the current GitHub code); the designs extend them rather than introduce an interface for other hosts. GitHub Enterprise Server is reachable through the host already carried by `GhSlug { host, owner, repo }` (not verified end to end).

**Identity.** A repository is `(host, owner, repo)` locally mapped to `repositoryId` (F01 §6); a PR is `(repositoryId, prNumber)`; a commit status or check belongs to a **commit SHA**, not to a PR, which is why every write is bound to an exact head hash.

**Two authentication modes, one connector**

| Mode | Used for | Notes |
|---|---|---|
| **`gh` CLI session** (exists: `ghAuthToken`, `ghAuthStatus`, `ghTransport`) | Reading repositories, PRs, commits; commit statuses; creating branches and draft PRs; PR comments | No token is stored or configured in CIE. Operates with the signed-in user's rights |
| **GitHub App installation** (new, optional) | Check runs with annotations and long summaries, webhook delivery to CIE, per-repository least-privilege installation tokens | Needed only where the richer feature is wanted (F02 second release). Must be confirmed against current GitHub documentation at implementation time |

**What each feature uses (to be checked against current GitHub API documentation when built)**

| Need | GitHub mechanism | Feature |
|---|---|---|
| List repositories the user or installation may see | Repositories listing for the user, organisation or installation | F01, F08 |
| Read a revision, tree, file | Git data / contents APIs, or a local clone | F01, F06 |
| PR base, head, merge base, changed files | Pull requests API; fork-safe head via the base repository's `refs/pull/N/head` | F02 |
| Webhooks: PR opened / synchronized / reopened / closed, push | Webhook deliveries (HMAC-signed; existing `receiveWebhook` is authenticated, ordered and idempotent) | F02, F08 |
| Publish a gate result | Commit status on the head SHA (first release); check run (App) later; one updatable PR comment (optional) | F02 |
| CI results for the exact head | Check runs / workflow artifacts for the head SHA | F02, F04 |
| Branch, commit, push | A CIE-owned clone and `git push` using the `gh` credential; branch names constrained to a `cie/` prefix | F07, F08 |
| Draft PR create / find / resolve head | Pull requests API with `draft: true`; find by head branch | F07, F08 (`GhDraftForge`) |
| Required checks and protection rules (read) | Branch protection read | F02 (to tell users which status context to require) |
| Issue and PR text as task input | Issues and pull requests APIs (treated as **data**, never instructions) | F07 |

**Operational rules that apply everywhere:** primary and secondary rate limits are handled with the connector's existing `RATE_LIMITED` state and stored resume time; credential expiry is a stated `EXPIRED` state, not a retry loop; writes are idempotent (find before create, keyed by head branch or `(headSha, context)`); every write is checked against a stored grant bound to the exact head and diff; nothing merges, approves, deploys or dispatches a workflow.

## Files

1. [F01 — Cross-repository search and precise navigation](F01-cross-repository-search-and-navigation.md)
2. [F02 — PR analysis and quality gates](F02-pr-analysis-and-quality-gates.md)
3. [F03 — Deterministic data-flow and taint analysis](F03-deterministic-data-flow-and-taint-analysis.md)
4. [F04 — Dependency vulnerability and licence scanning](F04-dependency-vulnerability-and-licence-scanning.md)
5. [F05 — Trace-linked continuous profiling](F05-trace-linked-continuous-profiling.md)
6. [F06 — Historical hotspots and change coupling](F06-historical-hotspots-and-change-coupling.md)
7. [F07 — Task-to-branch-to-PR execution](F07-task-to-branch-to-pr-execution.md)
8. [F08 — Coordinated multi-repository changes](F08-coordinated-multi-repository-changes.md)
9. [F09 — Readable semantic zoom and camera transitions](F09-readable-semantic-zoom.md)
10. [F10 — Bounded workflow digital twin](F10-bounded-workflow-digital-twin.md)
