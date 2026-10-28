//! The updater's launch side: the launch-check key row (2.1-Q164, 2.1-M206) through its
//! `services::settings` helper, and the restart into the updated Canopi (2.1-M209).

use std::{ffi::OsString, path::PathBuf};

use common_types::update::{UpdateFailure, UpdateFailureCode, UpdateLane, UpdateOp};
use tauri::{AppHandle, Manager as _, Runtime};

use super::failure;
use crate::{
    db::UserDb,
    native_operation::{NativeOperationClass, NativeOperationExecutor},
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

/// The relaunch's arguments: the binary, then the Design path alone (no flag; the launch parser
/// opens it), or nothing for a Draft, which restarts to the start screen.
fn restart_args(current: &[OsString], design_path: Option<PathBuf>) -> Vec<OsString> {
    current
        .first()
        .cloned()
        .into_iter()
        .chain(design_path.map(PathBuf::into_os_string))
        .collect()
}

/// Restarts into the updated Canopi with the open Design: the single-instance name released so
/// the relaunch is the primary instance, Tauri's exit cleanup run, then the relaunch. Called off
/// the main thread (the restart probe's finding).
pub fn restart<R: Runtime>(app: &AppHandle<R>, design_path: Option<PathBuf>) -> ! {
    let mut env = app.env();
    env.args_os = restart_args(&env.args_os, design_path);
    crate::host::single_instance::release(app);
    app.cleanup_before_exit();
    tauri::process::restart(&env)
}

#[cfg(test)]
mod tests {
    use super::restart_args;
    use std::{ffi::OsString, path::PathBuf};

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
