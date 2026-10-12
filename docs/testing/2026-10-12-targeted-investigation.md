# Targeted investigation and deadline follow-up

Apply `code-intelligence-targeted-investigation.patch` **after** `code-intelligence-evidence-walkthrough.patch`. Base is local checkpoint `6b7be06`. Restart the server so the new request deadline and tool behavior are loaded. No remote push was performed.

The new Mi-Pay output reaches `TransactionPipeline.execute` but leaves its source unread at offset 6392, lists unrelated symbols, and times out without a draft. This is different from the earlier wrong-repository evidence list. Mi-Pay source and the user's running model/server are not available in this workspace; validation here uses indexed fixtures and controlled model adapters.

## Changes

- `find_code` searches the entire accessible symbol name/path index before diagram retrieval. Distinctive query words rank above generic payment/refund words; direct lookup normalizes identifier separators, excludes test/fixture paths unless requested, and respects denied paths. No-match semantic fallback is labeled tentative. A shared word does not prove domain relevance; implementations must still be read.
- Source pages grow from **120 to 320 lines**, retaining the **14,000-character** cap and continuation offsets. This avoids an extra model round trip for medium-size Java pipelines. Pending source reads are explicitly presented before the next retrieval turn and before broadening the search.
- The writer's research calls are timed to preserve **12 seconds for a draft plus 12 seconds for review/finalization**. Answer calls preserve the latter reserve. A timed-out research adapter is aborted and transitions to an answer-only turn; it cannot consume the whole deadline even if it ignores abort.
- The HTTP chat operation gets **180 seconds**, up from **60**; other v1 operation defaults remain 60 seconds. The existing request lease already tracks this deadline plus finalization grace.
- Unresolved evidence lists show actual source reads first rather than earlier discovery-order matches. Withholding unsupported drafts and access/hash checks remain active.

## Checks

- **50/50** related tests pass (search, validation, chat, paging, deadlines, previous evidence fixes, action receipts, stale session reader, and answer visuals).
- **2/2** HTTP server tests pass.
- Typecheck and `git diff --check` pass.
- Before these changes, the 250-line pipeline regression omits its later compensation branch from the first page. The noncooperative retrieval regression remains pending and exceeds its two-second test limit; patched execution aborts retrieval, produces a draft and completes independent review with time remaining.
- Search regression includes the user's exact topup question, production topup entry/scheduler symbols, unrelated user methods, fixture symbols and model-budget refund code. Topup implementations rank first. This verifies lookup mechanics, not the correctness of a real Mi-Pay payment-loss conclusion.

The prior 106 broad-suite failures are outside this patch. Larger source still needs paging. A model or evidence gap may still legitimately result in Unresolved; this patch cannot promise a supported answer without inspecting the actual debit/provider/recovery implementations. Longer chat calls also require the deployment's HTTP proxy to permit their duration.
