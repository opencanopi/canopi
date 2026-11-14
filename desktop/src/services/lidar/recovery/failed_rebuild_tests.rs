//! canopi-uidt: a rebuild that fails, or a start that stops part way, never leaves an empty current catalogue
//! standing in for an unrebuilt one, and the startup prune deletes only originals something marked released. Each
//! library here is the real one (`LidarLibrary::open`), started two or three times over the same folder.

use super::super::LidarLibrary;
use super::super::paths::CATALOGUE_FILE;
use super::tests::{rebuilt_items, seed_original};
use super::*;

const ANY_FILE_BUT_A_DATABASE: &[u8] = b"not a database at all, just bytes";

/// The library folder of a fresh app data folder, with `sha-a` (its meta names item `lyr-a`, with `analyses`) and
/// `sha-b` (no meta) under `sources/`.
fn seeded(
    name: &str,
    analyses: Vec<source_meta::AnalysisMeta>,
) -> (crate::test_scratch::TestScratch, LidarPaths) {
    let root = crate::test_scratch::TestScratch::new(name);
    let paths = LidarPaths::open(&root).unwrap();
    seed_original(
        &paths,
        "sha-a",
        Some(&meta_naming("sha-a", "lyr-a", analyses)),
    );
    seed_original(&paths, "sha-b", None);
    (root, paths)
}

fn meta_naming(sha256: &str, item: &str, analyses: Vec<source_meta::AnalysisMeta>) -> SourceMeta {
    SourceMeta {
        version: source_meta::META_VERSION,
        sha256: sha256.to_string(),
        original_filename: "a.tif".to_string(),
        size_bytes: 4,
        imported_at: "2026-01-01T00:00:00Z".to_string(),
        items: vec![source_meta::ItemMeta {
            id: item.to_string(),
            name: "Field A".to_string(),
            quantity: DEFAULT_QUANTITY_KEY.to_string(),
            units: "m".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            members: vec![sha256.to_string()],
            analyses,
        }],
    }
}

/// An analysis over `lyr-a` that names the same input twice: valid JSON whose insert fails.
fn analysis_with_a_repeated_input() -> source_meta::AnalysisMeta {
    let input = source_meta::AnalysisInputMeta {
        input_key: "elevation".to_string(),
        item_id: "lyr-a".to_string(),
    };
    source_meta::AnalysisMeta {
        definition_id: "def-1".to_string(),
        analysis_id: "slope".to_string(),
        parameters: serde_json::json!({}),
        outputs: serde_json::json!({}),
        created_at: "2026-01-02T00:00:00Z".to_string(),
        inputs: vec![input.clone(), input],
        items: Vec::new(),
    }
}

/// Whether the catalogue path still holds the seeded damaged file, byte for byte.
fn catalogue_unchanged(paths: &LidarPaths) -> bool {
    std::fs::read(paths.catalogue_path()).ok().as_deref() == Some(ANY_FILE_BUT_A_DATABASE)
}

fn item_count(library: &LidarLibrary) -> usize {
    rebuilt_items(&library.catalogue().unwrap()).len()
}

fn assert_originals_kept(paths: &LidarPaths, start: &str) {
    for sha256 in ["sha-a", "sha-b"] {
        assert_eq!(
            std::fs::read(paths.source_original(sha256)).ok().as_deref(),
            Some(&b"tile"[..]),
            "{start}: {sha256} is kept"
        );
    }
    assert!(
        paths.source_meta("sha-a").is_file(),
        "{start}: sha-a's meta is kept"
    );
}

/// What a rebuild staged at the library root and left behind.
fn staging_left(paths: &LidarPaths) -> Vec<String> {
    std::fs::read_dir(paths.root())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(REBUILD_STAGING_DIR))
        .collect()
}

fn assert_recovered(library: &LidarLibrary, items: usize, generated: usize, start: &str) {
    let status = library.open_status();
    assert!(
        matches!(status, LibraryOpenStatus::Recovered { items: i, generated: g, .. } if *i == items && *g == generated),
        "{start}: {status:?}"
    );
}

#[cfg(unix)]
#[test]
fn canopi_uidt_a_rebuild_that_cannot_list_sources_keeps_the_catalogue_and_originals_for_the_next_start()
 {
    use std::os::unix::fs::PermissionsExt;
    let (root, paths) = seeded("uidt-unlistable", Vec::new());
    std::fs::write(paths.catalogue_path(), ANY_FILE_BUT_A_DATABASE).unwrap();
    let sources = paths.root().join("sources");
    std::fs::set_permissions(&sources, std::fs::Permissions::from_mode(0o300)).unwrap();
    if std::fs::read_dir(&sources).is_ok() {
        // Run as root: permissions are not enforced, so the folder cannot be made unlistable.
        std::fs::set_permissions(&sources, std::fs::Permissions::from_mode(0o755)).unwrap();
        eprintln!("skipped: permissions are not enforced for this user");
        return;
    }
    let first = LidarLibrary::open(&root).expect("start 1");
    std::fs::set_permissions(&sources, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        matches!(first.open_status(), LibraryOpenStatus::Unavailable { .. }),
        "start 1: {:?}",
        first.open_status()
    );
    drop(first);
    assert!(
        catalogue_unchanged(&paths),
        "the unrebuilt catalogue stays in place, so the next start recovers again"
    );
    assert!(
        staging_left(&paths).is_empty(),
        "{:?}",
        staging_left(&paths)
    );
    assert_originals_kept(&paths, "start 1");

    let second = LidarLibrary::open(&root).expect("start 2");
    assert_recovered(&second, 1, 1, "start 2");
    assert_eq!(item_count(&second), 2);
    drop(second);
    assert_originals_kept(&paths, "start 2");

    let third = LidarLibrary::open(&root).expect("start 3");
    assert_eq!(*third.open_status(), LibraryOpenStatus::Ready);
    assert_eq!(item_count(&third), 2, "start 3 lists both originals");
    drop(third);
    assert_originals_kept(&paths, "start 3");
}

#[test]
fn canopi_uidt_a_rebuild_whose_insert_fails_keeps_the_catalogue_and_every_original_at_each_start() {
    let (root, paths) = seeded("uidt-insert", vec![analysis_with_a_repeated_input()]);
    std::fs::write(paths.catalogue_path(), ANY_FILE_BUT_A_DATABASE).unwrap();
    for start in ["start 1", "start 2"] {
        let library = LidarLibrary::open(&root).expect(start);
        assert!(
            matches!(library.open_status(), LibraryOpenStatus::Unavailable { .. }),
            "{start}: {:?}",
            library.open_status()
        );
        drop(library);
        assert!(
            catalogue_unchanged(&paths),
            "{start}: the unrebuilt catalogue stays in place"
        );
        assert!(
            staging_left(&paths).is_empty(),
            "{start}: {:?}",
            staging_left(&paths)
        );
        assert_originals_kept(&paths, start);
    }

    // Once the meta reads again, the next start rebuilds both.
    source_meta::write(
        &paths.source_meta("sha-a"),
        &meta_naming("sha-a", "lyr-a", Vec::new()),
    )
    .unwrap();
    let third = LidarLibrary::open(&root).expect("start 3");
    assert_recovered(&third, 1, 1, "start 3");
    assert_eq!(item_count(&third), 2);
    drop(third);
    assert_originals_kept(&paths, "start 3");
}

/// A catalogue that is gone, or zero-length, beside originals is a lost catalogue, not an empty library: it is
/// rebuilt from them, and nothing is pruned.
#[test]
fn canopi_uidt_a_missing_or_empty_catalogue_beside_originals_is_rebuilt_and_prunes_none() {
    for (name, catalogue) in [("uidt-missing", None), ("uidt-zero-length", Some(&b""[..]))] {
        let (root, paths) = seeded(name, Vec::new());
        if let Some(bytes) = catalogue {
            std::fs::write(paths.catalogue_path(), bytes).unwrap();
        }
        let first = LidarLibrary::open(&root).expect(name);
        assert_recovered(&first, 1, 1, name);
        assert_eq!(item_count(&first), 2, "{name}");
        drop(first);
        assert_originals_kept(&paths, name);
        let second = LidarLibrary::open(&root).expect(name);
        assert_eq!(*second.open_status(), LibraryOpenStatus::Ready, "{name}");
        assert_eq!(item_count(&second), 2, "{name}");
    }
}

/// A missing catalogue beside only released originals is an empty library: it opens fresh, no rebuild is reported,
/// and the released original goes.
#[test]
fn canopi_uidt_a_missing_catalogue_beside_only_released_originals_opens_fresh_and_prunes_them() {
    let root = crate::test_scratch::TestScratch::new("uidt-missing-released");
    let paths = LidarPaths::open(&root).unwrap();
    seed_original(&paths, "sha-r", None);
    source_meta::release(&paths, "sha-r").unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    assert!(
        !paths.source_dir("sha-r").exists(),
        "a released original goes"
    );
}

/// The prune deletes an original only when its meta says it names no item, or a folder with no original; an
/// original nothing claims and nothing released (no meta, or a meta naming an item) stays.
#[test]
fn canopi_uidt_the_startup_prune_keeps_every_original_nothing_released() {
    let (root, paths) = seeded("uidt-prune", Vec::new());
    // The empty current catalogue the failed rebuild used to leave.
    drop(catalogue::open(&paths.catalogue_path()).unwrap());
    seed_original(&paths, "sha-released", None);
    source_meta::release(&paths, "sha-released").unwrap();
    std::fs::create_dir_all(paths.source_dir("sha-no-original")).unwrap();
    source_meta::write(
        &paths.source_meta("sha-no-original"),
        &meta_naming("sha-no-original", "lyr-gone", Vec::new()),
    )
    .unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    drop(library);
    assert_originals_kept(&paths, "the prune");
    assert!(
        !paths.source_dir("sha-released").exists(),
        "a released original goes"
    );
    assert!(
        !paths.source_dir("sha-no-original").exists(),
        "a folder with no original goes"
    );
}

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

/// A stop part way through a rebuild leaves the old catalogue in place beside a staging folder: the next start drops
/// it and recovers again.
#[test]
fn canopi_uidt_a_stop_during_a_rebuild_recovers_again_at_the_next_start() {
    let (root, paths) = seeded("uidt-stop-rebuild", Vec::new());
    std::fs::write(paths.catalogue_path(), ANY_FILE_BUT_A_DATABASE).unwrap();
    let staging = paths.root().join(REBUILD_STAGING_DIR);
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join(CATALOGUE_FILE), b"half a rebuild").unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_recovered(&library, 1, 1, "the next start");
    drop(library);
    assert!(
        staging_left(&paths).is_empty(),
        "{:?}",
        staging_left(&paths)
    );
    assert_originals_kept(&paths, "the next start");
}

/// Every directory (as `None`) and file (with its bytes) under the library root.
fn library_files(paths: &LidarPaths) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn walk(dir: &Path, out: &mut std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.insert(path.clone(), None);
                walk(&path, out);
            } else {
                out.insert(path.clone(), Some(std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    walk(paths.root(), &mut out);
    out
}

const NEWER_META: &str =
    r#"{"version":2,"sha256":"sha-a","a_newer_field":true,"items":[{"id":"lyr-a"}]}"#;

/// A meta a newer Canopi wrote is data this one cannot read: recovery of a missing or corrupt catalogue beside it
/// writes nothing (no set-aside, staging, catalogue or meta) and the library opens unavailable (2.1-M480).
#[test]
fn canopi_uidt_a_newer_meta_beside_a_missing_or_corrupt_catalogue_is_written_over_by_nothing() {
    for (name, catalogue) in [
        ("uidt-newer-missing", None),
        ("uidt-newer-corrupt", Some(ANY_FILE_BUT_A_DATABASE)),
    ] {
        let (root, paths) = seeded(name, Vec::new());
        std::fs::write(paths.source_meta("sha-a"), NEWER_META).unwrap();
        if let Some(bytes) = catalogue {
            std::fs::write(paths.catalogue_path(), bytes).unwrap();
        }
        let before = library_files(&paths);

        let library = LidarLibrary::open(&root).expect(name);

        assert!(
            matches!(library.open_status(), LibraryOpenStatus::Unavailable { .. }),
            "{name}: {:?}",
            library.open_status()
        );
        drop(library);
        assert!(
            library_files(&paths) == before,
            "{name}: nothing under the library changed"
        );
    }
}

/// No writer of a meta replaces one a newer Canopi wrote.
#[test]
fn canopi_uidt_a_newer_meta_is_never_rewritten() {
    let (_root, paths) = seeded("uidt-newer-write", Vec::new());
    std::fs::write(paths.source_meta("sha-a"), NEWER_META).unwrap();

    let written = source_meta::write(
        &paths.source_meta("sha-a"),
        &meta_naming("sha-a", "lyr-a", Vec::new()),
    );

    assert!(written.is_err(), "{written:?}");
    assert_eq!(
        std::fs::read_to_string(paths.source_meta("sha-a")).unwrap(),
        NEWER_META
    );
    assert!(source_meta::release(&paths, "sha-a").is_err());
    assert_eq!(
        std::fs::read_to_string(paths.source_meta("sha-a")).unwrap(),
        NEWER_META
    );
}

/// A `sources/` that cannot be listed beside no catalogue is no empty library: the library opens unavailable and
/// writes nothing, no catalogue included.
#[cfg(unix)]
#[test]
fn canopi_uidt_unlistable_sources_beside_no_catalogue_write_no_catalogue() {
    use std::os::unix::fs::PermissionsExt;
    let (root, paths) = seeded("uidt-unlistable-missing", Vec::new());
    let before = library_files(&paths);
    let sources = paths.root().join("sources");
    std::fs::set_permissions(&sources, std::fs::Permissions::from_mode(0o300)).unwrap();
    if std::fs::read_dir(&sources).is_ok() {
        std::fs::set_permissions(&sources, std::fs::Permissions::from_mode(0o755)).unwrap();
        eprintln!("skipped: permissions are not enforced for this user");
        return;
    }
    let library = LidarLibrary::open(&root).expect("start");
    std::fs::set_permissions(&sources, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(library.open_status(), LibraryOpenStatus::Unavailable { .. }),
        "{:?}",
        library.open_status()
    );
    drop(library);
    assert!(!paths.catalogue_path().exists(), "no catalogue is written");
    assert!(
        library_files(&paths) == before,
        "nothing under the library changed"
    );
}

/// An original folder whose contents cannot be read is no proof of an empty library either: one unreadable entry
/// makes the library unavailable rather than answer "no originals".
#[cfg(unix)]
#[test]
fn canopi_uidt_an_unreadable_original_folder_beside_no_catalogue_writes_no_catalogue() {
    use std::os::unix::fs::PermissionsExt;
    let (root, paths) = seeded("uidt-unreadable-entry", Vec::new());
    let folder = paths.source_dir("sha-b");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::metadata(paths.source_original("sha-b")).is_ok() {
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        eprintln!("skipped: permissions are not enforced for this user");
        return;
    }
    // sha-a is the only readable original; with its meta marked released, a survey that skipped sha-b would see none.
    source_meta::release(&paths, "sha-a").unwrap();
    let library = LidarLibrary::open(&root).expect("start");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(library.open_status(), LibraryOpenStatus::Unavailable { .. }),
        "{:?}",
        library.open_status()
    );
    drop(library);
    assert!(!paths.catalogue_path().exists(), "no catalogue is written");
    assert!(paths.source_original("sha-b").is_file());
}

/// An import that stopped after its original was renamed in and before it settled leaves the original listed in its
/// job root: the next start frees it through the job's settlement, not the prune (which no longer deletes an
/// unreleased original).
#[test]
fn canopi_uidt_a_crashed_import_frees_the_original_it_created_at_the_next_start() {
    let (root, paths) = seeded("uidt-crashed-import", Vec::new());
    drop(catalogue::open(&paths.catalogue_path()).unwrap());
    seed_original(&paths, "sha-created", None);
    std::fs::create_dir_all(paths.job_dir("imp-crashed")).unwrap();
    std::fs::write(
        paths.job_dir("imp-crashed").join("created-originals"),
        "sha-created\n",
    )
    .unwrap();

    let library = LidarLibrary::open(&root).unwrap();

    assert_eq!(*library.open_status(), LibraryOpenStatus::Ready);
    drop(library);
    assert!(
        !paths.source_dir("sha-created").exists(),
        "the created original goes"
    );
    assert!(!paths.job_dir("imp-crashed").exists(), "its job root goes");
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

/// A staging folder an earlier start could not remove goes at the next start that finds a current catalogue.
#[test]
fn canopi_uidt_a_staging_folder_beside_a_current_catalogue_goes_at_the_next_start() {
    let (root, paths) = seeded("uidt-staging-current", Vec::new());
    drop(catalogue::open(&paths.catalogue_path()).unwrap());
    let staging = paths.root().join(REBUILD_STAGING_DIR);
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("0.sqlite"), b"left behind").unwrap();

    drop(LidarLibrary::open(&root).unwrap());

    assert!(
        staging_left(&paths).is_empty(),
        "{:?}",
        staging_left(&paths)
    );
}
