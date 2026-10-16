# Investigation retry controls and process-kill validation

Base: 25faa28. Apply after cie-investigation-recovery.patch.

## Behavior

An interrupted conversation now offers Retry investigation for retryable connection failures, deadlines and turn-lease conflicts. The control resends the original serialized request with the same action key, preserving its question, revision, chart context, selection and pins. It does not append a duplicate user question. The server can return its completed receipt or resume durable progress after the original lease expires.

The request snapshot is independent of subsequent selection/object changes. Simultaneous attempts share one network promise. Existing response-generation guards discard late results. Repository, revision and conversation changes invalidate the retry; a new submitted question replaces it. The control is disabled while busy or without an indexed source. Access denial, stale revisions, invalid requests and cancellation do not offer this same-action retry.

Pending retry payloads stay in memory. Reloading/closing the tab loses this UI control; completed unresolved investigations still restore through the existing conversation history. No raw request, source or provider information is added to browser persistent storage. Starting a different action is not an automatic continuation of an interrupted action. Server ownership/access/source checks remain authoritative.

## Validation

44 focused tests passed, zero skipped. The set includes API request keys, immutable retry payloads, changed-scope refusal, shared in-flight requests, recoverable-error classification, ChatPanel SSR controls, existing source/access/continuation checks, recovery plans and conversation action ownership.

The new subprocess regression starts a real Node process, saves investigation progress to SQLite, waits for its checkpoint marker, kills it with SIGKILL, and recovers the retained observation through a replacement owner after simulated lease expiry. This validates CIE progress durability under process loss; it is not an execution test of wallet charging or provider fulfillment.

```sh
CIE_LOG_LEVEL=off node --test apps/web/test/conversation-retry.test.ts apps/web/test/api.test.ts packages/core/test/conversation-actions.test.ts packages/core/test/answer-validation.test.ts packages/core/test/investigation-recovery.test.ts
npm run typecheck
npm run web:build
```

setup-dev.sh completed before worker-backed tests. Core/web typechecks and production web build are validation gates. Browser smoke remains pending in a browser-capable environment; earlier attempts were blocked by Unix-socket restrictions. No Rust source changed. Evidence Core remains off by default. Wallet/provider failure-injection testing still requires the target repository and sandbox harness.
