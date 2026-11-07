// The canopi-redact copy: the rule's files glob reads every workspace crate (canopi-f47t.52.224).
// The planted http-client-only-in-http violation: a site in a file its family does not list.
fn f() { let _ = ureq::get("https://example.org").call(); }
