//! Design drafts: Untitled Designs kept in app data until they are saved as a
//! file or deleted. Each draft is `{app_data}/drafts/<id>.canopi` in the same
//! `.canopi` wire format, encoder, durable write and load admission as a Design file.

use canopi_types::design::{
    CanopiFile, DesignDraftSummary, DesignLoadFailure, DesignLoadFailureKind,
};
use std::path::{Path, PathBuf};

use super::format;

const DRAFTS_DIR: &str = "drafts";
const DRAFT_EXTENSION: &str = "canopi";
const MAX_DRAFT_ID_LEN: usize = 64;
const UNTITLED_DRAFT_NAME: &str = "Untitled";

/// The drafts store (`{app_data}/drafts`), managed as Tauri state.
#[derive(Debug, Clone)]
pub struct DesignDrafts {
    dir: PathBuf,
}

/// A draft id is `[a-z0-9-]{1,64}`, so it can only name a file directly
/// inside the drafts store.
fn is_valid_draft_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_DRAFT_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn draft_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_valid_draft_id(id) {
        return Err("Invalid Design draft id".to_owned());
    }
    Ok(dir.join(format!("{id}.{DRAFT_EXTENSION}")))
}

/// The Design Drafts folder under the app data directory.
pub(crate) fn drafts_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DRAFTS_DIR)
}

impl DesignDrafts {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            dir: drafts_root(app_data_dir),
        }
    }

    /// Durably write the draft `id`, creating the store when needed.
    pub(crate) fn save(&self, id: &str, content: &CanopiFile) -> Result<(), String> {
        let dir = self.dir.as_path();
        let path = draft_path(dir, id)?;
        let bytes = format::encode_design(content)?;
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create the drafts store: {e}"))?;
        super::with_write_admission(&path, || super::write_file_durably(&path, &bytes, "tmp"))
            .map_err(|e| format!("Failed to save the Design draft: {e}"))
    }

    /// Load the draft `id` with the same size cap and version admission as a
    /// Design file, its refusal typed as a Design file's is (canopi-cyqd).
    pub(crate) fn load(&self, id: &str) -> Result<CanopiFile, DesignLoadFailure> {
        let path = draft_path(&self.dir, id).map_err(|message| DesignLoadFailure {
            kind: DesignLoadFailureKind::Missing,
            message,
            field_path: None,
        })?;
        format::load_from_file(&path).map_err(|error| error.failure())
    }

    /// Every readable draft, most recently written first. A draft that cannot be
    /// read or decoded is skipped with a warning instead of failing the list; a
    /// draft from before Canopi 2.0 stays in place, unread (ADR 0021), and is
    /// skipped quietly.
    pub(crate) fn list(&self) -> Result<Vec<DesignDraftSummary>, String> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("Failed to read the drafts store: {error}")),
        };
        let mut drafts = Vec::new();
        for entry in entries {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(error) => {
                    tracing::warn!("Skipped an unreadable Design draft entry: {error}");
                    continue;
                }
            };
            let Some(id) = draft_id_of(&path) else {
                continue;
            };
            // Names and paths are user content; logs reach Diagnostic Bundles.
            match summarize_draft(&path, id) {
                Ok(draft) => drafts.push(draft),
                Err(DraftSkip::BeforeCanopi2) => {
                    tracing::debug!("Skipped a Design draft from before Canopi 2.0")
                }
                Err(DraftSkip::Unreadable) => tracing::warn!("Skipped an unreadable Design draft"),
            }
        }
        drafts.sort_by(|(left_time, left), (right_time, right)| {
            right_time
                .cmp(left_time)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(drafts.into_iter().map(|(_, draft)| draft).collect())
    }

    /// Delete the draft `id`. Deleting a draft that is already gone succeeds.
    pub(crate) fn delete(&self, id: &str) -> Result<(), String> {
        let path = draft_path(&self.dir, id)?;
        super::with_write_admission(&path, || match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to delete the Design draft: {error}")),
        })
    }
}

/// The draft id a store entry names, or `None` for anything else (temporary
/// sidecars, other files).
fn draft_id_of(path: &Path) -> Option<&str> {
    if path.extension().and_then(|extension| extension.to_str()) != Some(DRAFT_EXTENSION) {
        return None;
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| is_valid_draft_id(stem))
}

/// Why a store entry is not listed.
enum DraftSkip {
    /// Saved in a `.canopi` format before Canopi 2.0: left in place, unread.
    BeforeCanopi2,
    Unreadable,
}

fn summarize_draft(
    path: &Path,
    id: &str,
) -> Result<(std::time::SystemTime, DesignDraftSummary), DraftSkip> {
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|_| DraftSkip::Unreadable)?;
    let file = format::load_from_file(path).map_err(|error| {
        if error.failure().kind == canopi_types::design::DesignLoadFailureKind::OlderVersion {
            DraftSkip::BeforeCanopi2
        } else {
            DraftSkip::Unreadable
        }
    })?;
    let name = if file.name.trim().is_empty() {
        UNTITLED_DRAFT_NAME.to_owned()
    } else {
        file.name
    };
    let seconds = modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok((
        modified,
        DesignDraftSummary {
            id: id.to_owned(),
            name,
            updated_at: super::unix_to_iso8601(seconds),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::TestScratch;
    use std::fs;

    fn unique_dir(label: &str) -> TestScratch {
        TestScratch::new(&format!("drafts-{label}"))
    }

    fn design(name: &str) -> CanopiFile {
        format::create_new_design(name, "2026-09-25T00:00:00Z")
    }

    fn set_modified(path: &Path, seconds: u64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    #[test]
    fn a_draft_round_trips_through_the_design_wire_format() {
        let root = unique_dir("round_trip");
        let drafts = DesignDrafts::new(&root);
        let dir = drafts.dir.clone();

        drafts.save("draft-1", &design("Orchard sketch")).unwrap();

        let path = dir.join("draft-1.canopi");
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            bytes,
            format::encode_design(&design("Orchard sketch")).unwrap()
        );
        assert_eq!(drafts.load("draft-1").unwrap().name, "Orchard sketch");
        let names = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, ["draft-1.canopi"], "no temporary is left behind");

        drafts
            .save("draft-1", &design("Orchard sketch, later"))
            .unwrap();
        assert_eq!(
            drafts.load("draft-1").unwrap().name,
            "Orchard sketch, later"
        );
    }

    #[test]
    fn draft_ids_that_could_leave_the_store_are_refused() {
        let root = unique_dir("traversal");
        let drafts = DesignDrafts::new(&root);
        let dir = drafts.dir.clone();
        fs::create_dir_all(&dir).unwrap();
        let outside = root.join("outside.canopi");
        format::save_to_file(&outside, &design("Outside"), None).unwrap();
        let too_long = "a".repeat(MAX_DRAFT_ID_LEN + 1);

        for id in [
            "",
            "../outside",
            "..",
            ".",
            "a/b",
            "a\\b",
            "/tmp/x",
            "Draft",
            "draft_1",
            "draft.1",
            "draft 1",
            "draft\0",
            "é",
            too_long.as_str(),
        ] {
            assert!(drafts.save(id, &design("Escaped")).is_err(), "{id:?}");
            assert!(drafts.load(id).is_err(), "{id:?}");
            assert!(drafts.delete(id).is_err(), "{id:?}");
        }

        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(format::load_from_file(&outside).unwrap().name, "Outside");
        assert!(
            drafts
                .save(&"a".repeat(MAX_DRAFT_ID_LEN), &design("Longest"))
                .is_ok()
        );
    }

    #[test]
    fn drafts_list_newest_first_with_names_and_utc_times() {
        let root = unique_dir("list");
        let drafts = DesignDrafts::new(&root);
        let dir = drafts.dir.clone();
        drafts.save("older", &design("Older")).unwrap();
        drafts.save("newer", &design("Newer")).unwrap();
        drafts.save("unnamed", &design("  ")).unwrap();
        set_modified(&dir.join("older.canopi"), 1_700_000_000);
        set_modified(&dir.join("newer.canopi"), 1_800_000_000);
        set_modified(&dir.join("unnamed.canopi"), 1_750_000_000);

        let drafts = drafts.list().unwrap();

        let listed = drafts
            .iter()
            .map(|draft| {
                (
                    draft.id.as_str(),
                    draft.name.as_str(),
                    draft.updated_at.as_str(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            [
                ("newer", "Newer", "2027-01-15T08:00:00Z"),
                ("unnamed", "Untitled", "2025-06-15T15:06:40Z"),
                ("older", "Older", "2023-11-14T22:13:20Z"),
            ]
        );
    }

    #[test]
    fn a_missing_store_lists_no_drafts() {
        let root = unique_dir("missing_store");
        assert!(DesignDrafts::new(&root).list().unwrap().is_empty());
    }

    #[test]
    fn unreadable_drafts_are_skipped_without_logging_names_or_paths() {
        let root = unique_dir("corrupt");
        let drafts = DesignDrafts::new(&root);
        let dir = drafts.dir.clone();
        drafts.save("good", &design("Good")).unwrap();
        fs::write(dir.join("corrupt.canopi"), "{ not json").unwrap();
        let mut old_version = serde_json::to_value(design("Secret Orchard")).unwrap();
        old_version["version"] = serde_json::json!(6);
        fs::write(
            dir.join("old-version.canopi"),
            serde_json::to_vec(&old_version).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("notes.txt"), "not a draft").unwrap();
        fs::write(dir.join("Bad_Id.canopi"), "not a draft id").unwrap();

        let (drafts, logs) = crate::services::design_files::capture_logs(|| drafts.list());

        let drafts = drafts.unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].id, "good");
        assert_eq!(
            logs.matches("Skipped an unreadable Design draft").count(),
            1,
            "{logs}"
        );
        assert!(!logs.contains("Secret Orchard"), "{logs}");
        assert!(!logs.contains(&*root.to_string_lossy()), "{logs}");
    }

    /// Canopi 2.0 leaves Drafts from before 2.0 in place, unread (ADR 0021):
    /// they are not listed, and listing them is no fault worth a warning.
    #[test]
    fn earlier_drafts_stay_in_place_unlisted_and_log_no_warning() {
        let root = unique_dir("before_2_0");
        let drafts = DesignDrafts::new(&root);
        drafts.save("current", &design("Current")).unwrap();
        let dir = drafts.dir.clone();
        let mut older = serde_json::to_value(design("Preview")).unwrap();
        older["version"] = serde_json::json!(canopi_types::design::CURRENT_CANOPI_FILE_VERSION - 1);
        let older = serde_json::to_vec(&older).unwrap();
        fs::write(dir.join("preview.canopi"), &older).unwrap();

        let (listed, logs) = crate::services::design_files::capture_logs(|| drafts.list());

        let ids = listed
            .unwrap()
            .into_iter()
            .map(|draft| draft.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["current"]);
        assert!(!logs.contains("WARN"), "{logs}");
        assert!(
            logs.contains("DEBUG") && logs.contains("before Canopi 2.0"),
            "{logs}"
        );
        assert_eq!(fs::read(dir.join("preview.canopi")).unwrap(), older);
        let mut entries = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(entries, ["drafts"], "nothing is moved aside");
    }

    #[test]
    fn loading_a_draft_uses_design_file_admission() {
        let root = unique_dir("admission");
        let drafts = DesignDrafts::new(&root);
        let dir = drafts.dir.clone();
        fs::create_dir_all(&dir).unwrap();
        let mut old_version = serde_json::to_value(design("Old")).unwrap();
        old_version["version"] =
            serde_json::json!(canopi_types::design::CURRENT_CANOPI_FILE_VERSION - 1);
        fs::write(
            dir.join("old.canopi"),
            serde_json::to_vec(&old_version).unwrap(),
        )
        .unwrap();
        let huge = fs::File::create(dir.join("huge.canopi")).unwrap();
        huge.set_len(format::MAX_CANOPI_FILE_BYTES + 1).unwrap();
        drop(huge);

        let old = drafts.load("old").unwrap_err();
        assert_eq!(old.kind, DesignLoadFailureKind::OlderVersion);
        assert!(old.message.contains("unsupported_version"), "{old:?}");
        let huge = drafts.load("huge").unwrap_err();
        assert_eq!(huge.kind, DesignLoadFailureKind::TooLarge);
        assert!(huge.message.contains("64 MiB"), "{huge:?}");
        assert_eq!(
            drafts.load("absent").unwrap_err().kind,
            DesignLoadFailureKind::Missing
        );
    }

    /// canopi-cyqd: a refused draft keeps the typed failure a Design file's refusal has,
    /// its refused field included.
    #[test]
    fn canopi_cyqd_a_refused_draft_keeps_its_typed_failure() {
        let root = unique_dir("typed-refusal");
        let drafts = DesignDrafts::new(&root);
        let dir = drafts.dir.clone();
        fs::create_dir_all(&dir).unwrap();
        let mut refused = serde_json::to_value(design("Refused")).unwrap();
        refused["plants"] = serde_json::json!(3);
        fs::write(
            dir.join("refused.canopi"),
            serde_json::to_vec(&refused).unwrap(),
        )
        .unwrap();

        let failure = drafts.load("refused").unwrap_err();
        assert_eq!(failure.kind, DesignLoadFailureKind::InvalidDocument);
        let path = failure.field_path.map(|path| path.to_string());
        assert_eq!(path.as_deref(), Some("$.plants"));
        assert_eq!(
            drafts.load("Not An Id").unwrap_err().kind,
            DesignLoadFailureKind::Missing
        );
    }

    #[test]
    fn deleting_a_draft_removes_it_and_is_idempotent() {
        let root = unique_dir("delete");
        let drafts = DesignDrafts::new(&root);
        drafts.save("gone", &design("Gone")).unwrap();
        drafts.save("kept", &design("Kept")).unwrap();

        drafts.delete("gone").unwrap();
        drafts.delete("gone").unwrap();

        let ids = drafts
            .list()
            .unwrap()
            .into_iter()
            .map(|draft| draft.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["kept"]);
    }
}
