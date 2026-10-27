//! The Design commands' tests: each command on a mock app with a scratch folder and an in-memory
//! user database.

use common_types::design::DesignSaveOutcome;
use tauri::Manager;

use crate::{db::UserDb, design::drafts::DesignDrafts, native_operation::NativeOperationExecutor};

fn scratch_root(label: &str) -> crate::test_scratch::TestScratch {
    crate::test_scratch::TestScratch::new(&format!("design-commands-{label}"))
}

fn mock_app(root: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    let user_db = UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
    let start_folders = std::sync::Arc::new(StartFolders::default());
    tauri::test::mock_builder()
        .manage(NativeOperationExecutor::production())
        .manage(user_db)
        .manage(DesignDrafts::new(root))
        .manage(crate::services::recent_design_previews::RecentDesignPreviews::default())
        .manage(std::sync::Arc::clone(&start_folders))
        .manage(crate::host::dialogs::HostDialogs::new(start_folders))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

/// The window a command is invoked from, built once per label.
fn window(
    app: &tauri::App<tauri::test::MockRuntime>,
    label: &str,
) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    app.get_webview_window(label).unwrap_or_else(|| {
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
            .build()
            .unwrap()
    })
}

fn design(name: &str) -> common_types::design::CanopiFile {
    crate::design::format::create_new_design(name, "2026-09-25T00:00:00Z")
}

#[test]
fn save_and_load_commands_carry_fingerprints_and_refuse_outside_changes() {
    let root = scratch_root("save_load");
    let app = mock_app(&root);
    let path = root.join("garden.canopi").to_string_lossy().into_owned();
    let save = |name: &str, expected: Option<String>| {
        tauri::async_runtime::block_on(super::save_design(
            window(&app, "main"),
            app.state(),
            app.state(),
            app.state(),
            path.clone(),
            design(name),
            expected,
        ))
        .unwrap()
    };

    let DesignSaveOutcome::Saved { fingerprint, .. } = save("First", None) else {
        panic!("an unconditional save is written");
    };
    let loaded = tauri::async_runtime::block_on(super::load_design(
        window(&app, "main"),
        app.state(),
        app.state(),
        app.state(),
        path.clone(),
    ))
    .unwrap();
    assert_eq!(loaded.fingerprint, fingerprint);
    assert_eq!(loaded.file.name, "First");
    assert!(matches!(
        save("Second", Some(fingerprint.clone())),
        DesignSaveOutcome::Saved { .. }
    ));
    assert!(matches!(
        save("Third", Some(fingerprint)),
        DesignSaveOutcome::Conflict {
            current_fingerprint: Some(_)
        }
    ));
    let recent =
        tauri::async_runtime::block_on(super::get_recent_files(app.state(), app.state())).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].name, "Second");
}

/// The mock app's picker: records the start folder of each dialog it is shown and cancels it.
#[derive(Default)]
struct StartFolders(std::sync::Mutex<Vec<Option<std::path::PathBuf>>>);

impl crate::host::dialogs::Picker for StartFolders {
    fn show(
        &self,
        request: crate::host::dialogs::DialogRequest,
        answer: crate::host::dialogs::Answer,
    ) {
        self.0.lock().unwrap().push(request.start_folder);
        answer(None);
    }
}

/// Where `label`'s Open dialog starts now.
fn open_folder(
    app: &tauri::App<tauri::test::MockRuntime>,
    label: &str,
) -> Option<std::path::PathBuf> {
    tauri::async_runtime::block_on(crate::host::dialogs::pick_open(
        app.state::<NativeOperationExecutor>().inner(),
        app.state::<crate::host::dialogs::HostDialogs>().inner(),
        label,
        common_types::dialog::DialogKind::DesignOpen,
    ))
    .unwrap();
    let start_folders = app.state::<std::sync::Arc<StartFolders>>();
    start_folders.0.lock().unwrap().pop().flatten()
}

/// The folder of the last Design loaded or saved successfully in a window is where that
/// window's Open dialog starts; another window keeps its own, and a failed load changes none.
#[test]
fn canopi_f47t_52_228_14_a_loaded_or_saved_design_sets_its_windows_open_folder() {
    let root = scratch_root("dialog_folder");
    let app = mock_app(&root);
    let (saved, loaded) = (root.join("saved"), root.join("loaded"));
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::create_dir_all(&loaded).unwrap();
    let elsewhere = loaded.join("elsewhere.canopi");
    crate::design::format::export_to_file(&elsewhere, &design("Elsewhere")).unwrap();
    assert_eq!(open_folder(&app, "main"), None);

    tauri::async_runtime::block_on(super::save_design(
        window(&app, "main"),
        app.state(),
        app.state(),
        app.state(),
        saved.join("orchard.canopi").to_string_lossy().into_owned(),
        design("Orchard"),
        None,
    ))
    .unwrap();
    let load = |label: &str, path: &std::path::Path| {
        tauri::async_runtime::block_on(super::load_design(
            window(&app, label),
            app.state(),
            app.state(),
            app.state(),
            path.to_string_lossy().into_owned(),
        ))
    };
    load("second", &elsewhere).unwrap();
    assert!(load("main", &loaded.join("missing.canopi")).is_err());

    assert_eq!(open_folder(&app, "main"), Some(saved));
    assert_eq!(open_folder(&app, "second"), Some(loaded));
}

#[test]
fn recent_design_previews_read_listed_designs_only() {
    let root = scratch_root("previews");
    let app = mock_app(&root);
    let listed = root.join("orchard.canopi").to_string_lossy().into_owned();
    tauri::async_runtime::block_on(super::save_design(
        window(&app, "main"),
        app.state(),
        app.state(),
        app.state(),
        listed.clone(),
        design("Orchard"),
        None,
    ))
    .unwrap();
    let unlisted = root.join("elsewhere.canopi");
    crate::design::format::export_to_file(&unlisted, &design("Elsewhere")).unwrap();

    let previews = tauri::async_runtime::block_on(super::get_recent_design_previews(
        app.state(),
        app.state(),
        app.state(),
        vec![
            listed.clone(),
            unlisted.to_string_lossy().into_owned(),
            listed.clone(),
        ],
    ))
    .unwrap();

    assert_eq!(previews.len(), 1, "only a listed path is read, once");
    assert_eq!(previews[0].path, listed);
    assert_eq!(
        previews[0].preview,
        common_types::design::RecentDesignPreview::Read {
            plant_count: 0,
            zone_count: 0,
            bounds: None,
            sketch: None,
        }
    );
}

#[test]
fn recent_design_commands_reveal_its_file_and_remove_it_from_the_list() {
    use crate::services::folder_reveal::recording::{RecordingRevealer, Shown};
    let root = scratch_root("recent_actions");
    let app = mock_app(&root);
    let path = root.join("orchard.canopi").to_string_lossy().into_owned();
    tauri::async_runtime::block_on(super::save_design(
        window(&app, "main"),
        app.state(),
        app.state(),
        app.state(),
        path.clone(),
        design("Orchard"),
        None,
    ))
    .unwrap();

    let revealer = RecordingRevealer::default();
    tauri::async_runtime::block_on(super::show_recent_design_in_folder_with_executor(
        app.state::<NativeOperationExecutor>().inner(),
        app.state::<UserDb>().inner().clone(),
        path.clone(),
        revealer.clone(),
    ))
    .unwrap();
    assert_eq!(revealer.shown(), vec![Shown::Item(path.clone().into())]);

    // An unlisted path is refused before anything is opened.
    let unlisted = root.join("elsewhere.canopi").to_string_lossy().into_owned();
    assert!(
        tauri::async_runtime::block_on(super::show_recent_design_in_folder(
            app.state(),
            app.state(),
            unlisted,
        ))
        .is_err()
    );

    tauri::async_runtime::block_on(super::remove_recent_design(
        app.state(),
        app.state(),
        path.clone(),
    ))
    .unwrap();
    let recent =
        tauri::async_runtime::block_on(super::get_recent_files(app.state(), app.state())).unwrap();
    assert!(recent.is_empty());
    assert!(std::path::Path::new(&path).is_file());
}

#[test]
fn draft_commands_save_list_load_and_delete_through_managed_state() {
    let root = scratch_root("drafts");
    let app = mock_app(&root);

    tauri::async_runtime::block_on(super::save_design_draft(
        app.state(),
        app.state(),
        "draft-1".to_owned(),
        design("Sketch"),
    ))
    .unwrap();
    let listed =
        tauri::async_runtime::block_on(super::list_design_drafts(app.state(), app.state()))
            .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].id.as_str(), listed[0].name.as_str()),
        ("draft-1", "Sketch")
    );
    let loaded = tauri::async_runtime::block_on(super::load_design_draft(
        app.state(),
        app.state(),
        "draft-1".to_owned(),
    ))
    .unwrap();
    assert_eq!(loaded.name, "Sketch");
    assert!(
        tauri::async_runtime::block_on(super::load_design_draft(
            app.state(),
            app.state(),
            "../draft-1".to_owned(),
        ))
        .is_err()
    );
    tauri::async_runtime::block_on(super::delete_design_draft(
        app.state(),
        app.state(),
        "draft-1".to_owned(),
    ))
    .unwrap();
    assert!(
        tauri::async_runtime::block_on(super::list_design_drafts(app.state(), app.state()))
            .unwrap()
            .is_empty()
    );
    assert!(root.join("drafts").is_dir(), "drafts live under app data");
}

#[test]
fn new_design_command_returns_an_untitled_current_design() {
    let design = super::new_design().unwrap();
    assert_eq!(design.name, "Untitled");
    assert_eq!(
        design.version,
        common_types::design::CURRENT_CANOPI_FILE_VERSION
    );
}
