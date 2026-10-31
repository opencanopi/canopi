use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_SIDECAR: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(crate) struct PublicationError(String);

impl fmt::Display for PublicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for PublicationError {}

pub(crate) struct GenerationPlan {
    admission: PathBuf,
    marker: PathBuf,
    artifacts: Vec<GeneratedArtifact>,
}

pub(crate) struct GenerationAdmission {
    path: PathBuf,
    mode: AdmissionMode,
    _file: File,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum MarkerDisposition {
    RemoveOnDrop,
    Preserve,
    Removed,
}

struct PublicationMarker<'a, SyncDirectory>
where
    SyncDirectory: FnMut(&Path) -> io::Result<()>,
{
    path: PathBuf,
    contents: Vec<u8>,
    sync_directory: &'a mut SyncDirectory,
    disposition: MarkerDisposition,
}

impl<SyncDirectory> PublicationMarker<'_, SyncDirectory>
where
    SyncDirectory: FnMut(&Path) -> io::Result<()>,
{
    fn preserve_on_drop(&mut self) {
        self.disposition = MarkerDisposition::Preserve;
    }

    fn sync_directory(&mut self, directory: &Path) -> io::Result<()> {
        (self.sync_directory)(directory)
    }

    fn remove_durably(&mut self) -> io::Result<()> {
        if self.disposition == MarkerDisposition::Removed {
            return Ok(());
        }
        match remove_marker_durably(&self.path, self.sync_directory) {
            Ok(()) => {
                self.disposition = MarkerDisposition::Removed;
                Ok(())
            }
            Err(error) => {
                self.disposition = MarkerDisposition::Preserve;
                Err(error)
            }
        }
    }

    fn ensure_present(&mut self) -> io::Result<()> {
        self.disposition = MarkerDisposition::Preserve;
        match fs::metadata(&self.path) {
            Ok(metadata) if metadata.is_file() => return Ok(()),
            Ok(_) => {
                return Err(io::Error::other(
                    "in-progress marker path is not a regular file",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let parent = self.path.parent().ok_or_else(|| {
            io::Error::other("bindings generation marker has no parent directory")
        })?;
        let mut marker = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.path)?;
        let persisted = marker
            .write_all(&self.contents)
            .and_then(|()| marker.sync_all());
        drop(marker);
        persisted?;
        (self.sync_directory)(parent)
    }

    fn cleanup_after(mut self, original_error: PublicationError) -> PublicationError {
        match self.remove_durably() {
            Ok(()) => original_error,
            Err(cleanup_error) => PublicationError(format!(
                "{original_error}; the in-progress marker could not be cleaned up: {cleanup_error}"
            )),
        }
    }

    fn prepare_rollback(&mut self, original_error: String) -> Result<String, PublicationError> {
        match self.ensure_present() {
            Ok(()) => Ok(original_error),
            Err(error) => Err(PublicationError(format!(
                "{original_error}; failed to restore durable in-progress marker before rollback: {error}; rollback was not attempted because it would have no durable crash evidence"
            ))),
        }
    }
}

impl<SyncDirectory> Drop for PublicationMarker<'_, SyncDirectory>
where
    SyncDirectory: FnMut(&Path) -> io::Result<()>,
{
    fn drop(&mut self) {
        if self.disposition == MarkerDisposition::RemoveOnDrop {
            let _ = self.remove_durably();
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum AdmissionMode {
    Check,
    Publish,
}

struct GeneratedArtifact {
    destination: PathBuf,
    content: Vec<u8>,
}

struct PreparedArtifact {
    destination: PathBuf,
    staged: PathBuf,
    original: Option<Vec<u8>>,
    original_permissions: Option<Permissions>,
    published: bool,
}

struct PreparationFailure {
    prepared: Vec<PreparedArtifact>,
    failed_staged: Vec<PathBuf>,
    error: PublicationError,
}

struct ArtifactPreparationFailure {
    error: io::Error,
    staged: Vec<PathBuf>,
}

impl ArtifactPreparationFailure {
    fn before_staging(error: io::Error) -> Self {
        Self {
            error,
            staged: Vec::new(),
        }
    }
}

struct StagingFailure {
    error: io::Error,
    sidecar: Option<PathBuf>,
}

impl StagingFailure {
    fn before_sidecar(error: io::Error) -> Self {
        Self {
            error,
            sidecar: None,
        }
    }
}

pub(crate) fn acquire_generation_admission(
    repo_root: &Path,
    mode: AdmissionMode,
) -> Result<GenerationAdmission, PublicationError> {
    let marker = repo_root
        .join("target")
        .join("bindings-gen-publication.in-progress");
    acquire_admission_path(&marker.with_extension("lock"), mode)
}

impl GenerationPlan {
    pub(crate) fn new(repo_root: &Path) -> Self {
        let marker = repo_root
            .join("target")
            .join("bindings-gen-publication.in-progress");
        Self {
            admission: marker.with_extension("lock"),
            marker,
            artifacts: Vec::new(),
        }
    }

    #[cfg(test)]
    fn new_with_marker(marker: PathBuf) -> Self {
        Self {
            admission: marker.with_extension("lock"),
            marker,
            artifacts: Vec::new(),
        }
    }

    pub(crate) fn add(
        &mut self,
        destination: PathBuf,
        content: impl Into<Vec<u8>>,
    ) -> Result<(), PublicationError> {
        if self
            .artifacts
            .iter()
            .any(|artifact| artifact.destination == destination)
        {
            return Err(PublicationError(format!(
                "generated destination was added more than once: {}",
                destination.display()
            )));
        }
        self.artifacts.push(GeneratedArtifact {
            destination,
            content: content.into(),
        });
        Ok(())
    }

    pub(crate) fn publish_admitted(
        &self,
        admission: GenerationAdmission,
    ) -> Result<(), PublicationError> {
        self.publish_admitted_with_io(
            admission,
            replace_file,
            sync_directory,
            |path| fs::remove_file(path),
            prepare_artifact,
        )
    }

    pub(crate) fn check_admitted(
        &self,
        admission: GenerationAdmission,
    ) -> Result<(), PublicationError> {
        self.validate_admission(&admission, AdmissionMode::Check)?;
        let _admission = admission;
        self.reject_interrupted_publication()?;
        let mut stale = Vec::new();
        for artifact in &self.artifacts {
            let actual = match fs::read(&artifact.destination) {
                Ok(actual) => Some(actual),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(PublicationError(format!(
                        "failed to read generated artifact {} during drift check: {error}",
                        artifact.destination.display()
                    )));
                }
            };
            if actual.as_deref() != Some(artifact.content.as_slice()) {
                stale.push(artifact.destination.display().to_string());
            }
        }
        if stale.is_empty() {
            Ok(())
        } else {
            Err(PublicationError(format!(
                "generated artifacts are stale:\n- {}",
                stale.join("\n- ")
            )))
        }
    }

    #[cfg(test)]
    fn publish(&self) -> Result<(), PublicationError> {
        self.publish_with(replace_file)
    }

    #[cfg(test)]
    fn check(&self) -> Result<(), PublicationError> {
        let admission = self.acquire_own_admission(AdmissionMode::Check)?;
        self.check_admitted(admission)
    }

    #[cfg(test)]
    fn publish_with(
        &self,
        replace: impl FnMut(&Path, &Path) -> io::Result<()>,
    ) -> Result<(), PublicationError> {
        self.publish_with_io(replace, sync_directory)
    }

    #[cfg(test)]
    fn publish_with_io(
        &self,
        replace: impl FnMut(&Path, &Path) -> io::Result<()>,
        sync_directory: impl FnMut(&Path) -> io::Result<()>,
    ) -> Result<(), PublicationError> {
        self.publish_with_cleanup_io(replace, sync_directory, |path| fs::remove_file(path))
    }

    #[cfg(test)]
    fn publish_with_cleanup_io(
        &self,
        replace: impl FnMut(&Path, &Path) -> io::Result<()>,
        sync_directory: impl FnMut(&Path) -> io::Result<()>,
        remove_staged: impl FnMut(&Path) -> io::Result<()>,
    ) -> Result<(), PublicationError> {
        self.publish_with_prepare_io(replace, sync_directory, remove_staged, prepare_artifact)
    }

    #[cfg(test)]
    fn publish_with_prepare_io(
        &self,
        replace: impl FnMut(&Path, &Path) -> io::Result<()>,
        sync_directory: impl FnMut(&Path) -> io::Result<()>,
        remove_staged: impl FnMut(&Path) -> io::Result<()>,
        prepare_artifact: impl FnMut(
            &GeneratedArtifact,
        ) -> Result<PreparedArtifact, ArtifactPreparationFailure>,
    ) -> Result<(), PublicationError> {
        let admission = self.acquire_own_admission(AdmissionMode::Publish)?;
        self.publish_admitted_with_io(
            admission,
            replace,
            sync_directory,
            remove_staged,
            prepare_artifact,
        )
    }

    fn publish_admitted_with_io(
        &self,
        admission: GenerationAdmission,
        mut replace: impl FnMut(&Path, &Path) -> io::Result<()>,
        mut sync_directory: impl FnMut(&Path) -> io::Result<()>,
        mut remove_staged: impl FnMut(&Path) -> io::Result<()>,
        mut prepare_artifact: impl FnMut(
            &GeneratedArtifact,
        )
            -> Result<PreparedArtifact, ArtifactPreparationFailure>,
    ) -> Result<(), PublicationError> {
        self.validate_admission(&admission, AdmissionMode::Publish)?;
        let _admission = admission;
        self.reject_interrupted_publication()?;
        let mut marker = self.create_marker(&mut sync_directory)?;
        marker.preserve_on_drop();
        let mut prepared = match self.prepare_all(&mut prepare_artifact) {
            Ok(prepared) => prepared,
            Err(failure) => {
                let mut cleanup_errors =
                    cleanup_staged_sidecars(&failure.prepared, &mut remove_staged);
                cleanup_errors.extend(cleanup_sidecar_paths(
                    failure.failed_staged.iter().map(PathBuf::as_path),
                    &mut remove_staged,
                ));
                if cleanup_errors.is_empty() {
                    return Err(marker.cleanup_after(failure.error));
                }
                return Err(PublicationError(format!(
                    "{}; staged-sidecar cleanup failed: {}. The in-progress marker was preserved for inspection",
                    failure.error,
                    cleanup_errors.join("; ")
                )));
            }
        };

        for index in 0..prepared.len() {
            let result = replace(&prepared[index].staged, &prepared[index].destination);
            if let Err(error) = result {
                // A platform fallback may have removed or partially replaced the
                // destination before reporting its error, so restore this member
                // as well as every earlier successful member.
                prepared[index].published = true;
                let destination = prepared[index].destination.display().to_string();
                return Err(self.rollback_after(
                    &mut prepared,
                    &mut replace,
                    &mut remove_staged,
                    &mut marker,
                    format!("failed to publish generated artifact {destination}: {error}"),
                ));
            }
            prepared[index].published = true;
        }

        if let Err(error) = sync_destination_parents(&prepared, &mut marker) {
            let rollback_error = marker.prepare_rollback(format!(
                "failed to persist generated artifact publication: {error}"
            ))?;
            return Err(self.rollback_after(
                &mut prepared,
                &mut replace,
                &mut remove_staged,
                &mut marker,
                rollback_error,
            ));
        }

        if let Err(error) = marker.remove_durably() {
            let rollback_error = marker.prepare_rollback(format!(
                "generated artifacts were published but the in-progress marker could not be removed: {error}"
            ))?;
            return Err(self.rollback_after(
                &mut prepared,
                &mut replace,
                &mut remove_staged,
                &mut marker,
                rollback_error,
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    fn acquire_own_admission(
        &self,
        mode: AdmissionMode,
    ) -> Result<GenerationAdmission, PublicationError> {
        acquire_admission_path(&self.admission, mode)
    }

    fn validate_admission(
        &self,
        admission: &GenerationAdmission,
        expected_mode: AdmissionMode,
    ) -> Result<(), PublicationError> {
        if admission.path != self.admission || admission.mode != expected_mode {
            return Err(PublicationError(
                "bindings generation admission does not match this plan and operation".into(),
            ));
        }
        Ok(())
    }

    fn reject_interrupted_publication(&self) -> Result<(), PublicationError> {
        if self.marker.exists() {
            return Err(PublicationError(format!(
                "an interrupted bindings generation was detected at {}; inspect the generated-file diff, restore or accept it, then remove the marker before retrying",
                self.marker.display()
            )));
        }
        Ok(())
    }

    fn prepare_all(
        &self,
        prepare_artifact: &mut impl FnMut(
            &GeneratedArtifact,
        )
            -> Result<PreparedArtifact, ArtifactPreparationFailure>,
    ) -> Result<Vec<PreparedArtifact>, PreparationFailure> {
        let mut prepared = Vec::with_capacity(self.artifacts.len());
        let mut destinations = HashSet::new();
        for artifact in &self.artifacts {
            if !destinations.insert(&artifact.destination) {
                return Err(PreparationFailure {
                    prepared,
                    failed_staged: Vec::new(),
                    error: PublicationError(format!(
                        "generated destination was added more than once: {}",
                        artifact.destination.display()
                    )),
                });
            }
            match prepare_artifact(artifact) {
                Ok(artifact) => prepared.push(artifact),
                Err(failure) => {
                    return Err(PreparationFailure {
                        prepared,
                        failed_staged: failure.staged,
                        error: PublicationError(format!(
                            "failed to stage generated artifact {}: {}",
                            artifact.destination.display(),
                            failure.error,
                        )),
                    });
                }
            }
        }
        Ok(prepared)
    }

    fn create_marker<'a, SyncDirectory>(
        &self,
        sync_directory: &'a mut SyncDirectory,
    ) -> Result<PublicationMarker<'a, SyncDirectory>, PublicationError>
    where
        SyncDirectory: FnMut(&Path) -> io::Result<()>,
    {
        let parent = self.marker.parent().ok_or_else(|| {
            PublicationError("bindings generation marker has no parent directory".to_owned())
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            PublicationError(format!(
                "failed to create bindings generation marker directory {}: {error}",
                parent.display()
            ))
        })?;
        let mut contents = Vec::new();
        writeln!(
            &mut contents,
            "bindings-gen was publishing these generated destinations when it stopped:"
        )
        .and_then(|()| {
            self.artifacts.iter().try_for_each(|artifact| {
                writeln!(&mut contents, "{}", artifact.destination.display())
            })
        })
        .map_err(|error| {
            PublicationError(format!(
                "failed to render bindings generation in-progress marker: {error}"
            ))
        })?;
        let mut marker = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.marker)
            .map_err(|error| {
                PublicationError(format!(
                    "failed to create bindings generation in-progress marker {}: {error}",
                    self.marker.display()
                ))
            })?;
        let persisted = marker
            .write_all(&contents)
            .and_then(|()| marker.sync_all())
            .and_then(|()| sync_directory(parent));
        drop(marker);
        if let Err(error) = persisted {
            let cleanup = remove_marker_durably(&self.marker, sync_directory);
            let cleanup = cleanup
                .err()
                .map(|cleanup_error| format!("; marker cleanup also failed: {cleanup_error}"))
                .unwrap_or_default();
            return Err(PublicationError(format!(
                "failed to persist bindings generation in-progress marker {}: {error}{cleanup}",
                self.marker.display()
            )));
        }
        Ok(PublicationMarker {
            path: self.marker.clone(),
            contents,
            sync_directory,
            disposition: MarkerDisposition::RemoveOnDrop,
        })
    }

    fn rollback_after<SyncDirectory>(
        &self,
        prepared: &mut [PreparedArtifact],
        replace: &mut impl FnMut(&Path, &Path) -> io::Result<()>,
        remove_staged: &mut impl FnMut(&Path) -> io::Result<()>,
        marker: &mut PublicationMarker<'_, SyncDirectory>,
        original_error: String,
    ) -> PublicationError
    where
        SyncDirectory: FnMut(&Path) -> io::Result<()>,
    {
        let mut rollback_errors = Vec::new();
        let mut failed_restore_sidecars = Vec::new();
        for artifact in prepared.iter_mut().rev().filter(|item| item.published) {
            let result = match &artifact.original {
                Some(content) => match stage_bytes(
                    &artifact.destination,
                    content,
                    artifact.original_permissions.as_ref(),
                    "restore",
                ) {
                    Ok(restore) => {
                        let result = replace(&restore, &artifact.destination);
                        result.map_err(|error| {
                            io::Error::new(
                                error.kind(),
                                format!(
                                    "{error}; prior bytes remain staged at {}",
                                    restore.display()
                                ),
                            )
                        })
                    }
                    Err(failure) => {
                        if let Some(sidecar) = failure.sidecar {
                            failed_restore_sidecars.push(sidecar);
                        }
                        Err(failure.error)
                    }
                },
                None => match fs::remove_file(&artifact.destination) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error),
                },
            };
            if let Err(error) = result {
                rollback_errors.push(format!("{}: {error}", artifact.destination.display()));
            } else {
                artifact.published = false;
            }
        }

        rollback_errors.extend(cleanup_staged_sidecars(prepared, remove_staged));
        rollback_errors.extend(cleanup_sidecar_paths(
            failed_restore_sidecars.iter().map(PathBuf::as_path),
            remove_staged,
        ));

        if let Err(error) = sync_destination_parents(prepared, marker) {
            rollback_errors.push(error.to_string());
        }

        if rollback_errors.is_empty()
            && let Err(error) = marker.remove_durably()
        {
            rollback_errors.push(format!("{}: {error}", marker.path.display()));
        }

        let marker_preserved = if rollback_errors.is_empty() {
            true
        } else {
            match marker.ensure_present() {
                Ok(()) => true,
                Err(error) => {
                    rollback_errors.push(format!(
                        "{} could not be preserved: {error}",
                        marker.path.display()
                    ));
                    false
                }
            }
        };

        if rollback_errors.is_empty() {
            PublicationError(format!(
                "{original_error}; every generated destination was restored"
            ))
        } else {
            let evidence = if marker_preserved {
                "The in-progress marker was preserved for crash detection"
            } else {
                "The in-progress marker could not be fully preserved; inspect the generated destinations immediately"
            };
            PublicationError(format!(
                "{original_error}; rollback was incomplete: {}. {evidence}",
                rollback_errors.join("; ")
            ))
        }
    }
}

fn cleanup_staged_sidecars(
    prepared: &[PreparedArtifact],
    remove_staged: &mut impl FnMut(&Path) -> io::Result<()>,
) -> Vec<String> {
    cleanup_sidecar_paths(
        prepared.iter().map(|artifact| artifact.staged.as_path()),
        remove_staged,
    )
}

fn cleanup_sidecar_paths<'a>(
    paths: impl IntoIterator<Item = &'a Path>,
    remove_staged: &mut impl FnMut(&Path) -> io::Result<()>,
) -> Vec<String> {
    paths
        .into_iter()
        .filter_map(|path| match remove_staged(path) {
            Ok(()) => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => Some(format!("{}: {error}", path.display())),
        })
        .collect()
}

fn sync_destination_parents<SyncDirectory>(
    artifacts: &[PreparedArtifact],
    marker: &mut PublicationMarker<'_, SyncDirectory>,
) -> io::Result<()>
where
    SyncDirectory: FnMut(&Path) -> io::Result<()>,
{
    let mut synced = HashSet::new();
    for artifact in artifacts {
        let parent = artifact.destination.parent().ok_or_else(|| {
            io::Error::other(format!(
                "generated destination has no parent directory: {}",
                artifact.destination.display()
            ))
        })?;
        if synced.insert(parent) {
            marker.sync_directory(parent).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "failed to sync generated destination directory {}: {error}",
                        parent.display()
                    ),
                )
            })?;
        }
    }
    Ok(())
}

fn acquire_admission_path(
    admission: &Path,
    mode: AdmissionMode,
) -> Result<GenerationAdmission, PublicationError> {
    let parent = admission.parent().ok_or_else(|| {
        PublicationError("bindings generation admission file has no parent directory".into())
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        PublicationError(format!(
            "failed to create bindings generation admission directory {}: {error}",
            parent.display()
        ))
    })?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(admission)
        .map_err(|error| {
            PublicationError(format!(
                "failed to open bindings generation admission file {}: {error}",
                admission.display()
            ))
        })?;
    let lock = match mode {
        AdmissionMode::Check => file.try_lock_shared(),
        AdmissionMode::Publish => file.try_lock(),
    };
    lock.map_err(|error| {
        let message = match error {
            fs::TryLockError::WouldBlock => {
                "another bindings generation or drift check is already active".to_owned()
            }
            fs::TryLockError::Error(error) => {
                format!("failed to acquire bindings generation admission: {error}")
            }
        };
        PublicationError(format!("{message} at {}", admission.display()))
    })?;
    Ok(GenerationAdmission {
        path: admission.to_owned(),
        mode,
        _file: file,
    })
}

fn remove_marker_durably(
    marker: &Path,
    sync_directory: &mut impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<()> {
    match fs::remove_file(marker) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = marker
        .parent()
        .ok_or_else(|| io::Error::other("bindings generation marker has no parent directory"))?;
    sync_directory(parent)
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    let directory = File::open(directory)?;
    match directory.sync_all() {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported
            ) =>
        {
            // Some Unix filesystems do not implement directory fsync. The marker
            // file itself is still flushed; callers retain the documented
            // best-effort crash evidence on those filesystems.
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    // Rust's portable filesystem API cannot open directory handles for syncing
    // on every supported host (notably Windows). The marker file is still
    // sync_all'd before publication, and the generated diff remains inspectable.
    Ok(())
}

fn prepare_artifact(
    artifact: &GeneratedArtifact,
) -> Result<PreparedArtifact, ArtifactPreparationFailure> {
    let (original, original_permissions) = match fs::metadata(&artifact.destination) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(ArtifactPreparationFailure::before_staging(
                    io::Error::other("destination is not a regular file"),
                ));
            }
            (
                Some(
                    fs::read(&artifact.destination)
                        .map_err(ArtifactPreparationFailure::before_staging)?,
                ),
                Some(metadata.permissions()),
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => (None, None),
        Err(error) => return Err(ArtifactPreparationFailure::before_staging(error)),
    };
    let staged = stage_bytes(
        &artifact.destination,
        &artifact.content,
        original_permissions.as_ref(),
        "new",
    )
    .map_err(|failure| ArtifactPreparationFailure {
        error: failure.error,
        staged: failure.sidecar.into_iter().collect(),
    })?;
    Ok(PreparedArtifact {
        destination: artifact.destination.clone(),
        staged,
        original,
        original_permissions,
        published: false,
    })
}

fn stage_bytes(
    destination: &Path,
    content: &[u8],
    permissions: Option<&Permissions>,
    role: &str,
) -> Result<PathBuf, StagingFailure> {
    stage_bytes_with(destination, role, |file, candidate| {
        file.write_all(content)?;
        if let Some(permissions) = permissions {
            fs::set_permissions(candidate, permissions.clone())?;
        }
        file.sync_all()
    })
}

fn stage_bytes_with(
    destination: &Path,
    role: &str,
    mut persist: impl FnMut(&mut File, &Path) -> io::Result<()>,
) -> Result<PathBuf, StagingFailure> {
    let parent = destination.parent().ok_or_else(|| {
        StagingFailure::before_sidecar(io::Error::other("destination has no parent directory"))
    })?;
    let filename = destination
        .file_name()
        .ok_or_else(|| {
            StagingFailure::before_sidecar(io::Error::other("destination has no filename"))
        })?
        .to_string_lossy();
    for _ in 0..100 {
        let candidate = parent.join(format!(
            ".{filename}.bindings-gen-{}-{}-{role}",
            std::process::id(),
            NEXT_SIDECAR.fetch_add(1, Ordering::Relaxed),
        ));
        let mut file = match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(StagingFailure::before_sidecar(error)),
        };
        if let Err(error) = persist(&mut file, &candidate) {
            return Err(StagingFailure {
                error,
                sidecar: Some(candidate),
            });
        }
        return Ok(candidate);
    }
    Err(StagingFailure::before_sidecar(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a unique generated-artifact sidecar",
    )))
}

fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(first_error) if destination.is_file() => {
            fs::remove_file(destination)?;
            fs::rename(source, destination).map_err(|second_error| {
                io::Error::new(
                    second_error.kind(),
                    format!(
                        "direct replace failed ({first_error}); removing the destination then publishing also failed ({second_error})"
                    ),
                )
            })
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AdmissionMode, ArtifactPreparationFailure, GenerationPlan, acquire_generation_admission,
        prepare_artifact, replace_file, stage_bytes_with,
    };
    use std::fs;
    use std::io;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "canopi_bindings_gen_{name}_{}_{}",
                std::process::id(),
                NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&path).expect("create publication test root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn hold_exclusive_admission(marker: &Path) -> fs::File {
        let admission = marker.with_extension("lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(admission)
            .unwrap();
        file.try_lock().unwrap();
        file
    }

    #[test]
    fn reported_partial_publication_restores_every_destination() {
        let root = TempRoot::new("rollback");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut replacements = 0;
        let error = plan
            .publish_with(|source, destination| {
                replacements += 1;
                if replacements == 2 {
                    return Err(io::Error::other("forced second publication failure"));
                }
                replace_file(source, destination)
            })
            .expect_err("the forced replacement failure should be reported");

        assert!(
            error
                .to_string()
                .contains("forced second publication failure")
        );
        assert_eq!(fs::read(&first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(&second).unwrap(), b"second sentinel");
        assert!(!marker.exists());
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains("bindings-gen"))
                .count(),
            0,
        );
    }

    #[test]
    fn complete_rollback_syncs_restored_destination_parents_before_marker_removal() {
        let root = TempRoot::new("rollback_parent_sync");
        let generated_frontend = root.path().join("generated-frontend");
        let generated_backend = root.path().join("generated-backend");
        fs::create_dir(&generated_frontend).unwrap();
        fs::create_dir(&generated_backend).unwrap();
        let first = generated_frontend.join("first.ts");
        let second = generated_backend.join("second.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker);
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut replacements = 0;
        let mut synced = Vec::new();

        let error = plan
            .publish_with_io(
                |source, destination| {
                    replacements += 1;
                    if replacements == 2 {
                        return Err(io::Error::other("forced publication failure"));
                    }
                    replace_file(source, destination)
                },
                |directory| {
                    synced.push(directory.to_owned());
                    Ok(())
                },
            )
            .expect_err("the second replacement must force rollback");

        assert!(
            error
                .to_string()
                .contains("every generated destination was restored")
        );
        assert_eq!(
            synced,
            vec![
                root.path().to_owned(),
                generated_frontend,
                generated_backend,
                root.path().to_owned(),
            ]
        );
        assert_eq!(fs::read(first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(second).unwrap(), b"second sentinel");
    }

    #[test]
    fn successful_publication_syncs_destination_parents_before_marker_removal() {
        let root = TempRoot::new("publish_parent_sync");
        let generated_frontend = root.path().join("generated-frontend");
        let generated_backend = root.path().join("generated-backend");
        fs::create_dir(&generated_frontend).unwrap();
        fs::create_dir(&generated_backend).unwrap();
        let frontend = generated_frontend.join("contracts.ts");
        let backend = generated_backend.join("contracts.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&frontend, b"frontend sentinel").unwrap();
        fs::write(&backend, b"backend sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker);
        plan.add(frontend.clone(), b"frontend replacement".to_vec())
            .unwrap();
        plan.add(backend.clone(), b"backend replacement".to_vec())
            .unwrap();
        let mut synced = Vec::new();

        plan.publish_with_io(replace_file, |directory| {
            synced.push(directory.to_owned());
            Ok(())
        })
        .unwrap();

        assert_eq!(
            synced,
            vec![
                root.path().to_owned(),
                generated_frontend,
                generated_backend,
                root.path().to_owned(),
            ]
        );
        assert_eq!(fs::read(frontend).unwrap(), b"frontend replacement");
        assert_eq!(fs::read(backend).unwrap(), b"backend replacement");
    }

    #[test]
    fn incomplete_rollback_preserves_prior_bytes_and_crash_marker() {
        let root = TempRoot::new("incomplete_rollback");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut replacements = 0;
        let error = plan
            .publish_with(|source, destination| {
                replacements += 1;
                if matches!(replacements, 2 | 3) {
                    return Err(io::Error::other("forced publication and restore failure"));
                }
                replace_file(source, destination)
            })
            .expect_err("the failed restore should preserve crash evidence");

        assert!(error.to_string().contains("rollback was incomplete"));
        assert!(error.to_string().contains("prior bytes remain staged"));
        assert!(marker.exists());
        assert_eq!(fs::read(&first).unwrap(), b"first sentinel");
        let preserved = fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().ends_with("-restore"))
            .expect("a failed restore must preserve its prior bytes");
        assert_eq!(fs::read(preserved.path()).unwrap(), b"second sentinel");
    }

    #[test]
    fn incomplete_rollback_recreates_marker_after_removal_sync_failure() {
        let root = TempRoot::new("recreate_marker");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut replacements = 0;
        let mut directory_syncs = 0;

        let error = plan
            .publish_with_io(
                |source, destination| {
                    replacements += 1;
                    if replacements == 3 {
                        if !marker.exists() {
                            return Err(io::Error::other(
                                "rollback began without durable marker evidence",
                            ));
                        }
                        return Err(io::Error::other("forced restore failure"));
                    }
                    replace_file(source, destination)
                },
                |_| {
                    directory_syncs += 1;
                    if directory_syncs == 3 {
                        return Err(io::Error::other("forced marker removal sync failure"));
                    }
                    Ok(())
                },
            )
            .expect_err("an incomplete rollback must retain crash evidence");

        assert!(error.to_string().contains("rollback was incomplete"));
        assert!(error.to_string().contains("forced restore failure"));
        assert!(
            !error
                .to_string()
                .contains("rollback began without durable marker")
        );
        assert!(marker.exists());
        let marker_contents = fs::read_to_string(&marker).unwrap();
        assert!(marker_contents.contains(&first.display().to_string()));
        assert!(marker_contents.contains(&second.display().to_string()));
        assert_eq!(fs::read(&first).unwrap(), b"first sentinel");
        let preserved = fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().ends_with("-restore"))
            .expect("failed restoration must retain the prior bytes");
        assert_eq!(fs::read(preserved.path()).unwrap(), b"second sentinel");
    }

    #[test]
    fn marker_restoration_failure_stops_before_rollback_without_evidence() {
        let root = TempRoot::new("marker_restore_sync_failure");
        let generated = root.path().join("generated");
        fs::create_dir(&generated).unwrap();
        let destination = generated.join("contracts.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&destination, b"sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(destination.clone(), b"replacement".to_vec())
            .unwrap();
        let mut replacements = 0;
        let mut directory_syncs = 0;

        let error = plan
            .publish_with_io(
                |source, destination| {
                    replacements += 1;
                    replace_file(source, destination)
                },
                |_| {
                    directory_syncs += 1;
                    if matches!(directory_syncs, 3 | 4) {
                        return Err(io::Error::other("forced marker evidence sync failure"));
                    }
                    Ok(())
                },
            )
            .expect_err("rollback cannot begin without durable marker evidence");

        assert!(
            error
                .to_string()
                .contains("failed to restore durable in-progress marker")
        );
        assert!(error.to_string().contains("rollback was not attempted"));
        assert_eq!(replacements, 1);
        assert_eq!(fs::read(&destination).unwrap(), b"replacement");
        assert!(marker.exists());
    }

    #[test]
    fn check_reports_every_stale_destination_without_refreshing_destinations() {
        let root = TempRoot::new("check");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"expected first".to_vec()).unwrap();
        plan.add(second.clone(), b"expected second".to_vec())
            .unwrap();

        let error = plan.check().expect_err("both destinations are stale");

        assert!(error.to_string().contains(&first.display().to_string()));
        assert!(error.to_string().contains(&second.display().to_string()));
        assert_eq!(fs::read(&first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(&second).unwrap(), b"second sentinel");
        assert!(!marker.exists());
    }

    #[test]
    fn check_reports_missing_empty_artifact_as_stale() {
        let root = TempRoot::new("missing_empty");
        let destination = root.path().join("empty-generated.ts");
        let marker = root.path().join("publication.in-progress");

        let mut plan = GenerationPlan::new_with_marker(marker);
        plan.add(destination.clone(), Vec::new()).unwrap();

        let error = plan
            .check()
            .expect_err("a missing generated artifact is stale even when it should be empty");

        assert!(
            error
                .to_string()
                .contains(&destination.display().to_string())
        );
        assert!(!destination.exists());
    }

    #[test]
    fn active_publication_admission_prevents_transient_check_success() {
        let root = TempRoot::new("active_check");
        let destination = root.path().join("contracts.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&destination, b"transient expected bytes").unwrap();
        let _admission = hold_exclusive_admission(&marker);

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(destination.clone(), b"transient expected bytes".to_vec())
            .unwrap();

        let error = plan
            .check()
            .expect_err("a drift check must not read through an active publication");

        assert!(error.to_string().contains("already active"));
        assert_eq!(fs::read(&destination).unwrap(), b"transient expected bytes");
        assert!(!marker.exists());
    }

    #[test]
    fn drift_checks_can_hold_shared_admission_together() {
        let root = TempRoot::new("shared_checks");

        let first = acquire_generation_admission(root.path(), AdmissionMode::Check).unwrap();
        let second = acquire_generation_admission(root.path(), AdmissionMode::Check).unwrap();

        drop(second);
        drop(first);
    }

    #[test]
    fn publication_cannot_overlap_shared_drift_check_admission() {
        let root = TempRoot::new("shared_blocks_publish");
        let check = acquire_generation_admission(root.path(), AdmissionMode::Check).unwrap();

        let error = match acquire_generation_admission(root.path(), AdmissionMode::Publish) {
            Ok(_) => panic!("publication must not overlap a drift check"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("already active"));
        drop(check);
    }

    #[test]
    fn interrupted_publication_marker_blocks_a_new_publication() {
        let root = TempRoot::new("crash_marker");
        let destination = root.path().join("contracts.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&destination, b"sentinel").unwrap();
        fs::write(&marker, b"prior interrupted operation").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(destination.clone(), b"replacement".to_vec())
            .unwrap();

        let error = plan
            .publish()
            .expect_err("an interrupted publication must be inspected first");

        assert!(
            error
                .to_string()
                .contains("interrupted bindings generation")
        );
        assert_eq!(fs::read(&destination).unwrap(), b"sentinel");
        assert_eq!(fs::read(&marker).unwrap(), b"prior interrupted operation");
    }

    #[test]
    fn active_generation_admission_prevents_snapshot_and_staging() {
        let root = TempRoot::new("active_admission");
        let destination = root.path().join("contracts.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&destination, b"sentinel").unwrap();
        let _admission = hold_exclusive_admission(&marker);

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(destination.clone(), b"replacement".to_vec())
            .unwrap();

        let error = plan
            .publish()
            .expect_err("an active generator must own admission before snapshots are captured");

        assert!(error.to_string().contains("already active"));
        assert_eq!(fs::read(&destination).unwrap(), b"sentinel");
        assert!(!marker.exists());
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".bindings-gen-"))
                .count(),
            0,
        );
    }

    #[test]
    fn marker_directory_sync_failure_stops_before_publication_and_cleans_marker() {
        let root = TempRoot::new("marker_sync_failure");
        let destination = root.path().join("contracts.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&destination, b"sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(destination.clone(), b"replacement".to_vec())
            .unwrap();
        let mut sync_calls = 0;

        let error = plan
            .publish_with_io(replace_file, |_| {
                sync_calls += 1;
                if sync_calls == 1 {
                    Err(io::Error::other("forced marker directory sync failure"))
                } else {
                    Ok(())
                }
            })
            .expect_err("an undurable marker must prevent publication");

        assert!(
            error
                .to_string()
                .contains("forced marker directory sync failure")
        );
        assert_eq!(sync_calls, 2, "marker cleanup must also sync its parent");
        assert_eq!(fs::read(&destination).unwrap(), b"sentinel");
        assert!(!marker.exists());
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".bindings-gen-"))
                .count(),
            0,
        );
    }

    #[test]
    fn preparation_failure_durably_cleans_marker_and_staged_sidecars() {
        let root = TempRoot::new("preparation_failure");
        let first = root.path().join("first.ts");
        let invalid = root.path().join("not-a-file.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"sentinel").unwrap();
        fs::create_dir(&invalid).unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"replacement".to_vec()).unwrap();
        plan.add(invalid, b"replacement".to_vec()).unwrap();
        let mut sync_calls = 0;

        let error = plan
            .publish_with_io(replace_file, |_| {
                sync_calls += 1;
                Ok(())
            })
            .expect_err("a preparation failure must abort before publication");

        assert!(
            error
                .to_string()
                .contains("destination is not a regular file")
        );
        assert_eq!(
            sync_calls, 2,
            "marker creation and cleanup must both sync the parent"
        );
        assert_eq!(fs::read(&first).unwrap(), b"sentinel");
        assert!(!marker.exists());
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".bindings-gen-"))
                .count(),
            0,
        );
    }

    #[test]
    fn preparation_cleanup_failure_is_reported_before_preserving_marker() {
        let root = TempRoot::new("preparation_cleanup_failure");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.ts");
        let invalid = root.path().join("not-a-file.rs");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();
        fs::create_dir(&invalid).unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"replacement".to_vec()).unwrap();
        plan.add(second.clone(), b"replacement".to_vec()).unwrap();
        plan.add(invalid, b"replacement".to_vec()).unwrap();
        let mut sync_calls = 0;

        let error = plan
            .publish_with_cleanup_io(
                replace_file,
                |_| {
                    sync_calls += 1;
                    Ok(())
                },
                |_| Err(io::Error::other("forced staged-sidecar unlink failure")),
            )
            .expect_err("preparation and its failed cleanup must both be reported");

        assert!(
            error
                .to_string()
                .contains("destination is not a regular file")
        );
        assert!(
            error
                .to_string()
                .contains("forced staged-sidecar unlink failure")
        );
        assert!(error.to_string().contains("first.ts"));
        assert!(error.to_string().contains("second.ts"));
        assert_eq!(
            sync_calls, 1,
            "the marker must not be removed after sidecar cleanup fails"
        );
        assert_eq!(fs::read(&first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(&second).unwrap(), b"second sentinel");
        assert!(marker.exists());
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".bindings-gen-"))
                .count(),
            2,
            "every failed sidecar must remain inspectable"
        );
    }

    #[test]
    fn failed_staging_returns_its_owned_sidecar_for_explicit_cleanup() {
        let root = TempRoot::new("failed_staging_ownership");
        let destination = root.path().join("contracts.ts");

        let failure = stage_bytes_with(&destination, "new", |_, _| {
            Err(io::Error::other("forced staged-file persistence failure"))
        })
        .expect_err("the persistence seam must fail after reserving a sidecar");

        assert!(
            failure
                .error
                .to_string()
                .contains("forced staged-file persistence failure")
        );
        let sidecar = failure
            .sidecar
            .expect("a post-creation failure must return its owned sidecar");
        assert!(sidecar.exists());
        fs::remove_file(sidecar).unwrap();
    }

    #[test]
    fn failed_artifact_cleanup_failure_is_reported_before_preserving_marker() {
        let root = TempRoot::new("failed_artifact_cleanup_failure");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.ts");
        let failed_sidecar = root.path().join(".second.ts.bindings-gen-forced-new");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut preparations = 0;

        let error = plan
            .publish_with_prepare_io(
                replace_file,
                |_| Ok(()),
                |path| {
                    if path == failed_sidecar {
                        Err(io::Error::other("forced failed-artifact unlink failure"))
                    } else {
                        fs::remove_file(path)
                    }
                },
                |artifact| {
                    preparations += 1;
                    if preparations == 1 {
                        return prepare_artifact(artifact);
                    }
                    fs::write(&failed_sidecar, b"partial staged bytes").unwrap();
                    Err(ArtifactPreparationFailure {
                        error: io::Error::other("forced artifact staging failure"),
                        staged: vec![failed_sidecar.clone()],
                    })
                },
            )
            .expect_err("the staging and cleanup failures must both be reported");

        assert!(
            error
                .to_string()
                .contains("forced artifact staging failure")
        );
        assert!(
            error
                .to_string()
                .contains("forced failed-artifact unlink failure")
        );
        assert!(
            error
                .to_string()
                .contains(&failed_sidecar.display().to_string())
        );
        assert!(marker.exists());
        assert!(failed_sidecar.exists());
        assert_eq!(fs::read(first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(second).unwrap(), b"second sentinel");
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".bindings-gen-"))
                .count(),
            1,
            "the earlier sidecar must be cleaned while the failed one remains as evidence"
        );
    }

    #[test]
    #[expect(
        clippy::disallowed_methods,
        reason = "the test proves an unwinding preparation leaves the marker and sidecars"
    )]
    fn preparation_unwind_preserves_marker_and_staged_sidecars() {
        let root = TempRoot::new("preparation_unwind");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut preparations = 0;

        let unwound = catch_unwind(AssertUnwindSafe(|| {
            let _ = plan.publish_with_prepare_io(
                replace_file,
                |_| Ok(()),
                |path| fs::remove_file(path),
                |artifact| {
                    preparations += 1;
                    if preparations == 2 {
                        panic!("forced preparation unwind");
                    }
                    prepare_artifact(artifact)
                },
            );
        }));

        assert!(unwound.is_err());
        assert!(marker.exists());
        assert_eq!(fs::read(first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(second).unwrap(), b"second sentinel");
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".bindings-gen-"))
                .count(),
            1,
            "the marker must retain ownership evidence for the staged sidecar"
        );
    }

    #[test]
    fn rollback_cleanup_failure_is_reported_before_preserving_marker() {
        let root = TempRoot::new("rollback_cleanup_failure");
        let first = root.path().join("first.ts");
        let second = root.path().join("second.ts");
        let marker = root.path().join("publication.in-progress");
        fs::write(&first, b"first sentinel").unwrap();
        fs::write(&second, b"second sentinel").unwrap();

        let mut plan = GenerationPlan::new_with_marker(marker.clone());
        plan.add(first.clone(), b"new first".to_vec()).unwrap();
        plan.add(second.clone(), b"new second".to_vec()).unwrap();
        let mut replacements = 0;

        let error = plan
            .publish_with_cleanup_io(
                |source, destination| {
                    replacements += 1;
                    if replacements == 2 {
                        return Err(io::Error::other("forced publication failure"));
                    }
                    replace_file(source, destination)
                },
                |_| Ok(()),
                |path| {
                    if path.exists() {
                        Err(io::Error::other("forced rollback-sidecar unlink failure"))
                    } else {
                        fs::remove_file(path)
                    }
                },
            )
            .expect_err("failed rollback cleanup must remain observable");

        assert!(error.to_string().contains("rollback was incomplete"));
        assert!(
            error
                .to_string()
                .contains("forced rollback-sidecar unlink failure")
        );
        assert!(marker.exists());
        assert_eq!(fs::read(&first).unwrap(), b"first sentinel");
        assert_eq!(fs::read(&second).unwrap(), b"second sentinel");
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with("-new"))
                .count(),
            1,
        );
    }
}
