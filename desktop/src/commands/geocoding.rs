pub use canopi_types::location::GeoResult;
use tauri::State;

#[tauri::command]
pub async fn geocode_address(
    executor: State<'_, crate::native_operation::NativeOperationExecutor>,
    query: String,
) -> Result<Vec<GeoResult>, String> {
    crate::services::geocoding::geocode_address(executor.inner(), query).await
}
