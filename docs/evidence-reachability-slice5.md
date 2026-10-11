# Slice 5: transitive static call comparisons

Baseline: `020b7e0`, which includes slices 1–4 and the G6 migration. This incremental patch adds transitive queries without replacing the existing chart workspace or captured hover lens.

## Supported questions

| Question | Meaning |
| --- | --- |
| `functions reachable from both leftRoot and rightRoot` | Intersection of outgoing static reachability sets |
| `functions reachable from either leftRoot or rightRoot` | Union of outgoing static reachability sets |
| `functions reachable from leftRoot but not rightRoot` | Directional difference; exclusion needs a closed right branch |
| `functions reachable from rightRoot minus leftRoot` | Reverse difference |
| `functions that can reach both commonHelper and leftHelper` | Intersection of observed incoming static paths; missing callers remain unknown |

Existing `functions called by ...` questions still mean **direct** calls. Explicit `reachable from` and `can reach` phrases select transitive traversal. Ordinary conjunctions, nested prose and arbitrary predicates are not guessed.

## Evaluation and proof

`call-reachability.ts` traverses the shared snapshot, without another model request or evidence collection. It uses current static call edges, deterministic breadth-first witnesses, and visited sets to terminate cycles. Paths have at least one edge. A root belongs to its own reachable set only when there is an actual cycle back to it. Sorted roots and edges make witness choice repeatable.

An outgoing branch is closed only if every visited implementation has a valid revision-bound direct-call certificate, every certified target is retained with its edge, and traversal finishes within its budgets. Closure supports scoped static exclusions. An unresolved callee, stale proof, omitted target or incomplete source scan prevents closure while preserving known positive paths. Incoming traversal never treats neighborhood collection as whole-repository coverage.

The evaluator caps traversal at 1,024 nodes and 4,096 scanned edges per operand. These are upper bounds on evaluation of the already bounded collection, not an expansion of source retrieval. Exhaustion is reported as partial coverage. The source investigation retains its existing 64-entity, depth-3, 8-file, 128,000-byte and cooperative 1,500 ms defaults.

This patch also corrects source inspection admission to use the full reserved investigation deadline. Previously it mistakenly checked the shorter indexed-walk deadline before starting source recovery.

## UI and projection

Transitive results show **Static reachability comparison**. Each supported membership has an expandable call path listing the intermediate functions. Inspect opens the existing evidence drawer with the path's source references and, for exclusions, the relevant closure proof.

The chart projection includes the supported paths' intermediate functions and protects them from token trimming. If those witnesses exceed the prompt budget, the existing budget error asks for a narrower query instead of silently producing a disconnected projection. Canonical membership and witnesses are computed from the full snapshot before projection and reused across generated chart tabs.

Access redaction checks intermediate path identities and labels, as well as new investigation certificates and obligations. Saved direct-only plans remain compatible because an omitted traversal field means direct calls. No database migration or Rust change is required.

## Remaining scope

Static paths are possible source relationships; they do not establish invocation, timing, concurrency or runtime dispatch. The chart compiler still decides what to draw from its projection; a witness in the membership table does not require every renderer to display every edge. The existing model-generated chart validation remains in place.

The next slices can add typed predicates such as reads/writes and containment, a structured compound-plan builder, and deeper evidence expansion with explicit coverage contracts. This slice does not claim to answer those questions or close unsupported-language and runtime gaps.
