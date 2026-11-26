//! Thin `#[tauri::command]` wrappers over [`crate::services::design_core`] (2b-5;
//! `canopi-f47t.52.49`, contracts §10, `2.1-M156`, `2.1-M539`, `2.1-Q155`, `2.1-M88`).

use canopi_format::core::NewDesignInput;
use canopi_types::design::v10::{DraftSummaryOutcome, GeoPointV10 as GeoPoint};
use canopi_types::failure::Failure;
use canopi_types::saved_object_stamps::SavedObjectStampPayload;
use serde_json::Value;
use tauri::State;

use crate::native_operation::NativeOperationExecutor;
use crate::services::design_core::{
    self, DecodeDesignReply, DecodeStampReply, EncodeDesignReply, EncodeStampReply,
};

/// Reports the native `canopi-format` crate version.
#[tauri::command]
pub async fn design_core_version(
    executor: State<'_, NativeOperationExecutor>,
) -> Result<String, Failure> {
    design_core::version(executor.inner()).await
}

/// Decodes raw `.canopi` bytes (v9 or v10) through `canopi-format`.
#[tauri::command]
pub async fn design_core_decode(
    executor: State<'_, NativeOperationExecutor>,
    bytes: Vec<u8>,
) -> Result<DecodeDesignReply, Failure> {
    design_core::decode_design(executor.inner(), bytes).await
}

/// Validates and canonically encodes a v10 `.canopi` Design.
#[tauri::command]
pub async fn design_core_encode(
    executor: State<'_, NativeOperationExecutor>,
    design: Value,
) -> Result<EncodeDesignReply, Failure> {
    design_core::encode_design(executor.inner(), design).await
}

/// Constructs a canonical v10 `.canopi` Design from [`NewDesignInput`].
#[tauri::command]
pub async fn design_core_new_design(
    executor: State<'_, NativeOperationExecutor>,
    input: NewDesignInput,
) -> Result<Value, Failure> {
    design_core::new_design(executor.inner(), input).await
}

/// Derives a Draft summary from raw `.canopi` bytes through the one decode choke point.
#[tauri::command]
pub async fn design_core_draft_summary(
    executor: State<'_, NativeOperationExecutor>,
    bytes: Vec<u8>,
    updated_at: String,
) -> Result<DraftSummaryOutcome, Failure> {
    design_core::draft_summary(executor.inner(), bytes, updated_at).await
}

/// Decodes and migrates (v2 → v3) a saved-stamp JSON payload.
#[tauri::command]
pub async fn design_core_decode_stamp(
    executor: State<'_, NativeOperationExecutor>,
    payload_json: String,
) -> Result<DecodeStampReply, Failure> {
    design_core::decode_stamp(executor.inner(), payload_json).await
}

/// Validates and canonically encodes a v3 saved-stamp payload.
#[tauri::command]
pub async fn design_core_encode_stamp(
    executor: State<'_, NativeOperationExecutor>,
    payload: SavedObjectStampPayload,
) -> Result<EncodeStampReply, Failure> {
    design_core::encode_stamp(executor.inner(), payload).await
}

/// Maps a v3 stamp payload to canonical v10 `.canopi` stamp file bytes centred at `origin`.
#[tauri::command]
pub async fn design_core_stamp_to_canopi(
    executor: State<'_, NativeOperationExecutor>,
    payload: SavedObjectStampPayload,
    name: String,
    origin: GeoPoint,
) -> Result<EncodeDesignReply, Failure> {
    design_core::stamp_to_canopi(executor.inner(), payload, name, origin).await
}

/// Decodes a v9/v10 `.canopi` stamp file into a v3 [`SavedObjectStampPayload`] anchored at `origin`.
#[tauri::command]
pub async fn design_core_canopi_to_stamp(
    executor: State<'_, NativeOperationExecutor>,
    bytes: Vec<u8>,
    origin: GeoPoint,
) -> Result<DecodeStampReply, Failure> {
    design_core::canopi_to_stamp(executor.inner(), bytes, origin).await
}
