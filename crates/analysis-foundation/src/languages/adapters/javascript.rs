use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "straight-line expressions and explicit calls; narrow Java static bindings; other behavior opaque", id: "javascript", extensions: &["js", "mjs", "cjs", "jsx"], adapter_version: "javascript-calls.v3", semantics: "ecmascript-call-subset.v3" },
    grammar: || tree_sitter_javascript::LANGUAGE.into(),
    declarations: &["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"],
    profile: Profile::JavaScript,
};
