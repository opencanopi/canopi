// Planted locale-list-only-in-registry violations: direct sys_locale call and match-arm locale dispatch.
pub fn planted_locale() -> Option<String> {
    sys_locale::get_locale()
}

pub fn planted_match(code: &str) -> &'static str {
    match code {
        "fr" => "value_fr",
        "es" => "value_es",
        _ => "value_en",
    }
}
