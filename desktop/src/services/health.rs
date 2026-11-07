use crate::AppHealth;
use canopi_types::health::SubsystemHealth;

pub fn get_health(health: &AppHealth) -> SubsystemHealth {
    health.0.clone()
}

/// The health of a start where every store the Desktop opens came up ready.
#[cfg(test)]
pub(crate) fn all_ready() -> SubsystemHealth {
    use canopi_types::health::{StoreHealth, StoreId, StoreOpenStatus};
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
