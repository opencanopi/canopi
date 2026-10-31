//! Launch arguments: the Design file a launch asks Canopi to open (2.1-M214, M85, Q145).
//!
//! The first launch's arguments and every later launch the single-instance plugin forwards
//! (`host::single_instance`) go through one parser into one in-memory [`PendingOpenSlot`]; the
//! frontend pulls it with `take_pending_open` at boot and again on the payload-free
//! [`PENDING_OPEN_EVENT`]. A forwarded launch also brings the window to the front
//! ([`bring_to_front`]).

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The event a forwarded launch with a file emits; the frontend answers by pulling the slot.
pub const PENDING_OPEN_EVENT: &str = "launch:pending-open";

/// A Design file a launch asked to open: an absolute path when the launch gave a relative one,
/// and whether the launch named several files (the first opens; 2.1-Q228).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingOpen {
    pub path: String,
    pub several: bool,
}

/// One command-line argument as the launch delivered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchArgument {
    Text(String),
    /// Not valid Unicode: no path is guessed from it.
    NotUnicode,
}

impl LaunchArgument {
    /// An argument of this process's own launch (`std::env::args_os`).
    pub fn first_launch(argument: std::ffi::OsString) -> Self {
        argument.into_string().map_or(Self::NotUnicode, Self::Text)
    }

    /// An argument the single-instance plugin forwarded: it converts lossily (2.5.4), so a
    /// U+FFFD marks bytes that were not valid Unicode.
    pub fn forwarded(argument: String) -> Self {
        if argument.contains(char::REPLACEMENT_CHARACTER) {
            Self::NotUnicode
        } else {
            Self::Text(argument)
        }
    }
}

/// The file a launch asks to open, from its arguments (`args_os` order, so the executable first)
/// and the folder a relative path resolves against (`None` when that folder is not valid
/// Unicode). Every `--` flag is skipped, so a later flag needs no parser change (2.1-M209). An
/// argument that is not valid Unicode opens nothing and is logged without its path.
pub fn parse(
    arguments: impl IntoIterator<Item = LaunchArgument>,
    cwd: Option<&Path>,
) -> Option<PendingOpen> {
    let mut files = arguments.into_iter().skip(1).filter(
        |argument| !matches!(argument, LaunchArgument::Text(text) if text.starts_with("--")),
    );
    let first = files.next()?;
    let several = files.next().is_some();
    let LaunchArgument::Text(first) = first else {
        tracing::warn!("a launch argument is not valid Unicode; nothing opens");
        return None;
    };
    let path = PathBuf::from(first);
    let path = if path.is_absolute() {
        path
    } else {
        let Some(cwd) = cwd else {
            tracing::warn!("the launch folder is not valid Unicode; nothing opens");
            return None;
        };
        cwd.join(path)
    };
    let path = without_dot_parts(&path)
        .into_os_string()
        .into_string()
        .ok()?;
    Some(PendingOpen { path, several })
}

/// `path` with its `.` parts dropped and each `..` taking off the part before it, so one file
/// reaches Recent Designs (keyed by the exact path) under one path. Lexical, like a shell's
/// logical path: the file need not exist yet, and a symlinked folder is not followed.
fn without_dot_parts(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            // `pop` keeps the root: `/..` is `/`.
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    resolved
}

/// The one pending-open slot: the latest launch with a file wins, and a pull empties it.
#[derive(Debug, Default)]
pub struct PendingOpenSlot(std::sync::Mutex<Option<PendingOpen>>);

impl PendingOpenSlot {
    /// The slot holding this process's own launch file, if it named one.
    pub fn first_launch() -> Self {
        let cwd = std::env::current_dir()
            .ok()
            .filter(|cwd| cwd.to_str().is_some());
        let launch = parse(
            std::env::args_os().map(LaunchArgument::first_launch),
            cwd.as_deref(),
        );
        Self(std::sync::Mutex::new(launch))
    }

    /// Keeps `launch` when it names a file; true when it did.
    pub fn offer(&self, launch: Option<PendingOpen>) -> bool {
        let Some(launch) = launch else {
            return false;
        };
        *self.lock() = Some(launch);
        true
    }

    pub fn take(&self) -> Option<PendingOpen> {
        self.lock().take()
    }

    /// The slot holds one plain value that no panic leaves half written, so a poisoned lock is
    /// still read.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<PendingOpen>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// What a forwarded launch asks of the window.
pub trait WindowControl {
    fn unminimize(&self);
    fn show(&self);
    fn set_focus(&self);
    /// The nudge for compositors that refuse focus (GNOME on Wayland, 2.1-Q229).
    fn request_attention(&self);
}

/// Unminimises, shows and focuses the window, then asks for attention (2.1-M214, design-check A28).
pub fn bring_to_front(window: &impl WindowControl) {
    window.unminimize();
    window.show();
    window.set_focus();
    window.request_attention();
}

/// A launch the single-instance plugin forwarded (its arguments and folder, both converted
/// lossily): a file goes into the slot and the frontend is told to pull it, and the window comes
/// to the front whether or not the launch named a file (2.1-M60). A launch while Canopi boots
/// fills the slot before any window exists; the frontend's first pull returns it.
pub fn on_second_launch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    args: Vec<String>,
    cwd: String,
) {
    use tauri::{Emitter as _, Manager as _};
    let cwd = Some(PathBuf::from(cwd))
        .filter(|cwd| !cwd.to_string_lossy().contains(char::REPLACEMENT_CHARACTER));
    let launch = parse(
        args.into_iter().map(LaunchArgument::forwarded),
        cwd.as_deref(),
    );
    if let Some(slot) = app.try_state::<PendingOpenSlot>()
        && slot.offer(launch)
        && let Err(error) = app.emit(PENDING_OPEN_EVENT, ())
    {
        tracing::warn!("the pending-open event was not delivered: {error}");
    }
    if let Some(window) = app.get_webview_window("main") {
        bring_to_front(&window);
    }
}

/// The window's own calls; one that fails is logged and the next still runs.
impl<R: tauri::Runtime> WindowControl for tauri::WebviewWindow<R> {
    fn unminimize(&self) {
        log_window_failure("unminimize", tauri::WebviewWindow::unminimize(self));
    }
    fn show(&self) {
        log_window_failure("show", tauri::WebviewWindow::show(self));
    }
    fn set_focus(&self) {
        log_window_failure("set_focus", tauri::WebviewWindow::set_focus(self));
    }
    fn request_attention(&self) {
        log_window_failure(
            "request_user_attention",
            self.request_user_attention(Some(tauri::UserAttentionType::Informational)),
        );
    }
}

fn log_window_failure(call: &str, result: tauri::Result<()>) {
    if let Err(error) = result {
        tracing::warn!("bringing the window to the front: {call} failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn text(arguments: &[&str]) -> Vec<LaunchArgument> {
        arguments
            .iter()
            .map(|argument| LaunchArgument::Text((*argument).to_owned()))
            .collect()
    }

    fn opens(path: &str, several: bool) -> Option<PendingOpen> {
        Some(PendingOpen {
            path: path.to_owned(),
            several,
        })
    }

    fn cwd() -> PathBuf {
        std::env::temp_dir().join("canopi-launch-cwd")
    }

    fn absolute(name: &str) -> String {
        cwd().join(name).to_str().unwrap().to_owned()
    }

    #[test]
    fn canopi_f47t_52_228_14_the_executable_and_every_flag_are_skipped() {
        let design = absolute("garden.canopi");
        let launch = parse(
            text(&[
                "/usr/bin/canopi",
                "--update-failed=reason",
                "--later-flag",
                &design,
            ]),
            Some(&cwd()),
        );
        assert_eq!(launch, opens(&design, false));
        assert_eq!(
            parse(text(&["/usr/bin/canopi", "--only-a-flag"]), Some(&cwd())),
            None
        );
        assert_eq!(parse(text(&["/usr/bin/canopi"]), Some(&cwd())), None);
    }

    #[test]
    fn canopi_f47t_52_228_14_a_relative_path_resolves_against_the_launch_folder() {
        let launch = parse(text(&["canopi", "plans/garden.canopi"]), Some(&cwd()));
        assert_eq!(
            launch,
            opens(
                &absolute(&format!("plans{}garden.canopi", std::path::MAIN_SEPARATOR)),
                false
            )
        );
        assert_eq!(
            parse(text(&["canopi", "garden.canopi"]), None),
            None,
            "a relative path with no usable folder opens nothing"
        );
    }

    /// Recent Designs keys a file by its exact path, so `.` and `..` must not reach it.
    #[test]
    fn canopi_f47t_52_228_14_dot_and_dot_dot_parts_resolve_so_one_file_has_one_path() {
        let design = absolute("garden.canopi");
        for argument in [
            format!(".{0}garden.canopi", std::path::MAIN_SEPARATOR),
            format!(
                "..{0}canopi-launch-cwd{0}garden.canopi",
                std::path::MAIN_SEPARATOR
            ),
            format!("plans{0}..{0}.{0}garden.canopi", std::path::MAIN_SEPARATOR),
        ] {
            assert_eq!(
                parse(text(&["canopi", &argument]), Some(&cwd())),
                opens(&design, false),
                "{argument}"
            );
        }
        let dotted = cwd().join("plans").join("..").join("garden.canopi");
        assert_eq!(
            parse(text(&["canopi", dotted.to_str().unwrap()]), Some(&cwd())),
            opens(&design, false),
            "an absolute path is resolved too"
        );
    }

    #[test]
    fn canopi_f47t_52_228_14_a_launch_argument_that_is_not_unicode_opens_nothing() {
        assert_eq!(
            parse(
                [
                    LaunchArgument::Text("canopi".into()),
                    LaunchArgument::NotUnicode
                ],
                Some(&cwd())
            ),
            None
        );
        // The plugin forwards arguments lossily (2.5.4): U+FFFD stands where the bytes were.
        assert_eq!(
            LaunchArgument::forwarded("/home/g\u{FFFD}rden.canopi".into()),
            LaunchArgument::NotUnicode
        );
        assert_eq!(
            LaunchArgument::forwarded("/home/garden.canopi".into()),
            LaunchArgument::Text("/home/garden.canopi".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn canopi_f47t_52_228_14_a_first_launch_argument_that_is_not_unicode_is_refused() {
        use std::os::unix::ffi::OsStringExt as _;
        let bytes = std::ffi::OsString::from_vec(b"/home/g\xffrden.canopi".to_vec());
        assert_eq!(
            LaunchArgument::first_launch(bytes),
            LaunchArgument::NotUnicode
        );
        assert_eq!(
            LaunchArgument::first_launch("/home/garden.canopi".into()),
            LaunchArgument::Text("/home/garden.canopi".into())
        );
    }

    #[test]
    fn canopi_f47t_52_228_14_with_several_files_the_first_opens_and_the_launch_says_several() {
        let first = absolute("first.canopi");
        let second = absolute("second.canopi");
        assert_eq!(
            parse(text(&["canopi", &first, "--flag", &second]), Some(&cwd())),
            opens(&first, true)
        );
    }

    #[test]
    fn canopi_f47t_52_228_14_a_pipe_inside_a_path_survives() {
        let design = absolute("north|south.canopi");
        assert_eq!(
            parse(text(&["canopi", &design]), Some(&cwd())),
            opens(&design, false)
        );
    }

    #[test]
    fn canopi_f47t_52_228_14_the_slot_keeps_the_latest_launch_and_a_pull_empties_it() {
        let slot = PendingOpenSlot::default();
        assert!(slot.offer(opens("/a.canopi", false)));
        assert!(slot.offer(opens("/b.canopi", true)));
        assert!(
            !slot.offer(None),
            "a launch without a file keeps the pending one"
        );
        assert_eq!(slot.take(), opens("/b.canopi", true));
        assert_eq!(slot.take(), None);
    }

    #[derive(Default)]
    struct RecordingWindow(RefCell<Vec<&'static str>>);

    impl WindowControl for RecordingWindow {
        fn unminimize(&self) {
            self.0.borrow_mut().push("unminimize");
        }
        fn show(&self) {
            self.0.borrow_mut().push("show");
        }
        fn set_focus(&self) {
            self.0.borrow_mut().push("set_focus");
        }
        fn request_attention(&self) {
            self.0.borrow_mut().push("request_attention");
        }
    }

    #[test]
    fn canopi_f47t_52_228_14_a_forwarded_launch_unminimises_shows_focuses_then_asks_for_attention()
    {
        let window = RecordingWindow::default();
        bring_to_front(&window);
        assert_eq!(
            *window.0.borrow(),
            ["unminimize", "show", "set_focus", "request_attention"]
        );
    }

    #[test]
    fn canopi_f47t_52_228_14_the_pending_open_reaches_the_frontend_as_path_and_several() {
        let wire = serde_json::to_value(PendingOpen {
            path: "/g.canopi".into(),
            several: true,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "path": "/g.canopi", "several": true })
        );
    }

    /// Through Tauri's mock runtime: a forwarded launch during boot, before any window exists,
    /// fills the slot, emits the payload-free event, and the first pull returns its file.
    #[test]
    fn canopi_f47t_52_228_14_a_launch_during_boot_fills_the_slot_the_first_pull_returns() {
        use tauri::{Listener as _, Manager as _};
        let app = tauri::test::mock_builder()
            .manage(PendingOpenSlot::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app builds");
        let heard = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = heard.clone();
        app.listen_any(PENDING_OPEN_EVENT, move |_| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let folder = cwd().to_str().unwrap().to_owned();

        on_second_launch(
            app.handle(),
            vec!["canopi".into(), "garden.canopi".into()],
            folder.clone(),
        );
        on_second_launch(app.handle(), vec!["canopi".into()], folder);

        assert_eq!(
            heard.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "only a launch with a file emits"
        );
        let slot = app.state::<PendingOpenSlot>();
        assert_eq!(slot.take(), opens(&absolute("garden.canopi"), false));
        assert_eq!(slot.take(), None);
    }
}
