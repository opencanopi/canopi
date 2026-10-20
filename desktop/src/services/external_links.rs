//! The main webview's navigation guard (2.1-M79(a), Q180, Q181).
//!
//! The app webview only ever shows the app: it loads its own origins (the
//! index, a reload, in-app links) and, in a dev build, the dev server. The
//! origins are matched first, so `http://tauri.localhost` stays in place. An
//! http, https or mailto link, followed in place or asked for in a new window
//! (`target="_blank"`), opens in the system browser or mail client instead and
//! the webview stays where it is. Every other URL is refused. `lib.rs` wires
//! [`follow_navigation`] to the window's `on_navigation` and
//! [`follow_new_window`] to its `on_new_window`; the window is built in Rust
//! (`"create": false` in `tauri.conf.json`) because only a window builder sees
//! new-window requests. Logs carry the URL's scheme, never the URL: a link can
//! hold an address, a search or a token.

use tauri::Url;

/// What the main webview does with a URL it is asked to load.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkDecision {
    /// One of the app's own origins: the webview loads it.
    Stay,
    /// An http, https or mailto link: the system browser or mail client opens it
    /// and the webview stays where it is.
    OpenOutside,
    /// Anything else: neither loaded nor opened.
    Refuse,
}

/// The origins Tauri serves the app from on every platform: `tauri://localhost`
/// (Linux, macOS) and its WebView2 forms `http(s)://tauri.localhost`. Tauri
/// fixes them; they are not configuration.
const TAURI_APP_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Origin {
    scheme: String,
    host: Option<String>,
    port: Option<u16>,
}

impl Origin {
    fn of(url: &Url) -> Self {
        Self {
            scheme: url.scheme().to_ascii_lowercase(),
            host: url.host_str().map(str::to_ascii_lowercase),
            port: url.port_or_known_default(),
        }
    }
}

/// The origins the main webview may load.
#[derive(Debug, Clone)]
pub struct AppOrigins {
    origins: Vec<Origin>,
}

impl AppOrigins {
    /// Tauri's app origins, plus the configured `devUrl` in a dev build only
    /// (`tauri::is_dev()`): a release build never loads the dev server.
    pub fn new(dev_build: bool, dev_url: Option<&Url>) -> Self {
        let mut origins = TAURI_APP_ORIGINS
            .iter()
            .filter_map(|origin| Url::parse(origin).ok())
            .map(|url| Origin::of(&url))
            .collect::<Vec<_>>();
        if dev_build && let Some(dev_url) = dev_url {
            origins.push(Origin::of(dev_url));
        }
        Self { origins }
    }
}

/// Decide what the main webview does with `url`.
pub fn decide(url: &Url, origins: &AppOrigins) -> LinkDecision {
    if origins.origins.contains(&Origin::of(url)) {
        return LinkDecision::Stay;
    }
    match url.scheme() {
        "http" | "https" | "mailto" => LinkDecision::OpenOutside,
        _ => LinkDecision::Refuse,
    }
}

/// A navigation in the main webview (a link followed in place, a reload, the
/// first load). Returns whether the webview may load `url`; an outside link is
/// handed to `open_outside` (true when the system opened it) and never loaded.
pub fn follow_navigation(
    url: &Url,
    origins: &AppOrigins,
    open_outside: impl FnOnce(&Url) -> bool,
) -> bool {
    match decide(url, origins) {
        LinkDecision::Stay => true,
        LinkDecision::OpenOutside => {
            open_in_system(url, open_outside);
            false
        }
        LinkDecision::Refuse => {
            tracing::warn!(scheme = url.scheme(), "Navigation refused");
            false
        }
    }
}

/// A request for a new window (`target="_blank"`, `window.open`). The app
/// never opens a second webview: an outside link goes to `open_outside`, and
/// everything else, the app's own origins included, is refused.
pub fn follow_new_window(url: &Url, origins: &AppOrigins, open_outside: impl FnOnce(&Url) -> bool) {
    match decide(url, origins) {
        LinkDecision::OpenOutside => open_in_system(url, open_outside),
        LinkDecision::Stay | LinkDecision::Refuse => {
            tracing::warn!(scheme = url.scheme(), "New window refused");
        }
    }
}

fn open_in_system(url: &Url, open_outside: impl FnOnce(&Url) -> bool) {
    if open_outside(url) {
        tracing::info!(scheme = url.scheme(), "Link opened outside the app");
    } else {
        tracing::warn!(
            scheme = url.scheme(),
            "Link could not be opened outside the app"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{AppOrigins, LinkDecision, decide, follow_navigation, follow_new_window};
    use tauri::Url;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn release() -> AppOrigins {
        AppOrigins::new(false, Some(&url("http://localhost:1420")))
    }

    fn dev() -> AppOrigins {
        AppOrigins::new(true, Some(&url("http://localhost:1420")))
    }

    #[test]
    fn canopi_eon8_14_5_the_app_index_and_its_reload_stay_in_the_webview() {
        for own in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "tauri://localhost/index.html#design",
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html?reload=1",
            "https://tauri.localhost/",
            "HTTP://TAURI.LOCALHOST/",
        ] {
            assert_eq!(decide(&url(own), &release()), LinkDecision::Stay, "{own}");
            assert_eq!(decide(&url(own), &dev()), LinkDecision::Stay, "{own}");
        }
    }

    #[test]
    fn canopi_eon8_14_5_the_dev_server_is_an_app_origin_in_a_dev_build_only() {
        for page in [
            "http://localhost:1420/",
            "http://localhost:1420/src/main.tsx",
        ] {
            assert_eq!(decide(&url(page), &dev()), LinkDecision::Stay, "{page}");
            assert_eq!(
                decide(&url(page), &release()),
                LinkDecision::OpenOutside,
                "{page}: a release build never loads the dev server"
            );
        }
        assert_eq!(
            decide(&url("http://localhost:1421/"), &dev()),
            LinkDecision::OpenOutside,
            "another port is another origin"
        );
        assert_eq!(
            decide(&url("http://localhost:1420/"), &AppOrigins::new(true, None)),
            LinkDecision::OpenOutside,
            "no devUrl configured"
        );
    }

    /// The configured devUrl is read from the real `tauri.conf.json`.
    #[test]
    fn canopi_eon8_14_5_the_configured_dev_url_is_allowed_in_dev_and_refused_in_release() {
        #[expect(
            clippy::disallowed_methods,
            reason = "Tauri's generated context builds itself on a startup thread it joins at once"
        )]
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!(test = true);
        let dev_url = context
            .config()
            .build
            .dev_url
            .clone()
            .expect("tauri.conf.json sets devUrl");
        assert_eq!(
            decide(&dev_url, &AppOrigins::new(true, Some(&dev_url))),
            LinkDecision::Stay
        );
        assert_ne!(
            decide(&dev_url, &AppOrigins::new(false, Some(&dev_url))),
            LinkDecision::Stay
        );
    }

    #[test]
    fn canopi_eon8_14_5_http_https_and_mailto_links_open_outside_the_app() {
        for outside in [
            "http://example.org/",
            "HTTP://Example.org/Path",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.example.org/",
            "http://localhost/",
            "https://www.openstreetmap.org/copyright",
            "https://maplibre.org/",
            "https://tauri.localhost.example.org/",
            "https://tauri.localhost@example.org/",
            "https://tauri.localhost:8443/",
            "HTTPS://Example.org/Path",
            "mailto:someone@example.org",
            "mailto:someone@example.org?subject=Garden",
        ] {
            assert_eq!(
                decide(&url(outside), &dev()),
                LinkDecision::OpenOutside,
                "{outside}"
            );
            assert_eq!(
                decide(&url(outside), &release()),
                LinkDecision::OpenOutside,
                "{outside}"
            );
        }
    }

    #[test]
    fn canopi_eon8_14_5_every_other_scheme_is_refused() {
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<p>hi</p>",
            "blob:tauri://localhost/0b6c",
            "about:blank",
            "asset://localhost/x.tif",
            "ipc://localhost/plugin",
            "ftp://example.org/",
            "tel:+33100000000",
            "tauri://example.org/",
            "canopi://open",
        ] {
            assert_eq!(
                decide(&url(refused), &dev()),
                LinkDecision::Refuse,
                "{refused}"
            );
        }
    }

    #[test]
    fn canopi_eon8_14_5_a_navigation_loads_only_app_origins_and_hands_outside_links_to_the_system()
    {
        let mut opened = Vec::new();
        assert!(follow_navigation(
            &url("tauri://localhost/"),
            &release(),
            |_| unreachable!("an app origin is never opened outside")
        ));
        assert!(!follow_navigation(
            &url("https://example.org/a"),
            &release(),
            |link| {
                opened.push(link.to_string());
                true
            }
        ));
        assert!(!follow_navigation(
            &url("file:///etc/passwd"),
            &release(),
            |_| unreachable!("a refused link is never opened")
        ));
        assert_eq!(opened, ["https://example.org/a"]);
    }

    #[test]
    fn canopi_eon8_14_5_a_new_window_request_never_opens_a_webview_and_opens_outside_links() {
        let mut opened = Vec::new();
        for request in [
            "https://example.org/b",
            "http://example.org/c",
            "tauri://localhost/",
            "mailto:a@example.org",
            "javascript:alert(1)",
        ] {
            follow_new_window(&url(request), &release(), |link| {
                opened.push(link.to_string());
                true
            });
        }
        assert_eq!(
            opened,
            [
                "https://example.org/b",
                "http://example.org/c",
                "mailto:a@example.org"
            ]
        );
    }

    #[test]
    fn canopi_eon8_14_5_a_failed_or_refused_link_logs_its_scheme_never_the_url() {
        let secret = "https://example.org/garden?token=s3cret-value";
        let (loaded, logs) = crate::services::design_files::capture_logs(|| {
            let loaded = follow_navigation(&url(secret), &release(), |_| false);
            follow_new_window(&url(secret), &release(), |_| false);
            follow_navigation(
                &url("file:///home/me/private.canopi"),
                &release(),
                |_| unreachable!(),
            );
            follow_new_window(&url("tauri://localhost/x"), &release(), |_| unreachable!());
            loaded
        });
        assert!(
            !loaded,
            "an outside link that fails to open is still not loaded"
        );
        assert!(
            logs.contains("Link could not be opened outside the app"),
            "{logs}"
        );
        assert!(
            logs.contains("scheme=\"https\"") || logs.contains("scheme=https"),
            "{logs}"
        );
        assert!(logs.contains("Navigation refused"), "{logs}");
        assert!(logs.contains("New window refused"), "{logs}");
        for leaked in [
            "example.org",
            "s3cret",
            "garden",
            "private",
            "/home/me",
            "localhost/x",
        ] {
            assert!(!logs.contains(leaked), "{leaked} leaked into {logs}");
        }
    }
}
