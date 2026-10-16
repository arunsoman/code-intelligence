use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "straight-line locals, references and selected expressions; other bodies opaque", id: "java", extensions: &["java"], adapter_version: "java-expressions.v2", semantics: "java-expression-subset.v2" },
    grammar: || tree_sitter_java::LANGUAGE.into(),
    declarations: &["method_declaration"],
    profile: Profile::Java,
};
