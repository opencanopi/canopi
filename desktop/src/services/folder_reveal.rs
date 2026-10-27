//! Shows the user's files and Canopi's folders in the system file manager, through
//! `tauri-plugin-opener` (2.1-Q227, 2.1-M79).
//!
//! `reveal_item` opens the folder holding a file with the file selected: D-Bus
//! `org.freedesktop.FileManager1.ShowItems` on Linux, `SHOpenFolderAndSelectItems` on Windows.
//! It starts no process, so nothing inherits an AppImage's GTK environment. The opener's portal
//! fallback cannot reach the portal in 2.7.2 (wrong bus name and signature), so with no
//! FileManager1 the reveal fails and the caller reports it. `open_folder` opens a folder itself
//! through the `open` crate (`xdg-open`, double-forked and reaped; `ShellExecute` on Windows),
//! the same call external links make. Both block until the request is handed over: callers run
//! them on `NativeOperationClass::Local`, after checking the item is still there.
//!
//! The failure text and the log line never name the path: paths are the user's own and stay out
//! of logs and reports.

use std::path::Path;

pub(crate) trait FolderRevealer {
    /// Opens the folder holding `item` with `item` selected.
    fn reveal_item(&self, item: &Path) -> Result<(), String>;
    /// Opens `folder` itself.
    fn open_folder(&self, folder: &Path) -> Result<(), String>;
}

pub(crate) struct SystemFolderRevealer;

impl FolderRevealer for SystemFolderRevealer {
    fn reveal_item(&self, item: &Path) -> Result<(), String> {
        tauri_plugin_opener::reveal_item_in_dir(item).map_err(|error| file_manager_failure(&error))
    }

    fn open_folder(&self, folder: &Path) -> Result<(), String> {
        tauri_plugin_opener::open_path(folder, None::<&str>)
            .map_err(|error| file_manager_failure(&error))
    }
}

/// The failure the frontend shows, logged once. Only an I/O error kind is kept from the
/// opener's error: its other variants may carry the path or a file URI.
fn file_manager_failure(error: &tauri_plugin_opener::Error) -> String {
    let cause = match error {
        tauri_plugin_opener::Error::Io(io) => io.kind().to_string(),
        tauri_plugin_opener::Error::UnsupportedPlatform => "not supported here".to_owned(),
        _ => "the file manager refused the request".to_owned(),
    };
    tracing::warn!("Show in folder failed: {cause}");
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

    #[derive(Clone, Default)]
    pub(crate) struct RecordingRevealer(Arc<Mutex<Vec<Shown>>>);

    impl RecordingRevealer {
        pub(crate) fn shown(&self) -> Vec<Shown> {
            self.0.lock().unwrap().clone()
        }
    }

    impl FolderRevealer for RecordingRevealer {
        fn reveal_item(&self, item: &Path) -> Result<(), String> {
            self.0.lock().unwrap().push(Shown::Item(item.to_path_buf()));
            Ok(())
        }

        fn open_folder(&self, folder: &Path) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push(Shown::Folder(folder.to_path_buf()));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FolderRevealer, SystemFolderRevealer, file_manager_failure};
    use crate::services::design_files::capture_logs;
    use std::path::PathBuf;

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
        assert!(logs.contains("Show in folder failed"), "{logs}");
        assert!(!logs.contains("gone-canopi-folder"), "{logs}");
    }

    #[test]
    fn an_opener_failure_that_carries_the_path_is_reported_without_it() {
        let path = PathBuf::from("/home/alice/Private Garden");
        let (message, logs) = capture_logs(|| {
            file_manager_failure(&tauri_plugin_opener::Error::NoParent(path.clone()))
        });
        assert_eq!(
            message,
            "Failed to open the file manager: the file manager refused the request"
        );
        assert!(
            !message.contains("alice") && !logs.contains("alice"),
            "{logs}"
        );
    }
}
