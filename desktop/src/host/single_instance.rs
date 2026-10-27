//! The one module that names `tauri_plugin_single_instance`: a second launch hands its arguments
//! and folder to the running Canopi ([`super::launch::on_second_launch`]) and exits (2.1-M214).
//!
//! Pinned 2.5 behaviours (2.1-M80, `desktop/web/e2e/platform/desktop/single-instance.spec.ts`):
//! on Linux with no session bus the plugin logs a warning and a second instance starts; on
//! Windows a second launch waits at most 10 s for the first to take its arguments; a `|` inside
//! an argument arrives intact.

/// The plugin, registered first so a second launch exits before anything else starts.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(super::launch::on_second_launch)
}

/// Releases the single-instance name before the process ends outside Tauri's exit event, so the
/// next launch is not mistaken for a second instance; the update restart calls it (2.1-M209,
/// contracts §3).
pub fn release<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    tauri_plugin_single_instance::destroy(app);
}
