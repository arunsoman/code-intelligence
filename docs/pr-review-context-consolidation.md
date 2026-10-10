# PR review and response-context consolidation

Base commit: `fdbcb4f`. This patch includes the prior remaining-visualization consolidation, adapts the supplied F12–F16 patches, and adds a unified PR review workspace and durable response context. Apply this combined patch once to that base; do not apply its constituent patches afterward.

```sh
git apply --check pr-review-context-consolidated.patch
git apply pr-review-context-consolidated.patch
bash scripts/setup-dev.sh
npm run typecheck
npm run web:build
```

## One PR review workflow

Open **Work → Pull requests**, enter a PR number, then Analyze or Refresh. Every view shares the analysis ID, head hash and gate status. A changed analysis/head remounts its local conversation and publication preview; late data requests cannot replace another analysis.

| View | Purpose | Available actions |
| --- | --- | --- |
| Overview | Change counts, high-impact areas, reading order and gate conditions | Analyze, refresh, publish status/comment |
| Findings & impact | Findings alongside cited, ranked impact cards | Record a disposition, Useful/Noise, mute/unmute a kind, ask why, recompute weights |
| Conversation | Deterministic PR commands bound to the indexed head | Help, impact, tests, callers, why/why-not |
| Validated fixes | Introduced findings and stored fix candidates | Prepare, inspect before/after edits and checks, explicitly confirm inline publication |
| History & coverage | Analyzer coverage, limitations, waivers and prior heads | Inspect evidence limitations and supersession |

Reading order and reachability are labelled as inference. Missing reports, unsupported candidates, incomplete checks and unavailable free-form answers are shown explicitly. Feedback controls change ranking inputs; they do not change the gate. New weights apply when analysis runs again. Listing suggestions is read-only and does not update forge comments.

Fix previews use two columns on wide screens and one on narrow screens. Metrics and impact/fix cards use responsive grids; detailed gate and finding comparisons remain tables. The modal retains the shared focus trap and keyboard navigation. Hover-lens configuration remains fixed by the existing visualization implementation.

## Restored features and compatibility

F12 adds the loopback MCP adapter and bounded, evidence-shaped tools. Freshness probing compares file bytes without reindexing. Auto-refresh explicitly runs the derived-index refresh with a bounded wait; disabled auto-refresh preserves the indexed graph and reports staleness. A scan that exceeds its bound reports unknown freshness.

F13–F16 restore summaries, PR-thread command infrastructure, reviewer feedback and validated inline suggestion infrastructure. The impact-report and publication dependencies from F11 were recovered from repository history. Existing concept-card retirement, living investigations, native tables and replay changes remain intact.

New migrations use unused versions 45–49 instead of colliding with the current conversation migration: durable conversation actions, PR chat replies, impact reports, feedback, suggestions. Existing feature tables use `if not exists` for compatibility with databases that already carry them.

## Durable context

Conversation actions persist an idempotency receipt and a checkpoint of the scoped transcript/context. Completed retries reuse the response; conflicting payloads or overlapping live turns return explicit conflicts. Failed turns restore their checkpoint. A new request can recover an interrupted turn after its lease expires; late owners cannot overwrite recovered turns. The lease is bounded by the request deadline and two minutes. These receipts currently have no automated retention policy.

Chart activation synchronizes accessible entity referents, notation and structural zoom level with the conversation. Side perspectives retain the structural level. Sending the next chat turn waits for queued focus synchronization. Server history takes precedence over client-supplied history.

The chart workspace stores bounded navigation recipes, camera state and semantic selection in session storage, scoped to conversation and revision. Source specs and claims are regenerated after refresh; saved node IDs are projected through entity identity. Invalid or wrong-revision checkpoints are discarded. Storage restrictions leave in-memory navigation usable. This is same-tab recovery, not account-wide workspace synchronization.

## Validation and limits

Feature tests cover MCP contracts and staleness, PR summaries/commands/feedback/suggestions, turn replay/ownership/recovery and checkpoint identity. Headless tests cover PR tab navigation, responsive fix previews, explicit publication confirmation and chart regeneration with parent navigation after refresh. Tests use scripted forge responses; validation does not publish to GitHub.

Free-form PR chat is not enabled. The default suggestion engine has no candidate provider: preparation returns a clear refusal until a provider or validated candidate is supplied. Immediate recovery before lease expiry, receipt retention, full canonical architecture hierarchy, remaining plugin migrations and complete intent/notation parity remain separate work.
