use std::io;
use std::path::Path;
use std::sync::Arc;

use canopi_support::durable::TargetLocks;
use canopi_support::fault_fs::{FaultAction, FaultFs, FaultOp};
use canopi_support::hash;
use canopi_types::design_home::{HomeRead, HomeWrite};
use canopi_types::ids::HomeVersion;

use super::{DesktopHomeStore, FileGrantRegistry, GrantError, MAX_CANOPI_FILE_BYTES};
use crate::test_scratch::TestScratch;

#[test]
fn home_read_and_write_resolve_file_grants_and_draft_ids_behind_one_port() {
    let root = TestScratch::new("home-port-probe");
    let app_data = root.join("app-data");
    let designs = root.join("designs");
    std::fs::create_dir_all(&designs).unwrap();

    let grants = Arc::new(FileGrantRegistry::default());
    let store = DesktopHomeStore::production(&app_data, Arc::clone(&grants));

    // File grant home: absent -> write(None) -> read -> write(Some(v1)) -> conflict on stale v1.
    let file_path = designs.join("orchard.canopi");
    let grant = grants.grant(&file_path).expect("grant file");
    assert_eq!(grants.grant(&file_path).unwrap(), grant);
    assert!(FileGrantRegistry::is_grant(grant.as_str()));

    assert_eq!(store.read(grant.as_str()), HomeRead::Absent);

    let v1_bytes = b"{\"version\":9,\"name\":\"Orchard\"}";
    let HomeWrite::Written { version: v1 } = store.write(grant.as_str(), v1_bytes, None, false)
    else {
        panic!("expected Written for initial file home");
    };
    assert_eq!(v1.as_str(), hash::sha256_hex(v1_bytes));
    assert_eq!(
        store.read(grant.as_str()),
        HomeRead::Present {
            bytes: v1_bytes.to_vec(),
            version: v1.clone(),
        }
    );

    let v2_bytes = b"{\"version\":9,\"name\":\"Orchard v2\"}";
    let HomeWrite::Written { version: v2 } =
        store.write(grant.as_str(), v2_bytes, Some(&v1), false)
    else {
        panic!("expected Written for CAS update");
    };
    assert_eq!(
        store.write(grant.as_str(), b"stale", Some(&v1), false),
        HomeWrite::Conflict {
            current: Some(v2.clone()),
        }
    );

    // Draft id home through the exact same read/write port.
    let draft_key = "draft-2b4-probe";
    assert_eq!(store.read(draft_key), HomeRead::Absent);
    let draft_bytes = b"{\"version\":9,\"name\":\"Untitled\"}";
    let HomeWrite::Written { version: dv1 } = store.write(draft_key, draft_bytes, None, false)
    else {
        panic!("expected Written for Draft home");
    };
    assert_eq!(
        store.read(draft_key),
        HomeRead::Present {
            bytes: draft_bytes.to_vec(),
            version: dv1,
        }
    );
    assert!(
        app_data
            .join("drafts")
            .join("draft-2b4-probe.canopi")
            .exists()
    );

    // Invalid keys and unknown grants are refused cleanly.
    assert!(matches!(
        store.read("../escape"),
        HomeRead::Unreadable { .. }
    ));
    assert!(matches!(
        store.read("grant:9999"),
        HomeRead::Unreadable { .. }
    ));
    assert!(matches!(
        store.write("../escape", b"{}", None, false),
        HomeWrite::Failed { .. }
    ));
}

#[test]
fn conflict_wins_over_pre_upgrade_copy_and_copies_never_overwrite() {
    let root = TestScratch::new("home-pre-upgrade-copy");
    let app_data = root.join("app-data");
    let designs = root.join("designs");
    std::fs::create_dir_all(&designs).unwrap();

    let grants = Arc::new(FileGrantRegistry::default());
    let store = DesktopHomeStore::production(&app_data, Arc::clone(&grants));
    let file_path = designs.join("garden.canopi");
    let grant = grants.grant(&file_path).unwrap();

    let v9 = b"{\"version\":9}";
    let HomeWrite::Written { version: v9_hash } = store.write(grant.as_str(), v9, None, false)
    else {
        panic!("initial write");
    };

    // Stale expected version with keep_previous=true -> Conflict, NO backup created.
    let stale =
        HomeVersion::new("0000000000000000000000000000000000000000000000000000000000000000");
    assert_eq!(
        store.write(grant.as_str(), b"{\"version\":10}", Some(&stale), true),
        HomeWrite::Conflict {
            current: Some(v9_hash.clone()),
        }
    );
    assert!(!designs.join("garden (before 2.1).canopi").exists());

    // Valid expected version with keep_previous=true -> creates backup then publishes.
    let v10 = b"{\"version\":10}";
    let HomeWrite::Written { version: v10_hash } =
        store.write(grant.as_str(), v10, Some(&v9_hash), true)
    else {
        panic!("expected Written with keep_previous");
    };
    assert_eq!(
        std::fs::read(designs.join("garden (before 2.1).canopi")).unwrap(),
        v9
    );

    // Second keep_previous picks next free name and never overwrites first backup.
    assert!(matches!(
        store.write(
            grant.as_str(),
            b"{\"version\":10,\"edit\":2}",
            Some(&v10_hash),
            true
        ),
        HomeWrite::Written { .. }
    ));
    assert_eq!(
        std::fs::read(designs.join("garden (before 2.1).canopi")).unwrap(),
        v9
    );
    assert_eq!(
        std::fs::read(designs.join("garden (before 2.1) 2.canopi")).unwrap(),
        v10
    );

    // Draft keep_previous preserves v9 once under drafts/before-v10/<id>.canopi.
    let HomeWrite::Written { version: dv9 } = store.write("draft-1", v9, None, false) else {
        panic!("initial draft");
    };
    assert!(matches!(
        store.write("draft-1", v10, Some(&dv9), true),
        HomeWrite::Written { .. }
    ));
    assert_eq!(
        std::fs::read(app_data.join("drafts/before-v10/draft-1.canopi")).unwrap(),
        v9
    );
}

#[test]
fn fault_fs_unwritable_copy_blocks_publish_and_rename_failure_preserves_previous() {
    let root = TestScratch::new("home-fault-fs");
    let designs = root.join("designs");
    let drafts = root.join("drafts");
    std::fs::create_dir_all(&designs).unwrap();

    let grants = Arc::new(FileGrantRegistry::default());
    let file_path = designs.join("faulted.canopi");
    let grant = grants.grant(&file_path).unwrap();

    let store = DesktopHomeStore::with_fs(
        drafts,
        Arc::clone(&grants),
        Arc::new(TargetLocks::new()),
        FaultFs::new(),
    );

    let v1 = b"{\"version\":9,\"safe\":true}";
    let HomeWrite::Written { version: v1_hash } = store.write(grant.as_str(), v1, None, false)
    else {
        panic!("initial write");
    };

    // Inject permission denied on copy staging -> CopyBlocked, original bytes untouched.
    store.fs.inject(
        FaultOp::StageBytes,
        FaultAction::IoError(io::ErrorKind::PermissionDenied),
    );
    assert_eq!(
        store.write(grant.as_str(), b"{\"version\":10}", Some(&v1_hash), true),
        HomeWrite::CopyBlocked {
            folder: "designs".to_owned(),
        }
    );
    assert_eq!(
        store.read(grant.as_str()),
        HomeRead::Present {
            bytes: v1.to_vec(),
            version: v1_hash.clone(),
        }
    );

    // Inject rename failure -> Failed, original bytes still intact.
    store.fs.inject(
        FaultOp::RenameReplace,
        FaultAction::IoError(io::ErrorKind::StorageFull),
    );
    assert!(matches!(
        store.write(
            grant.as_str(),
            b"{\"version\":9,\"next\":true}",
            Some(&v1_hash),
            false
        ),
        HomeWrite::Failed { .. }
    ));
    assert_eq!(
        store.read(grant.as_str()),
        HomeRead::Present {
            bytes: v1.to_vec(),
            version: v1_hash,
        }
    );
}

#[test]
fn concurrent_home_write_and_legacy_design_write_serialize_on_shared_target_lock() {
    use std::sync::mpsc;
    use std::time::Duration;

    let root = TestScratch::new("home-shared-lock");
    let designs = root.join("designs");
    std::fs::create_dir_all(&designs).unwrap();
    let file_path = designs.join("shared.canopi");

    let grants = Arc::new(FileGrantRegistry::default());
    let grant = grants.grant(&file_path).unwrap();
    let store = Arc::new(DesktopHomeStore::production(
        root.path(),
        Arc::clone(&grants),
    ));

    // Seed initial file via home store.
    let v0 = b"{\"version\":9,\"step\":0}";
    let HomeWrite::Written { version: v0_hash } = store.write(grant.as_str(), v0, None, false)
    else {
        panic!("seed write");
    };

    // Hold the legacy design write lock on the exact same target path, then launch a concurrent
    // DesktopHomeStore::production write and prove it blocks until the legacy lock releases.
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();

    let legacy_path = file_path.clone();
    let legacy_handle = std::thread::spawn(move || {
        crate::target_locks::temporary_target_locks().with_lock(&legacy_path, || {
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            std::fs::write(&legacy_path, b"{\"version\":9,\"step\":1}").unwrap();
        });
    });

    locked_rx.recv().unwrap();

    let home_store = Arc::clone(&store);
    let home_grant = grant.clone();
    let expected = v0_hash.clone();
    let home_handle = std::thread::spawn(move || {
        let outcome = home_store.write(
            home_grant.as_str(),
            b"{\"version\":9,\"step\":2}",
            Some(&expected),
            false,
        );
        done_tx.send(outcome).unwrap();
    });

    // While legacy holds the shared target lock, DesktopHomeStore::write must not finish.
    assert!(
        done_rx.recv_timeout(Duration::from_millis(80)).is_err(),
        "DesktopHomeStore::write bypassed the shared TargetLocks"
    );

    // Release the legacy writer: home_write now acquires the lock, sees step 1 on disk, and
    // settles as Conflict with step 1's fingerprint rather than clobbering it.
    release_tx.send(()).unwrap();
    legacy_handle.join().unwrap();
    let outcome = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    home_handle.join().unwrap();

    let step1_hash = HomeVersion::new(canopi_support::hash::sha256_hex(
        b"{\"version\":9,\"step\":1}",
    ));
    assert_eq!(
        outcome,
        HomeWrite::Conflict {
            current: Some(step1_hash),
        }
    );
    assert_eq!(
        std::fs::read(&file_path).unwrap(),
        b"{\"version\":9,\"step\":1}"
    );
}

#[test]
fn real_commands_mint_file_grants_and_round_trip_home_read_and_home_write() {
    use tauri::Manager as _;

    let root = TestScratch::new("home-real-commands");
    let designs = root.join("designs");
    std::fs::create_dir_all(&designs).unwrap();
    let launched_path = designs.join("launched.canopi");
    let initial = b"{\"version\":9,\"origin\":\"launch\"}";
    std::fs::write(&launched_path, initial).unwrap();

    let grants = Arc::new(FileGrantRegistry::default());
    let store = Arc::new(DesktopHomeStore::production(
        root.path(),
        Arc::clone(&grants),
    ));
    let app = tauri::test::mock_builder()
        .manage(crate::native_operation::NativeOperationExecutor::production())
        .manage(crate::host::launch::PendingOpenSlot::default())
        .manage(Arc::clone(&grants))
        .manage(Arc::clone(&store))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds");

    // Forward a launch file through on_second_launch -> take_pending_open mints a grant.
    crate::host::launch::on_second_launch(
        app.handle(),
        vec!["canopi".into(), launched_path.to_str().unwrap().to_owned()],
        designs.to_str().unwrap().to_owned(),
    );
    let pending = crate::commands::host::take_pending_open(app.state()).expect("pending open");
    let grant = pending.grant.expect("minted file grant on launch");

    // Read through the real async `home_read` command using the minted grant.
    let read_outcome = tauri::async_runtime::block_on(crate::commands::host::home_read(
        app.state(),
        app.state(),
        grant.as_str().to_owned(),
    ))
    .expect("home_read command");
    let HomeRead::Present { bytes, version } = read_outcome else {
        panic!("expected Present, got {read_outcome:?}");
    };
    assert_eq!(bytes, initial);

    // Write an update through the real async `home_write` command using the same grant.
    let updated = b"{\"version\":10,\"origin\":\"home_write\"}";
    let write_outcome = tauri::async_runtime::block_on(crate::commands::host::home_write(
        app.state(),
        app.state(),
        grant.as_str().to_owned(),
        updated.to_vec(),
        Some(version),
        Some(false),
    ))
    .expect("home_write command");
    let HomeWrite::Written {
        version: updated_version,
    } = write_outcome
    else {
        panic!("expected Written, got {write_outcome:?}");
    };
    assert_eq!(
        updated_version,
        HomeVersion::new(canopi_support::hash::sha256_hex(updated))
    );
    assert_eq!(std::fs::read(&launched_path).unwrap(), updated);
}

#[test]
fn grant_rejects_missing_parent_or_filename_with_typed_error_and_oversized_file_refused_from_metadata()
 {
    let grants = Arc::new(FileGrantRegistry::default());
    assert_eq!(
        grants.grant(Path::new("orphan.canopi")),
        Err(GrantError::MissingParent)
    );
    assert_eq!(
        grants.grant(Path::new("/designs/..")),
        Err(GrantError::MissingFileName)
    );

    // Nit 1: metadata length check refuses oversized files before reading bytes into memory.
    let root = TestScratch::new("home-oversized");
    let designs = root.join("designs");
    std::fs::create_dir_all(&designs).unwrap();
    let huge = designs.join("huge.canopi");
    let file = std::fs::File::create(&huge).unwrap();
    file.set_len(MAX_CANOPI_FILE_BYTES + 1).unwrap();
    drop(file);

    let grant = grants.grant(&huge).unwrap();
    let store = DesktopHomeStore::production(root.path(), Arc::clone(&grants));
    assert_eq!(
        store.read(grant.as_str()),
        HomeRead::Unreadable {
            reason: "design exceeds the maximum readable size".to_owned(),
        }
    );
}
