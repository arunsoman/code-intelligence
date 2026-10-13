# shahy-restructure onboarding questions — reference answers

55 questions a newly-inducted developer would genuinely ask to get up to speed on
`/home/arun/shahy-restructure` (Gradle root artifact `mipay`: a mobile-money / airtime
top-up platform for the Afghan market — MTN, AWCC, Etisalat, Roshan, Salaam are the
telecom providers it tops up). Every answer below is my own, derived by reading the
actual source, configs and docs in that repository (file paths are given so each claim
can be checked). These are deliberately pointed at the seams, duplications and dead ends
a new hire would actually trip over — not softball questions.

This file holds the questions and my reference answers only. A separate run will send
the same questions to CIE's own chat agent (pointed at this repository) and record what
it answers and what chart it shows, for comparison.

---

## A. Big picture / module map

### 1. What product does this codebase implement, and who are its end users?
A mobile-money platform (Gradle root project name `mipay`) for Afghanistan: customers
top up airtime/bundles with telecom providers (MTN, AWCC, Etisalat, Roshan, Salaam),
agents/business-partners (BP) act as cash-in/cash-out points, and a back office manages
users, KYC and roles. Evidence: `settings.gradle` (`rootProject.name = 'mipay'`),
`.agent/docs/bookkeeping-integration.md` (named providers, AFN currency, USSD channel),
`business-partners/`, `kyc/`, `back-office-role-management/`.

### 2. How many Gradle modules exist, and which directories look like services but aren't built?
`settings.gradle` actively includes 18 modules: `api-gw`, `product-management`, `dms`,
`service-provider`, `shahy-topup`, `account-management`, `back-office-role-management`,
`smppservices`, `authorization-authentication`, `notifications-engine`, `kyc`,
`user-management`, `constants`, `trace-master`, `transactions-service`,
`transaction-management`, `ussd-router`, `business-partners`, `bookkeeping`,
`service-gateway`. Commented out (present as directories, not in the build) are
`e-top-up`, `connectors`, `constants-controller`, `notifications-controller`,
`report-manager`, `ussd-gateway`, `alerting`. Each of the latter still exists as a full
directory with its own `build.gradle` and source — they were deliberately pulled out of
the build, not simply forgotten, but nothing in the repo records *why* or whether they're
superseded.

### 3. Which directories ship an image per `debug-prod-docker-compose.yml`, and does every built module get deployed from a compose file here?
`debug-prod-docker-compose.yml` runs: `api-gw`, `artemis`, `smppservices`,
`authorization-authentication`, `user-management`, `business-partners`,
`product-management`, `etopup` (image `mls/e-top-up`), `kyc`,
`back-office-role-management`, `transaction-management`, `transactions-service`,
`mypay-prod`. A near-identical `prod-docker-compose.yml`/`prod-docker-compose-fixed.yml`
pair exists at root (the "fixed" one adds memory limits and comments out `artemis` and
`smppservices` — i.e., the prod compose itself was being actively patched). None of these
three files mention `service-gateway`, `bookkeeping`, `account-management`, `constants`,
`dms`, `trace-master`, `ussd-router`, `notifications-engine`, or `web`. `service-gateway`
instead ships its *own* `service-gateway/docker-compose.yml` (its own Redis + its own
ClickHouse). So: no, not every module that's built is wired into any one compose file in
this repo — deployment of at least `service-gateway`, `bookkeeping` and several others is
either happening outside this repo's committed compose files or hasn't happened yet.

### 4. The root artifact is `mipay` — does that name appear anywhere else?
Barely. The Docker image namespace is `mls/*` (`mls` = the org, `ml-shahy` on GitHub),
the shared Docker network is `mypay-et`/`mypay-prod`, and one route is
`/shahyetopup/**`. So the product is internally called "mipay" in exactly one file
(`settings.gradle`) while everywhere else it's "mls" or "mypay" or "shahy" — three
different spellings of the same product name, none of them consistent. A new developer
searching the codebase for "mipay" to orient themselves will find almost nothing.

### 5. Which messaging/broker technology ties the services together?
ActiveMQ Artemis (`quay.io/artemiscloud/activemq-artemis-broker-kubernetes`), per
`debug-prod-docker-compose.yml`, exposed on `61616` (protocol) and `8161` (console).
`smppservices` has its own `jms` package (`com/mindlabssolutions/smppservices/jms`)
consistent with JMS-over-Artemis. There is no Kafka or RabbitMQ anywhere in the compose
files.

### 6. Is there a shared single database for all services, or one per service?
Shared: every prod compose file has exactly one database-like container named
`mypay-prod`, and all the Spring services list it as a dependency — there's no
per-service database in the committed compose topology. The `bookkeeping` module's own
isolated test stack (`docker-compose-test.yml`, container `bookkeeping-mysql-test`) is
the one exception, but that's test-only. This is the classic microservices-in-name,
shared-database-in-practice pattern, and it means a schema migration in one module can
quietly affect another that reads the same tables.

---

## B. Gateway / routing

### 7. How does `api-gw` decide which backend host:port to send a request to?
It doesn't decide dynamically — `GatewayConfig.java` hardcodes a `baseUrl` constant
picked from three named IP literals (`local = "http://10.0.1.6"`,
`ajith = "http://192.168.0.195"`, `vibin = "http://192.168.0.141"`), with
`baseUrl = local` fixed in source, and then hardcodes a port per route (e.g.
`.uri(baseUrl + ":2225")` for `/bp/**`). There's no Eureka/Consul/DNS-based service
discovery, and no environment variable or Spring profile controls which of the three IPs
is used — switching environments means editing and recompiling this file.

### 8. What are "ajith" and "vibin" in `GatewayConfig.java`?
They're what they look like: two developers' LAN IP addresses, kept as named constants
alongside `local`, with comments-by-naming rather than comments-by-text. Only `local` is
ever assigned to `baseUrl` in the committed code, so `ajith`/`vibin` currently do
nothing except document "this is what someone's machine's IP used to be," and a new
developer should not assume switching to them does anything useful without first
checking whether those machines are even reachable or still exist.

### 9. Three path prefixes the gateway routes to a service not in the active module list.
`/dcms/**` → port 4332 (`dcms-controller`, not in `settings.gradle`), `/sm/**` → port
8089 (`supplier-management`, not in `settings.gradle`), `/report/**` → port 7002
(`report-manager`, commented out in `settings.gradle`). `/alerts/**` → 8091 is a fourth
(`alerting`, also commented out). A new developer should conclude these routes are either
stale leftovers from before those modules were pulled from the build, or those services
are built and run from somewhere this repo doesn't show (a fork, a separate deploy
pipeline) — either way, hitting those paths against whatever `baseUrl` currently points
to is likely to fail silently or hang, not return a clean 404, and that ambiguity itself
is worth raising with whoever owns the gateway.

### 10. Does the gateway log, retry, or circuit-break a failed downstream call?
`GatewayConfig.java` registers no retry filter, no circuit breaker, and the only
resilience-adjacent code is `preserveHostHeader()` on the `/bp/**` route. The
`@PostConstruct listGlobalFilters()` method logs which `GlobalFilter` beans exist at
startup (a debug print, `System.out.println`, not a real log framework call) but that's
diagnostic, not protective. Compare this to `service-gateway/provider/circuitbreaker`,
which is a real resilience layer — but it protects calls *out* to telecom providers, not
calls routed *through* `api-gw` to internal services. The gateway itself has no
protection against a downstream service being slow or down.

### 11. What do I touch to make a new microservice reachable through the gateway?
Minimum: (a) add `include 'your-service'` to `settings.gradle` if it's a new Gradle
module; (b) add a `.route("your_route", r -> r.path("/yourprefix/**").uri(baseUrl +
":PORT"))` block to `GatewayConfig.customRouteLocator`; (c) pick a port that doesn't
collide with the ~20 already hardcoded in that same method (nothing enforces
uniqueness — you'd have to read the whole file). There's no route registry, no
auto-discovery, and no test that asserts gateway routes match live services, so a
colliding or dangling route would only be caught by someone noticing in production.

---

## C. Auth

### 12. What happens on `POST /aaa/backoffice/login` with a wrong password?
`Login.java`'s `getLoginResponse` returns `new LoginResponse(ResponseCode.FAILED,
"Invalid password!", null)`, and the controller (`f()`) wraps that in
`ResponseEntity.ok().body(loginResponse)` — i.e. **HTTP 200**, with the failure encoded
only in a `responseCode` field inside the JSON body. A client that checks the HTTP status
instead of parsing the body will think login succeeded.

### 13. How is the JWT signed, and where does the secret come from?
HS256, via `Keys.hmacShaKeyFor(secretKey.getBytes())` where `secretKey` is injected
from the Spring property `jwt.secret` (`@Value("${jwt.secret}")`) — a plain shared
symmetric secret, not a keypair, read from whatever `application.properties`/environment
supplies it at runtime (not committed in the file I read; worth confirming where that
property is actually set per environment before assuming it's safely externalized).

### 14. What claims are inside the JWT? Is there a role/permission claim?
`language`, `userId` (stringified), and `userType` (the enum name, or — if the user is a
`MiPayAgent` whose `getUserType()` throws — the agent's `getAgentType()` name instead).
Subject (`sub`) is the user id again. There is no explicit permissions/scopes/roles-list
claim beyond this single `userType`/`agentType` string, so any fine-grained authorization
downstream has to re-derive permissions from that one string rather than reading them
off the token.

### 15. How long is a session valid? Is there logout/revocation?
Fixed 24 hours (`System.currentTimeMillis() + 86400000`), no refresh-token flow, and
`Login.java` — the only file with `/aaa` mappings I found — has no logout or
token-revocation endpoint. A JWT issued here is valid for a full day no matter what
happens to the account afterward (deactivation checks only run at *login* time, via
`findByUsernameAndUserTypeAndActiveTrueAndDeletedFalse`), unless revocation is enforced
somewhere else downstream that I haven't located.

### 16. Why hash `username+password` together, and what breaks if a username changes?
Folding the username into the material that gets BCrypt-hashed (`loginRequest.username()
+ loginRequest.password()`) is presumably meant to make two users with the same password
get different hashes without a separate per-user salt column (BCrypt already salts
internally, so this is redundant for that purpose) — but it has a real consequence: if a
username is ever changed, the stored hash was computed against the *old* username, so a
correct password will stop verifying unless the password is also re-hashed at rename
time. Whether that re-hash happens is something I'd need to check in whatever handles
username changes (I didn't find such a path in this module) — a new developer should
test it before assuming usernames are safely renameable.

### 17. The commented-out `iterateParents` — what was it for, and is it enforced now?
It was meant to walk an agent's parent chain (`MiPayAgent.getParent()`) and refuse login
if any ancestor agent is inactive/deleted — i.e. deactivating a parent agent should lock
out its sub-agents. As written it's also broken: the loop's final `return` evaluates
`current == null && current.isActive()`, which would NPE the moment `current` actually
becomes null (short-circuit `&&` saves it only because Java evaluates left-to-right, so
it never gets there — the method always returns `true` from inside the loop or falls
through to the trailing `return true`, meaning the check never actually blocks anyone).
It's entirely commented out in every call site (`f`, `fAll`, `fC`), so today **nothing**
enforces "a deactivated parent agent locks out its children" — that's worth confirming
is intentionally deferred rather than an accidental regression.

---

## D. Transaction / ledger core

### 18. Walk through a 60 AFN MTN top-up, step by step.
Per `.agent/docs/bookkeeping-integration.md`: (1) RESERVE a customer-payment ledger
entry, customer wallet → collection account, 60 AFN, status `RESERVED`/not committed;
(2) call the MTN provider to perform the actual top-up; (3) on provider success
(response includes a provider transaction id), POST (commit) that reserved entry —
customer wallet −60, collection account +60; (4) separately RESERVE-and-POST an
inventory-movement entry, `MASTER_INVENTORY` → `MTN_TOPUP_INVENTORY`, same 60 AFN, so
airtime stock depletion is tracked independently of the money movement. Two ledger
entries, not one, for what looks like a single customer action.

### 19. Why RESERVE then POST, instead of one direct debit?
Because the provider call sits *between* the two steps and can fail, time out, or hang
indefinitely. Reserving first lets the system hold the funds (so they can't be
double-spent) without committing them until the provider has actually confirmed success;
a provider failure lets the reservation simply be rolled back with nothing ever having
been posted to the ledger. A single direct debit would have no safe undo if the provider
call failed after the debit but the top-up never landed.

### 20. What is `StuckTransactionRecoveryJob`? How often, and what's most dangerous?
A `@Scheduled(fixedDelay = 300000)` job (every 5 minutes) that finds transactions stuck in
`PENDING` past their timeout (and under 5 retries), and resolves each by checking the
paired `gate_way_log.status`. The most dangerous state it names explicitly is a
**CRITICAL ANOMALY**: `gateway_log` has no row at all, yet ledger entries already exist
for that transaction — money/inventory was moved with no record of what the provider
actually said, and the job deliberately refuses to auto-resolve that case.

### 21. Why is "no gateway_log but ledger entries exist" a manual-review case, not auto-resolved?
Because every *other* branch has a safe, mechanically-derivable action (no log + no
ledger ⇒ safe to auto-rollback; log says SUCCESS ⇒ repair state or re-queue posting; log
says FAILED ⇒ rollback), but this one combination means the system has no record of
*why* money moved — it can't tell whether the provider actually succeeded (in which case
rolling back would create a real loss, since the ledger says it already happened) or
whether this is corruption/a race (in which case leaving it is wrong too). There's no
automatic rule that's safe in both cases, so it's deliberately left for a human with
access to provider-side records.

### 22. What does `FOR UPDATE SKIP LOCKED` do, and why does multi-instance matter?
It locks the rows the query selects for update, but skips any row another transaction
already has locked instead of blocking on it. That means if more than one instance (pod,
process) of this scheduled job is running at once — which is realistic for a
horizontally-scaled Spring service — they can each grab a disjoint batch of up to 100
stuck transactions and process them concurrently without double-processing the same
transaction or deadlocking against each other. Without it, two instances racing on the
same `LIMIT 100` query could both pick up the same rows.

### 23. What's the PENDING retry/backoff schedule, and when does it stop?
Exponential: wait `5 minutes × 2^retry_count` before the next attempt (retry 1: 5 min,
retry 2: 10 min, retry 3: 20 min, and so on per the doc's table), incrementing
`retry_count` and pushing `timeout_at` forward each time. The recovery query's own
`WHERE ... retry_count < 5` means after 5 retries a transaction simply stops being picked
up by this job at all — it's not escalated or flagged anywhere else in the doc I read, it
just falls out of the automatic recovery loop.

### 24. `transaction-management` vs `transactions-service` — what's the actual split?
By package layout: `transaction-management` (`mls/tms`) owns the core domain — ledger
(`mls/tms/ledger`), bookkeeping adapters (`mls/tms/bookkeeping`), provider-specific logic
(`mls/tms/services/roshan`), requests/responses — i.e. the orchestration and ledger
engine itself. `transactions-service` (`mls/service`) is much smaller and narrower:
bulk upload (`mls/service/bulkuplaod`) and scheduled jobs (`mls/service/schedular`) — it
reads like a batch/reporting satellite around the core engine, not a peer with equal
scope. The names strongly suggest two services that should probably be one, or that one
was carved out of the other and never renamed to reflect its narrower job.

### 25. Is renaming `mls.service.bulkuplaod` safe? What would it touch?
Not casually: it's a Java package name, so renaming it means moving every file under
that package, updating every `import mls.service.bulkuplaod....` in `transactions-service`
(and any other module that depends on this one and imports from it directly), and
re-checking anything that constructs class names reflectively or by string (Spring
component scanning by base-package annotation, config property keys, log category
filters keyed on package name). It's mechanically doable with an IDE "rename package"
refactor, but given this repo has no visible shared-package consumers outside
`transactions-service` itself (from the directory listing I checked), the real risk is
just making sure nothing scans `mls.service.bulkuplaod` as a literal string somewhere
(a `@ComponentScan` base package, a log4j/logback logger-name filter, CI grep scripts) —
that needs a repo-wide search before touching it, not an assumption that it's isolated.

---

## E. Provider integration & the in-progress restructure

### 26. Which providers, and where does each integration live?
MTN, AWCC, Etisalat, Roshan, Salaam (named across the bookkeeping doc and provider
packages). The newer, consolidated location is
`service-gateway/src/main/java/mls/gateway/provider/{awcc,etisalat,mtn,roshan,salaam}`,
each presumably implementing a shared `provider/core` port. Older, narrower integration
code also exists directly inside `transaction-management` (`mls/tms/services/roshan`),
which only names Roshan, not the other four — suggesting Roshan was the first provider
built directly into the transaction engine before the newer `service-gateway` provider
layer existed.

### 27. `transaction-management/services/roshan` vs `service-gateway/provider/roshan` — same or two?
Two: same provider (Roshan), two different code locations, in two different Gradle
modules, with no dependency from one to the other (`service-gateway/build.gradle` lists
no `project(':transaction-management')` dependency). The honest reading is that
`service-gateway/provider/*` is a newer, generalized replacement being built to host
*all five* providers behind a common port/adapter interface (with a circuit breaker and
a mock provider for testing — see Q28/Q29), while `transaction-management`'s
Roshan-specific package is the older, single-provider implementation it's meant to
eventually replace. Nothing in the repo marks the old one deprecated, though.

### 28. Is there a circuit breaker for the `transaction-management`-direct Roshan calls?
`service-gateway/provider/circuitbreaker` is a real resilience layer guarding the new
provider adapters. I found no equivalent package or annotation inside
`transaction-management/services/roshan` — the old, in-module Roshan integration calls
the provider directly with whatever retry/timeout handling (if any) lives in that
package alone, not the shared circuit-breaker. A new developer debugging a Roshan outage
needs to know *which* of the two Roshan code paths is actually live in prod before
assuming the circuit breaker is protecting them.

### 29. What does `service-gateway/provider/mock` imply?
That `service-gateway` was designed from the start to be testable/demoable without
hitting real telecom providers — a mock implementation of the same provider port the
real `mtn`/`awcc`/etc. adapters implement, so integration tests (and the
`MOCK_PROVIDERS_README.md`/`MOCK_PROVIDERS_ENHANCED_README.md` docs sitting in that same
module) can exercise the whole reserve→call→post flow deterministically. This is a
meaningfully more mature testing posture than anything visible in
`transaction-management`'s Roshan package.

### 30. Is `service-gateway` actually in production today?
Evidence against: it appears in none of `docker-compose.yml`, `debug-prod-docker-compose.yml`,
`prod-docker-compose.yml`, or `prod-docker-compose-fixed.yml` — the only compose file
that runs it is its own `service-gateway/docker-compose.yml`, which stands up its own
Redis and its own ClickHouse (`shahy_analytics` DB) independent of the root
`docker-compose-infrastructure.yml` stack. Evidence it might be live anyway: it has 167
Java files, full provider adapters, circuit breakers, an outbox, and bookkeeping
logic — too much investment to read as a throwaway prototype. My honest answer: based on
static inspection alone, I can't be fully confident either way — the compose topology
says "not part of the main deploy," but that's also exactly what you'd expect mid-migration,
before the cutover compose file is updated. This is a "go ask the person who deploys it"
question, not one static analysis alone settles.

### 31. Where should new provider-integration code go — old place or new?
`service-gateway/provider/*`, not `transaction-management/services/roshan`. It has the
shared port/adapter structure, the circuit breaker, and the mock provider the old
location lacks — adding a sixth provider (or more logic for an existing one) to the old
single-provider package would be building on the part of the codebase that looks like
it's being phased out, duplicating structure the new module already generalizes. This
should still be confirmed with whoever is driving the restructure, since Q30 shows the
new module's production status isn't settled from the code alone.

---

## F. Bookkeeping duplication

### 32. Two `mls.bookkeeping` packages — same code, a copy, or two implementations?
Two independent implementations, not a copy-paste duplicate. The standalone
`bookkeeping` module's internal layout is `application/port`, `domain/{model,value,factory}`,
`infrastructure/persistence`, `outbox`, `service/{impl,logic,messaging,outbox,redis}`,
`job`, `monitoring`. `service-gateway`'s internal `mls.bookkeeping` layout is
`core/{model,port/out,repository,service/impl}`, `domain/{model,value}`,
`infra/{outbox,persistence,redis}`, `features/topup/utils`. The directory names rhyme
(both are hexagonal/ports-and-adapters attempts at the same ledger concept) but the
actual package trees, class organization and even the top-level folder names
(`application` vs `core`/`features`) differ enough that this reads as two separate
people/sessions independently re-deriving a similar architecture for the same problem,
not one copying the other file-for-file.

### 33. Does `service-gateway` depend on the `bookkeeping` Gradle module?
No. `service-gateway/build.gradle` has no `project(':bookkeeping')` dependency — in fact
it has a *commented-out* `project(':ledger-engine')` line, naming a module that doesn't
even exist as a directory in this repo. So `service-gateway` compiles its own
self-contained bookkeeping logic rather than reusing the standalone module, and at some
point someone expected (or planned) a third name, `ledger-engine`, for whichever one was
meant to become canonical.

### 34. How many outbox implementations actually exist?
At least three directories: `bookkeeping/src/main/java/mls/bookkeeping/outbox`,
`service-gateway/src/main/java/mls/outbox` (a top-level one, with its own
`core/processor` and `infra/persistence`), and
`service-gateway/src/main/java/mls/bookkeeping/infra/outbox` (nested inside
`service-gateway`'s own bookkeeping package). That's two separate outbox
implementations inside `service-gateway` alone, plus the standalone module's. A new
developer needing outbox/transactional-messaging semantics anywhere else in this
codebase should not write a fourth — they should find out first which of these three is
considered correct (or whether any is), because right now the repository doesn't say.

### 35. Which of `bookkeeping` or `service-gateway` shows up in a compose file, and what does that imply?
Neither appears in the root prod compose files (`prod-docker-compose(-fixed).yml`,
`debug-prod-docker-compose.yml`); `bookkeeping` only has a test-only compose
(`docker-compose-test.yml`, MySQL+Redis on non-default ports to avoid local conflicts);
`service-gateway` has its own standalone compose. Taken together, neither looks
confidently "live" from the committed deploy configs — the actual production ledger
path, whatever it is right now, is most plausibly still the code embedded in
`transaction-management` (which *is* in every prod compose file), with both
`bookkeeping` and `service-gateway` reading as parallel rewrites-in-progress that
haven't been cut over yet. That reading should be confirmed with whoever owns deploys,
not taken as settled from compose files alone.

---

## G. Security / config hygiene

### 36. Is a credentials file tracked in git despite `.gitignore` listing it?
Yes. `git ls-files` shows `.creds` is tracked (added in an early commit, message "test
clients toys", alongside throwaway test scripts), and `.gitignore` *does* list `.creds` —
but adding a path to `.gitignore` only stops *future* changes to an already-tracked file
from being ignored; it does nothing to the file already in the index or to its full
history. The practical consequence: anyone who has ever cloned this repo, or who clones
it today, still gets `.creds` and its entire commit history unless it's explicitly
removed from history (e.g. `git filter-repo`) and any secret inside it is rotated — the
`.gitignore` entry alone gives a false sense that it's been handled.

### 37. `.env.example` and `.db_config.cnf` exist at root — where do real secrets belong?
Based on what's actually committed: `.env.example` is clearly meant as a template (the
`.example` suffix, and `.env`/`.env.*.local` are correctly gitignored), so real env
values belong in an untracked `.env`. `.db_config.cnf`, however, is *not* in the
`.gitignore` list I found, and its name gives no "example" signal — a new developer
should treat any file at this root that isn't explicitly gitignored as something that
could already be, or could accidentally become, committed with real values, and verify
each one individually rather than trusting the naming convention to protect them (as
`.creds` already demonstrates it doesn't, reliably).

### 38. What happens to gateway routing when "local," "ajith," and "vibin" are all off the team?
Nothing breaks automatically — `baseUrl = local` is still a valid IP literal that will
keep compiling and running exactly as before, pointing at whatever machine
`10.0.1.6` happens to be. The real risk is silent: if that machine is repurposed,
decommissioned, or re-IP'd, the gateway starts failing with no compiler error, no
missing-config error, and no indication in the code that this constant was ever meant to
be environment-specific — just connection failures with no obvious cause to someone who
doesn't already know this file's history. This is purely a knowledge-loss risk, not a
functional one, until the day it is one.

### 39. What should I assume about `bp*.py`/`*prod.py` scripts at repo root?
Treat them as ad hoc, personally-authored test/ops tooling, not part of any service's
build or deploy — `bpprod.py`, `bp2335.py`, `bp3225.py`, `bp-test-client.py` sit beside
`.creds` (added in the same "test clients toys" commit) and aren't referenced from any
`build.gradle`, CI workflow, or Dockerfile I found. A new developer should neither run
them against anything real without reading them first (one is literally named `prod`),
nor assume they're maintained or safe defaults — they look like one person's working
scratch scripts that got committed rather than gitignored, same pattern as `.creds`.

---

## H. Observability & peripheral services

### 40. What does `thoth` do, and why only two Java files?
It's a minimal translation/i18n lookup service: `Application.java` exposes
`GET /translate?key&lang` and `POST /saveTranslation?key&lang&translation`, both backed
directly by a `RedisTemplate` keyed `"<key>:<lang>"` — `RedisConfig.java` is the only
other file, wiring that template. It's small because its job is small: a key-value
translation cache with two HTTP verbs, nothing else. It is also not listed in any
compose file I found, so — like `bookkeeping` and `service-gateway` — its actual
deployment status isn't settled by what's committed here.

### 41. Is `trace-master` a deployed service or a shared library?
A shared library, not a deployable: its four source files (`BeanConfig`,
`DataSourceConfig`, `AopLogger`, `RepositoryMetricsAspect`) contain AOP aspects and bean
wiring, no `@SpringBootApplication`/`main()` entry point, and it's never listed as an
`image:` in any compose file. Eleven other modules (`account-management`,
`aml-controller`, `authorization-authentication`, `back-office-role-management`, `kyc`,
`notifications-controller`, `product-management`, `service-provider`,
`transaction-management`, `transactions-service`, `user-management`) declare it as a
`build.gradle` dependency, consistent with it being the shared cross-cutting
logging/metrics aspect every service's own build pulls in rather than something you run
on its own.

### 42. What's ClickHouse used for, and which service writes to it?
The root `docker-compose-infrastructure.yml` stack (ClickHouse + Grafana + a
`sync-scheduler`) looks like a general analytics/dashboarding pair, with Grafana
provisioned against it (`grafana/provisioning/datasources/clickhouse.yml`). The service
I could concretely tie to writing ClickHouse data is `service-gateway`: its own compose
file stands up a *separate* ClickHouse instance (database `shahy_analytics`), and
`mls/gateway/observability/TransactionObservabilityService.java` plus
`mls/gateway/service/integration/GatewayLogIntegration.java` are the classes that
reference ClickHouse directly — i.e. `service-gateway` logs transaction/gateway
observability data to its own ClickHouse, which may or may not be the same physical
instance the root infra compose stands up (the two aren't wired together in any compose
file I found, so by default they'd be two separate ClickHouse databases unless deployment
config outside this repo points them at the same host).

### 43. What does SMPP imply, and what is `smppservices` responsible for?
SMPP (Short Message Peer-to-Peer) is the standard protocol telecom networks use to
exchange SMS traffic with an external system (an SMSC bind). `smppservices`
(`com/mindlabssolutions/smppservices`, note: a different root package than everything
else in the repo, which uses `mls.*`) owns sending/receiving SMS — most plausibly OTPs,
transaction notifications, and USSD-adjacent messaging — via `jms` (consistent with the
Artemis broker) and its own `schedulers`/`repository` packages. It's also one of the
services the "fixed" prod compose variant comments out, so its current prod-deployment
status is, again, not settled from the compose files alone.

### 44. Why does `/shahyetopup/**` route to `ussd-router` instead of `/ussd/**`?
Literally, because `GatewayConfig.java`'s `ussd_route` is defined with
`.path("/shahyetopup/**")`, not a USSD-named prefix — a naming mismatch between the
route's variable name (`ussd_route`) and its actual path, and between the
directory name (`ussd-router`) and the path it answers to. This is exactly the kind of
inconsistency that makes a new developer grep for "ussd" in client code, find nothing,
and waste time before realizing the real entry path is `/shahyetopup`. Functionally,
`ussd-router`'s own code (`USSDProxyFilter`, `BloomFilterService`, `UserRouting`) does
look like USSD session routing/proxying, backed by a Bloom filter (likely for a fast
"have we seen this subscriber/session" membership check) and a `UserRoutingRepository` —
so the *service* is correctly named, only the gateway's path prefix for it is not.

---

## J. Product management

### 46. What's the actual difference between MainProduct, MasterProduct and SubProduct — which is the parent of which?
The entities (`dms/src/main/java/mls/dms/product/productEntities.kt`) don't form one
clean tree. `SubProduct` is the base catalog concept (a `subProdType`, and a list of
`ProductByService` combos). `MasterProduct` is the agent/customer-facing product: it
holds `productName`, a `userType` it's scoped to, an `agentCommission`, and *two*
separate links down to `SubProduct` (`ptSubProduct`, `fwSubProduct`) plus *two* separate
lists of `MainProduct` (`ptAgentMainProductList`, `fwAgentMainProductList`). `MainProduct`
in turn carries its own `masterProductId` and `subProductId` — so a `MasterProduct`
points down to `MainProduct`s via a `@OneToMany`, while a `MainProduct` points back up to
its `MasterProduct` and `SubProduct` via plain numeric ids, not the inverse side of that
same relation. It's a real hierarchy (`SubProduct` → `MasterProduct` → `MainProduct`,
roughly), but it's modeled with two different relationship styles depending on which
direction you're looking from.

### 47. `MainProduct.masterProductId`/`subProductId` are raw `Long`, but `productByService` is a real `@ManyToOne` — what does that cost?
The `@ManyToOne` relation (`productByService`) gets a Hibernate-managed foreign key:
you can't persist a `MainProduct` pointing at a non-existent `ProductByService` (the DB
constraint and/or Hibernate will reject it), and loading a `MainProduct` can fetch its
`ProductByService` directly. The two `Long` id fields get none of that — nothing stops
inserting a `MainProduct` with a `masterProductId` that doesn't exist, there's no
cascade, and resolving "which `MasterProduct` is this?" requires a separate manual
lookup (`masterProductRepo.findById(mainProduct.getMasterProductId())`) wherever that's
needed, written out by hand each time rather than once by JPA. A new developer touching
this entity should not assume `masterProductId`/`subProductId` are guaranteed to resolve
to a real row the way `productByService` is.

### 48. What do the `pt` and `fw` prefixes mean on `ptSubProduct`/`fwSubProduct` and the two `MainProduct` lists?
Nothing in `productEntities.kt`, the services, or the controllers I read spells this
out — there's no comment, no enum, no doc. Given the domain (agents, business
partners, commissions), the most plausible reading is something like "point-to-point"
vs "franchise/wholesale" distribution channels, but that's an inference, not something
the code states. This is exactly the kind of two-letter abbreviation a new developer
needs to ask a specific person about rather than guess at from the code alone — getting
it wrong when wiring a new product type into the wrong one of the two parallel lists
would be an easy, quiet mistake.

### 49. `ProductByService.Cashback` (capital C), a `Cashback` entity, and `CashBackGlAccountNo` — how many "cashback" concepts are actually here, and could this cause a bug?
Three distinct things sharing almost the same name, in one 90-line file: (1) a top-level
`Cashback` **entity class** (its own table, with `type`, `amount`, `name`); (2) a field on
`ProductByService` named `Cashback` (capital C — breaking normal camelCase field-naming,
and colliding visually with the class name) that is typed `FeesOrCommission?`, **not**
the `Cashback` entity — so a field called `Cashback` does not actually reference the
`Cashback` class; and (3) a `CashBackGlAccountNo` string field (yet a third casing:
`CashBack` with an internal capital B, vs `Cashback` with none). Lombok's `@Getter`/`@Setter`
on the capital-`Cashback` field will generate `getCashback()`/`setCashback()` — which
collides at the call-site reading level with "the Cashback entity," even though they're
unrelated types. This is a strong candidate for a real "which cashback did you mean"
mistake the next time someone edits this file, and it's worth raising as a cleanup
rather than copying the pattern forward.

### 50. Where do the `MainProduct`/`MasterProduct`/`SubProduct` entities actually live, and why does the file extension matter?
They're all defined in one file, `dms/src/main/java/mls/dms/product/productEntities.kt`
— a **Kotlin** file, inside a module (`dms`) whose directory is otherwise entirely
`.java`, and inside a *monorepo* that is overwhelmingly Java Spring Boot. This only
compiles because the root `settings.gradle` pins the Kotlin Gradle plugin
(`org.jetbrains.kotlin.jvm`) for the whole build — so Kotlin interop is a deliberate,
working capability here, not an accident, but it means a new developer who searches the
codebase by filename pattern `*.java` for these classes will find nothing, and anyone
editing this file needs to know Kotlin's JPA-entity quirks (e.g. `lateinit var` for
non-null relations, nullable `var id: Long? = null` instead of a primitive `long`) are
mixed in with ordinary Lombok-annotated-style Java entities elsewhere in the same
module.

---

## K. User management

### 51. Four classes are all named `UserManagement` — where, and why is that a problem?
`mls.um.agent.UserManagement`, `mls.um.bo.UserManagement`, `mls.um.corporate.UserManagement`,
and `mls.um.customer.UserManagement` — four REST controllers, one per user type, all
sharing the exact same simple class name, disambiguated only by package. In an IDE,
"go to class" / "open by name" for `UserManagement` returns four unrelated results with
no way to tell them apart from the name alone; a stack trace, a log line, or a search
result that just prints the simple class name (`UserManagement.someMethod`) is
ambiguous without also reading the package. Renaming them to `AgentUserManagement`,
`BoUserManagement`, etc. would be a pure, low-risk clarity win — the one thing worth
checking first is whether anything (a log-filter config, a metrics tag, an AOP pointcut
in `trace-master`) matches on the bare class name rather than the fully-qualified one.

### 52. What does `GET /um/api/not_applicable` actually do?
It's a real, live endpoint (`UtilsController`, bare `@GetMapping` with no sub-path), and
its handler calls `repo.save(service.backOfficeBuilder())` — i.e. **every GET request to
this URL writes a new row** (via `BigBangService.backOfficeBuilder()`) before returning
the full list of back-office users. That's a correctness problem independent of what
`not_applicable` was ever meant to mean: GETs are supposed to be safe/idempotent, so
this endpoint can be triggered by a browser prefetch, a monitoring probe, a proxy that
retries GETs automatically, or simply being link-followed, and each hit potentially adds
another back-office row (whether `backOfficeBuilder()` happens to be idempotent under
the hood is the one thing that would need checking before calling this "merely bad
style" rather than "a live data-integrity bug"). This is the single highest-severity,
most concretely verifiable finding in this whole review — it's worth confirming with
the team whether this route is still reachable in any deployed environment.

### 53. How are head/sub/leaf GL account numbers generated, and what breaks under concurrency?
`AccountNumberGeneratorUm` (three methods: `generateHead`, `generateSubAcc`,
`generateLeaf`) all follow the same shape: read the current highest existing number for
the relevant scope (`findFirstBy...OrderByIdDesc`), parse out its numeric sequence,
add 1, and format the result as the next account number. None of the three methods shown
here takes a lock or is wrapped in a visible `@Transactional` with a conflict-retry —
so two concurrent account-creation requests can both read the same "current max,"
both compute the same "next" number, and both attempt to use it. Whether that becomes a
visible bug depends entirely on whether the database has a `UNIQUE` constraint on
`accountNo` that would reject the second insert (forcing a retry somewhere upstream) —
if it doesn't, two different accounts could silently end up with the same GL code. A new
developer adding any bulk-account-creation feature (e.g. the `bulkuplaod` job in
`transactions-service`, Q25) should check this before assuming numbers are
collision-free under load.

### 54. Is agent-hierarchy deactivation (Q17's dead `iterateParents`) enforced anywhere live, in user-management?
Partially, and not at login. `AgentService.java` and both `agent/UserManagement.java`
and `bo/UserManagement.java` do reference `getParent`/`parentId`-shaped logic — so
parent/child agent relationships are real and are used somewhere in user-management
(most plausibly when creating, tethering or administratively deactivating an agent:
`CommonServices.tether(parent, subAgent)` appears right next to a password-generation
call in Q55's evidence). But that's a different moment from *login*: the only place I
found that checks an account's own `active`/`deleted` flags at authentication time is
`authorization-authentication`'s `Login.java`, and its one hierarchy-walking check
(`iterateParents`, Q17) is commented out everywhere. So: deactivating a parent agent
through user-management may well mark that parent (and, if `tether`/cascading logic
reaches it, its children) inactive in the data — but nothing in the code I read confirms
a deactivated *parent's* status is re-checked when a *child* agent logs in. That gap is
worth confirming directly with whoever owns the agent hierarchy, rather than assuming
either "it's handled" or "it's broken" from this alone.

### 55. A generated password goes through `PasswordGenerator.generatePassword(8)` — what forces it to be changed on first login?
As far as the code I read shows: nothing, currently. `agent/UserManagement.java` calls
`PasswordGenerator.generatePassword(8)` inline at 10+ separate call sites (itself a
duplication smell — the same three-line pattern repeated rather than extracted into one
helper) and immediately encodes it with the same `username + password` BCrypt scheme
Q16 describes — consistent with `Login.java`, at least. `Login.java` does read
`baseUer.getPwdUpdatedOn()` and branch on it, but **both** branches of that `if`
currently return the exact same `ResponseCode.SUCCESS` — the one response code that
would have signaled "please set a new password" (`PWD_NOT_SET`) only exists in a fully
commented-out duplicate of `getLoginResponse` lower in the same file. So today, a newly
generated 8-character password works indefinitely with no forced rotation, unless
something outside the files I read (a frontend check, a separate policy flag) fills that
gap — a new developer should not assume "password was system-generated" implies
"user will be prompted to change it."

---

## L. Onboarding meta

### 45. Which bookkeeping implementation do I change for a new ledger-entry field, and how would I discover there are two?
There's no authoritative answer available from the code alone (see Q30/Q35) — the
honest first step is to ask whoever owns deploys which of `transaction-management`'s
embedded ledger (`mls/tms/ledger`, the one actually present in every prod compose file),
the standalone `bookkeeping` module, or `service-gateway`'s internal `mls.bookkeeping`
is the one real traffic currently posts through, and change only that one (duplicating
the field into the others only if they're genuinely both live, which isn't established
here). As for discovery: nothing in this repo flags the duplication explicitly — a new
developer would only find it by doing what this document did, searching for the
`bookkeeping`/`ledger`/`outbox` package names across *all* modules instead of stopping
at the first one found, and diffing the directory structures against each other. That
this isn't written down anywhere is itself the finding worth raising with the team.

---

*Reference answers compiled by direct inspection of `/home/arun/shahy-restructure`
(commit `7c0204c0` at the time of writing). Where a claim depends on deployment behavior
outside this repo's committed files (service liveness, which ClickHouse instance is
actually written to in production, whether `.creds` ever held a real secret), that
uncertainty is stated rather than guessed past.*
