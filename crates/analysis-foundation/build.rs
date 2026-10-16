use std::{env, fs, path::PathBuf};

fn main() {
    let directory =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("src/languages/adapters");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut files: Vec<_> = fs::read_dir(&directory)
        .expect("adapter directory")
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .collect();
    files.sort();
    let mut output = String::new();
    for (i, path) in files.iter().enumerate() {
        println!("cargo:rerun-if-changed={}", path.display());
        output.push_str(&format!("#[path = {path:?}] mod adapter_{i};\n"));
    }
    output.push_str("pub fn builtin_adapters() -> Vec<&'static dyn LanguageAdapter> { vec![");
    for i in 0..files.len() {
        output.push_str(&format!("&adapter_{i}::ADAPTER,"));
    }
    output.push_str("] }\n");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("adapters.rs"),
        output,
    )
    .unwrap();
}
