//! Where the updater looks and what it asks for (2.1-M205, 2.1-M210): the channel the running
//! version belongs to, the one endpoint table `desktop/updater-endpoints.json` (read here once,
//! for the plugin's endpoint and the client's allowed hosts, and by the release workflow), and the
//! installer-specific channel key this build asks the channel file for.

use common_types::update::{UpdateArch, UpdateBundle, UpdateOs};
use serde::Deserialize;

/// The endpoint table, compiled in: the channel files, the hosts a payload may come from, the
/// release page an offer links to and the page a link-only update is downloaded from.
const ENDPOINTS_JSON: &str = include_str!("../../../updater-endpoints.json");

/// The e2e build's channel endpoint, set when the `updater-e2e` build is compiled
/// (`CANOPI_UPDATER_E2E_ENDPOINT`), so the N-1 to N test serves a local channel file.
#[cfg(feature = "updater-e2e")]
const E2E_ENDPOINT: Option<&str> = option_env!("CANOPI_UPDATER_E2E_ENDPOINT");

#[cfg(all(feature = "updater-e2e", not(debug_assertions)))]
compile_error!(
    "the `updater-e2e` feature points the updater at a test channel; a release build never carries it"
);

/// A release channel: the Cargo version's pre-release label, none for stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// `2.1.0`: reads `stable.json`.
    Stable,
    /// `2.1.0-beta.1`: reads `beta.json`.
    Beta,
}

impl Channel {
    /// The channel of `version`; `None` for a pre-release label that names no channel.
    pub fn of_version(version: &str) -> Option<Self> {
        let version = semver::Version::parse(version).ok()?;
        if version.pre.is_empty() {
            return Some(Self::Stable);
        }
        match version.pre.as_str().split('.').next() {
            Some("beta") => Some(Self::Beta),
            _ => None,
        }
    }

    /// The channel this build belongs to, from the Cargo version.
    pub fn running() -> Option<Self> {
        Self::of_version(env!("CARGO_PKG_VERSION"))
    }
}

/// The parsed endpoint table.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Endpoints {
    channels: ChannelUrls,
    payload_hosts: Vec<String>,
    release_page: String,
    download_page: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ChannelUrls {
    stable: Option<tauri::Url>,
    beta: Option<tauri::Url>,
}

impl Endpoints {
    /// The compiled-in table. A malformed one, which the tests refuse, would name no channel, so
    /// the build would never self-update.
    pub fn compiled() -> Self {
        serde_json::from_str(ENDPOINTS_JSON).unwrap_or_default()
    }

    /// The channel file `channel` reads; the e2e build's override when it has one.
    pub fn channel_url(&self, channel: Channel) -> Option<tauri::Url> {
        #[cfg(feature = "updater-e2e")]
        if let Some(endpoint) = E2E_ENDPOINT.and_then(|text| tauri::Url::parse(text).ok()) {
            return Some(endpoint);
        }
        match channel {
            Channel::Stable => self.channels.stable.clone(),
            Channel::Beta => self.channels.beta.clone(),
        }
    }

    /// The hosts the updater's client may reach, redirects included: the channel files' hosts and
    /// the payload hosts.
    pub fn allowed_hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = [Channel::Stable, Channel::Beta]
            .into_iter()
            .filter_map(|channel| self.channel_url(channel)?.host_str().map(str::to_owned))
            .chain(self.payload_hosts.iter().cloned())
            .collect();
        hosts.sort();
        hosts.dedup();
        hosts
    }

    /// Whether a payload URL the channel file announced is on an allowed host.
    pub fn allows(&self, url: &tauri::Url) -> bool {
        url.host_str()
            .is_some_and(|host| self.allowed_hosts().iter().any(|allowed| allowed == host))
    }

    /// The release page of `version` (2.1-Q236).
    pub fn release_page(&self, version: &str) -> String {
        self.release_page.replace("{version}", version)
    }

    /// The page a link-only update is downloaded from by hand (2.1-Q232).
    pub fn download_page(&self) -> &str {
        &self.download_page
    }
}

/// What this build was installed from: the channel key's three parts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Installation {
    /// The operating system.
    pub os: UpdateOs,
    /// The architecture.
    pub arch: UpdateArch,
    /// The installer.
    pub bundle: UpdateBundle,
}

impl Installation {
    /// The running build's installation; `None` for an unbundled binary (a `--no-bundle` or e2e
    /// build), which has no installer to update and so no self-update.
    pub fn current() -> Option<Self> {
        let bundle = match tauri::utils::platform::bundle_type()? {
            tauri::utils::config::BundleType::Deb => UpdateBundle::Deb,
            tauri::utils::config::BundleType::AppImage => UpdateBundle::Appimage,
            tauri::utils::config::BundleType::Nsis => UpdateBundle::Nsis,
            tauri::utils::config::BundleType::Msi => UpdateBundle::Msi,
            tauri::utils::config::BundleType::App | tauri::utils::config::BundleType::Dmg => {
                UpdateBundle::App
            }
            _ => return None,
        };
        let os = if cfg!(target_os = "windows") {
            UpdateOs::Windows
        } else if cfg!(target_os = "macos") {
            UpdateOs::Darwin
        } else if cfg!(target_os = "linux") {
            UpdateOs::Linux
        } else {
            return None;
        };
        let arch = if cfg!(target_arch = "x86_64") {
            UpdateArch::X86_64
        } else if cfg!(target_arch = "aarch64") {
            UpdateArch::Aarch64
        } else {
            return None;
        };
        Some(Self { os, arch, bundle })
    }

    /// The installer-specific channel key, `{os}-{arch}-{bundle}`; the updater asks for this key
    /// only, never the `{os}-{arch}` fallback, so one installer never receives another's payload.
    pub fn key(self) -> String {
        let os = match self.os {
            UpdateOs::Linux => "linux",
            UpdateOs::Windows => "windows",
            UpdateOs::Darwin => "darwin",
        };
        let arch = match self.arch {
            UpdateArch::X86_64 => "x86_64",
            UpdateArch::Aarch64 => "aarch64",
        };
        let bundle = match self.bundle {
            UpdateBundle::Deb => "deb",
            UpdateBundle::Appimage => "appimage",
            UpdateBundle::Nsis => "nsis",
            UpdateBundle::Msi => "msi",
            UpdateBundle::App => "app",
        };
        format!("{os}-{arch}-{bundle}")
    }
}

#[cfg(test)]
mod tests {
    use super::{Channel, Endpoints, Installation};
    use common_types::update::{UpdateArch, UpdateBundle, UpdateOs};
    use std::path::Path;

    /// The workflows that build what users install: the release candidate and the PR bundle build.
    const RELEASE_WORKFLOWS: [&str; 2] = ["release-candidate.yml", "build.yml"];

    #[test]
    fn a_beta_version_reads_the_beta_channel_and_a_release_the_stable_one() {
        for (version, channel) in [
            ("2.1.0", Some(Channel::Stable)),
            ("2.1.0-beta.1", Some(Channel::Beta)),
            ("2.1.0-beta.12", Some(Channel::Beta)),
            ("2.0.3", Some(Channel::Stable)),
            ("2.1.0-rc.1", None),
            ("not a version", None),
        ] {
            assert_eq!(Channel::of_version(version), channel, "{version}");
        }
        serde_json::from_str::<Endpoints>(super::ENDPOINTS_JSON).expect("the table parses");
        let endpoints = Endpoints::compiled();
        for (channel, url) in [
            (
                Channel::Stable,
                "https://updates.projectcanopi.com/stable.json",
            ),
            (Channel::Beta, "https://updates.projectcanopi.com/beta.json"),
        ] {
            assert_eq!(endpoints.channel_url(channel).unwrap().as_str(), url);
        }
    }

    #[test]
    fn the_running_version_names_a_channel() {
        assert!(
            Channel::running().is_some(),
            "{} has a pre-release label that names no channel in updater-endpoints.json",
            env!("CARGO_PKG_VERSION")
        );
    }

    #[test]
    fn the_client_reaches_the_channel_host_and_the_release_asset_hosts_only() {
        let endpoints = Endpoints::compiled();
        assert_eq!(
            endpoints.allowed_hosts(),
            [
                "github.com",
                "objects.githubusercontent.com",
                "release-assets.githubusercontent.com",
                "updates.projectcanopi.com",
            ]
        );
        for (url, allowed) in [
            (
                "https://github.com/opencanopi/canopi/releases/download/v2.1.0/a.deb",
                true,
            ),
            ("https://release-assets.githubusercontent.com/x", true),
            ("https://example.com/canopi.deb", false),
            ("https://github.com.example.com/a.deb", false),
        ] {
            assert_eq!(endpoints.allows(&url.parse().unwrap()), allowed, "{url}");
        }
        assert_eq!(
            endpoints.release_page("2.1.0"),
            "https://github.com/opencanopi/canopi/releases/tag/v2.1.0"
        );
        assert_eq!(endpoints.download_page(), "https://projectcanopi.com");
    }

    #[test]
    fn each_installer_asks_for_its_own_channel_key_only() {
        for (os, bundle, key) in [
            (UpdateOs::Windows, UpdateBundle::Nsis, "windows-x86_64-nsis"),
            (UpdateOs::Windows, UpdateBundle::Msi, "windows-x86_64-msi"),
            (UpdateOs::Linux, UpdateBundle::Deb, "linux-x86_64-deb"),
            (
                UpdateOs::Linux,
                UpdateBundle::Appimage,
                "linux-x86_64-appimage",
            ),
        ] {
            let installation = Installation {
                os,
                arch: UpdateArch::X86_64,
                bundle,
            };
            assert_eq!(installation.key(), key);
        }
    }

    /// An unbundled test binary has no installer, so no self-update.
    #[test]
    fn an_unbundled_binary_has_no_installation() {
        if cfg!(target_os = "macos") {
            return;
        }
        assert_eq!(Installation::current(), None);
    }

    /// The `updater-e2e` build points the updater at a test channel; it never ships, so the
    /// release workflows never name it (the `e2e` feature has its own test in `host/mod.rs`).
    #[test]
    fn release_workflows_never_build_the_updater_e2e_feature() {
        let workflows = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.github/workflows");
        for name in RELEASE_WORKFLOWS {
            let path = workflows.join(name);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("{} must be readable: {error}", path.display()));
            let named: Vec<(usize, &str)> = text
                .lines()
                .enumerate()
                .filter(|(_, line)| line.contains("updater-e2e"))
                .map(|(index, line)| (index + 1, line.trim()))
                .collect();
            assert!(
                named.is_empty(),
                "{name} names the `updater-e2e` feature, which never ships (2.1-M205): {named:?}"
            );
        }
    }
}
