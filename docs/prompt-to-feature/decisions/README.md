# Prompt-to-feature decisions

These records resolve the product-policy questions raised by GitHub issue [#98](https://github.com/arunsoman/code-intelligence/issues/98). They define what the implementation and certification work must enforce; they do not claim that the required integrations or evidence have already been built or measured.

| ID | Decision | Unblocks |
|---|---|---|
| [D001](D001-declaration-authority.md) | Declaration authority and review-only behavior | #94, #88 |
| [D002](D002-local-model-policy.md) | Required local Ollama baseline and model conformance | #94, #88 |
| [D003](D003-performance-policy.md) | Performance applicability, evidence and authority | #94, #88 |
| [D004](D004-validation-environment.md) | Browser, observed-coverage and runtime-evidence policy | #94, #88, #89, #90 |
| [D005](D005-publication-authority.md) | Scoped publication and exact-candidate invariant | #92, #88 |

## Execution order

1. **#98 decision record:** resolve product policy (these documents); keep hardware, measured budgets, audited browser image and real GitHub fixture credentials as explicit execution inputs rather than guessing them.
2. **#94 validation infrastructure:** Ollama run and measured model matrix; observed coverage; live-server Chromium journeys; runtime telemetry contract and measurements.
3. **#92 publication:** enforce scoped `feature.publish` authority and exercise a real draft-PR flow in a harmless fixture repository.
4. **#93 concurrency:** require fencing tokens on every candidate writer and validate the exact integrated candidate.
5. **#91 candidate representation:** support binary, symlink and mode mutations through Git's canonical binary diff/apply path.
6. **#88 golden path:** execute the normal CSV export flow plus denied-role, no-change and small-data variants with all required gates.
7. **#89 certification:** run AT-01–84 and merge evidence-backed ledgers.
8. **#90 truth and measured QA:** update README/spec/unsupported coverage from the certification results and publish measurements from the declared machine.

The strict prerequisite for #88 is #94 + #92 + #93; #91 is included before #88 to cover non-text candidate mutations. #89 follows #88, and #90 follows measured certification evidence. #93 and #91 are technically independent of #94/#92 but must both finish before the complete #88 acceptance run.
