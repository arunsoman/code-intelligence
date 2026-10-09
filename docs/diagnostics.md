# Detailed diagnostics

Detailed logging is enabled by default for the current investigation. Restart the server to load the changes, reproduce the question, then inspect `.cie/logs/diagnostics.jsonl`. Records are JSON, one per line, and are also written to stderr. The directory is git-ignored.

Every component API operation records start, outcome, duration, and uncaught error stacks. Async request context carries `requestId`, `traceId`, and `operation` through retrieval, worker calls, and model processing. Direct `ask` and `converse` calls also establish request context.

For question diagnosis, follow these events:

- `conversation.start`, `intent.classified`, `conversation.route`, `query.plan`: question, classification confidence, referents, resolved mentions, selected intent/chart, and whether repository overview retrieval was enabled.
- `ask.start`, `ask.route`: form, chart prerequisites, pins, seeds, scope, and route explanation.
- `retrieval.complete`: query terms, indexed counts, selected entities and relationships, fact predicate counts, coverage, unresolved calls, token budget, truncation, exclusions, and timing.
- `retrieval.candidates`: every accessible scored symbol in batches of 100, with scoring factors, selection status and retrieval provenance. Access-denied symbols are omitted.
- `model.start`, `model.dispatch`, `model.fallback`, `model.complete`: configured and actual provider, schema, purpose, evidence before/after scrubbing, egress decision notes, offline fallback, run identity, validation/failure outcome, and elapsed time.
- `chart.cache`, `chart.plan`, `chart.compiled`: cache hit, generated nodes/edges and caption, rendered counts, compiler diagnostics and gaps.
- `agent.turn.*`, `agent.tool.complete`: agent turns, selected tool names, argument field names, cache status, observation size, failure flag and timing.
- `worker.*`: worker startup/retry, RPC operation, frame size, timeout, result array counts, errors and timing.
- `ask.complete`, `conversation.complete`, `api.complete`: final answer, evidence gaps, warnings, result type, duration, and API status.

Example: find the `requestId` on a `conversation.start` record and filter all records for it:

```sh
tail -f .cie/logs/diagnostics.jsonl
rg 'YOUR_REQUEST_ID' .cie/logs/diagnostics.jsonl*
```

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CIE_LOG_LEVEL` | `debug` | `debug`, `info`, `warn`, `error`, or `off` |
| `CIE_LOG_FILE` | `.cie/logs/diagnostics.jsonl` | File path relative to the server working directory, or `off` |
| `CIE_LOG_STDERR` | enabled | Set `0` to suppress the stderr copy |
| `CIE_LOG_MAX_BYTES` | `10485760` | File size before rotation; minimum 1024 bytes |

Rotation keeps the active file plus three backups (`.1` through `.3`). Files have mode 0600; newly created directories use 0700. Logging failures do not fail requests. Strings are limited to 8,000 characters, and records exceeding 256 KiB or the configured file limit are replaced by an explicit omission record. Detailed logging uses synchronous local file writes and adds overhead; use `CIE_LOG_LEVEL=info` for ordinary operation or `off` to disable it.

These are application diagnostics, not a dump of every runtime instruction or model reasoning. Source excerpts, full prompts, tool observations, request bodies, headers, and credentials are excluded. Recognizable secrets are redacted, including those echoed in errors. Questions, answers, code symbol names and file paths can still contain private project information; logs are local and should be reviewed before sharing. Secret detection is heuristic. Invalid requests rejected before operation dispatch are handled by existing HTTP validation and do not produce an operation trace.
