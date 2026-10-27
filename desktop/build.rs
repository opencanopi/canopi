#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a build script fails the build loudly by design"
)]
fn main() {
    println!("cargo:rerun-if-env-changed=CANOPI_SKIP_BUNDLED_DB");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=capabilities-dev");
    println!("cargo:rerun-if-changed=binaries");
    // The one notices file, at the repository root (scripts/generate_notices.mjs), ships as a resource.
    println!("cargo:rerun-if-changed=../THIRD_PARTY_NOTICES.md");

    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let mut bundle = serde_json::Map::new();

    if std::env::var("CANOPI_SKIP_BUNDLED_DB").as_deref() == Ok("1") {
        // Allow CI lint/test jobs to compile the desktop crate without a locally
        // generated bundled plant DB. The runtime degrades gracefully when the
        // DB is missing; release packaging still requires the real DB. The
        // third-party notices ship regardless: the merge patch drops the DB
        // entry of tauri.conf.json's resource map and keeps the same mapping.
        if release {
            println!(
                "cargo:warning=CANOPI_SKIP_BUNDLED_DB=1 in a release build: the plant DB is not bundled"
            );
        }
        bundle.insert(
            "resources".into(),
            serde_json::json!({
                "resources/canopi-core.db": null,
                "../THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md"
            }),
        );
    }

    // The GeoLibre CLI sidecar (`bundle.externalBin` in tauri.conf.json) is
    // built by `scripts/build-geolibre-cli.sh` into `binaries/geolibre-<target
    // triple>[.exe]`. tauri-build fails when a listed sidecar is missing, so
    // the rule is: the sidecar is bundled exactly when its file exists. Lint,
    // test and dev builds without it keep working; a release build without it
    // warns and packages an app whose analyses report the engine as missing.
    if !sidecar_present() {
        if release {
            println!(
                "cargo:warning=desktop/binaries has no GeoLibre CLI for this target: the sidecar is not bundled (run scripts/build-geolibre-cli.sh)"
            );
        }
        bundle.insert("externalBin".into(), serde_json::Value::Null);
    }

    let mut patch = serde_json::Map::new();
    if !bundle.is_empty() {
        patch.insert("bundle".into(), serde_json::Value::Object(bundle));
    }

    // The MCP bridge drives the dev webview through `window.__TAURI__` and its
    // own permissions. Neither exists in a release build: the global API stays
    // off and the dev capability is never parsed or granted.
    let dev_bridge = !release && std::env::var_os("CARGO_FEATURE_MCP_BRIDGE").is_some();
    let capabilities_pattern = if dev_bridge {
        patch.insert(
            "app".into(),
            serde_json::json!({
                "withGlobalTauri": true,
                "security": { "capabilities": ["main-window", "mcp-bridge-dev"] }
            }),
        );
        "./capabilities*/**/*"
    } else {
        "./capabilities/**/*"
    };

    if !patch.is_empty() {
        // Compose over any configuration patch the Tauri CLI passed in, then
        // hand the result to both tauri-build (this process) and
        // `generate_context!` (the crate's rustc invocations), which apply it
        // to tauri.conf.json as a JSON merge patch.
        let mut config = std::env::var("TAURI_CONFIG")
            .ok()
            .and_then(|inline| serde_json::from_str::<serde_json::Value>(&inline).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        compose(&mut config, serde_json::Value::Object(patch));
        let config = config.to_string();
        println!("cargo:rustc-env=TAURI_CONFIG={config}");
        unsafe {
            std::env::set_var("TAURI_CONFIG", config);
        }
    }

    let mut attributes =
        tauri_build::Attributes::new().capabilities_path_pattern(capabilities_pattern);
    if embed_windows_manifest_in_every_target() {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("tauri build configuration");
}

/// On Windows the dialog plugin needs Common Controls v6, which only the
/// application manifest selects. tauri-build puts its manifest in a resource
/// that reaches the app binary only, so the unit-test binary could not start
/// (STATUS_ENTRYPOINT_NOT_FOUND). The MSVC linker embeds the same manifest,
/// Tauri's default copied verbatim, into every linked target instead; CI
/// checks the packaged executable still carries it.
fn embed_windows_manifest_in_every_target() -> bool {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        return false;
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let manifest = std::path::Path::new(&manifest_dir).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}

/// Whether `binaries/geolibre-<target triple>[.exe]`, the sidecar name Tauri
/// expects for the target being compiled, exists.
fn sidecar_present() -> bool {
    let triple = std::env::var("TARGET").expect("cargo sets TARGET");
    let extension = if triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    std::path::Path::new(&manifest_dir)
        .join("binaries")
        .join(format!("geolibre-{triple}{extension}"))
        .is_file()
}

/// Compose two JSON merge patches (RFC 7386): the result, applied to a
/// document, equals applying `target` then `patch`. A `null` in `patch` is
/// kept, not dropped, because it is the instruction to remove that key from
/// the final document.
fn compose(target: &mut serde_json::Value, patch: serde_json::Value) {
    match patch {
        serde_json::Value::Object(patch) => {
            if !target.is_object() {
                *target = serde_json::json!({});
            }
            let target = target.as_object_mut().expect("object");
            for (key, value) in patch {
                if value.is_object() {
                    compose(target.entry(key).or_insert(serde_json::Value::Null), value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        value => *target = value,
    }
}
