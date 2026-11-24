//! Real OS implementation of [`DurableFs`] (`OsDurableFs`), including
//! `tempfile::NamedTempFile::persist_noclobber` with FAT32/exFAT verified-copy
//! fallback (2.1-M541).

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::durable::{DurableError, DurableFs, EntryKind, NoclobberSupport, PublishOptions};
use crate::durable_locks::parent_dir;
use crate::fs_space;
use crate::hash;

static NEXT_SIDECAR_ID: AtomicU64 = AtomicU64::new(0);

/// Real OS implementation of [`DurableFs`].
#[derive(Debug, Default, Clone, Copy)]
pub struct OsDurableFs;

impl OsDurableFs {
    /// Singleton reference for callers that do not inject a fault seam.
    pub const fn new() -> Self {
        Self
    }
}

impl DurableFs for OsDurableFs {
    fn read_bytes(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    fn fingerprint_file(&self, path: &Path) -> io::Result<Option<String>> {
        hash::sha256_file(path)
    }

    fn entry_kind(&self, path: &Path) -> io::Result<Option<EntryKind>> {
        match std::fs::symlink_metadata(path) {
            Ok(meta) => {
                let ft = meta.file_type();
                if ft.is_file() {
                    Ok(Some(EntryKind::File))
                } else if ft.is_dir() {
                    Ok(Some(EntryKind::Dir))
                } else {
                    Ok(Some(EntryKind::Other))
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        std::fs::create_dir_all(path)
    }

    fn stage_bytes(
        &self,
        parent: &Path,
        role: &str,
        bytes: &[u8],
        options: &PublishOptions,
        preserve_from: Option<&Path>,
    ) -> io::Result<PathBuf> {
        let temporary = operation_sidecar_path(parent, role);
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = options.unix_mode {
            std::os::unix::fs::OpenOptionsExt::mode(&mut open, mode);
        }
        let mut file = open.open(&temporary)?;
        if let Err(error) = file.write_all(bytes) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        drop(file);
        if options.preserve_target_permissions
            && let Some(target) = preserve_from
            && let Ok(meta) = std::fs::metadata(target)
            && let Err(error) = std::fs::set_permissions(&temporary, meta.permissions())
        {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(temporary)
    }

    fn sync_file(&self, path: &Path) -> io::Result<()> {
        // Windows FlushFileBuffers requires write access on the handle; opening
        // with write(true) without truncate flushes without modifying bytes.
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)?
            .sync_all()
    }

    fn rename_replace(&self, src: &Path, dest: &Path) -> io::Result<()> {
        std::fs::rename(src, dest)
    }

    fn persist_noclobber(
        &self,
        src: &Path,
        dest: &Path,
        expected_fingerprint: Option<&str>,
        unix_mode: Option<u32>,
    ) -> Result<(), DurableError> {
        os_persist_noclobber(src, dest, expected_fingerprint, unix_mode)
    }

    fn sync_dir(&self, dir: &Path) -> io::Result<()> {
        os_sync_dir(dir)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }

    fn available_space(&self, dir: &Path) -> io::Result<u64> {
        fs_space::available_space(dir)
    }

    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

/// Probe whether `dir`'s filesystem supports `tempfile::NamedTempFile::persist_noclobber`
/// natively or requires the FAT32/exFAT verified-copy fallback (2.1-M541).
pub fn probe_noclobber_support(dir: &Path) -> io::Result<NoclobberSupport> {
    let probe_target = operation_sidecar_path(dir, "noclobber-probe");
    let mut temp = tempfile::Builder::new()
        .prefix(".canopi-probe-")
        .tempfile_in(dir)?;
    temp.write_all(b"p")?;
    let support = match temp.persist_noclobber(&probe_target) {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe_target);
            NoclobberSupport::Supported
        }
        Err(persist_err) if is_noclobber_unsupported(&persist_err.error, &probe_target) => {
            drop(persist_err.file);
            NoclobberSupport::FallbackVerifiedCopy
        }
        Err(persist_err) => {
            drop(persist_err.file);
            return Err(persist_err.error);
        }
    };
    Ok(support)
}

fn os_persist_noclobber(
    src: &Path,
    dest: &Path,
    expected_fingerprint: Option<&str>,
    unix_mode: Option<u32>,
) -> Result<(), DurableError> {
    let parent = parent_dir(dest);
    let mut temp = tempfile::Builder::new()
        .prefix(".canopi-nc-")
        .tempfile_in(parent)?;
    #[cfg(unix)]
    if let Some(mode) = unix_mode {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = unix_mode;

    let mut reader = std::fs::File::open(src)?;
    io::copy(&mut reader, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    drop(reader);

    match temp.persist_noclobber(dest) {
        Ok(_file) => {
            let _ = std::fs::remove_file(src);
            Ok(())
        }
        Err(persist_err) if persist_err.error.kind() == io::ErrorKind::AlreadyExists => {
            drop(persist_err.file);
            Err(DurableError::AlreadyExists)
        }
        Err(persist_err) if is_noclobber_unsupported(&persist_err.error, dest) => {
            drop(persist_err.file);
            os_fallback_verified_noclobber(src, dest, expected_fingerprint, unix_mode)?;
            let _ = std::fs::remove_file(src);
            Ok(())
        }
        Err(persist_err) => {
            drop(persist_err.file);
            Err(DurableError::Io(persist_err.error))
        }
    }
}

fn is_noclobber_unsupported(error: &io::Error, dest: &Path) -> bool {
    if dest.exists() {
        return false;
    }
    matches!(
        error.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::PermissionDenied
    ) || matches!(error.raw_os_error(), Some(1 | 18 | 38 | 95))
}

fn os_fallback_verified_noclobber(
    src: &Path,
    dest: &Path,
    expected_fingerprint: Option<&str>,
    unix_mode: Option<u32>,
) -> Result<(), DurableError> {
    let expected = match expected_fingerprint {
        Some(fp) => fp.to_owned(),
        None => hash::sha256_file(src)?.ok_or_else(|| {
            DurableError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                "staged source missing during no-clobber fallback",
            ))
        })?,
    };
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = unix_mode {
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, mode);
    }
    #[cfg(not(unix))]
    let _ = unix_mode;

    let mut out = match open.open(dest) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(DurableError::AlreadyExists);
        }
        Err(error) => return Err(DurableError::Io(error)),
    };
    let write_res: io::Result<()> = (|| {
        let mut reader = std::fs::File::open(src)?;
        io::copy(&mut reader, &mut out)?;
        out.sync_all()
    })();
    drop(out);
    if let Err(error) = write_res {
        let _ = std::fs::remove_file(dest);
        return Err(DurableError::Io(error));
    }
    let actual = hash::sha256_file(dest)?;
    if actual.as_deref() != Some(expected.as_str()) {
        let _ = std::fs::remove_file(dest);
        return Err(DurableError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "no-clobber fallback fingerprint verification failed",
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn os_sync_dir(dir: &Path) -> io::Result<()> {
    match std::fs::File::open(dir).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == io::ErrorKind::InvalidInput
                || error.kind() == io::ErrorKind::Unsupported =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn os_sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

fn operation_sidecar_path(parent: &Path, role: &str) -> PathBuf {
    loop {
        let id = NEXT_SIDECAR_ID.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".canopi-{:x}-{id:x}.{role}", std::process::id()));
        if !path.exists() {
            return path;
        }
    }
}
