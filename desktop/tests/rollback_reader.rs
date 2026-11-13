//! The rollback harness's Desktop reader and the writer of the frozen fixtures (Step 2.0.4 R4, canopi-f47t.52.239;
//! contracts §11 Rollback harness, 2.1-M484; plan "reader release: a session over every frozen 2.1 store fixture writes
//! no byte").
//!
//! The contract, frozen at the reader release's tag and extended, never broken: the fixture directory holds
//! `manifest.json` (schema `spec/rollback/manifest.schema.json`, rows `{store, form_version, edition, path}`) and each
//! row's file at its `path`. The reader lists the Desktop rows whose store it knows, skipping a store literal or a field
//! a later release added, runs one reader session over them and finds each newer-read-only and no byte changed;
//! `main`'s lane hashes the files itself as well (`node policy/gate/cli.mjs rollback-fixtures`).
//!
//! The fixture directory is `CANOPI_ROLLBACK_FIXTURES` when set (the rollback lane's reader jobs, over what the writer
//! job uploaded), else the in-repo frozen fixtures laid down by the writer below into a scratch directory. The writer
//! stands in for every store no build writes yet: it lays down the frozen form of each row of `spec/rollback/manifest.json`
//! (the `.canopi` v10 read fixture, user DB 10 holding settings record 2, catalogue 26, and the Web forms as R3 froze
//! them) and reports each as `FIXTURES-ONLY`; `CANOPI_ROLLBACK_WRITE` names the directory the lane's writer job uploads.
//! A store step that gains a writer replaces its row's frozen form with what the build writes.
//!
//! The reader session itself waits on a public Desktop seam (R2-2's `open_stores` is crate-private, and this binary
//! reaches only the crate's public items), so that test stays marked expected-fail until the seam lands.

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
    /// The Web stores, which the Web harness (desktop/web/e2e-rollback/reader.spec.ts) reads.
    const WEB_STORES: [&str; 3] = ["settings", "web_drafts", "web_species_lists"];

    /// One manifest row.
    #[derive(Debug, Clone, PartialEq)]
    struct Form {
        store: String,
        form_version: u64,
        edition: String,
        path: String,
    }

    fn repository() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    /// A directory of its own under the system temporary folder, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
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
    fn manifest_forms(manifest: &Path) -> Vec<Form> {
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
    /// This binary reaches no such seam yet: a public Desktop entry over R2-2's `open_stores(data_dir)`, the Draft list
    /// and the read-only Design open lands it.
    fn reader_session(forms: &[(String, PathBuf)]) -> Result<Vec<(String, String)>, String> {
        let _ = forms;
        Err("no public reader-session seam in canopi_desktop".to_string())
    }

    /// Runs `sql` into a new SQLite file at `path`, in WAL mode when `wal`, and closes it (a clean close leaves no
    /// `-wal` or `-shm`).
    fn sqlite(path: &Path, sql: &str, wal: bool) -> rusqlite::Connection {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        assert!(
            !path.exists(),
            "the writer never writes over {}",
            path.display()
        );
        let connection = rusqlite::Connection::open(path).unwrap();
        if wal {
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .unwrap();
        }
        connection.execute_batch(sql).unwrap();
        connection
    }

    fn copy(source: &str, target: &Path) {
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        assert!(
            !target.exists(),
            "the writer never writes over {}",
            target.display()
        );
        std::fs::copy(repository().join(source), target).unwrap();
    }

    fn frozen_sql(name: &str) -> String {
        std::fs::read_to_string(
            repository()
                .join("desktop/src/test_fixtures/frozen")
                .join(name),
        )
        .unwrap()
    }

    /// The writer for every store no build writes yet: lays down each row of `spec/rollback/manifest.json` from its
    /// frozen form in `dest`, with the manifest beside them, and returns one `FIXTURES-ONLY` line per row.
    fn write_frozen_fixtures(dest: &Path) -> Vec<String> {
        let manifest = repository().join("spec/rollback/manifest.json");
        let forms = manifest_forms(&manifest);
        std::fs::create_dir_all(dest).unwrap();
        std::fs::copy(&manifest, dest.join("manifest.json")).unwrap();
        let mut report = Vec::new();
        // The settings record lives in the user DB on Desktop, so its row names the user DB's file and is written there.
        let mut desktop_settings = Vec::new();
        for form in &forms {
            let target = dest.join(&form.path);
            match (form.edition.as_str(), form.store.as_str()) {
                ("desktop", "canopi_file" | "desktop_draft") => {
                    copy("canopi-format/spec/v10/read-fixture.canopi", &target);
                }
                ("desktop", "user_db") => {
                    drop(sqlite(&target, &frozen_sql("user-db-10.sql"), false));
                }
                ("desktop", "settings") => desktop_settings.push(target.clone()),
                ("desktop", "library_catalogue") => {
                    drop(sqlite(&target, &frozen_sql("catalogue-26.sql"), true));
                }
                ("web", "settings") => copy("spec/web/frozen/settings.json", &target),
                ("web", "web_drafts") => copy("spec/web/frozen/drafts.json", &target),
                ("web", "web_species_lists") => copy("spec/web/frozen/species-lists.json", &target),
                (edition, store) => {
                    panic!("the writer has no frozen form for the {edition} {store} row")
                }
            }
            report.push(format!(
                "FIXTURES-ONLY {} {} {} {}: no build writes it yet, so the readers read its frozen form",
                form.edition, form.store, form.form_version, form.path
            ));
        }
        for user_db in desktop_settings {
            assert!(
                user_db.is_file(),
                "the Desktop settings row names the user DB's file, {}",
                user_db.display()
            );
            let record: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(
                    repository().join("desktop/src/test_fixtures/frozen/settings-record-2.json"),
                )
                .unwrap(),
            )
            .unwrap();
            let connection = rusqlite::Connection::open(&user_db).unwrap();
            let changed = connection
                .execute(
                    "UPDATE settings SET value = ?1 WHERE key = 'settings'",
                    [record.to_string()],
                )
                .unwrap();
            assert_eq!(changed, 1, "user DB 10 holds the settings row");
        }
        report
    }

    /// The fixture directory: the lane's (`CANOPI_ROLLBACK_FIXTURES`), else the frozen fixtures written into `scratch`.
    fn fixture_root(scratch: &Scratch) -> PathBuf {
        match std::env::var_os("CANOPI_ROLLBACK_FIXTURES") {
            Some(root) => PathBuf::from(root),
            None => {
                let root = scratch.0.join("fixtures");
                write_frozen_fixtures(&root);
                root
            }
        }
    }

    #[test]
    #[ignore = "expected-fail: R4 canopi-f47t.52.239"]
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

    /// Each listed Desktop store has a health entry, and every entry is newer-read-only: a session that skips a store
    /// writes none of its bytes, so the byte comparison alone would pass it. The newer-read-only notice is checked here
    /// too once the reader-session seam reports it.
    fn every_form_read_newer_read_only(
        forms: &[(String, PathBuf)],
        health: &[(String, String)],
    ) -> Result<(), String> {
        if let Some((store, _)) = forms
            .iter()
            .find(|(store, _)| !health.iter().any(|(read, _)| read == store))
        {
            return Err(format!("the session reports no health for {store}"));
        }
        match health
            .iter()
            .find(|(_, status)| status != "newer_read_only")
        {
            Some((store, status)) => Err(format!("{store} opens {status}, not newer_read_only")),
            None => Ok(()),
        }
    }

    #[test]
    fn r4_canopi_f47t_52_239_a_session_that_skips_a_listed_desktop_store_fails_the_health_check() {
        let forms: Vec<(String, PathBuf)> = DESKTOP_STORES
            .iter()
            .map(|store| (store.to_string(), PathBuf::from(format!("{store}.bin"))))
            .collect();
        let read = |stores: &[&str]| -> Vec<(String, String)> {
            stores
                .iter()
                .map(|store| (store.to_string(), "newer_read_only".to_string()))
                .collect()
        };
        let fails = |health: Vec<(String, String)>| {
            every_form_read_newer_read_only(&forms, &health).is_err()
        };
        assert!(
            !fails(read(&DESKTOP_STORES)),
            "every store read newer-read-only passes"
        );
        assert!(fails(Vec::new()), "a session that reports no store fails");
        assert!(
            fails(read(&["user_db", "settings"])),
            "a session that never opens the catalogue or the Draft fails"
        );
        let mut ready = read(&DESKTOP_STORES);
        ready[0].1 = "ready".to_string();
        assert!(fails(ready), "a store opened read-write fails");
    }

    #[test]
    fn r4_canopi_f47t_52_239_the_writer_lays_down_every_frozen_form_the_manifest_lists_and_reports_each_fixtures_only()
     {
        let scratch = Scratch::new("writer");
        let dest = std::env::var_os("CANOPI_ROLLBACK_WRITE")
            .map(PathBuf::from)
            .unwrap_or_else(|| scratch.0.join("fixtures"));
        let report = write_frozen_fixtures(&dest);
        for line in &report {
            println!("{line}");
        }

        let forms = manifest_forms(&dest.join("manifest.json"));
        assert_eq!(report.len(), forms.len(), "one report line per row");
        for (store, edition) in DESKTOP_STORES
            .iter()
            .map(|store| (store, "desktop"))
            .chain(WEB_STORES.iter().map(|store| (store, "web")))
        {
            assert!(
                forms
                    .iter()
                    .any(|form| &form.store == store && form.edition == edition),
                "the manifest lists a {edition} {store} form"
            );
        }
        for form in &forms {
            assert!(dest.join(&form.path).is_file(), "{} is written", form.path);
            assert!(
                report.iter().any(|line| line.starts_with(&format!(
                    "FIXTURES-ONLY {} {} {} {}:",
                    form.edition, form.store, form.form_version, form.path
                ))),
                "{} {} is reported fixtures only",
                form.edition,
                form.store
            );
        }
        assert_each_desktop_form_at_its_version(&dest, &forms);
    }

    /// Each frozen Desktop form is at the version its row names, so a reader opening it reads a newer form, and the
    /// writer's clean close leaves no SQLite sidecar for the lane to mistake for a reader's write.
    fn assert_each_desktop_form_at_its_version(dest: &Path, forms: &[Form]) {
        let path = |store: &str, edition: &str| {
            dest.join(
                &forms
                    .iter()
                    .find(|form| form.store == store && form.edition == edition)
                    .unwrap()
                    .path,
            )
        };
        let version = |store: &str, edition: &str| {
            forms
                .iter()
                .find(|form| form.store == store && form.edition == edition)
                .unwrap()
                .form_version
        };
        for store in ["canopi_file", "desktop_draft"] {
            let design: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(path(store, "desktop")).unwrap())
                    .unwrap();
            assert_eq!(
                design["version"].as_u64(),
                Some(version(store, "desktop")),
                "{store}"
            );
        }
        let user_db = rusqlite::Connection::open_with_flags(
            path("user_db", "desktop"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let user_version: i64 = user_db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(
            user_version.to_string(),
            version("user_db", "desktop").to_string()
        );
        let settings: String = user_db
            .query_row(
                "SELECT value FROM settings WHERE key = 'settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
        assert_eq!(
            settings["version"].as_u64(),
            Some(version("settings", "desktop"))
        );
        let catalogue = rusqlite::Connection::open_with_flags(
            path("library_catalogue", "desktop"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let schema: String = catalogue
            .query_row(
                "SELECT value FROM lidar_catalogue_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, version("library_catalogue", "desktop").to_string());
        drop((user_db, catalogue));
        assert!(
            files(dest).keys().all(|file| {
                let name = file.to_string_lossy();
                !name.ends_with("-wal") && !name.ends_with("-journal")
            }),
            "the writer leaves no SQLite sidecar"
        );
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
        std::fs::remove_file(scratch.0.join("keep.canopi")).unwrap();
        assert_ne!(files(&scratch.0), before, "a pruned file is a change");
    }
}
