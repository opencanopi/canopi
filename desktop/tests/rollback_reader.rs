//! The rollback harness's Desktop reader and the writer of the frozen fixtures (Step 2.0.4 R4, canopi-f47t.52.239;
//! contracts §11 Rollback harness, 2.1-M484; plan "reader release: a session over every frozen 2.1 store fixture writes
//! no byte").
//!
//! The contract, frozen at the reader release's tag and extended, never broken: the fixture directory holds
//! `manifest.json` (schema `spec/rollback/manifest.schema.json`, rows `{store, form_version, edition, path}`) and each
//! row's file at its `path`. The reader lists the Desktop rows whose store it knows, skipping a store literal or a field
//! a later release added, runs one reader session over them and finds each read newer-read-only (a Design or Draft past
//! this reader's read refused as newer) and no byte or folder changed; that each raises its notice is held by the
//! presentation tests desktop/src/reader_session.rs names;
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
    /// The first `.canopi` format version 2.1 writes, the floor of what the reader release reads (canopi-format's
    /// `FIRST_READ_VERSION`), frozen here with the contract.
    const FIRST_2_1_CANOPI_VERSION: u32 = 10;

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

    /// The Desktop rows whose store this reader knows, as (store, file); a store literal a later release added is
    /// skipped, never refused (the contract is extended, never broken).
    fn desktop_forms(root: &Path) -> Vec<(String, PathBuf)> {
        manifest_forms(&root.join("manifest.json"))
            .into_iter()
            .filter(|form| {
                form.edition == "desktop" && DESKTOP_STORES.contains(&form.store.as_str())
            })
            .map(|form| (form.store, root.join(form.path)))
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

    /// How one reader session read one store: its open status (`StoreOpenStatus`'s kind) and, for a Design or Draft
    /// opened read-only, the format version its read view says saved it (`saved_by_version`, the input the page's
    /// Read-only label and its `newer-version` popover take).
    #[derive(Debug, Clone, PartialEq)]
    struct StoreRead {
        store: String,
        status: String,
        saved_by_version: Option<u32>,
    }

    /// One reader session over the Desktop forms through the crate's reader-session seam
    /// (`canopi_desktop::reader_session::read_session`): it opens the stores in the app data folder (the folder of the
    /// user DB's file, which holds the Drafts and the library catalogue too) as the app does at launch, lists and opens
    /// the Drafts, opens each Design file read-only, and reports how it read each store.
    fn reader_session(forms: &[(String, PathBuf)]) -> Result<Vec<StoreRead>, String> {
        let data_dir = forms
            .iter()
            .find(|(store, _)| store == "user_db")
            .and_then(|(_, file)| file.parent())
            .ok_or("the forms name the user DB's file")?;
        let designs: Vec<PathBuf> = forms
            .iter()
            .filter(|(store, _)| store == "canopi_file")
            .map(|(_, file)| file.clone())
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
                saved_by_version: read.saved_by_version,
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
                forms.iter().any(|(listed, _)| listed == store),
                "the manifest lists a Desktop {store} form"
            );
        }
        let before = files(&root);

        let health = reader_session(&forms).expect("a reader session opens every Desktop form");
        assert_eq!(
            every_form_read_newer_read_only(&forms, &health),
            Ok(()),
            "every Desktop form opens newer-read-only"
        );

        assert_eq!(files(&root), before, "the session writes no byte");
    }

    /// Each listed Desktop store has an entry (a session that skips a store writes none of its bytes, so the byte
    /// comparison alone would pass it). Every health store reads newer-read-only. Each Design and Draft opens as its
    /// read view with the `saved_by_version` (at least 2.1's first) the page's Read-only label takes, or is refused as
    /// newer than this reader's read admits, which a later release's form may correctly be. That each raises its
    /// notice is held where the page builds notices from these (the presentation tests named in
    /// desktop/src/reader_session.rs).
    fn every_form_read_newer_read_only(
        forms: &[(String, PathBuf)],
        health: &[StoreRead],
    ) -> Result<(), String> {
        if let Some((store, _)) = forms
            .iter()
            .find(|(store, _)| !health.iter().any(|read| &read.store == store))
        {
            return Err(format!("the session reports no health for {store}"));
        }
        for read in health {
            let design = DESIGN_STORES.contains(&read.store.as_str());
            match (read.status.as_str(), read.saved_by_version) {
                ("newer_read_only", None) if !design => {}
                ("newer_read_only", Some(version))
                    if design && version >= FIRST_2_1_CANOPI_VERSION => {}
                ("refused_newer", None) if design => {}
                (status, version) => {
                    let store = &read.store;
                    return Err(format!(
                        "{store} opens {status} saved by {version:?}, not newer_read_only"
                    ));
                }
            }
        }
        Ok(())
    }

    #[test]
    fn r4_canopi_f47t_52_239_the_health_check_fails_a_skipped_or_writable_store_and_passes_a_design_refused_as_newer()
     {
        let forms: Vec<(String, PathBuf)> = DESKTOP_STORES
            .iter()
            .map(|store| (store.to_string(), PathBuf::from(format!("{store}.bin"))))
            .collect();
        let read = |stores: &[&str]| -> Vec<StoreRead> {
            stores
                .iter()
                .map(|store| StoreRead {
                    store: store.to_string(),
                    status: "newer_read_only".to_string(),
                    saved_by_version: DESIGN_STORES
                        .contains(store)
                        .then_some(FIRST_2_1_CANOPI_VERSION),
                })
                .collect()
        };
        let fails =
            |health: Vec<StoreRead>| every_form_read_newer_read_only(&forms, &health).is_err();
        assert!(!fails(read(&DESKTOP_STORES)), "all newer-read-only");
        assert!(fails(Vec::new()), "a session that reports no store fails");
        assert!(
            fails(read(&["user_db", "settings"])),
            "a session that never opens the catalogue or the Draft fails"
        );
        // Each row changes one read (its DESKTOP_STORES index, status, saved_by_version) and says whether that fails. A
        // Design or Draft a later release wrote past this reader's read is refused, writing no byte: never a red lane.
        let first = FIRST_2_1_CANOPI_VERSION;
        let cases = [
            (2, "ready", None, true, "a store opened read-write"),
            (1, "ready", None, true, "a Draft opened to edit"),
            (0, "newer_read_only", None, true, "no saved_by_version"),
            (0, "newer_read_only", Some(first - 1), true, "pre-2.1"),
            (0, "refused_newer", None, false, "a refused Design"),
            (1, "refused_newer", None, false, "a refused Draft"),
            (2, "refused_newer", None, true, "a refused store"),
            (
                2,
                "newer_read_only",
                Some(first),
                true,
                "a health store with a saved_by_version",
            ),
        ];
        for (index, status, version, fail, why) in cases {
            let mut health = read(&DESKTOP_STORES);
            health[index].status = status.to_string();
            health[index].saved_by_version = version;
            assert_eq!(fails(health), fail, "{why}");
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
            [("user_db".to_string(), scratch.0.join("app/user.db"))]
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
