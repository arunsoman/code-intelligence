# Bounded supporting-view generation

Apply `bounded-view-generation-incremental.patch` after `predictable-response-ranking-incremental.patch`. This is a separate slice; it does not repeat ranking, table or canvas changes.

## Behavior

Previously, selecting a third unbuilt tab while two views were generating dropped the request and required another click. Supporting views were generated serially. The browser now uses a shared queue with two active requests, at most six waiting requests and a 180-second deadline per started request. The deadline leaves room for the existing 120-second local-model timeout plus request overhead. Budget overflow and timeouts produce explicit failures with a retry action.

Generation transitions through available → queued → generating → ready/partial, or failed. Queued requests start automatically. Selecting a queued supporting view promotes it ahead of waiting background jobs; requests already running are not preempted. Repeated requests for the same tab share the existing job and do not start another provider call. The response strip displays running and waiting counts.

Generate supporting views submits at most three relevant non-primary tabs concurrently without changing the selected tab. It remains usable when other work is running and further supporting views have not been queued. This is explicit user-requested generation; visiting a response does not automatically make additional model calls.

Cancel generation aborts active browser requests, removes waiting jobs and resets both states to available with incremented attempt tokens. The active waiting tab provides a Generate this view action. Closing a pending tab cancels that tab's job, preserving other requests; reopening can retry. The last open tab cannot be closed. Navigating or changing response context cancels the queue. Restoring an ancestor resets queued and generating tabs to retryable states while retaining saved view geometry and selection.

## Correctness and limits

Completion acceptance still requires response, revision, tab and attempt identity, plus the requested notation. Jobs from a cancelled response cannot update a newer response. An old job finishing cannot remove a newly queued job with the same key. A cancelled active job retains its queue slot until its request settles or its deadline fires, preventing an immediate replacement from exceeding the browser's active-job budget.

Completed views continue to be reused inside their saved workspace. There is no new cross-response cache: evidence fingerprints and provider/compiler identity would be needed to reuse independently generated results safely.

Abort and timeout stop browser waiting; the current HTTP/provider pipeline does not guarantee that the server terminates an already-running LLM computation. The two-job budget is therefore a browser scheduling limit, not a server-wide compute quota. Independent browser windows have independent budgets. Queued is an added response status; deployed strict consumers must receive the updated schema.

## Validation

Tests cover bounded concurrency, automatic dequeue, request deduplication, foreground promotion, active/pending cancellation, cancellation/retry identity collisions, overflow, provider exceptions, deadline progression and queued-history invalidation. Workspace, ranking and navigation regressions are included, followed by TypeScript and production-build checks and clean incremental application verification. Browser interactions remain unverified in this environment because Chrome is unavailable.
