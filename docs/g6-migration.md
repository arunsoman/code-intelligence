# G6 graph migration: first slice

This patch uses pinned `@antv/g6` 5.1.1 for layout and rendering of S21 call graphs and S23 dependency/module graphs. Other charts retain their existing renderers. Install dependencies with `npm ci` after applying the patch. The investigation patch can be applied independently: these changes use the existing evidence and view contracts.

## Rendering contract

`g6-adapter.ts` converts Rendered into G6 nodes, edges and combos without changing source objects. Entity IDs, relationship IDs, evidence references and application selection remain authoritative. Orphaned edge endpoints are excluded. Fact/inference/hypothesis/unknown modes remain visually distinguished. G6 is a presentation backend, not a source of code relationships.

Directed graphs use Dagre, with horizontal or vertical orientation selected from initial viewport dimensions. Disconnected nodes use grid. Resize updates the viewport without moving the user's graph. Fit preserves readable node labels at the expense of keeping some elements off-screen; the footer reports that and offers Bring into view. Automatic arrangement changes should never be mistaken for evidence of runtime ordering.

G6 loads lazily when a migrated chart is opened. It adds a substantial graph-engine download, so this slice does not claim a performance improvement over ELK/Cytoscape. Both engines remain installed until remaining notations migrate and routing/group quality is validated.

## Generic captured hover lens

G6 `node:pointerover` and `edge:pointerover` forward element identity and screen coordinates to the shared `LensEngine.hoverElement`. The common lens applies the 350 ms hover delay, pauses activation while zooming, captures the selected element and its detail once, and blocks chart zoom while the preview is active. Pointer-out cancels pending capture without instantly dismissing an active preview: the user can move into the enlarged content. Keyboard E uses the same preview.

The event handler is synchronous because the scene is already available. If future detail requires asynchronous retrieval, use an AbortController and a hover generation token; discard completion after pointer-out, a new subject, a tab change or a revision change. Fetching on every pointer movement would introduce latency and stale previews.

Node and edge clicks retain source/evidence actions. Shift/Ctrl/Meta click and Space toggle node selection. Box select, arrow/Home/End navigation, Enter inspection, O text outline, conventional wheel zoom, +/- zoom, lens paging and pause controls remain available. Saved camera state translates between the application's zoom/pan coordinates and G6's camera coordinates.

## Validation and remaining scope

Run `npm run typecheck`, the adapter/lens unit tests, `apps/web/test/e2e/g6.test.ts`, and the existing chart screenshot suite. Browser tests exercise indexed payment code with a stub provider; they do not validate a hosted model's interpretation.

ER/activity/sequence/concurrency migration, specialized routing and ports, comprehensive accessibility review, large-graph benchmarks, and removing legacy engines remain later work. Native tables should remain native tables. Full labels remain available through the captured lens and text outline.

## Second slice: architecture and UML classes

S1 container/component architecture and S16 UML class diagrams now also use G6. Architecture groups preserve their original parent membership through compound Dagre layout and nested combos; group labels appear at the upper boundary. No new deployment or technology boundary is inferred by rendering.

Class cards use a dedicated G6 node with stereotype, title, attribute and operation compartments and real separators. Dimensions reflect wrapped text. Both compartments receive a share of the visible member budget; excess members are counted explicitly and remain in source metadata for inspection. Empty compartments say that attributes/operations lack evidence. Connected classes use hierarchical layout; disconnected classes use a multi-column grid with actual card dimensions and spacing. The initial camera keeps the first class/component visible below the toolbar, while reporting off-screen content.

Inheritance and realization use hollow target triangles; realization and dependency use dashed links. Aggregation uses a hollow source diamond; composition uses a filled source diamond. Association has no directional arrow unless a later contract supplies navigability. Dependency uses an open target arrow. The captured relationship preview uses the same arrow contract and evidence colors.

The shared lens now pages long leaf detail lists using [ and ], as well as existing child-element pages. Paging retains the captured element and does not move the source graph. Its node hit boxes reflect actual class sizes rather than the old fixed graph-node size. Internal c4-/uml- role prefixes are removed from lens captions.

`g6-notation.test.ts` checks compartments, omission, sizing, relation semantics and complete detail paging. The browser notation fixture directly renders the production G6Canvas with deliberately varied cards and nested boundaries: it checks non-overlap, containment, multi-column layout, keyboard evidence callbacks and captured paging. Its data is synthetic renderer test data, not a claim about repository evidence. Existing indexed-repository interaction tests and the full screenshot suite cover the surrounding application.

Node and group world bounds are exposed as canvas data attributes for layout diagnostics. This slice does not add a new evidence extractor, class-member inference, group collapse navigation or image export API; existing response export and evidence actions remain in place. Other chart types still use their existing surfaces.
