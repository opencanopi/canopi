const MAX_GEOCODING_BYTES: u64 = 1024 * 1024;
const NOMINATIM_PUBLIC_HOST: &str = "nominatim.openstreetmap.org";

/// Nominatim's usage policy requires an agent that identifies the application.
const NOMINATIM_USER_AGENT: &str = concat!(
    "Canopi/",
    env!("CARGO_PKG_VERSION"),
    " (+https://projectcanopi.com)"
);

/// Pure native geocoder transport (canopi-f47t.52.77): fetches a TS-built Nominatim URL with
/// Canopi's identifying User-Agent and a bounded response read.
pub async fn geocoder_fetch(
    executor: &crate::native_operation::NativeOperationExecutor,
    url: String,
) -> Result<String, String> {
    validate_geocoder_url(&url)?;
    executor
        .run(
            crate::native_operation::NativeOperationClass::Network,
            "geocoding",
            move || geocoder_fetch_blocking(&url),
        )
        .await
}

fn validate_geocoder_url(url: &str) -> Result<(), String> {
    crate::http::require_https_host(url, NOMINATIM_PUBLIC_HOST)
}

fn geocoder_fetch_blocking(url: &str) -> Result<String, String> {
    let mut response = crate::http::build_get_request(
        url,
        NOMINATIM_USER_AGENT,
        std::time::Duration::from_secs(5),
    )
    .call()
    .map_err(|e| format!("Failed to geocode: {e}"))?;

    crate::http::read_limited_string(&mut response, MAX_GEOCODING_BYTES, "geocoding response")
}

#[cfg(test)]
mod tests {
    use super::validate_geocoder_url;

    #[test]
    fn identifies_the_application_to_nominatim() {
        assert!(super::NOMINATIM_USER_AGENT.starts_with("Canopi/"));
        assert!(super::NOMINATIM_USER_AGENT.contains("projectcanopi.com"));
    }

    #[test]
    fn allows_only_https_nominatim_public_host() {
        assert!(validate_geocoder_url(
            "https://nominatim.openstreetmap.org/search?q=Lyon&format=jsonv2&limit=5&accept-language=fr"
        )
        .is_ok());
        assert!(validate_geocoder_url("http://nominatim.openstreetmap.org/search?q=Lyon").is_err());
        assert!(validate_geocoder_url("https://example.com/search?q=Lyon").is_err());
        assert!(validate_geocoder_url("not-a-url").is_err());
    }
}
