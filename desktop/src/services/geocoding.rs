use canopi_types::location::GeoResult;
use serde::Deserialize;

#[derive(Deserialize)]
struct NominatimResult {
    display_name: String,
    #[serde(deserialize_with = "de_f64_from_str")]
    lat: f64,
    #[serde(deserialize_with = "de_f64_from_str")]
    lon: f64,
}

const MAX_GEOCODING_BYTES: u64 = 1024 * 1024;
/// Nominatim's usage policy requires an agent that identifies the application.
const NOMINATIM_USER_AGENT: &str = concat!(
    "Canopi/",
    env!("CARGO_PKG_VERSION"),
    " (+https://projectcanopi.com)"
);

pub async fn geocode_address(
    executor: &crate::native_operation::NativeOperationExecutor,
    query: String,
) -> Result<Vec<GeoResult>, String> {
    executor
        .run(
            crate::native_operation::NativeOperationClass::Network,
            "geocoding",
            move || geocode_address_blocking(query),
        )
        .await
}

fn geocode_address_blocking(query: String) -> Result<Vec<GeoResult>, String> {
    let mut response = crate::http::build_get_request(
        "https://nominatim.openstreetmap.org/search",
        NOMINATIM_USER_AGENT,
        std::time::Duration::from_secs(5),
    )
    .query("q", &query)
    .query("format", "json")
    .query("limit", "5")
    .call()
    .map_err(|e| format!("Failed to geocode: {e}"))?;

    let body =
        crate::http::read_limited_string(&mut response, MAX_GEOCODING_BYTES, "geocoding response")?;

    let results: Vec<NominatimResult> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to geocode: {e}"))?;

    Ok(results
        .into_iter()
        .map(|result| GeoResult {
            display_name: result.display_name,
            lat: result.lat,
            lon: result.lon,
        })
        .collect())
}

fn de_f64_from_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let s = String::deserialize(d)?;
    s.parse::<f64>().map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::GeoResult;

    #[test]
    fn identifies_the_application_to_nominatim() {
        assert!(super::NOMINATIM_USER_AGENT.starts_with("Canopi/"));
        assert!(super::NOMINATIM_USER_AGENT.contains("projectcanopi.com"));
    }

    #[test]
    fn parses_nominatim_string_coordinates() {
        let results: Vec<GeoResult> = serde_json::from_str::<Vec<serde_json::Value>>(
            r#"[{"display_name":"Paris","lat":"48.8566","lon":"2.3522"}]"#,
        )
        .ok()
        .into_iter()
        .flat_map(|values| {
            values.into_iter().map(|value| {
                let parsed: super::NominatimResult = serde_json::from_value(value).unwrap();
                GeoResult {
                    display_name: parsed.display_name,
                    lat: parsed.lat,
                    lon: parsed.lon,
                }
            })
        })
        .collect();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_name, "Paris");
        assert_eq!(results[0].lat, 48.8566);
        assert_eq!(results[0].lon, 2.3522);
    }
}
