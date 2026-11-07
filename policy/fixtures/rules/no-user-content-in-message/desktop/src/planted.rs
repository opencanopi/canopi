// The planted no-user-content-in-message violation: a site in a file its family does not list.
fn f(path: &std::path::Path) -> Result<(), String> { Err(format!("cannot read {}", path.display())) }
