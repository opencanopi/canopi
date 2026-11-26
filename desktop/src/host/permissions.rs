//! Webview permission policy (2.1-Q146, ADR 0030).
//!
//! Desktop "Show my location" on Linux and Windows relies on the webview's
//! geolocation API. Tauri's `Builder::on_permission_request` grants
//! `PermissionKind::Geolocation` only when the requesting webview is on the
//! Canopi app origin; every other origin and every other permission kind are
//! refused explicitly (`PermissionResponse::Deny`). On macOS, wry maps no
//! geolocation permission (ADR 0030), so Desktop hides the control there.

use tauri::webview::{PermissionKind, PermissionResponse};

/// Handle a webview permission request from Tauri's builder hook.
pub fn handle_request<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    kind: PermissionKind,
) -> PermissionResponse {
    let url = webview.url().ok();
    decide(url.as_ref(), kind)
}

/// Pure permission decision: grants `Geolocation` to the Canopi app origin
/// only, and refuses every other origin and permission kind.
pub fn decide(url: Option<&tauri::Url>, kind: PermissionKind) -> PermissionResponse {
    if kind != PermissionKind::Geolocation {
        return PermissionResponse::Deny;
    }
    match url {
        Some(url) if is_app_origin(url) => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

/// Whether `url` is Canopi's own bundled app origin (or the local dev server in
/// debug builds, matching `tauri.conf.json`'s `devUrl`).
fn is_app_origin(url: &tauri::Url) -> bool {
    let host = url.host_str();
    let is_bundled = match url.scheme() {
        "tauri" => host == Some("localhost") && url.port().is_none(),
        "http" | "https" => host == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    };
    if is_bundled {
        return true;
    }
    #[cfg(debug_assertions)]
    {
        if url.scheme() == "http" && host == Some("localhost") && url.port() == Some(1420) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> tauri::Url {
        tauri::Url::parse(raw).expect("valid test URL")
    }

    #[test]
    fn grants_geolocation_to_app_origin() {
        for raw in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/workspace",
        ] {
            assert_eq!(
                decide(Some(&parse(raw)), PermissionKind::Geolocation),
                PermissionResponse::Allow,
                "expected Allow for app origin {raw}"
            );
        }
    }

    #[test]
    fn refuses_geolocation_for_other_origins() {
        for raw in [
            "https://example.com/",
            "https://tauri.localhost.evil.com/",
            "http://evil-tauri.localhost/",
            "tauri://other/",
            "tauri://localhost:9999/",
            "http://tauri.localhost:9999/",
            "file:///tmp/index.html",
        ] {
            assert_eq!(
                decide(Some(&parse(raw)), PermissionKind::Geolocation),
                PermissionResponse::Deny,
                "expected Deny for foreign origin {raw}"
            );
        }
        assert_eq!(
            decide(None, PermissionKind::Geolocation),
            PermissionResponse::Deny,
            "expected Deny when webview URL is absent"
        );
    }

    #[test]
    fn refuses_other_permission_kinds_on_app_origin() {
        let app = parse("tauri://localhost/");
        for kind in [
            PermissionKind::Camera,
            PermissionKind::Microphone,
            PermissionKind::Notifications,
            PermissionKind::ClipboardRead,
            PermissionKind::DisplayCapture,
            PermissionKind::Midi,
            PermissionKind::Sensors,
            PermissionKind::LocalFonts,
            PermissionKind::WindowManagement,
            PermissionKind::PointerLock,
            PermissionKind::Other,
        ] {
            assert_eq!(
                decide(Some(&app), kind),
                PermissionResponse::Deny,
                "expected Deny for non-geolocation permission {kind:?}"
            );
        }
    }
}
