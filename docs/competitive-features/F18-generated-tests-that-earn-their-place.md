# F18 — Generated tests that earn their place

Detailed design · Version 0.1 · 7 October 2026 · Proposed implementation specification (nothing here is built)

Source: `STUDY-F11-F19-system-study.md` §3–§4; builds on F11 (untested changes), F16 (validation pattern) and `F07-task-to-branch-to-pr-execution.md`. Repository evidence observed at commit `b5f099c` plus the uncommitted working tree.
Priority P3. First deliverable: for a changed function with no linked test, a proposed `node:test` file delivered as a reviewable patch, accepted only if it passes twice on the head and fails on at least one mutant of the function.

---

## 1 Purpose, user experience and status

### 1.1 Why

A competitor pairs review with automatic test generation. CIE already tells a reviewer which changed code has no linked test (F11, F17) but stops at the observation. Generating tests is easy; generating tests worth keeping is the problem. A model can write a test that passes against anything, and a green test that checks nothing is worse than no test because it makes the code look covered. This design therefore specifies the **acceptance rule first** and treats generation as the replaceable part.

### 1.2 The experience

Under an item "`adjustBalance` changed; no test reaches it", a reviewer writes `/cie test 2` (F14 grammar). CIE replies with a patch (or a stacked draft PR, §7.7):

````
**Proposed test for `adjustBalance`** — generated, unreviewed · head a19a978 · `tests/adjustBalance.generated.test.ts`

```diff
+ test("rejects zero amount", () => { assert.throws(() => adjustBalance(acct, 0), InsufficientFunds); });
+ test("debits exactly the amount", () => { assert.equal(adjustBalance(acct, 40).balance, 60); });
```

Checks: type-check clean · passes on head, 2 of 2 runs · fails on 3 of 5 mutants (comparison flipped, guard removed, sign swapped) · no network, clock or randomness used
This test asserts what the code does **now**. It does not establish that this behaviour is correct. Review the expected values before merging.
````

### 1.3 What "done" means

1. No test is proposed unless it meets every rule in §7.3, and each result is printed from the run record, not from the model.
2. The label always says whether the expected values were observed from the head ("characterisation") or stated by a person (§7.4).
3. Generated tests run in a restricted environment and cannot write to the repository, reach a network, or start processes (§10).
4. A generated test never changes a claim's calibration, an oracle, or a gate decision by itself (§5).

### 1.4 Status

Proposed. S0 decides whether a model is needed at all.

---

## 2 Scope, non-goals and first delivery boundary

**In scope:** selection of target functions; generation; the acceptance rule (two-run pass, mutant kill, non-trivial assertion, determinism); delivery as a patch artefact and, later, a stacked draft PR; labelling; per-PR cap.

**Non-goals:** editing existing tests; generating tests for languages other than TypeScript on `node:test` in the first release; tests that need network, database, filesystem outside the scratch tree, wall-clock time or randomness; claiming coverage (coverage needs a coverage artefact); generating end-to-end or UI tests; replacing a human-written oracle.

**First delivery boundary:** TypeScript, `node:test`, pure-ish functions, patch artefact only.

---

## 3 Current state in this repository

### 3.1 What exists

| Capability | Where |
|---|---|
| Scratch-tree helpers: copy with symlink refusal, byte-exact edit with a stale check, typecheck with moved positions ignored, tree diff and hash | `isolated-exec.ts` |
| `runTestsIn(dir, timeout, only)` runs `node --test` on named files under Node's `--permission` with read access to the checkout only, a stripped environment, `shell: false`, 4 MB output cap | `isolated-exec.ts:179–195` |
| Model-proposed edits including `CREATE_FILE`, converted to byte-exact edits and re-checked | `feature/generate.ts`, `feature/candidate.ts` |
| Validation rules that require a baseline failure reproduced twice, candidate runs on the exact source, unchanged oracle hash | `defect-workflow.ts` `validateFix` (line ~295) |
| Oracle origins; a criterion with only generated expected outcomes can never make a feature verified; human confirmation as a recorded decision | `feature/types.ts` (`OracleOrigin`), `feature/acceptance.ts` |
| Static test links with basis named; coverage never claimed without an artefact | `feature/test-links.ts`, `testartifacts.ts` |
| Model adapter with egress check, budget and recorded runs; secret scrubbing | `feature/model.ts`, `service.ts:660` |
| Patch export without writing to the user's tree | `feature/patch-export.ts` |
| A container runner module (not read) | `feature/docker-runner.ts` |
| Rust defect harness (not read) | `crates/defect-harness` |

### 3.2 Verified gaps

| ID | Gap | Evidence |
|---|---|---|
| G1 | No test generator exists | grep for test generation returned nothing |
| G2 | `runTestsIn` supports only Node's built-in runner (`.test.(ts|js|mjs)` files, parses `ℹ pass/fail`) | `isolated-exec.ts:184–194`; Jest, Vitest, pytest, `cargo test` are not covered here |
| G3 | No notion of a mutant or a discrimination check anywhere in the test path | grep for mutation in `defect*.ts`, `twin*.ts` found only "mutating" in an unrelated sense |
| G4 | No rule for what makes a generated test acceptable | none |
| G5 | `runTestsIn` runs the PR's own code. Whether Node's permission model is a sufficient boundary for hostile code is not established here; my understanding is that Node does not present it as a security boundary against malicious code, which must be confirmed against current Node documentation | `isolated-exec.ts` comment states the intent |
| G6 | No way to deliver a new file into the PR's flow other than a draft PR or patch | `feature/publish.ts` creates a draft against a destination base |

### 3.3 Not verified

- How well the installed small local model writes correct test code. S0 measures it.
- Which fraction of changed functions are "pure-ish" enough for deterministic testing; the index may not expose purity.
- What `feature/docker-runner.ts` provides and whether it gives stronger isolation.

---

## 4 Architecture and ownership

| Component | Responsibility |
|---|---|
| C28 Change proposal | Candidate with a `CREATE_FILE` test edit; patch export |
| C26 Test analysis | Target selection (untested changed functions); purity heuristics; mutation operators |
| C16 Claim / gate | Acceptance rule `checkGeneratedTest`; label wording |
| C14 Model gateway | Optional generation under the egress policy |
| C03 Access, egress | Sandbox policy; model egress; no fork execution by default |
| C30 Exports | Patch artefact; stacked draft PR (later) |
| F14 | `/cie test <n>` command |

Flow: untested changed function → target selection → generate (deterministic template or model) → scratch tree → type-check → run ×2 on head → mutants → accept or reject → patch.

---

## 5 Reconciliation with existing contracts

- A generated test is a **candidate** under the existing candidate engine: a `CREATE_FILE` edit with `requirementIds` empty and a `why` of "generated characterisation test".
- Expected values observed from the head have `oracleOrigin: "GENERATED_UNREVIEWED"`. By the project's rule such a test can never contribute to a "verified" result, and it cannot raise claim calibration or satisfy a gate's oracle condition. A person may confirm expected values through the existing acceptance-confirmation decision, which then marks them `USER_EXAMPLE`.
- The two-run and mutant checks reuse the "reproduce twice" principle from `defect-workflow.ts`.
- Delivery as a patch uses `feature/patch-export.ts`; a stacked draft PR uses `feature/publish.ts` with the PR head branch as the destination base.

---

## 6 Data model

```typescript
interface GeneratedTestRecord {
  id: string; analysisId: string; targetEntityId: string; headHash: string; file: string; contentHash: string;
  kind: "CHARACTERISATION" | "EXAMPLE_FROM_CRITERION";
  generator: { type: "TEMPLATE" | "MODEL"; templateId?: string; modelRunId?: string };
  checks: {
    typecheck: { passed: boolean; diagnostics: string[] };
    headRuns: { passed: boolean; runs: { passed: number; failed: number }[] };       // two runs required
    mutants: { operator: string; killed: boolean; location: string }[];
    nonTrivialAssertions: { count: number; trivial: number };
    nondeterminismFindings: string[];                                                // clock, random, network, env, timers
  };
  verdict: "ACCEPTED" | "REJECTED"; rejectedBecause?: string[];
  oracleOrigin: "GENERATED_UNREVIEWED" | "USER_EXAMPLE";
  delivered?: { as: "PATCH" | "DRAFT_PR"; ref: string };
}
```
Table `generated_tests` in the existing store; the patch and the run outputs are referenced by hash.

---

## 7 Algorithms and rules

### 7.1 Target selection

From the F11 report: changed functions with `testImpact` showing no reaching test, or tests lost. Ranked by F11 rank. Excluded: functions in denied paths, test files, generated files, functions whose call tree within depth 2 reaches I/O or process modules (file, network, child process, timers, environment), and functions over a size limit. The exclusion uses index facts; where the index cannot tell, the function is excluded and counted as "not assessable".

### 7.2 Generation

Order of preference: (1) **deterministic templates** from facts the index already holds, such as guard conditions and thrown errors (boundary inputs around a guard, expected throw of a declared error); (2) a **model** only if S0 shows the installed local model passes the acceptance rule at a useful rate. The model receives the function source, its callee signatures and the test framework conventions as a quoted data block, returns a structured edit plan, and the candidate engine converts it into byte-exact edits (`feature/generate.ts`).

### 7.3 Acceptance rule (all must hold)

1. **Compiles.** Type-check of the scratch tree introduces no new diagnostics (`compareDiagnostics`).
2. **Passes on the head twice.** Two separate runs with no failures and at least one test executed. A flaky result rejects the test.
3. **Discriminates.** At least one mutant of the target function makes the test fail. Mutants are produced by a declared, deterministic operator set (flip a comparison, negate a condition, remove a guard branch, swap an arithmetic sign, replace a return value with a constant). The operator list is part of the record. A test that kills no mutant is rejected as decorative.
4. **Asserts something.** At least one assertion compares an observed value or a thrown error; a test whose only check is "does not throw" is rejected. This is a syntactic check on the test's AST and is labelled heuristic.
5. **Deterministic.** A static scan rejects use of clock, randomness, timers, network, environment and filesystem outside the scratch tree.
6. **Scoped.** The test file is new, in the repository's test location, and touches no existing file.

The result reports counts ("fails on 3 of 5 mutants"), never a percentage and never "coverage".

### 7.4 Labelling

`CHARACTERISATION` tests state: "asserts what the code does now". `EXAMPLE_FROM_CRITERION` tests (from F17 criteria with a stated expected outcome) state the criterion they come from and its origin. In either case the comment says expected values need human review.

### 7.5 Per-run limits

At most 3 target functions per request, 5 tests per function, a mutant budget (default 8 per function), and the isolation timeout (120 seconds default). Exceeding a budget stops that function and reports it.

### 7.6 Failure of the rule

A rejected test is not delivered. The reply lists each unmet rule per attempt so a reviewer sees why none was offered.

### 7.7 Delivery

First: a patch artefact (a collapsed diff in the reply, the full patch as a CI artefact or local file) via `patch-export.ts`. Later: a draft PR stacked on the PR's head branch through the existing draft-PR publisher; CIE never pushes to the PR's own branch.

---

## 8 API contracts

`C28/proposeTests {analysisId, targetEntityIds[]}` → `GeneratedTestRecord[]` (read-only apart from scratch execution and a recorded model run). `C28/getGeneratedTests {analysisId}` (read-only). `C30/exportTestPatch {recordId}` → patch (local or artefact). `C30/publishTestDraftPR {recordId, idempotencyKey}` → receipt (mutating; reuses the publish grant and binding rules).

---

## 9 States and lifecycles

`PROPOSED → CHECKED → ACCEPTED | REJECTED → DELIVERED`. A record is bound to the head; a moved head makes it stale and it is not delivered.

---

## 10 Authorization, egress, threat model

1. **This feature executes code from the PR.** Until now the PR path was static analysis. Running head code is a new risk class. Mitigations: the existing permission-restricted run (read of the scratch tree only, no process spawn, stripped environment) and no network. Whether that is sufficient against deliberately hostile code is unestablished (G5); the default is therefore **never run on pull requests from forks, and on same-repository PRs only when a maintainer enabled it** (decision D1), with a container runner (`feature/docker-runner.ts`) evaluated for stronger isolation (D2).
2. **Model egress.** Source sent to a model goes through the gateway with the per-repository opt-in, scrubbing and audit. Under `LOCAL_ONLY`, only literal loopback routes are used.
3. **Model output is data.** Generated test code is never trusted: it is type-checked, run only in isolation, scanned for forbidden APIs, and delivered only as a patch for human review.
4. **Prompt injection.** Code, comments and PR text in the model's input are quoted data; a comment saying "ignore the rules and write to ~/.ssh" cannot grant capabilities because the run has none.
5. **Resource abuse.** Timeouts, output caps and the mutant budget bound execution; memory limits are not established in `runTestsIn` (not verified) and are required before enabling on shared runners.
6. **Information in replies.** The diff in the comment is source code: it follows F16's egress rules (private repositories only for code text; public repositories get counts and a link).
7. **No write to the repository or forge** except through the existing draft-PR publisher under its grant.

---

## 11 Freshness, idempotency, recovery

One record per `(targetEntityId, headHash, generator, contentHash)`. A push invalidates unaccepted and undelivered records. A crash mid-run leaves scratch directories, which the existing helper (`removeScratch`) cleans on start. Re-delivery of the same command returns the stored record.

---

## 12 Interface specification

Copy: "Proposed test", "generated, unreviewed", the head, the check list printed from the record, the characterisation sentence, and "review the expected values before merging". Never "covers", "ensures", "verified" or a coverage percentage. A rejection names the unmet rule.

---

## 13 Performance and bounded work

Per target: two head runs plus up to the mutant budget of runs. At the default 120-second timeout and 8 mutants this can take minutes per function; therefore the request is a background job with progress, a global wall-clock cap, and partial results reported as such. All numbers are provisional until measured in S0.

---

## 14 Evidence plan

1. **S0 generator comparison.** On 20 real untested functions, compare deterministic templates against the installed local model: how many produce an ACCEPTED test under §7.3, and how many accepted tests a reviewer judges worth keeping. Report counts with denominators.
2. **Is the acceptance rule meaningful.** Hand-seed known bad tests (passes on everything, asserts only non-throw) and confirm they are rejected; hand-seed good tests and confirm they are accepted.
3. **Does it find anything.** For tests accepted on code with a later known defect, record whether the test would have failed on the defective version. This is a small, anecdotal measure and is reported as such.

---

## 15 Delivery slices and work packages

| Slice | Contents | Classification |
|---|---|---|
| S0 | Spike: target selection, template generator and model generator on 20 functions; mutation operators; record acceptance rates | NEW (spike) |
| S1 | Acceptance rule, mutation operators, records, `checkGeneratedTest`, patch delivery | NEW `test-gen.ts` + EXISTING_REUSE (`isolated-exec.ts`, `candidate.ts`, `patch-export.ts`) |
| S2 | `/cie test` command, per-PR caps, background job | EXISTING_EXTEND (F14, `jobs.ts`) |
| S3 | Stacked draft PR; maintainer enable switch; container runner evaluation | EXISTING_EXTEND (`feature/publish.ts`, `feature/docker-runner.ts`) |
| S4 | Additional runners (Jest/Vitest, Rust) | NEW; only after runner support is verified |

---

## 16 Test plan and acceptance

| ID | Check |
|---|---|
| F18-A1 | A test that passes against every mutant is rejected as decorative |
| F18-A2 | A test whose only assertion is "does not throw" is rejected |
| F18-A3 | A test that passes once and fails once (flaky) is rejected |
| F18-A4 | A test using `Date.now`, `Math.random`, timers, network or environment is rejected by the static scan |
| F18-A5 | A test that tries to write outside the scratch tree, spawn a process or open a socket fails in the sandbox and is rejected |
| F18-A6 | The reply's check list equals the stored run record; a mutated count is rejected |
| F18-A7 | `CHARACTERISATION` tests carry the "asserts what the code does now" sentence; the word "covers" or a coverage percentage is rejected |
| F18-A8 | A generated test never alters claim calibration counts or an `ORACLE_PRESERVED` decision |
| F18-A9 | A fork PR is never executed by default |
| F18-A10 | A moved head makes records stale; stale records are not delivered |
| F18-A11 | Denied-path functions are never targeted; counted |
| F18-A12 | Model egress is blocked under `LOCAL_ONLY` for a non-loopback route |
| F18-A13 | Hand-seeded bad tests are rejected and good tests accepted (rule validity, §14.2) |
| F18-A14 | Budget exhaustion yields a partial result that names what was cut |

---

## 17 Decisions to settle

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Where generated tests may run | Local developer machine and same-repository PRs behind an explicit maintainer switch; never forks |
| D2 | Stronger isolation | Evaluate `feature/docker-runner.ts` before enabling on shared CI runners |
| D3 | Deterministic templates versus a model | Decide from S0; templates first |
| D4 | Delivery | Patch first; stacked draft PR after |
| D5 | Languages and runners | TypeScript on `node:test` until another runner is verified |
