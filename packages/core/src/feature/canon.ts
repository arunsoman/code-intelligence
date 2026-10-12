// pf-canon-v1 moved to @cie/canon (packages/canon/src/index.ts) so packages beneath core can share the
// identity protocol without a dependency on @cie/core (C33's re-evidence module in core now depends on
// @cie/evidence, which itself depends on @cie/canon — a package cycle would otherwise be unavoidable).
// The protocol itself is unchanged (§29.3: a protocol change creates new identities); this re-export
// keeps every existing importer working.
export * from "@cie/canon";
