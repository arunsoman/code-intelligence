# Sample-question inventory — every askable prompt in the repo's markdown

Built by scanning every `.md` file for question-shaped lines and quoted user prompts
(quoted fragments are how the demo scripts, PRD use cases and feature specs express
"what a person would ask"). Purpose: the single corpus behind eval runs (Phase 5
acceptance gate), with each prompt classified by which capability must answer it and
whether that capability exists today.

## 1. Corpus map

| File | Askable prompts | Role |
|---|---|---|
| `tools/eval/shahy-onboarding/questions-and-answers.md` | 55 numbered (Q1–Q55, sections A–L) | **Primary golden set** — real onboarding questions against the shahy-restructure fixture, with reference answers |
| `tools/eval/shahy-onboarding/report.md` | the same 55 | Run log of CIE answering the golden set — not a distinct corpus |
| `tools/eval/shahy-onboarding/live-sample-2.md` | 5 live excerpts of the same | Run log excerpt — dedupe |
| `dlta-report.md` §22–27 (UC-01…UC-36) | ~46 quoted prompts across 6 families | PRD use-case prompts ("A person could ask: …") |
| `README.md` (demo script) | ~24 quoted prompts | Flagship demo script — heavily overlaps the DLTA UCs |
| `plans/code-explainer-query-chart-implementation.md` | ~30 quoted exemplars | Original implementation-plan query catalogue |
| `docs/competitive-features/README.md` + `F01…F19` | ~25 exemplars | One exemplar prompt per competitive feature |
| `C22_Hypothesis_Engine_Detailed_Design.md`, `C27_…Counterfactual…` | 7 | Design-motivating prompts |
| `docs/eval-hierarchy-retrieval.json` | 17 (JSON, not md) | Golden introspection questions for hierarchy retrieval |
| `code-intelligence-qa-certification-report.md` | echoes README/demo prompts | Certification log — dedupe |

Raw extraction ≈ 210; unique after dedupe ≈ **~170 questions in 14 families**.

## 2. Families, prompts, and what must answer them

Status: ✅ answerable today · 🟡 partial (needs evidence the system has, but thin) · ❌ future/not built.

### F1 — Project overview & architecture map ✅
Tools: `project_overview`, SOURCE_OVERVIEW, `get_module_graph`, `read_module`.
- "What does this whole repo / project do?" (plan, demo) · "what is this project about?" (progress-review)
- "Explain this project, identify its riskiest module, and show me the tests covering it." (README)
- "Show me the high-level architecture / components" · "How is the codebase structured / organized?" · "Show me the modules / services and their dependencies" · "What is the main entry point / how does the app start?" · "What are the main entities / database tables?" (plan)
- shahy Q1 (what product, who are the users)

### F2 — Explain an element / body semantics (IR-first core) ✅
Tools: `ir_of` (semantic IR), `read_code` escalation, `find_code` resolution.
- "Walk me through createPayment" (README) · "Walk me through what happens when [action]" (plan)
- "What are the possible paths / control flow of this method?" · "Explain this method step-by-step / line-by-line" · "what does this do?" (plan)
- "show me ReserveService" · "show me the billing module" (plan)
- shahy Q7 (gateway host:port decision), Q8 (what are "ajith"/"vibin"), Q10 (retry/circuit-break),
  Q12 (login wrong-password flow), Q17 (dead `iterateParents`), Q18 (**walk a 60 AFN top-up** — flow),
  Q20 (StuckTransactionRecoveryJob), Q23 (retry/backoff schedule), Q24 (transaction-management vs
  transactions-service split), Q40 (thoth), Q43 (SMPP), Q44 (`/shahyetopup/**` routing), Q46–Q50
  (product entity semantics), Q52 (what `not_applicable` does), Q55 (password force-change)

### F3 — Data flow, state, invariants 🟡 (pdgs + lineage + claims exist as forms; chat-side depth varies)
- "Who reads and writes balance?" (README) · "Find every way balance can become inconsistent" (C22, contracts)
- "Why could this balance become incorrect?" (README/UC-03) · "Where can balance race?" · "Why is adjustBalance not transactional?" · "Where is it risky to change things?" (README)
- "Are there race conditions? How are they handled?" · "Is this operation idempotent? What happens on retry?" · "How does the system recover / compensate on failure?" · "How does data flow through the system / this feature?" · "What are the states of [entity] and how do they change?" (plan)
- shahy Q16 (username+password hash coupling), Q19 (RESERVE then POST — invariant rationale),
  Q21 (manual-review case), Q22 (FOR UPDATE SKIP LOCKED), Q53 (GL number concurrency)

### F4 — Near-duplicate, identity, collision (vectors + concept store) ✅ — the IR-first superpower
Tools: `similar_of`, `concept_of`, identity registry, `ir_of`.
- shahy Q32 (**two `mls.bookkeeping` packages — same code, a copy, or two implementations?**) — validated live at 88%
- shahy Q25 (is renaming `mls.service.bulkuplaod` safe), Q27 (roshan old vs new), Q34 (how many outbox
  implementations), Q45 (how would I discover there are two bookkeeping implementations), Q51 (four classes
  named `UserManagement`)
- "Where is this API used?" (F01/README) — single-repo ✅; cross-repo ❌ (F12)

### F5 — Call/dependency graphs, collaboration, guards ✅
Tools: `read_code` relations, `get_module_graph`, `get_guards`, `get_routes`, pdgs.
- "Who calls whom / show the call graph of this" · "What does this class collaborate with?" ·
  "How is dependency injection / wiring done?" (plan)
- "Who can reach adjustBalance and what stops them?" (README) — reachability + guards
- shahy Q33 (does service-gateway depend on the bookkeeping module), Q35 (compose coupling),
  Q41 (trace-master), Q42 (ClickHouse writers), Q54 (agent-hierarchy enforcement)

### F6 — Why-suspicion, provenance, epistemic honesty ✅ (claims, bands, citations)
- "why do you suspect Y?" · "why are these connected?" · "why are you showing this?" ·
  "why isn't X shown?" (README/demo; UCs) · "why are you showing this?" per-edge provenance
- "why did it forget my subject" · "why not ledger" · "how do I fix the boost logic" (plan)
- "Why wasn't X in that answer?" (F12) · "Why this and not something else?" (F11)
- shahy Q30/Q31 voice (confidence banding exemplars), Q28 (circuit breaker claim to verify)

### F7 — Config, build, deploy, environment 🟡 (`get_config` + literal routing; compose/Gradle need the source tier)
- shahy Q2 (18 modules vs dead directories), Q3 (compose images), Q5 (broker tech), Q6 (shared DB),
  Q9 (path prefixes), Q29 (mock provider implication), Q30 (is service-gateway in production),
  Q37 where secrets belong, Q39 (root `bp*.py` scripts — assume nothing)
- "Which policies are enforced and where are the gaps?" (README) — `get_config`+`get_guards`, partial
- UC-35 "Environment / Config Behavioral Diff" ❌ (future form)

### F8 — Git history, archaeology, hotspots, ownership 🟡/❌ (git-aware walk exists; hotspot/ownership maps partial or future)
- "What changed since the last index?" (README) 🟡 · "which commit introduced it" (README) ❌
- "What has been going wrong in the last 7 days?" (README) ❌ · "Why does this ugly code exist?" (UC) ❌
- "How are hotspots ranked from git history?" (JSON introspection — about CIE itself, ✅ via read_code)
- "Who owns what and where is the bus factor 1?" (README) ❌ · shahy Q36 (credentials tracked despite
  .gitignore — git-aware, 🟡), Q17 partial overlap

### F9 — Risk, blast radius, PR analysis, tests 🟡 (`change_risk`, `find_tests`, PR-analysis existence; competitive forms future)
- "What can this PR break?" · "How far does it reach?" · "What is untested?" ·
  "Why wasn't this shown?" · "Why this and not something else?" · "What does CIE not know here?" (F11)
- "Is this PR safe?" (F02/README) · "Is this dependency risky?" (F03/F04 — ❌ today) ·
  "Is this safe under concurrency?" (F14) · "does this do what the ticket asked?" (F17 ❌)
- "How well tested are our operations?" · "Which tests cover the critical paths / invariants?" ·
  "Which tests exercise this?" (README/plan/F12) — `find_tests` ✅/🟡
- "What should we refactor first?" (F06/F10) 🟡 · "Where are the performance hotspots?" (F05 ❌)

### F10 — Counterfactual / what-if (C27) ❌
- "What if we remove the ledger module?" (README/UC-21) · "What if we double arrival rate?" ·
  "What happens if we shorten this critical section?" · "What fails if this dependency disappears?" ·
  "what would change if we changed X?" (F10)

### F11 — Security, trust boundaries, privacy 🟡 (`get_guards`, privacy redaction live; UC-28 map future)
- "What are the security / trust boundaries?" (plan) · "Who can reach adjustBalance and what stops them?" 🟡
- shahy Q13 (JWT signing/secret), Q14 (claims/roles), Q15 (session validity/revocation),
  Q38 (hardcoded hosts rot) — read_code/ir_of ✅ per-element
- "How do we stop a hosted model from receiving code the user has not approved?" (JSON — introspection ✅)

### F12 — Cross-repo, forge/PR execution, MCP, tickets ❌ (competitive features)
- "Is the index current for my edits?" (F12) · "does this do what the ticket asked?" (F17) ·
  "How far does it reach?" cross-repo variants (F01/F08) · MCP context-server prompts (F12)

### F13 — Dogfood/introspection when CIE indexes itself ✅ (the 17 JSON golden questions)
"How is the quality gate policy evaluated for a pull request?" · "Where do we publish a status or comment
to GitHub for a pull request?" · "How are hotspots ranked from git history?" · "How is a program dependence
graph built for a function?" · "How are invariants inferred from guards?" · "How are test results and
coverage artifacts parsed?" · "How does the chat agent call read-only tools?" · "How is a forge webhook
verified and applied?" · "How do we stop a hosted model from receiving code the user has not approved?" ·
"Where do we decide whether a displayed statement is grounded in evidence?" · "How do we run untrusted
tests without letting them touch the rest of the disk?" · "What turns a defect report into a reviewed
patch and a draft request on the forge?" · "How does the system remember what a model called each group
of similar functions?" · "How do we find every place a symbol is used across several repositories?" ·
"Where do we turn a plain-language feature request into checkable requirements?" · "How is it decided
what is in scope for a release and whether it is ready?" · "What is reused and what is rebuilt when a
small edit is made and the build runs again?"

### F14 — Structural proposals, migrations, refactoring journeys ❌/🟡 (UC-16…UC-18, UC-23/24 forms partial)
- "What should we refactor first?" overlap · cohesion/extraction/decoupling prompts (UC-23/24)

## 3. Coverage matrix

| Family | Primary tool(s) today | Status |
|---|---|---|
| F1 overview | project_overview, module graph | ✅ |
| F2 explain/body IR | `ir_of`, `read_code` | ✅ |
| F3 data flow/invariants | pdgs, lineage, claims | 🟡 |
| F4 duplicates/identity | `similar_of`, `concept_of`, identity | ✅ |
| F5 graphs/guards | read_code relations, module graph, guards | ✅ |
| F6 why-suspicion | claims, bands, citations | ✅ |
| F7 config/build | `get_config`, literal routing | 🟡 |
| F8 git archaeology | git metrics only | 🟡/❌ |
| F9 risk/PR/tests | `change_risk`, `find_tests` | 🟡 |
| F10 counterfactual | — | ❌ |
| F11 security/privacy | `get_guards`, redaction | 🟡 |
| F12 cross-repo/forge/MCP | — | ❌ |
| F13 introspection | full toolset (dogfood) | ✅ |
| F14 refactoring journey | forms partial | ❌/🟡 |

## 4. Eval guidance (Phase 5 mapping)

- **Acceptance gate (must pass):** shahy golden set Q&A (all 55) scored per tier; F13 JSON set scored per
  tier; F2 + F4 + F6 families are the IR-first proving ground — Q32, Q45, Q51 and the JSON concept question
  exercise `similar_of`/`concept_of` directly (Q32 already verified live at 88% cross-module).
- **Banding-sensitive:** every F6 prompt and shahy Q30/Q31 — IR-only answers must sit at/below HYPOTHESIS
  and say why.
- **Source-tier escalation tests:** shahy Q2/Q3/Q5/Q9/Q13/Q15/Q22/Q23/Q29/Q36/Q37/Q39/Q42 (config/build/
  literal) — measure tier-2 artifact pull vs wrong-scope IR answers.
- **Known gaps to keep failing honestly:** F8 commit-archaeology, F10 counterfactual, F12 cross-repo/forge.
  These should produce UNRESOLVED-with-next-step, not confident prose.