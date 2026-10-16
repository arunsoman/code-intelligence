# Nested field-read identity correction

Apply after profiling checkpoint 1329f65. Default mode remains off. Producer
version becomes 3; enabled analyzer namespace is evidence-core-v3 and enabled
revision suffix is -ec3. AnalysisBatch sidecar envelope remains batch.v1.

## Cause and minimal reproduction

The reads emitter uses `fact:reads:<file>:<startByte>` but nested member reads
`x.content.length` share a start byte. When both content and length are written
somewhere, the lineage filter retains both read observations. They have different
payloads and the same ID. Legacy merging silently keeps one; strict collision
validation rejects them. The first observed failure in CIE core was a reads fact
in answer-validation.ts. No entity collision or broken hash function was involved.

The seven-line nested-reads/nested.ts fixture writes both fields then reads the
nested expression. A saved previous worker reproduces EVIDENCE_CORE_ID_COLLISION
on that fixture. The corrected worker retains both reads.

## Correction and compatibility

The versioned normalizer already handles two known emitter collisions. It now
also handles fact:reads IDs whose predicate is reads, keeping the first legacy ID
and assigning distinct colliding payloads an observation-v3 SHA-256 suffix.
Existing call/defect observation-v2 suffixes stay unchanged. Arbitrary collisions
and conflicting evidence IDs remain hard failures. Default-off output is unchanged.

Because an additional fact is now observable, enabled revisions and producer
identity are versioned, rather than mutating existing content-addressed revisions.
Worker analyzer/revision suffixes derive from the producer version. Version-2
bases force a full index; Store does not authorize their delta reuse. Historical
metadata remains readable under its original revision. No DB migration is needed.

## Validation

Release build, 139 Cargo tests, 29 targeted Node tests and typecheck passed.
New regressions verify both read values, unique IDs, retention of the legacy
fact and object, version-2 full fallback, and full/delta metadata equivalence
when a different file stops writing one of the fields. A new Rust test verifies
that unrelated fact-ID conflicts are not repaired. Existing collision, source
access, atomic rollback and resource-limit checks remain green. Temporary debug
ID details were removed; production collision errors retain their generic code.

## Full-core result and remaining blocker

The corrected full-core scan passes collision validation, then stops with
RESOURCE_LIMIT / EVIDENCE_CORE_LIMIT: sidecar row cap exceeded. The default-off
scan of the same source succeeds with 312 files, 84,109 facts, 10,822 relationships
and 105,713 fact/relationship evidence associations. The corrected enabled
projection can add observations; the off count alone already exceeds 100,000.

This fixes the diagnosed collision, NOT full-core enabled indexing. The 100,000
row cap and 16 MiB cap remain intact. The next work must address bounded large-
repository metadata handling (for example streaming/chunking with revision-wide
budgets), rather than silently raising limits or skipping validation. No new
performance acceptance is claimed; default enablement remains blocked.
