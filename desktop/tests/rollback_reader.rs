//! The rollback harness's Desktop reader and the writer of the frozen fixtures (Step 2.0.4 R4, canopi-f47t.52.239;
//! contracts §11 Rollback harness, 2.1-M484; plan "reader release: a session over every frozen 2.1 store fixture writes
//! no byte").
//!
//! The contract, frozen at the reader release's tag and extended, never broken: the fixture directory holds
//! `manifest.json` (schema `spec/rollback/manifest.schema.json`, rows `{store, form_version, edition, path}`) and each
//! row's file at its `path`. The reader lists the Desktop rows whose store it knows, skipping a store literal or a field
//! a later release added, runs one reader session over them and finds each store read with the expected rollback-reader
//! status (health stores newer-read-only; v10 Design/Draft files ready; v11+ Design/Draft files refused as newer) and no
//! byte or folder changed; that each raises its notice is held by the presentation tests
//! desktop/src/reader_session.rs names;
//! `main`'s lane hashes the files itself as well (`node policy/gate/cli.mjs rollback-fixtures`).
//!
//! The fixture directory is `CANOPI_ROLLBACK_FIXTURES` when set (the rollback lane's reader jobs, over what the writer
//! job uploaded), else the in-repo frozen fixtures laid down by the writer (`rollback_reader/writer.rs`) into a scratch directory. The writer
//! stands in for every store no build writes yet: it lays down the frozen form of each row of `spec/rollback/manifest.json`
//! (the `.canopi` v10 read fixture, user DB 10 holding settings record 2, catalogue 26, and the Web forms as R3 froze
//! them) and reports each as `FIXTURES-ONLY`; `CANOPI_ROLLBACK_WRITE` names the directory the lane's writer job uploads.
//! A store step that gains a writer replaces its row's frozen form with what the build writes.
//!
//! The reader session runs through the crate's public, doc-hidden seam `canopi_desktop::reader_session`, which opens
//! the stores with the app's own launch and open paths.

#[cfg(test)]
#[path = "rollback_reader/writer.rs"]
mod writer;

// Inside a cfg(test) module, so clippy reads the helpers as test code (clippy.toml allow-unwrap-in-tests).
#[cfg(test)]
mod reader {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// The Desktop stores a 2.1 session leaves behind, each of which the reader release reads newer-read-only.
    pub(crate) const DESKTOP_STORES: [&str; 5] = [
        "canopi_file",
        "desktop_draft",
        "user_db",
        "library_catalogue",
        "settings",
    ];
    /// The Web stores, which the Web harness (desktop/web/e2e-rollback/reader.spec.ts) reads.
    pub(crate) const WEB_STORES: [&str; 3] = ["settings", "web_drafts", "web_species_lists"];
    /// The Desktop stores that hold one Design each, opened as the page opens a Design rather than through store health.
    const DESIGN_STORES: [&str; 2] = ["canopi_file", "desktop_draft"];

    /// One manifest row.
    #[derive(Debug, Clone, PartialEq)]
    pub(crate) struct Form {
        pub(crate) store: String,
        pub(crate) form_version: u64,
        pub(crate) edition: String,
        pub(crate) path: String,
    }

    pub(crate) fn repository() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    /// A directory of its own under the system temporary folder, removed when dropped.
    pub(crate) struct Scratch(pub(crate) PathBuf);

    impl Scratch {
        pub(crate) fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "canopi-rollback-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A row's path as the schema allows it: forward slashes, no leading slash, no segment starting with a dot.
    fn is_safe(path: &str) -> bool {
        !path.is_empty()
            && path.split('/').all(|segment| {
                !segment.is_empty()
                    && !segment.starts_with(['.', '-'])
                    && segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            })
    }

    /// Every row of the manifest at `manifest`; a field a later release added is ignored.
    pub(crate) fn manifest_forms(manifest: &Path) -> Vec<Form> {
        let text = std::fs::read_to_string(manifest).unwrap_or_else(|error| {
            panic!(
                "the rollback manifest {} is missing ({error}): the fixture directory holds manifest.json",
                manifest.display()
            )
        });
        let manifest: serde_json::Value =
            serde_json::from_str(&text).expect("the manifest is JSON");
        assert_eq!(manifest["version"], 1, "manifest version 1");
        manifest["forms"]
            .as_array()
            .expect("the manifest lists its forms")
            .iter()
            .map(|form| {
                let text = |field: &str| {
                    form[field]
                        .as_str()
                        .unwrap_or_else(|| panic!("a form names its {field}: {form}"))
                        .to_string()
                };
                let row = Form {
                    store: text("store"),
                    form_version: form["form_version"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("a form names its form_version: {form}")),
                    edition: text("edition"),
                    path: text("path"),
                };
                assert!(
                    is_safe(&row.path),
                    "a form's path stays under the fixture directory: {}",
                    row.path
                );
                row
            })
            .collect()
    }

    /// The Desktop rows whose store this reader knows, as (store, form_version, file); a store literal a later release
    /// added is skipped, never refused (the contract is extended, never broken).
    fn desktop_forms(root: &Path) -> Vec<(String, u64, PathBuf)> {
        manifest_forms(&root.join("manifest.json"))
            .into_iter()
            .filter(|form| {
                form.edition == "desktop" && DESKTOP_STORES.contains(&form.store.as_str())
            })
            .map(|form| (form.store, form.form_version, root.join(form.path)))
            .collect()
    }

    /// Every file under `root` with its bytes and every directory (`None`), so a created folder is a write too, except
    /// SQLite's engine metadata a read-only open may create (a `-shm` file or an empty `-wal`; contracts §11 Degraded
    /// stores).
    pub(crate) fn files(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                    out.insert(path, None);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                let bytes = std::fs::read(&path).unwrap();
                if name.ends_with("-shm") || (name.ends_with("-wal") && bytes.is_empty()) {
                    continue;
                }
                out.insert(path, Some(bytes));
            }
        }
        let mut out = BTreeMap::new();
        walk(root, &mut out);
        out
    }

    /// How one reader session read one store: its open status (`StoreOpenStatus`'s kind).
    #[derive(Debug, Clone, PartialEq)]
    struct StoreRead {
        store: String,
        status: String,
    }

    /// One reader session over the Desktop forms through the crate's reader-session seam
    /// (`canopi_desktop::reader_session::read_session`): it opens the stores in the app data folder (the folder of the
    /// user DB's file, which holds the Drafts and the library catalogue too) as the app does at launch, lists and opens
    /// the Drafts, opens each Design file, and reports how it read each store without writing any bytes.
    fn reader_session(forms: &[(String, u64, PathBuf)]) -> Result<Vec<StoreRead>, String> {
        let data_dir = forms
            .iter()
            .find(|(store, _, _)| store == "user_db")
            .and_then(|(_, _, file)| file.parent())
            .ok_or("the forms name the user DB's file")?;
        let designs: Vec<PathBuf> = forms
            .iter()
            .filter(|(store, _, _)| store == "canopi_file")
            .map(|(_, _, file)| file.clone())
            .collect();
        let reads = canopi_desktop::reader_session::read_session(data_dir, &designs)?;
        Ok(reads
            .into_iter()
            .map(|read| StoreRead {
                status: serde_json::to_value(&read.status).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string(),
                store: read.store,
            })
            .collect())
    }

    /// The fixture directory: the lane's (`CANOPI_ROLLBACK_FIXTURES`), else the frozen fixtures written into `scratch`.
    fn fixture_root(scratch: &Scratch) -> PathBuf {
        match std::env::var_os("CANOPI_ROLLBACK_FIXTURES") {
            Some(root) => PathBuf::from(root),
            None => {
                let root = scratch.0.join("fixtures");
                crate::writer::write_frozen_fixtures(&root);
                root
            }
        }
    }

    #[test]
    fn r4_canopi_f47t_52_239_a_session_over_every_frozen_store_fixture_writes_no_byte_on_desktop() {
        let scratch = Scratch::new("session");
        let root = fixture_root(&scratch);
        let forms = desktop_forms(&root);
        for store in DESKTOP_STORES {
            assert!(
                forms.iter().any(|(listed, _, _)| listed == store),
                "the manifest lists a Desktop {store} form"
            );
        }
        let before = files(&root);

        let health = reader_session(&forms).expect("a reader session opens every Desktop form");
        assert_eq!(
            every_form_matches_expected_rollback_status(&forms, &health),
            Ok(()),
            "every Desktop form opens with its expected rollback-reader status"
        );

        assert_eq!(files(&root), before, "the session writes no byte");
    }

    /// Each listed Desktop store has an entry (a session that skips a store writes none of its bytes, so the byte
    /// comparison alone would pass it). Every non-Design store reads newer-read-only. Under 2.1-Q347 (v10 cutover),
    /// each Design or Draft at or below `CURRENT_CANOPI_FILE_VERSION` opens `"ready"` (without writing bytes), and
    /// each Design or Draft above `CURRENT_CANOPI_FILE_VERSION` is refused as `"refused_newer"`.
    fn every_form_matches_expected_rollback_status(
        forms: &[(String, u64, PathBuf)],
        health: &[StoreRead],
    ) -> Result<(), String> {
        let current_design_version = u64::from(canopi_types::design::CURRENT_CANOPI_FILE_VERSION);
        if let Some((store, _, _)) = forms
            .iter()
            .find(|(store, _, _)| !health.iter().any(|read| &read.store == store))
        {
            return Err(format!("the session reports no health for {store}"));
        }
        for read in health {
            let design = DESIGN_STORES.contains(&read.store.as_str());
            let form_version = forms
                .iter()
                .find(|(store, _, _)| store == &read.store)
                .map(|(_, version, _)| *version);
            let expected = if !design {
                "newer_read_only"
            } else if form_version.is_some_and(|version| version <= current_design_version) {
                "ready"
            } else {
                "refused_newer"
            };
            if read.status != expected {
                let store = &read.store;
                let status = &read.status;
                return Err(format!("{store} opens {status}, not {expected}"));
            }
        }
        Ok(())
    }

    fn synthetic_desktop_forms(design_version: u64) -> Vec<(String, u64, PathBuf)> {
        DESKTOP_STORES
            .iter()
            .map(|store| {
                let version = if DESIGN_STORES.contains(store) {
                    design_version
                } else {
                    99
                };
                (
                    store.to_string(),
                    version,
                    PathBuf::from(format!("{store}.bin")),
                )
            })
            .collect()
    }

    fn synthetic_health(stores: &[&str], design_status: &str) -> Vec<StoreRead> {
        stores
            .iter()
            .map(|store| StoreRead {
                store: store.to_string(),
                status: if DESIGN_STORES.contains(store) {
                    design_status.to_string()
                } else {
                    "newer_read_only".to_string()
                },
            })
            .collect()
    }

    #[test]
    fn r4_canopi_f47t_52_239_the_health_check_fails_a_skipped_or_writable_store_and_passes_a_design_refused_as_newer()
     {
        let current = u64::from(canopi_types::design::CURRENT_CANOPI_FILE_VERSION);
        let (v10_forms, v11_forms) = (
            synthetic_desktop_forms(current),
            synthetic_desktop_forms(current + 1),
        );
        let fails = |forms: &[(String, u64, PathBuf)], health: Vec<StoreRead>| {
            every_form_matches_expected_rollback_status(forms, &health).is_err()
        };
        assert!(!fails(
            &v10_forms,
            synthetic_health(&DESKTOP_STORES, "ready")
        ));
        assert!(!fails(
            &v11_forms,
            synthetic_health(&DESKTOP_STORES, "refused_newer")
        ));
        assert!(fails(&v10_forms, Vec::new()));
        assert!(fails(
            &v10_forms,
            synthetic_health(&["user_db", "settings"], "ready")
        ));
        for (index, status, fail, why) in [
            (2, "ready", true, "a non-Design store opened read-write"),
            (0, "refused_newer", true, "v10 Design must open ready"),
            (1, "refused_newer", true, "v10 Draft must open ready"),
            (
                0,
                "newer_read_only",
                true,
                "Designs no longer newer_read_only",
            ),
            (2, "refused_newer", true, "a refused non-Design store"),
        ] {
            let mut health = synthetic_health(&DESKTOP_STORES, "ready");
            health[index].status = status.to_string();
            assert_eq!(fails(&v10_forms, health), fail, "{why}");
        }
        for (index, status, fail, why) in [
            (0, "ready", true, "v11 Design must be refused_newer"),
            (1, "ready", true, "v11 Draft must be refused_newer"),
            (0, "refused_newer", false, "v11 Design refused_newer passes"),
            (1, "refused_newer", false, "v11 Draft refused_newer passes"),
        ] {
            let mut health = synthetic_health(&DESKTOP_STORES, "refused_newer");
            health[index].status = status.to_string();
            assert_eq!(fails(&v11_forms, health), fail, "{why}");
        }
    }

    #[test]
    fn r4_canopi_f47t_52_239_a_row_whose_store_or_field_a_later_release_added_is_skipped_never_refused()
     {
        // A further reader release may extend the contract, never break it (design check F1): this reader keeps reading
        // the rows it knows beside a new store literal and a new optional field.
        let scratch = Scratch::new("extended");
        let manifest = serde_json::json!({
            "version": 1,
            "forms": [
                { "store": "user_db", "form_version": 11, "edition": "desktop", "path": "app/user.db", "written_by": "2.2.0" },
                { "store": "desktop_notebook", "form_version": 1, "edition": "desktop", "path": "app/notebook.sqlite" },
                { "store": "web_library", "form_version": 1, "edition": "web", "path": "web/library.json" }
            ]
        });
        std::fs::write(scratch.0.join("manifest.json"), manifest.to_string()).unwrap();
        assert_eq!(
            desktop_forms(&scratch.0),
            [("user_db".to_string(), 11, scratch.0.join("app/user.db"))]
        );
    }

    #[test]
    fn r4_canopi_f47t_52_239_a_row_whose_path_leaves_the_fixture_directory_is_refused() {
        for path in [
            "../user.db",
            "/etc/passwd",
            "app/.hidden",
            "app//user.db",
            "",
            "app\\user.db",
        ] {
            assert!(!is_safe(path), "{path:?}");
        }
        assert!(is_safe("desktop/app-data/lidar/lidar-library.sqlite"));
    }

    #[test]
    fn r4_canopi_f47t_52_239_the_byte_comparison_tolerates_engine_metadata_only() {
        // -wal/-shm created or a file pruned (design check R4-2): a created -shm or an empty -wal is SQLite's engine
        // metadata (contracts §11 Degraded stores), a -wal holding pages is a write, and a pruned file is a change.
        let scratch = Scratch::new("bytes");
        std::fs::write(scratch.0.join("user.db"), b"SQLite format 3\0").unwrap();
        std::fs::write(scratch.0.join("keep.canopi"), b"{}").unwrap();
        let before = files(&scratch.0);
        std::fs::write(scratch.0.join("user.db-shm"), [0u8; 32]).unwrap();
        std::fs::write(scratch.0.join("user.db-wal"), b"").unwrap();
        assert_eq!(files(&scratch.0), before, "engine metadata is no write");
        std::fs::write(scratch.0.join("user.db-wal"), b"frame").unwrap();
        assert_ne!(files(&scratch.0), before, "a -wal holding pages is a write");
        std::fs::remove_file(scratch.0.join("user.db-wal")).unwrap();
        assert_eq!(files(&scratch.0), before);
        // A directory a reader creates, empty or not, is a write (a library opened read-write lays down its folders).
        std::fs::create_dir(scratch.0.join("display-cog")).unwrap();
        assert_ne!(files(&scratch.0), before, "a created directory is a write");
        std::fs::remove_dir(scratch.0.join("display-cog")).unwrap();
        std::fs::remove_file(scratch.0.join("keep.canopi")).unwrap();
        assert_ne!(files(&scratch.0), before, "a pruned file is a change");
    }
}
