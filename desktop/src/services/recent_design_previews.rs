//! Start › Recent Designs previews: plant and zone counts, ground bounds and a
//! symbolic sketch, read from each Design's file when the list is shown.
//!
//! Nothing is stored in the user database. Previews are cached in memory by
//! path, modification time and size, so an unchanged file is read once per
//! session. Logs never name a Design or its path.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::SystemTime,
};

use canopi_types::design::{
    RecentDesignPreview, RecentDesignSummary, RecentDesignUnreadableReason,
};

use crate::design::format::{self, DesignLoadError, OpenedDesign};

/// Files larger than this are not read for a preview; the row shows the name only.
pub(crate) const RECENT_PREVIEW_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// Cached previews kept at most; Recent Designs lists 20.
const PREVIEW_CACHE_LIMIT: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

struct CachedPreview {
    stamp: FileStamp,
    preview: RecentDesignPreview,
}

/// Managed state: the in-memory preview cache.
#[derive(Clone, Default)]
pub struct RecentDesignPreviews {
    cache: Arc<Mutex<HashMap<String, CachedPreview>>>,
}

impl RecentDesignPreviews {
    /// Previews of `paths`, in order. Blocking file work: run it in the executor.
    pub(crate) fn previews(&self, paths: &[String]) -> Vec<RecentDesignSummary> {
        paths
            .iter()
            .map(|path| RecentDesignSummary {
                path: path.clone(),
                preview: self.preview(path),
            })
            .collect()
    }

    fn preview(&self, path: &str) -> RecentDesignPreview {
        let stamp = match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => FileStamp {
                modified: metadata.modified().ok(),
                len: metadata.len(),
            },
            Ok(_) => return unreadable(RecentDesignUnreadableReason::Unknown),
            Err(error) => return unreadable(io_reason(&error)),
        };
        if let Some(cached) = self.cached(path, stamp) {
            return cached;
        }
        let (preview, cacheable) = read_preview(Path::new(path), stamp.len);
        if cacheable {
            let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            if cache.len() >= PREVIEW_CACHE_LIMIT && !cache.contains_key(path) {
                cache.clear();
            }
            cache.insert(
                path.to_owned(),
                CachedPreview {
                    stamp,
                    preview: preview.clone(),
                },
            );
        }
        preview
    }

    fn cached(&self, path: &str, stamp: FileStamp) -> Option<RecentDesignPreview> {
        let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .get(path)
            .filter(|cached| cached.stamp == stamp && stamp.modified.is_some())
            .map(|cached| cached.preview.clone())
    }

    #[cfg(test)]
    fn cached_len(&self) -> usize {
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// The preview and whether it describes the file's content (and may be
/// cached), rather than a read error that could clear without the file changing.
fn read_preview(path: &Path, len: u64) -> (RecentDesignPreview, bool) {
    if len > RECENT_PREVIEW_MAX_BYTES {
        return (RecentDesignPreview::TooLarge, true);
    }
    match format::open_within(path, RECENT_PREVIEW_MAX_BYTES) {
        Ok(OpenedDesign::Editable(file)) => (crate::design::preview::preview_of(&file), true),
        // A newer Design opens read-only (2.1-Q316); its row says newer by its reason until a
        // read-only preview has a wire state. A version-10 file the read refuses is damaged,
        // as Open says.
        Ok(OpenedDesign::ReadOnly(_)) => {
            (unreadable(RecentDesignUnreadableReason::NewerVersion), true)
        }
        Err(DesignLoadError::NewerRefused { source }) => {
            let reason = match source.kind {
                canopi_types::design::DesignLoadFailureKind::NewerVersion => {
                    RecentDesignUnreadableReason::NewerVersion
                }
                _ => RecentDesignUnreadableReason::Damaged,
            };
            tracing::info!(
                ?reason,
                "A newer Recent Design could not be read; no preview"
            );
            (unreadable(reason), true)
        }
        Err(DesignLoadError::TooLarge { .. }) => (RecentDesignPreview::TooLarge, true),
        Err(DesignLoadError::Read { source, .. }) => {
            tracing::warn!("A Recent Design could not be read for its preview");
            (unreadable(io_reason(&source)), false)
        }
        Err(DesignLoadError::InvalidJson { .. }) => {
            tracing::info!("A Recent Design is not a Design file; no preview");
            (unreadable(RecentDesignUnreadableReason::Damaged), true)
        }
        Err(DesignLoadError::Ingestion { source, .. }) => {
            let reason = match source.found_unsupported_version() {
                Some(_) if source.is_older_than_supported() => {
                    RecentDesignUnreadableReason::OlderVersion
                }
                Some(_) => RecentDesignUnreadableReason::NewerVersion,
                None => RecentDesignUnreadableReason::Damaged,
            };
            tracing::info!(
                ?reason,
                "A Recent Design is not a current Design file; no preview"
            );
            (unreadable(reason), true)
        }
    }
}

fn unreadable(reason: RecentDesignUnreadableReason) -> RecentDesignPreview {
    RecentDesignPreview::Unreadable { reason }
}

fn io_reason(error: &std::io::Error) -> RecentDesignUnreadableReason {
    if error.kind() == std::io::ErrorKind::NotFound {
        RecentDesignUnreadableReason::Missing
    } else {
        RecentDesignUnreadableReason::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::TestScratch;
    use canopi_types::design::{CURRENT_CANOPI_FILE_VERSION, CanopiFile};

    fn scratch(label: &str) -> TestScratch {
        TestScratch::new(&format!("recent-previews-{label}"))
    }

    fn with_plants(count: usize) -> CanopiFile {
        let mut file = format::create_new_design("Orchard", "2026-09-27T00:00:00Z");
        file.plants = (0..count)
            .map(|index| {
                serde_json::from_value(serde_json::json!({
                    "id": format!("plant-{index}"),
                    "canonical_name": "Malus domestica",
                    "position": { "lon": 0.1 + index as f64 * 1e-5, "lat": 47.0 },
                }))
                .unwrap()
            })
            .collect();
        file
    }

    fn write(path: &Path, file: &CanopiFile) {
        std::fs::write(path, format::encode_design(file).unwrap()).unwrap();
    }

    fn plant_count(preview: &RecentDesignPreview) -> Option<u32> {
        match preview {
            RecentDesignPreview::Read { plant_count, .. } => Some(*plant_count),
            _ => None,
        }
    }

    #[test]
    fn previews_follow_the_file_and_are_cached_until_it_changes() {
        let root = scratch("cache");
        let path = root.join("orchard.canopi");
        write(&path, &with_plants(3));
        let previews = RecentDesignPreviews::default();
        let listed = vec![path.to_string_lossy().into_owned()];

        let first = previews.previews(&listed);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].path, listed[0]);
        assert_eq!(plant_count(&first[0].preview), Some(3));
        assert_eq!(previews.cached_len(), 1);

        // A different size is a different file: it is read again.
        write(&path, &with_plants(5));
        assert_eq!(plant_count(&previews.previews(&listed)[0].preview), Some(5));
    }

    #[test]
    fn unreadable_files_say_why_without_logging_their_paths() {
        let root = scratch("unreadable");
        let garbage = root.join("garbage.canopi");
        std::fs::write(&garbage, "not json").unwrap();
        let invalid = root.join("invalid.canopi");
        std::fs::write(
            &invalid,
            format!(r#"{{"version": {CURRENT_CANOPI_FILE_VERSION}, "plants": 3}}"#),
        )
        .unwrap();
        let old = root.join("old.canopi");
        std::fs::write(&old, r#"{"version": 4, "name": "Canopi 1.1"}"#).unwrap();
        let unversioned = root.join("unversioned.canopi");
        std::fs::write(&unversioned, r#"{"name": "Canopi 1"}"#).unwrap();
        let newer = root.join("newer.canopi");
        std::fs::write(
            &newer,
            format!(
                r#"{{"version": {}, "name": "Next"}}"#,
                CURRENT_CANOPI_FILE_VERSION + 1
            ),
        )
        .unwrap();
        // canopi-f47t.52.270: a newer Design the read refuses says why as Open would.
        let newer_refused = root.join("newer-refused.canopi");
        let refused = |version: u32| format!(r#"{{"version": {version}, "plants": 3}}"#);
        std::fs::write(&newer_refused, refused(CURRENT_CANOPI_FILE_VERSION + 1)).unwrap();
        let later_refused = root.join("later-refused.canopi");
        std::fs::write(&later_refused, refused(CURRENT_CANOPI_FILE_VERSION + 2)).unwrap();
        let moved = root.join("moved.canopi");
        let previews = RecentDesignPreviews::default();
        let paths = [
            &garbage,
            &invalid,
            &old,
            &unversioned,
            &newer,
            &newer_refused,
            &later_refused,
            &moved,
            &root.path().to_path_buf(),
        ]
        .map(|path| path.to_string_lossy().into_owned());

        let (result, logs) =
            crate::services::design_files::capture_logs(|| previews.previews(&paths));
        let reasons: Vec<_> = result
            .iter()
            .map(|summary| summary.preview.clone())
            .collect();
        use RecentDesignUnreadableReason::*;
        assert_eq!(
            reasons,
            [
                Damaged,
                Damaged,
                OlderVersion,
                OlderVersion,
                NewerVersion,
                Damaged,
                NewerVersion,
                Missing,
                Unknown
            ]
            .map(unreadable)
        );
        assert!(!logs.contains(&*root.to_string_lossy()), "{logs}");
    }

    /// The 2.0 previews' formats (v7, v8) are not read through any ladder:
    /// their Recent Design cards say the file is older (ADR 0021).
    #[test]
    fn designs_from_before_2_0_preview_as_older_version() {
        let root = scratch("before-2-0");
        let paths: Vec<String> = [
            CURRENT_CANOPI_FILE_VERSION - 2,
            CURRENT_CANOPI_FILE_VERSION - 1,
        ]
        .into_iter()
        .map(|version| {
            let path = root.join(format!("v{version}.canopi"));
            let mut value = serde_json::to_value(with_plants(2)).unwrap();
            value["version"] = serde_json::json!(version);
            std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();
            path.to_string_lossy().into_owned()
        })
        .collect();
        let previews = RecentDesignPreviews::default();

        let result = previews.previews(&paths);

        assert_eq!(
            result
                .iter()
                .map(|summary| summary.preview.clone())
                .collect::<Vec<_>>(),
            [RecentDesignUnreadableReason::OlderVersion; 2].map(unreadable)
        );
    }

    #[test]
    fn a_file_over_the_preview_cap_is_not_read() {
        let root = scratch("large");
        let path = root.join("large.canopi");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(RECENT_PREVIEW_MAX_BYTES + 1).unwrap();
        let previews = RecentDesignPreviews::default();

        let result = previews.previews(&[path.to_string_lossy().into_owned()]);
        assert_eq!(result[0].preview, RecentDesignPreview::TooLarge);
    }

    #[test]
    fn the_cache_stays_bounded() {
        let root = scratch("bounded");
        let previews = RecentDesignPreviews::default();
        let paths: Vec<String> = (0..PREVIEW_CACHE_LIMIT + 5)
            .map(|index| {
                let path = root.join(format!("design-{index}.canopi"));
                write(&path, &with_plants(1));
                path.to_string_lossy().into_owned()
            })
            .collect();

        previews.previews(&paths);
        assert!(previews.cached_len() <= PREVIEW_CACHE_LIMIT);
    }
}
