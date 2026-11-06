//! Tauri IPC commands for the LiDAR library.
//!
//! UI callers never orchestrate SQL, rasters, masks, engine processes, cache
//! publication or recovery: every capability here returns library identities,
//! receipts or snapshots. All heavy work runs through the managed Native
//! Operation Executor.

use crate::{native_operation::NativeOperationExecutor, services::lidar::LidarLibrary};
use canopi_types::library::{
    AnalysisReceipt, AnalysisRequest, LibraryDeleteImpact, LibrarySnapshot, ProcessingHistoryPage,
    RasterQuantity,
};
use canopi_types::lidar::{LidarImportReceipt, LidarImportRefusal};
use tauri::State;

#[tauri::command]
pub async fn lidar_list_library(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
) -> Result<LibrarySnapshot, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar library snapshot",
            move || library.library_snapshot(),
        )
        .await
}

/// Rename one library item, source or derived; metadata only.
#[tauri::command]
pub async fn lidar_rename_item(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    item_id: String,
    name: String,
) -> Result<(), String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar rename item",
            move || library.rename_item(&item_id, &name),
        )
        .await
}

/// The derived items calculated from one item, shown before deletion.
#[tauri::command]
pub async fn lidar_delete_impact(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    item_id: String,
) -> Result<LibraryDeleteImpact, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar delete impact",
            move || library.delete_impact(&item_id),
        )
        .await
}

/// Delete one library item; refused while results were calculated from it.
/// The rows go on `UserData`; once the item's own cancelled jobs settle, its
/// files are freed there too. A file left behind is freed at the next start
/// and never fails the committed Delete.
#[tauri::command]
pub async fn lidar_delete_item(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    item_id: String,
) -> Result<(), String> {
    let library = library.inner().clone();
    let deleting = library.clone();
    let deleted = executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar delete item",
            move || deleting.delete_item_rows(&item_id),
        )
        .await?;
    // The item is gone; its own cancelled jobs let go of its files first.
    library.await_jobs_settled(&deleted.job_ids).await;
    let freeing = library.clone();
    let freed = executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar free a deleted item's files",
            move || {
                freeing.free_deleted_item(&deleted);
                Ok(())
            },
        )
        .await;
    if let Err(error) = freed {
        tracing::warn!(%error, "a deleted item's files are freed at the next start");
    }
    Ok(())
}

/// Cancel one import: its flag is set before any queued work, so the job
/// stops at its next step however busy the executor is, then its import is
/// withdrawn on `UserData` before Cancel returns: a Retry's item reads Failed
/// again, a first import's item is deleted.
#[tauri::command]
pub async fn lidar_cancel_import(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    job_id: String,
) -> Result<(), String> {
    let library = library.inner().clone();
    library.set_cancel_flag(&job_id);
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar cancel import",
            move || library.cancel_import(&job_id),
        )
        .await
}

/// Bounded cancellation signal delivery; must bypass queued executor work so
/// a busy Local class cannot make Cancel unresponsive. Only the in-memory
/// flag is set here; the job row is updated on the executor.
#[tauri::command]
pub fn lidar_cancel_analysis_job(library: State<'_, LidarLibrary>, job_id: String) {
    library.signal_cancel(&job_id);
}

/// Create a definition of a registered analysis and start its first run.
#[tauri::command]
pub async fn lidar_create_analysis(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    request: AnalysisRequest,
) -> Result<AnalysisReceipt, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar create analysis",
            move || library.create_analysis(&request),
        )
        .await
}

/// Run a definition again: Retry before a first result, Refresh after one.
#[tauri::command]
pub async fn lidar_rerun_analysis(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    definition_id: String,
) -> Result<AnalysisReceipt, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar rerun analysis",
            move || library.rerun_analysis(&definition_id),
        )
        .await
}

/// One bounded page of a definition's processing history, newest first.
#[tauri::command]
pub async fn lidar_processing_history(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    definition_id: String,
    cursor: Option<String>,
) -> Result<ProcessingHistoryPage, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar processing history",
            move || library.processing_history(&definition_id, cursor.as_deref()),
        )
        .await
}

/// One bounded page of a layer's ordered source composition.
#[tauri::command]
pub async fn lidar_layer_collection(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    layer_id: String,
    cursor: Option<String>,
) -> Result<canopi_types::lidar::LidarLayerCollection, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar layer collection",
            move || library.layer_collection(&layer_id, cursor.as_deref()),
        )
        .await
}

/// Site data's one sampler (spec §1.10): the native cell under each WGS84
/// point of each target, in target and point order, for row values, the pin
/// and a profile alike.
///
/// A request over the generated caps is refused before anything waits. Then
/// sampling is serialised library-wide by one permit, taken before the Local
/// slot, so the sampler never holds more than one of Local's running slots and
/// a save is always admitted beside it. The read opens raster files, so it
/// belongs to the `Local` class, never to `UserData`.
#[tauri::command]
pub async fn lidar_sample_points(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    request: canopi_types::lidar::LidarSamplePointsRequest,
) -> Result<Vec<canopi_types::lidar::LidarSampleSeries>, String> {
    let library = library.inner().clone();
    let turn = library.sampling_turn(&request).await?;
    executor
        .run(
            crate::native_operation::NativeOperationClass::Local,
            "lidar sample points",
            move || {
                // The turn is held for the whole read and released with it.
                let _turn = turn;
                library.sample_points(&request)
            },
        )
        .await
}

/// Describe the display derivatives of one entity's current generation.
///
/// Missing derivatives start preparing in the library's display lane; the
/// response then says `Preparing` and the caller asks again. Only managed file
/// paths inside the scoped display directory are returned, never bytes.
#[tauri::command]
pub async fn lidar_display_descriptor(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    request: canopi_types::lidar::LidarDisplayRequest,
) -> Result<canopi_types::lidar::LidarDisplayDescriptor, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar display descriptor",
            move || library.display_descriptor(&request),
        )
        .await
}

/// Import selected files as one new fixed library item.
///
/// The item and its job are created together only when the user submits the
/// selection; cancelling the file picker creates nothing. Preparation,
/// display derivatives and publication run as one job: a failure or
/// cancellation publishes none of the batch. A stopping job still settling
/// (cancelled, or done) is waited for before the file check, so the same
/// file imports again. A refusal carries its kind, so the dialog names it
/// in the interface language; a busy executor is `Internal`.
#[tauri::command]
pub async fn lidar_import_item(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    name: String,
    quantity: RasterQuantity,
    // `unit_label` and `unit_unknown` declare the unit of an "other continuous"
    // dataset. Elevation and height are always metres and refuse both.
    unit_label: Option<String>,
    unit_unknown: Option<bool>,
    paths: Vec<String>,
) -> Result<LidarImportReceipt, LidarImportRefusal> {
    let library = library.inner().clone();
    library.await_stopping_jobs().await;
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar import item",
            move || {
                Ok(library.import_item(
                    &name,
                    quantity,
                    unit_label.as_deref(),
                    unit_unknown.unwrap_or(false),
                    paths.into_iter().map(std::path::PathBuf::from).collect(),
                ))
            },
        )
        .await?
}

/// Import › "Covers your site": the WGS84 box around the chosen files, read
/// from their metadata before anything is imported.
#[tauri::command]
pub async fn lidar_import_coverage(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    paths: Vec<String>,
) -> Result<canopi_types::lidar::LidarImportCoverage, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Local,
            "lidar import coverage",
            move || {
                let paths: Vec<std::path::PathBuf> =
                    paths.into_iter().map(std::path::PathBuf::from).collect();
                library.import_coverage(&paths)
            },
        )
        .await
}

/// Data library footer: bytes the library occupies on this device.
#[tauri::command]
pub async fn lidar_library_disk_usage(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
) -> Result<u64, String> {
    let library = library.inner().clone();
    executor
        .run(
            crate::native_operation::NativeOperationClass::Local,
            "lidar library size",
            move || library.disk_usage(),
        )
        .await
}

/// Retry a failed import with its saved selection, keeping the same library
/// item. A published item cannot be retried. A stopping job still settling
/// is waited for first, as Import waits. A refusal carries its kind, as
/// Import's does.
#[tauri::command]
pub async fn lidar_retry_import(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    layer_id: String,
) -> Result<LidarImportReceipt, LidarImportRefusal> {
    let library = library.inner().clone();
    library.await_stopping_jobs().await;
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar retry import",
            move || Ok(library.retry_import(&layer_id)),
        )
        .await?
}

/// Remove an unpublished item whose import failed. A stopping job still
/// settling, such as the item's own failed import freeing its files, is
/// waited for first, as Import waits, since Dismiss may free originals under
/// the same heavy lease.
#[tauri::command]
pub async fn lidar_dismiss_import(
    library: State<'_, LidarLibrary>,
    executor: State<'_, NativeOperationExecutor>,
    layer_id: String,
) -> Result<(), String> {
    let library = library.inner().clone();
    library.await_stopping_jobs().await;
    executor
        .run(
            crate::native_operation::NativeOperationClass::UserData,
            "lidar dismiss import",
            move || library.dismiss_import(&layer_id),
        )
        .await
}
