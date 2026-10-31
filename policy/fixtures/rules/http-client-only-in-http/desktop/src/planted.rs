// The planted http-client-only-in-http violation: a site in a file its family does not list.
fn f() { let _ = ureq::get("https://example.org").call(); }
