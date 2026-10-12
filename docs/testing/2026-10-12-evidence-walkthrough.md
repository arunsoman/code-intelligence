# Evidence and unresolved-state code walkthrough

Base: local commit `fb6a2f9`, which contains the previously delivered async/session fixes on upstream `8a907b6235b5f8e734c306a2d4a51c7acc73fe93`. Apply this incremental patch after `code-intelligence-async-session-fixes.patch`. No remote branch was pushed.

## Confirmed defects and fixes

| Defect | Reproduction / consequence | Fix |
| --- | --- | --- |
| Scenario nouns became code subjects | The topup question's ordinary `user`, `case`, and `payment` words resolve unrelated `User`, `Case`, and `Payment` symbols. The prompt instructed the agent to start from these lexical matches. | Suppress common lowercase scenario nouns as implicit mentions. Explicit backtick references, declaration references and capitalized identifiers still resolve. Treat mentions as relevance candidates rather than required targets. Include indexed repository name in the request; require domain and fixture relevance checks in writer and reviewer prompts. |
| Name cache crossed store boundaries | Two independent stores with the same revision ID reuse the first store's symbols. | Cache per Store and revision, using a WeakMap. |
| Source-path access check followed untrusted symlinks | An indexed visible path redirected to an external file or a denied in-repository path exposes its bytes. The test uses temporary marker files only. | Resolve physical root and source paths; reject external and denied targets before reading source. Resume also checks physical access, including identical-byte redirects into denied paths. |
| Changed source used old symbol offsets | Inserting text before an indexed function makes its old byte range return unrelated text as the function's implementation. | Refuse changed source and request reindexing before source can be read or recorded as inspected. |
| Graph-only saved evidence was not fingerprinted | An unresolved investigation without `read_code` has no source hashes; changing a discovered entity's implementation does not block continuation. | Fingerprint the source spans of every retained indexed entity, in addition to actual reads. Resume rejects changed evidence before invoking the model. Missing indexed entities are stale evidence, rather than incorrectly reported as access denial. |
| Malformed reviewer output ended investigation immediately | One inconsistent structured review produces UNRESOLVED even when a second review of the same evidence would be valid. | Allow one isolated reviewer-format retry within the same total 15-second review deadline and request deadline. The writer/retrieval loop is not repeated for formatting repair. Persistently invalid approval remains withheld. |

## Verification

Eight new regression assertions fail on the pre-patch base (16 tests: 8 pass, 8 fail), covering all six defects and both failed reviewer recovery and repeated malformed approval. After patching, the related suite passes **56/56** across evidence walkthrough, answer validation, chat agent, source paging, model deadline, retrieval, conversation actions, stale session readers, answer visuals and session migration.

`npm run typecheck` passes. `git diff --check` passes. Worker-dependent tests use the existing release worker; the mandated development setup was run. No Rust sources or browser components changed in this patch.

The earlier complete-suite comparison had **106 failures already present upstream**. This walkthrough does not fix or claim to rerun that entire suite. See the previous async/session regression report for that inventory.

## Meaning of the reported topup result

The supplied evidence list contains code-intelligence's own test fixtures and model-budget refund code. It does not establish a production topup debit, provider outcome, or wallet refund path. The patch removes confirmed lexical misdirection and strengthens domain checks; these model instructions are guidance, not a deterministic domain classifier. It does not supply the missing Mi-Pay repository or prove any payment-loss scenario. The correct source must be indexed to support that answer.

## Additional path requiring reproduction

The web API retries a failed network request immediately with the same action ID. If its first server request is still running, the second request can receive an in-progress ownership conflict before a completed receipt exists. This was identified by walkthrough but was not reproduced or changed in this patch; preserving action identity and ownership fencing is essential in any future receipt-polling fix.
