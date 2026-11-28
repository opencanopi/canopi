use canopi_types::location::GEOCODER_IDENTIFIED_HOSTS;

const MAX_GEOCODING_BYTES: u64 = 1024 * 1024;

/// Nominatim's usage policy requires an agent that identifies the application.
const NOMINATIM_USER_AGENT: &str = concat!(
    "Canopi/",
    env!("CARGO_PKG_VERSION"),
    " (+https://projectcanopi.com)"
);

/// Pure native geocoder transport (canopi-f47t.52.77): fetches a TS-built Nominatim URL with
/// Canopi's identifying User-Agent, no redirects, and a bounded response read.
pub async fn geocoder_fetch(
    executor: &crate::native_operation::NativeOperationExecutor,
    url: String,
) -> Result<String, String> {
    let validated = validate_geocoder_url(&url)?;
    executor
        .run(
            crate::native_operation::NativeOperationClass::Network,
            "geocoding",
            move || geocoder_fetch_blocking(&validated),
        )
        .await
}

fn validate_geocoder_url(url: &str) -> Result<String, String> {
    crate::http::validate_geocoder_url(url, GEOCODER_IDENTIFIED_HOSTS)
}

fn geocoder_fetch_blocking(url: &str) -> Result<String, String> {
    let mut response = crate::http::build_get_request(
        url,
        NOMINATIM_USER_AGENT,
        std::time::Duration::from_secs(5),
    )
    .call()
    .map_err(|e| format!("Failed to geocode: {e}"))?;

    if response.status().is_redirection() {
        return Err(format!(
            "Geocoding redirects are not allowed ({})",
            response.status()
        ));
    }

    crate::http::read_limited_string(&mut response, MAX_GEOCODING_BYTES, "geocoding response")
}

#[cfg(test)]
mod tests {
    use super::{geocoder_fetch_blocking, validate_geocoder_url};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn identifies_the_application_to_nominatim() {
        assert!(super::NOMINATIM_USER_AGENT.starts_with("Canopi/"));
        assert!(super::NOMINATIM_USER_AGENT.contains("projectcanopi.com"));
    }

    #[test]
    fn allows_only_https_nominatim_search_without_port_or_userinfo() {
        let valid = validate_geocoder_url(
            "https://nominatim.openstreetmap.org/search?q=Lyon&format=jsonv2&limit=5&accept-language=fr",
        )
        .expect("valid Nominatim search URL is accepted");
        assert!(valid.starts_with("https://nominatim.openstreetmap.org/search?"));

        assert!(validate_geocoder_url("http://nominatim.openstreetmap.org/search?q=Lyon").is_err());
        assert!(validate_geocoder_url("https://example.com/search?q=Lyon").is_err());
        assert!(
            validate_geocoder_url("https://nominatim.openstreetmap.org:8443/search?q=Lyon")
                .is_err()
        );
        assert!(
            validate_geocoder_url("https://user:pass@nominatim.openstreetmap.org/search?q=Lyon")
                .is_err()
        );
        assert!(
            validate_geocoder_url("https://user@nominatim.openstreetmap.org/search?q=Lyon")
                .is_err()
        );
        assert!(
            validate_geocoder_url("https://nominatim.openstreetmap.org/reverse?lat=0&lon=0")
                .is_err()
        );
        assert!(
            validate_geocoder_url("https://nominatim.openstreetmap.org/details?place_id=1")
                .is_err()
        );
        assert!(validate_geocoder_url("https://nominatim.openstreetmap.org/").is_err());
        assert!(validate_geocoder_url("not-a-url").is_err());
    }

    #[test]
    fn refuses_redirects_on_geocoder_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://example.com/evil\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });

        let result = geocoder_fetch_blocking(&format!("http://{addr}/search?q=Lyon"));
        server.join().expect("server thread finishes");
        assert!(result.is_err(), "redirect must be refused, got {result:?}");
    }
}
