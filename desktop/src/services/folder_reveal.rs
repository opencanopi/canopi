//! Shows the user's files and Canopi's folders in the system file manager, through
//! `tauri-plugin-opener` (2.1-Q227, 2.1-M79).
//!
//! `reveal_item` opens the folder holding a file with the file selected: D-Bus
//! `org.freedesktop.FileManager1.ShowItems` on Linux, `SHOpenFolderAndSelectItems` on Windows.
//! `reveal_item` starts no process, so nothing inherits an AppImage's GTK environment. The
//! opener's portal fallback cannot reach the portal in 2.7.2 (wrong bus name and signature), so
//! with no FileManager1 the reveal fails; `show_item`, what callers use, then opens the item's
//! folder instead and reports a failure only when that fails too. `open_folder` opens a folder
//! itself through the `open` crate (`xdg-open`, double-forked and reaped; `ShellExecute` on
//! Windows), the same call app folders and external links make: that child process inherits the
//! app's environment, an AppImage's GTK and LD variables included, as those paths already do. Both block until the request is handed over: callers run
//! them on `NativeOperationClass::Local`, after checking the item is still there.
//!
//! A refused selection logs at debug, a refused folder as the Show in folder failure. The
//! failure text and the log lines never name the path: paths are the user's own and stay out
//! of logs and reports.

use std::path::Path;

pub(crate) trait FolderRevealer {
    /// Opens the folder holding `item` with `item` selected.
    fn reveal_item(&self, item: &Path) -> Result<(), String>;
    /// Opens `folder` itself.
    fn open_folder(&self, folder: &Path) -> Result<(), String>;

    /// Show in folder: selects `item` in its folder, or opens the folder when the file manager
    /// cannot select it (no `FileManager1`), as `xdg-open` did before 2.1. Fails only when the
    /// folder cannot open either.
    fn show_item(&self, item: &Path) -> Result<(), String> {
        self.reveal_item(item)
            .or_else(|refused| match item.parent() {
                Some(folder) if !folder.as_os_str().is_empty() => self.open_folder(folder),
                _ => Err(refused),
            })
    }
}

pub(crate) struct SystemFolderRevealer;

impl FolderRevealer for SystemFolderRevealer {
    /// A refusal logs at debug only: `show_item` then opens the folder, so it is not yet a
    /// Show in folder failure.
    fn reveal_item(&self, item: &Path) -> Result<(), String> {
        tauri_plugin_opener::reveal_item_in_dir(item).map_err(|error| {
            let cause = file_manager_cause(&error);
            tracing::debug!("Selecting the item in its folder failed, opening its folder: {cause}");
            file_manager_failure(&cause)
        })
    }

    /// The last step of every Show in folder, so its refusal is the one logged as a failure.
    fn open_folder(&self, folder: &Path) -> Result<(), String> {
        tauri_plugin_opener::open_path(folder, None::<&str>).map_err(|error| {
            let cause = file_manager_cause(&error);
            tracing::warn!("Show in folder failed: {cause}");
            file_manager_failure(&cause)
        })
    }
}

/// Why the opener refused. Only an I/O error kind is kept from the opener's error: its other
/// variants may carry the path or a file URI.
fn file_manager_cause(error: &tauri_plugin_opener::Error) -> String {
    match error {
        tauri_plugin_opener::Error::Io(io) => io.kind().to_string(),
        tauri_plugin_opener::Error::UnsupportedPlatform => "not supported here".to_owned(),
        _ => "the file manager refused the request".to_owned(),
    }
}

/// The failure the frontend shows.
fn file_manager_failure(cause: &str) -> String {
    format!("Failed to open the file manager: {cause}")
}

#[cfg(test)]
pub(crate) mod recording {
    //! The test double every Show in folder caller uses.

    use super::FolderRevealer;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    /// One request a [`RecordingRevealer`] received.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) enum Shown {
        Item(PathBuf),
        Folder(PathBuf),
    }

    /// Records every request; a request it refuses is recorded too.
    #[derive(Clone, Default)]
    pub(crate) struct RecordingRevealer {
        shown: Arc<Mutex<Vec<Shown>>>,
        refuses_reveal: bool,
        refuses_open: bool,
    }

    impl RecordingRevealer {
        /// A desktop whose file manager offers no `FileManager1`: revealing an item fails.
        pub(crate) fn without_file_manager() -> Self {
            Self {
                refuses_reveal: true,
                ..Self::default()
            }
        }

        /// A desktop where neither revealing nor opening a folder works.
        pub(crate) fn refusing_everything() -> Self {
            Self {
                refuses_reveal: true,
                refuses_open: true,
                ..Self::default()
            }
        }

        pub(crate) fn shown(&self) -> Vec<Shown> {
            self.shown.lock().unwrap().clone()
        }

        fn record(&self, shown: Shown, refused: bool) -> Result<(), String> {
            self.shown.lock().unwrap().push(shown);
            if refused {
                Err("Failed to open the file manager: the file manager refused the request".into())
            } else {
                Ok(())
            }
        }
    }

    impl FolderRevealer for RecordingRevealer {
        fn reveal_item(&self, item: &Path) -> Result<(), String> {
            self.record(Shown::Item(item.to_path_buf()), self.refuses_reveal)
        }

        fn open_folder(&self, folder: &Path) -> Result<(), String> {
            self.record(Shown::Folder(folder.to_path_buf()), self.refuses_open)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::recording::{RecordingRevealer, Shown};
    use super::{FolderRevealer, SystemFolderRevealer, file_manager_cause};
    use crate::services::design_files::capture_logs;
    use std::path::{Path, PathBuf};

    #[test]
    fn show_item_selects_the_item_when_the_file_manager_can() {
        let revealer = RecordingRevealer::default();
        revealer
            .show_item(Path::new("/gardens/orchard.canopi"))
            .unwrap();
        assert_eq!(
            revealer.shown(),
            vec![Shown::Item("/gardens/orchard.canopi".into())]
        );
    }

    #[test]
    fn show_item_opens_the_items_folder_when_the_file_manager_cannot_select_it() {
        let revealer = RecordingRevealer::without_file_manager();
        revealer
            .show_item(Path::new("/gardens/orchard.canopi"))
            .unwrap();
        assert_eq!(
            revealer.shown(),
            vec![
                Shown::Item("/gardens/orchard.canopi".into()),
                Shown::Folder("/gardens".into()),
            ]
        );
    }

    #[test]
    fn show_item_fails_without_the_path_only_when_the_folder_cannot_open_either() {
        let revealer = RecordingRevealer::refusing_everything();
        let error = revealer
            .show_item(Path::new("/home/alice/orchard.canopi"))
            .unwrap_err();
        assert!(
            error.starts_with("Failed to open the file manager"),
            "{error}"
        );
        assert!(!error.contains("alice"), "{error}");
    }

    /// Probe (2.1-Q227): the opener canonicalizes the item before any D-Bus or shell call, so
    /// a deleted file fails with the I/O error alone.
    #[test]
    fn the_system_opener_refuses_a_missing_item_before_any_file_manager_call() {
        let scratch = crate::test_scratch::TestScratch::new("folder-reveal-missing-item");
        let error = tauri_plugin_opener::reveal_item_in_dir(scratch.join("gone.canopi"))
            .expect_err("a deleted file has nothing to reveal");
        assert!(
            matches!(&error, tauri_plugin_opener::Error::Io(io) if io.kind() == std::io::ErrorKind::NotFound),
            "{error:?}"
        );
    }

    #[test]
    fn a_missing_item_or_folder_fails_through_the_system_revealer_without_its_path() {
        let scratch = crate::test_scratch::TestScratch::new("folder-reveal-gone-canopi-folder");
        let gone = scratch.join("gone-canopi-folder");
        let (results, logs) = capture_logs(|| {
            [
                SystemFolderRevealer.reveal_item(&gone.join("orchard.canopi")),
                SystemFolderRevealer.open_folder(&gone),
            ]
        });
        for result in results {
            assert_eq!(
                result.unwrap_err(),
                "Failed to open the file manager: entity not found"
            );
        }
        assert!(!logs.contains("gone-canopi-folder"), "{logs}");
    }

    /// Review of canopi-zhv0: `show_item` falls back to opening the folder when selecting the
    /// item fails, so that refusal is not a Show in folder failure and must not log as one.
    #[test]
    fn canopi_zhv0_a_refused_selection_logs_no_show_in_folder_failure_only_a_refused_folder_does() {
        let scratch = crate::test_scratch::TestScratch::new("folder-reveal-log-levels");
        let gone = scratch.join("gone-canopi-folder");
        let (_, selection_logs) =
            capture_logs(|| SystemFolderRevealer.reveal_item(&gone.join("orchard.canopi")));
        assert!(!selection_logs.contains("WARN"), "{selection_logs}");
        assert!(
            !selection_logs.contains("Show in folder failed"),
            "{selection_logs}"
        );
        let (_, folder_logs) = capture_logs(|| SystemFolderRevealer.open_folder(&gone));
        assert!(folder_logs.contains("WARN"), "{folder_logs}");
        assert!(
            folder_logs.contains("Show in folder failed"),
            "{folder_logs}"
        );
    }

    #[test]
    fn an_opener_failure_that_carries_the_path_is_reported_without_it() {
        let path = PathBuf::from("/home/alice/Private Garden");
        let cause = file_manager_cause(&tauri_plugin_opener::Error::NoParent(path));
        assert_eq!(cause, "the file manager refused the request");
    }
}
