//! The reader release's session over a data folder, for the rollback harness
//! (`desktop/tests/rollback_reader.rs`; contracts §11 Rollback harness, 2.1-M484). Not app API.
//!
//! It runs the app's own launch and open paths, never a copy of them: the stores open through
//! `services::health::open_stores` and `LidarLibrary::open` as `run()`'s setup opens them, then
//! the reads the page makes at Start (settings, Recent Designs, the Data library snapshot, the
//! Draft list), then each Draft and each named Design file opened as the open commands do. Each
//! of those writes nothing to a store a newer Canopi wrote, so the session writes no byte there.
//!
//! Two launch steps are left out: `ImageCache::new`, since the image cache is a derived store
//! with no stored form for a newer Canopi to leave behind, and `LidarLibrary::attach_executor`,
//! which only hands the library the executor its jobs run on and neither reads nor writes.
//!
//! It reports what the page is handed, not the notices the page raises from it: that each
//! newer-read-only store raises its notice is held by the presentation tests
//! (`failures/health-presentation.test.ts` `every_health_status_has_one_message`, and
//! `app/document-session/read-only-chrome.test.tsx` for the `newer-version` Read-only label).

use canopi_types::design::DesignLoadFailure;
use canopi_types::health::{StoreId, StoreOpenStatus};
use std::path::{Path, PathBuf};

use crate::design::{drafts::DesignDrafts, format::OpenedDesign};
use crate::services;

/// How the session read one store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreRead {
    /// The store's literal: a `StoreId` (`user_db`, `settings`, `library_catalogue`), or
    /// `desktop_draft` and `canopi_file` for a Draft and a Design file.
    pub store: String,
    /// How the store opened: a health store's startup status as the page is handed it; for a
    /// Design or Draft, `ready` when it opens to edit, `newer_read_only` when it opens as its
    /// read view, `refused_newer` when this build's read refuses a newer one.
    pub status: StoreOpenStatus,
    /// For a Design or Draft opened as its read view, the format version that saved it
    /// (`ReadOnlyDesign::saved_by_version`): what opens the page's read-only Session with
    /// `origin: 'newer-version'` (`app/document-session/load-result.ts`) and its Read-only label.
    pub saved_by_version: Option<u32>,
}

/// One reader session over `data_dir` (the app data folder) and the Design files `designs`.
/// An error is a store the app could not open at all (its startup refusal) or a read that failed.
pub fn read_session(data_dir: &Path, designs: &[PathBuf]) -> Result<Vec<StoreRead>, String> {
    let (user_db, user_stores) = services::health::open_stores(data_dir)
        .map_err(|error| format!("the user DB did not open: {error}"))?;
    let library = services::lidar::LidarLibrary::open(data_dir)?;
    let mut reads: Vec<StoreRead> = user_stores
        .into_iter()
        .map(|(store, health)| (store, health.status))
        .chain([(StoreId::LibraryCatalogue, library.open_status().health())])
        .map(|(store, status)| health_read(store, status))
        .collect::<Result<_, _>>()?;

    services::settings::get_settings(&user_db)?;
    services::design_files::get_recent_files(&user_db)?;
    library.library_snapshot()?;

    let drafts = DesignDrafts::new(data_dir);
    for draft in drafts.list()? {
        reads.push(design_read("desktop_draft", drafts.load(&draft.id))?);
    }
    for design in designs {
        let path = design.to_string_lossy().into_owned();
        reads.push(design_read(
            "canopi_file",
            services::design_files::load_design(&user_db, path),
        )?);
    }
    Ok(reads)
}

fn health_read(store: StoreId, status: StoreOpenStatus) -> Result<StoreRead, String> {
    let store = serde_json::to_value(store)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or("a store id serializes as its literal")?;
    Ok(StoreRead {
        store,
        status,
        saved_by_version: None,
    })
}

/// A Draft or Design file as it opened; any refusal but a newer one fails the session.
fn design_read<T>(
    store: &str,
    opened: Result<OpenedDesign<T>, DesignLoadFailure>,
) -> Result<StoreRead, String> {
    use canopi_types::design::DesignLoadFailureKind;
    let (status, saved_by_version) = match opened {
        Ok(OpenedDesign::Editable(_)) => (StoreOpenStatus::Ready, None),
        Ok(OpenedDesign::ReadOnly(design)) => (
            StoreOpenStatus::NewerReadOnly,
            Some(design.saved_by_version),
        ),
        Err(failure) if failure.kind == DesignLoadFailureKind::NewerVersion => {
            (StoreOpenStatus::RefusedNewer, None)
        }
        Err(failure) => {
            return Err(format!(
                "a {store} did not open ({:?}): {}",
                failure.kind, failure.message
            ));
        }
    };
    Ok(StoreRead {
        store: store.to_owned(),
        status,
        saved_by_version,
    })
}
