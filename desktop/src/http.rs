use std::time::Duration;

pub fn build_get_request(
    url: &str,
    user_agent: &str,
    timeout: Duration,
) -> ureq::RequestBuilder<ureq::typestate::WithoutBody> {
    ureq::get(url)
        .header("User-Agent", user_agent)
        .config()
        .timeout_global(Some(timeout))
        .build()
}

pub fn read_limited_bytes(
    response: &mut ureq::http::Response<ureq::Body>,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    reject_if_content_length_exceeds_limit(response, max_bytes, label)?;
    response
        .body_mut()
        .with_config()
        .limit(max_bytes)
        .read_to_vec()
        .map_err(|e| format!("Failed to read {label}: {e}"))
}

pub fn read_limited_string(
    response: &mut ureq::http::Response<ureq::Body>,
    max_bytes: u64,
    label: &str,
) -> Result<String, String> {
    reject_if_content_length_exceeds_limit(response, max_bytes, label)?;
    response
        .body_mut()
        .with_config()
        .limit(max_bytes)
        .read_to_string()
        .map_err(|e| format!("Failed to read {label}: {e}"))
}

pub fn reject_if_content_length_exceeds_limit(
    response: &ureq::http::Response<ureq::Body>,
    max_bytes: u64,
    label: &str,
) -> Result<(), String> {
    if let Some(content_length) = response.headers().get("content-length")
        && let Some(length) = parse_content_length(content_length.to_str().ok())
        && length > max_bytes
    {
        return Err(format!(
            "{label} too large ({length} bytes, max {max_bytes})"
        ));
    }

    Ok(())
}

/// The updater client's settings (2.1-M210): the plugin builds its own reqwest client and Canopi
/// configures it, never replaces it.
pub struct UpdaterClient {
    pub user_agent: &'static str,
    pub connect_timeout: Duration,
    /// No bytes for this long ends a read.
    pub read_timeout: Duration,
    /// The only hosts the client may reach by redirect.
    pub allowed_hosts: Vec<String>,
}

/// The most redirects the updater follows, reqwest's own default.
const MAX_UPDATER_REDIRECTS: usize = 10;

impl UpdaterClient {
    /// Applies these settings to the plugin's client builder; a redirect to a host outside
    /// `allowed_hosts` fails the request as a redirect error.
    pub fn configure(&self, client: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        let allowed_hosts = self.allowed_hosts.clone();
        client
            .user_agent(self.user_agent)
            .connect_timeout(self.connect_timeout)
            .read_timeout(self.read_timeout)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= MAX_UPDATER_REDIRECTS {
                    attempt.error("too many redirects")
                } else if redirect_allowed(&allowed_hosts, attempt.url().host_str()) {
                    attempt.follow()
                } else {
                    attempt.error("a redirect left the allowed hosts")
                }
            }))
    }
}

fn redirect_allowed(allowed_hosts: &[String], host: Option<&str>) -> bool {
    host.is_some_and(|host| allowed_hosts.iter().any(|allowed| allowed == host))
}

fn parse_content_length(value: Option<&str>) -> Option<u64> {
    value?.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::{parse_content_length, redirect_allowed};

    #[test]
    fn a_redirect_is_allowed_only_to_a_listed_host() {
        let allowed = ["updates.projectcanopi.com".to_owned()];
        assert!(redirect_allowed(
            &allowed,
            Some("updates.projectcanopi.com")
        ));
        assert!(!redirect_allowed(
            &allowed,
            Some("projectcanopi.com.evil.example")
        ));
        assert!(!redirect_allowed(&allowed, None));
    }

    #[test]
    fn parse_content_length_accepts_valid_numbers() {
        assert_eq!(parse_content_length(Some("42")), Some(42));
    }

    #[test]
    fn parse_content_length_rejects_invalid_values() {
        assert_eq!(parse_content_length(Some("abc")), None);
        assert_eq!(parse_content_length(None), None);
    }
}
