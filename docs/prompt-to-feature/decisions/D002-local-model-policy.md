# D002 — Local model policy

**Status:** Accepted product-policy baseline, 2026-10-06
**Origin:** GitHub issue #98, decision 2
**Unblocks:** #94 and #88

Ollama local execution is mandatory for the baseline Prompt-to-feature certification path. Cloud providers may be opt-in adapters later, but cloud access is not a prerequisite for proving the baseline workflow. A local-only session must never fall back to a cloud provider.

Maintain a versioned tested-model matrix instead of hardcoding one model as the permanent product requirement:

| Tier | Requirement | Suggested class |
|---|---|---|
| Minimal | Required for low-resource baseline certification | Approximately 1B–3B coding/instruct model |
| Reference local | Optional quality comparison when hardware permits | Approximately 7B model |

The actual model name, Ollama version, machine and measurements are recorded by #94 after a real run; this decision does not claim a model is already certified.

For each run, record model/provider identity, Ollama/model version where observable (otherwise `UNKNOWN`), prompt/template hash, seed and sampling settings when supported, input/output token counts when available, duration, retries, repair loops, generated paths and validation outcome. Do not expose raw private prompts in the telemetry record.

### Conformance bar

- Deterministic safety gates and syntax/schema contracts: **100% pass**.
- No unsupported file creation without retrieved evidence; no unauthorized operation or egress.
- Core builder scenarios: at least **9 of 10 independent runs** succeed for the minimal tier.
- Materially different outcomes on repeated identical inputs are reported as flaky; the harness must not silently repair or hide failures.
- Quality means orchestration reliably constrains and verifies the model. It does not require the small model to independently reason perfectly.

The 10-run result is evidence for the tested model/build/configuration only. It is not a general guarantee for other prompts, repositories or hardware.
