// The planted no-cancelled-literal violation: a site in a file its family does not list.
fn f() -> Result<(), String> { Err("cancelled".to_string()) }
