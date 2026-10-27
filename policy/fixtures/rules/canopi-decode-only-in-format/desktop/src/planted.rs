// The planted canopi-decode-only-in-format violation: a site in a file its family does not list.
fn f(t: &str) { let file = serde_json::from_str::<CanopiFile>(t); }
