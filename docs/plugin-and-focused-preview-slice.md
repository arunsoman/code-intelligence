# Plugin architecture and focused preview slice

This patch is incremental after both earlier patches:

1. `code-intelligence-response-workspace.patch`
2. `automatic-fisheye-incremental.patch`

## Focused circular preview

The lens is now an isolated preview of the target captured from the source chart immediately before activation. Its drawing does not project, magnify or rearrange neighboring chart elements. Moving through the preview does not rebind its target.

- A node shows its own bounded detail card, or its immediate children and relationships between those children.
- An edge shows only its endpoints and that relationship, preserving edge styling and arrow semantics.
- Source geometry remains unchanged. The preview retains the existing inspection/evidence callbacks.
- The focused header names the captured target. Child clicks inspect that child; they do not automatically replace the captured preview target.
- Automatic viewport sizing, the 88% inner boundary, 200 ms hover delay, pause/resume, keyboard focus and paging remain from the preceding patch.
- Sparse details show a limitation rather than inventing an internal model. Capture is a display snapshot until dismissed; it is not a runtime execution trace.

## Plugin foundation

`packages/schema/src/plugins/chart-module.ts` defines capability-specific compiler inputs/results, metadata, rendering-family contracts and the registered retrieval vocabulary. Retrieval kinds are hints; they do not prove a diagram's semantics or establish worker coverage.

Each declared chart has one module in `packages/core/src/plugins/charts/*.chart.ts`. It exports a static literal `descriptor` and a default module satisfying `ChartModule<"S…">`. The compiler input and returned view identity are tied to that chart ID. Unavailable modules must give a reason and cannot provide a compiler.

There are 30 registered chart IDs: 29 compiler adapters and the explicitly unavailable S29 CFG. The migration wraps existing compiler behavior rather than replacing the analytical engines.

### Discovery and registration

`scripts/generate-plugins.ts` discovers chart modules and `.renderer.ts`/`.renderer.tsx` modules, parses literal metadata through TypeScript's AST, validates it, rejects duplicate identities and missing renderer pairings, and generates:

- The portable schema catalog, containing metadata only.
- Explicit core compiler imports and an exhaustive capability map.
- Explicit web renderer imports and an exhaustive rendering-family map.

There are no runtime directory scans or Vite glob casts that pretend to prove exhaustiveness. Generated maps are checked against declared capability/renderer unions by TypeScript. Generation is deterministic and metadata cannot contain executable expressions or spreads.

Run `npm run plugins:generate` after adding or editing plugin metadata. `npm run plugins:check` rejects stale generated files. Typechecking, the root production web build, startup and the root test command run this check. An additional GitHub Actions workflow runs plugin contract checks and focused tests; it has not been executed remotely by this task.

Runtime core loading also validates metadata, compiler presence, availability consistency and agreement with the generated catalog before handling requests.

### Catalog and response mapping

The schema's existing `CHART_REGISTRY` and `CHART_NAMES` APIs remain as compatibility projections of generated metadata. The gallery's system-chart list and response portfolio now derive from plugin descriptors. Chart concern and question captions are declared once per plugin; concern rules select related views without chart-specific intent wiring. Portfolio policy is now `portfolio.v2`; the response schema still accepts v1.

Native V-code views retain their existing catalog and a small concern mapping. They have not been converted into chart modules.

### Renderer migration

One `view-spec` renderer family wraps existing graph geometry. The workspace selects that registered family when drawing chart graphs. Existing matrix, terrain, Canvas and text-outline surfaces remain intact. This is an adapter foundation, not a new dedicated sequence, ER or C4 renderer.

### Compiler migration

`chart-creator.ts` becomes a compatibility facade over generated typed v2 dispatch. It rejects explicit notation mismatch and unsupported capabilities before invoking a compiler. Model request/cache helpers remain available through its existing imports.

Existing compiler implementations are preserved in `chart-compilers.ts`. Its legacy dispatch remains available for migration parity checks and v1/standard compatibility; new v2 production registration belongs in plugin modules. Physically splitting every compiler body is future cleanup, not necessary to maintain the new registry.

## Adding a chart

For an already declared capability, add or replace its `.chart.ts` module and run generation. No handwritten catalog, compiler registration or concern membership list is needed.

A genuinely new wire capability still requires declaring its ID and typed chart-plan variant in schema: this is the contract, not repetitive registration. A new rendering family requires its renderer contract/ID and implementation. Compile checks intentionally reject undeclared IDs, missing compilers, mismatched result IDs and missing renderer families.

## Validation and boundaries

- TypeScript checks, generated-file checks and production web build pass.
- 21 focused and conversation tests pass, including all 29 empty-evidence compiler parity cases, duplicate/missing-pairing rejection, invalid retrieval vocabulary, compiler-boundary enforcement, explicit notation mismatch, isolated preview content and stable capture after source changes.
- Existing chart tests remain 8 passing / 26 failing, with exactly the same failing test names as untouched HEAD. No chart-fidelity repair is claimed.
- No new dependencies or Rust changes. The previous Rust validation is unchanged; Rust tests were not rerun for this TypeScript-only slice.
- Browser rendering is not validated in this environment. Existing browser tests remain available for a Chrome-equipped environment.
- Workflow plugins, chat-tool migration, Rust module discovery, actual worker capability probing, evidence-proof requirements, plugin cost estimation, uniform cache keys, sentence-level entailment and dedicated notation renderers remain later slices.
- This is trusted repository-source extensibility at build time, not installation or sandboxing of arbitrary third-party code.
