use common_types::dialog::{DialogKind, PickOpenOutcome, PickSaveOutcome};
use tauri::{Manager as _, State};

use crate::host::dialogs::{self, HostDialogs};
use crate::host::launch::{PendingOpen, PendingOpenSlot};
use crate::native_operation::NativeOperationExecutor;

/// The Design file a launch asked to open, once: the pull empties the slot (2.1-M214).
#[tauri::command]
pub fn take_pending_open(slot: tauri::State<'_, PendingOpenSlot>) -> Option<PendingOpen> {
    slot.take()
}

/// Show `kind`'s Open dialog in the calling window: the chosen paths, or cancelled (2.1-M81).
#[tauri::command]
pub async fn pick_open(
    window: tauri::WebviewWindow,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    kind: DialogKind,
) -> Result<PickOpenOutcome, String> {
    let picker = dialogs::system_picker(window.app_handle());
    dialogs::pick_open(
        executor.inner(),
        dialogs.inner(),
        picker,
        window.label(),
        kind,
    )
    .await
}

/// Show `kind`'s Save dialog in the calling window, suggesting `stem`: the chosen path with the
/// kind's extension, or cancelled (2.1-M81).
#[tauri::command]
pub async fn pick_save(
    window: tauri::WebviewWindow,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, HostDialogs>,
    kind: DialogKind,
    stem: String,
) -> Result<PickSaveOutcome, String> {
    let picker = dialogs::system_picker(window.app_handle());
    dialogs::pick_save(
        executor.inner(),
        dialogs.inner(),
        picker,
        window.label(),
        kind,
        &stem,
    )
    .await
}

/// The host dialogs the pick commands call, with an injected picker: the commands add only the
/// managed state, the window's label and the system picker.
#[cfg(test)]
mod tests {
    use crate::host::dialogs::*;
    use crate::native_operation::{
        NativeOperationClassLimits, NativeOperationExecutor, NativeOperationLimits,
    };
    use common_types::dialog::{DialogKind, PickOpenOutcome, PickSaveOutcome};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::{Duration, Instant};

    /// Holds each dialog until the test answers it.
    #[derive(Default)]
    struct HeldPicker {
        held: Mutex<Vec<(DialogRequest, Option<Answer>)>>,
    }

    impl Picker for HeldPicker {
        fn show(&self, request: DialogRequest, answer: Answer) {
            lock_held(&self.held).push((request, Some(answer)));
        }
    }

    fn lock_held<T>(held: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    impl HeldPicker {
        /// The `index`th request, once shown.
        fn request(&self, index: usize) -> DialogRequest {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some((request, _)) = lock_held(&self.held).get(index) {
                    return request.clone();
                }
                assert!(Instant::now() < deadline, "dialog {index} was never shown");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn answer(&self, index: usize, paths: Option<Vec<PathBuf>>) {
            self.request(index);
            let answer = lock_held(&self.held)[index]
                .1
                .take()
                .expect("answered once");
            answer(paths);
        }
    }

    fn executor() -> NativeOperationExecutor {
        let limits = NativeOperationClassLimits::new(4, 2);
        NativeOperationExecutor::new(NativeOperationLimits::new(
            limits, limits, limits, limits, limits,
        ))
        .expect("test limits are valid")
    }

    struct Host {
        executor: NativeOperationExecutor,
        dialogs: Arc<HostDialogs>,
        picker: Arc<HeldPicker>,
    }

    impl Host {
        fn new() -> Self {
            Self {
                executor: executor(),
                dialogs: Arc::default(),
                picker: Arc::default(),
            }
        }

        fn open(
            &self,
            window: &'static str,
            kind: DialogKind,
        ) -> tauri::async_runtime::JoinHandle<Result<PickOpenOutcome, String>> {
            let (executor, dialogs, picker) = self.parts();
            tauri::async_runtime::spawn(async move {
                pick_open(&executor, &dialogs, picker, window, kind).await
            })
        }

        fn save(
            &self,
            kind: DialogKind,
            stem: &'static str,
        ) -> tauri::async_runtime::JoinHandle<Result<PickSaveOutcome, String>> {
            let (executor, dialogs, picker) = self.parts();
            tauri::async_runtime::spawn(async move {
                pick_save(&executor, &dialogs, picker, "main", kind, stem).await
            })
        }

        fn parts(&self) -> (NativeOperationExecutor, Arc<HostDialogs>, Arc<dyn Picker>) {
            let picker: Arc<dyn Picker> = self.picker.clone();
            (self.executor.clone(), Arc::clone(&self.dialogs), picker)
        }
    }

    /// The pick's result, failing rather than hanging when it never settles.
    fn settle<T>(handle: tauri::async_runtime::JoinHandle<T>) -> T {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(5), handle).await
        })
        .expect("the pick settles within 5 s")
        .expect("the pick task ends")
    }

    fn picked(path: &Path) -> PickOpenOutcome {
        PickOpenOutcome::Picked {
            paths: vec![path.display().to_string()],
        }
    }

    fn absolute(parts: &[&str]) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.extend(parts);
        path
    }

    /// 2.1-M81, plan:126: a file picked through the host dialogs is not served over `asset://`
    /// by the scope the real `tauri.conf.json` builds, while a published display COG still is.
    /// The plugin's JS Open command, which the webview used before, adds the file to the scope.
    #[test]
    fn canopi_f47t_52_228_14_a_file_picked_through_the_host_dialogs_is_refused_over_the_asset_protocol()
     {
        use tauri::Manager as _;
        let context = tauri::generate_context!(test = true);
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("the mock app builds from the real configuration");
        let scope = app.asset_protocol_scope();
        let data_dir = app.path().app_data_dir().expect("app data dir");
        let display_cog = crate::services::lidar::paths::library_root(&data_dir)
            .join("display-cog")
            .join("f47t-probe-3857.tif");
        let garden = absolute(&["canopi-f47t-picked", "garden.canopi"]);
        let host = Host::new();

        let pick = host.open("main", DialogKind::DesignOpen);
        host.picker.answer(0, Some(vec![garden.clone()]));

        assert_eq!(settle(pick), Ok(picked(&garden)));
        assert!(!scope.is_allowed(&garden), "the picked file is served");
        assert!(scope.is_allowed(&display_cog), "the display COG is refused");
        scope.allow_file(&garden).expect("the scope takes a file");
        assert!(
            scope.is_allowed(&garden),
            "the check cannot see a widened scope"
        );
    }

    /// Contracts §7: one pick at a time per window; another window may pick meanwhile.
    #[test]
    fn canopi_f47t_52_228_14_a_second_pick_in_the_same_window_is_refused() {
        let host = Host::new();
        let first = host.open("main", DialogKind::DesignOpen);
        host.picker.request(0);

        let second = settle(host.open("main", DialogKind::StampImport));
        let other = host.open("other", DialogKind::StampImport);
        host.picker.answer(1, None);
        let garden = absolute(&["garden.canopi"]);
        host.picker.answer(0, Some(vec![garden.clone()]));

        assert_eq!(second, Err(ALREADY_OPEN.to_string()));
        assert_eq!(settle(other), Ok(PickOpenOutcome::Cancelled));
        assert_eq!(settle(first), Ok(picked(&garden)));
        let again = host.open("main", DialogKind::DesignOpen);
        host.picker.answer(2, None);
        assert_eq!(settle(again), Ok(PickOpenOutcome::Cancelled));
    }

    /// Contracts §7: a destroyed window settles its pick as cancelled; the dialog's late answer
    /// is dropped and never answers a later pick in a window of the same label.
    #[test]
    fn canopi_f47t_52_228_14_a_destroyed_window_settles_cancelled_and_drops_the_late_answer() {
        let host = Host::new();
        let first = host.open("main", DialogKind::DesignOpen);
        host.picker.request(0);

        host.dialogs.window_destroyed("main");
        let later = host.open("main", DialogKind::DesignOpen);
        host.picker.request(1);
        host.picker
            .answer(0, Some(vec![absolute(&["late.canopi"])]));
        let garden = absolute(&["garden.canopi"]);
        host.picker.answer(1, Some(vec![garden.clone()]));

        assert_eq!(settle(first), Ok(PickOpenOutcome::Cancelled));
        assert_eq!(settle(later), Ok(picked(&garden)));
    }

    /// The Save dialog suggests the stem with the kind's extension, and a chosen name without
    /// one of the kind's extensions gets the first (the rule `ipc/export.ts` held before).
    #[test]
    fn canopi_f47t_52_228_14_a_save_appends_the_kinds_first_extension_when_missing() {
        let host = Host::new();
        let cases = [
            (
                DialogKind::GeojsonExport,
                "plan",
                "plan.geojson",
                "out",
                "out.geojson",
            ),
            (
                DialogKind::GeojsonExport,
                "plan.json",
                "plan.json",
                "out.JSON",
                "out.JSON",
            ),
            (
                DialogKind::PdfExport,
                "Garden",
                "Garden.pdf",
                "print.PDF",
                "print.PDF",
            ),
            (
                DialogKind::BudgetCsvExport,
                "g-budget.csv",
                "g-budget.csv",
                "b.txt",
                "b.txt.csv",
            ),
            (
                DialogKind::StampExport,
                "Hedge",
                "Hedge.canopi",
                "hedge",
                "hedge.canopi",
            ),
        ];
        for (index, (kind, stem, suggested, chosen, written)) in cases.into_iter().enumerate() {
            let save = host.save(kind, stem);
            assert_eq!(
                host.picker.request(index).file_name.as_deref(),
                Some(suggested)
            );
            host.picker.answer(index, Some(vec![absolute(&[chosen])]));
            let path = absolute(&[written]).display().to_string();
            assert_eq!(
                settle(save),
                Ok(PickSaveOutcome::Picked { path }),
                "{kind:?}"
            );
        }
    }

    /// The named replacement of `design-open-dialog-folder.test.ts`'s assertion: the Open dialog
    /// starts in the current Design's folder, and Save defaults to it; a stamp import has no
    /// start folder; Close keeps the folder, a destroyed window forgets it.
    #[test]
    fn canopi_f47t_52_228_14_the_open_dialog_starts_in_the_current_designs_folder() {
        let host = Host::new();
        let scratch = crate::test_scratch::TestScratch::new("host-dialogs-design-folder");
        let folder = scratch.join("My Gardens");
        std::fs::create_dir_all(&folder).expect("the folder is created");
        host.dialogs
            .record_design_folder("main", folder.join("garden.canopi"));

        let open = host.open("main", DialogKind::DesignOpen);
        assert_eq!(host.picker.request(0).start_folder.as_ref(), Some(&folder));
        host.picker.answer(0, None);
        settle(open).expect("cancelled");
        let stamp = host.open("main", DialogKind::StampImport);
        assert_eq!(host.picker.request(1).start_folder, None);
        host.picker.answer(1, None);
        settle(stamp).expect("cancelled");
        let save = host.save(DialogKind::DesignSave, "Orchard");
        let request = host.picker.request(2);
        assert_eq!(request.start_folder.as_ref(), Some(&folder));
        assert_eq!(request.file_name.as_deref(), Some("Orchard.canopi"));
        host.picker.answer(2, None);
        assert_eq!(settle(save), Ok(PickSaveOutcome::Cancelled));

        host.dialogs.window_destroyed("main");
        let fresh = host.open("main", DialogKind::DesignOpen);
        assert_eq!(host.picker.request(3).start_folder, None);
        host.picker.answer(3, None);
        settle(fresh).expect("cancelled");
    }

    #[test]
    fn canopi_f47t_52_228_14_each_command_takes_only_its_own_kinds() {
        let host = Host::new();
        let (executor, dialogs, picker) = host.parts();
        tauri::async_runtime::block_on(async {
            let open = pick_open(
                &executor,
                &dialogs,
                picker.clone(),
                "main",
                DialogKind::PdfExport,
            );
            assert!(open.await.is_err());
            let host_read = pick_open(
                &executor,
                &dialogs,
                picker.clone(),
                "main",
                DialogKind::GeojsonImport,
            );
            assert!(host_read.await.is_err());
            let save = pick_save(
                &executor,
                &dialogs,
                picker.clone(),
                "main",
                DialogKind::DesignOpen,
                "x",
            );
            assert!(save.await.is_err());
            let read = pick_host_read(&executor, &dialogs, picker, "main", DialogKind::StampImport);
            assert!(read.await.is_err());
        });
        assert!(
            lock_held(&host.picker.held).is_empty(),
            "no dialog was shown"
        );
    }

    /// Only the LiDAR import takes several files; a single-file kind keeps the first.
    #[test]
    fn canopi_f47t_52_228_14_only_a_multiple_kind_returns_several_paths() {
        let host = Host::new();
        let (a, b) = (absolute(&["a.tif"]), absolute(&["b.tiff"]));
        let lidar = host.open("main", DialogKind::LidarGeotiffImport);
        host.picker.answer(0, Some(vec![a.clone(), b.clone()]));
        let design = host.open("main", DialogKind::DesignOpen);
        host.picker.answer(1, Some(vec![a.clone(), b.clone()]));
        let empty = host.open("main", DialogKind::StampImport);
        host.picker.answer(2, Some(Vec::new()));

        let both = vec![a.display().to_string(), b.display().to_string()];
        assert_eq!(settle(lidar), Ok(PickOpenOutcome::Picked { paths: both }));
        assert_eq!(settle(design), Ok(picked(&a)));
        assert_eq!(settle(empty), Ok(PickOpenOutcome::Cancelled));
    }

    #[test]
    fn canopi_f47t_52_228_14_the_geojson_host_read_keeps_the_path_in_the_host() {
        let host = Host::new();
        let (executor, dialogs, picker) = host.parts();
        let read = tauri::async_runtime::spawn(async move {
            pick_host_read(
                &executor,
                &dialogs,
                picker,
                "main",
                DialogKind::GeojsonImport,
            )
            .await
        });
        let request = host.picker.request(0);
        let source = absolute(&["plan.geojson"]);
        host.picker.answer(0, Some(vec![source.clone()]));

        assert_eq!(
            request.kind.extensions(),
            crate::services::export::GEOJSON_IMPORT_EXTENSIONS
        );
        assert_eq!(settle(read), Ok(Some(source)));
    }

    /// A recorded Design folder that is gone is not offered to the dialog.
    #[test]
    fn canopi_f47t_52_228_14_a_design_folder_that_is_gone_is_not_offered() {
        let host = Host::new();
        let gone = absolute(&["canopi-f47t-gone", "garden.canopi"]);
        host.dialogs.record_design_folder("main", &gone);

        let open = host.open("main", DialogKind::DesignOpen);
        assert_eq!(host.picker.request(0).start_folder, None);
        host.picker.answer(0, None);
        settle(open).expect("cancelled");
    }
}
