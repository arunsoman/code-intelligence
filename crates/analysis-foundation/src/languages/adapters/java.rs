use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "literal returns; all other bodies opaque; module semantics excluded", id: "java", extensions: &["java"], adapter_version: "java-literals.v1", semantics: "java-literal-subset.v1" },
    grammar: || tree_sitter_java::LANGUAGE.into(),
    declarations: &["method_declaration"],
    profile: Profile::Java,
};
