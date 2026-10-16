# Evidence core: native delta slice

This patch follows the foundation checkpoint `2b0bd5a`. It adds native delta
sidecars and version-fenced reuse of unchanged file producer runs. Default mode
remains off; coverage remains PARTIAL and proof gates remain disabled.

## Behavior

- Service advertises a reusable base only when its producer version, analyzer,
  file scopes, coverage rows and support-link cardinality are compatible.
- Worker version 2 accepts compatible bases, emits changed scopes, and always
  recomputes repository scopes. Missing or older producer versions force full.
- Store copies unchanged file provenance, rebinding revision membership while
  preserving content identities. It validates incoming scopes against the
  resulting revision and writes everything in one transaction. Missing copied
  evidence bindings trigger full fallback; other insertion errors roll back.
- Known legacy unresolved-call and defect emitters could assign the same ID to
  distinct observations at one start byte. The first retains its legacy ID;
  additional distinct observations receive a content-addressed observation-v2
  suffix. Other incompatible ID collisions remain errors.
- This semantic correction uses producer version 2, an evidence-core-v2 analyzer
  suffix and an `-ec2` revision suffix. Legacy/off revisions remain immutable.
  Consumers must not assume enabled and disabled revision IDs are identical.

## Validation

- Setup and release build passed. Cargo workspace: 137 tests passed.
- TypeScript typecheck passed.
- Targeted Node suites: evidence-core, evidence-core-delta, incremental-index,
  store-queries. Delta cases cover unchanged indexing, edits, additions,
  removals, cross-file target edits, exact clean/full metadata equivalence,
  producer fences, missing coverage/support links, manifest tampering, atomic
  rollback, denied/revoked reads, and chained-call collisions.
- Manual strict enabled indexing of fixtures/sample-repo succeeded: 80 facts,
  six producer runs, reusable base version 2.

## Limits

This is a staged migration, not completion of the full PRD. The worker still
builds the graph before sharding; this does not claim parsing only changed
sources. No new benchmark acceptance is claimed. The foundation performance
target remains unmet, so enabling by default is not justified. Broader producer
decomposition, resource accounting across accumulated delta metadata, and
performance work remain follow-up tasks.
