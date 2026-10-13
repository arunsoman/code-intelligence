# shahy-restructure onboarding — second live browser sample (15 questions)

Run live against the running CIE server at http://127.0.0.1:4317 (not the in-memory harness),
same methodology as the first pass: each question asked in a fresh conversation context,
model `deepseek-v4.1-flash:cloud` (hosted), repo `shahy-restructure`.

Picked to spread across sections A–K, avoiding questions already sampled in the first pass
(1, 8, 32, 49, 52).

---

## Q2 (A). How many Gradle modules exist, and which directories look like services but aren't built?

**Result: model timeout -> fell back to deterministic facts -> investigation ran out of its
turn budget -> verdict UNRESOLVED (correctly withheld).**

- `Note: The model deepseek-v4.1-flash:cloud timed out. Try again or choose another model from
  the model menu; showing deterministic facts only.`
- `Note: Investigation incomplete: the answer and review reserve was reached.`
- `Note: The answer did not pass validation; its unvalidated conclusion was withheld.`
- Final message: *"Unresolved: I cannot yet support a definitive answer to this question."*
  Evidence inspected list was a grab-bag of unrelated files (Services.java, LeafAccountService,
  bp-test-client.py, alert-detail.component.ts, DynamicRCAEngine, kyc.service.ts, aml Main.java,
  sync_to_clickhouse.py, alert-list.component.ts, SDNSearchService, proxy-providers/app.py) —
  none of these are Gradle module/build-descriptor evidence.
- The withheld draft's own reasoning (visible in "Missing evidence or answer issues"): *"The
  draft's negative conclusion (no build configuration exists in the index) rests on a bounded
  keyword search for 'settings.gradle'/'build.gradle' and a single config lookup; an unread or
  unsearched build descriptor (e.g., settings.gradle.kts ...) cannot be ruled out."*
- Repair attempts: 0/2 (never reached the repair loop — this was a budget/timeout exhaustion,
  not a reviewer rejection).

**Assessment:** correct trust behavior (declined to assert a count it hadn't verified), but a
real-world reliability data point: the live hosted model timed out on this question even before
an answer draft could be reviewed. Not a code bug; a hosted-model latency/availability issue.

---

## Q7 (B). How does `api-gw` decide which backend host:port to send a request to?

**Result: SUPPORTED, answer review passed. Accurate and well-cited.**

CIE's answer: `api-gw` does not decide anything dynamically — the backend host:port is a fixed
compile-time constant chosen by a static route table in `GatewayConfig.customRouteLocator`.
Correctly cited:
- `baseUrl = local = "http://10.0.1.6"` constant (with the dead `ajith`/`vibin` constants noted
  as unused alternates, not runtime-selected).
- Spring Cloud Gateway matches first-fit path predicate, forwards to that route's fixed URI;
  confirmed no discovery locator is configured.
- `MiFilter` (GlobalFilter, order -1) only validates JWTs / injects identity headers, doesn't
  affect destination selection; `TraceMasterGlobalFilter.java` noted as an empty file.
- Correctly flagged `preserveHostHeader()` on the `bp_route` as the one extra routing-related
  detail.
- Proactively disambiguated the unrelated second gateway module `service-gateway` to avoid
  confusion between the two.

**Assessment:** this matches my hand-researched reference answer closely, including catching
the same `ajith`/`vibin` dead-constant detail from Q8 in passing (correctly, this time, since the
question is actually about routing and the constants are genuinely in `GatewayConfig`).

---

## Q13 (C). How is the JWT signed, and where does the secret come from?

**Result: UNRESOLVED — reviewer timed out, repair loop engaged (1/2) but still ran out of time.**

- Investigation evidence inspected was actually the *right* files: `JwtUtil.java` (init,
  validateToken, getUserIdFromToken, getUserTypeFromToken) and `Login.java` (generateToken,
  backOfficeLogin, LoginRequest/LoginResponse) — the draft was almost certainly looking at the
  right code.
- Failure reason: `"The review model did not respond within the available time budget; retrying
  with a fresh budget may succeed."`
- `Repair attempts: 1/2` — confirms the `reviewProcessFailed`/REPAIRABLE fix from earlier this
  session is live and working: a reviewer-timeout process failure now correctly engages the
  outer repair-retry loop (this used to be hardcoded UNRESOLVED with 0/2, per Bug B). Here it
  used 1 of its 2 attempts and still didn't recover before the overall question deadline, so the
  final verdict is still Unresolved — but for a legitimate reason (model latency), not the old
  swallowed-timeout bug.

**Assessment:** not a new defect. This is the `verifiedBy` change and `reviewProcessFailed` fix
both operating correctly together in production — no regression. The underlying bottleneck is
hosted-model latency/availability on this run (same symptom as Q2), not a code bug.

---

## Q19 (D). Why RESERVE then POST, instead of one direct debit?

**Result: UNRESOLVED — chat model call itself failed mid-investigation (not a timeout this time).**

- `Note: The retrieval model call reached its time allowance; remaining time is reserved for an
  answer and review.`
- `Note: Investigation incomplete: the chat model call failed.`
- `Note: The chat model did not complete an answer: the chat model call failed.`
- `Repair attempts: 1/2` — repair loop engaged correctly again.
- Evidence inspected was exactly the right file/methods: `BookkeepingEngine.reserve`,
  `BookkeepingEngine.post`, and surrounding `BookkeepingEngine` class/interface — so retrieval
  had already found the right code before the chat-model call itself errored out.

**Assessment:** third model-reliability failure in a row (Q2 timeout, Q13 reviewer timeout, Q19
chat-model call failure) on questions that need multi-step investigation, vs. Q7 (a more
self-contained, single-file routing question) which passed cleanly. This looks like the hosted
`deepseek-v4.1-flash:cloud` endpoint is under load or intermittently erroring right now, not a
CIE defect — retrieval is finding the right evidence each time, it's the generation/review calls
that are failing.

---

## Q22 (D). What does `FOR UPDATE SKIP LOCKED` do, and why does multi-instance matter?

**Result: UNRESOLVED — reviewer timed out again.**

- `Note: The answer did not pass validation; its unvalidated conclusion was withheld.`
- Evidence inspected: `OutboxRepository.fetchAndLockBatch`, `OutboxRepository.fetchPending`,
  `OutboxService.pollPending`, `LedgerQueueConsumer.processOutboxEvents` — exactly the right
  symbols for a `FOR UPDATE SKIP LOCKED` / outbox-polling question.
- `"The review model did not respond within the available time budget; retrying with a fresh
  budget may succeed."`

**Assessment:** fourth hosted-model reliability failure out of five questions so far (only Q7
passed). Retrieval keeps finding the right evidence; every failure so far is in the
generation/review stage of the pipeline, consistently time-budget related. This strongly
suggests the hosted `deepseek-v4.1-flash:cloud` endpoint is currently slow/overloaded, not a CIE
logic regression — worth flagging to the user as a live infrastructure observation separate from
the code fixes under test.
