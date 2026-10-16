# Evidence-core scope membership hardening

Incremental patch after lazy-fact checkpoint 4afdfcb. No migration, producer ID,
revision namespace or default changes. Valid Rust-produced metadata is unchanged.

## Defect and fix

Validation checked supplied coverage rows and support links, but did not require
coverage for every producer run. Evidence-free files could also be omitted
without making support-link validation fail. Strict mode could therefore store
an incomplete metadata membership set without rejecting it.

The validator now requires one producer run per expected scope, no duplicate or
unexpected scopes, and one coverage record per run. Expected full scopes come
from the manifest; expected delta scopes are surviving manifest entries in
changedFiles. Repository scope uses the empty manifest key. Static runs must
have PARTIAL status. This checks membership, not closed-world completeness:
coverage remains PARTIAL and proof gates remain disabled.

Strict invalid full/delta writes roll back. Optional invalid sidecars are
wholly discarded with EVIDENCE_CORE_REJECTED while legacy facts remain. For an
optional delta, already copied valid unchanged provenance may remain; the new
revision cannot authorize reuse when required scopes are missing.

Base selection additionally rejects extra/duplicate/missing stored scopes,
non-PARTIAL runs, invalid coverage status/domain and malformed run JSON. It
returns no reusable version instead of throwing for malformed JSON. It is a
compatibility fence, not a general cryptographic audit of arbitrary DB tampering.

## Validation

Release build, 138 Cargo tests, TypeScript checks and 26 targeted Node tests
passed. New cases cover missing coverage, an omitted evidence-free file,
missing repository scope, failed producer state, optional rejection, strict
delta rollback, corrupted coverage state and malformed stored run JSON.
Existing suites retain full/delta equivalence, access filtering, resource limits
and default-off compatibility. The patch applies after the preceding patch.

No new speedup or performance acceptance is claimed. Broader profiling and the
1.15x target remain pending; default mode remains off.
