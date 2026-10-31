// The planted durable-write-only-in-publish violation: a site in a file its family does not list.
fn f(p: &Path) { std::fs::write(p, b"x").unwrap(); }
