//! Opens a folder in the system file manager.
//!
//! Callers validate the folder first (a Problem Report folder, one of
//! Canopi's app folders, a Recent Design's folder). Error text never names the
//! folder: paths are the user's own and stay out of logs and reports.

use std::path::Path;
use std::process::Command;

pub(crate) trait FolderRevealer {
    fn reveal_folder(&self, folder: &Path) -> Result<(), String>;
}

pub(crate) struct SystemFolderRevealer;

impl FolderRevealer for SystemFolderRevealer {
    fn reveal_folder(&self, folder: &Path) -> Result<(), String> {
        let mut command = platform_reveal_command(folder);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to open the file manager: {error}"))?;
        // The opener may run as long as the file manager it hands off to, so
        // reap it off the calling thread instead of leaving a zombie. The
        // closure sits outside the reviewed statement so clippy still checks it.
        let reap = move || {
            if let Err(error) = child.wait() {
                tracing::warn!("Folder opener could not be reaped: {error}");
            }
        };
        #[expect(
            clippy::disallowed_methods,
            reason = "the opener may live as long as the file manager; holding an executor \
                      slot for it would starve bounded work"
        )]
        let reaper = std::thread::Builder::new()
            .name("folder-reveal-reaper".to_owned())
            .spawn(reap);
        reaper.map_err(|error| format!("Failed to watch the folder opener: {error}"))?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn platform_reveal_command(folder: &Path) -> Command {
    let mut command = Command::new("open");
    command.arg(folder);
    command
}

#[cfg(target_os = "windows")]
fn platform_reveal_command(folder: &Path) -> Command {
    let mut command = Command::new("explorer");
    command.arg(folder);
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn platform_reveal_command(folder: &Path) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(folder);
    command
}

#[cfg(test)]
mod tests {
    use super::platform_reveal_command;
    use std::path::Path;

    #[test]
    fn the_opener_gets_the_folder_as_its_only_argument() {
        let command = platform_reveal_command(Path::new("/tmp/some folder"));
        let args = command.get_args().collect::<Vec<_>>();
        assert_eq!(args, vec![std::ffi::OsStr::new("/tmp/some folder")]);
    }
}
