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

/// Opens the user database in `data_dir`, with the health entries of the stores it holds: the user DB
/// and, on Desktop, the settings record (startup seam, R2-2).
///
/// A user database from before 2.0 is renamed, since 2.0 needs its path, and a notice tells the
/// user once (ADR 0021); a damaged one is set aside and its status names the set-aside file on that
/// start only (NAT-02). One saved by a newer Canopi opens read-only and the app starts (2.1-M410).
/// Drafts in an earlier format and the retired 1.x autosave store stay where they are, unread, and
/// are not reported (U59).
pub(crate) fn open_stores(
    data_dir: &std::path::Path,
) -> Result<(crate::db::UserDb, [(StoreId, StoreHealth); 2]), crate::db::UserDbInitError> {
    let (user_db, health) = crate::db::UserDb::open(data_dir.join("user.db"))?;
    let settings = settings_entry(&health);
    Ok((
        user_db,
        [(StoreId::UserDb, health), (StoreId::Settings, settings)],
    ))
}

/// The settings record's entry: it lives in the user DB, so it shares the user DB's access (newer
/// read-only, unavailable); a damaged or rebuilt user DB is the user DB's own one-time event, named
/// once by its entry, and the settings record lives in the fresh database, so it is ready.
fn settings_entry(user_db: &StoreHealth) -> StoreHealth {
    let status = match &user_db.status {
        StoreOpenStatus::SetAsideDamaged { .. } | StoreOpenStatus::Recovered { .. } => {
            StoreOpenStatus::Ready
        }
        status => status.clone(),
    };
    StoreHealth {
        status,
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
        (StoreId::Settings, ready()),
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

    /// On Desktop the settings record lives in the user DB, so its entry follows the user DB's
    /// access; a one-time notice or set-aside stays the user DB's own.
    #[test]
    fn r2_canopi_f47t_52_271_the_settings_entry_follows_the_user_db_it_lives_in() {
        use canopi_types::failure::IoFailureKind;
        let code = FailureCode::Io {
            io: IoFailureKind::ReadOnly,
        };
        for status in [
            StoreOpenStatus::Ready,
            StoreOpenStatus::NewerReadOnly,
            StoreOpenStatus::Unavailable { code },
        ] {
            let user_db = StoreHealth {
                status: status.clone(),
                notice: Some(StoreNotice::MovedAsidePre20),
            };
            assert_eq!(
                settings_entry(&user_db),
                StoreHealth {
                    status,
                    notice: None
                }
            );
        }
        let fresh = [
            StoreOpenStatus::SetAsideDamaged {
                file: "user.db.corrupt-1".to_owned(),
            },
            StoreOpenStatus::Recovered {
                items: 1,
                generated: 0,
            },
        ];
        for status in fresh {
            let user_db = StoreHealth {
                status,
                notice: None,
            };
            assert_eq!(settings_entry(&user_db).status, StoreOpenStatus::Ready);
        }
    }

    /// A user DB saved by a newer Canopi starts the app (2.1-M410): the user DB and the settings
    /// it holds come back newer-read-only, where 2.0 refused to start.
    #[test]
    fn r2_canopi_f47t_52_271_a_user_db_10_starts_the_app_with_the_user_db_and_settings_newer_read_only()
     {
        let data_dir = crate::test_scratch::TestScratch::new("open-stores-user-db-10");
        let writer = rusqlite::Connection::open(data_dir.join("user.db")).unwrap();
        writer
            .execute_batch(include_str!("../test_fixtures/frozen/user-db-10.sql"))
            .unwrap();
        drop(writer);

        let (user_db, stores) = open_stores(&data_dir).expect("the app starts");
        drop(user_db);

        let newer = StoreHealth {
            status: StoreOpenStatus::NewerReadOnly,
            notice: None,
        };
        assert_eq!(
            stores,
            [(StoreId::UserDb, newer.clone()), (StoreId::Settings, newer)]
        );
    }

    /// A damaged user DB is set aside and named once, by the user DB's own entry: the settings
    /// record lives in the fresh database that replaced it, so it is ready and raises no second
    /// set-aside notice.
    #[test]
    fn r2_canopi_f47t_52_271_a_damaged_user_db_sets_aside_once_and_the_settings_entry_is_ready() {
        let data_dir = crate::test_scratch::TestScratch::new("open-stores-damaged-user-db");
        std::fs::write(data_dir.join("user.db"), b"not a database, damaged on disk").unwrap();

        let (user_db, [(_, user_db_entry), settings]) =
            open_stores(&data_dir).expect("the app starts");
        drop(user_db);

        assert!(matches!(
            user_db_entry.status,
            StoreOpenStatus::SetAsideDamaged { .. }
        ));
        let ready = StoreHealth {
            status: StoreOpenStatus::Ready,
            notice: None,
        };
        assert_eq!(settings, (StoreId::Settings, ready));
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
