use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "straight-line expressions and explicit calls; narrow Java static bindings; other behavior opaque", id: "java", extensions: &["java"], adapter_version: "java-calls.v3", semantics: "java-call-subset.v3" },
    grammar: || tree_sitter_java::LANGUAGE.into(),
    declarations: &["method_declaration"],
    profile: Profile::Java,
};
