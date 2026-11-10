use crate::AppHealth;
use canopi_types::health::{StoreId, SubsystemHealth};

/// The startup health snapshot, less the one-time notices dismissed this run, cloned; it cannot
/// fail, so the command returns it as is (D3).
#[tauri::command]
pub fn get_health(health: tauri::State<'_, AppHealth>) -> SubsystemHealth {
    crate::services::health::get_health(&health)
}

/// The user dismissed `store`'s one-time notice: a page reloaded in this run is not told again
/// (ADR 0021 "says once"); its status stays. It cannot fail, so it returns nothing.
#[tauri::command]
pub fn dismiss_store_notice(health: tauri::State<'_, AppHealth>, store: StoreId) {
    crate::services::health::dismiss_store_notice(&health, store);
}

#[cfg(test)]
mod tests {
    use crate::AppHealth;
    use canopi_types::health::{PlantDbStatus, StoreId, SubsystemHealth};

    #[test]
    fn get_health_omits_a_notice_dismissed_this_run() {
        use canopi_types::health::{StoreHealth, StoreNotice, StoreOpenStatus};
        use tauri::Manager as _;
        let mut snapshot = crate::services::health::all_ready();
        let moved_aside = StoreHealth {
            status: StoreOpenStatus::Ready,
            notice: Some(StoreNotice::MovedAsidePre20),
        };
        snapshot.0.insert(StoreId::UserDb, moved_aside);
        let app = tauri::test::mock_builder()
            .manage(AppHealth::new(snapshot.clone()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app builds");

        super::dismiss_store_notice(app.state(), StoreId::UserDb);
        // A store with no entry is left as it is.
        super::dismiss_store_notice(app.state(), StoreId::Settings);

        let served: SubsystemHealth = super::get_health(app.state());
        let mut expected = snapshot;
        if let Some(entry) = expected.0.get_mut(&StoreId::UserDb) {
            entry.notice = None;
        }
        assert_eq!(served, expected);
        assert_eq!(
            served.0.get(&StoreId::UserDb).map(|entry| &entry.status),
            Some(&StoreOpenStatus::Ready),
            "the status stays"
        );
    }

    #[test]
    fn get_health_returns_the_startup_snapshot() {
        use tauri::Manager as _;
        let mut snapshot = crate::services::health::all_ready();
        snapshot.0.insert(
            StoreId::PlantCatalog,
            crate::services::health::plant_catalog(PlantDbStatus::Missing),
        );
        let app = tauri::test::mock_builder()
            .manage(AppHealth::new(snapshot.clone()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app builds");

        let served: SubsystemHealth = super::get_health(app.state());

        assert_eq!(served, snapshot);
    }
}
