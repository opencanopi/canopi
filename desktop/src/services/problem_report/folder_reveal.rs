use std::path::Path;

use crate::services::folder_reveal::FolderRevealer;

use super::{BUNDLE_FILENAME, SUMMARY_FILENAME};

/// Open `folder` with its diagnostic bundle selected (the file the user
/// attaches), if it is a generated report folder directly inside
/// `output_root`, the folder reports are written to.
pub(crate) fn show_problem_report_folder(
    folder: &Path,
    output_root: &Path,
    revealer: &impl FolderRevealer,
) -> Result<(), String> {
    validate_problem_report_folder(folder, output_root)?;
    revealer.reveal_item(&folder.join(BUNDLE_FILENAME))
}

fn validate_problem_report_folder(folder: &Path, output_root: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(folder).map_err(|error| {
        format!(
            "Problem Report folder was not found at {}: {error}",
            folder.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }

    let not_a_report = || format!("{} is not a Canopi Problem Report folder", folder.display());
    let folder_name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(not_a_report)?;
    if !folder_name.starts_with("Canopi Problem Report ") {
        return Err(not_a_report());
    }
    let canonical_parent = folder
        .canonicalize()
        .ok()
        .and_then(|folder| folder.parent().map(Path::to_path_buf));
    let canonical_root = output_root.canonicalize().ok();
    if canonical_parent.is_none() || canonical_parent != canonical_root {
        return Err(not_a_report());
    }

    for required_file in [SUMMARY_FILENAME, BUNDLE_FILENAME] {
        let required_path = folder.join(required_file);
        if !required_path.is_file() {
            return Err(format!(
                "Problem Report folder {} is missing {required_file}",
                folder.display()
            ));
        }
    }

    Ok(())
}
