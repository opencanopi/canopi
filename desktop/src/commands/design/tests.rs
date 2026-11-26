//! The Design commands' tests: each command on a mock app with a scratch folder and an in-memory
//! user database.

use tauri::Manager;

use crate::{db::UserDb, design::drafts::DesignDrafts, native_operation::NativeOperationExecutor};

fn scratch_root(label: &str) -> crate::test_scratch::TestScratch {
    crate::test_scratch::TestScratch::new(&format!("design-commands-{label}"))
}

fn mock_app(root: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    let user_db = UserDb::initialize(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
    tauri::test::mock_builder()
        .manage(NativeOperationExecutor::production())
        .manage(user_db)
        .manage(DesignDrafts::new(root))
        .manage(crate::services::recent_design_previews::RecentDesignPreviews::default())
        .manage(std::sync::Arc::new(
            crate::host::home::FileGrantRegistry::default(),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

fn design(name: &str) -> canopi_types::design::CanopiFile {
    crate::design::format::create_new_design(name, "2026-09-25T00:00:00Z")
}

#[test]
fn canopi_f47t_52_228_14_a_loaded_or_saved_design_sets_its_windows_open_folder() {
    use canopi_types::design_home::{HomeRead, HomeWrite};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct StartFolders(Mutex<Vec<Option<PathBuf>>>);

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

    let root = scratch_root("dialog_folder");
    let (saved, loaded) = (root.join("saved"), root.join("loaded"));
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::create_dir_all(&loaded).unwrap();
    let saved_file = saved.join("orchard.canopi");
    let elsewhere = loaded.join("elsewhere.canopi");
    let missing = loaded.join("missing.canopi");
    std::fs::write(&elsewhere, b"{\"version\":9}").unwrap();

    let grants = Arc::new(crate::host::home::FileGrantRegistry::default());
    let store = Arc::new(crate::host::home::DesktopHomeStore::production(
        root.path(),
        Arc::clone(&grants),
    ));
    let start_folders = Arc::new(StartFolders::default());
    let app = tauri::test::mock_builder()
        .manage(NativeOperationExecutor::production())
        .manage(crate::host::dialogs::HostDialogs::new(
            Arc::clone(&start_folders) as Arc<dyn crate::host::dialogs::Picker>,
        ))
        .manage(Arc::clone(&grants))
        .manage(Arc::clone(&store))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds");
    let win_main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let win_second = tauri::WebviewWindowBuilder::new(&app, "second", tauri::WebviewUrl::default())
        .build()
        .unwrap();

    let open_folder = |win: &tauri::WebviewWindow<tauri::test::MockRuntime>| -> Option<PathBuf> {
        let _ = tauri::async_runtime::block_on(crate::commands::host::pick_open(
            win.clone(),
            app.state(),
            app.state(),
            app.state(),
            canopi_types::dialog::DialogKind::DesignOpen,
        ))
        .unwrap();
        start_folders.0.lock().unwrap().pop().flatten()
    };

    assert_eq!(open_folder(&win_main), None);

    let saved_grant = grants.grant(&saved_file).unwrap();
    let elsewhere_grant = grants.grant(&elsewhere).unwrap();
    let missing_grant = grants.grant(&missing).unwrap();

    let write_res = tauri::async_runtime::block_on(crate::commands::host::home_write(
        win_main.clone(),
        app.state(),
        app.state(),
        saved_grant.as_str().to_owned(),
        b"{\"version\":9}".to_vec(),
        None,
        Some(false),
    ))
    .unwrap();
    assert!(matches!(write_res, HomeWrite::Written { .. }));

    let read_res = tauri::async_runtime::block_on(crate::commands::host::home_read(
        win_second.clone(),
        app.state(),
        app.state(),
        app.state(),
        elsewhere_grant.as_str().to_owned(),
    ))
    .unwrap();
    assert!(matches!(read_res, HomeRead::Present { .. }));

    let absent_res = tauri::async_runtime::block_on(crate::commands::host::home_read(
        win_main.clone(),
        app.state(),
        app.state(),
        app.state(),
        missing_grant.as_str().to_owned(),
    ))
    .unwrap();
    assert!(matches!(absent_res, HomeRead::Absent));

    assert_eq!(open_folder(&win_main), Some(saved));
    assert_eq!(open_folder(&win_second), Some(loaded));
}

#[test]
fn recent_design_previews_read_listed_designs_only() {
    let root = scratch_root("previews");
    let app = mock_app(&root);
    let listed = root.join("orchard.canopi").to_string_lossy().into_owned();
    crate::services::design_files::save_design(
        app.state::<UserDb>().inner(),
        listed.clone(),
        design("Orchard"),
        None,
    )
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
    crate::services::design_files::save_design(
        app.state::<UserDb>().inner(),
        path.clone(),
        design("Orchard"),
        None,
    )
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
    let recent = tauri::async_runtime::block_on(super::get_recent_files(
        app.state(),
        app.state(),
        app.state(),
    ))
    .unwrap();
    assert!(recent.is_empty());
    assert!(std::path::Path::new(&path).is_file());
}

#[test]
fn draft_commands_list_and_delete_through_managed_state() {
    let root = scratch_root("drafts");
    let app = mock_app(&root);
    app.state::<DesignDrafts>()
        .inner()
        .save("draft-1", &design("Sketch"))
        .unwrap();
    let listed =
        tauri::async_runtime::block_on(super::list_design_drafts(app.state(), app.state()))
            .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].id.as_str(), listed[0].name.as_str()),
        ("draft-1", "Sketch")
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

/// canopi-f47t.52.270 / 2.1-Q347: at v10 cutover, a v10 Design opens editable from Recent
/// previews and the Draft list, while a v11+ Design is refused unchanged (`NewerVersion` /
/// `unreadable`) without writing any bytes.
#[test]
fn canopi_f47t_52_270_a_v10_design_opens_editable_and_v11_is_refused_from_recent_and_drafts() {
    let root = scratch_root("newer");
    let app = mock_app(&root);
    let path = root.join("pond.canopi");
    std::fs::write(&path, V10_DESIGN).unwrap();
    let path_str = path.to_string_lossy().into_owned();

    let mut v11: serde_json::Value = serde_json::from_str(V10_DESIGN).unwrap();
    v11["version"] = serde_json::json!(11);
    let v11_text = v11.to_string();
    let v11_path = root.join("pond-2-2.canopi");
    std::fs::write(&v11_path, &v11_text).unwrap();
    let v11_path_str = v11_path.to_string_lossy().into_owned();

    {
        let user_db = app.state::<UserDb>();
        let conn = user_db.acquire();
        crate::db::recent_files::record_recent_file(&conn, &path_str, "Orchard by the pond")
            .unwrap();
        crate::db::recent_files::record_recent_file(&conn, &v11_path_str, "Future pond").unwrap();
    }
    let recent = tauri::async_runtime::block_on(super::get_recent_files(
        app.state(),
        app.state(),
        app.state(),
    ))
    .unwrap();
    assert_eq!(recent.len(), 2);

    let previews = tauri::async_runtime::block_on(super::get_recent_design_previews(
        app.state(),
        app.state(),
        app.state(),
        vec![path_str, v11_path_str],
    ))
    .unwrap();
    assert!(
        matches!(
            previews[0].preview,
            canopi_types::design::RecentDesignPreview::Read { .. }
        ),
        "a v10 Recent Design opens Read: {:?}",
        previews[0].preview
    );
    assert!(
        matches!(
            previews[1].preview,
            canopi_types::design::RecentDesignPreview::Unreadable {
                reason: canopi_types::design::RecentDesignUnreadableReason::NewerVersion,
            }
        ),
        "a v11 Recent Design is refused as NewerVersion (2.1-Q347): {:?}",
        previews[1].preview
    );

    std::fs::create_dir_all(root.join("drafts")).unwrap();
    std::fs::write(root.join("drafts/pond-2-1.canopi"), V10_DESIGN).unwrap();
    std::fs::write(root.join("drafts/pond-2-2.canopi"), &v11_text).unwrap();
    let listed =
        tauri::async_runtime::block_on(super::list_design_drafts(app.state(), app.state()))
            .unwrap();
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
        ("pond-2-1", "Orchard by the pond", "editable"),
        ("pond-2-2", "Untitled", "unreadable"),
    ]
    .map(|(id, name, access)| (id.to_owned(), name.to_owned(), access.to_owned()));
    assert_eq!(listed, expected);
    assert_eq!(
        std::fs::read_to_string(root.join("drafts/pond-2-1.canopi")).unwrap(),
        V10_DESIGN,
        "opening and listing write nothing"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("drafts/pond-2-2.canopi")).unwrap(),
        v11_text,
        "refusing v11 writes nothing"
    );
}
