# Investigation recovery and evidence-aware prompts

Base: e32ded2 (the evidence answers/charts patch). Apply after that patch.

## Delivered

- Unresolved investigations include a deterministic recovery plan: exact first unread character offsets, total unfinished reads, reusable observation count and an action-specific next step. Display at most eight read actions.
- The plan survives completed-turn persistence and conversation reload through the existing actor/session scoped validation summary. Raw tool observations remain server-side in the existing completed investigation checkpoint.
- Tool observations and source-read progress are also written while a turn is pending. An identical request retried with the same idempotency key after lease expiry restores that progress, then rechecks revision, source hashes and access before replay. Writes require the current pending lease owner. Repeated process loss before another tool call retains the preceding progress; a completed answer replaces the provisional record.
- Tool failures/refusals are not replay-cache hits. One retry per identical failing tool call is permitted within a request, still subject to existing total call/deadline limits. Continued requests receive a fresh retry allowance.
- Failed ir_of observations are not restored as implementation-reading credit.
- Continuation does not repeat the automatic opening read_module call. Existing source hash, permission and cross-revision checks still apply.
- Writer/reviewer prompts distinguish implementation support, producer provenance, conditional scenarios and execution evidence. Payment investigations explicitly inspect debit/commit, provider mapping, recovery, refund boundaries and idempotency.
- The existing answer-aware chart selector already chooses compensation/failure charts and represents unknown paths as gaps. This patch does not add a redundant selector or change answer verdicts.

## Validation

79 selected tests passed, none skipped. Includes transient/persistent read fault injection, bounded retries, SQLite reopen and lease replacement, provisional checkpoint writes and end-to-end action retry, recovery offsets with holes/overlap, blocker actions, summary persistence, existing continuation/access/staleness/re-indexing, answer/chart selection, evidence trace and panel SSR tests.

```sh
CIE_LOG_LEVEL=off node --test packages/core/test/conversation-actions.test.ts packages/core/test/investigation-recovery.test.ts packages/core/test/chat-agent.test.ts packages/core/test/answer-validation.test.ts packages/core/test/answer-visual.test.ts packages/core/test/evidence-trace.test.ts packages/core/test/evidence-walkthrough.test.ts apps/web/test/evidence-panel.test.ts
npm run typecheck
npm run web:build
```

setup-dev.sh completed. No Rust code changed. Browser tests were not rerun: the preceding patch documented the environment's Unix-socket restriction. These checks do not validate an actual wallet/provider transaction.

## Remaining work and practical limits

Completed unresolved turns can continue from the existing button. Interrupted pending turns require retrying the same payload, session and idempotency key after the lease expires; a new action key starts a new turn. A tool call interrupted before it returns must run again. Tests close/reopen SQLite and simulate the crash-before-finalization state; they do not forcibly kill a live server subprocess. No lease is extended and no permission check is bypassed.

Wallet runtime validation requires the wallet repository, its executable test environment and sandbox/provider stubs. Required cases: failure after debit commit, unknown provider response, pending across a date boundary, refund failure before/after commit, crash between refund and recovery status update, duplicate recovery and concurrent recovery. Verify both ledger net movement and provider fulfillment, including no duplicate credit. No production provider calls or synthetic tests presented as proof of the wallet behavior are included.

Evidence Core remains off by default. This patch neither enables it nor backfills provenance. Unsupported findings and access barriers remain explicit instead of being converted to successful conclusions.
