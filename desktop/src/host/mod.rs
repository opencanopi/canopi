//! The Desktop host: what Canopi asks of the operating system around its one window.
//!
//! The `e2e` feature builds the binary the real-app suite drives (`desktop/web/e2e/platform/`,
//! 2.1-M213): `tauri build --debug --no-bundle --features e2e`, under its own identifier
//! `com.canopi.e2e` so its single-instance name and data folders never meet the user's Canopi.
//! The feature's one seam puts every app folder in the session's profile ([`in_e2e_profile`]),
//! and it never reaches a release: a release build with it does not compile, a build with it
//! never carries the MCP bridge, and `tests::release_workflows_never_build_the_e2e_feature`
//! refuses it in the release workflows.

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!(
    "the `e2e` feature is for the real-app suite's debug build only; a release build never carries it"
);

#[cfg(all(feature = "e2e", feature = "mcp-bridge"))]
compile_error!(
    "the `e2e` build never enables the MCP bridge: the suite drives the app through tauri-driver alone"
);

/// The variable the real-app suite sets to the session's profile folder, an absolute path.
#[cfg(any(test, feature = "e2e"))]
pub const E2E_PROFILE_VARIABLE: &str = "CANOPI_E2E_PROFILE";

/// `context` with every app folder Tauri resolves (config, data, local data and so the WebView's
/// data folder, cache, logs) inside `profile`, the value of [`E2E_PROFILE_VARIABLE`], through
/// Tauri's `appDirectoriesOverride`. One mechanism on every platform: Windows resolves the
/// default folders through the shell's known folders, which no environment variable moves. An
/// e2e build with no absolute profile is refused, so it never falls back to the real folders.
#[cfg(any(test, feature = "e2e"))]
pub fn in_e2e_profile<R: tauri::Runtime>(
    mut context: tauri::Context<R>,
    profile: Option<std::ffi::OsString>,
) -> Result<tauri::Context<R>, String> {
    let profile = std::path::PathBuf::from(profile.unwrap_or_default());
    if !profile.is_absolute() {
        return Err(format!(
            "the e2e build needs {E2E_PROFILE_VARIABLE} set to an absolute profile folder, not {:?}",
            profile.display()
        ));
    }
    context.config_mut().app.app_directories_override =
        Some(tauri::utils::config::AppDirectoriesOverride::Root(profile));
    Ok(context)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// The workflows that build what users install: the release candidate and the PR bundle build.
    const RELEASE_WORKFLOWS: [&str; 2] = ["release-candidate.yml", "build.yml"];
    const E2E_FEATURE: &str = "e2e";

    /// The feature flags cargo and the Tauri CLI take: the long form and the short `-F` (cargo)
    /// and `-f` (Tauri CLI), whose list follows after a space, an `=` or, for a short one, at once.
    const FEATURE_FLAGS: [&str; 3] = ["--features", "-F", "-f"];

    /// Each line naming the `e2e` feature, through a feature flag on a command line or a YAML
    /// `features:` value. A list is split on commas and spaces, quotes and brackets dropped, so
    /// `updater-e2e` and other names containing `e2e` do not match.
    fn lines_naming_e2e(text: &str) -> Vec<(usize, String)> {
        text.lines()
            .enumerate()
            .filter(|(_, line)| {
                feature_values(line)
                    .iter()
                    .any(|value| list_items(value).any(|item| item == E2E_FEATURE))
            })
            .map(|(index, line)| (index + 1, line.trim().to_string()))
            .collect()
    }

    /// The feature lists one line gives: each feature flag's argument and a `features:` key's
    /// value. A flag starts a word: the line's start or after a character that is not part of a
    /// name, so a `-f` inside `--features-e2e` or `x-f` is not one.
    fn feature_values(line: &str) -> Vec<String> {
        let mut values = Vec::new();
        for (at, _) in line.match_indices('-') {
            let starts_word = line[..at]
                .chars()
                .next_back()
                .is_none_or(|before| !(before.is_alphanumeric() || matches!(before, '-' | '_')));
            if !starts_word {
                continue;
            }
            let word = &line[at..];
            let Some((flag, after)) = FEATURE_FLAGS
                .iter()
                .find_map(|flag| word.strip_prefix(flag).map(|after| (*flag, after)))
            else {
                continue;
            };
            let argument = if let Some(argument) = after.strip_prefix('=') {
                argument
            } else if after.starts_with(char::is_whitespace) {
                after.trim_start()
            } else if flag.starts_with("--") {
                continue;
            } else {
                after
            };
            values.push(first_argument(argument));
        }
        let trimmed = line.trim_start().trim_start_matches("- ");
        if let Some(value) = trimmed.strip_prefix("features:") {
            values.push(value.trim().to_string());
        }
        values
    }

    /// The shell argument at the start of `text`: a quoted string whole, else up to whitespace.
    fn first_argument(text: &str) -> String {
        for quote in ['"', '\''] {
            if let Some(inner) = text.strip_prefix(quote) {
                return inner.split(quote).next().unwrap_or_default().to_string();
            }
        }
        text.split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string()
    }

    fn list_items(value: &str) -> impl Iterator<Item = &str> {
        value
            .split(|c: char| c == ',' || c.is_whitespace())
            .map(|item| item.trim_matches(|c: char| matches!(c, '"' | '\'' | '[' | ']')))
            .filter(|item| !item.is_empty())
    }

    /// The e2e build keeps every folder Tauri resolves for it, the WebView's data folder included
    /// (`app_local_data_dir` on Linux and Windows), inside the session's profile; resolved by
    /// Tauri's own path resolver in a mock app.
    #[test]
    fn canopi_f47t_52_228_14_the_e2e_profile_holds_every_app_folder_on_every_platform() {
        use tauri::Manager as _;
        let root = std::env::temp_dir()
            .join("canopi-e2e-profile-probe")
            .join("app");
        let context = tauri::test::mock_context(tauri::test::noop_assets());
        let context = super::in_e2e_profile(context, Some(root.clone().into_os_string()))
            .expect("an absolute profile is taken");
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("the mock app builds");
        let path = app.path();
        for (name, folder) in [
            ("config", path.app_config_dir()),
            ("data", path.app_data_dir()),
            ("local data", path.app_local_data_dir()),
            ("cache", path.app_cache_dir()),
            ("log", path.app_log_dir()),
        ] {
            let folder = folder.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(
                folder.starts_with(&root),
                "the {name} folder {} is outside the profile {}",
                folder.display(),
                root.display()
            );
        }
    }

    #[test]
    fn canopi_f47t_52_228_14_the_e2e_build_refuses_to_start_without_an_absolute_profile() {
        for profile in [None, Some(""), Some("relative/profile")] {
            let context: tauri::Context<tauri::test::MockRuntime> =
                tauri::test::mock_context(tauri::test::noop_assets());
            let refused = super::in_e2e_profile(context, profile.map(Into::into));
            assert!(refused.is_err(), "taken: {profile:?}");
        }
    }

    #[test]
    fn release_workflows_never_build_the_e2e_feature() {
        let workflows = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.github/workflows");
        for name in RELEASE_WORKFLOWS {
            let path = workflows.join(name);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("{} must be readable: {error}", path.display()));
            let found = lines_naming_e2e(&text);
            assert!(
                found.is_empty(),
                "{name} builds the real-app suite's `e2e` feature, which never ships (2.1-M213): {found:?}"
            );
        }
    }

    #[test]
    fn canopi_f47t_52_228_14_the_e2e_feature_is_found_in_each_form_and_other_names_are_not() {
        for planted in [
            "npx @tauri-apps/cli@2.12.3 build --features e2e -- --locked",
            "cargo build --release --features=e2e",
            "cargo build --features \"mcp-bridge,e2e\"",
            "tauri build --features 'mcp-bridge e2e'",
            "          features: e2e",
            "  features: [mcp-bridge, e2e]",
            "  - features: \"e2e\"",
            "cargo build -F e2e",
            "cargo test -F \"mcp-bridge,e2e\"",
            "cargo build -Fe2e",
            "npx @tauri-apps/cli build -f e2e",
            "tauri build -f=e2e",
            "            bundle_args: \"--target x86_64-pc-windows-msvc -f e2e\"",
        ] {
            assert_eq!(
                lines_naming_e2e(planted).len(),
                1,
                "not found in {planted:?}"
            );
        }
        for kept in [
            "tauri build --features updater-e2e",
            "cargo test --features=updater-e2e,mcp-bridge",
            "  features: [updater-e2e]",
            "  name: e2e",
            "  run: npm run build:e2e",
            "  # --features alone",
            "curl -fsSL https://sh.rustup.rs | sh",
            "tauri build -f updater-e2e",
            "cargo build --features-e2e",
            "  run: npm run build:e2e -- -- --locked",
        ] {
            assert!(lines_naming_e2e(kept).is_empty(), "found in {kept:?}");
        }
    }
}
