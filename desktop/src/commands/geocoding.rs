use tauri::State;

#[tauri::command]
pub async fn geocoder_fetch(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    url: String,
) -> Result<String, String> {
    crate::services::geocoding::geocoder_fetch(executor.inner(), url).await
}
