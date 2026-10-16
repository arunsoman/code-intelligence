# Evidence in answers and charts

Base: origin/main d43e53b. Evidence Core remains off by default.

## Features

- Answers and chart footers expose a shared expandable Evidence and coverage panel.
- Current static observations show source filenames, byte ranges and, when recorded, analyzer ID/version and producer run ID.
- Snapshot-backed alternate charts retain the same evidence collection identity.
- Source buttons use the existing code viewer and reject changed/unavailable sources.
- Coverage stays PARTIAL. Exclusions, unavailable provenance and display truncation are explicit; provenance never changes answer-review verdicts or proves runtime behavior.
- The writer can request evidence_of for provenance and coverage. This does not satisfy implementation-reading requirements.

Legacy/off/shadow indexes retain current source citations when available. Producer trails require an index created with provenance enabled; enabling the mode alone does not backfill old revisions. No new chart type or inference engine is introduced.

## Boundaries

The display selects at most 80 entities, 40 observations and two source links per observation. This is a presentation bound, not a hard bound on underlying retrieval queries. Source hashes, access policy and revocation are checked before exposing links. Source opening also canonicalizes symlinks to reject external or denied targets, including identical-content aliases.

Cached chart traces are discarded and regenerated for fresh answers and saved workspace charts. Historical saved message traces are removed on reopen. Shared workspaces discard cached traces rather than reuse another principal's source metadata; regenerate an authorized answer/chart to obtain a fresh trail. Existing answer validation remains separate and unchanged.

## Validation

- scripts/setup-dev.sh completed before worker-backed tests.
- Selected core and UI tests: 73 total, 72 passed, one existing skip, zero failed. Includes evidence trace, chat agent, answer visuals, snapshots, walkthrough, Evidence Core, source pages, saved workspaces, collaboration, and SSR panel rendering/source-button callback.
- Core/web typechecks and production web build checked separately.
- Browser smoke test added for answer/chart panels, keyboard interaction, source opening and alternate charts. Could not complete in this environment: a complete Chrome binary exits when its required Unix socket is denied (Operation not permitted). SSR/API tests are not a substitute for this browser smoke test; run it in a browser-capable environment before rollout.
- No Rust implementation changed; Rust tests and the broader performance rollout gate were not rerun by this patch.

Commands:

```sh
CIE_LOG_LEVEL=off node --test packages/core/test/evidence-trace.test.ts packages/core/test/chat-agent.test.ts packages/core/test/answer-visual.test.ts packages/core/test/evidence-snapshot.test.ts packages/core/test/evidence-walkthrough.test.ts packages/core/test/evidence-core.test.ts packages/core/test/source-page.test.ts packages/core/test/workspace.test.ts packages/core/test/c29.test.ts apps/web/test/evidence-panel.test.ts
npm run typecheck
npm run web:build
node --test --test-concurrency=1 apps/web/test/e2e/evidence-panel.test.ts
```
