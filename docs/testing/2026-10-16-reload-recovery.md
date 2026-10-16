# Reload recovery and workstream status

Base: 1574573 (investigation retry controls). Apply after that patch.

## Reload recovery

Conversation restore now returns optional recoverable metadata containing only investigation ID, revision and readyAt. The server reads its own provisional checkpoint; no original request or tool observations are stored in browser persistent storage. Discovery is scoped to tenant, principal and session and excludes unavailable/revoked revisions and checkpoints with denied or missing elements.

The UI discovers this metadata when its indexed repository/session loads, displays Resume interrupted investigation, and waits for the original lease to expire. While waiting it refreshes the conversation every five seconds so a completed original request restores its final text instead of offering a stale resume. Client generation/repository guards suppress late discovery responses. The existing local retry control takes precedence while its exact request is available.

Resuming creates an ordinary new conversation action referencing the server checkpoint ID. The server refuses a live pending lease, checks the checkpoint belongs to the same repository, and applies existing source hash, access, canonical-path and cross-revision checks before replaying observations. A successful continuation consumes the old failed provisional payload atomically with finalization. Failed continuations retain it. Completed unresolved investigations continue to use their existing history controls.

Limits: discovery selects the most recent provisional checkpoint with usable access metadata. A tool interrupted before checkpointing must run again. Source changes may require re-indexing; permission failures cannot be bypassed. This change does not claim full browser reload/hydration coverage: API and SSR tests pass, but browser smoke remains blocked by the earlier environment socket restriction.

## Three-workstream status

| Workstream | Delivered | Remaining |
| --- | --- | --- |
| Investigation recovery | Durable tool checkpoints, process-kill regression, targeted continuation, unread offsets, bounded retries, same-action retry, server-discovered reload recovery | Browser rollout validation and operational measurement |
| Evidence-aware answers/charts | Current source/provenance panels, prompt distinctions, retained supported findings, answer-aware chart selection and explicit gaps | Full claim-by-claim support and unknown-step presentation validation across chart types; real-repository acceptance run |
| Execution validation | CIE fault tests for tool failure, process interruption, ownership, stale/denied source and recovery | Wallet provider timeouts, failed refunds, scheduler interruptions, duplicate/concurrent recovery and ledger assertions against actual target code |

The third workstream is not completed by CIE process-recovery tests. It requires the wallet implementation and an isolated test harness/provider stubs. No production payment/provider execution is performed by this patch. Evidence Core remains off by default.

## Validation

72 selected tests passed, zero skipped. Includes discovery isolation, safe metadata shape, live-lease conflict, expired checkpoint continuation with a new action, consumption after success, wrong-repository rejection, denied/revoked discovery, stale source before model replay, existing rename and symlink checks, actual SIGKILL recovery, and SSR control availability.

```sh
CIE_LOG_LEVEL=off node --test packages/core/test/answer-validation.test.ts packages/core/test/conversation-actions.test.ts packages/core/test/investigation-recovery.test.ts packages/core/test/chat-agent.test.ts apps/web/test/conversation-retry.test.ts apps/web/test/api.test.ts
npm run typecheck
npm run web:build
```

setup-dev.sh completed. No Rust source changed; Rust tests were not rerun.
