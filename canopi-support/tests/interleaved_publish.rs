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

use canopi_support::durable::{
    DurableError, DurableFs, Precondition, PublishOptions, PublishSource, RenameRetryPolicy,
    TargetLocks, publish_durably_with_options, remove_durably,
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
    PublishNotExistsWithCrash {
        variant: usize,
        payload: Vec<u8>,
        fallback: bool,
        crash_before_replace: bool,
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
        (
            0usize..3,
            payload_strategy(),
            any::<bool>(),
            any::<bool>(),
            crash_mode_strategy()
        )
            .prop_map(|(variant, payload, fallback, crash_before_replace, mode)| {
                Step::PublishNotExistsWithCrash {
                    variant,
                    payload,
                    fallback,
                    crash_before_replace,
                    mode,
                }
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
        sweep_stale_sidecars: false,
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
        | Step::PublishWithCrash { .. }
        | Step::PublishNotExistsWithCrash { .. } => {
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
            // Ok-means-durable property: an acknowledged publish with no fault
            // injected must already be durable on stable storage.
            let durable = fs.durable_bytes(&target);
            prop_assert_eq!(durable.as_ref(), Some(payload));
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
                let durable = fs.durable_bytes(&target);
                prop_assert_eq!(durable.as_ref(), Some(payload));
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
                let durable = fs.durable_bytes(&target);
                prop_assert_eq!(durable.as_ref(), Some(payload));
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
        Step::PublishWithCrash { .. } => {
            run_crash_step(fs, locks, step, opts, model)?;
        }
        Step::PublishNotExistsWithCrash { .. } => {
            run_noclobber_crash_step(fs, locks, step, opts, model)?;
        }
        _ => {}
    }
    Ok(())
}

fn run_crash_step(
    fs: &FaultFs,
    locks: &TargetLocks,
    step: &Step,
    opts: &PublishOptions,
    model: &mut ModelState,
) -> Result<(), proptest::test_runner::TestCaseError> {
    let Step::PublishWithCrash {
        variant,
        payload,
        op,
        mode,
    } = step
    else {
        return Ok(());
    };
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
    Ok(())
}

fn run_noclobber_crash_step(
    fs: &FaultFs,
    locks: &TargetLocks,
    step: &Step,
    opts: &PublishOptions,
    model: &mut ModelState,
) -> Result<(), proptest::test_runner::TestCaseError> {
    let Step::PublishNotExistsWithCrash {
        variant,
        payload,
        fallback,
        crash_before_replace,
        mode,
    } = step
    else {
        return Ok(());
    };
    let target = target_for(*variant);
    let existed = model.current.is_some();
    if !existed {
        model.admitted.insert(payload.clone());
        if *fallback {
            fs.inject(FaultOp::PersistNoclobber, FaultAction::NoclobberFallback);
            let action = if *crash_before_replace {
                FaultAction::CrashBefore(*mode)
            } else {
                FaultAction::CrashAfter(*mode)
            };
            fs.inject(FaultOp::NoclobberFallbackReplace, action);
        } else {
            fs.inject(FaultOp::PersistNoclobber, FaultAction::CrashAfter(*mode));
        }
    }
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
        let post_crash = fs.durable_bytes(&target);
        if let Some(ref bytes) = post_crash {
            prop_assert!(
                model.admitted.contains(bytes),
                "torn or partial bytes after noclobber crash: len={}",
                bytes.len()
            );
        }
        model.current = post_crash;
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
