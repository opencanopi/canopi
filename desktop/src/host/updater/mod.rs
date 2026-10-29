//! The one module that names `tauri_plugin_updater` (ast-grep `updater-plugin-only-in-updater`,
//! ADR 0023; cargo-deny admits the crate only through canopi-desktop): Desktop self-update
//! (ADR 0029 Release safety, contracts §3 Updater).
//!
//! One op at a time: a second check awaits the running one's result, a second download joins the
//! running download (its progress reaches every caller), unless that run is cancelled. Each run has
//! one cancel signal its leader and followers share; `update_cancel` reaches a run only through the
//! id of an op in it. Until N0's `OpSpec`, check and download each run in one
//! `NativeOperationExecutor::run(Network, ..)`, `block_on` of the plugin's future raced against the
//! cancel signal, so a cancel drops the transfer and stages nothing (the payload stays in memory);
//! the install's verify, temp write, `pkexec` and replace run on the Local class (2.1-M207, M241).
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
mod transfer;

use std::{
    collections::{HashMap, VecDeque},
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

/// A run's cancel signal, shared by its leader and its followers; `true` once cancelled.
type CancelSignal = Arc<watch::Sender<bool>>;
/// A run's result channel, `None` until it settles.
type Settled<T> = watch::Receiver<Option<T>>;

#[derive(Default)]
struct Ops {
    check: Option<(Settled<CheckSettlement>, CancelSignal)>,
    download: Option<(Settled<DownloadSettlement>, Sinks, CancelSignal)>,
    offered: Option<Update>,
    staged: Option<Staged>,
}

/// Whose turn an op call is: lead the op, or await the running one.
enum Turn<L, T> {
    Lead(L),
    Follow(watch::Receiver<Option<T>>),
}

/// Whether a later op may join a run: unsettled and not cancelled (it would settle `cancelled`).
fn joinable<T>(receiver: &watch::Receiver<Option<T>>, signal: &CancelSignal) -> bool {
    receiver.has_changed().is_ok() && receiver.borrow().is_none() && !*signal.borrow()
}

/// The accepted, unsettled ops by id, each with its run's cancel signal, and the last few ids
/// cancelled before their op arrived.
#[derive(Default)]
struct Cancels {
    running: HashMap<String, CancelSignal>,
    early: VecDeque<String>,
}

/// An accepted op's place in [`Cancels::running`], left when the op settles or its call is dropped.
struct Accepted<'a> {
    host: &'a UpdaterHost,
    operation: String,
}

impl Drop for Accepted<'_> {
    fn drop(&mut self) {
        self.host.cancels().running.remove(&self.operation);
    }
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
    /// Locked before `ops` when both are held, never after.
    cancels: Mutex<Cancels>,
    ops: Mutex<Ops>,
}

/// How many early cancels are remembered: the webview runs one op at a time, so a few cover it.
const EARLY_CANCELS: usize = 8;

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
            cancels: Mutex::default(),
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

    /// Cancels the check or download `operation` names: its run's transfer is dropped, nothing is
    /// staged and the run settles `cancelled` for every caller in it. An `operation` that is not
    /// running is remembered, so it settles `cancelled` if it reaches the host only after this
    /// cancel (`update_cancel` runs on the main thread, the ops on the async runtime); any other op
    /// is left alone, also when the named op has already settled.
    pub fn cancel(&self, operation: &str) {
        let mut cancels = self.cancels();
        if let Some(signal) = cancels.running.get(operation) {
            signal.send_replace(true);
            return;
        }
        if cancels.early.len() == EARLY_CANCELS {
            cancels.early.pop_front();
        }
        cancels.early.push_back(operation.to_owned());
    }

    /// Accepts `operation` into the run `turn` picks under the ops lock: `cancelled` when a cancel
    /// named it before it arrived, otherwise its place among the running ops and its run's turn.
    fn accept<T>(
        &self,
        operation: &str,
        op: UpdateOp,
        turn: impl FnOnce(&mut Ops) -> (T, CancelSignal),
    ) -> Result<(Accepted<'_>, T, watch::Receiver<bool>), UpdateFailure> {
        let mut cancels = self.cancels();
        if let Some(index) = cancels.early.iter().position(|named| named == operation) {
            cancels.early.remove(index);
            return Err(failure::cancelled(op));
        }
        let (turn, signal) = turn(&mut self.ops());
        let cancelled = signal.subscribe();
        cancels.running.insert(operation.to_owned(), signal);
        let accepted = Accepted {
            host: self,
            operation: operation.to_owned(),
        };
        Ok((accepted, turn, cancelled))
    }

    fn cancels(&self) -> MutexGuard<'_, Cancels> {
        self.cancels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        operation: &str,
    ) -> CheckSettlement {
        let (_accepted, turn, cancelled) =
            self.accept(operation, UpdateOp::Check, |ops| match &ops.check {
                Some((receiver, signal)) if joinable(receiver, signal) => {
                    (Turn::Follow(receiver.clone()), Arc::clone(signal))
                }
                _ => {
                    let (sender, receiver) = watch::channel(None);
                    let signal = Arc::new(watch::Sender::new(false));
                    ops.check = Some((receiver, Arc::clone(&signal)));
                    (Turn::Lead(sender), signal)
                }
            })?;
        let sender = match turn {
            Turn::Follow(receiver) => return follow(receiver, UpdateOp::Check).await?,
            Turn::Lead(sender) => sender,
        };
        let settlement = self.run_check(app, executor, cancelled).await;
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
        mut cancelled: watch::Receiver<bool>,
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
        let update = executor
            .run(NativeOperationClass::Network, "updater.check", move || {
                Ok(tauri::async_runtime::block_on(async move {
                    tokio::select! {
                        checked = updater.check() => checked
                            .map_err(|error| failure::from_plugin(UpdateOp::Check, installation, &error)),
                        _ = cancelled.wait_for(|cancelled| *cancelled) =>
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
        operation: &str,
        progress: ProgressSink,
    ) -> DownloadSettlement {
        let (_accepted, turn, cancelled) =
            self.accept(operation, UpdateOp::Download, |ops| match &ops.download {
                Some((receiver, sinks, signal)) if joinable(receiver, signal) => {
                    sinks
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(progress);
                    (Turn::Follow(receiver.clone()), Arc::clone(signal))
                }
                _ => {
                    let (sender, receiver) = watch::channel(None);
                    let sinks = Arc::new(Mutex::new(vec![progress]));
                    let signal = Arc::new(watch::Sender::new(false));
                    ops.download = Some((receiver, Arc::clone(&sinks), Arc::clone(&signal)));
                    (Turn::Lead((sender, sinks)), signal)
                }
            })?;
        let (sender, sinks) = match turn {
            Turn::Follow(receiver) => return follow(receiver, UpdateOp::Download).await?,
            Turn::Lead(lead) => lead,
        };
        let result = self.run_download(app, executor, sinks, cancelled).await;
        self.ops().download = None;
        sender.send_replace(Some(result.clone()));
        result
    }

    async fn run_download<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        executor: &NativeOperationExecutor,
        sinks: Sinks,
        mut cancelled: watch::Receiver<bool>,
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
        let staged_update = update.clone();
        let bytes = executor
            .run(
                NativeOperationClass::Network,
                "updater.download",
                move || {
                    Ok(tauri::async_runtime::block_on(transfer::transfer(
                        &update,
                        installation,
                        size_cap,
                        &sinks,
                        cancelled.wait_for(|cancelled| *cancelled),
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

mod tests;
