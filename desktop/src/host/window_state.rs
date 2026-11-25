//! Desktop window geometry persistence (`2.1-Q144`, `2.1-Q367`, `2.1-M135`).
//!
//! Uses `tauri-plugin-window-state` in the app config folder, driven strictly from Rust
//! (no webview capability grant). The main window starts hidden (`visible(false)`),
//! restores its saved geometry before showing so it never jumps on screen, and falls
//! back cleanly to the primary monitor or default window if the saved state is off-screen
//! or unreadable. Window geometry never enters a Problem Report.

use tauri::{PhysicalPosition, Runtime, WebviewWindow, plugin::TauriPlugin};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags, WindowExt as _};

/// Filename used in `app_config_dir()` to persist Desktop window geometry.
pub const WINDOW_STATE_FILENAME: &str = "window-state.json";

/// Geometry flags restored and saved; `VISIBLE` is omitted so the main window always
/// starts hidden, restores geometry, and then shows explicitly without risking a stuck
/// hidden window after an interrupted launch.
pub const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::DECORATIONS)
    .union(StateFlags::FULLSCREEN);

/// Registers `tauri-plugin-window-state` with Canopi's filename and geometry flags.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    WindowStateBuilder::default()
        .with_filename(WINDOW_STATE_FILENAME)
        .with_state_flags(WINDOW_STATE_FLAGS)
        .build()
}

/// Axis-aligned rectangle in physical pixels used for off-screen monitor checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl ScreenRect {
    /// Returns true if any corner of `window` lies inside `self`.
    pub fn contains_any_corner(self, window: ScreenRect) -> bool {
        let left = self.x;
        let right = self
            .x
            .saturating_add(self.width.min(i32::MAX as u32) as i32);
        let top = self.y;
        let bottom = self
            .y
            .saturating_add(self.height.min(i32::MAX as u32) as i32);
        let wx2 = window
            .x
            .saturating_add(window.width.min(i32::MAX as u32) as i32);
        let wy2 = window
            .y
            .saturating_add(window.height.min(i32::MAX as u32) as i32);
        [
            (window.x, window.y),
            (wx2, window.y),
            (window.x, wy2),
            (wx2, wy2),
        ]
        .into_iter()
        .any(|(cx, cy)| cx >= left && cx < right && cy >= top && cy < bottom)
    }
}

/// If `window` intersects none of `monitors`, returns a centred position on `primary`
/// (clamped inside `primary`). Returns `None` when the window is already on-screen or no
/// primary monitor is known.
pub fn on_screen_fallback_position(
    window: ScreenRect,
    monitors: &[ScreenRect],
    primary: Option<ScreenRect>,
) -> Option<(i32, i32)> {
    if monitors.is_empty() || monitors.iter().any(|m| m.contains_any_corner(window)) {
        return None;
    }
    let target = primary.or_else(|| monitors.first().copied())?;
    let dx = (target.width.saturating_sub(window.width) / 2).min(i32::MAX as u32) as i32;
    let dy = (target.height.saturating_sub(window.height) / 2).min(i32::MAX as u32) as i32;
    Some((target.x.saturating_add(dx), target.y.saturating_add(dy)))
}

/// Restores saved geometry on `window` (built hidden), moves it onto the primary screen
/// if it landed off every available monitor, and then shows it (`2.1-Q144`, `2.1-M135`).
pub fn restore_and_show_main_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.restore_state(WINDOW_STATE_FLAGS);
    if let (Ok(pos), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) {
        let win_rect = ScreenRect {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        };
        let to_rect = |m: &tauri::Monitor| ScreenRect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        };
        let monitor_rects: Vec<ScreenRect> = monitors.iter().map(to_rect).collect();
        let primary_rect = window.primary_monitor().ok().flatten().map(|m| to_rect(&m));
        if let Some((x, y)) = on_screen_fallback_position(win_rect, &monitor_rects, primary_rect) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::problem_report::{ProblemReportContext, create_problem_report};
    use crate::test_scratch::TestScratch;
    use canopi_types::support::ProblemReportRequest;
    use tauri::Manager as _;
    use tauri_plugin_window_state::AppHandleExt as _;

    fn mock_app_in_profile(profile: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(profile.to_path_buf()),
        );
        tauri::test::mock_builder()
            .plugin(plugin())
            .build(context)
            .expect("mock app with window-state plugin builds")
    }

    /// 2.1-M135: saved window state survives relaunch (written to config dir and loaded back).
    #[test]
    fn window_state_survives_relaunch_in_profile() {
        let profile = TestScratch::new("window-state-relaunch");
        {
            let app = mock_app_in_profile(profile.path());
            let _window =
                tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
                    .inner_size(1280.0, 820.0)
                    .visible(false)
                    .build()
                    .expect("main window builds");
            app.handle()
                .save_window_state(WINDOW_STATE_FLAGS)
                .expect("save window state succeeds");
        }

        let config_dir = {
            let app = mock_app_in_profile(profile.path());
            app.path().app_config_dir().expect("config dir resolves")
        };
        let state_file = config_dir.join(WINDOW_STATE_FILENAME);
        assert!(
            state_file.exists(),
            "state file exists at {}",
            state_file.display()
        );
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&state_file).unwrap())
                .expect("state file is valid JSON");
        assert!(saved.get("main").is_some(), "main window entry persisted");

        // Second launch loads the saved state and shows cleanly without error.
        let app2 = mock_app_in_profile(profile.path());
        let window2 = tauri::WebviewWindowBuilder::new(&app2, "main", tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("main window builds on relaunch");
        restore_and_show_main_window(&window2);
        assert_eq!(app2.handle().filename(), WINDOW_STATE_FILENAME);
    }

    /// 2.1-M135: an unreadable window-state file opens the default window without error.
    #[test]
    fn unreadable_window_state_file_opens_default_window() {
        let profile = TestScratch::new("window-state-unreadable");
        let config_dir = {
            let app = mock_app_in_profile(profile.path());
            app.path().app_config_dir().unwrap()
        };
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join(WINDOW_STATE_FILENAME), "{corrupt json").unwrap();

        let app = mock_app_in_profile(profile.path());
        let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .inner_size(1024.0, 768.0)
            .visible(false)
            .build()
            .expect("default window builds despite unreadable state file");
        restore_and_show_main_window(&window);
        assert_eq!(window.label(), "main");
    }

    /// 2.1-M135: a window saved off every available screen reopens on the primary screen.
    #[test]
    fn window_saved_off_every_screen_reopens_on_primary_screen() {
        let primary = ScreenRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let secondary = ScreenRect {
            x: 1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let off_screen = ScreenRect {
            x: 9000,
            y: -4000,
            width: 1200,
            height: 800,
        };

        let fallback =
            on_screen_fallback_position(off_screen, &[primary, secondary], Some(primary));
        assert_eq!(fallback, Some((360, 140)));

        // A window already intersecting any screen keeps its saved coordinates.
        let on_secondary = ScreenRect {
            x: 2000,
            y: 100,
            width: 1200,
            height: 800,
        };
        assert_eq!(
            on_screen_fallback_position(on_secondary, &[primary, secondary], Some(primary)),
            None
        );
    }

    /// 2.1-M135: a Problem Report carries no window geometry from the window-state file.
    #[test]
    fn problem_report_contains_no_window_geometry() {
        let scratch = TestScratch::new("window-state-problem-report");
        let reports_folder = scratch.join("Problem reports");
        let sentinel_state = r#"{"main":{"width":1337,"height":9421,"x":4242,"y":3131,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;
        std::fs::write(scratch.join(WINDOW_STATE_FILENAME), sentinel_state).unwrap();

        let request = ProblemReportRequest {
            sections: vec![],
            current_design: None,
        };
        let context = ProblemReportContext {
            reports_folder: reports_folder.clone(),
            log_dir: None,
            app_data_dir: Some(scratch.path().to_path_buf()),
            timestamp_secs: 1_760_000_000,
            app_version: "2.1.0-beta.3".to_owned(),
            target: "linux/x86_64".to_owned(),
            webview_version: None,
            health: crate::services::health::all_ready(),
            settlements: vec![],
            library: Err("unused".to_owned()),
            library_disk_bytes: Err("unused".to_owned()),
        };

        let result = create_problem_report(&request, &context).expect("report builds");
        let zip_bytes = std::fs::read(reports_folder.join(&result.file_name)).unwrap();
        let text = String::from_utf8_lossy(&zip_bytes);
        for forbidden in ["window-state.json", "1337", "9421", "4242", "3131"] {
            assert!(
                !text.contains(forbidden),
                "problem report must not include window geometry sentinel {forbidden}"
            );
        }
    }
}
