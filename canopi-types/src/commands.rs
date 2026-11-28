//! Declarative native command table (`commands!` declaration half; Stage 2 Item 10).
//!
//! `tauri-specta` prototype finding (Stage 2 Item 10):
//! `canopi-types` and `bindings-gen` pin `specta = "=2.0.0-rc.23"` and `specta-typescript = "0.0.10"`
//! in the locked offline `Cargo.lock`. `tauri-specta` requires `specta = 2.0.0-rc.28`, which conflicts
//! with `specta-typescript 0.0.10` and cannot be resolved under `--locked` / offline builds.
//! Accordingly, 2a lands the declarative `commands!` table here (`ALL_COMMANDS`) with per-row typed
//! IPC argument and reply signatures, verifies 1-to-1 parity with `tauri::generate_handler![...]`,
//! `SYNC_COMMAND_ALLOWLIST`, and every `#[tauri::command]` handler's `syn`-parsed parameter list in
//! `native_command_policy::tests`, and emits `desktop/web/src/generated/command-map.ts` (typed
//! `CommandMap` + generated `createTypedInvoke`) through `bindings-gen`'s custom emitter.

/// Execution model of a registered Tauri command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandSyncKind {
    /// Executor-backed async command (default).
    Async,
    /// Reviewed bounded synchronous command (in `SYNC_COMMAND_ALLOWLIST`).
    BoundedSync,
}

/// One typed IPC argument (camelCase wire name + TypeScript type expression).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandArg {
    /// Wire argument name in camelCase (matching Tauri's default `rename_all = "camelCase"`).
    pub name: &'static str,
    /// TypeScript type expression for this argument.
    pub ts_type: &'static str,
    /// Whether the argument is optional (`Option<T>` on the Rust handler).
    pub optional: bool,
}

/// One row of the native command registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandRow {
    /// IPC command name as invoked from TypeScript.
    pub name: &'static str,
    /// Rust path inside `desktop/src/commands/`.
    pub path: &'static str,
    /// Execution model (async vs reviewed bounded sync).
    pub sync: CommandSyncKind,
    /// Typed wire arguments (empty slice when the command takes no IPC arguments).
    pub args: &'static [CommandArg],
    /// TypeScript return type expression.
    pub reply: &'static str,
}

macro_rules! commands {
    (
        $(
            $name:ident => $path:literal : $sync:ident ( $($arg_name:ident $(? $opt:tt)? : $arg_ty:literal),* $(,)? ) -> $reply:literal
        ),* $(,)?
    ) => {
        /// Every Tauri command registered by `canopi-desktop`.
        pub const ALL_COMMANDS: &[CommandRow] = &[
            $(
                CommandRow {
                    name: stringify!($name),
                    path: $path,
                    sync: CommandSyncKind::$sync,
                    args: &[
                        $(
                            CommandArg {
                                name: stringify!($arg_name),
                                ts_type: $arg_ty,
                                optional: false $(|| { let _ = stringify!($opt); true })?,
                            },
                        )*
                    ],
                    reply: $reply,
                },
            )*
        ];
    };
}

commands! {
    get_settings_record => "commands::settings::get_settings_record": Async () -> "{ readonly record: Record<string, unknown>; readonly reset_fields: readonly string[]; readonly newer_read_only: boolean }",
    patch_settings_record => "commands::settings::patch_settings_record": Async (patch: "Record<string, unknown>") -> "void",
    search_species => "commands::species::search_species": Async (request: "SpeciesSearchRequest") -> "PaginatedResult<SpeciesListItem>",
    supersede_species_search => "commands::species::supersede_species_search": BoundedSync () -> "void",
    get_species_detail => "commands::species::get_species_detail": Async (canonicalName: "string", locale: "string") -> "SpeciesDetail",
    get_common_names => "commands::species::get_common_names": Async (canonicalNames: "readonly string[]", locale: "string") -> "Record<string, string>",
    get_species_habits => "commands::species::get_species_habits": Async (canonicalNames: "readonly string[]") -> "Record<string, string>",
    get_species_batch => "commands::species::get_species_batch": Async (canonicalNames: "readonly string[]", locale: "string") -> "SpeciesDetail[]",
    get_filter_options => "commands::species::get_filter_options": Async () -> "FilterOptions",
    get_dynamic_filter_options => "commands::species::get_dynamic_filter_options": Async (fields: "readonly string[]", locale: "string") -> "DynamicFilterOptions[]",
    get_species_images => "commands::species::get_species_images": Async (canonicalName: "string") -> "SpeciesImage[]",
    get_locale_common_names => "commands::species::get_locale_common_names": Async (canonicalName: "string", locale: "string") -> "CommonNameEntry[]",
    get_cached_image_path => "commands::species::get_cached_image_path": Async (url: "string") -> "string",
    toggle_favorite => "commands::favorites::toggle_favorite": Async (canonicalName: "string") -> "boolean",
    get_favorites => "commands::favorites::get_favorites": Async (locale: "string") -> "SpeciesListItem[]",
    get_recently_viewed => "commands::favorites::get_recently_viewed": Async (locale: "string", limit: "number") -> "SpeciesListItem[]",
    get_saved_object_stamps => "commands::saved_object_stamps::get_saved_object_stamps": Async () -> "SavedObjectStamp[]",
    create_saved_object_stamp => "commands::saved_object_stamps::create_saved_object_stamp": Async (name: "string", payloadJson: "string") -> "SavedObjectStamp",
    rename_saved_object_stamp => "commands::saved_object_stamps::rename_saved_object_stamp": Async (id: "string", name: "string") -> "SavedObjectStamp",
    delete_saved_object_stamp => "commands::saved_object_stamps::delete_saved_object_stamp": Async (id: "string") -> "boolean",
    restore_saved_object_stamp => "commands::saved_object_stamps::restore_saved_object_stamp": Async (stamp: "SavedObjectStamp") -> "SavedObjectStamp",
    reorder_saved_object_stamps => "commands::saved_object_stamps::reorder_saved_object_stamps": Async (ids: "readonly string[]") -> "SavedObjectStamp[]",
    export_saved_object_stamp_canopi_file => "commands::saved_object_stamps::export_saved_object_stamp_canopi_file": Async (path: "string", content: "Record<string, unknown>") -> "string",
    load_saved_object_stamp_canopi_file => "commands::saved_object_stamps::load_saved_object_stamp_canopi_file": Async (path: "string") -> "CanopiFileV10",
    get_recent_files => "commands::design::get_recent_files": Async () -> "DesignSummary[]",
    get_recent_design_previews => "commands::design::get_recent_design_previews": Async (paths: "readonly string[]") -> "RecentDesignSummary[]",
    remove_recent_design => "commands::design::remove_recent_design": Async (path: "string") -> "void",
    show_recent_design_in_folder => "commands::design::show_recent_design_in_folder": Async (path: "string") -> "void",
    list_design_drafts => "commands::design::list_design_drafts": Async () -> "DesignDraftSummary[]",
    delete_design_draft => "commands::design::delete_design_draft": Async (id: "string") -> "void",
    design_core_version => "commands::design_core::design_core_version": Async () -> "string",
    design_core_decode => "commands::design_core::design_core_decode": Async (bytes: "readonly number[]") -> "FormatDecodeAnswer",
    design_core_encode => "commands::design_core::design_core_encode": Async (design: "unknown") -> "{ ok: number[] } | { err: FormatRefusal }",
    design_core_new_design => "commands::design_core::design_core_new_design": Async (input: "NewDesignInputContract") -> "Record<string, unknown>",
    design_core_draft_summary => "commands::design_core::design_core_draft_summary": Async (bytes: "readonly number[]", updatedAt: "string") -> "DraftSummaryOutcome",
    design_core_decode_stamp => "commands::design_core::design_core_decode_stamp": Async (payloadJson: "string") -> "{ ok: SavedObjectStampPayload } | { err: unknown }",
    design_core_encode_stamp => "commands::design_core::design_core_encode_stamp": Async (payload: "SavedObjectStampPayload") -> "{ ok: string } | { err: unknown }",
    design_core_stamp_to_canopi => "commands::design_core::design_core_stamp_to_canopi": Async (payload: "SavedObjectStampPayload", name: "string", origin: "GeoPointV10") -> "{ ok: number[] } | { err: FormatRefusal }",
    design_core_canopi_to_stamp => "commands::design_core::design_core_canopi_to_stamp": Async (bytes: "readonly number[]", origin: "GeoPointV10") -> "{ ok: SavedObjectStampPayload } | { err: unknown }",
    get_design_notebook => "commands::design_notebook::get_design_notebook": Async () -> "DesignNotebookSnapshot",
    create_notebook_section => "commands::design_notebook::create_notebook_section": Async (name: "string") -> "DesignNotebookSection",
    add_design_reference_to_notebook => "commands::design_notebook::add_design_reference_to_notebook": Async (path: "string", content: "CanopiFileV10") -> "void",
    rename_notebook_section => "commands::design_notebook::rename_notebook_section": Async (sectionId: "string", name: "string") -> "void",
    delete_notebook_section => "commands::design_notebook::delete_notebook_section": Async (sectionId: "string") -> "void",
    move_design_reference_to_section => "commands::design_notebook::move_design_reference_to_section": Async (path: "string", sectionId? opt: "string | null") -> "void",
    remove_design_reference => "commands::design_notebook::remove_design_reference": Async (path: "string") -> "void",
    reorder_notebook_sections => "commands::design_notebook::reorder_notebook_sections": Async (sectionIds: "readonly string[]") -> "void",
    reorder_design_references => "commands::design_notebook::reorder_design_references": Async (paths: "readonly string[]") -> "void",
    relocate_design_reference => "commands::design_notebook::relocate_design_reference": Async (path: "string", sectionId? opt: "string | null", paths: "readonly string[]") -> "void",
    deliver_file => "commands::export::deliver_file": Async () -> "string",
    pick_geojson_file => "commands::export::pick_geojson_file": Async (extensions? opt: "readonly string[]") -> "GeoJsonSource | null",
    get_health => "commands::health::get_health": BoundedSync () -> "SubsystemHealth",
    dismiss_store_notice => "commands::health::dismiss_store_notice": BoundedSync (store: "StoreId") -> "void",
    take_pending_open => "commands::host::take_pending_open": BoundedSync () -> "PendingOpen | null",
    home_read => "commands::host::home_read": Async (key: "string") -> "HomeRead",
    home_write => "commands::host::home_write": Async (key: "string", bytes: "readonly number[]", expected? opt: "HomeVersion | null", keepPrevious? opt: "boolean | null") -> "HomeWrite",
    grant_for_recent => "commands::host::grant_for_recent": Async (recentId: "string") -> "FileHomeGrant | null",
    pick_open => "commands::host::pick_open": Async (kind: "DialogKind") -> "PickOpenOutcome",
    pick_save => "commands::host::pick_save": Async (kind: "DialogKind", stem: "string") -> "PickSaveOutcome",
    update_check => "commands::update::update_check": Async (operation: "string") -> "UpdateOffer | null",
    update_download => "commands::update::update_download": Async (operation: "string", progress: "unknown") -> "UpdateDownload",
    update_install => "commands::update::update_install": Async () -> "void",
    update_cancel => "commands::update::update_cancel": BoundedSync (operation: "string") -> "void",
    update_restart => "commands::update::update_restart": BoundedSync () -> "void",
    update_take_launch_notice => "commands::update::update_take_launch_notice": Async () -> "boolean",
    create_problem_report => "commands::problem_report::create_problem_report": Async (request: "ProblemReportRequest") -> "ProblemReportResult",
    show_problem_report_folder => "commands::problem_report::show_problem_report_folder": Async (fileName: "string") -> "void",
    get_app_folders => "commands::app_folders::get_app_folders": Async () -> "AppFolderLocations",
    show_app_folder => "commands::app_folders::show_app_folder": Async (folder: "AppFolder") -> "void",
    geocoder_fetch => "commands::geocoding::geocoder_fetch": Async (url: "string") -> "string",
    lidar_list_library => "commands::lidar::lidar_list_library": Async () -> "LibrarySnapshot",
    lidar_rename_item => "commands::lidar::lidar_rename_item": Async (itemId: "string", name: "string") -> "void",
    lidar_delete_impact => "commands::lidar::lidar_delete_impact": Async (itemId: "string") -> "LibraryDeleteImpact",
    lidar_delete_item => "commands::lidar::lidar_delete_item": Async (itemId: "string") -> "void",
    lidar_cancel_import => "commands::lidar::lidar_cancel_import": Async (jobId: "string") -> "void",
    lidar_create_analysis => "commands::lidar::lidar_create_analysis": Async (request: "AnalysisRequest") -> "AnalysisReceipt",
    lidar_rerun_analysis => "commands::lidar::lidar_rerun_analysis": Async (definitionId: "string") -> "AnalysisReceipt",
    lidar_processing_history => "commands::lidar::lidar_processing_history": Async (definitionId: "string", cursor? opt: "string | null") -> "ProcessingHistoryPage",
    lidar_cancel_analysis_job => "commands::lidar::lidar_cancel_analysis_job": BoundedSync (jobId: "string") -> "void",
    lidar_sample_points => "commands::lidar::lidar_sample_points": Async (request: "LidarSamplePointsRequest") -> "LidarSampleSeries[]",
    lidar_display_descriptor => "commands::lidar::lidar_display_descriptor": Async (request: "LidarDisplayRequest") -> "LidarDisplayDescriptor",
    lidar_import_item => "commands::lidar::lidar_import_item": Async (name: "string", quantity: "RasterQuantity", unitLabel? opt: "string | null", unitUnknown? opt: "boolean | null", paths: "readonly string[]") -> "LidarImportReceipt",
    lidar_retry_import => "commands::lidar::lidar_retry_import": Async (layerId: "string") -> "LidarImportReceipt",
    lidar_dismiss_import => "commands::lidar::lidar_dismiss_import": Async (layerId: "string") -> "void",
    lidar_layer_collection => "commands::lidar::lidar_layer_collection": Async (layerId: "string", cursor? opt: "string | null") -> "LidarLayerCollection",
    lidar_import_coverage => "commands::lidar::lidar_import_coverage": Async (paths: "readonly string[]") -> "LidarImportCoverage",
    lidar_library_disk_usage => "commands::lidar::lidar_library_disk_usage": Async () -> "number",
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn command_names_and_paths_are_unique_and_consistent() {
        let mut names = BTreeSet::new();
        for row in ALL_COMMANDS {
            assert!(names.insert(row.name), "duplicate command {}", row.name);
            assert!(
                row.path.ends_with(&format!("::{}", row.name)),
                "path {} must end with ::{}",
                row.path,
                row.name
            );
        }
        assert_eq!(names.len(), 87);
    }
}
