# F12 — MCP server: cited code analysis for coding agents

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §1–§4. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree.
Priority P1. First deliverable: a local stdio MCP server exposing five read-only tools, each returning a claim class, citations, gaps and completeness.

---

## 1 Purpose, user experience and status

### 1.1 Why

Coding agents (Claude Code, Cursor and others) now do much of the code reading and editing. Competitors have positioned their code graph as context for those agents (Sourcegraph ships an MCP server). CIE has the part agents lack: answers that say how they are known, cite code, and abstain. An MCP server puts that in front of an agent without the developer opening CIE.

This feature adds no analysis. It is an adapter over operations and chat tools that already exist, plus one genuinely new problem: **keeping answers honest while the agent edits the files** (§7.3).

### 1.2 The experience

| Agent asks | Tool | Delivers |
|---|---|---|
| "What breaks if I change `adjustBalance`?" | `impact_of_change` | Dependents, transaction/guard consequences, tests that reach it, each with class and citation |
| "Who calls this and through what?" | `who_calls` | Call paths with unresolved hops marked Fog |
| "Which tests exercise this?" | `tests_reaching` | Static links, coverage if an artefact exists, never "tests pass" |
| "Why wasn't X in that answer?" | `why_not_shown` | The salience factors or the specific exclusion reason |
| "How are A and B connected?" | `explain_connection` | A cited path that passed the claim gates, or "I can't determine this" |
| "Is the index current for my edits?" | `index_status` | Revision, files changed since indexing, whether answers are stale |

An agent sees, for each result, `claimClass`, `evidence` (path and line range), `gaps`, `completeness` and the revision it was computed on. It is told in the tool description that a missing result is not evidence of absence.

### 1.3 What "done" means

1. Adding the server to an agent's configuration takes one entry (`command: cie mcp`), with no account.
2. Every tool result carries class, citations, gaps and revision; a result without them cannot be produced (§7.4).
3. When the working tree has changed since the last index, the tool says so in the result, not in a log, and either answers about the indexed revision with that stated or refreshes first (§7.3).
4. No tool can write to the repository, the forge or the store beyond index refresh (§10).

### 1.4 Status

Proposed.

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** stdio transport; a read-only tool set generated from existing registries; resources for evidence by id; result shaping; index freshness handling; per-tool budgets; identity and access; a client-side example configuration.

**Non-goals (first release):** write or mutating tools (no candidate creation, no publishing, no investigation steering); a hosted or remote MCP endpoint; streaming partial results; model calls on the server's behalf (the server returns analysis; the calling agent does any reasoning); prompts and sampling features of the protocol.

**First delivery boundary:** stdio, five tools, one repository per server process, index refresh on demand.

---

## 3 Current state in this repository

### 3.1 What exists

| Capability | Where |
|---|---|
| Typed operations by component, with `mutating` flags | `server.ts:45–128` |
| Loopback-only HTTP gateway with trusted identity hook, 8 MB cap, idempotency keys for mutating calls | `server.ts` |
| Read-only chat tools with JSON schemas and a "may cite only ids a tool showed" rule: `find_code`, `read_code`, `show_view`, `project_overview`, `change_risk`, `find_tests`, `get_routes`, `get_guards`, `get_module_graph`, `get_config` | `chat-tools.ts:107` |
| Per-observation size cap (7,000 characters) | `chat-agent.ts` `MAX_OBSERVATION` |
| Evidence retrieval by id, batch, and span location | `C18/evidence`, `C18/evidenceBatch`, `C26/locateSpans` |
| Why shown / why hidden | `C15/whyShown`, `C15/whyHidden`, `salience.ts` |
| Changes since the index; incremental re-index | `C13/changesSinceIndex`, `C07/enqueueIndex`, `C07/invalidateAndRevalidate` |
| Access policy applied to retrieval, graph queries and evidence | `access.ts` |
| Completeness and warnings on every `ApiResult` | `server.ts`, schema |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | No MCP implementation anywhere in the repository | grep for "mcp" over `packages apps extensions crates docs README.md` returns nothing |
| G2 | The chat tools return text for a model to read, not structured results with class, citations and gaps | `chat-tools.ts` `ChatTool` returns a short text and registers seen ids |
| G3 | No handling of an agent changing files between index and query | `C13/changesSinceIndex` exists but nothing calls it before answering a question |
| G4 | No per-caller rate or budget limit on read operations; the existing limits are per request | `chat-agent.ts` constants; gateway body cap only |
| G5 | The server assumes one local user; no notion of an agent as a principal distinct from the person | `server.ts` `LOCAL` identity |
| G6 | Results can contain repository text. Handing it to an agent makes it prompt-injection input, and nothing marks it as such | `read_code` returns file text |

### 3.3 Not verified

- Which tool names an agent host will treat as safe to auto-approve (host-specific).
- The cost of `C07/enqueueIndex` on a large repository when called from an editor-speed loop.
- Whether the MCP SDK for TypeScript can run under the repository's Node version and `.ts` execution mode without a build step.

---

## 4 Architecture and ownership

```
agent host ──stdio──► cie mcp (adapter process) ──HTTP loopback──► existing gateway ──► Service
                              │
                              ├─ tool registry (generated, §7.1)
                              ├─ result shaper (class, citations, gaps, revision) (§7.4)
                              └─ freshness guard (§7.3)
```

The adapter is a separate small process that speaks MCP on stdio and calls the already-running local gateway. It does **not** import `Service`, so it cannot reach an operation that is not in the allowlist, and it reuses every existing check (access, egress, budget) unchanged.

| Component | Responsibility |
|---|---|
| C01 Client shells | New `cie mcp` entry point; configuration snippet; connection to the gateway |
| C03 Access, egress | Allowlist of operations; agent principal; read-only enforcement |
| C15 / C18 / C19 | Provide the underlying answers, evidence and why-explanations (existing) |
| C07 Scheduler | Index refresh on demand |
| C16 Claim gates | Class assignment for results that are claims |
| C32 Operations | Packaging, versioning of the tool schema |

---

## 5 Reconciliation with existing contracts

- Tool results map from `ApiResult<T>`: `ok:false` becomes an MCP error with the same code vocabulary; `metadata.completeness` and `metadata.warnings` are copied into the result.
- The chat tool names are reused where the semantics match (`find_code`, `find_tests`), so documentation and evaluation of one carry to the other. New names are added only where a tool differs (`impact_of_change`, `index_status`).
- Claim classes are the existing four. The adapter adds no fifth.
- The tool schema is versioned (`toolSchemaVersion`) and reported by `index_status`, so a host can detect a change.

---

## 6 Data model

No new persistent tables for the first release. In memory, the adapter keeps the repository identity and the last-seen index revision.

```typescript
interface McpToolResult {
  schemaVersion: 1;
  revision: { indexed: string; workingTreeChanged: boolean; changedFiles: number };
  claims: {
    class: "FACT" | "INFERENCE" | "HYPOTHESIS" | "FOG";
    text: string;
    evidence: { id: string; path: string; startLine: number; endLine: number }[];
  }[];
  gaps: string[];
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  withheld: { items: number; note: string } | null;   // denied paths, counted not named
  untrustedText: true;                                  // any quoted repository text is data
}
```

---

## 7 Algorithms and rules

### 7.1 Tool generation

Tools are declared once in a registry that carries, per tool: name, description, argument schema, the underlying operation(s), and a shaper. Descriptions are written to constrain the agent ("a missing result is not evidence of absence"). Tools whose underlying operation has `mutating: true` cannot be registered; this is a test (F12-A1), not a convention.

### 7.2 Mapping the first tool set

| Tool | Built from | New work |
|---|---|---|
| `impact_of_change` | `history.compare` consequences and blast radius on a symbol; `dependents()` | Single-symbol entry point; no PR needed |
| `who_calls` | `get_module_graph`, call relationships | Path output with unresolved hops as Fog |
| `tests_reaching` | `testsReaching`, `find_tests` | Class: static link is Fact of reachability, not of passing |
| `why_not_shown` | `C15/whyHidden` | Argument shaping |
| `explain_connection` | existing connection explanation with five claim checks | Argument shaping |
| `index_status` | `C13/changesSinceIndex`, revision stats | New |

### 7.3 Index freshness when the agent edits files

The central new problem. An agent changes a file and asks "what calls this?" The index describes the earlier revision.

1. Every tool call first asks `C13/changesSinceIndex`. If nothing changed, answer.
2. If files changed, and `autoRefresh` is on (default), enqueue an incremental index and wait up to a bounded time (default 10 seconds). On success answer on the new revision.
3. If the refresh does not finish in time, or `autoRefresh` is off, answer about the **indexed** revision and set `workingTreeChanged: true` with the changed-file count, and add a gap: "N files changed since the answer's revision; callers may differ." A tool never silently answers about stale code.
4. If the queried symbol lives in a changed file, the result is downgraded one class (Fact → Inference) unless refresh succeeded.

### 7.4 Result shaping gate

A pure function `checkMcpResult(r)` rejects a result lacking a revision, a non-Fog claim lacking evidence, or text containing certainty wording the tool does not support. It reuses the template discipline of F11 §7.6 where the tool is claim-based.

### 7.5 Bounded work

Per call: operation deadline, result size cap (default 8 KB of claim text, overflow counted in `gaps`), a maximum number of claims (default 20). Per session: a call budget (default 200 per hour) so a looping agent cannot saturate the local service; exhaustion returns a typed error with a retry hint.

---

## 8 API contracts

MCP surface: `tools/list`, `tools/call`, and `resources/read` for `cie://evidence/{id}` returning the cited span with its path, line range and content hash. The adapter calls these existing operations only: `C15/whyHidden`, `C18/evidence`, `C18/evidenceBatch`, `C26/locateSpans`, `C13/changesSinceIndex`, `C07/enqueueIndex`, `C13/revisionStats`, plus the read operations behind the chat tools. The allowlist lives in one file and is asserted against the operation table's `mutating` flags at start-up.

CLI: `cie mcp [--repo <path>] [--url http://127.0.0.1:4317] [--no-auto-refresh]`. Refuses a non-loopback URL, as the VS Code extension does (`events.ts` `isLoopback`).

---

## 9 States and lifecycles

Adapter states: Connecting → Ready → Degraded (gateway unreachable; tools return a typed error naming the cause) → Ready. A gateway restart is detected by revision and version in `index_status`; cached repository identity is dropped.

---

## 10 Authorization, egress, threat model

1. **Read-only by construction.** The allowlist is checked against `mutating` flags; index refresh is the single exception and only touches derived data.
2. **Identity.** The agent acts as a distinct principal (`agent:<host>`) bound to the user's access policy, so denied prefixes apply and are counted, not named. Whether the agent principal should have narrower access than the person is decision D2.
3. **No model on the server's behalf.** No model call is made, so no egress policy is triggered by this feature.
4. **Prompt injection.** Returned code text may contain instructions aimed at an agent. Every result sets `untrustedText: true`, and tool descriptions state that quoted repository text is data. The adapter cannot stop a host from following it; this is a stated residual risk.
5. **Local only.** Stdio plus a loopback URL. No listening port is added.
6. **Information volume.** A rogue agent could page the whole index out. The per-session budget and result cap bound this; they do not prevent it.

---

## 11 Freshness, cancellation, idempotency

All tools are read-only and idempotent. A host cancelling a call aborts the in-flight gateway request; a refresh already enqueued continues (it is useful to the next call). Results are bound to the revision they were computed on, and a later call with a different revision is not merged with an earlier one.

---

## 12 Interface specification

No visual interface. The tool descriptions and the result copy are the interface. Copy rules: lead with the class; never "will break" or "safe"; always return the revision; state the freshness caveat in the result body. `index_status` returns a one-line human-readable summary first so an agent can relay it to its user.

---

## 13 Performance and bounded work

Provisional: first byte of a warm answer within 2 seconds on a repository of ~2k files; refresh wait capped at 10 seconds; tool schema list under 6 KB (hosts pay for it on every request, so fewer, sharper tools beat many). All provisional until measured in slice 0.

---

## 14 Failure modes

| Failure | Behaviour |
|---|---|
| Gateway not running | Typed error "CIE is not running at <url>"; no fallback answer |
| Index stale and refresh times out | Answer on indexed revision with explicit staleness gap and downgrade (§7.3) |
| Symbol not found | `FOG`/not-found with nearest names; never a guess presented as the symbol |
| Result truncated | Count of omitted claims in `gaps` |
| Access denied path | Counted in `withheld`, not named |
| Tool schema changed under a host | `toolSchemaVersion` differs; documented migration |

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | Prototype one tool (`impact_of_change`) end to end against a real repository and a real agent host; record what the agent does with Fog and staleness | NEW (spike) |
| S1 | Registry, allowlist-vs-`mutating` assertion, shaper, `checkMcpResult`, five tools | NEW `packages/core/src/mcp/` + EXISTING_REUSE operations |
| S2 | Freshness guard (§7.3) and `index_status` | EXISTING_EXTEND (`C13/changesSinceIndex`, `C07/enqueueIndex`) |
| S3 | Evidence resources; session budget; packaging and docs | NEW + EXISTING_EXTEND |

Each slice's demonstrated result must use a real repository and a real agent host, not only a scripted client.

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F12-A1 | Registering a tool whose operation is `mutating: true` fails at start-up; the allowlist matches the operation table |
| F12-A2 | Every result carries revision, completeness and, for non-Fog claims, at least one evidence id |
| F12-A3 | Edit a file after indexing: the next call reports `workingTreeChanged: true`, or refreshes and reports the new revision; never silent |
| F12-A4 | A symbol in a changed file whose refresh failed is downgraded one class |
| F12-A5 | A denied path is counted, never named, in tools and resources |
| F12-A6 | A non-loopback `--url` is refused |
| F12-A7 | The session budget returns a typed error and recovers |
| F12-A8 | Repository text containing agent-directed instructions is returned with `untrustedText: true` and unchanged |
| F12-A9 | `tools/list` stays under the size budget; the schema version is reported |
| F12-A10 | Presentation mutation: a result with a hypothesis marked as fact, or without a caveat, is rejected by `checkMcpResult` |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Adapter separate from the service, or in-process | Separate process over loopback HTTP, so the allowlist is a real boundary |
| D2 | Should an agent have narrower access than its user | Yes by default: no access to paths marked sensitive in policy; configurable |
| D3 | Auto-refresh default | On, with the 10-second cap |
| D4 | Tool count | Five plus `index_status`; add only after real agent transcripts show a need |
| D5 | Remote or hosted endpoint | Out of the first release |
