//! The Design commands' tests: each command on a mock app with a scratch folder and an in-memory
//! user database.

use canopi_types::design::DesignSaveOutcome;
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

fn design(name: &str) -> canopi_types::design::CanopiFile {
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
    .unwrap()
    .editable();
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
        canopi_types::dialog::DialogKind::DesignOpen,
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
        canopi_types::design::RecentDesignPreview::Read {
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
    .unwrap()
    .editable();
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
        canopi_types::design::CURRENT_CANOPI_FILE_VERSION
    );
}

/// The hand-made v10 Design R1 froze (`canopi-format/spec/v10/`), as 2.1 saves it.
const V10_DESIGN: &str = include_str!("../../../../canopi-format/spec/v10/read-fixture.canopi");

/// canopi-f47t.52.270: after a rollback, a Design 2.1 saved opens read-only from Open, Recent
/// and the Draft list (2.1-M478, 2.1-Q316), its wire shape `ReadOnlyDesign` told apart by
/// `saved_by_version`; its Recent row is read-only, never the 2.0.3 update state, and its Draft
/// is listed read-only, one the read refuses unreadable, never hidden or editable.
#[test]
fn canopi_f47t_52_270_a_newer_design_opens_read_only_from_open_recent_and_the_draft_list() {
    use crate::design::format::OpenedDesign;
    let root = scratch_root("newer");
    let app = mock_app(&root);
    let path = root.join("pond.canopi");
    std::fs::write(&path, V10_DESIGN).unwrap();
    let path = path.to_string_lossy().into_owned();

    let opened = tauri::async_runtime::block_on(super::load_design(
        window(&app, "main"),
        app.state(),
        app.state(),
        app.state(),
        path.clone(),
    ))
    .unwrap();
    let wire = serde_json::to_value(&opened).unwrap();
    assert_eq!(wire["saved_by_version"], serde_json::json!(10));
    assert_eq!(
        wire["view"]["name"],
        serde_json::json!("Orchard by the pond")
    );
    assert!(wire.get("fingerprint").is_none(), "{wire}");
    let OpenedDesign::ReadOnly(view) = &opened else {
        panic!("a v10 Design opens read-only");
    };
    assert_eq!(view.saved_by_version, 10);
    let recent =
        tauri::async_runtime::block_on(super::get_recent_files(app.state(), app.state())).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].name, "Orchard by the pond");
    let previews = tauri::async_runtime::block_on(super::get_recent_design_previews(
        app.state(),
        app.state(),
        app.state(),
        vec![path.clone()],
    ))
    .unwrap();
    let plants = Some(view.view.plants.len());
    assert!(
        matches!(previews[0].preview, canopi_types::design::RecentDesignPreview::ReadOnly {
            saved_by_version: 10, plant_count, ..
        } if usize::try_from(plant_count).ok() == plants),
        "a newer Recent Design is read-only, never the update state: {:?}",
        previews[0].preview
    );

    std::fs::create_dir_all(root.join("drafts")).unwrap();
    std::fs::write(root.join("drafts/pond-2-1.canopi"), V10_DESIGN).unwrap();
    let mut unread: serde_json::Value = serde_json::from_str(V10_DESIGN).unwrap();
    unread["version"] = serde_json::json!(11);
    unread["plants"] = serde_json::json!(3);
    std::fs::write(root.join("drafts/pond-2-2.canopi"), unread.to_string()).unwrap();
    let listed =
        tauri::async_runtime::block_on(super::list_design_drafts(app.state(), app.state()))
            .unwrap();
    // The wire's access state; an editable Draft omits it.
    let mut listed: Vec<_> = listed
        .iter()
        .map(|draft| {
            let wire = serde_json::to_value(draft).unwrap();
            let access = wire["access"].as_str().unwrap_or("editable").to_owned();
            (draft.id.clone(), draft.name.clone(), access)
        })
        .collect();
    listed.sort_unstable();
    let expected = [
        ("pond-2-1", "Orchard by the pond", "read_only"),
        ("pond-2-2", "Untitled", "unreadable"),
    ]
    .map(|(id, name, access)| (id.to_owned(), name.to_owned(), access.to_owned()));
    assert_eq!(
        listed, expected,
        "a newer Draft is listed read-only, and one the read refuses unreadable, never as an \
         editable row; opening it says why"
    );
    let unread = tauri::async_runtime::block_on(super::load_design_draft(
        app.state(),
        app.state(),
        "pond-2-2".to_owned(),
    ))
    .unwrap_err();
    assert_eq!(
        unread.kind,
        canopi_types::design::DesignLoadFailureKind::NewerVersion
    );
    let draft = tauri::async_runtime::block_on(super::load_design_draft(
        app.state(),
        app.state(),
        "pond-2-1".to_owned(),
    ))
    .unwrap();
    let OpenedDesign::ReadOnly(draft) = draft else {
        panic!("a v10 Draft opens read-only");
    };
    assert_eq!(draft.saved_by_version, 10);
    assert_eq!(
        std::fs::read_to_string(root.join("drafts/pond-2-1.canopi")).unwrap(),
        V10_DESIGN,
        "opening and listing write nothing"
    );
}
