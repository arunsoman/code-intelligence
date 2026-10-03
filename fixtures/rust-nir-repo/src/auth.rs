pub struct Session {
    pub valid: bool,
}

pub fn verify(token: &str) -> bool {
    if token.is_empty() {
        panic!("missing token");
    }
    true
}
