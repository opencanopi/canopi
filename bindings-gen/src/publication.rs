//! Plain in-memory generation plan and per-file writer for `bindings-gen` (canopi-4nsh).
//!
//! All emitters render their bytes into memory before any file is touched. `publish`
//! writes only files whose on-disk bytes differ (via sibling temp + rename to prevent
//! torn reads); `check` compares every artifact in memory and lists every stale or
//! missing destination without modifying disk.

use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(crate) struct PublicationError(String);

impl fmt::Display for PublicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for PublicationError {}

struct GeneratedArtifact {
    path: PathBuf,
    contents: Vec<u8>,
}

pub(crate) struct GenerationPlan {
    root: PathBuf,
    artifacts: Vec<GeneratedArtifact>,
    seen: HashSet<PathBuf>,
}

impl GenerationPlan {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            artifacts: Vec::new(),
            seen: HashSet::new(),
        }
    }

    pub(crate) fn add(
        &mut self,
        path: PathBuf,
        contents: impl Into<Vec<u8>>,
    ) -> Result<(), PublicationError> {
        if !self.seen.insert(path.clone()) {
            return Err(PublicationError(format!(
                "duplicate generated destination: {}",
                path.display()
            )));
        }
        self.artifacts.push(GeneratedArtifact {
            path,
            contents: contents.into(),
        });
        Ok(())
    }

    pub(crate) fn publish(&self) -> Result<(), PublicationError> {
        for artifact in &self.artifacts {
            if matches!(fs::read(&artifact.path), Ok(existing) if existing == artifact.contents) {
                continue;
            }
            write_via_temp(&artifact.path, &artifact.contents).map_err(|error| {
                PublicationError(format!(
                    "failed to write {}: {error}",
                    self.display_relative(&artifact.path)
                ))
            })?;
        }
        Ok(())
    }

    pub(crate) fn check(&self) -> Result<(), PublicationError> {
        let mut stale = Vec::new();
        for artifact in &self.artifacts {
            let up_to_date =
                matches!(fs::read(&artifact.path), Ok(existing) if existing == artifact.contents);
            if !up_to_date {
                stale.push(self.display_relative(&artifact.path));
            }
        }
        if stale.is_empty() {
            return Ok(());
        }
        let mut message = String::from(
            "generated artifacts are stale; run `cd desktop/web && npm run gen:types`:\n",
        );
        for item in stale {
            message.push_str("- ");
            message.push_str(&item);
            message.push('\n');
        }
        Err(PublicationError(message))
    }

    fn display_relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }
}

fn write_via_temp(destination: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("artifact");
    let seq = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
    let tmp = destination.with_file_name(format!(".{file_name}.tmp.{}.{seq}", std::process::id()));
    if let Err(error) = fs::write(&tmp, contents) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp, destination) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let seq = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("canopi_pub_{name}_{}_{seq}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn check_reports_every_stale_destination_without_refreshing_destinations() {
        let root = TempDir::new("stale");
        let first = root.0.join("a/first.ts");
        let second = root.0.join("b/second.ts");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&first, b"old-first").unwrap();
        fs::write(&second, b"old-second").unwrap();

        let mut plan = GenerationPlan::new(&root.0);
        plan.add(first.clone(), b"new-first").unwrap();
        plan.add(second.clone(), b"new-second").unwrap();

        let err = plan.check().expect_err("stale artifacts must fail check");
        let message = err.to_string();
        assert!(message.contains("a/first.ts"), "{message}");
        assert!(message.contains("b/second.ts"), "{message}");
        assert!(message.contains("npm run gen:types"), "{message}");
        assert_eq!(fs::read(&first).unwrap(), b"old-first");
        assert_eq!(fs::read(&second).unwrap(), b"old-second");
    }

    #[test]
    fn check_reports_missing_empty_artifact_as_stale() {
        let root = TempDir::new("missing_empty");
        let empty = root.0.join("empty.ts");
        let mut plan = GenerationPlan::new(&root.0);
        plan.add(empty.clone(), Vec::new()).unwrap();

        let err = plan
            .check()
            .expect_err("missing empty artifact must fail check");
        assert!(err.to_string().contains("empty.ts"));
        assert!(!empty.exists());
    }

    #[test]
    fn publish_writes_and_check_passes_and_refuses_duplicate_destinations() {
        let root = TempDir::new("publish");
        let dest = root.0.join("sub/file.ts");
        let mut plan = GenerationPlan::new(&root.0);
        plan.add(dest.clone(), b"hello\n").unwrap();
        assert!(plan.add(dest.clone(), b"other\n").is_err());

        plan.publish().unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello\n");
        plan.check().unwrap();
    }
}
