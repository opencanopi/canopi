#[tauri::command]
pub async fn planted_command(path: String) -> Result<(), String> {
    let _ = path;
    Ok(())
}
