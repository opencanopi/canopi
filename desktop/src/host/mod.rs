//! The Desktop host: what Canopi asks of the operating system around its one window.
//!
//! The `e2e` feature builds the binary the real-app suite drives (`desktop/web/e2e/platform/`,
//! 2.1-M213): `tauri build --debug --no-bundle --features e2e`, under its own identifier
//! `com.canopi.e2e` so its single-instance name and data folders never meet the user's Canopi.
//! The feature adds no code today; it exists so a test-only seam has one switch, and it never
//! reaches a release: a release build with it does not compile, a build with it never carries the
//! MCP bridge, and `tests::release_workflows_never_build_the_e2e_feature` refuses it in the release
//! workflows.

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!(
    "the `e2e` feature is for the real-app suite's debug build only; a release build never carries it"
);

#[cfg(all(feature = "e2e", feature = "mcp-bridge"))]
compile_error!(
    "the `e2e` build never enables the MCP bridge: the suite drives the app through tauri-driver alone"
);

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// The workflows that build what users install: the release candidate and the PR bundle build.
    const RELEASE_WORKFLOWS: [&str; 2] = ["release-candidate.yml", "build.yml"];
    const E2E_FEATURE: &str = "e2e";

    /// Each line naming the `e2e` feature, as `--features <list>` or `--features=<list>` on a command
    /// line or a YAML `features:` value. A list is split on commas and spaces, quotes and brackets
    /// dropped, so `updater-e2e` and other names containing `e2e` do not match.
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

    /// The feature lists one line gives: each `--features` argument and a `features:` key's value.
    fn feature_values(line: &str) -> Vec<String> {
        let mut values = Vec::new();
        let mut rest = line;
        while let Some(at) = rest.find("--features") {
            let after = &rest[at + "--features".len()..];
            let argument = after
                .strip_prefix('=')
                .or_else(|| after.strip_prefix(char::is_whitespace))
                .map(str::trim_start);
            if let Some(argument) = argument {
                values.push(first_argument(argument));
            }
            rest = after;
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
    fn the_e2e_feature_is_found_in_each_form_and_other_names_are_not() {
        for planted in [
            "npx @tauri-apps/cli@2.12.3 build --features e2e -- --locked",
            "cargo build --release --features=e2e",
            "cargo build --features \"mcp-bridge,e2e\"",
            "tauri build --features 'mcp-bridge e2e'",
            "          features: e2e",
            "  features: [mcp-bridge, e2e]",
            "  - features: \"e2e\"",
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
        ] {
            assert!(lines_naming_e2e(kept).is_empty(), "found in {kept:?}");
        }
    }
}
