use crate::AppHealth;
use canopi_types::failure::{FailureCode, PlantCatalogCause};
use canopi_types::health::{PlantDbStatus, StoreHealth, StoreId, StoreOpenStatus, SubsystemHealth};

/// The stores whose one-time notice the user dismissed this run.
pub type DismissedNotices = std::sync::Mutex<std::collections::BTreeSet<StoreId>>;

/// The store health the host reports (`crate::AppHealth`): `.0` the startup snapshot, never
/// changed, and `.1` the stores whose one-time notice the user dismissed this run
/// (`dismiss_store_notice`).
impl AppHealth {
    pub fn new(startup: SubsystemHealth) -> Self {
        Self(startup, DismissedNotices::default())
    }

    /// The set holds plain values that no panic leaves half written, so a poisoned lock is still
    /// read.
    fn dismissed(&self) -> std::sync::MutexGuard<'_, std::collections::BTreeSet<StoreId>> {
        self.1
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Each store's health as the page is told it: the startup snapshot, less the one-time notices
/// dismissed this run.
pub fn get_health(health: &AppHealth) -> SubsystemHealth {
    let dismissed = health.dismissed();
    let mut served = health.0.clone();
    for (store, entry) in &mut served.0 {
        if dismissed.contains(store) {
            entry.notice = None;
        }
    }
    served
}

/// Each store's health for the problem report: the startup snapshot, notices included, since a
/// dismissed notice is UI state, not a change in the store (ADR 0025 health at report time).
pub fn report_health(health: &AppHealth) -> SubsystemHealth {
    health.0.clone()
}

/// Forgets `store`'s one-time notice for the page for the rest of the run; its status stays.
pub fn dismiss_store_notice(health: &AppHealth, store: StoreId) {
    health.dismissed().insert(store);
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
    use canopi_types::health::StoreNotice;

    /// A dismissed notice is UI state: the problem report keeps the startup health, so support
    /// still sees that an earlier user database was moved aside (ADR 0025 health at report time).
    #[test]
    fn canopi_f47t_52_36_a_dismissed_notice_stays_in_the_report_health() {
        let mut startup = all_ready();
        startup.0.insert(
            StoreId::UserDb,
            StoreHealth {
                status: StoreOpenStatus::Ready,
                notice: Some(StoreNotice::MovedAsidePre20),
            },
        );
        let health = AppHealth::new(startup.clone());

        dismiss_store_notice(&health, StoreId::UserDb);

        let notice = |health: &SubsystemHealth| {
            health
                .0
                .get(&StoreId::UserDb)
                .and_then(|entry| entry.notice)
        };
        assert_eq!(notice(&get_health(&health)), None);
        assert_eq!(report_health(&health), startup);
    }

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
