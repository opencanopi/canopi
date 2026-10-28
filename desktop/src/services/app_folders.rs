//! Settings › Files and data: where Canopi keeps Design Drafts and the Data
//! library on this device, and opening those folders.
//!
//! The paths are the user's own. They are returned for display on that screen
//! only and never written to a log or an error message.

use std::path::{Path, PathBuf};

use common_types::settings::{AppFolder, AppFolderLocations};

use crate::services::folder_reveal::FolderRevealer;

pub(crate) fn app_folder_path(app_data_dir: &Path, folder: AppFolder) -> PathBuf {
    match folder {
        AppFolder::Drafts => crate::design::drafts::drafts_root(app_data_dir),
        AppFolder::DataLibrary => crate::services::lidar::paths::library_root(app_data_dir),
    }
}

pub(crate) fn app_folder_locations(app_data_dir: &Path) -> AppFolderLocations {
    AppFolderLocations {
        drafts: app_folder_path(app_data_dir, AppFolder::Drafts)
            .to_string_lossy()
            .into_owned(),
        data_library: app_folder_path(app_data_dir, AppFolder::DataLibrary)
            .to_string_lossy()
            .into_owned(),
    }
}

/// Open one of Canopi's folders, creating it first if nothing was kept there yet.
pub(crate) fn show_app_folder(
    app_data_dir: &Path,
    folder: AppFolder,
    revealer: &impl FolderRevealer,
) -> Result<(), String> {
    let path = app_folder_path(app_data_dir, folder);
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Canopi could not create the folder: {error}"))?;
    revealer.open_folder(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::folder_reveal::recording::{RecordingRevealer, Shown};
    use crate::test_scratch::TestScratch;

    fn temp_app_data(name: &str) -> (TestScratch, PathBuf) {
        let scratch = TestScratch::new(&format!("app-folders-{name}"));
        let app_data = scratch.join("app-data");
        (scratch, app_data)
    }

    #[test]
    fn locations_name_the_drafts_and_data_library_folders_under_app_data() {
        let app_data = Path::new("/app-data");
        let locations = app_folder_locations(app_data);
        assert_eq!(
            PathBuf::from(locations.drafts),
            crate::design::drafts::drafts_root(app_data)
        );
        assert_eq!(
            PathBuf::from(locations.data_library),
            crate::services::lidar::paths::library_root(app_data)
        );
    }

    #[test]
    fn showing_a_folder_creates_it_and_opens_exactly_that_folder() {
        let (_scratch, app_data) = temp_app_data("show");
        let revealer = RecordingRevealer::default();
        show_app_folder(&app_data, AppFolder::DataLibrary, &revealer).unwrap();
        let expected = app_folder_path(&app_data, AppFolder::DataLibrary);
        assert!(expected.is_dir());
        assert_eq!(revealer.shown(), vec![Shown::Folder(expected)]);
    }

    #[test]
    fn a_folder_that_cannot_be_created_is_reported_without_its_path() {
        let (_scratch, app_data) = temp_app_data("blocked");
        std::fs::create_dir_all(&app_data).unwrap();
        // A file where the folder should be makes creation fail.
        std::fs::write(app_folder_path(&app_data, AppFolder::Drafts), b"").unwrap();
        let revealer = RecordingRevealer::default();
        let error = show_app_folder(&app_data, AppFolder::Drafts, &revealer).unwrap_err();
        assert!(!error.contains(&*app_data.to_string_lossy()), "{error}");
        assert!(revealer.shown().is_empty());
    }
}
