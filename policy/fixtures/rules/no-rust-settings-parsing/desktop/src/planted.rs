// Planted violation for no-rust-settings-parsing (Stage 2 E1, ADR 0024).
pub fn planted_settings_read(user_db: &()) {
    let _ = crate::services::settings::get_settings(user_db);
}
