// Tests may start threads freely; production threads and blocking pools are
// disallowed in clippy.toml (native_command_policy::tests).
#![cfg_attr(test, allow(clippy::disallowed_methods))]

#[cfg(test)]
mod ci_lane_policy;
mod commands;
mod db;
mod design;
mod host;
mod http;
mod image_cache;
mod logging;
#[cfg(test)]
mod module_layering;
#[cfg(test)]
mod native_command_policy;
mod native_operation;
mod services;
#[cfg(test)]
mod test_scratch;
use common_types::health::{LocalDataStatus, SubsystemHealth};
use rusqlite::{Connection, OpenFlags};
use tauri::Manager;

pub struct AppHealth(pub SubsystemHealth);

const PLANT_DB_BUNDLED_PATH: &str = "resources/canopi-core.db";

fn resolve_plant_db_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<std::path::PathBuf> {
    // Tauri resource resolution uses the same relative path as
    // `tauri.conf.json > bundle > resources`, which keeps the `resources/` prefix.
    app.path()
        .resolve(PLANT_DB_BUNDLED_PATH, tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
        .or_else(dev_plant_db_path)
}

/// Debug builds run from the repository, where `scripts/prepare-db.py` leaves
/// the DB under `desktop/resources/`. A release build never looks outside its
/// bundle.
#[cfg(debug_assertions)]
fn dev_plant_db_path() -> Option<std::path::PathBuf> {
    Some(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("canopi-core.db"),
    )
    .filter(|path| path.exists())
}

#[cfg(not(debug_assertions))]
fn dev_plant_db_path() -> Option<std::path::PathBuf> {
    None
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_dialog::init());

    // Localhost only: the bridge can execute script in the webview.
    #[cfg(all(debug_assertions, feature = "mcp-bridge"))]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init_with_config(
        tauri_plugin_mcp_bridge::Config::localhost_only(),
    ));

    #[expect(
        clippy::disallowed_methods,
        reason = "Tauri's generated context builds itself on a startup thread it joins at once"
    )]
    let context = tauri::generate_context!();
    let context = host::e2e_context(context);
    let result = builder
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::species::search_species,
            commands::species::supersede_species_search,
            commands::species::get_species_detail,
            commands::species::get_common_names,
            commands::species::get_species_habits,
            commands::species::get_species_batch,
            commands::species::get_flower_color_batch,
            commands::species::get_filter_options,
            commands::species::get_dynamic_filter_options,
            commands::species::get_species_images,
            commands::species::get_locale_common_names,
            commands::species::get_cached_image_path,
            commands::favorites::toggle_favorite,
            commands::favorites::get_favorites,
            commands::favorites::get_recently_viewed,
            commands::saved_object_stamps::get_saved_object_stamps,
            commands::saved_object_stamps::create_saved_object_stamp,
            commands::saved_object_stamps::rename_saved_object_stamp,
            commands::saved_object_stamps::delete_saved_object_stamp,
            commands::saved_object_stamps::reorder_saved_object_stamps,
            commands::saved_object_stamps::export_saved_object_stamp_canopi_file,
            commands::saved_object_stamps::load_saved_object_stamp_canopi_file,
            commands::design::new_design,
            commands::design::save_design,
            commands::design::load_design,
            commands::design::get_recent_files,
            commands::design::get_recent_design_previews,
            commands::design::remove_recent_design,
            commands::design::show_recent_design_in_folder,
            commands::design::save_design_draft,
            commands::design::load_design_draft,
            commands::design::list_design_drafts,
            commands::design::delete_design_draft,
            commands::design_notebook::get_design_notebook,
            commands::design_notebook::create_notebook_section,
            commands::design_notebook::add_design_reference_to_notebook,
            commands::design_notebook::rename_notebook_section,
            commands::design_notebook::delete_notebook_section,
            commands::design_notebook::move_design_reference_to_section,
            commands::design_notebook::remove_design_reference,
            commands::design_notebook::reorder_notebook_sections,
            commands::design_notebook::reorder_design_references,
            commands::design_notebook::relocate_design_reference,
            commands::export::export_file,
            commands::export::pick_geojson_file,
            commands::export::save_canvas_pdf,
            commands::health::get_health,
            commands::problem_report::create_problem_report,
            commands::problem_report::show_problem_report_folder,
            commands::app_folders::get_app_folders,
            commands::app_folders::show_app_folder,
            commands::geocoding::geocode_address,
            commands::lidar::lidar_list_library,
            commands::lidar::lidar_rename_item,
            commands::lidar::lidar_delete_impact,
            commands::lidar::lidar_import_coverage,
            commands::lidar::lidar_library_disk_usage,
            commands::lidar::lidar_delete_item,
            commands::lidar::lidar_cancel_import,
            commands::lidar::lidar_create_analysis,
            commands::lidar::lidar_rerun_analysis,
            commands::lidar::lidar_processing_history,
            commands::lidar::lidar_cancel_analysis_job,
            commands::lidar::lidar_sample_points,
            commands::lidar::lidar_display_descriptor,
            commands::lidar::lidar_import_item,
            commands::lidar::lidar_retry_import,
            commands::lidar::lidar_dismiss_import,
            commands::lidar::lidar_layer_collection,
        ])
        .setup(|app| {
            // Logging
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            logging::init(&log_dir);
            tracing::info!("Canopi starting");
            build_main_window(app.handle())?;

            let native_executor = native_operation::NativeOperationExecutor::production();
            app.manage(native_executor.clone());
            tracing::info!("Native operation executor initialized");

            // User DB (writable, in app data dir)
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(design::drafts::DesignDrafts::new(&data_dir));
            app.manage(services::recent_design_previews::RecentDesignPreviews::default());
            let (user_db, local_data_status) = match open_user_data(&data_dir) {
                Ok(opened) => opened,
                Err(error) => {
                    // A user database this Canopi cannot own (written by a newer
                    // version) is refused, never modified: tell the user and exit
                    // instead of panicking or showing a half-working window.
                    if let Some(message) = startup_refusal_message(&error) {
                        tracing::error!("User DB refused at startup");
                        refuse_startup(app, message);
                        return Ok(());
                    }
                    return Err(format!("Failed to initialize user DB: {error}").into());
                }
            };
            app.manage(user_db);

            tracing::info!("User DB initialized");

            // LiDAR library (dedicated catalogue, managed raster assets). A bad
            // catalogue never stops startup: the library opens recovered or
            // refused and its status says which (`services::lidar::recovery`).
            let lidar_library = services::lidar::LidarLibrary::open(&data_dir)
                .map_err(|e| format!("Failed to initialize LiDAR library: {e}"))?;
            lidar_library.attach_executor(native_executor);
            tracing::info!(status = ?lidar_library.open_status(), "LiDAR library initialized");
            let lidar_library_status = lidar_library.open_status().health();
            app.manage(lidar_library);

            // Image cache (disk-backed, in app data dir)
            let image_cache = match image_cache::ImageCache::new(&data_dir) {
                Ok(cache) => cache,
                Err(error) => {
                    tracing::warn!("Image cache init failed: {error}, using temp dir fallback");
                    image_cache::ImageCache::new(&std::env::temp_dir()).map_err(|fallback| {
                        format!("Failed to initialize image cache: {error}; temp dir fallback: {fallback}")
                    })?
                }
            };
            app.manage(image_cache);
            tracing::info!("Image cache initialized");

            // Plant DB (read-only, bundled resource)
            let plant_db_path = resolve_plant_db_path(app.handle());

            let plant_db = match plant_db_path {
                Some(path) => {
                    match Connection::open_with_flags(
                        &path,
                        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                    ) {
                        Ok(plant_conn) => {
                            if let Err(e) = plant_conn.pragma_update(None, "mmap_size", 268435456_i64) {
                                tracing::warn!("Failed to set plant DB mmap_size: {e}");
                            }
                            if let Err(e) = plant_conn.pragma_update(None, "cache_size", -64000_i64) {
                                tracing::warn!("Failed to set plant DB cache_size: {e}");
                            }
                            let plant_db = db::PlantDb::available(plant_conn);
                            if plant_db.status() == common_types::health::PlantDbStatus::Available {
                                tracing::info!("Plant DB admitted at {}", path.display());
                            }
                            plant_db
                        }
                        Err(e) => {
                            tracing::error!("Failed to open plant DB at {}: {e}. Species search unavailable.", path.display());
                            db::PlantDb::corrupt()
                        }
                    }
                }
                None => {
                    tracing::error!("Plant DB not found. Run scripts/prepare-db.py first. Species search unavailable.");
                    db::PlantDb::missing()
                }
            };
            let plant_db_status = plant_db.status();
            app.manage(plant_db);
            app.manage(services::plant_browser::SpeciesSearchCancellation::default());

            app.manage(AppHealth(SubsystemHealth {
                plant_db: plant_db_status,
                lidar_library: lidar_library_status,
                local_data: local_data_status,
            }));

            Ok(())
        })
        .run(context);
    if let Err(error) = result {
        tracing::error!("Canopi failed to run: {error}");
        eprintln!("Canopi failed to run: {error}");
        std::process::exit(1);
    }
}

/// The main window, built here rather than by Tauri (`"create": false` in
/// `tauri.conf.json`) so its webview carries the navigation guard: it loads only
/// the app's own origins, and http, https and mailto links, followed in place or
/// asked for in a new window, go to `open_link_in_system` (`services::external_links`).
fn build_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    use services::external_links::{AppOrigins, follow_navigation, follow_new_window};
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let origins = AppOrigins::new(tauri::is_dev(), app.config().build.dev_url.as_ref());
    let window_origins = origins.clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| follow_navigation(url, &origins, open_link_in_system))
        .on_new_window(move |url, _features| {
            follow_new_window(&url, &window_origins, open_link_in_system);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}

/// Hand a link to the system browser or mail client; true when it opened.
fn open_link_in_system(url: &tauri::Url) -> bool {
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).is_ok()
}

/// Open the user database in `data_dir`.
///
/// Canopi 2.0 breaks stored data (ADR 0021): a user database from before 2.0
/// is renamed, since 2.0 needs its path, and the returned status tells the
/// user once. Drafts in an earlier format and the retired 1.x autosave store
/// stay where they are, unread, and are not reported (U59).
fn open_user_data(
    data_dir: &std::path::Path,
) -> Result<(db::UserDb, LocalDataStatus), db::UserDbInitError> {
    let (user_db, opened) = db::UserDb::open(data_dir.join("user.db"))?;
    let status = if opened == db::UserDbOpened::MovedAside {
        LocalDataStatus::MovedAside
    } else {
        LocalDataStatus::Current
    };
    Ok((user_db, status))
}

/// The message for a startup failure the user can act on, or `None` when the
/// failure is an internal error.
fn startup_refusal_message(error: &db::UserDbInitError) -> Option<String> {
    match error {
        db::UserDbInitError::NewerSchemaVersion { .. } => Some(
            "Your Canopi data was saved by a newer version of Canopi. \
             Install the latest Canopi to open it; this version will not change it."
                .to_string(),
        ),
        db::UserDbInitError::SetAside { .. } => Some(
            "Canopi could not move its earlier data file aside to start fresh. \
             Check that the Canopi data folder can be written to, then start Canopi again."
                .to_string(),
        ),
        _ => None,
    }
}

fn refuse_startup(app: &tauri::App, message: String) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let handle = app.handle().clone();
    app.dialog()
        .message(message)
        .title("Canopi")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

#[cfg(test)]
mod tests {
    #[test]
    fn refused_user_databases_get_a_message_and_internal_errors_do_not() {
        let newer = super::db::UserDbInitError::NewerSchemaVersion {
            found: 99,
            supported: 9,
        };
        let message = super::startup_refusal_message(&newer).expect("newer data is refused");
        assert!(message.contains("newer version of Canopi"));
        let set_aside = super::db::UserDbInitError::SetAside {
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        };
        assert!(
            super::startup_refusal_message(&set_aside)
                .expect("a failed move aside is explained")
                .contains("can be written to")
        );
        let internal = super::db::UserDbInitError::ForeignKeysDisabled;
        assert!(super::startup_refusal_message(&internal).is_none());
    }

    #[test]
    fn a_fresh_data_folder_opens_as_current() {
        let data_dir = super::test_scratch::TestScratch::new("startup-fresh");

        let (user_db, status) = super::open_user_data(&data_dir).expect("a fresh folder opens");
        drop(user_db);

        assert_eq!(status, super::LocalDataStatus::Current);
    }

    /// Canopi 2.0 breaks stored data (ADR 0021): a user database from before
    /// 2.0 is renamed, since 2.0 needs its path, and the user is told once.
    #[test]
    fn an_earlier_user_database_is_moved_aside_and_reported_once() {
        let data_dir = super::test_scratch::TestScratch::new("startup-earlier-user-db");
        let connection = rusqlite::Connection::open(data_dir.join("user.db")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 PRAGMA user_version = 8;",
            )
            .unwrap();
        drop(connection);

        let (user_db, status) = super::open_user_data(&data_dir).expect("earlier data opens");
        drop(user_db);
        assert_eq!(status, super::LocalDataStatus::MovedAside);

        let (user_db, again) = super::open_user_data(&data_dir).expect("current data opens");
        drop(user_db);
        assert_eq!(again, super::LocalDataStatus::Current, "told once");
    }

    /// Drafts in an earlier format and the retired 1.x autosave store stay
    /// where they are, unread and unchanged, on every start, and are not
    /// reported: only the renamed user database is (U59).
    #[test]
    fn earlier_drafts_and_autosave_stay_in_place_and_are_not_reported() {
        let data_dir = super::test_scratch::TestScratch::new("startup-earlier-drafts");
        let drafts = data_dir.join("drafts");
        std::fs::create_dir(&drafts).unwrap();
        let mut value = serde_json::to_value(super::design::format::create_new_design(
            "Preview",
            "2026-09-25T00:00:00Z",
        ))
        .unwrap();
        value["version"] = serde_json::json!(8);
        let older = value.to_string();
        std::fs::write(drafts.join("old.canopi"), &older).unwrap();
        let autosave = data_dir.join("autosave");
        std::fs::create_dir(&autosave).unwrap();
        std::fs::write(autosave.join("recovery.canopi"), "unsaved work").unwrap();

        for start in ["first", "second"] {
            let (user_db, status) = super::open_user_data(&data_dir).expect("the folder opens");
            drop(user_db);
            assert_eq!(status, super::LocalDataStatus::Current, "{start} start");
            assert_eq!(
                std::fs::read_to_string(drafts.join("old.canopi")).unwrap(),
                older
            );
            assert_eq!(
                std::fs::read_to_string(autosave.join("recovery.canopi")).unwrap(),
                "unsaved work"
            );
            let mut entries = std::fs::read_dir(&data_dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| !name.starts_with("user.db"))
                .collect::<Vec<_>>();
            entries.sort();
            assert_eq!(
                entries,
                ["autosave", "drafts"],
                "{start} start moves nothing"
            );
        }
    }

    /// 2.1-M54: a capability file that gains a permission fails this test, so
    /// a new grant to the webview is always a reviewed change.
    #[test]
    fn canopi_eon8_14_4_each_capability_file_grants_exactly_its_expected_permissions() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut found = std::collections::BTreeMap::new();
        for folder in ["capabilities", "capabilities-dev"] {
            for entry in std::fs::read_dir(manifest_dir.join(folder)).unwrap() {
                let path = entry.unwrap().path();
                let file: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                let name = format!("{folder}/{}", path.file_name().unwrap().to_string_lossy());
                assert_eq!(file["windows"], serde_json::json!(["main"]), "{name}");
                found.insert(
                    (name, file["identifier"].as_str().unwrap().to_owned()),
                    file["permissions"].clone(),
                );
            }
        }
        let expected = std::collections::BTreeMap::from([
            (
                (
                    "capabilities/main-window.json".to_owned(),
                    "main-window".to_owned(),
                ),
                serde_json::json!([
                    "core:event:allow-listen",
                    "core:event:allow-unlisten",
                    "core:window:allow-start-dragging",
                    "core:window:allow-minimize",
                    "core:window:allow-toggle-maximize",
                    "core:window:allow-close",
                    "core:window:allow-destroy",
                    "dialog:allow-open",
                    "dialog:allow-save",
                    "dialog:allow-message",
                ]),
            ),
            (
                (
                    "capabilities-dev/mcp-bridge-dev.json".to_owned(),
                    "mcp-bridge-dev".to_owned(),
                ),
                serde_json::json!(["mcp-bridge:default", "core:event:allow-emit"]),
            ),
        ]);
        assert_eq!(found, expected);
    }

    /// 2.1-M171: the asset scope the app really builds (tauri.conf.json through
    /// a mock app) serves published display COGs and cached images, and
    /// refuses a display COG still being written in `display-cog-staging`
    /// and every other app data file. Paths are only matched, never created.
    #[test]
    fn canopi_eon8_14_4_asset_protocol_the_real_scope_serves_display_cogs_and_the_image_cache_and_refuses_display_cog_staging()
     {
        #[expect(
            clippy::disallowed_methods,
            reason = "Tauri's generated context builds itself on a startup thread it joins at once"
        )]
        let context = tauri::generate_context!(test = true);
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("the mock app builds from the real configuration");
        use tauri::Manager as _;
        let scope = app.asset_protocol_scope();
        let data_dir = app.path().app_data_dir().expect("app data dir");
        let lidar = super::services::lidar::paths::library_root(&data_dir);

        for served in [
            lidar.join("display-cog").join("eon8-probe-3857.tif"),
            data_dir.join("image-cache").join("eon8-probe.jpg"),
            data_dir
                .join("image-cache")
                .join("ab")
                .join("eon8-probe.webp"),
        ] {
            assert!(scope.is_allowed(&served), "served: {}", served.display());
        }
        for refused in [
            lidar
                .join("display-cog-staging")
                .join("eon8-probe-3857.tif"),
            lidar
                .join("display-cog")
                .join("nested")
                .join("eon8-probe.tif"),
            lidar.join("display-cog").join("eon8-probe.json"),
            lidar.join("assets").join("eon8-probe").join("cog.tif"),
            lidar.join("lidar-library.sqlite"),
            data_dir.join("user.db"),
        ] {
            assert!(
                !scope.is_allowed(&refused),
                "refused: {}",
                refused.display()
            );
        }
    }

    /// 2.1-Q180: Tauri creates no window from the configuration; the app builds
    /// the one main window, with the navigation guard, from the real config.
    #[test]
    fn canopi_eon8_14_5_the_main_window_is_built_once_from_the_real_config_with_the_guard() {
        use tauri::Manager as _;
        #[expect(
            clippy::disallowed_methods,
            reason = "Tauri's generated context builds itself on a startup thread it joins at once"
        )]
        let context = tauri::generate_context!(test = true);
        let main = context
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .expect("tauri.conf.json declares the main window");
        assert!(
            !main.create,
            "Tauri must not create the unguarded main window"
        );
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("the mock app builds from the real configuration");
        assert!(app.webview_windows().is_empty());

        let window = super::build_main_window(app.handle()).expect("the main window builds");

        assert_eq!(window.label(), "main");
        assert_eq!(
            app.webview_windows().keys().cloned().collect::<Vec<_>>(),
            ["main"]
        );
    }

    #[test]
    fn global_tauri_api_and_bridge_capability_exist_only_for_the_debug_bridge() {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!(test = true);
        let dev_bridge = cfg!(all(debug_assertions, feature = "mcp-bridge"));
        assert_eq!(context.config().app.with_global_tauri, dev_bridge);
        let capabilities = context
            .config()
            .app
            .security
            .capabilities
            .iter()
            .map(|capability| match capability {
                tauri::utils::config::CapabilityEntry::Reference(identifier) => identifier.clone(),
                tauri::utils::config::CapabilityEntry::Inlined(capability) => {
                    capability.identifier.clone()
                }
            })
            .collect::<Vec<_>>();
        let mut expected = vec!["main-window".to_owned()];
        if dev_bridge {
            expected.push("mcp-bridge-dev".to_owned());
        }
        assert_eq!(capabilities, expected);
    }
}
