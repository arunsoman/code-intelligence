# Task 1.G: model generation adapter

`packages/core/src/feature/model.ts` provides `FeatureModelAdapter`, backed by the frozen `FeatureStore` interface. Its `generate` method runs REQUIREMENTS → CONTRACT → EDIT_PLAN through the structured generation interface in `llm-router.ts`. `OllamaGenerationRouter` is the default transport; providers are injectable for conformance tests and explicit fallback configuration.

Construct an adapter with a feature request ID, store, configured routes and `egress` from `loadFeatureConfig(repoRoot)`. Omitting policy defaults to `LOCAL_ONLY`. Pass the request's exact prompt, hash-checked context artifacts, authority-policy hash and owner principal to `generate`. Context file locators are repository-relative paths; existing-file edits must quote supplied contents and raw SHA-256 hashes. The adapter does not read files or retrieve additional context on its own.

A successful result contains a `FeatureContractDraft`, proposed exact edits, contributing invocation IDs and a `pf-canon-v1` generation-provenance hash. Requirements remain PROPOSED and generated criteria have GENERATED_UNREVIEWED oracles. Task 2.I owns semantic analysis, review and adoption of this draft; 1.E owns candidate materialisation. The draft uses the `pf.GeneratedContractDraft` identity schema. It is not installed as the active contract by generation. These module methods are integration seams; the existing gateway stubs are wired in the end-to-end integration task.

The adapter's request-bound `recordModelInvocation` method implements the frozen C14 API signature. The call-context request ID is a trace ID, not the feature request ID. Its idempotency key identifies repeated recording calls within this feature and principal.

Invocation snapshots live inside `FeatureRecord.modelInvocations`, preserving the five-family persistence limit. Each attempted call commits a STARTED snapshot with `interrupted: true` before provider I/O. A separate immutable terminal snapshot supersedes that intent. `interruptedModelInvocations` identifies intents without successors after a crash. Records contain hashes, provider metadata and parameters, not raw prompt/context/output text. Private source artifacts remain the caller's responsibility.

A hidden revision is stored as UNKNOWN, never inferred from an Ollama model tag. UNKNOWN revisions, changed model identities and fallback identity changes enqueue `ModelIdentityChanged` events requesting dependent C17 evaluation. Task 3.U implements that evaluation; generation does not rewrite deterministic validation evidence or claim the builder evaluation passed.

Each stage has configurable aggregate input/output token budgets, a wall-clock deadline and a maximum of four attempts (two by default). Input admission uses a conservative UTF-8 byte estimate plus an envelope reserve, not a provider-tokenizer measurement. Output tokens are reserved across attempts and capped in each provider request; absent usage is checked conservatively by output bytes. Provider response buffers have a separate byte cap. Failed calls consume their reservation even when usage is unavailable. There are no hidden transport retries; fallback candidates must be explicitly configured and pass policy before each call.

Local-only routes require literal loopback IPs and refuse hosted/cloud model aliases. DNS names, non-loopback endpoints, URL credentials and redirects are refused. This protects the configured transport boundary; a local daemon and injected provider implementations are trusted components, not an OS network sandbox. Provider failures return a failed generation outcome while preserving independent deterministic request work.

Validation uses scripted providers and a local HTTP fixture, not live-model quality measurements:

```sh
node --test packages/core/test/feature-model.test.ts packages/core/test/route.test.ts
npm run typecheck
```
