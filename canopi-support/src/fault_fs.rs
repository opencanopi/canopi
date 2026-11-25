//! ALICE/lazyfs-style crash-consistent [`FaultFs`] implementing [`DurableFs`]
//! (ADR 0023, ADR 0028, 2.1-M541).
//!
//! Models separate **volatile** (page cache / un-fsynced writes and directory
//! entries) and **durable** (on-disk state committed by `sync_file` / `sync_dir`)
//! layers. Calling [`FaultFs::crash`] or injecting [`FaultAction::CrashBefore`]
//! / [`FaultAction::CrashAfter`] drops or corrupts unsynced volatile state
//! according to [`CrashMode`], letting tests verify that
//! [`crate::durable::publish_durably`] never leaves a torn or half-written
//! target after a power cut at any step.
//!
//! Note: `FaultFs` is keyed by normalized path (not inode numbers). Calling
//! `sync_file` on an already-durable path updates the volatile entry's durable
//! payload; directory entries are committed to `durable` on `sync_dir`, which
//! is sufficient for modeling `publish_durably` and `remove_durably`.

use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::durable::{DurableError, DurableFs, EntryKind, PublishOptions};
use crate::fault_fs_ops::{apply_crash, apply_io_fault, normalize_key, persist_noclobber_fallback};
use crate::hash;

static NEXT_FAULT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

/// Operation hook points where [`FaultFs`] can inject a fault or crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FaultOp {
    Read,
    Fingerprint,
    StageBytes,
    SyncFile,
    RenameReplace,
    PersistNoclobber,
    /// Second step of the FAT32/exFAT no-clobber fallback (atomic rename of
    /// staged file over the empty `create_new` placeholder).
    NoclobberFallbackReplace,
    SyncDir,
    RemoveFile,
    AvailableSpace,
}

/// How unsynced volatile state behaves on a simulated power loss (ALICE/lazyfs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashMode {
    /// Unsynced writes and directory mutations are discarded; durable state wins.
    DropUnsynced,
    /// Unsynced file bytes become zero-filled (models ext4 `data=writeback` /
    /// lazyfs un-fsynced allocation without data flush).
    ZeroUnsynced,
    /// Unsynced file bytes are truncated to half their volatile length.
    TruncateUnsynced,
}

/// Fault injected on a matching [`FaultOp`] invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultAction {
    /// Fail the operation with an [`io::ErrorKind`].
    IoError(io::ErrorKind),
    /// Fail with `ResourceBusy` (models Windows sharing/lock violation).
    TargetBusy,
    /// Fail `PersistNoclobber` with `AlreadyExists`.
    AlreadyExists,
    /// Simulate FAT32/exFAT where `persist_noclobber` falls back to verified copy
    /// (succeeds if target absent, `AlreadyExists` if present).
    NoclobberFallback,
    /// Simulate an immediate crash (power loss) right before the operation
    /// completes, recovering volatile state from durable state per [`CrashMode`].
    CrashBefore(CrashMode),
    /// Perform the operation in volatile memory, then immediately crash before
    /// the next step runs.
    CrashAfter(CrashMode),
}

#[derive(Debug, Clone)]
pub(crate) enum Inode {
    File {
        volatile: Vec<u8>,
        durable: Option<Vec<u8>>,
        synced: bool,
    },
    Dir,
}

#[derive(Debug, Default)]
pub(crate) struct FsState {
    /// Normalized path -> volatile entry.
    pub(crate) volatile: BTreeMap<PathBuf, Inode>,
    /// Normalized path -> durable entry (updated on `sync_file` / `sync_dir`).
    pub(crate) durable: BTreeMap<PathBuf, Inode>,
    /// Pending faults per operation (FIFO queue).
    pub(crate) faults: BTreeMap<FaultOp, VecDeque<FaultAction>>,
    /// Simulated free disk bytes.
    pub(crate) available_bytes: u64,
    /// Read-only filesystem flag.
    pub(crate) read_only: bool,
    /// Case-insensitive path normalization flag.
    pub(crate) case_insensitive: bool,
    /// Operation call log for assertions.
    pub(crate) trace: Vec<FaultOp>,
}

/// In-memory crash-consistent filesystem fault injector implementing [`DurableFs`].
#[derive(Debug)]
pub struct FaultFs {
    state: Mutex<FsState>,
}

impl Default for FaultFs {
    fn default() -> Self {
        Self::new()
    }
}

impl FaultFs {
    /// Create a fresh writable, case-sensitive `FaultFs` with 1 GiB free space.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(FsState {
                available_bytes: 1024 * 1024 * 1024,
                ..FsState::default()
            }),
        }
    }

    /// Create a `FaultFs` configured for case-insensitive volume semantics.
    pub fn case_insensitive() -> Self {
        let fs = Self::new();
        fs.set_case_insensitive(true);
        fs
    }

    /// Toggle case-insensitive path matching.
    pub fn set_case_insensitive(&self, enabled: bool) {
        let mut state = self.lock_state();
        state.case_insensitive = enabled;
    }

    /// Set simulated available disk bytes; writes exceeding this fail with `StorageFull`.
    pub fn set_available_space(&self, bytes: u64) {
        let mut state = self.lock_state();
        state.available_bytes = bytes;
    }

    /// Toggle read-only mode (all mutating operations fail with `ReadOnlyFilesystem`).
    pub fn set_read_only(&self, read_only: bool) {
        let mut state = self.lock_state();
        state.read_only = read_only;
    }

    /// Queue a fault action to trigger on the next call to `op`.
    pub fn inject(&self, op: FaultOp, action: FaultAction) {
        let mut state = self.lock_state();
        state.faults.entry(op).or_default().push_back(action);
    }

    /// Seed a durable file directly (as if previously committed before a crash).
    pub fn seed_durable_file(&self, path: &Path, bytes: &[u8]) {
        let mut state = self.lock_state();
        let key = normalize_key(path, state.case_insensitive);
        let inode = Inode::File {
            volatile: bytes.to_vec(),
            durable: Some(bytes.to_vec()),
            synced: true,
        };
        state.volatile.insert(key.clone(), inode.clone());
        state.durable.insert(key, inode);
    }

    /// Seed a durable directory at `path`.
    pub fn seed_dir(&self, path: &Path) {
        let mut state = self.lock_state();
        let key = normalize_key(path, state.case_insensitive);
        state.volatile.insert(key.clone(), Inode::Dir);
        state.durable.insert(key, Inode::Dir);
    }

    /// Simulate a power cut right now and recover volatile state from durable
    /// state according to `mode`.
    pub fn crash(&self, mode: CrashMode) {
        let mut state = self.lock_state();
        apply_crash(&mut state, mode);
    }

    /// Read the durable (post-crash) bytes of `path`, if present as a file.
    pub fn durable_bytes(&self, path: &Path) -> Option<Vec<u8>> {
        let state = self.lock_state();
        let key = normalize_key(path, state.case_insensitive);
        match state.durable.get(&key) {
            Some(Inode::File {
                durable: Some(b), ..
            }) => Some(b.clone()),
            _ => None,
        }
    }

    /// List all volatile file paths whose parent matches `dir`.
    pub fn volatile_files_in(&self, dir: &Path) -> Vec<PathBuf> {
        let state = self.lock_state();
        let dir_key = normalize_key(dir, state.case_insensitive);
        state
            .volatile
            .keys()
            .filter(|p| p.parent() == Some(dir_key.as_path()))
            .cloned()
            .collect()
    }

    /// Snapshot of recorded [`FaultOp`] calls in order.
    pub fn trace(&self) -> Vec<FaultOp> {
        self.lock_state().trace.clone()
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, FsState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn take_fault(state: &mut FsState, op: FaultOp) -> Option<FaultAction> {
        state.trace.push(op);
        state.faults.get_mut(&op).and_then(VecDeque::pop_front)
    }
}

impl DurableFs for FaultFs {
    fn read_bytes(&self, path: &Path) -> io::Result<Vec<u8>> {
        let mut state = self.lock_state();
        if let Some(action) = Self::take_fault(&mut state, FaultOp::Read) {
            return Err(apply_io_fault(&mut state, action));
        }
        let key = normalize_key(path, state.case_insensitive);
        match state.volatile.get(&key) {
            Some(Inode::File { volatile, .. }) => Ok(volatile.clone()),
            Some(Inode::Dir) => Err(io::Error::new(
                io::ErrorKind::IsADirectory,
                "is a directory",
            )),
            None => Err(io::Error::new(io::ErrorKind::NotFound, "not found")),
        }
    }

    fn fingerprint_file(&self, path: &Path) -> io::Result<Option<String>> {
        let mut state = self.lock_state();
        if let Some(action) = Self::take_fault(&mut state, FaultOp::Fingerprint) {
            return Err(apply_io_fault(&mut state, action));
        }
        let key = normalize_key(path, state.case_insensitive);
        match state.volatile.get(&key) {
            Some(Inode::File { volatile, .. }) => Ok(Some(hash::sha256_hex(volatile))),
            Some(Inode::Dir) => Err(io::Error::new(
                io::ErrorKind::IsADirectory,
                "is a directory",
            )),
            None => Ok(None),
        }
    }

    fn entry_kind(&self, path: &Path) -> io::Result<Option<EntryKind>> {
        let state = self.lock_state();
        let key = normalize_key(path, state.case_insensitive);
        Ok(state.volatile.get(&key).map(|inode| match inode {
            Inode::File { .. } => EntryKind::File,
            Inode::Dir => EntryKind::Dir,
        }))
    }

    fn file_len(&self, path: &Path) -> io::Result<Option<u64>> {
        let state = self.lock_state();
        let key = normalize_key(path, state.case_insensitive);
        match state.volatile.get(&key) {
            Some(Inode::File { volatile, .. }) => Ok(Some(volatile.len() as u64)),
            Some(Inode::Dir) => Err(io::Error::new(
                io::ErrorKind::IsADirectory,
                "is a directory",
            )),
            None => Ok(None),
        }
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock_state();
        if state.read_only {
            return Err(io::Error::new(
                io::ErrorKind::ReadOnlyFilesystem,
                "read-only filesystem",
            ));
        }
        let key = normalize_key(path, state.case_insensitive);
        if matches!(state.volatile.get(&key), Some(Inode::File { .. })) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file exists at directory path",
            ));
        }
        state.volatile.insert(key.clone(), Inode::Dir);
        state.durable.insert(key, Inode::Dir);
        Ok(())
    }

    fn stage_bytes(
        &self,
        parent: &Path,
        role: &str,
        bytes: &[u8],
        _options: &PublishOptions,
        _preserve_from: Option<&Path>,
    ) -> io::Result<PathBuf> {
        let mut state = self.lock_state();
        if state.read_only {
            return Err(io::Error::new(
                io::ErrorKind::ReadOnlyFilesystem,
                "read-only filesystem",
            ));
        }
        let fault = Self::take_fault(&mut state, FaultOp::StageBytes);
        if let Some(action) = fault
            && !matches!(action, FaultAction::CrashAfter(_))
        {
            return Err(apply_io_fault(&mut state, action));
        }
        if (bytes.len() as u64) > state.available_bytes {
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "no space left on device",
            ));
        }
        let id = NEXT_FAULT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(".canopi-fault-{id:x}.{role}"));
        let key = normalize_key(&temp, state.case_insensitive);
        state.volatile.insert(
            key,
            Inode::File {
                volatile: bytes.to_vec(),
                durable: None,
                synced: false,
            },
        );
        if let Some(FaultAction::CrashAfter(mode)) = fault {
            apply_crash(&mut state, mode);
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "simulated crash",
            ));
        }
        Ok(temp)
    }

    fn sync_file(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock_state();
        let fault = Self::take_fault(&mut state, FaultOp::SyncFile);
        if let Some(action) = fault
            && !matches!(action, FaultAction::CrashAfter(_))
        {
            return Err(apply_io_fault(&mut state, action));
        }
        let key = normalize_key(path, state.case_insensitive);
        match state.volatile.get_mut(&key) {
            Some(Inode::File {
                volatile,
                durable,
                synced,
            }) => {
                *durable = Some(volatile.clone());
                *synced = true;
            }
            Some(Inode::Dir) => {
                return Err(io::Error::new(
                    io::ErrorKind::IsADirectory,
                    "is a directory",
                ));
            }
            None => return Err(io::Error::new(io::ErrorKind::NotFound, "not found")),
        }
        if let Some(FaultAction::CrashAfter(mode)) = fault {
            apply_crash(&mut state, mode);
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "simulated crash",
            ));
        }
        Ok(())
    }

    fn rename_replace(&self, src: &Path, dest: &Path) -> io::Result<()> {
        let mut state = self.lock_state();
        if state.read_only {
            return Err(io::Error::new(
                io::ErrorKind::ReadOnlyFilesystem,
                "read-only filesystem",
            ));
        }
        let fault = Self::take_fault(&mut state, FaultOp::RenameReplace);
        if let Some(action) = fault
            && !matches!(action, FaultAction::CrashAfter(_))
        {
            return Err(apply_io_fault(&mut state, action));
        }
        let src_key = normalize_key(src, state.case_insensitive);
        let dest_key = normalize_key(dest, state.case_insensitive);
        if matches!(state.volatile.get(&dest_key), Some(Inode::Dir)) {
            return Err(io::Error::new(
                io::ErrorKind::IsADirectory,
                "cannot replace directory with file",
            ));
        }
        let inode = state
            .volatile
            .remove(&src_key)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "source not found"))?;
        state.volatile.insert(dest_key, inode);
        if let Some(FaultAction::CrashAfter(mode)) = fault {
            apply_crash(&mut state, mode);
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "simulated crash",
            ));
        }
        Ok(())
    }

    fn persist_noclobber(
        &self,
        src: &Path,
        dest: &Path,
        expected_fingerprint: Option<&str>,
        _unix_mode: Option<u32>,
    ) -> Result<(), DurableError> {
        let mut state = self.lock_state();
        if state.read_only {
            return Err(DurableError::Io(io::Error::new(
                io::ErrorKind::ReadOnlyFilesystem,
                "read-only filesystem",
            )));
        }
        let fault = Self::take_fault(&mut state, FaultOp::PersistNoclobber);
        let fallback_mode = match fault {
            Some(FaultAction::AlreadyExists) => return Err(DurableError::AlreadyExists),
            Some(FaultAction::NoclobberFallback) => true,
            Some(action) if !matches!(action, FaultAction::CrashAfter(_)) => {
                return Err(DurableError::Io(apply_io_fault(&mut state, action)));
            }
            _ => false,
        };
        let src_key = normalize_key(src, state.case_insensitive);
        let dest_key = normalize_key(dest, state.case_insensitive);
        if state.volatile.contains_key(&dest_key) {
            return Err(DurableError::AlreadyExists);
        }
        if fallback_mode {
            return persist_noclobber_fallback(
                &mut state,
                &src_key,
                &dest_key,
                expected_fingerprint,
            );
        }

        let inode = state
            .volatile
            .remove(&src_key)
            .ok_or_else(|| DurableError::Io(io::Error::new(io::ErrorKind::NotFound, "missing")))?;
        if let Some(expected) = expected_fingerprint
            && let Inode::File { ref volatile, .. } = inode
            && hash::sha256_hex(volatile) != expected
        {
            return Err(DurableError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "fingerprint verification failed",
            )));
        }
        state.volatile.insert(dest_key, inode);
        if let Some(FaultAction::CrashAfter(mode)) = fault {
            apply_crash(&mut state, mode);
            return Err(DurableError::Io(io::Error::new(
                io::ErrorKind::Interrupted,
                "simulated crash",
            )));
        }
        Ok(())
    }

    fn sweep_role_sidecars(&self, parent: &Path, role: &str) {
        let mut state = self.lock_state();
        if state.read_only {
            return;
        }
        let parent_key = normalize_key(parent, state.case_insensitive);
        let suffix = format!(".{role}");
        let to_remove: Vec<PathBuf> = state
            .volatile
            .iter()
            .filter_map(|(path, inode)| {
                if !matches!(inode, Inode::File { .. })
                    || path.parent() != Some(parent_key.as_path())
                {
                    return None;
                }
                let name = path.file_name()?.to_str()?;
                (name.starts_with(".canopi-") && name.ends_with(&suffix)).then(|| path.clone())
            })
            .collect();
        for path in to_remove {
            state.volatile.remove(&path);
        }
    }

    fn sync_dir(&self, dir: &Path) -> io::Result<()> {
        let mut state = self.lock_state();
        let fault = Self::take_fault(&mut state, FaultOp::SyncDir);
        if let Some(action) = fault
            && !matches!(action, FaultAction::CrashAfter(_))
        {
            return Err(apply_io_fault(&mut state, action));
        }
        let dir_key = normalize_key(dir, state.case_insensitive);
        // Commit all volatile entries directly under `dir_key` into `durable`.
        let to_remove: Vec<PathBuf> = state
            .durable
            .keys()
            .filter(|p| p.parent() == Some(dir_key.as_path()) && !state.volatile.contains_key(*p))
            .cloned()
            .collect();
        for path in to_remove {
            state.durable.remove(&path);
        }
        let to_commit: Vec<(PathBuf, Inode)> = state
            .volatile
            .iter()
            .filter(|(p, _)| p.parent() == Some(dir_key.as_path()))
            .map(|(p, inode)| (p.clone(), inode.clone()))
            .collect();
        for (path, inode) in to_commit {
            state.durable.insert(path, inode);
        }
        if let Some(FaultAction::CrashAfter(mode)) = fault {
            apply_crash(&mut state, mode);
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "simulated crash",
            ));
        }
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock_state();
        if state.read_only {
            return Err(io::Error::new(
                io::ErrorKind::ReadOnlyFilesystem,
                "read-only filesystem",
            ));
        }
        if let Some(action) = Self::take_fault(&mut state, FaultOp::RemoveFile) {
            return Err(apply_io_fault(&mut state, action));
        }
        let key = normalize_key(path, state.case_insensitive);
        match state.volatile.remove(&key) {
            Some(Inode::File { .. }) => Ok(()),
            Some(Inode::Dir) => {
                state.volatile.insert(key, Inode::Dir);
                Err(io::Error::new(
                    io::ErrorKind::IsADirectory,
                    "is a directory",
                ))
            }
            None => Err(io::Error::new(io::ErrorKind::NotFound, "not found")),
        }
    }

    fn available_space(&self, _dir: &Path) -> io::Result<u64> {
        let mut state = self.lock_state();
        if let Some(action) = Self::take_fault(&mut state, FaultOp::AvailableSpace) {
            return Err(apply_io_fault(&mut state, action));
        }
        Ok(state.available_bytes)
    }
}
