use super::{Metadata, Profile, TreeAdapter};
pub static ADAPTER: TreeAdapter = TreeAdapter {
    metadata: Metadata {
        semantic_scope: "expressions, calls, supported branches/loops and simple JS/TS catch; joins approximate; other behavior opaque", id: "java", extensions: &["java"], adapter_version: "java-control.v4", semantics: "java-control-subset.v4" },
    grammar: || tree_sitter_java::LANGUAGE.into(),
    declarations: &["method_declaration"],
    profile: Profile::Java,
};
