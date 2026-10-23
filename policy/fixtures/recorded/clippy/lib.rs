// Recorded from desktop/src/lib.rs at fa9e24f91 (lines 60-80 and 495-560): three statement-level #[expect]s.
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
    let result = builder
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::species::search_species,
}
fn excerpt() {
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
