// The planted process-only-in-runner violation: a site in a file its family does not list.
fn f() { std::process::Command::new("xdg-open"); }
