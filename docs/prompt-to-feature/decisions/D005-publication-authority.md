# D005 — Scoped publication authority

**Status:** Accepted product-policy baseline, 2026-10-06
**Origin:** GitHub issue #98, decision 5
**Unblocks:** #92 and #88

Request ownership does not imply permission to publish. Model publication as a separately configured scope, `feature.publish`, with a principal, repository and explicit permission set (initially `draft_pr.create`). Keep request, validation, publication and release authority separate. Repository/base-branch allowlists and branch/label conventions belong to the binding or repository policy, not caller-supplied free text.

Draft-PR creation requires all of the following at the write boundary:

```text
candidate is verified
AND publication authority is valid for this principal and repository
AND target repository and base branch are allowed
AND candidate SHA equals the SHA covered by the validation evidence
```

The exact validated/integrated candidate hash is carried through branch creation, commit and PR receipt. Any candidate change, merge, rebase or conflict resolution invalidates the certificate until the resulting exact tree is revalidated. Publication remains draft-only; merge and deployment are separate authorities and operations.

Issue #92 must exercise one real draft PR against a harmless fixture repository, verify the resulting head SHA and evidence summary, and record the repository, branch convention and labels. Credentials are injected through the authorized execution environment and never committed. The real target repository and credential availability remain operational inputs; this decision does not authorize publication to the main product repository.
