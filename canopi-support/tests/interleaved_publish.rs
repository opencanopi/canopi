//! Interleaved-publish property test and ALICE/lazyfs crash-consistency suite
//! (ADR 0023, ADR 0028, 2.1-M541, canopi-f47t.52.72).
//!
//! Runs on both Linux and Windows CI (`platform-tests`), verifying:
//! 1. No torn/half-written targets after power loss (`DropUnsynced`,
//!    `ZeroUnsynced`, `TruncateUnsynced`) at any step of `publish_durably`.
//! 2. No-clobber (`Precondition::NotExists` via `tempfile::persist_noclobber`
//!    and FAT32/exFAT verified-copy fallback) never overwrites an existing file.
//! 3. Fingerprint CAS (`Precondition::MatchesFingerprint`) rejects stale writes
//!    with `DurableError::Conflict` and leaves the newer bytes untouched.
//! 4. Case-variant paths (`Garden.canopi` vs `garden.canopi`) serialize under
//!    one `TargetLocks` entry on case-insensitive volumes.
//! 5. Windows-style busy/sharing-violation renames retry up to budget and settle
//!    as typed `DurableError::TargetBusy` with the original target intact.
//! 6. Real `OsDurableFs` multi-threaded CAS and no-clobber races + FAT32/exFAT
//!    probe (`probe_noclobber_support`).

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Barrier;

use canopi_support::durable::{
    DurableError, DurableFs, NoclobberSupport, OsDurableFs, Precondition, PublishOptions,
    PublishSource, RenameRetryPolicy, TargetLocks, move_aside_durably, probe_noclobber_support,
    publish_durably, publish_durably_with_options, remove_durably, write_private_new,
};
use canopi_support::fault_fs::{CrashMode, FaultAction, FaultFs, FaultOp};
use canopi_support::hash::sha256_hex;
use proptest::prelude::{Just, Strategy, any, prop_assert, prop_assert_eq, prop_oneof, proptest};
use proptest::test_runner::{Config as ProptestConfig, RngSeed};

#[derive(Debug, Clone)]
enum Step {
    PublishAny {
        variant: usize,
        payload: Vec<u8>,
    },
    PublishNotExists {
        variant: usize,
        payload: Vec<u8>,
    },
    PublishCasCurrent {
        variant: usize,
        payload: Vec<u8>,
    },
    PublishCasStale {
        variant: usize,
        payload: Vec<u8>,
    },
    PublishWithTransientBusy {
        variant: usize,
        payload: Vec<u8>,
        busy_count: u32,
    },
    PublishWithExhaustedBusy {
        variant: usize,
        payload: Vec<u8>,
    },
    PublishWithDiskFull {
        variant: usize,
        payload: Vec<u8>,
    },
    PublishWithCrash {
        variant: usize,
        payload: Vec<u8>,
        op: FaultOp,
        mode: CrashMode,
    },
    RemoveAny {
        variant: usize,
    },
}

const CASE_VARIANTS: [&str; 3] = ["Garden.canopi", "garden.canopi", "GARDEN.CANOPI"];

struct ModelState {
    admitted: BTreeSet<Vec<u8>>,
    current: Option<Vec<u8>>,
}

fn crash_mode_strategy() -> impl Strategy<Value = CrashMode> {
    prop_oneof![
        Just(CrashMode::DropUnsynced),
        Just(CrashMode::ZeroUnsynced),
        Just(CrashMode::TruncateUnsynced),
    ]
}

fn crash_op_strategy() -> impl Strategy<Value = FaultOp> {
    prop_oneof![
        Just(FaultOp::StageBytes),
        Just(FaultOp::SyncFile),
        Just(FaultOp::RenameReplace),
        Just(FaultOp::SyncDir),
    ]
}

fn payload_strategy() -> impl Strategy<Value = Vec<u8>> {
    proptest::collection::vec(any::<u8>(), 1..64)
}

fn step_strategy() -> impl Strategy<Value = Step> {
    prop_oneof![
        (0usize..3, payload_strategy())
            .prop_map(|(variant, payload)| Step::PublishAny { variant, payload }),
        (0usize..3, payload_strategy())
            .prop_map(|(variant, payload)| Step::PublishNotExists { variant, payload }),
        (0usize..3, payload_strategy())
            .prop_map(|(variant, payload)| Step::PublishCasCurrent { variant, payload }),
        (0usize..3, payload_strategy())
            .prop_map(|(variant, payload)| Step::PublishCasStale { variant, payload }),
        (0usize..3, payload_strategy(), 1u32..=3).prop_map(|(variant, payload, busy_count)| {
            Step::PublishWithTransientBusy {
                variant,
                payload,
                busy_count,
            }
        }),
        (0usize..3, payload_strategy())
            .prop_map(|(variant, payload)| Step::PublishWithExhaustedBusy { variant, payload }),
        (0usize..3, payload_strategy())
            .prop_map(|(variant, payload)| Step::PublishWithDiskFull { variant, payload }),
        (
            0usize..3,
            payload_strategy(),
            crash_op_strategy(),
            crash_mode_strategy()
        )
            .prop_map(|(variant, payload, op, mode)| Step::PublishWithCrash {
                variant,
                payload,
                op,
                mode,
            }),
        (0usize..3).prop_map(|variant| Step::RemoveAny { variant }),
    ]
}

fn target_for(variant: usize) -> PathBuf {
    Path::new("/vault").join(CASE_VARIANTS[variant % CASE_VARIANTS.len()])
}

fn fast_options() -> PublishOptions {
    PublishOptions {
        unix_mode: None,
        preserve_target_permissions: false,
        retry_policy: RenameRetryPolicy::immediate(3),
    }
}

fn assert_no_temp_sidecars(
    fs: &FaultFs,
    dir: &Path,
) -> Result<(), proptest::test_runner::TestCaseError> {
    let stray: Vec<PathBuf> = fs
        .volatile_files_in(dir)
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(".canopi-"))
        })
        .collect();
    prop_assert!(stray.is_empty(), "leaked sidecars: {stray:?}");
    Ok(())
}

fn run_step(
    fs: &FaultFs,
    locks: &TargetLocks,
    step: &Step,
    model: &mut ModelState,
) -> Result<(), proptest::test_runner::TestCaseError> {
    let dir = Path::new("/vault");
    let opts = fast_options();
    match step {
        Step::PublishAny { .. }
        | Step::PublishNotExists { .. }
        | Step::PublishCasCurrent { .. }
        | Step::PublishCasStale { .. } => {
            run_basic_publish_step(fs, locks, step, &opts, model)?;
            assert_no_temp_sidecars(fs, dir)?;
        }
        Step::PublishWithTransientBusy { .. }
        | Step::PublishWithExhaustedBusy { .. }
        | Step::PublishWithDiskFull { .. }
        | Step::PublishWithCrash { .. } => {
            run_fault_publish_step(fs, locks, step, &opts, model)?;
        }
        Step::RemoveAny { variant } => {
            let target = target_for(*variant);
            let outcome = remove_durably(fs, locks, &target, Precondition::Any);
            prop_assert!(outcome.is_ok(), "RemoveAny failed: {outcome:?}");
            model.current = None;
        }
    }
    let live = fs.read_bytes(&target_for(0)).ok();
    prop_assert_eq!(live.as_ref(), model.current.as_ref());
    Ok(())
}

fn run_basic_publish_step(
    fs: &FaultFs,
    locks: &TargetLocks,
    step: &Step,
    opts: &PublishOptions,
    model: &mut ModelState,
) -> Result<(), proptest::test_runner::TestCaseError> {
    match step {
        Step::PublishAny { variant, payload } => {
            let target = target_for(*variant);
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::Any,
                opts,
            );
            prop_assert!(outcome.is_ok(), "PublishAny failed: {outcome:?}");
            model.admitted.insert(payload.clone());
            model.current = Some(payload.clone());
        }
        Step::PublishNotExists { variant, payload } => {
            let target = target_for(*variant);
            let existed = model.current.is_some();
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::NotExists,
                opts,
            );
            if existed {
                prop_assert!(matches!(outcome, Err(DurableError::AlreadyExists)));
            } else {
                prop_assert!(outcome.is_ok(), "PublishNotExists failed: {outcome:?}");
                model.admitted.insert(payload.clone());
                model.current = Some(payload.clone());
            }
        }
        Step::PublishCasCurrent { variant, payload } => {
            let target = target_for(*variant);
            let expected = model
                .current
                .as_deref()
                .map_or_else(|| "missing".to_owned(), sha256_hex);
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::MatchesFingerprint(expected),
                opts,
            );
            if model.current.is_some() {
                prop_assert!(outcome.is_ok(), "PublishCasCurrent failed: {outcome:?}");
                model.admitted.insert(payload.clone());
                model.current = Some(payload.clone());
            } else {
                prop_assert!(
                    matches!(outcome, Err(DurableError::Conflict { .. })),
                    "expected Conflict, got {outcome:?}"
                );
            }
        }
        Step::PublishCasStale { variant, payload } => {
            let target = target_for(*variant);
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::MatchesFingerprint("0000stale".to_owned()),
                opts,
            );
            prop_assert!(
                matches!(outcome, Err(DurableError::Conflict { .. })),
                "expected Conflict, got {outcome:?}"
            );
        }
        _ => {}
    }
    Ok(())
}

fn run_fault_publish_step(
    fs: &FaultFs,
    locks: &TargetLocks,
    step: &Step,
    opts: &PublishOptions,
    model: &mut ModelState,
) -> Result<(), proptest::test_runner::TestCaseError> {
    let dir = Path::new("/vault");
    match step {
        Step::PublishWithTransientBusy {
            variant,
            payload,
            busy_count,
        } => {
            let target = target_for(*variant);
            for _ in 0..*busy_count {
                fs.inject(FaultOp::RenameReplace, FaultAction::TargetBusy);
            }
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::Any,
                opts,
            );
            prop_assert!(
                outcome.is_ok(),
                "transient busy should succeed: {outcome:?}"
            );
            model.admitted.insert(payload.clone());
            model.current = Some(payload.clone());
            assert_no_temp_sidecars(fs, dir)?;
        }
        Step::PublishWithExhaustedBusy { variant, payload } => {
            let target = target_for(*variant);
            for _ in 0..=opts.retry_policy.max_retries {
                fs.inject(FaultOp::RenameReplace, FaultAction::TargetBusy);
            }
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::Any,
                opts,
            );
            prop_assert!(
                matches!(outcome, Err(DurableError::TargetBusy { .. })),
                "expected TargetBusy, got {outcome:?}"
            );
            assert_no_temp_sidecars(fs, dir)?;
        }
        Step::PublishWithDiskFull { variant, payload } => {
            let target = target_for(*variant);
            fs.inject(
                FaultOp::StageBytes,
                FaultAction::IoError(io::ErrorKind::StorageFull),
            );
            let outcome = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::Any,
                opts,
            );
            prop_assert!(
                matches!(outcome, Err(DurableError::Io(ref e)) if e.kind() == io::ErrorKind::StorageFull)
            );
            assert_no_temp_sidecars(fs, dir)?;
        }
        Step::PublishWithCrash {
            variant,
            payload,
            op,
            mode,
        } => {
            let target = target_for(*variant);
            model.admitted.insert(payload.clone());
            fs.inject(*op, FaultAction::CrashAfter(*mode));
            let _ = publish_durably_with_options(
                fs,
                locks,
                PublishSource::Bytes(payload),
                &target,
                "tmp",
                Precondition::Any,
                opts,
            );
            let post_crash = fs.durable_bytes(&target);
            if let Some(ref bytes) = post_crash {
                prop_assert!(
                    model.admitted.contains(bytes),
                    "torn or unknown bytes after crash ({op:?}, {mode:?}): len={}",
                    bytes.len()
                );
            }
            model.current = post_crash;
        }
        _ => {}
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 64,
        rng_seed: RngSeed::Fixed(0x2B01_5272_CAFE_BEEF),
        ..ProptestConfig::default()
    })]

    #[test]
    fn canopi_f47t_52_72_interleaved_publish_and_crash_recovery_never_tears_target(
        steps in proptest::collection::vec(step_strategy(), 1..25)
    ) {
        let fs = FaultFs::case_insensitive();
        let locks = TargetLocks::with_case_folding(true);
        fs.seed_dir(Path::new("/vault"));
        let mut model = ModelState {
            admitted: BTreeSet::new(),
            current: None,
        };
        for step in &steps {
            run_step(&fs, &locks, step, &mut model)?;
        }
    }
}

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
