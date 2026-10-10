# Make a feature: prompt → agreed plan → candidate → checks → repair → patch

This patch connects the existing Build feature wizard to a complete, bounded build workflow. It is incremental to `pr-review-context-consolidated.patch` against repository base `fdbcb4f`. Apply that consolidation first. It does not push commits or publish a pull request.

## User journey

| Stage | Primary work | Result |
|---|---|---|
| Describe | Explain the missing feature and an example of expected behavior | Durable feature request; discovery and planning job |
| Clarify | Answer material questions; update the plan | Recorded decisions, constraints and overlap assessment |
| Agree plan | Review requirements and explicitly confirm generated expected outcomes | Versioned agreed contract |
| Changes | Inspect the impact graph, affected files and code/diffs | Exact candidate review |
| Test & repair | Run baseline/candidate checks; repair candidate failures within budget | Candidate-bound execution evidence and repair checkpoints |
| Deliver | Export the patch and download its validation report | Local replacement patch with exact base and candidate identity |

The feature occupies the dialog's main content area. Task details are collapsed, the duplicate heading is removed, and narrow-screen actions wrap. Stage navigation does not execute work. A new feature creates a separate request; the saved request's original prompt and mode are read-only.

## Execution and repair

- `C02/prepareFeaturePlan` analyses an existing request without generating edits or approving criteria. It checks constraints, clarifications, existing support and impact, then prepares tasks.
- `C28/buildFeatureCandidate` generates edits against the agreed contract, materializes them in an isolated candidate, and runs the existing validation engine.
- Three repairs and ten minutes are the UI defaults. The API permits 0–3 repairs and 1–1800 seconds. Provider calls also retain their existing bounded budgets.
- Initial generation may add tests. Automatic repair cannot change or delete test files, including tests added by its own candidate. Existing test changes remain subject to the candidate engine's policy controls.
- Compiler, type, unit and integration failures are repairable only with a healthy baseline. Baseline failures, infrastructure limitations and policy/security failures stop for review.
- Each repair creates a cumulative candidate against the original base. Earlier candidates are superseded; their evidence does not transfer to the new candidate.
- A changed contract, changed base, withdrawn source access, cancelled job or lost job ownership prevents late candidate/evidence writes.
- Optional workbench history lives in the existing durable request JSON: reports, job IDs, timestamps, candidate hashes, repair counts and evidence IDs. No new database migration is needed.
- A process restart marks unfinished jobs interrupted through the existing job engine. Reopening displays that checkpoint. Resume starts a fresh bounded run from the saved current candidate; there is no silent automatic replay of a model call.
- Standalone validation now chooses the Docker runner when available, consistent with pipeline validation, and otherwise uses the local runner with its stated refusals and omissions.

## Local failure feedback

`C27/importFeatureTestReport` accepts the strict shared `feature-test-report.v1` JSON contract. The wizard downloads a template populated with the request, candidate and original base revision. The user can upload a JSON file or paste JSON.

```json
{
  "format": "feature-test-report.v1",
  "requestId": "request ID from the downloaded template",
  "candidateHash": "candidate binding hash from the downloaded template",
  "baseRevision": "original base commit from the downloaded template",
  "command": "npm test",
  "environment": "OS, Node version and relevant dependency versions",
  "exitCode": 1,
  "failures": [
    { "name": "CSV export returns a header", "message": "Expected/actual values and bounded stack trace" }
  ],
  "output": "Optional bounded diagnostic output"
}
```

Reports are limited to 64 KB, 100 failures and 32,000 output characters. Unknown fields and inconsistent successful exit codes with failures are rejected. Import is content-deduplicated and owner-scoped, with a limit of 16 reports per request. Reports must name the current candidate, current contract and its exact original base. A request retains up to 32 build runs.

Imported results are labelled `EXTERNAL_UNVERIFIED`. They never enter the execution-evidence table or satisfy a publication gate. Commands are diagnostic labels, not instructions to execute. The repair model receives bounded diagnostic data through its structured edit-plan stage and cannot replace the agreed contract. Repair from a local failure report is followed by the system's own validation attempt.

JUnit XML, Jest/Vitest JSON, TAP and plain-log adapters are follow-up extensions; this patch implements canonical JSON only. Incremental follow-up patches against a developer's already-modified tree are also not implemented.

## Delivery contract

`C27/exportFeatureValidationReport` includes:

- request ID, candidate binding/content hash and original base commit;
- diff identity and exported patch artifact hashes when a patch has been exported;
- validation-plan hash and declared check commands;
- execution manifests, isolation class, tool versions, baseline health, results, coverage gaps and bounded diagnostic output;
- whether each recorded check is current for this candidate/contract/plan;
- imported-report references explicitly marked external/unverified.

The existing export engine continues to evaluate eligibility and label the patch. Passing checks alone never bypass coverage, expected-outcome review, model evaluation, required declarations, or release approval.

Corrected patches are **replacements against the original base**. Apply them on a clean branch at that base. Do not stack a replacement patch onto a previously applied replacement patch. Check before applying:

```bash
git apply --check feature.patch
git apply feature.patch
```

## Environment requirements and current limits

The UI performs `C02/featureSetupCheck` and displays the actionable results. Automatic generation/check planning currently targets TypeScript/Node/npm. Installing Rust alone does not provide a Rust feature-build adapter, and mixed-language repositories need additional validation adapters.

A usable configured model route is required. Generation remains subject to the repository's egress policy and model provenance/evaluation gates. This patch does not install a model, infer authority bindings, change security policy, or declare a production-like environment on the user's behalf.

The user can explicitly declare synthetic test fixtures. Unknown or unauthorized test data stays blocked. A synthetic-data declaration does not establish representative environment fidelity or dependency availability.

For npm scripts, Docker and a suitable provisioned runner environment are preferred. The default Node image does not automatically contain repository-specific dependencies, compilers, databases, browsers or external security tools. Dependency installation/provisioning and additional stack adapters remain separate work. A refused or incomplete run remains visible and does not become a pass.

Production requires external SAST by default. The scripted transactions fixture now explicitly selects built-in security checks, fixing older fixture expectations without relaxing production policy.

This development host has Node 24, no usable Docker image/daemon, and no usable network namespace. The local permission runner therefore refuses the real candidate assertion test. That check is explicitly skipped with its isolation reason. The new orchestration tests use controlled model/runner fixtures; the headless UI test uses a real app/server/browser with scripted feature API responses. These establish workflow behavior, not production model quality or a full container validation result.

## Validation

The focused backend and existing wizard suites cover report ownership/binding/deduplication, UTF-8 cumulative edits, protected tests, bounded repair, cancellation, recorded model calls, fresh request analysis/confirmation/build, existing validation/eligibility and release behavior. The headless browser exercises build, failure import, repair, narrow-screen layout and reopening the saved job. Type checking and plugin-contract checks are required before delivery.
