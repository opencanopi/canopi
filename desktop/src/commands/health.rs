use crate::AppHealth;
use canopi_types::health::SubsystemHealth;

/// The startup health snapshot, cloned; it cannot fail, so the command returns it as is (D3).
#[tauri::command]
pub fn get_health(health: tauri::State<'_, AppHealth>) -> SubsystemHealth {
    crate::services::health::get_health(&health)
}

#[cfg(test)]
mod tests {
    use crate::AppHealth;
    use canopi_types::health::{PlantDbStatus, StoreId, SubsystemHealth};

    #[test]
    fn get_health_returns_the_startup_snapshot() {
        use tauri::Manager as _;
        let mut snapshot = crate::services::health::all_ready();
        snapshot.0.insert(
            StoreId::PlantCatalog,
            crate::services::health::plant_catalog(PlantDbStatus::Missing),
        );
        let app = tauri::test::mock_builder()
            .manage(AppHealth(snapshot.clone()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app builds");

        let served: SubsystemHealth = super::get_health(app.state());

        assert_eq!(served, snapshot);
    }
}
