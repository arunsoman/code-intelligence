# ER renderer slice

Apply this patch after the six previous incremental patches, ending with the dedicated sequence renderer.

S4 and S9 now use a discovered ER renderer and optional typed `er.v1` metadata. Table cards retain column names, types, evidence and interpreted key/nullability flags. Adaptive ELK placement uses actual card dimensions. Cards show twelve fields and an explicit overflow row; the element outline exposes every retained field. Existing inspection, source navigation, camera handling and captured hover preview remain on the shared graph canvas. Older views without valid ER metadata retain the graph fallback.

Columns without current evidence are omitted with a gap. Inferred relationships require a rationale. Declared relationship styling requires indexed endpoint agreement and matching current evidence for a foreign-key or persistence-association link. Cardinality and column properties remain plan interpretations marked `?`; citations alone do not prove database constraints. Duplicate endpoint relationships retain distinct identities.

Validation covers compiler filtering, relationship evidence, renderer registration, metadata preservation, legacy fallback and real ELK geometry, alongside existing workflow, sequence, preview and architecture checks. Typecheck and web production build are required. Browser interaction was not validated because Chrome is unavailable in this environment. The existing broad geometry suite has a previously reproduced Ownership L3 crossing-threshold failure; this patch does not alter that threshold.
