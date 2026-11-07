// The canopi-redact copy: the rule's files glob reads every workspace crate (canopi-f47t.52.224).
// The planted no-formatted-sql violation: a site in a file its family does not list.
fn f(c: &str) -> String { format!("SELECT {c} FROM layers WHERE id = ?1") }
