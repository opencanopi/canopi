use crate::AppHealth;
use canopi_types::failure::{FailureCode, PlantCatalogCause};
use canopi_types::health::{PlantDbStatus, StoreHealth, StoreId, StoreOpenStatus, SubsystemHealth};

/// The store health the host reports (`crate::AppHealth`): the startup snapshot, whose one later
/// change is a one-time notice the user dismissed this run (`dismiss_store_notice`).
impl AppHealth {
    pub fn new(startup: SubsystemHealth) -> Self {
        Self(std::sync::Mutex::new(startup))
    }

    /// The health holds plain values that no panic leaves half written, so a poisoned lock is
    /// still read.
    fn lock(&self) -> std::sync::MutexGuard<'_, SubsystemHealth> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Each store's health as the host reports it now: the startup snapshot, less the one-time notices
/// dismissed this run.
pub fn get_health(health: &AppHealth) -> SubsystemHealth {
    health.lock().clone()
}

/// Forgets `store`'s one-time notice for the rest of the run; its status stays.
pub fn dismiss_store_notice(health: &AppHealth, store: StoreId) {
    if let Some(entry) = health.lock().0.get_mut(&store) {
        entry.notice = None;
    }
}

/// The plant catalog's entry in `SubsystemHealth`, from the plant DB handle's own state:
/// ready, or unavailable as `missing` or `open_failed`.
pub(crate) fn plant_catalog(status: PlantDbStatus) -> StoreHealth {
    let cause = match status {
        PlantDbStatus::Available => {
            return StoreHealth {
                status: StoreOpenStatus::Ready,
                notice: None,
            };
        }
        PlantDbStatus::Missing => PlantCatalogCause::Missing,
        PlantDbStatus::Corrupt => PlantCatalogCause::OpenFailed,
    };
    let code = FailureCode::PlantDbUnavailable { cause };
    StoreHealth {
        status: StoreOpenStatus::Unavailable { code },
        notice: None,
    }
}

/// The health of a start where every store the Desktop opens came up ready.
#[cfg(test)]
pub(crate) fn all_ready() -> SubsystemHealth {
    use canopi_types::health::StoreId;
    let ready = || StoreHealth {
        status: StoreOpenStatus::Ready,
        notice: None,
    };
    SubsystemHealth(std::collections::BTreeMap::from([
        (StoreId::PlantCatalog, ready()),
        (StoreId::UserDb, ready()),
        (StoreId::LibraryCatalogue, ready()),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plant_catalog_entry_is_ready_missing_or_open_failed() {
        let entry = |status| super::plant_catalog(status).status;
        assert_eq!(entry(PlantDbStatus::Available), StoreOpenStatus::Ready);
        for (status, cause) in [
            (PlantDbStatus::Missing, PlantCatalogCause::Missing),
            (PlantDbStatus::Corrupt, PlantCatalogCause::OpenFailed),
        ] {
            let code = FailureCode::PlantDbUnavailable { cause };
            assert_eq!(entry(status), StoreOpenStatus::Unavailable { code });
            assert_eq!(super::plant_catalog(status).notice, None);
        }
    }
}
