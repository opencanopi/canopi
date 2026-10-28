//! Installing a verified update (contracts §3, 2.1-Q232, 2.1-Q233, 2.1-Q234), run on the
//! executor's Local class: the link-only probe before a download, the `.deb` through Canopi's own
//! `pkexec dpkg -i` (never the plugin's zenity or kdialog chain), the AppImage through the plugin's
//! replace and its backup, and on Windows the pending-update marker the next launch reads.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use common_types::update::{UpdateBundle, UpdateFailure, UpdateFailureCode, UpdateOp};
use serde::{Deserialize, Serialize};
use tauri_plugin_updater::Update;

use super::{channel::Installation, failure};

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
}

/// Whether this installer can replace itself, probed before a download (2.1-M210): the `.deb`
/// needs `pkexec` on `PATH` (a scan, no process starts), the AppImage a folder Canopi can write;
/// the macOS app is link-only until the Q136 probe is clean.
pub fn can_replace_itself(bundle: UpdateBundle, context: &Context) -> bool {
    match bundle {
        UpdateBundle::Deb => find_on_path("pkexec", context.search_path.as_deref()).is_some(),
        UpdateBundle::Appimage => context
            .appimage
            .as_deref()
            .and_then(Path::parent)
            .is_some_and(writable_folder),
        UpdateBundle::Nsis | UpdateBundle::Msi => true,
        UpdateBundle::App => false,
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

/// Installs `bytes`, the verified payload of `update`, as `installation`'s installer does.
pub fn install(
    installation: Installation,
    context: &Context,
    update: &Update,
    bytes: &[u8],
) -> Result<(), UpdateFailure> {
    match installation.bundle {
        UpdateBundle::Deb => install_deb(context, update, bytes),
        UpdateBundle::Appimage => install_appimage(installation, update, bytes),
        UpdateBundle::Nsis | UpdateBundle::Msi => {
            install_windows(installation, context, update, bytes)
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
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.subsec_nanos());
        let folder = parent.join(format!(
            "canopi-update-{}-{nanos:08x}-{attempt}",
            std::process::id()
        ));
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

/// The AppImage: the plugin's replace, which backs the running AppImage up and restores it when
/// the replace fails.
fn install_appimage(
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
/// written, then the plugin runs the installer, which quits Canopi.
fn install_windows(
    installation: Installation,
    context: &Context,
    update: &Update,
    bytes: &[u8],
) -> Result<(), UpdateFailure> {
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
    update.install(bytes).map_err(|error| {
        let _removed = std::fs::remove_file(marker);
        failure::from_plugin(op, installation, &error)
    })
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

#[cfg(test)]
mod tests {
    use super::{Context, can_replace_itself, find_on_path, take_marker, write_marker};
    use crate::host::updater::{
        UpdaterHost,
        testkit::{APPIMAGE, DEB, FAST, Offer, code, elf_payload, mock_app, run, scratch, sink},
    };
    use crate::native_operation::NativeOperationExecutor;
    use common_types::update::{IoFailureKind, UpdateBundle, UpdateDownload, UpdateFailureCode};
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    fn executable(path: &Path, script: &str) {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::write(path, script).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn context(search_path: Option<&Path>, appimage: Option<PathBuf>) -> Context {
        Context {
            appimage,
            search_path: search_path.map(|path| path.as_os_str().to_owned()),
            temp_dir: std::env::temp_dir(),
            marker: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_deb_without_pkexec_on_path_and_an_unwritable_appimage_folder_are_link_only() {
        let bin = scratch("bin");
        assert!(!can_replace_itself(
            UpdateBundle::Deb,
            &context(Some(&bin), None)
        ));
        std::fs::write(bin.join("pkexec"), "not executable").unwrap();
        assert!(!can_replace_itself(
            UpdateBundle::Deb,
            &context(Some(&bin), None)
        ));
        executable(&bin.join("pkexec"), "#!/bin/sh\nexit 0\n");
        assert!(can_replace_itself(
            UpdateBundle::Deb,
            &context(Some(&bin), None)
        ));
        assert_eq!(
            find_on_path("pkexec", Some(bin.as_os_str())),
            Some(bin.join("pkexec"))
        );

        let apps = scratch("apps");
        let appimage = apps.join("Canopi.AppImage");
        assert!(can_replace_itself(
            UpdateBundle::Appimage,
            &context(None, Some(appimage.clone()))
        ));
        assert!(!can_replace_itself(
            UpdateBundle::Appimage,
            &context(None, Some(PathBuf::from("/proc/Canopi.AppImage")))
        ));
        assert!(!can_replace_itself(
            UpdateBundle::Appimage,
            &context(None, None)
        ));
        assert!(!can_replace_itself(UpdateBundle::App, &context(None, None)));
    }

    #[test]
    fn a_marker_above_the_running_version_gives_the_notice_once_and_any_other_is_cleared() {
        let folder = scratch("marker");
        let marker = folder.join(super::MARKER_FILE);
        let running = semver::Version::parse("2.1.0").unwrap();
        for (target, notice) in [
            ("2.2.0", true),
            ("2.1.0", false),
            ("2.0.3", false),
            ("x", false),
        ] {
            write_marker(&marker, target).unwrap();
            assert_eq!(take_marker(&marker, &running), notice, "{target}");
            assert!(!marker.exists(), "{target}: the marker is cleared");
            assert!(!take_marker(&marker, &running), "{target}: read once");
        }
    }

    #[test]
    fn an_unwritable_marker_is_refused_before_the_installer_runs() {
        let folder = scratch("marker-blocked");
        let blocker = folder.join("not-a-folder");
        std::fs::write(&blocker, "a file where the app data folder should be").unwrap();
        let refused = write_marker(&blocker.join(super::MARKER_FILE), "2.2.0").unwrap_err();
        assert!(
            matches!(refused.code, UpdateFailureCode::Io { io } if io != IoFailureKind::NotFound),
            "{refused:?}"
        );
    }

    /// A fake `pkexec` in a fresh folder: it records its arguments, then exits with `status`.
    #[cfg(all(test, unix))]
    fn fake_pkexec(status: i32) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let folder = scratch(&format!("pkexec-{status}"));
        let script = folder.join("pkexec");
        let record = folder.join("args");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$@\" > '{}'\nexit {status}\n",
                record.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        folder
    }

    #[cfg(unix)]
    #[test]
    fn the_deb_installs_through_pkexec_dpkg_and_its_exit_statuses_settle_as_their_codes() {
        for (status, settled) in [
            (0, Ok(())),
            (126, Err(UpdateFailureCode::UpdateAdminPromptDismissed)),
            (127, Err(UpdateFailureCode::UpdateAdminPromptRefused)),
            (
                1,
                Err(UpdateFailureCode::UpdateInstallFailed {
                    bundle: UpdateBundle::Deb,
                }),
            ),
        ] {
            let offer = Offer::signed(DEB);
            let app = mock_app(&offer.key.public_key());
            let executor = NativeOperationExecutor::production();
            let bin = fake_pkexec(status);
            let temp = scratch(&format!("deb-temp-{status}"));
            let host = UpdaterHost {
                search_path: Some(bin.clone().into_os_string()),
                temp_dir: Some(temp.clone()),
                ..offer.host(DEB, FAST)
            };
            run(host.check(app.handle(), &executor)).unwrap().unwrap();
            let (progress, _) = sink();
            assert_eq!(
                run(host.download(app.handle(), &executor, progress)),
                Ok(UpdateDownload::Verified)
            );

            let installed = run(host.install(app.handle(), &executor));

            assert_eq!(
                installed.map_err(|failure| failure.code),
                settled,
                "exit {status}"
            );
            let args = std::fs::read_to_string(bin.join("args")).unwrap();
            assert!(args.starts_with("dpkg -i "), "{args}");
            assert!(args.trim_end().ends_with(".deb"), "{args}");
            assert_eq!(
                std::fs::read_dir(&temp).unwrap().count(),
                0,
                "the package file is removed"
            );
            assert_eq!(
                host.ops().staged.is_some(),
                status != 0,
                "a failed install can be retried"
            );
        }
    }

    /// A shared temp folder's predictable name is never written or handed to dpkg: another account
    /// can plant a file or symlink there and swap the verified bytes before root reads them.
    #[cfg(unix)]
    #[test]
    fn the_deb_reaches_dpkg_from_a_private_folder_never_a_planted_temp_file() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};
        let offer = Offer::signed(DEB);
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let bin = scratch("pkexec-private");
        let record = bin.join("seen");
        executable(
            &bin.join("pkexec"),
            &format!(
                "#!/bin/sh\nstat -c '%a' \"$(dirname \"$3\")\" \"$3\" > '{record}'\ncp \"$3\" '{record}.deb'\n",
                record = record.display()
            ),
        );
        let temp = scratch("deb-temp-shared");
        let target = scratch("deb-temp-target").join("victim");
        std::fs::write(&target, "untouched").unwrap();
        symlink(&target, temp.join("canopi-update-9.0.0.deb")).unwrap();
        let planted = temp.join("planted");
        std::fs::write(&planted, "planted").unwrap();
        std::fs::set_permissions(&planted, std::fs::Permissions::from_mode(0o666)).unwrap();
        let host = UpdaterHost {
            search_path: Some(bin.clone().into_os_string()),
            temp_dir: Some(temp.clone()),
            ..offer.host(DEB, FAST)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        run(host.download(app.handle(), &executor, progress)).unwrap();

        assert_eq!(run(host.install(app.handle(), &executor)), Ok(()));

        assert!(
            std::fs::read(&target).unwrap() == b"untouched",
            "the planted symlink's target is never written"
        );
        assert_eq!(
            std::fs::read_to_string(&record).unwrap(),
            "700\n600\n",
            "dpkg reads a 0600 file in a 0700 folder"
        );
        assert_eq!(
            std::fs::read(record.with_extension("deb")).unwrap(),
            offer.payload
        );
        let mut left: Vec<_> = std::fs::read_dir(&temp)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        left.sort();
        assert_eq!(
            left,
            ["canopi-update-9.0.0.deb", "planted"],
            "the private folder is removed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_deb_install_without_pkexec_on_path_is_admin_prompt_unavailable() {
        let offer = Offer::signed(DEB);
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let bin = fake_pkexec(0);
        let host = UpdaterHost {
            search_path: Some(bin.clone().into_os_string()),
            ..offer.host(DEB, FAST)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        run(host.download(app.handle(), &executor, progress)).unwrap();
        std::fs::remove_file(bin.join("pkexec")).unwrap();
        assert_eq!(
            code(run(host.install(app.handle(), &executor))),
            UpdateFailureCode::UpdateAdminPromptUnavailable
        );
    }

    #[test]
    fn a_verified_appimage_replaces_the_running_one() {
        let offer = Offer::signed(APPIMAGE);
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let appimage = scratch("appimage").join("Canopi.AppImage");
        plant_appimage(&appimage, &elf_payload(128));
        let host = UpdaterHost {
            appimage: Some(appimage.clone()),
            ..offer.host(APPIMAGE, FAST)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        run(host.download(app.handle(), &executor, progress)).unwrap();

        assert_eq!(run(host.install(app.handle(), &executor)), Ok(()));
        assert_eq!(std::fs::read(&appimage).unwrap(), offer.payload);
    }

    #[cfg(test)]
    fn plant_appimage(path: &std::path::Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// The child half of the AppImage replace failure: the file-size limit lets the backup move but
    /// fails the new AppImage's write, so the plugin restores the backup.
    const REPLACE_FAILURE_CHILD: &str = "CANOPI_UPDATER_REPLACE_FAILURE_CHILD";

    #[cfg(target_os = "linux")]
    #[test]
    fn an_appimage_replace_failure_restores_the_backup_and_keeps_the_design_open() {
        if std::env::var_os(REPLACE_FAILURE_CHILD).is_some() {
            replace_failure_child();
            return;
        }
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host::updater::install::tests::an_appimage_replace_failure_restores_the_backup_and_keeps_the_design_open",
                "--nocapture",
            ])
            .env(REPLACE_FAILURE_CHILD, "1")
            .output()
            .unwrap();
        let output = String::from_utf8_lossy(&child.stdout);
        assert!(
            child.status.success(),
            "{output}\n{}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(output.contains("replace failure settled"), "{output}");
    }

    /// Runs in the child process only: its file-size limit would fail every other test's writes.
    #[cfg(target_os = "linux")]
    #[cfg(test)]
    fn replace_failure_child() {
        let offer = Offer::signed(APPIMAGE);
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let appimage = scratch("replace-failure").join("Canopi.AppImage");
        let running = elf_payload(128);
        plant_appimage(&appimage, &running);
        let host = UpdaterHost {
            appimage: Some(appimage.clone()),
            ..offer.host(APPIMAGE, FAST)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        run(host.download(app.handle(), &executor, progress)).unwrap();
        let limit = libc::rlimit {
            rlim_cur: 4096,
            rlim_max: libc::RLIM_INFINITY,
        };
        // SAFETY: `limit` is a valid rlimit for the call's duration; ignoring SIGXFSZ makes an
        // over-limit write fail with EFBIG instead of ending the process.
        unsafe {
            assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
        }

        let installed = run(host.install(app.handle(), &executor));

        assert_eq!(
            installed.map_err(|failure| failure.code),
            Err(UpdateFailureCode::UpdateInstallFailed {
                bundle: UpdateBundle::Appimage
            })
        );
        assert_eq!(
            std::fs::read(&appimage).unwrap(),
            running,
            "the backup is restored"
        );
        assert!(
            host.ops().staged.is_some(),
            "the Design stays open and Retry can install again"
        );
        println!("replace failure settled");
    }
}
