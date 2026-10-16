use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "expressions, calls, supported branches/loops and simple JS/TS catch; joins approximate; other behavior opaque", id: "typescript", extensions: &["ts", "mts", "cts", "tsx"], adapter_version: "typescript-control.v4", semantics: "ecmascript-control-subset.v4" },
    grammar: || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    declarations: &["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"],
    profile: Profile::TypeScript,
};
