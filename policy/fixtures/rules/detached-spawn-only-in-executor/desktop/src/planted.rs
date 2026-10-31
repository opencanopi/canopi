// The planted detached-spawn-only-in-executor violation: a site in a file its family does not list.
fn f() { tauri::async_runtime::spawn(async {}); }
