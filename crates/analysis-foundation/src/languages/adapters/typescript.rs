use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "straight-line locals, references and selected expressions; other bodies opaque", id: "typescript", extensions: &["ts", "mts", "cts", "tsx"], adapter_version: "typescript-expressions.v2", semantics: "ecmascript-expression-subset.v2" },
    grammar: || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    declarations: &["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"],
    profile: Profile::TypeScript,
};
