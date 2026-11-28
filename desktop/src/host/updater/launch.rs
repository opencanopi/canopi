//! The updater's launch side: the exits into the updated Canopi (2.1-M209): the Linux
//! restart and the Windows installer start, each after the bounded write drain (2.1-M82), each
//! relaunching with the open Design (`restart_args`).

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager as _, Runtime};

use crate::native_operation::{
    EXIT_DRAIN_DEADLINE, ExitDrain, NativeOperationClass, NativeOperationExecutor,
};

/// The relaunch's arguments: the binary alone, with no Design path or prior launch arguments
/// because launch reopens the last open home from settings (2.1-Q127, 2.1-M523).
fn restart_args(current: &[OsString]) -> Vec<OsString> {
    current.first().cloned().into_iter().collect()
}

/// The Windows relaunch's arguments after the binary: always empty because launch reopens the
/// last open home from settings (2.1-Q127, 2.1-M523).
pub(super) fn relaunch_args() -> Vec<OsString> {
    Vec::new()
}

/// Restarts into the updated Canopi with no Design path argument (2.1-M523). Called off the main
/// thread (the restart probe's finding).
pub fn restart<R: Runtime>(app: &AppHandle<R>) -> ! {
    let env = prepare_restart(app);
    tauri::process::restart(&env)
}

/// Everything before the relaunch: the writes in flight drained (`tauri::process::restart` ends
/// the process without the exit event's drain), the single-instance name released so the relaunch
/// is the primary instance, Tauri's exit cleanup run; answers the relaunch's environment.
fn prepare_restart<R: Runtime>(app: &AppHandle<R>) -> tauri::Env {
    crate::host::exit::flush_writes_before_exit(app);
    let mut env = app.env();
    env.args_os = restart_args(&env.args_os);
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
/// crate-private), so Canopi builds the command itself. NSIS: ``/P /UPDATE /R /ARGS `<args>` ``, a
/// layer the plugin lacks: the installer reads the value with NSIS `GetOptions`, which strips one
/// pair of outer quotes and stops at an unquoted `/`, so a path with a space would reach the
/// relaunch split in two; the value is wrapped in the first of `` ` ``, `'` and `"` it lacks (a
/// quote inside would close the wrap early), which `GetOptions` strips, and the Windows quotes
/// inside reach `RunAsUser` whole. A path holding a backtick and an apostrophe leaves no free quote,
/// so its `/` become `\`, the same Windows path, and nothing can end the value early
/// (canopi-f47t.52.228.53, the round trip in `launch/nsis_round_trip.rs`). A Draft keeps the bare
/// `/ARGS`. MSI:
/// `msiexec /i <package> /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS="<args>"`.
/// Argument escaping after tauri-plugin-updater 2.14.1 (MIT or Apache-2.0).
pub(super) fn installer_command(
    bundle: canopi_types::update::UpdateBundle,
    installer: &Path,
    relaunch: &[OsString],
    system_root: Option<&OsStr>,
) -> InstallerCommand {
    if bundle == canopi_types::update::UpdateBundle::Msi {
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
    if !relaunch.is_empty() {
        let value = |separator: &str| {
            relaunch
                .iter()
                .map(|arg| {
                    escape_nsis_arg(OsStr::new(&arg.to_string_lossy().replace('/', separator)))
                })
                .collect::<Vec<_>>()
                .join(" ")
        };
        let escaped = value("/");
        let (quote, escaped) = match ['`', '\'', '"'].into_iter().find(|q| !escaped.contains(*q)) {
            Some(quote) => (quote, escaped),
            None => ('`', value("\\")),
        };
        parameters.push_str(&format!(" {quote}{escaped}{quote}"));
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

/// Ends Canopi once its installer has started: the drain kept, so no write starts, the
/// single-instance name released, Tauri's exit cleanup run.
pub(super) fn exit_into_installer<R: Runtime>(app: &AppHandle<R>, drain: ExitDrain) -> ! {
    drain.keep();
    crate::host::single_instance::release(app);
    app.cleanup_before_exit();
    std::process::exit(0)
}

mod nsis_round_trip;

#[cfg(test)]
mod tests {
    use super::{InstallerCommand, prepare_restart, restart_args, start_installer_after_drain};
    use crate::{
        host::updater::testkit::{mock_app, run},
        native_operation::{NativeOperationClass, NativeOperationExecutor},
    };
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

    /// 2.1-M523: the install's relaunch passes no Design path (launch reopens the last open home).
    #[test]
    fn the_install_relaunches_without_a_design_path() {
        use crate::host::updater::{
            UpdaterHost,
            testkit::{APPIMAGE, FAST},
        };
        let app = mock_app("unused");
        let host = UpdaterHost::for_test(APPIMAGE, FAST, "http://127.0.0.1:9/stable.json");

        assert!(host.install_context(app.handle()).relaunch.is_empty());
    }

    /// 2.1-M523: Windows installers relaunch with no Design path argument (bare `/ARGS` on NSIS,
    /// empty `LAUNCHAPPARGS` on MSI), while `installer_command` still escapes explicit args.
    #[test]
    fn the_windows_installer_relaunches_without_a_design_path() {
        use canopi_types::update::UpdateBundle;
        let installer = PathBuf::from("C:\\Temp\\canopi-update-1\\Canopi-update-setup.exe");
        let package = PathBuf::from("C:\\Temp\\canopi-update-1\\Canopi-update.msi");
        let nsis = super::installer_command(
            UpdateBundle::Nsis,
            &installer,
            &super::relaunch_args(),
            None,
        );
        let msi = super::installer_command(
            UpdateBundle::Msi,
            &package,
            &super::relaunch_args(),
            Some(std::ffi::OsStr::new("C:\\Windows")),
        );

        assert_eq!(
            (nsis, msi),
            (
                InstallerCommand {
                    program: installer,
                    parameters: OsString::from("/P /UPDATE /R /ARGS"),
                },
                InstallerCommand {
                    program: PathBuf::from("C:\\Windows")
                        .join("System32")
                        .join("msiexec.exe"),
                    parameters: OsString::from(
                        "/i \"C:\\Temp\\canopi-update-1\\Canopi-update.msi\" /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS=\"\"",
                    ),
                },
            )
        );
    }

    /// The MSI's `LAUNCHAPPARGS` keeps each relaunch argument whole: one holding a space or a quote
    /// is wrapped in doubled quotes, an `=` inside a path stays in the path, and only an option
    /// (`-name=value`) is quoted after its `=`.
    #[test]
    fn msi_relaunch_arguments_each_stay_one_launchappargs_argument() {
        use canopi_types::update::UpdateBundle;
        let package = PathBuf::from("C:\\Temp\\Canopi-update.msi");
        for (arg, value) in [
            ("C:\\Gardens\\A.canopi", "C:\\Gardens\\A.canopi"),
            (
                "C:\\My Gardens\\a=b.canopi",
                "\"\"C:\\My Gardens\\a=b.canopi\"\"",
            ),
            (
                "-design=C:\\My Gardens\\B.canopi",
                "-design=\"\"C:\\My Gardens\\B.canopi\"\"",
            ),
            ("", "\"\"\"\""),
        ] {
            let command =
                super::installer_command(UpdateBundle::Msi, &package, &[OsString::from(arg)], None);
            assert_eq!(
                (command.program, command.parameters),
                (
                    PathBuf::from("msiexec.exe"),
                    OsString::from(format!(
                        "/i \"C:\\Temp\\Canopi-update.msi\" /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS=\"{value}\""
                    ))
                ),
                "{arg}"
            );
        }
    }

    /// canopi-f47t.52.228.15, 2.1-Q234: a launch with no pending-update marker gives no notice.
    /// The app has an identifier of its own, so its app data folder holds no marker.
    #[test]
    fn canopi_f47t_52_228_15_with_no_pending_update_marker_the_launch_notice_is_false() {
        use crate::host::updater::{
            UpdaterHost,
            testkit::{APPIMAGE, FAST},
        };
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier =
            format!("org.canopi.test.no-marker-{}", std::process::id());
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("the mock app builds");
        let host = UpdaterHost::for_test(APPIMAGE, FAST, "http://127.0.0.1:9/stable.json");
        let marker = host.install_context(app.handle()).marker.unwrap();
        assert!(!marker.exists(), "{}", marker.display());

        assert_eq!(
            run(host.take_launch_notice(app.handle(), &NativeOperationExecutor::production())),
            Ok(false)
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

        let env = prepare_restart(app.handle());

        assert_eq!((landed.try_recv(), env.args_os.len()), (Ok(()), 1));
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
    fn the_relaunch_passes_the_binary_alone_and_drops_prior_args() {
        let current: Vec<OsString> = ["/opt/canopi/canopi", "--flag", "/old.canopi"]
            .map(OsString::from)
            .to_vec();
        assert_eq!(
            restart_args(&current),
            ["/opt/canopi/canopi"].map(OsString::from)
        );
    }
}
