use crate::AppHealth;
use canopi_types::health::SubsystemHealth;

pub fn get_health(health: &AppHealth) -> SubsystemHealth {
    health.0.clone()
}
