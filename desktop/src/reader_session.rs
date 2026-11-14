//! The reader release's session over a data folder, for the rollback harness
//! (`desktop/tests/rollback_reader.rs`; contracts §11 Rollback harness, 2.1-M484). Not app API.
//!
//! It runs the app's own launch and open paths, never a copy of them: the stores open through
//! `services::health::open_stores` and `LidarLibrary::open` as `run()`'s setup opens them, then
//! the reads the page makes at Start (settings, Recent Designs, the Data library snapshot, the
//! Draft list), then each Draft and each named Design file opened as the open commands do. Each
//! of those writes nothing to a store a newer Canopi wrote, so the session writes no byte there.

use canopi_types::design::DesignLoadFailure;
use canopi_types::health::{StoreHealth, StoreId, StoreOpenStatus};
use std::path::{Path, PathBuf};

use crate::design::{drafts::DesignDrafts, format::OpenedDesign};
use crate::services;

/// How the session read one store: its open status and, when it read newer-read-only, the key
/// of the notice that tells the user so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreRead {
    /// The store's literal: a `StoreId` (`user_db`, `settings`, `library_catalogue`), or
    /// `desktop_draft` and `canopi_file` for a Draft and a Design file.
    pub store: String,
    /// How the store opened.
    pub status: StoreOpenStatus,
    /// The newer-read-only notice's key, naming the store as one `:`-separated segment: a
    /// health store's status notice key (`health:<store>:status:<status JSON>`, as
    /// `failures/health-presentation.ts` keys it), or for a Design the read-only Session kind
    /// it opens in (`session:<store>:read-only:newer-version`, `app/document-session/load-result.ts`).
    pub notice: Option<String>,
}

/// One reader session over `data_dir` (the app data folder) and the Design files `designs`.
/// An error is a store the app could not open at all (its startup refusal) or a read that failed.
pub fn read_session(data_dir: &Path, designs: &[PathBuf]) -> Result<Vec<StoreRead>, String> {
    let (user_db, user_stores) = services::health::open_stores(data_dir)
        .map_err(|error| format!("the user DB did not open: {error}"))?;
    let library = services::lidar::LidarLibrary::open(data_dir)?;
    let mut reads: Vec<StoreRead> = user_stores
        .into_iter()
        .chain([(
            StoreId::LibraryCatalogue,
            StoreHealth {
                status: library.open_status().health(),
                notice: None,
            },
        )])
        .map(|(store, health)| health_read(store, health.status))
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
    let literal = |value: serde_json::Value| value.as_str().map(str::to_owned);
    let store = serde_json::to_value(store)
        .ok()
        .and_then(literal)
        .ok_or("a store id serializes as its literal")?;
    let notice = match status {
        StoreOpenStatus::NewerReadOnly => {
            let status = serde_json::to_string(&status).map_err(|error| error.to_string())?;
            Some(format!("health:{store}:status:{status}"))
        }
        _ => None,
    };
    Ok(StoreRead {
        store,
        status,
        notice,
    })
}

/// A Draft or Design file as it opened: editable is ready, a newer one's read view is
/// newer-read-only, a newer one whose read this build refuses is refused-newer; any other
/// refusal fails the session.
fn design_read<T>(
    store: &str,
    opened: Result<OpenedDesign<T>, DesignLoadFailure>,
) -> Result<StoreRead, String> {
    use canopi_types::design::DesignLoadFailureKind;
    let (status, notice) = match opened {
        Ok(OpenedDesign::Editable(_)) => (StoreOpenStatus::Ready, None),
        Ok(OpenedDesign::ReadOnly(_)) => (
            StoreOpenStatus::NewerReadOnly,
            Some(format!("session:{store}:read-only:newer-version")),
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
        notice,
    })
}
