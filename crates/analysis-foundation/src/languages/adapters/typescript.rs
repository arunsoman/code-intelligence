use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "literal returns; all other bodies opaque; module semantics excluded", id: "typescript", extensions: &["ts", "mts", "cts", "tsx"], adapter_version: "typescript-literals.v1", semantics: "ecmascript-literal-subset.v1" },
    grammar: || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    declarations: &["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"],
    profile: Profile::TypeScript,
};
