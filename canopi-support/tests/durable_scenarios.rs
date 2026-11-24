//! Targeted OS and `FaultFs` data-safety scenarios for `canopi-support`:
//! read-only (`0o555`) permission preservation, stale sidecar sweeping,
//! two-step FAT32/exFAT no-clobber fallback crash/error recovery, threaded
//! case-variant CAS serialization, `sync_dir` known exception, and empty-dir
//! case-sensitivity probing (ADR 0023, ADR 0028, 2.1-M541, canopi-f47t.52.72).

use std::io;
use std::path::Path;
use std::sync::Barrier;

use canopi_support::durable::{
    DurableError, DurableFs, NoclobberSupport, OsDurableFs, Precondition, PublishOptions,
    PublishSource, RenameRetryPolicy, TargetLocks, detect_case_insensitive_volume,
    move_aside_durably, probe_noclobber_support, publish_durably, publish_durably_with_options,
    write_private_new,
};
use canopi_support::fault_fs::{CrashMode, FaultAction, FaultFs, FaultOp};
use canopi_support::hash::sha256_hex;

const CASE_VARIANTS: [&str; 3] = ["Garden.canopi", "garden.canopi", "GARDEN.CANOPI"];

#[test]
fn case_folded_target_locks_collapse_case_variants() {
    let locks = TargetLocks::with_case_folding(true);
    let a = locks.lock_key(Path::new("/tmp/Garden.canopi"));
    let b = locks.lock_key(Path::new("/tmp/garden.canopi"));
    let c = locks.lock_key(Path::new("/tmp/GARDEN.CANOPI"));
    assert_eq!(a, b);
    assert_eq!(b, c);
}

#[test]
fn os_durable_fs_noclobber_race_admits_exactly_one_writer() {
    let Ok(dir) = tempfile::tempdir() else {
        return;
    };
    let target = dir.path().join("report.zip");
    let locks = TargetLocks::new();
    let barrier = Barrier::new(4);
    #[expect(
        clippy::disallowed_methods,
        reason = "multi-threaded race test drives concurrent publishes"
    )]
    let winners: usize = std::thread::scope(|scope| {
        let handles: Vec<_> = (0u8..4)
            .map(|id| {
                let target_ref = &target;
                let locks_ref = &locks;
                let barrier_ref = &barrier;
                scope.spawn(move || {
                    let payload = vec![id + 1; 128];
                    barrier_ref.wait();
                    publish_durably(
                        &OsDurableFs,
                        locks_ref,
                        PublishSource::Bytes(&payload),
                        target_ref,
                        "nc",
                        Precondition::NotExists,
                    )
                    .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|&won| won)
            .count()
    });
    assert_eq!(winners, 1, "exactly one no-clobber writer must win");
    let bytes = std::fs::read(&target).ok();
    assert!(
        bytes
            .as_ref()
            .is_some_and(|b| b.len() == 128 && b.iter().all(|x| *x == b[0]))
    );
}

#[test]
fn os_durable_fs_cas_race_admits_exactly_one_writer() {
    let Ok(dir) = tempfile::tempdir() else {
        return;
    };
    let target = dir.path().join("design.canopi");
    let locks = TargetLocks::new();
    let initial = b"{\"version\":9}";
    let init_fp = sha256_hex(initial);
    let seeded = publish_durably(
        &OsDurableFs,
        &locks,
        PublishSource::Bytes(initial),
        &target,
        "init",
        Precondition::Any,
    );
    assert!(seeded.is_ok());

    let barrier = Barrier::new(4);
    #[expect(
        clippy::disallowed_methods,
        reason = "multi-threaded race test drives concurrent publishes"
    )]
    let (ok_count, conflict_count, unexpected_count) = std::thread::scope(|scope| {
        let handles: Vec<_> = (0u8..4)
            .map(|id| {
                let target_ref = &target;
                let locks_ref = &locks;
                let barrier_ref = &barrier;
                let fp = init_fp.clone();
                scope.spawn(move || {
                    let payload = format!("{{\"winner\":{id}}}");
                    barrier_ref.wait();
                    publish_durably(
                        &OsDurableFs,
                        locks_ref,
                        PublishSource::Bytes(payload.as_bytes()),
                        target_ref,
                        "cas",
                        Precondition::MatchesFingerprint(fp),
                    )
                })
            })
            .collect();
        let mut ok = 0usize;
        let mut conflict = 0usize;
        let mut unexpected = 0usize;
        for handle in handles {
            match handle.join() {
                Ok(Ok(_)) => ok += 1,
                Ok(Err(DurableError::Conflict { .. })) => conflict += 1,
                _ => unexpected += 1,
            }
        }
        (ok, conflict, unexpected)
    });
    assert_eq!(unexpected_count, 0);
    assert_eq!(ok_count, 1);
    assert_eq!(conflict_count, 3);
}

#[test]
fn os_durable_fs_probe_noclobber_and_private_write_work() {
    let Ok(dir) = tempfile::tempdir() else {
        return;
    };
    let support = probe_noclobber_support(dir.path()).ok();
    assert!(matches!(
        support,
        Some(NoclobberSupport::Supported | NoclobberSupport::FallbackVerifiedCopy)
    ));

    let locks = TargetLocks::new();
    let private_file = dir.path().join("pkg.deb");
    let first = write_private_new(&OsDurableFs, &locks, &private_file, b"secret-pkg");
    assert!(first.is_ok());
    let second = write_private_new(&OsDurableFs, &locks, &private_file, b"overwrite");
    assert!(matches!(second, Err(DurableError::AlreadyExists)));
    assert_eq!(
        std::fs::read(&private_file).ok().as_deref(),
        Some(b"secret-pkg".as_slice())
    );
}

#[test]
fn fault_fs_move_aside_rolls_back_on_companion_failure() {
    let fs = FaultFs::new();
    let locks = TargetLocks::new();
    let dir = Path::new("/data");
    fs.seed_dir(dir);
    let main_db = dir.join("user.db");
    let wal = dir.join("user.db-wal");
    fs.seed_durable_file(&main_db, b"main");
    fs.seed_durable_file(&wal, b"wal");

    let aside_base = dir.join("user.db.corrupt-1");
    fs.seed_dir(&dir.join("user.db.corrupt-1-wal"));
    let result = move_aside_durably(
        &fs,
        &locks,
        &main_db,
        std::iter::once(aside_base),
        &["-wal"],
    );
    assert!(matches!(result, Err(ref e) if e.kind() == io::ErrorKind::AlreadyExists));
    assert_eq!(
        fs.read_bytes(&main_db).ok().as_deref(),
        Some(b"main".as_slice())
    );
    assert_eq!(fs.read_bytes(&wal).ok().as_deref(), Some(b"wal".as_slice()));
}

#[cfg(unix)]
#[test]
fn os_durable_fs_updates_read_only_0555_target_preserving_permissions() {
    use std::os::unix::fs::PermissionsExt as _;

    let Ok(dir) = tempfile::tempdir() else {
        return;
    };
    let target = dir.path().join("Canopi.AppImage");
    assert!(std::fs::write(&target, b"\x7fELF-old").is_ok());
    assert!(std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o555)).is_ok());

    let locks = TargetLocks::new();
    let options = PublishOptions {
        unix_mode: Some(0o600),
        preserve_target_permissions: true,
        sweep_stale_sidecars: true,
        retry_policy: RenameRetryPolicy::immediate(2),
    };
    let outcome = publish_durably_with_options(
        &OsDurableFs,
        &locks,
        PublishSource::Bytes(b"\x7fELF-new"),
        &target,
        "update",
        Precondition::Any,
        &options,
    );
    assert!(outcome.is_ok(), "updating 0o555 target failed: {outcome:?}");
    assert_eq!(
        std::fs::read(&target).ok().as_deref(),
        Some(b"\x7fELF-new".as_slice())
    );
    let mode = std::fs::metadata(&target)
        .ok()
        .map(|meta| meta.permissions().mode() & 0o777);
    assert_eq!(mode, Some(0o555));
}

#[test]
fn os_durable_fs_sweeps_stale_role_sidecars_before_staging() {
    let Ok(dir) = tempfile::tempdir() else {
        return;
    };
    let target = dir.path().join("Canopi.AppImage");
    let stale_update = dir.path().join(".canopi-deadbeef-0.update");
    let other_role = dir.path().join(".canopi-deadbeef-1.design");
    let unrelated = dir.path().join("keep.txt");
    assert!(std::fs::write(&target, b"old").is_ok());
    assert!(std::fs::write(&stale_update, b"half-written-update").is_ok());
    assert!(std::fs::write(&other_role, b"other-role").is_ok());
    assert!(std::fs::write(&unrelated, b"keep").is_ok());

    let locks = TargetLocks::new();
    let options = PublishOptions {
        unix_mode: Some(0o600),
        preserve_target_permissions: false,
        sweep_stale_sidecars: true,
        retry_policy: RenameRetryPolicy::immediate(2),
    };
    let outcome = publish_durably_with_options(
        &OsDurableFs,
        &locks,
        PublishSource::Bytes(b"new"),
        &target,
        "update",
        Precondition::Any,
        &options,
    );
    assert!(outcome.is_ok(), "publish with sweep failed: {outcome:?}");
    assert!(
        !stale_update.exists(),
        "stale .update sidecar must be swept"
    );
    assert!(other_role.exists(), "other role sidecar must not be swept");
    assert!(unrelated.exists(), "unrelated files must not be touched");
}

#[test]
fn fault_fs_noclobber_fallback_crash_between_claim_and_replace_leaves_no_partial_target() {
    for mode in [
        CrashMode::DropUnsynced,
        CrashMode::ZeroUnsynced,
        CrashMode::TruncateUnsynced,
    ] {
        let fs = FaultFs::new();
        let locks = TargetLocks::new();
        let dir = Path::new("/fat32");
        fs.seed_dir(dir);
        let target = dir.join("export.canopi");

        fs.inject(FaultOp::PersistNoclobber, FaultAction::NoclobberFallback);
        fs.inject(
            FaultOp::NoclobberFallbackReplace,
            FaultAction::CrashBefore(mode),
        );
        let outcome = publish_durably(
            &fs,
            &locks,
            PublishSource::Bytes(b"payload-bytes"),
            &target,
            "export",
            Precondition::NotExists,
        );
        assert!(outcome.is_err());
        assert_eq!(
            fs.durable_bytes(&target),
            None,
            "crash between placeholder claim and rename must leave no partial file ({mode:?})"
        );
    }
}

#[test]
fn fault_fs_noclobber_fallback_io_error_removes_placeholder_and_never_clobbers_existing() {
    let fs = FaultFs::new();
    let locks = TargetLocks::new();
    let dir = Path::new("/fat32");
    fs.seed_dir(dir);
    let target = dir.join("report.zip");

    fs.inject(FaultOp::PersistNoclobber, FaultAction::NoclobberFallback);
    fs.inject(
        FaultOp::NoclobberFallbackReplace,
        FaultAction::IoError(io::ErrorKind::StorageFull),
    );
    let first = publish_durably(
        &fs,
        &locks,
        PublishSource::Bytes(b"zip-v1"),
        &target,
        "report",
        Precondition::NotExists,
    );
    assert!(matches!(
        first,
        Err(DurableError::Io(ref err)) if err.kind() == io::ErrorKind::StorageFull
    ));
    assert!(
        fs.read_bytes(&target).is_err(),
        "placeholder must be removed on fallback replace failure"
    );

    fs.inject(FaultOp::PersistNoclobber, FaultAction::NoclobberFallback);
    let second = publish_durably(
        &fs,
        &locks,
        PublishSource::Bytes(b"zip-v2"),
        &target,
        "report",
        Precondition::NotExists,
    );
    assert!(second.is_ok());
    assert_eq!(
        fs.durable_bytes(&target).as_deref(),
        Some(b"zip-v2".as_slice())
    );

    fs.inject(FaultOp::PersistNoclobber, FaultAction::NoclobberFallback);
    let third = publish_durably(
        &fs,
        &locks,
        PublishSource::Bytes(b"zip-v3"),
        &target,
        "report",
        Precondition::NotExists,
    );
    assert!(matches!(third, Err(DurableError::AlreadyExists)));
    assert_eq!(
        fs.durable_bytes(&target).as_deref(),
        Some(b"zip-v2".as_slice())
    );
}

#[test]
fn fault_fs_threaded_case_variant_cas_serializes_under_case_folded_lock() {
    let fs = FaultFs::case_insensitive();
    let locks = TargetLocks::with_case_folding(true);
    let dir = Path::new("/vault");
    fs.seed_dir(dir);

    let seed = b"round-0-seed";
    assert!(
        publish_durably(
            &fs,
            &locks,
            PublishSource::Bytes(seed),
            &dir.join(CASE_VARIANTS[0]),
            "init",
            Precondition::Any,
        )
        .is_ok()
    );

    let mut expected_payload = seed.to_vec();
    for round in 1u8..=6 {
        let current_fp = sha256_hex(&expected_payload);
        let barrier = Barrier::new(4);
        #[expect(
            clippy::disallowed_methods,
            reason = "multi-threaded race test drives concurrent case-variant publishes"
        )]
        let (winners, conflicts, unexpected) = std::thread::scope(|scope| {
            let handles: Vec<_> = (0usize..4)
                .map(|id| {
                    let fs_ref = &fs;
                    let locks_ref = &locks;
                    let barrier_ref = &barrier;
                    let fp = current_fp.clone();
                    let target = dir.join(CASE_VARIANTS[id % CASE_VARIANTS.len()]);
                    scope.spawn(move || {
                        let payload = format!("round-{round}-writer-{id}").into_bytes();
                        barrier_ref.wait();
                        let res = publish_durably(
                            fs_ref,
                            locks_ref,
                            PublishSource::Bytes(&payload),
                            &target,
                            "cas",
                            Precondition::MatchesFingerprint(fp),
                        );
                        (res, payload)
                    })
                })
                .collect();
            let mut win_payloads = Vec::new();
            let mut conflict = 0usize;
            let mut other = 0usize;
            for handle in handles {
                match handle.join() {
                    Ok((Ok(_), payload)) => win_payloads.push(payload),
                    Ok((Err(DurableError::Conflict { .. }), _)) => conflict += 1,
                    _ => other += 1,
                }
            }
            (win_payloads, conflict, other)
        });
        assert_eq!(unexpected, 0);
        assert_eq!(
            winners.len(),
            1,
            "exactly one case-variant CAS winner per round"
        );
        assert_eq!(conflicts, 3);
        expected_payload = winners[0].clone();
        fs.crash(CrashMode::DropUnsynced);
        assert_eq!(
            fs.durable_bytes(&dir.join(CASE_VARIANTS[0])).as_deref(),
            Some(expected_payload.as_slice())
        );
    }
}

#[test]
fn sync_dir_failure_is_logged_and_swallowed_known_exception() {
    let fs = FaultFs::new();
    let locks = TargetLocks::new();
    let dir = Path::new("/vault");
    fs.seed_dir(dir);
    let target = dir.join("design.canopi");

    assert!(
        publish_durably(
            &fs,
            &locks,
            PublishSource::Bytes(b"v1"),
            &target,
            "save",
            Precondition::Any,
        )
        .is_ok()
    );
    fs.inject(FaultOp::SyncDir, FaultAction::IoError(io::ErrorKind::Other));
    let outcome = publish_durably(
        &fs,
        &locks,
        PublishSource::Bytes(b"v2"),
        &target,
        "save",
        Precondition::Any,
    );
    assert!(outcome.is_ok());
    assert_eq!(
        fs.read_bytes(&target).ok().as_deref(),
        Some(b"v2".as_slice())
    );
    fs.crash(CrashMode::DropUnsynced);
    assert_eq!(fs.durable_bytes(&target).as_deref(), Some(b"v1".as_slice()));
}

#[test]
fn case_sensitivity_detection_probes_empty_dir_and_defaults_to_folding_when_unwritable() {
    if let Ok(empty_dir) = tempfile::tempdir() {
        let _detected = detect_case_insensitive_volume(empty_dir.path());
        let leftovers: Vec<_> = std::fs::read_dir(empty_dir.path())
            .into_iter()
            .flatten()
            .flatten()
            .collect();
        assert!(
            leftovers.is_empty(),
            "case-sensitivity probe must remove its probe file: {leftovers:?}"
        );
    }

    let missing = Path::new("/nonexistent-canopi-case-probe-dir-999999");
    assert!(detect_case_insensitive_volume(missing));

    let folding = TargetLocks::with_volume_probe(|_| true);
    assert_eq!(
        folding.lock_key(Path::new("/tmp/Garden.canopi")),
        folding.lock_key(Path::new("/tmp/garden.canopi"))
    );
    let sensitive = TargetLocks::with_volume_probe(|_| false);
    assert_ne!(
        sensitive.lock_key(Path::new("/tmp/Garden.canopi")),
        sensitive.lock_key(Path::new("/tmp/garden.canopi"))
    );
}
