//! The rollback harness's Desktop reader (Step 2.0.4 R4, canopi-f47t.52.239; contracts §11 Rollback harness, 2.1-M484;
//! plan "reader release: a session over every frozen 2.1 store fixture writes no byte").
//!
//! It lists its forms from `spec/rollback/manifest.json` (rows `{store, form_version, edition, path}`, schema
//! `spec/rollback/manifest.schema.json`) under one fixture directory, the in-repo fixtures unless
//! `CANOPI_ROLLBACK_FIXTURES` names another (the rollback lane's writer job), runs one reader session over the Desktop
//! rows and finds no byte changed. `main`'s lane hashes the files itself as well.
//!
//! Written failing in commit 0 and marked expected-fail: no manifest exists yet and this binary has no reader-session
//! seam (R2-2's `open_stores(data_dir)`). R4-2 writes the manifest, replaces `reader_session` with that seam's call
//! asserting each store's newer-read-only health, and removes the marker.

// Inside a cfg(test) module, so clippy reads the helpers as test code (clippy.toml allow-unwrap-in-tests).
#[cfg(test)]
mod reader {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// The Desktop stores a 2.1 session leaves behind, each of which the reader release reads newer-read-only.
    const DESKTOP_STORES: [&str; 5] = [
        "canopi_file",
        "desktop_draft",
        "user_db",
        "library_catalogue",
        "settings",
    ];

    fn repository() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    fn fixture_root() -> PathBuf {
        std::env::var_os("CANOPI_ROLLBACK_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|| repository().join("spec/rollback"))
    }

    /// The manifest's Desktop rows as (store, path under the fixture root).
    fn desktop_forms(root: &Path) -> Vec<(String, PathBuf)> {
        let manifest = root.join("manifest.json");
        let text = std::fs::read_to_string(&manifest).unwrap_or_else(|error| {
            panic!(
                "the rollback manifest {} is missing ({error}); R4-2 writes it",
                manifest.display()
            )
        });
        let manifest: serde_json::Value =
            serde_json::from_str(&text).expect("the manifest is JSON");
        manifest["forms"]
            .as_array()
            .expect("the manifest lists its forms")
            .iter()
            .filter(|form| form["edition"] == "desktop")
            .map(|form| {
                let store = form["store"].as_str().expect("a form names its store");
                let path = form["path"].as_str().expect("a form names its path");
                (store.to_string(), root.join(path))
            })
            .collect()
    }

    /// Every file under `root` with its bytes, except SQLite's engine metadata a read-only open may create (a `-shm`
    /// file or an empty `-wal`; contracts §11 Degraded stores).
    fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                let bytes = std::fs::read(&path).unwrap();
                if name.ends_with("-shm") || (name.ends_with("-wal") && bytes.is_empty()) {
                    continue;
                }
                out.insert(path, bytes);
            }
        }
        let mut out = BTreeMap::new();
        walk(root, &mut out);
        out
    }

    /// One reader session over the Desktop forms: opens each store as the app does at launch and reports its health.
    /// This binary exposes no such seam yet; R4-2 calls R2-2's `open_stores(data_dir)` here.
    fn reader_session(forms: &[(String, PathBuf)]) -> Result<Vec<(String, String)>, String> {
        let _ = forms;
        Err("no reader-session seam: R2-2's open_stores(data_dir) lands it".to_string())
    }

    #[test]
    #[ignore = "expected-fail: R4 canopi-f47t.52.239"]
    fn r4_canopi_f47t_52_239_a_session_over_every_frozen_store_fixture_writes_no_byte_on_desktop() {
        let root = fixture_root();
        let forms = desktop_forms(&root);
        for store in DESKTOP_STORES {
            assert!(
                forms.iter().any(|(listed, _)| listed == store),
                "the manifest lists a Desktop {store} form"
            );
        }
        let before = files(&root);

        let health = reader_session(&forms).expect("a reader session opens every Desktop form");
        for (store, status) in &health {
            assert_eq!(status, "newer_read_only", "{store} opens newer-read-only");
        }

        assert_eq!(files(&root), before, "the session writes no byte");
    }
}
