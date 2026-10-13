# shahy-restructure onboarding — CIE's actual answers

Generated 2026-10-13T12:38:47.205Z. Repository indexed: `/home/arun/shahy-restructure` (revision `wt-b68e258bf9a20b71`). Model: `ollama/deepseek-v4.1-flash:cloud` via the local Ollama daemon.

This file holds only what CIE's real chat agent actually answered when asked each of the 55 questions against the real, indexed repository — including which chart/view it produced, if any. The reference answers (written by reading the actual source by hand) live separately in `questions-and-answers.md`; the two files share question numbers so they line up for comparison without either copy drifting out of sync with the other. CIE indexes Java/TypeScript/Go/Python/Rust; the ~20 Kotlin files in this repo (including the one defining MainProduct/MasterProduct/SubProduct, Q46-50) are not parsed, so CIE is structurally unable to answer those from its own index the way a human reading the file can — that gap is itself a finding, not a bug in this harness.

## Summary

- 3 question(s) run, 3 answered without a transport/service error, 3 produced a chart/view.
- Average latency: 21319 ms/question.
- Answer kinds: view=2, analysis=1.

---

## 1. What product does this codebase implement, and who are its end users?

**CIE's actual answer** (kind: `view`, 5705 ms):

Inferred from the source code:

The implemented workflows include analyze, search, process insert event, dispatch. (alerting/src/main/java/mls/alerting/engine/DynamicRCAEngine.java:35)

• An implementation entry is DynamicRCAEngine.analyze. (alerting/src/main/java/mls/alerting/engine/DynamicRCAEngine.java:35)

• An implementation entry is SDNSearchService.search. (aml-service/src/main/java/mls/aml/services/SDNSearchService.java:31)

• An implementation entry is process_insert_event, which calls TransactionRecord. (proxy-providers/app.py:94)

• An implementation entry is CustomMiddleware.dispatch. (api-gw/pi.py:41)

Inferred from sampled implementation and static calls; runtime behavior and business intent are not proven.

**Chart shown:** form GeneratedChart, 1 node(s), 0 edge(s), 2 gap(s) — "System context · Offline S27 (system context): repository boundary plus 0 possible external system(s) grounded in infrastructure/provider client imports. Users, deployment names, and runtime connections remain gaps. The offline model can only arrange statically indexed facts, so notation-specific details a hosted model could judge are left as gaps rather than invented."

**Warnings:** Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.; 322 call(s) could not be statically resolved; Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.

---

## 2. How many Gradle modules exist, and which directories look like services but aren't built?

**CIE's actual answer** (kind: `view`, 6007 ms):

Inferred from the source code:

The implemented workflows include analyze, search, process insert event, dispatch. (alerting/src/main/java/mls/alerting/engine/DynamicRCAEngine.java:35)

• An implementation entry is DynamicRCAEngine.analyze. (alerting/src/main/java/mls/alerting/engine/DynamicRCAEngine.java:35)

• An implementation entry is SDNSearchService.search. (aml-service/src/main/java/mls/aml/services/SDNSearchService.java:31)

• An implementation entry is process_insert_event, which calls TransactionRecord. (proxy-providers/app.py:94)

• An implementation entry is CustomMiddleware.dispatch. (api-gw/pi.py:41)

Inferred from sampled implementation and static calls; runtime behavior and business intent are not proven.

Proof:
- LeafAccountService.getLeafByType (account-management/src/main/java/mls/ams/LeafAccountService.java): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- AlertDetailComponent.ngOnInit (alerting/webapp/src/app/features/alerts/alert-detail/alert-detail.component.ts): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- AlertDetailComponent.getSeverityClass (alerting/webapp/src/app/features/alerts/alert-detail/alert-detail.component.ts): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- DynamicRCAEngine.analyze (alerting/src/main/java/mls/alerting/engine/DynamicRCAEngine.java): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- proxy_request (api-gw/pi.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- MiFilter.filter (api-gw/src/main/java/gw/MiFilter.java): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- CustomMiddleware.dispatch (api-gw/pi.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- IndividualKYCService.getHeaders (web/bo/src/app/user-management/user-management/user-management/bo/kyc.service.ts): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- Main (aml-controller/src/main/java/mls/aml/ctrl/Main.java): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- main (clickhouse/sync/sync_to_clickhouse.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- insert_gateway_batch_sql (clickhouse/sync/sync_to_clickhouse.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- AlertListComponent.goToPage (alerting/webapp/src/app/features/alerts/alert-list/alert-list.component.ts): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- SDNSearchService.search (aml-service/src/main/java/mls/aml/services/SDNSearchService.java): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- process_insert_event (proxy-providers/app.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- TransactionRecord (proxy-providers/app.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- CustomerService.getHeaders (web/agent/src/app/dashboard/customer/customer.service.ts): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- TopupService.getHeaders (web/agent/src/app/dashboard/customer/topup.servie.ts): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- run_interactive (scripts/db_management/db_manager.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- main (scripts/db_management/db_manager.py): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read
- Login.f (authorization-authentication/src/main/java/mls/aaa/Login.java): VERIFIED — the cited entity is indexed, its source is unchanged, and the full span was read

**Chart shown:** form GeneratedChart, 31 node(s), 1 edge(s), 2 gap(s) — "UML package diagram · Offline S17 (package diagram): 32 source package(s), 1 cross-package import dependency(ies). Package boundaries use source directories; dependencies are indexed imports. The offline model can only arrange statically indexed facts, so notation-specific details a hosted model could judge are left as gaps rather than invented."

**Warnings:** Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.; 322 call(s) could not be statically resolved; Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.

---

## 3. Which directories ship an image per `debug-prod-docker-compose.yml`, and does every built module get deployed from a compose file here?

**CIE's actual answer** (kind: `analysis`, validation: `UNRESOLVED`, 52245 ms):

Unresolved: I cannot yet support a definitive answer to this question.

Evidence inspected: file:debug-prod-docker-compose.yml; file:docker-compose.yml; file:service-gateway/docker-compose.yml; method:account-management/src/main/java/mls/ams/LeafAccountService.java#LeafAccountService.getLeafByType; function:bp-test-client.py#color; method:alerting/webapp/src/app/features/alerts/alert-detail/alert-detail.component.ts#AlertDetailComponent.ngOnInit; method:alerting/src/main/java/mls/alerting/engine/DynamicRCAEngine.java#DynamicRCAEngine.analyze; function:api-gw/pi.py#proxy_request; method:web/bo/src/app/user-management/user-management/user-management/bo/kyc.service.ts#IndividualKYCService.getHeaders; class:aml-controller/src/main/java/mls/aml/ctrl/Main.java#Main; function:clickhouse/sync/sync_to_clickhouse.py#main; method:alerting/webapp/src/app/features/alerts/alert-list/alert-list.component.ts#AlertListComponent.goToPage.

Missing evidence or answer issues:

• The reviewer's response could not be validated: "gaps" must be an array of at most 8 strings, each at most 500 characters.

Next: Continue the targeted investigation with a fresh budget.

**Chart shown:** form SemanticMap, 0 node(s), 0 edge(s), 3 gap(s) — "Nothing in this repository matches that question. Try naming a feature or module — the map stays empty rather than guessing."

**Warnings:** Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.; The answer did not pass validation; its unvalidated conclusion was withheld.

---

## 4. The root artifact is `mipay` — does that name appear anywhere else?

_not run (skipped or limit reached)._

---

## 5. Which messaging/broker technology ties the services together?

_not run (skipped or limit reached)._

---

## 6. Is there a shared single database for all services, or one per service?

_not run (skipped or limit reached)._

---

## 7. How does `api-gw` decide which backend host:port to send a request to?

_not run (skipped or limit reached)._

---

## 8. What are "ajith" and "vibin" in `GatewayConfig.java`?

_not run (skipped or limit reached)._

---

## 9. Three path prefixes the gateway routes to a service not in the active module list.

_not run (skipped or limit reached)._

---

## 10. Does the gateway log, retry, or circuit-break a failed downstream call?

_not run (skipped or limit reached)._

---

## 11. What do I touch to make a new microservice reachable through the gateway?

_not run (skipped or limit reached)._

---

## 12. What happens on `POST /aaa/backoffice/login` with a wrong password?

_not run (skipped or limit reached)._

---

## 13. How is the JWT signed, and where does the secret come from?

_not run (skipped or limit reached)._

---

## 14. What claims are inside the JWT? Is there a role/permission claim?

_not run (skipped or limit reached)._

---

## 15. How long is a session valid? Is there logout/revocation?

_not run (skipped or limit reached)._

---

## 16. Why hash `username+password` together, and what breaks if a username changes?

_not run (skipped or limit reached)._

---

## 17. The commented-out `iterateParents` — what was it for, and is it enforced now?

_not run (skipped or limit reached)._

---

## 18. Walk through a 60 AFN MTN top-up, step by step.

_not run (skipped or limit reached)._

---

## 19. Why RESERVE then POST, instead of one direct debit?

_not run (skipped or limit reached)._

---

## 20. What is `StuckTransactionRecoveryJob`? How often, and what's most dangerous?

_not run (skipped or limit reached)._

---

## 21. Why is "no gateway_log but ledger entries exist" a manual-review case, not auto-resolved?

_not run (skipped or limit reached)._

---

## 22. What does `FOR UPDATE SKIP LOCKED` do, and why does multi-instance matter?

_not run (skipped or limit reached)._

---

## 23. What's the PENDING retry/backoff schedule, and when does it stop?

_not run (skipped or limit reached)._

---

## 24. `transaction-management` vs `transactions-service` — what's the actual split?

_not run (skipped or limit reached)._

---

## 25. Is renaming `mls.service.bulkuplaod` safe? What would it touch?

_not run (skipped or limit reached)._

---

## 26. Which providers, and where does each integration live?

_not run (skipped or limit reached)._

---

## 27. `transaction-management/services/roshan` vs `service-gateway/provider/roshan` — same or two?

_not run (skipped or limit reached)._

---

## 28. Is there a circuit breaker for the `transaction-management`-direct Roshan calls?

_not run (skipped or limit reached)._

---

## 29. What does `service-gateway/provider/mock` imply?

_not run (skipped or limit reached)._

---

## 30. Is `service-gateway` actually in production today?

_not run (skipped or limit reached)._

---

## 31. Where should new provider-integration code go — old place or new?

_not run (skipped or limit reached)._

---

## 32. Two `mls.bookkeeping` packages — same code, a copy, or two implementations?

_not run (skipped or limit reached)._

---

## 33. Does `service-gateway` depend on the `bookkeeping` Gradle module?

_not run (skipped or limit reached)._

---

## 34. How many outbox implementations actually exist?

_not run (skipped or limit reached)._

---

## 35. Which of `bookkeeping` or `service-gateway` shows up in a compose file, and what does that imply?

_not run (skipped or limit reached)._

---

## 36. Is a credentials file tracked in git despite `.gitignore` listing it?

_not run (skipped or limit reached)._

---

## 37. `.env.example` and `.db_config.cnf` exist at root — where do real secrets belong?

_not run (skipped or limit reached)._

---

## 38. What happens to gateway routing when "local," "ajith," and "vibin" are all off the team?

_not run (skipped or limit reached)._

---

## 39. What should I assume about `bp*.py`/`*prod.py` scripts at repo root?

_not run (skipped or limit reached)._

---

## 40. What does `thoth` do, and why only two Java files?

_not run (skipped or limit reached)._

---

## 41. Is `trace-master` a deployed service or a shared library?

_not run (skipped or limit reached)._

---

## 42. What's ClickHouse used for, and which service writes to it?

_not run (skipped or limit reached)._

---

## 43. What does SMPP imply, and what is `smppservices` responsible for?

_not run (skipped or limit reached)._

---

## 44. Why does `/shahyetopup/**` route to `ussd-router` instead of `/ussd/**`?

_not run (skipped or limit reached)._

---

## 46. What's the actual difference between MainProduct, MasterProduct and SubProduct — which is the parent of which?

_not run (skipped or limit reached)._

---

## 47. `MainProduct.masterProductId`/`subProductId` are raw `Long`, but `productByService` is a real `@ManyToOne` — what does that cost?

_not run (skipped or limit reached)._

---

## 48. What do the `pt` and `fw` prefixes mean on `ptSubProduct`/`fwSubProduct` and the two `MainProduct` lists?

_not run (skipped or limit reached)._

---

## 49. `ProductByService.Cashback` (capital C), a `Cashback` entity, and `CashBackGlAccountNo` — how many "cashback" concepts are actually here, and could this cause a bug?

_not run (skipped or limit reached)._

---

## 50. Where do the `MainProduct`/`MasterProduct`/`SubProduct` entities actually live, and why does the file extension matter?

_not run (skipped or limit reached)._

---

## 51. Four classes are all named `UserManagement` — where, and why is that a problem?

_not run (skipped or limit reached)._

---

## 52. What does `GET /um/api/not_applicable` actually do?

_not run (skipped or limit reached)._

---

## 53. How are head/sub/leaf GL account numbers generated, and what breaks under concurrency?

_not run (skipped or limit reached)._

---

## 54. Is agent-hierarchy deactivation (Q17's dead `iterateParents`) enforced anywhere live, in user-management?

_not run (skipped or limit reached)._

---

## 55. A generated password goes through `PasswordGenerator.generatePassword(8)` — what forces it to be changed on first login?

_not run (skipped or limit reached)._

---

## 45. Which bookkeeping implementation do I change for a new ledger-entry field, and how would I discover there are two?

_not run (skipped or limit reached)._

---
