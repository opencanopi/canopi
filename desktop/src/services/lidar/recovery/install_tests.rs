//! canopi-uidt: what the install does with the old catalogue's files. The old main file is copied aside and its
//! sidecars moved beside the copy before the one rename; a failure before that rename puts the sidecars back, and a
//! log beside a missing catalogue is set aside before a fresh catalogue opens there. Each library here is the real
//! one (`LidarLibrary::open`).

use super::super::LidarLibrary;
use super::super::paths::CATALOGUE_FILE;
use super::failed_rebuild_tests::{
    ANY_FILE_BUT_A_DATABASE, assert_originals_kept, assert_recovered, catalogue_unchanged,
    item_count, seeded, staging_left,
};
use super::*;

/// A stop inside an earlier Canopi's set-aside (which moved the catalogue before its log) left no catalogue, a staging
/// folder and a stray log: the next start rebuilds and moves the log aside, so it is never replayed on the rebuild.
#[test]
fn canopi_uidt_a_stop_between_set_aside_and_install_is_rebuilt_at_the_next_start() {
    let (root, paths) = seeded("uidt-stop-install", Vec::new());
    let staging = paths.root().join(REBUILD_STAGING_DIR);
    std::fs::create_dir_all(&staging).unwrap();
    drop(catalogue::open(&staging.join(CATALOGUE_FILE)).unwrap());
    let mut wal = paths.catalogue_path().into_os_string();
    wal.push("-wal");
    std::fs::write(&wal, b"the old catalogue's log").unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_recovered(&library, 1, 1, "the next start");
    assert_eq!(item_count(&library), 2);
    drop(library);
    assert!(
        staging_left(&paths).is_empty(),
        "{:?}",
        staging_left(&paths)
    );
    let kept: Vec<Vec<u8>> = std::fs::read_dir(paths.set_aside_dir())
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with("-wal"))
        .map(|entry| std::fs::read(entry.path()).unwrap())
        .collect();
    assert_eq!(
        kept,
        vec![b"the old catalogue's log".to_vec()],
        "the stray log is set aside, byte for byte"
    );
    assert_originals_kept(&paths, "the next start");
}

/// A failure after the rebuild committed and before the rename (here the set-aside folder refuses the copy) leaves
/// the old catalogue at its path and no staging folder, so the next start recovers it again.
#[cfg(unix)]
#[test]
fn canopi_uidt_a_rebuild_that_cannot_set_the_old_catalogue_aside_keeps_it_in_place() {
    use std::os::unix::fs::PermissionsExt;
    let (root, paths) = seeded("uidt-set-aside-fails", Vec::new());
    std::fs::write(paths.catalogue_path(), ANY_FILE_BUT_A_DATABASE).unwrap();
    let set_aside = paths.set_aside_dir();
    std::fs::create_dir_all(&set_aside).unwrap();
    std::fs::set_permissions(&set_aside, std::fs::Permissions::from_mode(0o500)).unwrap();
    if std::fs::write(set_aside.join("probe"), b"").is_ok() {
        // Run as root: permissions are not enforced, so the folder cannot refuse a write.
        std::fs::set_permissions(&set_aside, std::fs::Permissions::from_mode(0o755)).unwrap();
        eprintln!("skipped: permissions are not enforced for this user");
        return;
    }

    let first = LidarLibrary::open(&root).expect("start 1");
    std::fs::set_permissions(&set_aside, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(first.open_status(), LibraryOpenStatus::Unavailable { .. }),
        "start 1: {:?}",
        first.open_status()
    );
    drop(first);
    assert!(
        catalogue_unchanged(&paths),
        "the old catalogue stays in its place"
    );
    assert!(
        staging_left(&paths).is_empty(),
        "{:?}",
        staging_left(&paths)
    );
    assert_originals_kept(&paths, "start 1");

    let second = LidarLibrary::open(&root).expect("start 2");
    assert_recovered(&second, 1, 1, "start 2");
    drop(second);
    let copies: Vec<Vec<u8>> = std::fs::read_dir(&set_aside)
        .unwrap()
        .flatten()
        .map(|entry| std::fs::read(entry.path()).unwrap())
        .collect();
    assert_eq!(
        copies,
        vec![ANY_FILE_BUT_A_DATABASE.to_vec()],
        "the old catalogue is copied aside, byte for byte"
    );
}

/// The catalogue path with `suffix` appended: one of its sidecars.
fn catalogue_sidecar(paths: &LidarPaths, suffix: &str) -> PathBuf {
    let mut path = paths.catalogue_path().into_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

/// A sidecar that cannot follow after the old log was already set aside (here the `-shm` is a directory holding the
/// set-aside folder, which no rename can move into itself) puts the log back beside the old catalogue: without it
/// a catalogue damaged only through its log would read as current. The next start recovers it.
#[cfg(unix)]
#[test]
fn canopi_uidt_a_sidecar_that_cannot_follow_puts_the_old_log_back_beside_the_old_catalogue() {
    let (root, paths) = seeded("uidt-sidecar-stuck", Vec::new());
    std::fs::write(paths.catalogue_path(), ANY_FILE_BUT_A_DATABASE).unwrap();
    let wal = catalogue_sidecar(&paths, "-wal");
    std::fs::write(&wal, b"the old catalogue's log").unwrap();
    let shm = catalogue_sidecar(&paths, "-shm");
    std::fs::create_dir(&shm).unwrap();
    std::os::unix::fs::symlink(&shm, paths.set_aside_dir()).unwrap();

    let first = LidarLibrary::open(&root).expect("start 1");

    assert!(
        matches!(first.open_status(), LibraryOpenStatus::Unavailable { .. }),
        "start 1: {:?}",
        first.open_status()
    );
    drop(first);
    assert!(
        catalogue_unchanged(&paths),
        "the old catalogue stays in place"
    );
    assert_eq!(
        std::fs::read(&wal).ok().as_deref(),
        Some(&b"the old catalogue's log"[..]),
        "its log is back beside it"
    );
    assert!(
        staging_left(&paths).is_empty(),
        "{:?}",
        staging_left(&paths)
    );
    assert_originals_kept(&paths, "start 1");

    std::fs::remove_file(paths.set_aside_dir()).unwrap();
    std::fs::remove_dir_all(&shm).unwrap();
    let second = LidarLibrary::open(&root).expect("start 2");
    assert_recovered(&second, 1, 1, "start 2");
    drop(second);
    assert_originals_kept(&paths, "start 2");
}

/// A log left beside a missing catalogue (an earlier Canopi's set-aside cut short) is set aside before a fresh
/// catalogue opens there, even with no original to rebuild from: SQLite would discard it, losing the only copy.
#[test]
fn canopi_uidt_a_stray_log_beside_a_missing_catalogue_is_set_aside_before_it_opens_fresh() {
    let root = crate::test_scratch::TestScratch::new("uidt-stray-log-fresh");
    let paths = LidarPaths::open(&root).unwrap();
    std::fs::write(
        catalogue_sidecar(&paths, "-wal"),
        b"the old catalogue's log",
    )
    .unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    drop(library);
    let kept: Vec<Vec<u8>> = std::fs::read_dir(paths.set_aside_dir())
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().ends_with("-wal"))
                .map(|entry| std::fs::read(entry.path()).unwrap())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        kept,
        vec![b"the old catalogue's log".to_vec()],
        "the stray log is set aside, byte for byte"
    );
}
