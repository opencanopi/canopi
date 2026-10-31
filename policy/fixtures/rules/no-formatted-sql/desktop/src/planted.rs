// The planted no-formatted-sql violation: a site in a file its family does not list.
fn f(c: &str) -> String { format!("SELECT {c} FROM layers WHERE id = ?1") }
