// The planted no-string-error-command violation: a site in a file its family does not list.
#[tauri::command]
pub fn f() -> Result<u8, String> { Ok(1) }
