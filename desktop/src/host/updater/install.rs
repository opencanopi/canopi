//! Installing a verified update (contracts §3, 2.1-Q232, 2.1-Q233, 2.1-Q234), run on the
//! executor's Local class: the link-only probe before a download, the `.deb` through Canopi's own
//! `pkexec dpkg -i` (never the plugin's zenity or kdialog chain), the AppImage written whole beside
//! the running one and renamed over it, and on Windows the pending-update marker the next launch
//! reads, then the installer Canopi starts itself after the write drain.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use common_types::update::{UpdateBundle, UpdateFailure, UpdateFailureCode, UpdateOp};
use serde::{Deserialize, Serialize};
use tauri_plugin_updater::Update;

use super::{channel::Installation, failure, launch};
use crate::native_operation::{ExitDrain, NativeOperationExecutor};

/// The pending-update marker's file name in the app data folder.
pub const MARKER_FILE: &str = "pending-update.json";

/// What an install reads from the running app.
#[derive(Debug, Clone)]
pub struct Context {
    /// The running AppImage, when Canopi runs as one.
    pub appimage: Option<PathBuf>,
    /// The `PATH` searched for `pkexec`.
    pub search_path: Option<OsString>,
    /// Where the `.deb` is written for `dpkg`.
    pub temp_dir: PathBuf,
    /// The pending-update marker's path, in the app data folder.
    pub marker: Option<PathBuf>,
    /// Whether the macOS app replaces itself: only in the `updater-e2e` build, for the macOS
    /// self-update probe (2.1-Q136); every release build keeps it link-only until that probe is
    /// clean.
    pub probe_app_bundle: bool,
    /// The Windows relaunch's arguments after the binary: the open Design's path, or none
    /// (`launch::restart_args`).
    pub relaunch: Vec<OsString>,
}

/// What a successful install leaves to do.
#[must_use]
pub enum Installed {
    /// Installed while Canopi runs (Linux); a restart finishes it.
    InPlace,
    /// The Windows installer has started: Canopi exits now, holding the write drain.
    Exit(ExitDrain),
}

/// Whether this installer can replace itself, probed before a download (2.1-M210): the `.deb`
/// needs `pkexec` on `PATH` (a scan, no process starts), the AppImage a folder Canopi can write;
/// the macOS app is link-only until the Q136 probe is clean, except in the probe's own build.
pub fn can_replace_itself(bundle: UpdateBundle, context: &Context) -> bool {
    match bundle {
        UpdateBundle::Deb => find_on_path("pkexec", context.search_path.as_deref()).is_some(),
        UpdateBundle::Appimage => context
            .appimage
            .as_deref()
            .and_then(Path::parent)
            .is_some_and(writable_folder),
        UpdateBundle::Nsis | UpdateBundle::Msi => true,
        UpdateBundle::App => context.probe_app_bundle,
    }
}

/// The first executable file named `name` in `search_path`'s folders.
fn find_on_path(name: &str, search_path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(search_path?)
        .map(|folder| folder.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Whether this process may create files in `folder`.
#[cfg(unix)]
fn writable_folder(folder: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt as _;
    let mut path = folder.as_os_str().as_bytes().to_vec();
    path.push(0);
    // SAFETY: `path` is a NUL-terminated byte string that outlives the call; `access` only
    // reads it.
    unsafe { libc::access(path.as_ptr().cast(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn writable_folder(folder: &Path) -> bool {
    std::fs::metadata(folder).is_ok_and(|metadata| !metadata.permissions().readonly())
}

/// Installs `bytes`, the verified payload of `update`, as `installation`'s installer does, from
/// inside the install's Local operation on `executor`.
pub fn install(
    installation: Installation,
    context: &Context,
    update: &Update,
    bytes: &[u8],
    executor: &NativeOperationExecutor,
) -> Result<Installed, UpdateFailure> {
    match installation.bundle {
        UpdateBundle::Deb => install_deb(context, update, bytes).map(|()| Installed::InPlace),
        UpdateBundle::Appimage => {
            install_appimage(installation, context, update, bytes).map(|()| Installed::InPlace)
        }
        UpdateBundle::App if context.probe_app_bundle => {
            install_by_plugin(installation, update, bytes).map(|()| Installed::InPlace)
        }
        UpdateBundle::Nsis | UpdateBundle::Msi => {
            install_windows(installation, context, update, bytes, executor).map(Installed::Exit)
        }
        UpdateBundle::App => Err(failure::failure(
            UpdateOp::Install,
            UpdateFailureCode::Invalid,
            "the macOS app updates by its download link",
        )),
    }
}

fn verify(update: &Update, bytes: &[u8], installation: Installation) -> Result<(), UpdateFailure> {
    update
        .verify(bytes)
        .map_err(|error| failure::from_plugin(UpdateOp::Install, installation, &error))
}

/// The `.deb`: verified, written to a new 0600 file in a fresh 0700 folder (never a predictable
/// name in the shared temp folder, which another account could swap before root reads it),
/// installed by `pkexec dpkg -i`, the folder removed.
/// pkexec's 126 is a closed password prompt, its 127 a refusal.
fn install_deb(context: &Context, update: &Update, bytes: &[u8]) -> Result<(), UpdateFailure> {
    let op = UpdateOp::Install;
    let installation = Installation {
        os: common_types::update::UpdateOs::Linux,
        arch: common_types::update::UpdateArch::X86_64,
        bundle: UpdateBundle::Deb,
    };
    verify(update, bytes, installation)?;
    let Some(pkexec) = find_on_path("pkexec", context.search_path.as_deref()) else {
        return Err(failure::failure(
            op,
            UpdateFailureCode::UpdateAdminPromptUnavailable,
            "pkexec is not on PATH",
        ));
    };
    let folder = private_folder(&context.temp_dir)
        .map_err(|error| failure::io(op, &error, "the package folder could not be made"))?;
    let file = folder.join("canopi-update.deb");
    let status = write_private(&file, bytes)
        .map_err(|error| failure::io(op, &error, "the package could not be written"))
        .map(|()| {
            std::process::Command::new(pkexec)
                .arg("dpkg")
                .arg("-i")
                .arg(&file)
                .status()
        });
    let _removed = std::fs::remove_dir_all(&folder);
    match status?.map(|status| status.code()) {
        Ok(Some(0)) => Ok(()),
        Ok(Some(126)) => Err(failure::failure(
            op,
            UpdateFailureCode::UpdateAdminPromptDismissed,
            "the password prompt was closed",
        )),
        Ok(Some(127)) => Err(failure::failure(
            op,
            UpdateFailureCode::UpdateAdminPromptRefused,
            "pkexec refused the request",
        )),
        Ok(_) | Err(_) => Err(failure::install_failed(UpdateBundle::Deb)),
    }
}

/// A fresh folder in `parent` only this account can enter (0700 on Unix), made by an exclusive
/// create, so a name another account planted in a shared temp folder is never reused.
fn private_folder(parent: &Path) -> std::io::Result<PathBuf> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    let mut last = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
    for attempt in 0_u32..16 {
        // A fresh random name, from std's per-process random hasher keys (no clock, no new crate).
        let random = std::hash::BuildHasher::hash_one(
            &std::collections::hash_map::RandomState::new(),
            attempt,
        );
        let folder = parent.join(format!("canopi-update-{random:016x}"));
        match builder.create(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

/// Writes `bytes` to a new file at `file` only this account can read (0600 on Unix); an existing
/// file or symlink there is refused, never followed.
fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut opened = options.open(file)?;
    opened.write_all(bytes)?;
    opened.sync_all()
}

/// The AppImage: verified, then written whole to a sibling file and renamed over the running one
/// (2.1-Q254). The plugin's replace moves the running AppImage away and writes the new one in its
/// place, so a process death mid-write (a closed window's exit, a kill) left a truncated AppImage
/// and Canopi no longer started. A rename is atomic in one folder, so at every moment the path holds
/// the running AppImage or the new one, whole; the running process keeps its open copy until it
/// exits.
fn install_appimage(
    installation: Installation,
    context: &Context,
    update: &Update,
    bytes: &[u8],
) -> Result<(), UpdateFailure> {
    verify(update, bytes, installation)?;
    // An AppImage is an ELF executable; Canopi's channel announces it uncompressed.
    if !bytes.starts_with(b"\x7fELF") {
        return Err(failure::install_failed(installation.bundle));
    }
    let Some(appimage) = context.appimage.as_deref() else {
        return Err(failure::failure(
            UpdateOp::Install,
            UpdateFailureCode::Internal,
            "Canopi does not run as an AppImage",
        ));
    };
    replace_whole(appimage, bytes).map_err(|error| failure::install_io(installation, &error))
}

/// Replaces `target` by `bytes` with its permissions kept: a sibling file written, synced and
/// renamed over it, the folder synced so the rename itself survives a power cut. A sibling left by
/// an install that died is removed first, never written through; any failure removes the sibling
/// and leaves `target` untouched.
fn replace_whole(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let not_found = || std::io::Error::from(std::io::ErrorKind::NotFound);
    let folder = target.parent().ok_or_else(not_found)?;
    let name = target.file_name().ok_or_else(not_found)?;
    let mut sibling_name = OsString::from(".");
    sibling_name.push(name);
    sibling_name.push(".update");
    let sibling = folder.join(sibling_name);
    match std::fs::remove_file(&sibling) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        Ok(()) | Err(_) => {}
    }
    let permissions = std::fs::metadata(target)?.permissions();
    let replaced = write_private(&sibling, bytes)
        .and_then(|()| std::fs::set_permissions(&sibling, permissions))
        .and_then(|()| std::fs::rename(&sibling, target))
        .and_then(|()| sync_folder(folder));
    if replaced.is_err() {
        let _removed = std::fs::remove_file(&sibling);
    }
    replaced
}

/// Syncs `folder`'s entries, so a rename in it is on disk.
#[cfg(unix)]
fn sync_folder(folder: &Path) -> std::io::Result<()> {
    std::fs::File::open(folder)?.sync_all()
}

#[cfg(not(unix))]
fn sync_folder(_: &Path) -> std::io::Result<()> {
    Ok(())
}

/// The macOS app in the probe build: the plugin's replace, which backs the running app bundle up
/// and restores it when the replace fails.
fn install_by_plugin(
    installation: Installation,
    update: &Update,
    bytes: &[u8],
) -> Result<(), UpdateFailure> {
    update
        .install(bytes)
        .map_err(|error| failure::from_plugin(UpdateOp::Install, installation, &error))
}

/// The pending-update marker: the version a Windows install was started for.
#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    version: String,
}

/// Windows: the marker first, refused with `io{kind}` before the installer runs when it cannot be
/// written; then the installer is written to a fresh private folder and started, once the writes
/// in flight have landed, with the relaunch's arguments (`launch::installer_command`). The answer
/// is the held drain: the caller exits. Canopi starts the installer itself, as it runs `dpkg`
/// itself: the plugin's start relaunches with the launch's argv and exits without the drain. Any
/// failure removes the marker, and Canopi stays open.
fn install_windows(
    installation: Installation,
    context: &Context,
    update: &Update,
    bytes: &[u8],
    executor: &NativeOperationExecutor,
) -> Result<ExitDrain, UpdateFailure> {
    let op = UpdateOp::Install;
    verify(update, bytes, installation)?;
    let Some(marker) = &context.marker else {
        return Err(failure::failure(
            op,
            UpdateFailureCode::Internal,
            "no app data folder",
        ));
    };
    write_marker(marker, &update.version)?;
    let file_name = match installation.bundle {
        UpdateBundle::Msi => "Canopi-update.msi",
        _ => "Canopi-update-setup.exe",
    };
    let started = private_folder(&context.temp_dir)
        .and_then(|folder| {
            let installer = folder.join(file_name);
            write_private(&installer, bytes)?;
            let command = launch::installer_command(
                installation.bundle,
                &installer,
                &context.relaunch,
                std::env::var_os("SYSTEMROOT").as_deref(),
            );
            launch::start_installer_after_drain(executor, &command, start_installer)
        })
        .map_err(|error| failure::install_io(installation, &error));
    if started.is_err() {
        let _removed = std::fs::remove_file(marker);
    }
    started
}

/// Starts the installer with its command line as Windows reads it, unquoted by Rust.
#[cfg(windows)]
fn start_installer(command: &launch::InstallerCommand) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt as _;
    std::process::Command::new(&command.program)
        .raw_arg(&command.parameters)
        .spawn()
        .map(drop)
}

#[cfg(not(windows))]
fn start_installer(_: &launch::InstallerCommand) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

fn write_marker(marker: &Path, version: &str) -> Result<(), UpdateFailure> {
    let op = UpdateOp::Install;
    let text = serde_json::to_string(&Marker {
        version: version.to_owned(),
    })
    .map_err(|_| {
        failure::failure(
            op,
            UpdateFailureCode::Internal,
            "the marker did not serialize",
        )
    })?;
    if let Some(folder) = marker.parent() {
        std::fs::create_dir_all(folder)
            .map_err(|error| failure::io(op, &error, "the app data folder could not be made"))?;
    }
    std::fs::write(marker, text)
        .map_err(|error| failure::io(op, &error, "the pending-update marker could not be written"))
}

/// Reads and clears the marker: `true`, once, when it names a version above `running`, so the
/// install that quit Canopi did not take. Any other marker is cleared silently.
pub fn take_marker(marker: &Path, running: &semver::Version) -> bool {
    let Ok(text) = std::fs::read_to_string(marker) else {
        return false;
    };
    let _removed = std::fs::remove_file(marker);
    serde_json::from_str::<Marker>(&text)
        .ok()
        .and_then(|marker| semver::Version::parse(&marker.version).ok())
        .is_some_and(|target| target > *running)
}

mod tests;
