use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "straight-line locals, references and selected expressions; other bodies opaque", id: "javascript", extensions: &["js", "mjs", "cjs", "jsx"], adapter_version: "javascript-expressions.v2", semantics: "ecmascript-expression-subset.v2" },
    grammar: || tree_sitter_javascript::LANGUAGE.into(),
    declarations: &["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"],
    profile: Profile::JavaScript,
};
