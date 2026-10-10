# Hierarchical exploration navigation

Apply after the ten earlier patches, ending with contextual exploration. Explicit exploration now creates a scope breadcrumb; perspective tabs stay within that scope. Back returns to the parent exploration rather than undoing a tab choice. An ancestor can be selected directly, restoring its active tab, selection, matrix cells, semantic level, display mode, weights, camera and lens state. Pending ancestor generations become retryable and old attempts cannot replace their views.

Breadcrumbs describe actual visited scopes and active perspectives across architecture, components, behavior, data, state, reliability and code. They do not invent repository containment relationships. Opening a source adds a code breadcrumb; returning closes source inspection while preserving the canvas. New questions and revision changes establish fresh roots. The most recent thirty parent scopes are retained, with an explicit notice when earlier steps are omitted. There is no forward-history branch or persisted cross-session navigation in this slice.

New child perspectives project selection through entity identity and start with their own diagram geometry; parent snapshots retain their exact viewport. Jumping back invalidates outstanding generation and discards descendants. Existing export now carries the current navigation label, without exporting ancestor UI snapshots.

Validation covers branch creation, ancestor restoration, new roots, revision isolation, perspective changes, stale attempts, retention limits, invalid jumps and semantic selection projection, alongside existing focused suites, typecheck and web build. Browser interaction remains unverified.
