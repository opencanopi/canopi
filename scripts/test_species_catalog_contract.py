import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest

from scripts import species_catalog_contract as contract


SCRIPT_DIR = Path(__file__).parent
CONTRACT_CLI = SCRIPT_DIR / "species_catalog_contract.py"
CONTRACT_PATH = SCRIPT_DIR / "schema-contract.json"
FILTER_PATH = SCRIPT_DIR.parent / "common-types/plant-filter-fields.json"
NORMALIZATION_PATH = (
    SCRIPT_DIR.parent / "common-types/species-search-normalization.json"
)
UNICODE_FACTS_PATH = SCRIPT_DIR.parent / "common-types/species-search-unicode-15.json"


def copy_contract_sources(root: Path) -> None:
    contract_dir = root / "scripts"
    filter_dir = root / "common-types"
    contract_dir.mkdir(parents=True)
    filter_dir.mkdir(parents=True)
    (contract_dir / "schema-contract.json").write_text(
        CONTRACT_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (filter_dir / "plant-filter-fields.json").write_text(
        FILTER_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (filter_dir / "species-search-normalization.json").write_text(
        NORMALIZATION_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (filter_dir / "species-search-unicode-15.json").write_text(
        UNICODE_FACTS_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )


def create_minimal_export_database(path: Path) -> None:
    source = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE _metadata (key TEXT PRIMARY KEY, value TEXT)")
        connection.execute(
            "INSERT INTO _metadata (key, value) VALUES ('schema_version', ?)",
            (str(source["min_export_schema_version"]),),
        )
        species_columns = [
            column for column in source["columns"] if column.get("required", False)
        ]
        connection.execute(
            "CREATE TABLE species ("
            + ", ".join(
                f"{column['name']} {column['type']}" for column in species_columns
            )
            + ")"
        )
        for table in source["supporting_tables"]:
            required_columns = [
                column
                for column in table["columns"]
                if column.get("required", False)
            ]
            connection.execute(
                f"CREATE TABLE {table['name']} ("
                + ", ".join(
                    f"{column['name']} {column['type']}"
                    for column in required_columns
                )
                + ")"
            )
        connection.commit()
    finally:
        connection.close()


def create_prepared_database(path: Path) -> None:
    source = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    projection = contract.project(contract.ProjectionTarget.PREPARE_DB)
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "CREATE TABLE species ("
            + ", ".join(
                f"{column['name']} {column['type']}" for column in source["columns"]
            )
            + ")"
        )
        for table in source["supporting_tables"]:
            connection.execute(
                f"CREATE TABLE {table['name']} ("
                + ", ".join(
                    f"{column['name']} {column['type']}"
                    for column in table["columns"]
                )
                + ")"
            )
        for table in source["prepared_tables"]:
            columns = ", ".join(
                f"{column['name']} {column['type']}" for column in table["columns"]
            )
            if table.get("virtual_module") == "fts5":
                options = ", ".join(
                    f'{key}="{value}"' if "'" in value else f"{key}='{value}'"
                    for key, value in table["virtual_options"].items()
                )
                connection.execute(
                    f"CREATE VIRTUAL TABLE {table['name']} USING fts5("
                    + ", ".join(column["name"] for column in table["columns"])
                    + f", {options})"
                )
            else:
                connection.execute(f"CREATE TABLE {table['name']} ({columns})")
        connection.executemany(
            "INSERT INTO species_search_metadata (key, value) VALUES (?, ?)",
            [
                ("schema_version", str(projection.prepared_schema_version)),
                ("storage_contract_fingerprint", projection.fingerprint),
                (
                    "normalization_version",
                    str(projection.species_search_normalization_version),
                ),
                (
                    "normalization_fingerprint",
                    projection.species_search_normalization_fingerprint,
                ),
            ],
        )
        for table, indexes in source["indexes"].items():
            for index in indexes:
                connection.execute(
                    f"CREATE INDEX {index['name']} ON {table}({index['columns']})"
                )
        connection.execute(f"PRAGMA user_version = {source['schema_version']}")
        connection.commit()
    finally:
        connection.close()


class SpeciesCatalogContractCliTests(unittest.TestCase):
    def test_value_commands_read_versions_from_the_authored_contract(self):
        authored = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        release = contract.project(contract.ProjectionTarget.RELEASE)

        cases = {
            "prepared-schema-version": authored["schema_version"],
            "minimum-export-schema-version": authored["min_export_schema_version"],
            "prepared-source-export-sha256": authored["prepared_artifact"][
                "source_export_sha256"
            ],
            "prepared-contract-fingerprint": release.fingerprint,
            "prepared-db-asset-name": (
                f"canopi-core-v{release.prepared_schema_version}-"
                f"{release.fingerprint}-"
                f"{release.source_export_sha256}.db"
            ),
        }
        for value_name, expected in cases.items():
            with self.subTest(value_name=value_name):
                result = subprocess.run(
                    [sys.executable, str(CONTRACT_CLI), "value", value_name],
                    cwd=SCRIPT_DIR.parent,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, f"{expected}\n")
                self.assertEqual(result.stderr, "")

    def test_emit_rust_write_command_uses_the_selected_repository_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)

            result = subprocess.run(
                [
                    sys.executable,
                    str(CONTRACT_CLI),
                    "--root",
                    str(root),
                    "emit-rust",
                    "--write",
                ],
                cwd=SCRIPT_DIR.parent,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(
                (root / "desktop/src/db/schema_contract_generated.rs").is_file()
            )
            self.assertIn("Wrote generated Species Catalog Rust facts", result.stdout)
            self.assertEqual(result.stderr, "")

    def test_release_callers_use_contract_commands_without_source_scraping(self):
        callers = [
            SCRIPT_DIR / "publish-db-release.sh",
            SCRIPT_DIR.parent / ".github/workflows/release-candidate.yml",
        ]
        for caller in callers:
            with self.subTest(caller=caller):
                source = caller.read_text(encoding="utf-8")
                self.assertIn("species_catalog_contract.py check", source)
                self.assertIn(
                    "species_catalog_contract.py value prepared-schema-version",
                    source,
                )
                self.assertIn(
                    "species_catalog_contract.py value prepared-db-asset-name",
                    source,
                )
                self.assertIn(
                    "species_catalog_contract.py verify-db --profile prepared",
                    source,
                )
                self.assertNotIn("schema_contract.rs", source)
                self.assertNotIn("EXPECTED_PLANT_SCHEMA_VERSION", source)

    def test_bundled_database_assets_are_selected_by_compiled_prepared_identity(self):
        publish = (SCRIPT_DIR / "publish-db-release.sh").read_text(encoding="utf-8")
        build = (SCRIPT_DIR.parent / ".github/workflows/build.yml").read_text(
            encoding="utf-8"
        )
        release_candidate = (
            SCRIPT_DIR.parent / ".github/workflows/release-candidate.yml"
        ).read_text(encoding="utf-8")

        for source in (publish, build, release_candidate):
            self.assertIn(
                "species_catalog_contract.py value prepared-db-asset-name",
                source,
            )
        self.assertNotIn("--clobber", publish)
        self.assertNotIn("CANOPI_CORE_DB_ASSET_NAME", build)
        self.assertNotIn("db_asset_name:", release_candidate.split("jobs:", 1)[0])
        self.assertIn("desktop/resources/canopi-core.db", build)
        self.assertIn("github.event.pull_request.head.repo.full_name", build)

    def test_publisher_stages_exact_immutable_asset_basenames_for_custom_output(self):
        release = contract.project(contract.ProjectionTarget.RELEASE)
        asset_name = (
            f"canopi-core-v{release.prepared_schema_version}-"
            f"{release.fingerprint}-{release.source_export_sha256}.db"
        )
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            gh_log = temp / "gh-args"
            custom_output = temp / "operator-selected-name.db"
            custom_output.write_bytes(b"prepared catalog")

            self._write_executable(
                fake_bin / "python3",
                f"""#!/usr/bin/env bash
if [[ "$*" == *"catalog-asset-name"* ]]; then
  printf '%s\\n' 'canopi-web-catalog-test.tar.gz'
elif [[ "$*" == *"pack-catalog"* ]]; then
  for out; do :; done
  printf 'catalog' > "$out"
elif [[ "$*" == *"value prepared-schema-version"* ]]; then
  printf '%s\\n' '{release.prepared_schema_version}'
elif [[ "$*" == *"value prepared-db-asset-name"* ]]; then
  printf '%s\\n' '{asset_name}'
fi
""",
            )
            self._write_executable(
                fake_bin / "sha256sum",
                """#!/usr/bin/env bash
printf '%064d  %s\\n' 0 "$1"
""",
            )
            self._write_executable(
                fake_bin / "gh",
                """#!/usr/bin/env bash
printf '__CALL__\\0' >> "$GH_LOG"
printf '%s\\0' "$@" >> "$GH_LOG"
""",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            environment["GH_LOG"] = str(gh_log)

            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPT_DIR / "publish-db-release.sh"),
                    "--export-path",
                    str(temp / "export.db"),
                    "--output-path",
                    str(custom_output),
                    "--repo",
                    "example/canopi",
                ],
                cwd=SCRIPT_DIR.parent,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [
                arguments
                for arguments in (
                    call.split(b"\0")
                    for call in gh_log.read_bytes().split(b"__CALL__\0")
                    if call
                )
            ]
            upload = [argument.decode() for argument in calls[-1] if argument]
            self.assertEqual(upload[:3], ["release", "upload", "canopi-core-db"])
            self.assertEqual(Path(upload[3]).name, asset_name)
            self.assertEqual(Path(upload[4]).name, f"{asset_name}.sha256")
            self.assertEqual(Path(upload[5]).name, "canopi-web-catalog-test.tar.gz")
            self.assertEqual(Path(upload[6]).name, "canopi-web-catalog-test.tar.gz.sha256")
            for argument in upload[3:7]:
                self.assertNotIn("#", argument)
            self.assertEqual(upload[7:], ["--repo", "example/canopi"])

    def test_publisher_refuses_identity_changed_during_prepare(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            identity_changed = temp / "identity-changed"
            gh_log = temp / "gh-args"
            custom_output = temp / "operator-selected-name.db"
            custom_output.write_bytes(b"prepared catalog")

            self._write_executable(
                fake_bin / "python3",
                """#!/usr/bin/env bash
if [[ "$*" == *"catalog-asset-name"* ]]; then
  printf '%s\\n' 'canopi-web-catalog-test.tar.gz'
elif [[ "$*" == *"pack-catalog"* ]]; then
  for out; do :; done
  printf 'catalog' > "$out"
elif [[ "$*" == *"value prepared-schema-version"* ]]; then
  printf '%s\\n' '13'
elif [[ "$*" == *"value prepared-db-asset-name"* ]]; then
  if [[ -e "$IDENTITY_CHANGED" ]]; then
    printf '%s\\n' 'canopi-core-v13-new-identity.db'
  else
    printf '%s\\n' 'canopi-core-v13-old-identity.db'
  fi
elif [[ "$*" == *"prepare-db.py"* ]]; then
  touch "$IDENTITY_CHANGED"
fi
""",
            )
            self._write_executable(
                fake_bin / "sha256sum",
                """#!/usr/bin/env bash
printf '%064d  %s\\n' 0 "$1"
""",
            )
            self._write_executable(
                fake_bin / "gh",
                """#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$GH_LOG"
""",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            environment["IDENTITY_CHANGED"] = str(identity_changed)
            environment["GH_LOG"] = str(gh_log)

            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPT_DIR / "publish-db-release.sh"),
                    "--export-path",
                    str(temp / "export.db"),
                    "--output-path",
                    str(custom_output),
                    "--repo",
                    "example/canopi",
                ],
                cwd=SCRIPT_DIR.parent,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("identity changed during preparation", result.stderr)
            if gh_log.exists():
                self.assertNotIn(b"upload", gh_log.read_bytes().split(b"\0"))

    def test_publisher_reverifies_source_snapshot_after_prepare(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            source_changed = temp / "source-changed"
            gh_log = temp / "gh-args"
            custom_output = temp / "operator-selected-name.db"
            custom_output.write_bytes(b"prepared catalog")

            self._write_executable(
                fake_bin / "python3",
                """#!/usr/bin/env bash
if [[ "$*" == *"catalog-asset-name"* ]]; then
  printf '%s\\n' 'canopi-web-catalog-test.tar.gz'
elif [[ "$*" == *"pack-catalog"* ]]; then
  for out; do :; done
  printf 'catalog' > "$out"
elif [[ "$*" == *"value prepared-schema-version"* ]]; then
  printf '%s\\n' '13'
elif [[ "$*" == *"value prepared-db-asset-name"* ]]; then
  printf '%s\\n' 'canopi-core-v13-stable-identity.db'
elif [[ "$*" == *"prepare-db.py"* ]]; then
  touch "$SOURCE_CHANGED"
elif [[ "$*" == *"verify-source-export"* && -e "$SOURCE_CHANGED" ]]; then
  printf '%s\\n' 'source snapshot changed during preparation' >&2
  exit 1
fi
""",
            )
            self._write_executable(
                fake_bin / "sha256sum",
                """#!/usr/bin/env bash
printf '%064d  %s\\n' 0 "$1"
""",
            )
            self._write_executable(
                fake_bin / "gh",
                """#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$GH_LOG"
""",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            environment["SOURCE_CHANGED"] = str(source_changed)
            environment["GH_LOG"] = str(gh_log)

            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPT_DIR / "publish-db-release.sh"),
                    "--export-path",
                    str(temp / "export.db"),
                    "--output-path",
                    str(custom_output),
                    "--repo",
                    "example/canopi",
                ],
                cwd=SCRIPT_DIR.parent,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("source snapshot changed during preparation", result.stderr)
            if gh_log.exists():
                self.assertNotIn(b"upload", gh_log.read_bytes().split(b"\0"))

    def _run_publisher(self, temp: Path, published_assets: list[str], *extra: str):
        fake_bin = temp / "bin"
        fake_bin.mkdir()
        self._write_executable(
            fake_bin / "python3",
            """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PY_LOG"
if [[ "$*" == *"catalog-asset-name"* ]]; then
  printf '%s\\n' 'canopi-web-catalog-test.tar.gz'
elif [[ "$*" == *"pack-catalog"* ]]; then
  for out; do :; done
  printf 'catalog' > "$out"
elif [[ "$*" == *"value prepared-schema-version"* ]]; then
  printf '%s\\n' '13'
elif [[ "$*" == *"value prepared-db-asset-name"* ]]; then
  printf '%s\\n' 'canopi-core-v13-published.db'
elif [[ "$*" == *"prepare-db.py"* ]]; then
  printf 'prepared' > "$OUTPUT_PATH"
fi
""",
        )
        self._write_executable(
            fake_bin / "sha256sum",
            """#!/usr/bin/env bash
printf '%064d  %s\\n' 0 "$1"
""",
        )
        self._write_executable(
            fake_bin / "gh",
            """#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$GH_LOG"
printf '\\n' >> "$GH_LOG"
if [[ "$1 $2" == "release view" ]]; then
  printf '%s' "$PUBLISHED_ASSETS"
fi
""",
        )
        environment = os.environ.copy()
        environment.update(
            PATH=f"{fake_bin}:{environment['PATH']}",
            PY_LOG=str(temp / "py-log"),
            GH_LOG=str(temp / "gh-log"),
            OUTPUT_PATH=str(temp / "prepared.db"),
            PUBLISHED_ASSETS="".join(f"{name}\n" for name in published_assets),
        )
        result = subprocess.run(
            ["bash", str(SCRIPT_DIR / "publish-db-release.sh"), "--export-path", str(temp / "export.db"),
             "--output-path", str(temp / "prepared.db"), "--repo", "example/canopi", *extra],
            cwd=SCRIPT_DIR.parent, env=environment, capture_output=True, text=True, check=False,
        )
        python_calls = (temp / "py-log").read_text().splitlines() if (temp / "py-log").exists() else []
        gh_calls = [
            [argument for argument in line.split("\0") if argument]
            for line in ((temp / "gh-log").read_text().splitlines() if (temp / "gh-log").exists() else [])
        ]
        return result, python_calls, gh_calls

    def test_web_catalog_only_adds_the_catalog_to_a_published_db_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, python_calls, gh_calls = self._run_publisher(
                Path(tmp), ["canopi-core-v13-published.db"], "--web-catalog-only")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any("prepare-db.py" in call for call in python_calls))
        self.assertTrue(any("verify-source-export" in call for call in python_calls))
        self.assertTrue(any(call.startswith("scripts/generate-web-catalog.py --export-path") for call in python_calls))
        upload = gh_calls[-1]
        self.assertEqual(upload[:3], ["release", "upload", "canopi-core-db"])
        self.assertEqual([Path(argument).name for argument in upload[3:5]],
                         ["canopi-web-catalog-test.tar.gz", "canopi-web-catalog-test.tar.gz.sha256"])
        self.assertEqual(upload[5:], ["--repo", "example/canopi"])

    def test_publisher_uploads_db_and_catalog_together_from_one_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, python_calls, gh_calls = self._run_publisher(Path(tmp), [])

        self.assertEqual(result.returncode, 0, result.stderr)
        prepare = next(call for call in python_calls if "prepare-db.py" in call)
        generate = next(call for call in python_calls if "generate-web-catalog.py" in call)
        self.assertIn(prepare.split("--export-path ")[1].split()[0], generate)
        self.assertEqual([Path(argument).name for argument in gh_calls[-1][3:7]], [
            "canopi-core-v13-published.db", "canopi-core-v13-published.db.sha256",
            "canopi-web-catalog-test.tar.gz", "canopi-web-catalog-test.tar.gz.sha256"])

    def test_dry_run_builds_and_names_both_assets_but_uploads_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, python_calls, gh_calls = self._run_publisher(Path(tmp), [], "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any("prepare-db.py" in call for call in python_calls))
        self.assertTrue(any("generate-web-catalog.py" in call for call in python_calls))
        self.assertFalse(any(call[:2] == ["release", "upload"] for call in gh_calls))
        for name in ["canopi-core-v13-published.db", "canopi-web-catalog-test.tar.gz"]:
            self.assertIn(f"Would upload: {name}\n", result.stdout)
            self.assertIn(f"Would upload: {name}.sha256\n", result.stdout)

    def test_publisher_refuses_published_identities_and_a_catalog_without_its_db(self):
        cases = [
            ([], ("--web-catalog-only",), "needs canopi-core-v13-published.db"),
            (["canopi-web-catalog-test.tar.gz", "canopi-core-v13-published.db"], ("--web-catalog-only",),
             "already published"),
            (["canopi-core-v13-published.db"], (), "use --web-catalog-only"),
        ]
        for published, extra, message in cases:
            with self.subTest(published=published, extra=extra), tempfile.TemporaryDirectory() as tmp:
                result, python_calls, gh_calls = self._run_publisher(Path(tmp), published, *extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(any("generate-web-catalog.py" in call for call in python_calls))
                self.assertFalse(any(call[:2] == ["release", "upload"] for call in gh_calls))

    def test_source_export_identity_changes_asset_not_prepared_semantics(self):
        baseline = contract.project(contract.ProjectionTarget.RELEASE)
        baseline_web = contract.project(contract.ProjectionTarget.WEB_CATALOG)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["prepared_artifact"]["source_export_sha256"] = "b" * 64
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            changed = contract.project(contract.ProjectionTarget.RELEASE, root=root)
            changed_web = contract.project(
                contract.ProjectionTarget.WEB_CATALOG,
                root=root,
            )

        self.assertEqual(changed.fingerprint, baseline.fingerprint)
        self.assertEqual(changed_web.fingerprint, baseline_web.fingerprint)
        self.assertNotEqual(
            changed.source_export_sha256,
            baseline.source_export_sha256,
        )
        self.assertNotEqual(
            contract.prepared_database_asset_name(changed),
            contract.prepared_database_asset_name(baseline),
        )

    def test_source_export_identity_verifies_exact_authored_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            export_path = root / "export.db"
            export_path.write_bytes(b"candidate export bytes")
            expected_sha256 = hashlib.sha256(export_path.read_bytes()).hexdigest()
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["prepared_artifact"]["source_export_sha256"] = expected_sha256
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            self.assertEqual(
                contract.verify_source_export_identity(export_path, root=root),
                expected_sha256,
            )
            export_path.write_bytes(b"different export bytes")
            with self.assertRaisesRegex(
                contract.SpeciesCatalogContractError,
                r"source export SHA-256.*does not equal authored",
            ):
                contract.verify_source_export_identity(export_path, root=root)

    @staticmethod
    def _write_executable(path: Path, source: str) -> None:
        path.write_text(source, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def test_release_builds_pin_code_and_database_to_preflight(self):
        workflow = (
            SCRIPT_DIR.parent / ".github/workflows/release-candidate.yml"
        ).read_text(encoding="utf-8")
        build_job = workflow.split("\n  build:\n", 1)[1].split(
            "\n  web:\n",
            1,
        )[0]
        web_job = workflow.split("\n  web:\n", 1)[1].split(
            "\n  manifest:\n",
            1,
        )[0]
        self.assertIn("ref: ${{ needs.preflight.outputs.head_sha }}", web_job)
        self.assertIn("needs.preflight.outputs.web_catalog_asset_name", web_job)
        self.assertIn('sha256sum --check --strict "$ASSET_NAME.sha256"', web_job)
        self.assertIn("web_release.py unpack-catalog", web_job)
        self.assertIn('--commit "$HEAD_SHA"', web_job)

        self.assertIn(
            'expected_db_sha256="${{ needs.preflight.outputs.db_sha256 }}"',
            build_job,
        )
        self.assertIn(
            'DB_PATH="$db_path" node <<\'NODE\'',
            build_job,
        )
        self.assertIn(
            "fs.createReadStream(process.env.DB_PATH)",
            build_job,
        )
        self.assertIn(
            'if [[ "$actual_db_sha256" != "$expected_db_sha256" ]]; then',
            build_job,
        )
        # The DB is hashed with node on every runner; only the Linux-only bundler-tools step uses sha256sum.
        db_step = build_job.split("- name: Download bundled plant DB", 1)[1].split("\n      - ", 1)[0]
        self.assertNotIn("sha256sum", db_step)
        self.assertIn(
            "ref: ${{ needs.preflight.outputs.head_sha }}",
            build_job,
        )
        self.assertNotIn("ref: ${{ inputs.ref }}", build_job)


class LinuxBuildBaseTests(unittest.TestCase):
    """The Linux packages' build base agrees across both workflows (canopi-eon8.14.6).

    2.0.1 built on ubuntu-latest and needed GLIBC_2.39. Both workflows build the
    Linux row in the same container, name it in every Rust cache key that row
    restores, and start the packages on Debian 12; the smoke script's glibc floor
    is that image's glibc.
    """

    ROOT = SCRIPT_DIR.parent
    IMAGE_GLIBC = {"ubuntu:22.04": "2.35"}

    def _read(self, relative: str) -> str:
        return (self.ROOT / relative).read_text(encoding="utf-8")

    @staticmethod
    def _job(workflow: str, name: str) -> str:
        body = workflow.split(f"\n  {name}:\n", 1)[1]
        end = re.search(r"\n  [A-Za-z0-9_-]+:\n", body)
        return body[: end.start()] if end else body

    def _build_jobs(self):
        release_candidate = self._read(".github/workflows/release-candidate.yml")
        build = self._read(".github/workflows/build.yml")
        return {
            "release-candidate.yml": (release_candidate, self._job(release_candidate, "build")),
            "build.yml": (build, self._job(build, "build")),
        }

    def _linux_images(self):
        release_candidate = self._read(".github/workflows/release-candidate.yml")
        build = self._read(".github/workflows/build.yml")
        rc_entries = re.findall(
            r"- os: (ubuntu-[^\n]+)\n((?:            [^\n]*\n)+)",
            self._job(release_candidate, "build"),
        )
        rc_images = [
            (re.search(r"container: (\S+)", body) or [None, None])[1]
            for _, body in rc_entries
        ]
        build_entries = re.findall(r'\{"os": "ubuntu-[^}]*\}', build)
        build_images = [
            (re.search(r'"container": "([^"]+)"', entry) or [None, None])[1]
            for entry in build_entries
        ]
        return rc_images, build_images

    def test_canopi_eon8_14_6_every_linux_package_row_builds_in_the_same_image(self):
        rc_images, build_images = self._linux_images()
        self.assertTrue(rc_images, "Release Candidate has a Linux matrix row")
        self.assertTrue(build_images, "Build & Test has a Linux packaging row")
        images = set(rc_images) | set(build_images)
        self.assertEqual(len(images), 1, f"Linux rows disagree: {images}")
        image = images.pop()
        self.assertIn(image, self.IMAGE_GLIBC, "a Linux row has no container")
        smoke = self._read("scripts/smoke-bundled-sidecar.sh")
        self.assertIn(f"GLIBC_FLOOR={self.IMAGE_GLIBC[image]}\n", smoke)

    def test_canopi_eon8_14_6_build_jobs_run_the_row_image_and_key_caches_by_it(self):
        for name, (_, job) in self._build_jobs().items():
            with self.subTest(workflow=name):
                self.assertIn("    container: ${{ matrix.container }}\n", job)
                self.assertIn(
                    "shared-key: release-${{ matrix.target }}"
                    "${{ matrix.container && format('-{0}', matrix.container) || '' }}",
                    job,
                )
                # The image has no curl: dependencies come before the toolchain.
                self.assertLess(
                    job.index("./.github/actions/install-linux-deps"),
                    job.index("dtolnay/rust-toolchain"),
                )
                self.assertIn("./.github/actions/build-geolibre-cli", job)
        geolibre = self._read(".github/actions/build-geolibre-cli/action.yml")
        self.assertIn("/etc/os-release", geolibre)
        self.assertRegex(
            geolibre,
            r"key: geolibre-cli-[^\n]*\$\{\{ steps\.base\.outputs\.image \}\}",
        )

    def test_canopi_eon8_14_6_linux_packages_start_on_debian_12(self):
        for name, (workflow, _) in self._build_jobs().items():
            with self.subTest(workflow=name):
                floor = self._job(workflow, "linux-floor")
                self.assertIn("    container: debian:12\n", floor)
                self.assertIn("name: canopi-x86_64-unknown-linux-gnu", floor)
                self.assertIn(
                    "scripts/smoke-bundled-sidecar.sh x86_64-unknown-linux-gnu bundle",
                    floor,
                )
        release_candidate = self._read(".github/workflows/release-candidate.yml")
        self.assertIn("linux-floor", self._job(release_candidate, "manifest").split("\n")[0])


class GeneratedRustContractTests(unittest.TestCase):
    def test_check_rejects_stale_generated_rust_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generated_dir = root / "desktop/src/db"
            copy_contract_sources(root)
            generated_dir.mkdir(parents=True)
            generated_path = generated_dir / "schema_contract_generated.rs"
            generated_path.write_text("stale generated facts\n", encoding="utf-8")

            with self.assertRaises(contract.GeneratedArtifactDriftError):
                contract.sync_generated(contract.SyncMode.CHECK, root=root)

            self.assertEqual(
                generated_path.read_text(encoding="utf-8"),
                "stale generated facts\n",
            )

    def test_write_emits_all_storage_facts_and_makes_check_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generated_dir = root / "desktop/src/db"
            copy_contract_sources(root)
            generated_dir.mkdir(parents=True)
            mode_probe = generated_dir / "mode-probe"
            mode_probe.touch(mode=0o666)
            expected_mode = stat.S_IMODE(mode_probe.stat().st_mode)
            mode_probe.unlink()

            generated_path = contract.sync_generated(
                contract.SyncMode.WRITE,
                root=root,
            )
            generated = generated_path.read_text(encoding="utf-8")
            self.assertEqual(
                stat.S_IMODE(generated_path.stat().st_mode),
                expected_mode,
            )

            self.assertIn("SPECIES_STORAGE_CONTRACT_FINGERPRINT", generated)
            self.assertIn('(\"id\", \"TEXT\", true)', generated)
            self.assertIn('\"species_common_names\"', generated)
            self.assertIn('(\"species_search_fts\", Some(\"fts5\"))', generated)
            self.assertIn(
                '(\"species_search_fts\", \"content\", \"species_search_text\")',
                generated,
            )
            self.assertIn(
                '(\"species\", \"idx_species_id\", &[\"id\"])',
                generated,
            )
            self.assertEqual(
                contract.sync_generated(contract.SyncMode.CHECK, root=root),
                generated_path,
            )

    def test_write_preserves_existing_generated_file_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generated_dir = root / "desktop/src/db"
            copy_contract_sources(root)
            generated_dir.mkdir(parents=True)
            generated_path = generated_dir / "schema_contract_generated.rs"
            generated_path.write_text("stale\n", encoding="utf-8")
            generated_path.chmod(0o640)

            contract.sync_generated(contract.SyncMode.WRITE, root=root)

            self.assertEqual(
                stat.S_IMODE(generated_path.stat().st_mode),
                0o640,
            )


class ContractValidationTests(unittest.TestCase):
    def test_project_rejects_a_storage_normalization_version_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["species_search_normalization_version"] = 999
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            self.assertIn(
                "species_search_normalization_version: expected 1, found 999",
                str(raised.exception),
            )

    def test_project_aggregates_contract_invariant_violations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_dir = root / "scripts"
            source = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            source["contract_format_version"] = 1
            source["schema_version"] = 0
            source["columns"].append({"name": "id", "type": "TEXT"})
            source["supporting_tables"].append("species_common_names")
            source["indexes"]["species"].append(
                {"name": "not a safe index", "columns": "missing_column"}
            )
            (contract_dir / "schema-contract.json").write_text(
                json.dumps(source),
                encoding="utf-8",
            )

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            message = str(raised.exception)
            self.assertIn("schema_version", message)
            self.assertIn("columns[154].name", message)
            self.assertIn("supporting_tables[6]", message)
            self.assertIn("indexes.species[28].name", message)
            self.assertIn("indexes.species[28].columns", message)

    def test_project_requires_closed_source_export_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["prepared_artifact"] = {
                "source_export_sha256": "A" * 64,
                "unexpected": True,
            }
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            message = str(raised.exception)
            self.assertIn("prepared_artifact.unexpected: unknown property", message)
            self.assertIn(
                "prepared_artifact.source_export_sha256: expected 64 lowercase",
                message,
            )

    def test_project_rejects_index_columns_absent_from_contracted_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["indexes"]["species_images"][0]["columns"] = (
                "definitely_missing"
            )
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            self.assertIn(
                "indexes.species_images[0].columns: unknown species_images "
                "column 'definitely_missing'",
                str(raised.exception),
            )

    def test_project_rejects_sql_bearing_values_outside_closed_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["columns"][0]["type"] = "TEXT); DROP TABLE species; --"
            source["columns"][1]["type"] = []
            source["translations"]["habit"]["Tree"]["xx"] = "Tree"
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            message = str(raised.exception)
            self.assertIn(
                "columns[0].type: unsupported SQLite declared type",
                message,
            )
            self.assertIn(
                "columns[1].type: unsupported SQLite declared type",
                message,
            )
            self.assertIn(
                "translations.habit.Tree.xx: locale has no contracted "
                "translated_values column",
                message,
            )

    def test_project_requires_storage_table_column_shapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            del source["supporting_tables"][1]["columns"]
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            self.assertIn(
                "supporting_tables[1].columns: expected an array",
                str(raised.exception),
            )

    def test_project_rejects_supporting_table_named_species(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            source["supporting_tables"].append(
                {
                    "name": "species",
                    "required": True,
                    "columns": source["columns"],
                }
            )
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            self.assertIn(
                "supporting_tables[6].name: storage table 'species' is already "
                "contracted",
                str(raised.exception),
            )

    def test_project_validates_translated_values_storage_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            translated_values = next(
                table
                for table in source["supporting_tables"]
                if table["name"] == "translated_values"
            )
            translated_values["columns"] = [
                column
                for column in translated_values["columns"]
                if column["name"] != "field_name"
            ]
            next(
                column
                for column in translated_values["columns"]
                if column["name"] == "value_fr"
            )["type"] = "REAL"
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            message = str(raised.exception)
            self.assertIn(
                "translated_values.field_name: required TEXT column is missing",
                message,
            )
            self.assertIn(
                "translated_values.value_fr: locale column must have TEXT affinity",
                message,
            )


class ContractProjectionTests(unittest.TestCase):
    def test_prepare_db_projection_is_typed_and_caller_shaped(self):
        projection = contract.project(contract.ProjectionTarget.PREPARE_DB)
        authored = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

        self.assertEqual(
            projection.prepared_schema_version,
            authored["schema_version"],
        )
        self.assertEqual(
            projection.minimum_export_schema_version,
            authored["min_export_schema_version"],
        )
        self.assertEqual(projection.species_columns[0].name, "id")
        self.assertEqual(
            projection.species_columns[0].affinity,
            contract.SQLiteAffinity.TEXT,
        )
        self.assertEqual(projection.supporting_tables[0].name, "species_common_names")
        self.assertIn(
            "best_common_names",
            {table.name for table in projection.prepared_tables},
        )
        self.assertEqual(
            next(
                table
                for table in projection.prepared_tables
                if table.name == "species_search_fts"
            ).virtual_module,
            "fts5",
        )
        self.assertIsInstance(projection.translations[0], contract.TranslationEntry)
        self.assertFalse(any(isinstance(value, dict) for value in projection.__dict__.values()))

    def test_storage_projection_carries_species_search_normalization_identity(self):
        projection = contract.project(contract.ProjectionTarget.PREPARE_DB)
        normalization = json.loads(NORMALIZATION_PATH.read_text(encoding="utf-8"))

        self.assertEqual(
            projection.species_search_normalization_version,
            normalization["normalization_version"],
        )
        self.assertRegex(
            projection.species_search_normalization_fingerprint,
            r"^[0-9a-f]{64}$",
        )

    def test_storage_fingerprint_includes_the_normalization_authority(self):
        baseline = contract.project(contract.ProjectionTarget.RELEASE).fingerprint
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            normalization_path = (
                root / "common-types/species-search-normalization.json"
            )
            normalization = json.loads(
                normalization_path.read_text(encoding="utf-8")
            )
            normalization["corpus"][0]["name"] = "changed-semantic-corpus"
            normalization_path.write_text(
                json.dumps(normalization),
                encoding="utf-8",
            )

            changed = contract.project(
                contract.ProjectionTarget.RELEASE,
                root=root,
            ).fingerprint

        self.assertNotEqual(changed, baseline)

    def test_web_only_projection_changes_do_not_invalidate_prepared_identity(self):
        baseline_prepare = contract.project(contract.ProjectionTarget.PREPARE_DB)
        baseline_release = contract.project(contract.ProjectionTarget.RELEASE)
        baseline_web = contract.project(contract.ProjectionTarget.WEB_CATALOG)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            self.assertNotIn("family", source["web_projection"]["species_columns"])
            source["web_projection"]["species_columns"].append("family")
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            changed_prepare = contract.project(
                contract.ProjectionTarget.PREPARE_DB,
                root=root,
            )
            changed_release = contract.project(
                contract.ProjectionTarget.RELEASE,
                root=root,
            )
            changed_web = contract.project(
                contract.ProjectionTarget.WEB_CATALOG,
                root=root,
            )

        self.assertEqual(changed_prepare.fingerprint, baseline_prepare.fingerprint)
        self.assertEqual(changed_release.fingerprint, baseline_release.fingerprint)
        self.assertNotEqual(changed_web.fingerprint, baseline_web.fingerprint)

    def test_web_catalog_projection_is_reduced_to_physical_dependencies(self):
        projection = contract.project(contract.ProjectionTarget.WEB_CATALOG)

        column_names = tuple(column.name for column in projection.species_columns)
        self.assertEqual(
            column_names,
            (
                "id",
                "slug",
                "canonical_name",
                "common_name",
                "habit",
                "growth_form_type",
                "growth_form_shape",
                "growth_habit",
                "is_annual",
                "is_biennial",
                "is_perennial",
                "climate_zones",
                "image_urls",
            ),
        )
        self.assertNotIn("growth_form", column_names)
        self.assertNotIn("life_cycles", column_names)
        self.assertEqual(
            tuple(table.name for table in projection.supporting_tables),
            (
                "species_common_names",
                "species_images",
                "species_climate_zones",
            ),
        )
        self.assertEqual(
            projection.supported_filter_keys,
            ("climate_zones", "habit", "life_cycle"),
        )

    def test_web_behavior_validation_rejects_unknown_keys_and_output_columns(self):
        projection = contract.project(contract.ProjectionTarget.WEB_CATALOG)
        self.assertIsInstance(projection, contract.WebCatalogProjection)

        with self.assertRaises(contract.WebProjectionError) as raised:
            contract.validate_web_catalog_behavior(
                projection,
                emitted_species_fields=("id", "climate_zones"),
                filters=(
                    contract.WebFilterUse("climate_zones", ("climate_zones",)),
                    contract.WebFilterUse("not_a_filter", ("not_emitted",)),
                ),
                storage_uses=(),
            )

        message = str(raised.exception)
        self.assertIn("unsupported Filter key 'not_a_filter'", message)
        self.assertIn("required Filter key 'habit' is missing", message)
        self.assertIn("required Filter key 'life_cycle' is missing", message)
        self.assertIn("output column 'not_emitted' is not emitted", message)


class FilterStorageValidationTests(unittest.TestCase):
    def test_project_rejects_missing_and_wrong_affinity_filter_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            filter_path = root / "common-types/plant-filter-fields.json"
            source = json.loads(filter_path.read_text(encoding="utf-8"))
            source["fields"][1]["sql_column"] = "s.not_a_species_column"
            source["fields"][2]["sql_column"] = "s.family"
            source["fixed_filters"][0]["predicate"]["clauses"][0]["clause"] = (
                "s.also_missing = 1"
            )
            source["fixed_filters"][5]["predicate"]["column"] = "s.family"
            filter_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.FilterContractError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            message = str(raised.exception)
            self.assertIn("fields[1].sql_column", message)
            self.assertIn("unknown Species column 'not_a_species_column'", message)
            self.assertIn("fields[2].sql_column", message)
            self.assertIn("expected INTEGER affinity, found TEXT", message)
            self.assertIn("fixed_filters[0].predicate.clauses[0].clause", message)
            self.assertIn("unknown Species column 'also_missing'", message)
            self.assertIn("fixed_filters[5].predicate.column", message)
            self.assertIn("expected numeric affinity, found TEXT", message)

    def test_project_validates_climate_zone_join_storage_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            contract_path = root / "scripts/schema-contract.json"
            source = json.loads(contract_path.read_text(encoding="utf-8"))
            climate_table = next(
                table
                for table in source["supporting_tables"]
                if table["name"] == "species_climate_zones"
            )
            climate_table["columns"] = [
                column
                for column in climate_table["columns"]
                if column["name"] != "climate_zone"
            ]
            web_climate_table = next(
                table
                for table in source["web_projection"]["supporting_tables"]
                if table["name"] == "species_climate_zones"
            )
            web_climate_table["columns"].remove("climate_zone")
            source["indexes"]["species_climate_zones"][0]["columns"] = "species_id"
            contract_path.write_text(json.dumps(source), encoding="utf-8")

            with self.assertRaises(contract.FilterContractError) as raised:
                contract.project(contract.ProjectionTarget.RELEASE, root=root)

            self.assertIn(
                "fixed_filters[8].predicate: supporting table "
                "'species_climate_zones' is missing TEXT column 'climate_zone'",
                str(raised.exception),
            )


class DatabaseVerificationTests(unittest.TestCase):
    def test_export_profile_rejects_fractional_schema_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "export.db"
            create_minimal_export_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE _metadata")
                connection.execute("CREATE TABLE _metadata (key TEXT, value REAL)")
                connection.execute(
                    "INSERT INTO _metadata VALUES ('schema_version', 14.5)"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.EXPORT,
                    database_path,
                    root=root,
                )

            self.assertIn(
                "_metadata.schema_version: expected a decimal integer value",
                str(raised.exception),
            )

    def test_export_profile_accepts_required_shape_and_reports_optional_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "export.db"
            create_minimal_export_database(database_path)

            receipt = contract.verify_database(
                contract.DatabaseProfile.EXPORT,
                database_path,
                root=root,
            )

            authored = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            self.assertEqual(
                receipt.observed_schema_version,
                authored["min_export_schema_version"],
            )
            self.assertEqual(receipt.profile, contract.DatabaseProfile.EXPORT)
            self.assertIn(
                "optional Species column 'common_name' is absent",
                receipt.warnings,
            )

    def test_web_export_profile_keeps_supporting_sources_optional(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "web-export.db"
            create_minimal_export_database(database_path)
            source = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            connection = sqlite3.connect(database_path)
            try:
                for table in source["supporting_tables"]:
                    connection.execute(f"DROP TABLE {table['name']}")
                connection.commit()
            finally:
                connection.close()

            receipt = contract.verify_database(
                contract.DatabaseProfile.WEB_EXPORT,
                database_path,
                root=root,
            )

            authored = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            self.assertEqual(
                receipt.observed_schema_version,
                authored["min_export_schema_version"],
            )
            self.assertIn(
                "optional table 'species_common_names' is absent",
                receipt.warnings,
            )
            self.assertIn(
                "optional table 'species_images' is absent",
                receipt.warnings,
            )
            self.assertIn(
                "optional table 'species_climate_zones' is absent",
                receipt.warnings,
            )

    def test_prepared_profile_accepts_exact_schema_and_contracted_indexes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)

            receipt = contract.verify_database(
                contract.DatabaseProfile.PREPARED,
                database_path,
                root=root,
            )

            authored = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            self.assertEqual(
                receipt.observed_schema_version,
                authored["schema_version"],
            )
            self.assertEqual(receipt.profile, contract.DatabaseProfile.PREPARED)
            self.assertEqual(receipt.warnings, ())

    def test_prepared_profile_rejects_missing_search_normalization_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE IF EXISTS species_search_metadata")
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            self.assertIn("species_search_metadata", str(raised.exception))

    def test_prepared_profile_rejects_wrong_search_normalization_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            projection = contract.project(contract.ProjectionTarget.PREPARE_DB)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS species_search_metadata "
                    "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
                )
                connection.execute("DELETE FROM species_search_metadata")
                connection.executemany(
                    "INSERT INTO species_search_metadata (key, value) VALUES (?, ?)",
                    [
                        ("schema_version", str(projection.prepared_schema_version)),
                        ("storage_contract_fingerprint", projection.fingerprint),
                        (
                            "normalization_version",
                            str(projection.species_search_normalization_version),
                        ),
                        ("normalization_fingerprint", "wrong"),
                    ],
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            self.assertIn("normalization_fingerprint", str(raised.exception))

    def test_prepared_profile_rejects_duplicate_and_extra_identity_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            projection = contract.project(contract.ProjectionTarget.PREPARE_DB)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE species_search_metadata")
                connection.execute(
                    "CREATE TABLE species_search_metadata "
                    "(key TEXT NOT NULL, value TEXT NOT NULL)"
                )
                identity = [
                    ("schema_version", str(projection.prepared_schema_version)),
                    ("storage_contract_fingerprint", projection.fingerprint),
                    (
                        "normalization_version",
                        str(projection.species_search_normalization_version),
                    ),
                    (
                        "normalization_fingerprint",
                        projection.species_search_normalization_fingerprint,
                    ),
                ]
                connection.executemany(
                    "INSERT INTO species_search_metadata (key, value) VALUES (?, ?)",
                    [*identity, identity[-1], ("unexpected", "value")],
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            message = str(raised.exception)
            self.assertIn("expected exactly one identity value", message)
            self.assertIn("unexpected identity key", message)

    def test_prepared_profile_rejects_missing_runtime_generated_tables(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE species_search_fts")
                connection.execute("DROP TABLE best_common_names")
                connection.execute(
                    "CREATE TABLE best_common_names "
                    "(species_id TEXT, language TEXT)"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            message = str(raised.exception)
            self.assertIn("species_search_fts", message)
            self.assertIn("best_common_names.common_name", message)

    def test_prepared_profile_rejects_ordinary_table_in_place_of_fts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE species_search_fts")
                connection.execute(
                    "CREATE TABLE species_search_fts ("
                    "canonical_name BLOB, common_names BLOB, family_genus BLOB, "
                    "uses_text BLOB, other_text BLOB)"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            self.assertIn(
                "species_search_fts: expected SQLite virtual table module 'fts5'",
                str(raised.exception),
            )

    def test_prepared_profile_rejects_wrong_fts_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE species_search_fts")
                connection.execute(
                    "CREATE VIRTUAL TABLE species_search_fts USING fts5("
                    "canonical_name, common_names, family_genus, uses_text, "
                    "other_text, tokenize='porter')"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            message = str(raised.exception)
            self.assertIn(
                "species_search_fts: expected virtual option "
                "content='species_search_text'",
                message,
            )
            self.assertIn(
                "species_search_fts: expected virtual option "
                "tokenize=\"unicode61 remove_diacritics 2 tokenchars '_'\"",
                message,
            )

    def test_prepared_profile_rejects_reordered_fts_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP TABLE species_search_fts")
                connection.execute(
                    "CREATE VIRTUAL TABLE species_search_fts USING fts5("
                    "common_names, canonical_name, family_genus, uses_text, "
                    "other_text, content='species_search_text', "
                    "content_rowid='species_rowid', "
                    "tokenize=\"unicode61 remove_diacritics 2 tokenchars '_'\")"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            self.assertIn(
                "species_search_fts: expected ordered virtual columns "
                "('canonical_name', 'common_names', 'family_genus', "
                "'uses_text', 'other_text')",
                str(raised.exception),
            )

    def test_prepared_profile_aggregates_version_affinity_and_index_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            source = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("PRAGMA user_version = 1")
                connection.execute("DROP TABLE species")
                connection.execute(
                    "CREATE TABLE species ("
                    + ", ".join(
                        f"{column['name']} "
                        f"{'INTEGER' if column['name'] == 'id' else column['type']}"
                        for column in source["columns"]
                    )
                    + ")"
                )
                connection.execute("DROP INDEX idx_cn_species_lang")
                connection.execute(
                    "CREATE INDEX idx_cn_species_lang "
                    "ON species_common_names(language, species_id)"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            message = str(raised.exception)
            self.assertIn(
                "PRAGMA user_version: prepared schema version 1 does not equal",
                message,
            )
            self.assertIn(
                "species.id: expected TEXT affinity, found INTEGER",
                message,
            )
            self.assertIn(
                "indexes.idx_species_id: required index on 'species' is missing",
                message,
            )
            self.assertIn(
                "indexes.idx_cn_species_lang: expected columns "
                "('species_id', 'language'), found ('language', 'species_id')",
                message,
            )

    def test_prepared_profile_rejects_partial_required_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP INDEX idx_species_id")
                connection.execute(
                    "CREATE INDEX idx_species_id ON species(id) WHERE 0"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            self.assertIn(
                "indexes.idx_species_id: required index must not be partial",
                str(raised.exception),
            )

    def test_prepared_profile_rejects_required_index_with_nonbinary_collation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy_contract_sources(root)
            database_path = root / "prepared.db"
            create_prepared_database(database_path)
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("DROP INDEX idx_species_id")
                connection.execute(
                    "CREATE INDEX idx_species_id ON species(id COLLATE NOCASE)"
                )
                connection.commit()
            finally:
                connection.close()

            with self.assertRaises(contract.DatabaseContractError) as raised:
                contract.verify_database(
                    contract.DatabaseProfile.PREPARED,
                    database_path,
                    root=root,
                )

            self.assertIn(
                "indexes.idx_species_id: expected BINARY collation for column "
                "'id', found NOCASE",
                str(raised.exception),
            )


if __name__ == "__main__":
    unittest.main()
