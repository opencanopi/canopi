//! The one module that names `tauri_plugin_updater` (ast-grep `updater-plugin-only-in-updater`,
//! ADR 0023; cargo-deny admits the crate only through canopi-desktop): Desktop self-update
//! (ADR 0029 Release safety, contracts §3 Updater).
//!
//! One op at a time: a second check awaits the running one's result, a second download joins the
//! running download (its progress reaches every caller). Until N0's `OpSpec`, the check and the
//! download each run inside one `NativeOperationExecutor::run(Network, ..)` with `block_on` of the
//! plugin's future raced against the updater's cancel signal, so a cancel drops the transfer and
//! stages nothing; the install's verify, temp write, `pkexec` and replace run on the Local class
//! (2.1-M207, 2.1-M241). The payload stays in memory.
//!
//! The plugin asks the channel file for this installer's `{os}-{arch}-{bundle}` key only, its
//! client is configured (User-Agent, timeouts, redirects to the endpoint table's hosts only) through
//! `configure_client` and `http::UpdaterClient`, never replaced, and an announced payload must be on
//! the endpoint table's hosts (2.1-M210).

mod channel;
mod failure;
mod install;
mod launch;
mod testkit;

use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use common_types::update::{
    NetworkFailureKind, UpdateDownload, UpdateFailure, UpdateFailureCode, UpdateLane, UpdateOffer,
    UpdateOp, UpdateProgress,
};
use tauri::{AppHandle, Manager as _, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tokio::sync::watch;

use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};
use channel::{Channel, Endpoints, Installation};

pub use launch::{launch_check_get, launch_check_set, restart};

/// The plugin, registered by [`super::register`]; its settings are `tauri.conf.json`'s
/// `plugins.updater` (the public key, `requireSignedVersion`, no downgrades).
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

/// How long and how large an update may be. Measured on v2.0.3's artifacts: the largest, the
/// AppImage, is 510 MB (the .deb and MSI 475 MB, the NSIS installer 305 MB), so the cap is twice it.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// The channel file check, request to body.
    pub check_timeout: Duration,
    /// Reaching a host.
    pub connect_timeout: Duration,
    /// No progress on the payload for this long ends the download.
    pub stall_timeout: Duration,
    /// The largest payload accepted, in bytes.
    pub size_cap: u64,
}

impl Limits {
    /// The shipped limits.
    pub const PRODUCTION: Self = Self {
        check_timeout: Duration::from_secs(30),
        connect_timeout: Duration::from_secs(15),
        stall_timeout: Duration::from_secs(60),
        size_cap: 1 << 30,
    };
}

type CheckSettlement = Result<Option<UpdateOffer>, UpdateFailure>;
type DownloadSettlement = Result<UpdateDownload, UpdateFailure>;
/// Where a download's progress goes; the command's channel in the app.
pub type ProgressSink = Arc<dyn Fn(UpdateProgress) + Send + Sync>;

/// Every caller's progress sink of the running download.
type Sinks = Arc<Mutex<Vec<ProgressSink>>>;

/// The verified payload and the update it belongs to.
#[derive(Clone)]
struct Staged {
    update: Update,
    bytes: Arc<Vec<u8>>,
}

#[derive(Default)]
struct Ops {
    check: Option<watch::Receiver<Option<CheckSettlement>>>,
    download: Option<(watch::Receiver<Option<DownloadSettlement>>, Sinks)>,
    offered: Option<Update>,
    staged: Option<Staged>,
}

/// Whose turn an op call is: lead the op, or await the running one.
enum Turn<L, T> {
    Lead(L),
    Follow(watch::Receiver<Option<T>>),
}

/// The running op's result channel when one is still running.
fn running<T>(slot: &Option<watch::Receiver<Option<T>>>) -> Option<watch::Receiver<Option<T>>> {
    slot.as_ref()
        .filter(|receiver| receiver.has_changed().is_ok() && receiver.borrow().is_none())
        .cloned()
}

/// Awaits a running op's settlement.
async fn follow<T: Clone>(
    mut receiver: watch::Receiver<Option<T>>,
    op: UpdateOp,
) -> Result<T, UpdateFailure> {
    match receiver.wait_for(Option::is_some).await {
        Ok(settled) => settled.clone().ok_or_else(|| interrupted(op)),
        Err(_) => Err(interrupted(op)),
    }
}

fn interrupted(op: UpdateOp) -> UpdateFailure {
    failure::failure(
        op,
        UpdateFailureCode::Internal,
        "the running update operation stopped",
    )
}

/// The updater's managed state.
pub struct UpdaterHost {
    endpoints: Endpoints,
    limits: Limits,
    installation: Option<Installation>,
    channel: Option<Channel>,
    /// Test seams: a local channel file and its host, the AppImage path, the `PATH` searched for
    /// `pkexec` and the folder the `.deb` is written to.
    endpoint: Option<tauri::Url>,
    local_host: Option<String>,
    appimage: Option<PathBuf>,
    search_path: Option<OsString>,
    temp_dir: Option<PathBuf>,
    /// Each cancel moves the generation; an op started at an earlier one stops.
    cancel: watch::Sender<u64>,
    ops: Mutex<Ops>,
}

impl UpdaterHost {
    /// The running build's updater: its installation, its channel and the shipped limits.
    pub fn production() -> Self {
        Self::new(
            Installation::current(),
            Channel::running(),
            Limits::PRODUCTION,
        )
    }

    fn new(installation: Option<Installation>, channel: Option<Channel>, limits: Limits) -> Self {
        Self {
            endpoints: Endpoints::compiled(),
            limits,
            installation,
            channel,
            endpoint: None,
            local_host: None,
            appimage: None,
            search_path: None,
            temp_dir: None,
            cancel: watch::Sender::new(0),
            ops: Mutex::default(),
        }
    }

    /// A test updater for `installation` reading the channel file at `endpoint`, whose host
    /// counts as allowed.
    #[cfg(test)]
    fn for_test(installation: Installation, limits: Limits, endpoint: &str) -> Self {
        let endpoint: tauri::Url = endpoint.parse().unwrap();
        Self {
            local_host: endpoint.host_str().map(str::to_owned),
            endpoint: Some(endpoint),
            search_path: Some(OsString::new()),
            ..Self::new(Some(installation), Some(Channel::Stable), limits)
        }
    }

    fn ops(&self) -> MutexGuard<'_, Ops> {
        self.ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Cancels the running check or download: its transfer is dropped, nothing is staged and it
    /// settles `cancelled`. A cancel with nothing running does nothing.
    pub fn cancel(&self) {
        self.cancel.send_modify(|generation| *generation += 1);
    }

    /// The plugin's updater for `installation`: this installer's key only, read from `endpoint`,
    /// the client configured, never replaced.
    fn plugin_updater<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        installation: Installation,
        endpoint: tauri::Url,
        op: UpdateOp,
    ) -> Result<tauri_plugin_updater::Updater, UpdateFailure> {
        let mut allowed_hosts = self.endpoints.allowed_hosts();
        allowed_hosts.extend(self.local_host.clone());
        let client = crate::http::UpdaterClient {
            user_agent: concat!("Canopi/", env!("CARGO_PKG_VERSION")),
            connect_timeout: self.limits.connect_timeout,
            read_timeout: self.limits.stall_timeout,
            allowed_hosts,
        };
        let mut builder = app
            .updater_builder()
            .target(installation.key())
            .timeout(self.limits.check_timeout)
            .configure_client(move |builder| client.configure(builder));
        if let Some(appimage) = &self.appimage {
            builder = builder.executable_path(appimage);
        }
        builder
            .endpoints(vec![endpoint])
            .and_then(tauri_plugin_updater::UpdaterBuilder::build)
            .map_err(|error| failure::from_plugin(op, installation, &error))
    }

    /// Checks the channel for a newer release for this installer; `None` when there is none, or
    /// when this build has no installer to update. A second call while one runs awaits its result.
    pub async fn check<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
    ) -> CheckSettlement {
        let turn = {
            let mut ops = self.ops();
            match running(&ops.check) {
                Some(receiver) => Turn::Follow(receiver),
                None => {
                    let (sender, receiver) = watch::channel(None);
                    ops.check = Some(receiver);
                    Turn::Lead(sender)
                }
            }
        };
        let sender = match turn {
            Turn::Follow(receiver) => return follow(receiver, UpdateOp::Check).await?,
            Turn::Lead(sender) => sender,
        };
        let settlement = self.run_check(app, executor).await;
        let offered = settlement
            .as_ref()
            .ok()
            .and_then(|(update, _)| update.clone());
        let result = settlement.map(|(_, offer)| offer);
        {
            let mut ops = self.ops();
            ops.offered = offered;
            ops.check = None;
        }
        sender.send_replace(Some(result.clone()));
        result
    }

    async fn run_check<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
    ) -> Result<(Option<Update>, Option<UpdateOffer>), UpdateFailure> {
        let (Some(installation), Some(channel)) = (self.installation, self.channel) else {
            return Ok((None, None));
        };
        let Some(endpoint) = self
            .endpoint
            .clone()
            .or_else(|| self.endpoints.channel_url(channel))
        else {
            return Ok((None, None));
        };
        let updater = self.plugin_updater(app, installation, endpoint, UpdateOp::Check)?;
        let mut cancel = self.cancel.subscribe();
        let started = *cancel.borrow_and_update();
        let update = executor
            .run(NativeOperationClass::Network, "updater.check", move || {
                Ok(tauri::async_runtime::block_on(async move {
                    tokio::select! {
                        checked = updater.check() => checked
                            .map_err(|error| failure::from_plugin(UpdateOp::Check, installation, &error)),
                        _ = cancel.wait_for(|generation| *generation != started) =>
                            Err(failure::cancelled(UpdateOp::Check)),
                    }
                }))
            })
            .await
            .map_err(|message| failure::executor(UpdateOp::Check, UpdateLane::Network, &message))??;
        let Some(update) = update else {
            return Ok((None, None));
        };
        let offer = UpdateOffer {
            version: update.version.clone(),
            date: update.raw_json["pub_date"].as_str().map(str::to_owned),
            notes_url: self.endpoints.release_page(&update.version),
        };
        Ok((Some(update), Some(offer)))
    }

    /// Downloads and verifies the offered update, or answers `link_only` when this installer
    /// cannot replace itself. A second call while one runs joins it and hears its progress.
    pub async fn download<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
        progress: ProgressSink,
    ) -> DownloadSettlement {
        let turn = {
            let mut ops = self.ops();
            let joined = ops
                .download
                .as_ref()
                .and_then(|(receiver, sinks)| Some((running(&Some(receiver.clone()))?, sinks)));
            if let Some((receiver, sinks)) = joined {
                sinks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(progress);
                Turn::Follow(receiver)
            } else {
                let (sender, receiver) = watch::channel(None);
                let sinks = Arc::new(Mutex::new(vec![progress]));
                ops.download = Some((receiver, Arc::clone(&sinks)));
                Turn::Lead((sender, sinks))
            }
        };
        let (sender, sinks) = match turn {
            Turn::Follow(receiver) => return follow(receiver, UpdateOp::Download).await?,
            Turn::Lead(lead) => lead,
        };
        let result = self.run_download(app, executor, sinks).await;
        self.ops().download = None;
        sender.send_replace(Some(result.clone()));
        result
    }

    async fn run_download<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
        sinks: Sinks,
    ) -> DownloadSettlement {
        let op = UpdateOp::Download;
        let (Some(installation), Some(update)) = (self.installation, self.ops().offered.clone())
        else {
            return Err(failure::failure(
                op,
                UpdateFailureCode::Invalid,
                "no update was offered",
            ));
        };
        if !install::can_replace_itself(installation.bundle, &self.install_context(app)) {
            return Ok(UpdateDownload::LinkOnly {
                url: self.endpoints.download_page().to_owned(),
            });
        }
        let local = self
            .local_host
            .as_deref()
            .is_some_and(|host| update.download_url.host_str() == Some(host));
        if !local && !self.endpoints.allows(&update.download_url) {
            return Err(failure::network(
                op,
                NetworkFailureKind::HostNotAllowed,
                "the payload is announced on a host outside the endpoint table",
            ));
        }
        let size_cap = self.limits.size_cap;
        let mut cancel = self.cancel.subscribe();
        let started = *cancel.borrow_and_update();
        let staged_update = update.clone();
        let bytes = executor
            .run(
                NativeOperationClass::Network,
                "updater.download",
                move || {
                    Ok(tauri::async_runtime::block_on(transfer(
                        &update,
                        installation,
                        size_cap,
                        &sinks,
                        cancel.wait_for(move |generation| *generation != started),
                    )))
                },
            )
            .await
            .map_err(|message| failure::executor(op, UpdateLane::Network, &message))??;
        self.ops().staged = Some(Staged {
            update: staged_update,
            bytes: Arc::new(bytes),
        });
        Ok(UpdateDownload::Verified)
    }

    fn install_context<R: Runtime>(&self, app: &AppHandle<R>) -> install::Context {
        install::Context {
            appimage: self.appimage.clone().or_else(|| running_appimage(app)),
            search_path: self
                .search_path
                .clone()
                .or_else(|| std::env::var_os("PATH")),
            temp_dir: self.temp_dir.clone().unwrap_or_else(std::env::temp_dir),
            marker: app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join(install::MARKER_FILE)),
        }
    }

    /// Installs the verified payload: on Linux while Canopi runs (the `.deb` through Canopi's own
    /// `pkexec dpkg -i`, the AppImage by the plugin's replace); on Windows the pending-update
    /// marker is written, then the installer runs and Canopi exits. Every failure leaves the
    /// Design open; nothing relaunches.
    pub async fn install<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
    ) -> Result<(), UpdateFailure> {
        let op = UpdateOp::Install;
        let (Some(installation), Some(staged)) = (self.installation, self.ops().staged.take())
        else {
            return Err(failure::failure(
                op,
                UpdateFailureCode::Invalid,
                "no verified update",
            ));
        };
        let context = self.install_context(app);
        let Staged { update, bytes } = staged.clone();
        let installed = executor
            .run(NativeOperationClass::Local, "updater.install", move || {
                Ok(install::install(installation, &context, &update, &bytes))
            })
            .await
            .map_err(|message| failure::executor(op, UpdateLane::Local, &message))
            .and_then(|installed| installed);
        if installed.is_err() {
            // The verified payload stays staged, so Retry installs it without a new download.
            self.ops().staged.get_or_insert(staged);
        }
        installed
    }

    /// Whether this launch follows a Windows update that did not install: read once, the marker
    /// cleared (2.1-Q234).
    pub async fn take_launch_notice<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
    ) -> Result<bool, UpdateFailure> {
        let marker = self.install_context(app).marker;
        let running = app.package_info().version.clone();
        executor
            .run(
                NativeOperationClass::Local,
                "updater.launch_notice",
                move || Ok(marker.is_some_and(|marker| install::take_marker(&marker, &running))),
            )
            .await
            .map_err(|message| failure::executor(UpdateOp::Install, UpdateLane::Local, &message))
    }
}

/// The AppImage Canopi runs as, from `APPIMAGE`.
#[cfg(target_os = "linux")]
fn running_appimage<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.env().appimage.map(PathBuf::from)
}

#[cfg(not(target_os = "linux"))]
fn running_appimage<R: Runtime>(_: &AppHandle<R>) -> Option<PathBuf> {
    None
}

/// The payload's transfer: the plugin's download raced against `cancelled` and the size cap its
/// chunk callback watches; progress goes to every sink.
async fn transfer(
    update: &Update,
    installation: Installation,
    size_cap: u64,
    sinks: &Mutex<Vec<ProgressSink>>,
    cancelled: impl std::future::Future,
) -> Result<Vec<u8>, UpdateFailure> {
    let op = UpdateOp::Download;
    let (over_cap, mut watching) = watch::channel(false);
    let mut received: u64 = 0;
    let on_chunk = |length: usize, total: Option<u64>| {
        received = received.saturating_add(length as u64);
        if received > size_cap || total.is_some_and(|total| total > size_cap) {
            over_cap.send_replace(true);
            return;
        }
        let progress = UpdateProgress {
            received: u32::try_from(received).unwrap_or(u32::MAX),
            total: total.and_then(|total| u32::try_from(total).ok()),
        };
        for sink in sinks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            sink(progress);
        }
    };
    let too_large = || {
        failure::network(
            op,
            NetworkFailureKind::TooLarge,
            "the payload is larger than its cap",
        )
    };
    let downloaded = tokio::select! {
        biased;
        _ = cancelled => return Err(failure::cancelled(op)),
        _ = watching.wait_for(|over| *over) => return Err(too_large()),
        downloaded = update.download(on_chunk, || {}) => downloaded,
    };
    // A payload that arrived whole in one poll passed the cap before the watch was read.
    if *watching.borrow() {
        return Err(too_large());
    }
    downloaded.map_err(|error| failure::from_plugin(op, installation, &error))
}

mod tests;
