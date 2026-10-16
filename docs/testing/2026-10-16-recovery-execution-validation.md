# Recovery execution validation: first implementation

Base: 3f19e20 (reload recovery). This patch implements the reusable runner/adapter contract and tests its assertions. It does not complete integration with the user's wallet.

## Scenario coverage

| Scenario | Required final state |
| --- | --- |
| Provider timeout, provider actually failed | One debit, one full refund, no fulfillment |
| Provider timeout, provider actually fulfilled | One debit, one fulfillment, no refund |
| Refund fails before commit | A later attempt completes exactly one refund |
| Refund commits but acknowledgement fails | Retrying creates no second credit |
| Scheduler interrupted before refund | Later recovery completes refund |
| Scheduler interrupted after refund | Later recovery does not duplicate refund |
| Duplicate recovery | Five repeated calls cannot create extra credit |
| Concurrent recovery | Four calls begin against unsettled state; one later call checks convergence |
| Pending transaction crosses midnight | Next-day recovery still settles the transaction |

Every scenario starts a separate session/transaction. Assertions use integer gross debits, gross refunds, committed refund counts, provider fulfillment counts, terminal-state observations and fault-exercised receipts. Missing receipts or invalid snapshots cannot pass. Unknown provider outcomes cannot be treated as failed solely because a request timed out: the adapter must establish the configured definitive provider outcome before recovery.

Only allowlisted snapshot fields enter reports; raw exception text and extra adapter fields are omitted. A failed invariant means the defined scenario did not satisfy its bounded recovery expectation, not proof that money will never be returned at any later time.

## Integration contract

`validateRecovery(adapter, options)` and the associated types are exported from @cie/core. An adapter implements `open`, then session `pay`, `recover`, `snapshot`, `close`, and `advanceDay` for date-boundary testing. The scenario requests one-shot faults; the adapter must inject them into the real dependency/commit boundaries and record which faults were actually exercised. The test fixture is deliberately separate and is never selected as a default target adapter.

```ts
import { validateRecovery, type RecoveryAdapter } from "@cie/core";

// Implement this against the actual application and isolated provider stubs.
declare const walletAdapter: RecoveryAdapter;
const report = await validateRecovery(walletAdapter, {
  amountMinor: 1000,
  caseTimeoutMs: 3000,
});
```

For a TARGET adapter, bind the application revision and SHA-256 of the tested source/build. Bindings and measurements are adapter declarations, not independent attestations. Reports distinguish NOT_EXECUTED, FIXTURE_EXECUTION and ADAPTER_REPORTED_TARGET_EXECUTION. No result changes an answer-review verdict, static evidence class or twin replay result automatically. No new model tool executes arbitrary adapters.

Without an adapter, every case is INCOMPLETE. An unbound TARGET adapter is refused before execution. A deadline or cleanup/setup failure stops subsequent scenarios. The runner cannot isolate arbitrary code: deadlines are cooperative, synchronous infinite loops require an external process kill, and the adapter must provide process/container isolation, stubbed providers, database isolation and resource cleanup. `open` must release resources on abort even if it never returns; late returned sessions are closed and never paid. No overlapping next scenario starts after a timeout.

Fees, commissions, FX, external settlement, bulk transactions, debit retry and production capacity are outside this first oracle. Add separate explicit invariants before drawing conclusions about them.

## Validation

25 selected tests passed, zero skipped (15 runner tests plus existing investigation/action recovery tests). The fixture passes all nine scenarios. Five deliberately broken variants are detected: duplicate credits, terminal state before refund, today's-only recovery, an unguarded concurrent refund and refund-after-fulfillment. Additional tests cover absent/unbound adapters, missing receipts, invalid amounts/snapshots, cooperative abort, cleanup failure, late-open cleanup, output field filtering and unknown provider outcomes. Unknown provider status or unconfirmed faults leave the scenario INCOMPLETE rather than establishing a target defect.

```sh
node --test --test-reporter=spec packages/core/test/recovery-validation.test.ts packages/core/test/investigation-recovery.test.ts packages/core/test/conversation-actions.test.ts
npm run typecheck
```

setup-dev.sh completed. No Rust or web implementation changed. The workstream remains **runner implemented; actual wallet adapter/execution pending**. The wallet implementation is absent from this checkout, and the existing twin is explicitly a reference model. Neither fixture execution nor CIE process-kill tests prove the user's topup/refund behavior.
