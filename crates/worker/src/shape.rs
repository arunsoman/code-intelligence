//! A symbol's AST shape, independent of language: the sequence of tree-sitter grammar node kinds in pre-order,
//! discarding every identifier's and literal's actual text. `node.kind()` already returns the grammar rule name
//! ("enum_declaration", "property_signature", "identifier", "string") rather than the source text, so collecting
//! that sequence is exactly "this construct, this shape, regardless of what anything is named or set to" with no
//! separate identifier-blanking step needed. Two symbols with the same shape hash are structurally identical.
use sha2::{Digest, Sha256};
use tree_sitter::Node;

pub fn shape_hash(node: Node) -> String {
    let mut buf = String::with_capacity(256);
    walk(node, &mut buf);
    let mut hasher = Sha256::new();
    hasher.update(buf.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn walk(node: Node, buf: &mut String) {
    buf.push_str(node.kind());
    buf.push('|');
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            walk(cursor.node(), buf);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}
