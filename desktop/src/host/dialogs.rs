//! Host file dialogs (2.1-M81, contracts §7): the webview names a [`DialogKind`] and the host
//! shows the system's Open or Save dialog, with the system's own title (2.1-Q241), the kind's
//! filter and start folder. The webview holds no dialog permission, and a picked file is never
//! added to the asset protocol's scope: the Rust dialog API, unlike the plugin's JS commands, does
//! not widen it, so `asset://` keeps serving only what `tauri.conf.json` names.
//!
//! One pick at a time per window: a second is refused with [`ALREADY_OPEN`] until the error
//! catalogue (Phase 1a) gives it a type. A window that goes away settles its pending pick as
//! cancelled ([`window_destroyed`]) and the dialog's late answer is dropped. Dialogs use the
//! plugin's callback API, never `blocking_*`, so the GTK main loop is never waited on.
//!
//! In memory, per window, the folder of the last Design loaded or saved: Open starts there and
//! Save defaults to it. It outlives Close and ends with the window or the process; Phase 2b's
//! last-open home replaces it (contracts §4). Phase 2b also turns the picked paths into file
//! grants and refuses a Save over an existing file (2.1-M155); the outcomes stay enums for that.
//!
//! The e2e build (`--features e2e`, 2.1-M213) shows no native dialog: each pick takes the next
//! answer file from the folder [`E2E_DIALOGS_VARIABLE`] names (ADR 0029 Platform matrix).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use common_types::dialog::{DialogKind, DialogPurpose, PickOpenOutcome, PickSaveOutcome};

use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};

/// The refusal of a second pick while one is open in the same window.
pub const ALREADY_OPEN: &str = "file-dialog-already-open";

/// What the host asks of the system dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRequest {
    /// The label of the window the dialog belongs to.
    pub window: String,
    /// The dialog's purpose: filter, multiple selection, Open or Save.
    pub kind: DialogKind,
    /// The folder the dialog opens in, when the kind has one and it still exists.
    pub start_folder: Option<PathBuf>,
    /// A Save dialog's suggested file name, with the kind's extension.
    pub file_name: Option<String>,
}

/// The dialog's answer: the chosen paths, or `None` when cancelled.
pub type Answer = Box<dyn FnOnce(Option<Vec<PathBuf>>) + Send>;

/// Shows a dialog and calls `answer` once, whenever the user answers.
pub trait Picker: Send + Sync {
    /// Show the dialog `request` describes; must not wait for the user.
    fn show(&self, request: DialogRequest, answer: Answer);
}

#[derive(Default)]
struct WindowDialogs {
    pending: Option<PendingPick>,
    design_folder: Option<PathBuf>,
}

struct PendingPick {
    id: u64,
    answer: tokio::sync::oneshot::Sender<Option<Vec<PathBuf>>>,
}

type Windows = Arc<Mutex<HashMap<String, WindowDialogs>>>;

/// The host's dialog state: each window's pending pick and last Design folder.
#[derive(Default)]
pub struct HostDialogs {
    windows: Windows,
    next_id: AtomicU64,
}

fn lock(windows: &Windows) -> std::sync::MutexGuard<'_, HashMap<String, WindowDialogs>> {
    windows.lock().unwrap_or_else(PoisonError::into_inner)
}

impl HostDialogs {
    /// Remember the folder of a Design just loaded or saved in `window`.
    pub fn record_design_folder(&self, window: &str, design: &Path) {
        if let Some(folder) = design.parent().filter(|folder| folder.is_absolute()) {
            lock(&self.windows)
                .entry(window.to_string())
                .or_default()
                .design_folder = Some(folder.to_path_buf());
        }
    }

    /// Settle `window`'s pending pick as cancelled and forget the window.
    pub fn window_destroyed(&self, window: &str) {
        // Dropping the pending pick's sender settles it: `pick` reads a closed channel as a cancel.
        lock(&self.windows).remove(window);
    }

    /// Show one dialog in `window` and wait for its answer; `None` is cancelled.
    async fn pick(
        &self,
        executor: &NativeOperationExecutor,
        picker: Arc<dyn Picker>,
        window: &str,
        kind: DialogKind,
        file_name: Option<String>,
    ) -> Result<Option<Vec<PathBuf>>, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, answered) = tokio::sync::oneshot::channel();
        let start_folder = {
            let mut windows = lock(&self.windows);
            let dialogs = windows.entry(window.to_string()).or_default();
            if dialogs.pending.is_some() {
                return Err(ALREADY_OPEN.to_string());
            }
            dialogs.pending = Some(PendingPick { id, answer: sender });
            dialogs
                .design_folder
                .clone()
                .filter(|_| kind.starts_in_design_folder())
        };
        let windows = Arc::clone(&self.windows);
        let label = window.to_string();
        let answer: Answer = Box::new(move |paths| {
            let mut windows = lock(&windows);
            let Some(dialogs) = windows.get_mut(&label) else {
                return;
            };
            if dialogs
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
                && let Some(pending) = dialogs.pending.take()
            {
                let _ = pending.answer.send(paths);
            }
        });
        let mut request = DialogRequest {
            window: window.to_string(),
            kind,
            start_folder,
            file_name,
        };
        // The start folder's check and the e2e build's answer file are filesystem work.
        let shown = executor
            .run(NativeOperationClass::Local, "file dialog", move || {
                request.start_folder = request.start_folder.take().filter(|f| f.is_dir());
                picker.show(request, answer);
                Ok(())
            })
            .await;
        if let Err(error) = shown {
            let mut windows = lock(&self.windows);
            if let Some(dialogs) = windows.get_mut(window)
                && dialogs
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.id == id)
            {
                dialogs.pending = None;
            }
            return Err(error);
        }
        Ok(answered.await.unwrap_or(None))
    }
}

/// Show `kind`'s Open dialog in `window`: the chosen paths, one unless the kind allows several.
pub async fn pick_open(
    executor: &NativeOperationExecutor,
    dialogs: &HostDialogs,
    picker: Arc<dyn Picker>,
    window: &str,
    kind: DialogKind,
) -> Result<PickOpenOutcome, String> {
    if kind.purpose() != DialogPurpose::Open {
        return Err(format!("{} is not an Open dialog", kind.literal()));
    }
    let Some(mut paths) = dialogs.pick(executor, picker, window, kind, None).await? else {
        return Ok(PickOpenOutcome::Cancelled);
    };
    if !kind.allows_multiple() {
        paths.truncate(1);
    }
    if paths.is_empty() {
        return Ok(PickOpenOutcome::Cancelled);
    }
    let paths = paths
        .into_iter()
        .map(path_text)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PickOpenOutcome::Picked { paths })
}

/// Show `kind`'s Save dialog in `window`, suggesting `stem` with the kind's extension; the
/// chosen path gets the kind's first extension when it has none of the kind's.
pub async fn pick_save(
    executor: &NativeOperationExecutor,
    dialogs: &HostDialogs,
    picker: Arc<dyn Picker>,
    window: &str,
    kind: DialogKind,
    stem: &str,
) -> Result<PickSaveOutcome, String> {
    if kind.purpose() != DialogPurpose::Save {
        return Err(format!("{} is not a Save dialog", kind.literal()));
    }
    let file_name = with_extension(kind, PathBuf::from(stem));
    let file_name = path_text(file_name)?;
    let picked = dialogs
        .pick(executor, picker, window, kind, Some(file_name))
        .await?;
    let Some(path) = picked.and_then(|paths| paths.into_iter().next()) else {
        return Ok(PickSaveOutcome::Cancelled);
    };
    Ok(PickSaveOutcome::Picked {
        path: path_text(with_extension(kind, path))?,
    })
}

/// Show the Open dialog of a kind the host reads itself; the path stays in the host.
pub async fn pick_host_read(
    executor: &NativeOperationExecutor,
    dialogs: &HostDialogs,
    picker: Arc<dyn Picker>,
    window: &str,
    kind: DialogKind,
) -> Result<Option<PathBuf>, String> {
    if kind.purpose() != DialogPurpose::HostRead {
        return Err(format!("{} is not read by the host", kind.literal()));
    }
    let picked = dialogs.pick(executor, picker, window, kind, None).await?;
    Ok(picked.and_then(|paths| paths.into_iter().next()))
}

/// `path` with `kind`'s first extension appended unless it ends in one of the kind's.
fn with_extension(kind: DialogKind, path: PathBuf) -> PathBuf {
    let has_one = path.extension().is_some_and(|extension| {
        kind.extensions()
            .iter()
            .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    });
    if has_one {
        return path;
    }
    let mut text = path.into_os_string();
    text.push(".");
    text.push(kind.extensions()[0]);
    PathBuf::from(text)
}

fn path_text(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "The chosen file's path is not valid Unicode".to_string())
}

/// The window event hook: a destroyed window settles its pending pick as cancelled.
pub fn window_destroyed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &str) {
    use tauri::Manager as _;
    if let Some(dialogs) = app.try_state::<HostDialogs>() {
        dialogs.window_destroyed(window);
    }
}

/// The picker this build uses: the system's dialogs, or the e2e build's answer folder.
pub fn system_picker<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Arc<dyn Picker> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Arc::new(AnswerFolderPicker {
            folder: std::env::var_os(E2E_DIALOGS_VARIABLE).map(PathBuf::from),
        })
    }
    #[cfg(not(feature = "e2e"))]
    Arc::new(SystemPicker { app: app.clone() })
}

/// The system's dialogs through the dialog plugin's callback API.
#[cfg(not(feature = "e2e"))]
struct SystemPicker<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

#[cfg(not(feature = "e2e"))]
impl<R: tauri::Runtime> Picker for SystemPicker<R> {
    fn show(&self, request: DialogRequest, answer: Answer) {
        use tauri_plugin_dialog::{DialogExt as _, FilePath};
        let kind = request.kind;
        let mut dialog = self
            .app
            .dialog()
            .file()
            .add_filter(kind.filter_label(), kind.extensions());
        // As the plugin's own Open command: GTK gets no parent window.
        #[cfg(any(windows, target_os = "macos"))]
        {
            use tauri::Manager as _;
            if let Some(window) = self.app.get_webview_window(&request.window) {
                dialog = dialog.set_parent(&window);
            }
        }
        if let Some(folder) = request.start_folder {
            dialog = dialog.set_directory(folder);
        }
        if let Some(name) = request.file_name {
            dialog = dialog.set_file_name(name);
        }
        let paths = |files: Vec<FilePath>| -> Option<Vec<PathBuf>> {
            files
                .into_iter()
                .map(|file| file.into_path().ok())
                .collect()
        };
        if kind.purpose() == DialogPurpose::Save {
            dialog.save_file(move |file| answer(file.and_then(|file| paths(vec![file]))));
        } else if kind.allows_multiple() {
            dialog.pick_files(move |files| answer(files.and_then(paths)));
        } else {
            dialog.pick_file(move |file| answer(file.and_then(|file| paths(vec![file]))));
        }
    }
}

/// The variable naming the e2e build's answer folder.
#[cfg(any(test, feature = "e2e"))]
pub const E2E_DIALOGS_VARIABLE: &str = "CANOPI_E2E_DIALOGS";

/// The e2e build's dialogs: each pick takes the first answer file, by name, from `folder` and
/// deletes it. Its lines are the chosen paths; an empty file, no file or no folder is a cancel.
#[cfg(any(test, feature = "e2e"))]
struct AnswerFolderPicker {
    folder: Option<PathBuf>,
}

#[cfg(any(test, feature = "e2e"))]
impl AnswerFolderPicker {
    fn next_answer(&self) -> Option<Vec<PathBuf>> {
        let folder = self.folder.as_ref()?;
        let mut files = std::fs::read_dir(folder)
            .ok()?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        files.sort();
        let file = files.into_iter().next()?;
        let text = std::fs::read_to_string(&file).ok();
        std::fs::remove_file(&file).ok()?;
        let paths = text?
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        (!paths.is_empty()).then_some(paths)
    }
}

#[cfg(any(test, feature = "e2e"))]
impl Picker for AnswerFolderPicker {
    fn show(&self, _request: DialogRequest, answer: Answer) {
        answer(self.next_answer());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Design path's folder on each platform's own path syntax; a relative path has none.
    #[test]
    fn canopi_f47t_52_228_14_the_design_folder_follows_windows_and_unix_paths() {
        #[cfg(windows)]
        let (design, folder) = (
            r"C:\Users\ana\My Gardens\garden.canopi",
            r"C:\Users\ana\My Gardens",
        );
        #[cfg(not(windows))]
        let (design, folder) = ("/home/ana/My Gardens/garden.canopi", "/home/ana/My Gardens");
        let dialogs = HostDialogs::default();
        dialogs.record_design_folder("main", Path::new(design));
        dialogs.record_design_folder("other", Path::new("garden.canopi"));

        let windows = lock(&dialogs.windows);
        assert_eq!(
            windows.get("main").and_then(|w| w.design_folder.clone()),
            Some(PathBuf::from(folder))
        );
        assert!(
            windows.get("other").is_none(),
            "a relative path has no folder"
        );
    }

    /// ADR 0029 Platform matrix: the e2e build answers each pick with the next answer file.
    #[test]
    fn canopi_f47t_52_228_14_the_e2e_answer_folder_answers_each_pick_in_name_order() {
        let scratch = crate::test_scratch::TestScratch::new("host-dialogs-e2e-answers");
        let garden = std::env::temp_dir().join("garden.canopi");
        std::fs::write(scratch.join("1-open"), format!("{}\n", garden.display())).expect("written");
        std::fs::write(scratch.join("2-cancel"), "\n").expect("written");
        let picker = AnswerFolderPicker {
            folder: Some(scratch.path().to_path_buf()),
        };

        assert_eq!(picker.next_answer(), Some(vec![garden]));
        assert_eq!(picker.next_answer(), None);
        assert!(
            std::fs::read_dir(&*scratch)
                .expect("listed")
                .next()
                .is_none()
        );
        assert_eq!(picker.next_answer(), None, "no file is a cancel");
        assert_eq!(AnswerFolderPicker { folder: None }.next_answer(), None);
    }
}
