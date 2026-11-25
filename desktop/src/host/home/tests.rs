use std::io;
use std::sync::Arc;

use canopi_support::durable::TargetLocks;
use canopi_support::fault_fs::{FaultAction, FaultFs, FaultOp};
use canopi_support::hash;
use canopi_types::design_home::{HomeRead, HomeWrite};
use canopi_types::ids::HomeVersion;

use super::{DesktopHomeStore, FileGrantRegistry};
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
