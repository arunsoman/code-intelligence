# Pluggable Framework Extraction Plan

## Goal

Make framework-specific metadata extraction a first-class, pluggable extension inside CIE, just like the existing Nirdosha source-IR adapter. Any framework — Spring Boot, NestJS, Express, Fastify, Next.js, Flask, Django, etc. — should be addable as a small, isolated plugin that produces the same `Entity` / `Fact` / `Relationship` / `EvidenceRef` rows the rest of the system already consumes.

## Status

**Phase 0, Phase 1, Phase 2, Phase 3, Phase 4, and Phase 5 are implemented end-to-end.**

- Framework plugin trait and registry: `crates/worker/src/frameworks/mod.rs`
- Spring Boot plugin: `crates/worker/src/frameworks/spring.rs`
- Spring Cloud Gateway plugin: `crates/worker/src/frameworks/java_gateway.rs`
- NestJS plugin: `crates/worker/src/frameworks/nestjs.rs`
- Express plugin: `crates/worker/src/frameworks/express.rs`
- Next.js plugin: `crates/worker/src/frameworks/nextjs.rs`
- Config resolver plugin: `crates/worker/src/frameworks/config.rs`
- Framework metadata → semantic model resolver: `crates/worker/src/index.rs` (`resolve_framework_metadata`)
- TypeScript consumers: `packages/core/src/forms/journey.ts`, `packages/core/src/forms/analysis.ts`
- Test fixtures: `fixtures/spring-repo/`, `fixtures/nestjs-repo/`, `fixtures/express-repo/`, `fixtures/nextjs-repo/`
- Rust worker tests: `crates/worker/src/index.rs::spring_tests`, `crates/worker/src/index.rs::nestjs_tests`, `crates/worker/src/index.rs::express_tests`, `crates/worker/src/index.rs::nextjs_tests`, `crates/worker/src/frameworks/spring.rs::tests`, `crates/worker/src/frameworks/java_gateway.rs::tests`, `crates/worker/src/frameworks/nestjs.rs::tests`, `crates/worker/src/frameworks/express.rs::tests`, `crates/worker/src/frameworks/nextjs.rs::tests`, `crates/worker/src/frameworks/config.rs::tests`
- Node integration tests: `packages/core/test/spring-framework.test.ts`, `packages/core/test/nestjs-framework.test.ts`, `packages/core/test/express-framework.test.ts`, `packages/core/test/nextjs-framework.test.ts`

## Core principle

**AST stays framework-agnostic.** The current `RawFile` is a good syntax-level structure. Framework plugins observe the `RawFile`, optionally annotate it, and the indexer turns those annotations into typed semantic rows. This matches the existing `source_ir.rs` model: an external specialist produces metadata per file, and `index.rs` merges it into the common model.

## Where the plugin model fits

```text
Source files (TS, Java, Go, Python, …)
        │
        ▼
┌─────────────────────────────────────┐
│  Language parser (unchanged)        │  crates/worker/src/language.rs
│  - RawFile with symbols/imports/    │      crates/worker/src/polyglot.rs
│    calls/writes/reads/throws/txs     │
│  - NEW: framework_metadata: Vec<>     │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  FrameworkExtension registry        │  crates/worker/src/frameworks/mod.rs
│  - one plugin per framework         │
│  - plugin receives (RawFile, file    │
│    path, project context)           │
│  - plugin returns FrameworkMetadata │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  Indexer (unchanged graph pipeline) │  crates/worker/src/index.rs
│  - resolves imports & symbols       │
│  - resolves injection tokens        │
│  - builds framework relationships   │
│  - emits AnalysisBatch              │
└─────────────────────────────────────┘
        │
        ▼
  Existing store / forms / visuals
```

## New Rust modules

| Module | Responsibility |
|---|---|
| `crates/worker/src/frameworks/mod.rs` | Trait `FrameworkExtension`, registry, dispatch loop, project context |
| `crates/worker/src/frameworks/spring.rs` | Extract Spring Boot metadata: controllers, providers, routes, injection, transactions, guards |
| `crates/worker/src/frameworks/java_gateway.rs` | Extract Spring Cloud Gateway `RouteLocator` DSL, custom `GatewayFilter` classes, YAML/properties route config |
| `crates/worker/src/frameworks/nestjs.rs` | Extract NestJS metadata: controllers, providers, modules, routes, constructor injection, guards, interceptors |
| `crates/worker/src/frameworks/express.rs` | Extract Express/Fastify/Koa-style metadata: static routes, middleware, router mounts |
| `crates/worker/src/frameworks/nextjs.rs` | Extract Next.js metadata: App Router and Pages Router file-system routes, API handlers, server actions |
| `crates/worker/src/frameworks/config.rs` | Reads `package.json`, `tsconfig.json`, `nest-cli.json`, `.env`, `application*.yml/properties`, `pom.xml` and emits `config_value` / `active_profile` facts |

## Shared data shape

```rust
// Attached to RawFile
pub struct RawFrameworkMetadata {
    pub framework: &'static str,          // "spring", "nestjs", "express", "nextjs"
    pub kind: FrameworkEntityKind,
    pub name: String,
    pub subject_symbol: Option<usize>,      // index into RawFile.symbols when there is a source symbol
    pub start: usize,
    pub end: usize,
    pub properties: Value,
    pub parent: Option<String>,
}

pub enum FrameworkEntityKind {
    Controller, Route, Provider, Guard, Interceptor, Middleware,
    Module, Inject, Transaction, MessageListener,
    GatewayRoute, GatewayFilter, GatewayPredicate, ConfigValue,
}
```

Plugins return only this structured metadata. The indexer owns cross-file resolution and graph construction.

## What `index.rs` does with it

A new pass, `resolve_framework_metadata`, runs after entities are created and before the per-file call-resolution loop:

- Emits `Entity` rows with kinds like `spring_route`, `spring_provider`, etc.
- Emits `Fact` rows:
  - `predicate: "route"` → `{ method, path, handler }`
  - `predicate: "injected"` → `{ token, type, scope, qualifier }`
  - `predicate: "uses_transaction"` → `{ framework: "spring", source, constructor }`
  - `predicate: "framework_role"` → `{ framework, role, name, properties }`
- Emits `Relationship` rows:
  - `controller → exposes_route → route`
  - `module → contains → provider/controller`
  - `provider → injects → provider`
  - `route → applies_guard → guard` (future)

All rows use the existing `EvidenceRef`/`SourceSpan` machinery with `resolution: STATIC_RESOLVED` where the plugin resolved something statically, `PARSED` where it only saw syntax, and `UNRESOLVED` / **Fog** for dynamic/conditional pieces.

## Implemented Spring Boot extraction

| Target | How to detect | Metadata emitted |
|---|---|---|
| `@Controller` / `@RestController` | class annotation | `Controller` |
| `@GetMapping` / `@PostMapping` / etc. | method annotation | `Route` with method + path |
| `@RequestMapping` | class/method annotation | `Route` (merged prefix + path) |
| `@Autowired` / constructor injection | constructor/method/field | `Inject` (token, type, qualifier) |
| `@Value("${key}")` | parameter/field | `ConfigValue` (future) |
| `@Transactional` | class/method | `Transaction` |
| `@Service` / `@Repository` / `@Component` | class annotation | `Provider` |
| `@KafkaListener` / `@RabbitListener` / `@JmsListener` | method annotation | `MessageListener` (mirrored) |
| `@PreAuthorize` / `@Secured` / `@RolesAllowed` | method annotation | `Guard` |

## TypeScript consumers updated

| File | Change |
|---|---|
| `packages/core/src/forms/journey.ts` | Steps inside a transaction are marked with a note and badge; framework facts show the framework name (e.g. "Spring transaction"). |
| `packages/core/src/forms/analysis.ts` | `guards()` now also recognises `framework_role` facts with `role: "guard"`, so Spring Security annotations and NestJS guard classes appear as gates in trust/policy views. |

## Runtime verification (future)

For frameworks where static analysis is insufficient, add a Node-side runtime sandbox that produces `RUNTIME` evidence:

| Framework | Sandbox approach | Location |
|---|---|---|
| NestJS | `Test.createTestingModule({ imports: [AppModule] }).compile()` then `DiscoveryService` / `ModulesContainer` / `MetadataScanner` | `packages/core/src/runtime-sandbox.ts` (future) |
| Next.js | build or start a dev server, read build manifest / route handlers | future |
| Generic Node | `require-in-the-middle` or Node diagnostics channel | future |

## Incremental indexing

Because framework metadata is per-file and content-addressed, the existing incremental logic in `index.rs` works automatically:

- Unchanged files reuse cached `RawFile` including `framework_metadata`.
- Changed files re-run the relevant plugins.
- `shard()` digests the resulting rows per file.
- No special incremental handling required beyond keeping `RawFile` serializable.

## Test coverage

| Test | What it proves |
|---|---|
| `crates/worker/src/frameworks/spring.rs::tests` | Plugin extracts controller, route, provider, constructor injection, transactional method/constructor, security guard; does not over-inject plain constructors. |
| `crates/worker/src/frameworks/java_gateway.rs::tests` | Plugin extracts Java DSL routes/filters, custom `GatewayFilter` classes, and YAML/properties route definitions. |
| `crates/worker/src/frameworks/nestjs.rs::tests` | Plugin extracts controllers, providers, modules, routes, constructor injection, guards, interceptors, and module graph. |
| `crates/worker/src/index.rs::spring_tests` | Full indexing turns Spring and Spring Cloud Gateway metadata into typed entities, facts, and relationships. |
| `crates/worker/src/index.rs::nestjs_tests` | Full indexing turns NestJS metadata into typed entities, facts, and relationships, including cross-file module graph. |
| `crates/worker/src/frameworks/express.rs::tests` | Plugin extracts static routes and middleware from `app.*`, `router.*`, and `server.*` calls. |
| `crates/worker/src/frameworks/nextjs.rs::tests` | Plugin infers App Router and Pages Router file-system routes, API handlers, and server actions. |
| `crates/worker/src/index.rs::express_tests` | Full indexing turns Express metadata into typed entities, facts, and relationships. |
| `crates/worker/src/index.rs::nextjs_tests` | Full indexing turns Next.js metadata into typed entities and facts, including API handlers and server actions. |
| `crates/worker/src/frameworks/config.rs::tests` | Plugin extracts package.json scripts/dependencies, tsconfig.json options, .env values, application.yml/properties, and pom.xml coordinates. |
| `packages/core/test/spring-framework.test.ts` | Node service stores and exposes the framework facts; `guards()` recognises `@PreAuthorize`; journey marks transactional steps as "Spring transaction"; gateway routes/filters appear end-to-end; pom.xml and application properties are extracted. |
| `packages/core/test/nestjs-framework.test.ts` | Node service stores NestJS framework facts; `guards()` recognises `@UseGuards` and `CanActivate` guard classes; routes, injection, module graph, package.json/tsconfig/.env are exposed. |
| `packages/core/test/express-framework.test.ts` | Node service stores Express routes and middleware entities and package.json config values end-to-end. |
| `packages/core/test/nextjs-framework.test.ts` | Node service stores Next.js routes and server actions and tsconfig.json/.env/package.json config values end-to-end. |

## Remaining phases

### Phase 2 — Spring Cloud Gateway ✅

Implemented in `crates/worker/src/frameworks/java_gateway.rs`.

- Detects `RouteLocator` bean methods and the fluent `.route()` / `.filters()` DSL.
- Detects custom classes implementing `GatewayFilter` (or `GatewayFilterFactory`).
- Parses `application*.yml` and `application*.properties` for `spring.cloud.gateway.routes`.
- Emits `spring_cloud_gateway_route`, `spring_cloud_gateway_filter` entities and `gateway_route` / `gateway_filter` facts.
- Adds `uses_filter` relationships from route to filter.
- Adds `framework_role` facts with `role: "gateway_filter"` for custom filter classes (inventory).

### Phase 3 — NestJS ✅

Implemented in `crates/worker/src/frameworks/nestjs.rs`.

- Detects TS decorators: `@Controller`, `@Injectable`, `@Module`, `@Get`/`@Post`/etc., `@UseGuards`, `@UseInterceptors`, `@Inject`, `@Optional`.
- Detects guards by `implements CanActivate` and interceptors by `implements NestInterceptor`.
- Emits `nestjs_controller`, `nestjs_provider`, `nestjs_module`, `nestjs_route`, `nestjs_guard`, `nestjs_interceptor` entities.
- Emits `route`, `injected`, `framework_role` facts and `injects`, `exposes_route`, `contains` relationships.
- Resolves module graph across files (`imports`, `controllers`, `providers`, `exports`).

### Phase 4 — Express / Next.js ✅

Implemented in `crates/worker/src/frameworks/express.rs` and `crates/worker/src/frameworks/nextjs.rs`.

Express:
- Detects `app.get/post/put/delete/patch/all/head/options(path, ...handlers)`, `router.*`, and `server.*` calls.
- Detects `app.use(path?, ...middleware)` mounts.
- Emits `express_route` and `express_middleware` entities and `route` / middleware facts.

Next.js:
- Infers App Router routes from `app/**/page.tsx`, `app/**/route.ts`, `app/**/layout.tsx`.
- Infers Pages Router routes from `pages/**/index.tsx`, `pages/**/*.tsx`, `pages/api/**/*.ts`.
- Extracts API route handlers from exported `GET`/`POST`/etc. functions.
- Extracts server actions from `actions.ts` / `actions/*.ts`.
- Emits `nextjs_route` entities and `route` facts.

### Phase 5 — Config resolver ✅

Implemented in `crates/worker/src/frameworks/config.rs`.

- Reads `package.json` (scripts, dependencies, name, version).
- Reads `tsconfig.json` (compiler options, include/exclude).
- Reads `.env` / `.env.*` files (key/value pairs, prefixed as `env:<filename>:<key>`).
- Reads `nest-cli.json` (collection, sourceRoot, projects).
- Reads `application*.yml` / `application*.properties` (flattened keys, `spring:` prefix for non-`spring.*` properties, `active_profile` fact for `spring.profiles.active`).
- Reads `pom.xml` (groupId, artifactId, version, java.version, spring-boot.version).
- The repository walk in `index.rs` now includes these config files and routes them through the framework plugin dispatch.
- Emits `config_value` facts (with secret redaction) and `active_profile` facts.

### Phase 6 — Runtime sandbox
- Add `packages/core/src/runtime-sandbox.ts`.
- Implement NestJS `TestingModule` bootstrap and metadata extraction.
- Integrate with `Service` / jobs, write `RUNTIME` evidence to store.

### Phase 7 — LLM tools + new forms
- Add framework-aware tools (`getModuleGraph`, `getRoutes`, `getProviders`, `getGuards`, `getConfigValue`, `getGatewayRoutes`).
- Add gateway/module route visual forms if needed.

## How to run

```sh
cargo build --release                 # build the worker with Spring + Gateway + NestJS + Express + Next.js + Config plugins
node --test packages/core/test/spring-framework.test.ts
node --test packages/core/test/nestjs-framework.test.ts
node --test packages/core/test/express-framework.test.ts
node --test packages/core/test/nextjs-framework.test.ts
```

All existing tests pass:
```sh
cd crates/worker && cargo test        # 81 tests pass
npm run typecheck                      # TypeScript typechecks
node --test packages/core/test/c05.test.ts packages/core/test/c07.test.ts
node --test packages/core/test/forms.test.ts
node --test packages/core/test/spring-framework.test.ts
node --test packages/core/test/nestjs-framework.test.ts
node --test packages/core/test/express-framework.test.ts
node --test packages/core/test/nextjs-framework.test.ts
```
