// The planted locale-list-only-in-registry violation: direct sys_locale call outside settings.rs.
pub fn planted_locale() -> Option<String> {
    sys_locale::get_locale()
}
