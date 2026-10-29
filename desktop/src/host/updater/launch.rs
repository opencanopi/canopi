//! The updater's launch side: the launch-check key row (2.1-Q164, 2.1-M206) through its
//! `services::settings` helper, and the exits into the updated Canopi (2.1-M209): the Linux
//! restart and the Windows installer start, each after the bounded write drain (2.1-M82), each
//! relaunching with the open Design (`restart_args`).

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use common_types::update::{UpdateFailure, UpdateFailureCode, UpdateLane, UpdateOp};
use tauri::{AppHandle, Manager as _, Runtime};

use super::failure;
use crate::{
    db::UserDb,
    native_operation::{
        EXIT_DRAIN_DEADLINE, ExitDrain, NativeOperationClass, NativeOperationExecutor,
    },
    services::settings,
};

fn row_failure(_: String) -> UpdateFailure {
    failure::failure(
        UpdateOp::Check,
        UpdateFailureCode::Internal,
        "the launch check setting could not be read or written",
    )
}

/// Whether Canopi checks for an update at launch; a missing row reads on.
pub async fn launch_check_get(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
) -> Result<bool, UpdateFailure> {
    executor
        .run(
            NativeOperationClass::UserData,
            "updater.launch_check_get",
            move || Ok(settings::updater_check_at_launch(&user_db).map_err(row_failure)),
        )
        .await
        .map_err(|message| failure::executor(UpdateOp::Check, UpdateLane::Local, &message))?
}

/// Stores whether Canopi checks for an update at launch.
pub async fn launch_check_set(
    executor: &NativeOperationExecutor,
    user_db: UserDb,
    on: bool,
) -> Result<(), UpdateFailure> {
    executor
        .run(
            NativeOperationClass::UserData,
            "updater.launch_check_set",
            move || Ok(settings::set_updater_check_at_launch(&user_db, on).map_err(row_failure)),
        )
        .await
        .map_err(|message| failure::executor(UpdateOp::Check, UpdateLane::Local, &message))?
}

/// The relaunch's arguments, on Linux and Windows alike: the binary, then the Design path alone
/// (no flag; the launch parser opens it), or nothing for a Draft, which restarts to the start
/// screen. Never the launch's own arguments: launched with A and switched to B, the relaunch
/// reopens B (plan:194).
fn restart_args(current: &[OsString], design_path: Option<PathBuf>) -> Vec<OsString> {
    current
        .first()
        .cloned()
        .into_iter()
        .chain(design_path.map(PathBuf::into_os_string))
        .collect()
}

/// The Windows relaunch's arguments, the installer's to pass after the binary: [`restart_args`]
/// without the binary.
pub(super) fn relaunch_args(current: &[OsString], design_path: Option<PathBuf>) -> Vec<OsString> {
    restart_args(current, design_path)
        .into_iter()
        .skip(1)
        .collect()
}

/// Restarts into the updated Canopi with the open Design. Called off the main thread (the
/// restart probe's finding).
pub fn restart<R: Runtime>(app: &AppHandle<R>, design_path: Option<PathBuf>) -> ! {
    let env = prepare_restart(app, design_path);
    tauri::process::restart(&env)
}

/// Everything before the relaunch: the writes in flight drained (`tauri::process::restart` ends
/// the process without the exit event's drain), the single-instance name released so the relaunch
/// is the primary instance, Tauri's exit cleanup run; answers the relaunch's environment.
fn prepare_restart<R: Runtime>(app: &AppHandle<R>, design_path: Option<PathBuf>) -> tauri::Env {
    crate::flush_writes_before_exit(app);
    let mut env = app.env();
    env.args_os = restart_args(&env.args_os, design_path);
    crate::host::single_instance::release(app);
    app.cleanup_before_exit();
    env
}

/// How the Windows installer is started: the program and its command line as one string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InstallerCommand {
    pub program: PathBuf,
    pub parameters: OsString,
}

/// The Windows installer's command for an update in the plugin's default `passive` mode (Canopi's
/// `plugins.updater` sets no `windows` section; a test holds it): the plugin's own arguments, with
/// the relaunch given `relaunch`, the arguments after the binary from [`restart_args`]. The plugin
/// takes the relaunch's arguments from the launch's argv only (its `current_exe_args` is
/// crate-private), so Canopi builds the command itself. NSIS: `/P /UPDATE /R /ARGS <args>`; MSI:
/// `msiexec /i <package> /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS="<args>"`.
/// Argument escaping after tauri-plugin-updater 2.14.1 (MIT or Apache-2.0).
pub(super) fn installer_command(
    bundle: common_types::update::UpdateBundle,
    installer: &Path,
    relaunch: &[OsString],
    system_root: Option<&OsStr>,
) -> InstallerCommand {
    if bundle == common_types::update::UpdateBundle::Msi {
        let program = system_root.map_or_else(
            || PathBuf::from("msiexec.exe"),
            |root| Path::new(root).join("System32").join("msiexec.exe"),
        );
        let launch_args = relaunch
            .iter()
            .map(|arg| escape_msi_property_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let parameters = format!(
            "/i \"{}\" /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS=\"{launch_args}\"",
            installer.to_string_lossy()
        );
        return InstallerCommand {
            program,
            parameters: parameters.into(),
        };
    }
    let mut parameters = String::from("/P /UPDATE /R /ARGS");
    for arg in relaunch {
        parameters.push(' ');
        parameters.push_str(&escape_nsis_arg(arg));
    }
    InstallerCommand {
        program: installer.to_path_buf(),
        parameters: parameters.into(),
    }
}

/// One relaunch argument on the NSIS installer's command line: quoted when it holds a space, a tab
/// or a `/` (which NSIS would read as its own option) or is empty, with the Windows rules for the
/// backslashes before a quote.
fn escape_nsis_arg(arg: &OsStr) -> String {
    let arg = arg.to_string_lossy();
    let quote = arg.is_empty() || arg.contains([' ', '\t', '/']);
    let mut escaped = String::new();
    if quote {
        escaped.push('"');
    }
    let mut backslashes = 0_usize;
    for character in arg.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                escaped.extend(std::iter::repeat_n('\\', backslashes + 1));
            }
            backslashes = 0;
        }
        escaped.push(character);
    }
    if quote {
        escaped.extend(std::iter::repeat_n('\\', backslashes));
        escaped.push('"');
    }
    escaped
}

/// One relaunch argument inside the MSI's `LAUNCHAPPARGS` property.
fn escape_msi_property_arg(arg: &OsStr) -> String {
    let arg = arg.to_string_lossy();
    if arg.is_empty() {
        return "\"\"\"\"".to_owned();
    }
    if !arg.contains([' ', '"']) {
        return arg.into_owned();
    }
    let arg = arg.replace('"', "\"\"\"\"");
    match arg.split_once('=') {
        Some((option, value)) if arg.starts_with('-') => format!("{option}=\"\"{value}\"\""),
        _ => format!("\"\"{arg}\"\""),
    }
}

/// Starts the Windows installer, which ends Canopi, once the writes in flight have landed
/// (2.1-M82), from inside the install's own Local operation. Answers the held drain: the caller
/// exits holding it, so no write starts after. An installer that cannot start drops it, and Canopi
/// stays open, saving again.
pub(super) fn start_installer_after_drain(
    executor: &NativeOperationExecutor,
    command: &InstallerCommand,
    start: impl FnOnce(&InstallerCommand) -> std::io::Result<()>,
) -> std::io::Result<ExitDrain> {
    let drain =
        executor.hold_writes_for_exit(EXIT_DRAIN_DEADLINE, Some(NativeOperationClass::Local));
    start(command).map(|()| drain)
}

/// Starts the installer with its command line as Windows reads it, unquoted by Rust.
#[cfg(windows)]
pub(super) fn start_installer(command: &InstallerCommand) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt as _;
    std::process::Command::new(&command.program)
        .raw_arg(&command.parameters)
        .spawn()
        .map(drop)
}

#[cfg(not(windows))]
pub(super) fn start_installer(_: &InstallerCommand) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

/// Ends Canopi once its installer has started: the drain kept, so no write starts, the
/// single-instance name released, Tauri's exit cleanup run.
pub(super) fn exit_into_installer<R: Runtime>(app: &AppHandle<R>, drain: ExitDrain) -> ! {
    drain.keep();
    crate::host::single_instance::release(app);
    app.cleanup_before_exit();
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::{
        InstallerCommand, launch_check_get, launch_check_set, prepare_restart, restart_args,
        start_installer_after_drain,
    };
    use crate::{
        db::UserDb,
        host::updater::testkit::{mock_app, run},
        native_operation::{NativeOperationClass, NativeOperationExecutor},
    };
    use rusqlite::Connection;
    use std::{ffi::OsString, path::PathBuf, sync::mpsc, time::Duration};
    use tauri::Manager as _;

    const WAIT: Duration = Duration::from_secs(2);

    /// A Design write the frontend has sent, still running: it lands when the test's timer fires.
    fn write_in_flight(executor: &NativeOperationExecutor) -> mpsc::Receiver<()> {
        let (landed_tx, landed) = mpsc::channel();
        let (started_tx, started) = mpsc::channel();
        let executor = executor.clone();
        tauri::async_runtime::spawn(async move {
            let _written = executor
                .run(NativeOperationClass::UserData, "design write", move || {
                    started_tx.send(()).ok();
                    std::thread::sleep(Duration::from_millis(50));
                    landed_tx.send(()).ok();
                    Ok(())
                })
                .await;
        });
        started.recv_timeout(WAIT).unwrap();
        landed
    }

    /// canopi-f47t.52.228.15, plan:194: launched with A and switched to B, the Windows relaunch
    /// reopens B, from the Linux restart's own arguments; a Draft relaunches to the start screen.
    #[test]
    fn the_windows_installer_relaunches_the_open_design_as_the_linux_restart_does() {
        use common_types::update::UpdateBundle;
        let current: Vec<OsString> = ["C:\\Canopi\\Canopi.exe", "C:\\Gardens\\A.canopi"]
            .map(OsString::from)
            .to_vec();
        let b = Some(PathBuf::from("C:\\My Gardens\\B.canopi"));
        let installer = PathBuf::from("C:\\Temp\\canopi-update-1\\Canopi-update-setup.exe");
        let package = PathBuf::from("C:\\Temp\\canopi-update-1\\Canopi-update.msi");
        let nsis = |design| {
            super::installer_command(
                UpdateBundle::Nsis,
                &installer,
                &super::relaunch_args(&current, design),
                None,
            )
        };
        let msi = super::installer_command(
            UpdateBundle::Msi,
            &package,
            &super::relaunch_args(&current, b.clone()),
            Some(std::ffi::OsStr::new("C:\\Windows")),
        );

        assert_eq!(
            (nsis(b.clone()), nsis(None), msi),
            (
                InstallerCommand {
                    program: installer.clone(),
                    parameters: OsString::from("/P /UPDATE /R /ARGS \"C:\\My Gardens\\B.canopi\""),
                },
                InstallerCommand {
                    program: installer.clone(),
                    parameters: OsString::from("/P /UPDATE /R /ARGS"),
                },
                InstallerCommand {
                    program: PathBuf::from("C:\\Windows")
                        .join("System32")
                        .join("msiexec.exe"),
                    parameters: OsString::from(
                        "/i \"C:\\Temp\\canopi-update-1\\Canopi-update.msi\" /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS=\"\"\"C:\\My Gardens\\B.canopi\"\"\"",
                    ),
                },
            )
        );
    }

    /// The installer's command is built for the plugin's default `passive` mode with no extra
    /// installer arguments: the shipped `plugins.updater` must not set a `windows` section.
    #[test]
    fn the_shipped_updater_settings_leave_the_windows_installer_at_its_defaults() {
        let config = crate::host::updater::testkit::shipped_updater_config("key");
        assert_eq!(config.get("windows"), None);
    }

    /// The NSIS command line keeps a relaunch argument whole: quoted at a space or a `/`, its
    /// quotes and the backslashes before them escaped.
    #[test]
    fn nsis_relaunch_arguments_are_escaped_as_the_plugin_escapes_them() {
        let escaped = [
            "plain",
            "",
            "a b",
            "C:/x",
            "say \"hi\"",
            "C:\\dir\\",
            "tail\\ end\\",
        ]
        .map(|arg| super::escape_nsis_arg(std::ffi::OsStr::new(arg)));
        assert_eq!(
            escaped,
            [
                "plain",
                "\"\"",
                "\"a b\"",
                "\"C:/x\"",
                "\"say \\\"hi\\\"\"",
                "C:\\dir\\",
                "\"tail\\ end\\\\\"",
            ]
        );
    }

    /// canopi-f47t.52.228.15: the Linux update restart ends this process with
    /// `tauri::process::restart`, which skips the exit event's drain, so it drains first.
    #[test]
    fn the_update_restart_lets_a_write_in_flight_land_before_it_relaunches() {
        let app = mock_app("unused");
        let executor = NativeOperationExecutor::production();
        app.manage(executor.clone());
        let landed = write_in_flight(&executor);

        let env = prepare_restart(app.handle(), Some(PathBuf::from("/home/g/b.canopi")));

        assert_eq!(
            (landed.try_recv(), env.args_os.last().cloned()),
            (Ok(()), Some(OsString::from("/home/g/b.canopi")))
        );
    }

    /// canopi-f47t.52.228.15: the Windows installer ends Canopi as it starts, so a write in
    /// flight lands before it starts; an installer that cannot start leaves Canopi saving again.
    #[test]
    fn the_windows_installer_starts_only_after_the_writes_in_flight_land() {
        let executor = NativeOperationExecutor::production();
        let command = InstallerCommand {
            program: PathBuf::from("C:\\Temp\\canopi-update\\Canopi-setup.exe"),
            parameters: OsString::from("/P /UPDATE"),
        };
        let landed = write_in_flight(&executor);
        let inner = executor.clone();
        let started =
            run(
                executor.run(NativeOperationClass::Local, "updater.install", move || {
                    let mut seen = None;
                    let drain = start_installer_after_drain(&inner, &command, |_| {
                        seen = Some(landed.try_recv().is_ok());
                        Ok(())
                    });
                    Ok((drain.is_ok(), seen))
                }),
            );

        let inner = executor.clone();
        let refused =
            run(
                executor.run(NativeOperationClass::Local, "updater.install", move || {
                    let command = InstallerCommand {
                        program: PathBuf::from("missing.exe"),
                        parameters: OsString::new(),
                    };
                    Ok(start_installer_after_drain(&inner, &command, |_| {
                        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
                    })
                    .is_err())
                }),
            );
        let saved_after =
            run(executor.run(NativeOperationClass::UserData, "design write", || Ok(())));

        assert_eq!(
            (started, refused, saved_after),
            (Ok((true, Some(true))), Ok(true), Ok(()))
        );
    }

    #[test]
    fn the_launch_check_reads_on_until_switched_off_through_the_executor() {
        let executor = NativeOperationExecutor::production();
        let user_db = UserDb::initialize(Connection::open_in_memory().unwrap()).unwrap();

        assert!(run(launch_check_get(&executor, user_db.clone())).unwrap());
        run(launch_check_set(&executor, user_db.clone(), false)).unwrap();
        assert!(!run(launch_check_get(&executor, user_db)).unwrap());
    }

    #[test]
    fn the_relaunch_names_the_design_path_alone_and_a_draft_names_nothing() {
        let current: Vec<OsString> = ["/opt/canopi/canopi", "--flag", "/old.canopi"]
            .map(OsString::from)
            .to_vec();
        assert_eq!(
            restart_args(&current, Some(PathBuf::from("/home/g/garden.canopi"))),
            ["/opt/canopi/canopi", "/home/g/garden.canopi"].map(OsString::from)
        );
        assert_eq!(
            restart_args(&current, None),
            ["/opt/canopi/canopi"].map(OsString::from)
        );
    }
}
