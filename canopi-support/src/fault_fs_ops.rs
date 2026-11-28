//! Crash recovery, fault mapping, and FAT32/exFAT no-clobber fallback helpers
//! for [`crate::fault_fs::FaultFs`].

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::durable::DurableError;
use crate::fault_fs::{CrashMode, FaultAction, FaultFs, FaultOp, FsState, Inode};
use crate::hash;

pub(crate) fn apply_io_fault(state: &mut FsState, action: FaultAction) -> io::Error {
    match action {
        FaultAction::IoError(kind) => io::Error::new(kind, "injected fault"),
        FaultAction::TargetBusy => io::Error::new(io::ErrorKind::ResourceBusy, "target busy"),
        FaultAction::AlreadyExists => {
            io::Error::new(io::ErrorKind::AlreadyExists, "already exists")
        }
        FaultAction::NoclobberFallback => {
            io::Error::new(io::ErrorKind::Unsupported, "noclobber unsupported")
        }
        FaultAction::CrashBefore(mode) | FaultAction::CrashAfter(mode) => {
            apply_crash(state, mode);
            io::Error::new(io::ErrorKind::Interrupted, "simulated crash")
        }
    }
}

pub(crate) fn apply_crash(state: &mut FsState, mode: CrashMode) {
    let mut recovered = BTreeMap::new();
    for (path, inode) in &state.durable {
        match inode {
            Inode::Dir => {
                recovered.insert(path.clone(), Inode::Dir);
            }
            Inode::File {
                volatile,
                durable,
                synced,
            } => {
                let bytes = if *synced {
                    durable.clone().unwrap_or_else(|| volatile.clone())
                } else {
                    match mode {
                        CrashMode::DropUnsynced => match durable {
                            Some(prev) => prev.clone(),
                            None => continue,
                        },
                        CrashMode::ZeroUnsynced => vec![0u8; volatile.len()],
                        CrashMode::TruncateUnsynced => volatile[..volatile.len() / 2].to_vec(),
                    }
                };
                recovered.insert(
                    path.clone(),
                    Inode::File {
                        volatile: bytes.clone(),
                        durable: Some(bytes),
                        synced: true,
                    },
                );
            }
        }
    }
    state.durable = recovered.clone();
    state.volatile = recovered;
}

pub(crate) fn normalize_key(path: &Path, case_insensitive: bool) -> PathBuf {
    if case_insensitive {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

pub(crate) fn persist_noclobber_fallback(
    state: &mut FsState,
    src_key: &Path,
    dest_key: &Path,
    expected_fingerprint: Option<&str>,
) -> Result<(), DurableError> {
    // 1. Claim `dest` exclusively with an empty unsynced placeholder.
    state.volatile.insert(
        dest_key.to_path_buf(),
        Inode::File {
            volatile: Vec::new(),
            durable: None,
            synced: false,
        },
    );
    // 2. Replace the placeholder with the synced staged file, with an
    //    injectable fault/crash point between claim and replace.
    let replace_fault = FaultFs::take_fault(state, FaultOp::NoclobberFallbackReplace);
    if let Some(action) = replace_fault
        && !matches!(action, FaultAction::CrashAfter(_))
    {
        if matches!(action, FaultAction::CrashBefore(_)) {
            return Err(DurableError::Io(apply_io_fault(state, action)));
        }
        state.volatile.remove(dest_key);
        return Err(DurableError::Io(apply_io_fault(state, action)));
    }
    let inode = state.volatile.remove(src_key).ok_or_else(|| {
        state.volatile.remove(dest_key);
        DurableError::Io(io::Error::new(io::ErrorKind::NotFound, "missing"))
    })?;
    if let Some(expected) = expected_fingerprint
        && let Inode::File { ref volatile, .. } = inode
        && hash::sha256_hex(volatile) != expected
    {
        state.volatile.remove(dest_key);
        return Err(DurableError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "fingerprint verification failed",
        )));
    }
    state.volatile.insert(dest_key.to_path_buf(), inode);
    if let Some(FaultAction::CrashAfter(mode)) = replace_fault {
        apply_crash(state, mode);
        return Err(DurableError::Io(io::Error::new(
            io::ErrorKind::Interrupted,
            "simulated crash",
        )));
    }
    Ok(())
}
