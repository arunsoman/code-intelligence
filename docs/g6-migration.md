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

Architecture/class/ER/activity/sequence/concurrency migration, specialized routing and ports, comprehensive accessibility review, large-graph benchmarks, and removing legacy engines remain later work. Native tables should remain native tables. Full labels remain available through the captured lens and text outline.
