// The planted janitor-only-deletes violation: a site in a file its family does not list.
fn f(p: &Path) { std::fs::remove_file(p).unwrap(); }
