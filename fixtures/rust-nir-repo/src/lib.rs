pub mod auth;

#[path = "screens/tasks.nir"]
pub mod tasks;

pub fn entry(token: &str) -> bool {
    auth::verify(token)
}
