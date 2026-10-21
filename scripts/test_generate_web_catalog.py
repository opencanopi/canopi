import importlib.util
from dataclasses import replace
import json
import sqlite3
import stat
import tempfile
from pathlib import Path
import unittest
from unittest import mock

from scripts import species_catalog_contract as contract


def load_generator_module():
    module_path = Path(__file__).with_name("generate-web-catalog.py")
    spec = importlib.util.spec_from_file_location("generate_web_catalog", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = load_generator_module()
EXPECTED_LOCALES = [
    "en",
    "fr",
    "es",
    "pt",
    "it",
    "zh",
    "de",
    "ja",
    "ko",
    "nl",
    "ru",
]


class GenerateWebCatalogTests(unittest.TestCase):
    def test_the_default_output_is_the_web_builds_catalog_input_outside_public(self):
        """2.1-M176: the Web build places the catalog under assets/catalog/<content id>/ from catalog-input/;
        a catalog under public/ would ship at a fixed, mutable path."""
        self.assertEqual(generator.DEFAULT_OUTPUT_DIR, generator.REPO_ROOT / "desktop/web/catalog-input")

    def test_generates_reduced_duckdb_compatible_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)

            manifest = generator.generate_web_catalog(
                export_path=export_path,
                output_dir=output_dir,
                species_shard_count=2,
                image_shard_count=2,
                max_asset_bytes=25 * 1024 * 1024,
            )

            self.assertEqual(manifest["asset_format"], "parquet")
            self.assertRegex(
                manifest["artifact_contract_fingerprint"],
                r"^[0-9a-f]{64}$",
            )
            self.assertEqual(manifest["duckdb"]["reader"], "read_parquet")
            self.assertEqual(manifest["locales"], EXPECTED_LOCALES)
            self.assertEqual(
                manifest["supported_filters"],
                [
                    {
                        "key": "climate_zones",
                        "options_key": "climate_zones",
                        "predicate": {
                            "kind": "json_array_any",
                            "columns": ["climate_zones"],
                        },
                    },
                    {
                        "key": "habit",
                        "options_key": "habits",
                        "predicate": {
                            "kind": "text_any",
                            "columns": ["habit", "growth_form"],
                        },
                    },
                    {
                        "key": "life_cycle",
                        "options_key": "life_cycles",
                        "predicate": {
                            "kind": "json_array_any",
                            "columns": ["life_cycles"],
                        },
                    },
                ],
            )
            self.assertNotIn(
                "woody",
                [field["key"] for field in manifest["supported_filters"]],
            )
            self.assertEqual(
                manifest["schema"]["species_fields"],
                [
                    {"name": "id", "logical_type": "required_text"},
                    {"name": "slug", "logical_type": "required_text"},
                    {"name": "canonical_name", "logical_type": "required_text"},
                    {"name": "common_name", "logical_type": "nullable_text"},
                    {"name": "normalized_canonical_name", "logical_type": "required_text"},
                    {"name": "normalized_common_name", "logical_type": "nullable_text"},
                    {"name": "climate_zones", "logical_type": "json_text_array"},
                    {"name": "habit", "logical_type": "nullable_text"},
                    {"name": "growth_form", "logical_type": "nullable_text"},
                    {"name": "life_cycles", "logical_type": "json_text_array"},
                ],
            )
            self.assertEqual(
                sorted(asset["path"] for asset in manifest["assets"]["species"]),
                ["species/species-0000.parquet", "species/species-0001.parquet"],
            )
            for asset in manifest["assets"]["species"]:
                species_asset = output_dir / asset["path"]
                self.assertEqual(species_asset.read_bytes()[:4], b"PAR1")
                self.assertEqual(species_asset.read_bytes()[-4:], b"PAR1")
            self.assertEqual(
                sorted(manifest["assets"]["names"].keys()),
                sorted(EXPECTED_LOCALES),
            )
            self.assertEqual(
                manifest["assets"]["names"]["fr"]["path"],
                "names/names-fr.parquet",
            )

            species_rows = read_manifest_rows(
                output_dir,
                manifest["assets"]["species"],
                fields=schema_field_names(manifest, "species_fields"),
            )
            apple = next(row for row in species_rows if row["slug"] == "malus-domestica")
            self.assertEqual(apple["canonical_name"], "Malus domestica")
            self.assertEqual(apple["common_name"], "Apple")
            self.assertEqual(apple["normalized_canonical_name"], "malus domestica")
            self.assertEqual(apple["normalized_common_name"], "apple")
            self.assertEqual(apple["climate_zones"], ["Boreal", "Temperate"])
            self.assertEqual(apple["habit"], "Tree")
            self.assertEqual(apple["growth_form"], "Tree")
            self.assertEqual(apple["life_cycles"], ["Perennial"])
            balm = next(row for row in species_rows if row["slug"] == "melissa-officinalis")
            self.assertEqual(balm["normalized_canonical_name"], "strasse officinalis")
            self.assertEqual(balm["normalized_common_name"], "cafe balm")

            forbidden = json.dumps(species_rows)
            for field in [
                "edibility",
                "hardiness",
                "height",
                "stratum",
                "soil_ph",
                "native_distribution",
            ]:
                self.assertNotIn(field, forbidden)

            french_names = read_manifest_rows(
                output_dir,
                [manifest["assets"]["names"]["fr"]],
                fields=schema_field_names(manifest, "names_fields"),
            )
            self.assertEqual(french_names, [{
                "species_id": "species-apple",
                "language": "fr",
                "common_name": "Pommier",
                "normalized_name": "pommier",
                "is_primary": True,
                "display_order": 0,
            }])
            japanese_names = read_manifest_rows(
                output_dir,
                [manifest["assets"]["names"]["ja"]],
                fields=schema_field_names(manifest, "names_fields"),
            )
            self.assertEqual(japanese_names, [])

            self.assertEqual(
                sorted(asset["path"] for asset in manifest["assets"]["images"]),
                ["images/images-0000.parquet", "images/images-0001.parquet"],
            )
            image_rows = read_manifest_rows(
                output_dir,
                manifest["assets"]["images"],
                fields=schema_field_names(manifest, "images_fields"),
            )
            self.assertEqual(
                next(row for row in image_rows if row["species_id"] == "species-apple"),
                {
                    "species_id": "species-apple",
                    "url": "https://example.test/apple-primary.jpg",
                    "source": None,
                    "source_page_url": None,
                    "credit": None,
                    "license": None,
                },
            )
            self.assertEqual(
                next(row for row in image_rows if row["species_id"] == "species-balm")["source"],
                None,
            )

    def test_generation_uses_compiled_asset_layout_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            plan = generator.ARTIFACT_PLAN
            plan = replace_artifact_table(
                plan,
                generator.artifact_contract.ArtifactTable.SPECIES,
                directory="plant-rows",
                filename_prefix="plant-chunk-",
            )
            plan = replace_artifact_table(
                plan,
                generator.artifact_contract.ArtifactTable.NAMES,
                directory="localized-names",
                filename_prefix="locale-",
            )
            plan = replace_artifact_table(
                plan,
                generator.artifact_contract.ArtifactTable.IMAGES,
                directory="hero-images",
                filename_prefix="hero-chunk-",
            )

            with mock.patch.object(generator, "ARTIFACT_PLAN", plan):
                manifest = generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertEqual(
                manifest["assets"]["species"][0]["path"],
                "plant-rows/plant-chunk-0000.parquet",
            )
            self.assertEqual(
                manifest["assets"]["names"]["fr"]["path"],
                "localized-names/locale-fr.parquet",
            )
            self.assertEqual(
                manifest["assets"]["images"][0]["path"],
                "hero-images/hero-chunk-0000.parquet",
            )

    def test_generation_rejects_row_schema_the_projector_cannot_produce(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            plan = generator.ARTIFACT_PLAN
            species = next(
                table
                for table in plan.tables
                if table.table is generator.artifact_contract.ArtifactTable.SPECIES
            )
            plan = replace_artifact_table(
                plan,
                generator.artifact_contract.ArtifactTable.SPECIES,
                fields=species.fields + (
                    generator.artifact_contract.ArtifactField(
                        name="future_field",
                        logical_type="nullable_text",
                    ),
                ),
            )

            with (
                mock.patch.object(generator, "ARTIFACT_PLAN", plan),
                self.assertRaisesRegex(
                    generator.ArtifactProjectionError,
                    r"tables\.species\.fields.*future_field.*cannot derive",
                ),
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertFalse(output_dir.exists())

    def test_generation_rejects_logical_type_drift_before_reading_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            plan = generator.ARTIFACT_PLAN
            images = next(
                table
                for table in plan.tables
                if table.table is generator.artifact_contract.ArtifactTable.IMAGES
            )
            plan = replace_artifact_table(
                plan,
                generator.artifact_contract.ArtifactTable.IMAGES,
                fields=tuple(
                    replace(field, logical_type="required_text")
                    if field.name == "source"
                    else field
                    for field in images.fields
                ),
            )

            with (
                mock.patch.object(generator, "ARTIFACT_PLAN", plan),
                mock.patch.object(
                    generator.storage_contract,
                    "verify_database",
                ) as verify_database,
                self.assertRaisesRegex(
                    generator.ArtifactProjectionError,
                    r"tables\.images\.fields\.source.*nullable_text.*required_text",
                ),
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            verify_database.assert_not_called()
            self.assertFalse(output_dir.exists())

    def test_generation_rejects_shard_counts_outside_the_compiled_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            plan = replace_artifact_table(
                generator.ARTIFACT_PLAN,
                generator.artifact_contract.ArtifactTable.SPECIES,
                filename_index_width=1,
            )

            with (
                mock.patch.object(generator, "ARTIFACT_PLAN", plan),
                mock.patch.object(
                    generator.storage_contract,
                    "verify_database",
                ) as verify_database,
                self.assertRaisesRegex(
                    generator.artifact_contract.ArtifactLayoutError,
                    r"species.*11 shards.*one-digit index",
                ),
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=11,
                    image_shard_count=1,
                )

            verify_database.assert_not_called()
            self.assertFalse(output_dir.exists())

    def test_asset_size_check_fails_for_oversized_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            oversized = output_dir / "catalog-worker.wasm"
            oversized.write_bytes(b"123456")

            with self.assertRaises(generator.AssetSizeError):
                generator.assert_asset_sizes(output_dir, max_asset_bytes=5)

    def test_manifest_asset_limit_failure_preserves_existing_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            (output_dir / "species").mkdir(parents=True)
            (output_dir / "species" / "existing.parquet").write_bytes(
                b"existing species asset"
            )
            mark_owned_catalog(output_dir)
            catalog_before = snapshot_directory(output_dir)
            siblings_before = snapshot_directory(root)

            with self.assertRaises(
                generator.artifact_contract.ManifestBuildError
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                    max_asset_bytes=1,
                )

            self.assertEqual(snapshot_directory(output_dir), catalog_before)
            self.assertEqual(snapshot_directory(root), siblings_before)

    def test_success_replaces_existing_catalog_without_work_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            output_dir.mkdir()
            mark_owned_catalog(output_dir)
            stale_asset = output_dir / "stale.parquet"
            stale_asset.write_bytes(b"stale catalog")
            output_dir.chmod(0o555)
            expected_mode = stat.S_IMODE(output_dir.stat().st_mode)

            manifest = generator.generate_web_catalog(
                export_path=export_path,
                output_dir=output_dir,
                species_shard_count=1,
                image_shard_count=1,
            )

            self.assertFalse(stale_asset.exists())
            self.assertEqual(
                json.loads((output_dir / "manifest.json").read_text(encoding="utf-8")),
                manifest,
            )
            self.assertEqual(
                {child.name for child in root.iterdir()},
                {export_path.name, output_dir.name},
            )
            self.assertEqual(
                stat.S_IMODE(output_dir.stat().st_mode),
                expected_mode,
            )

    def test_destination_created_during_generation_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            original_size_check = generator.assert_asset_sizes

            def create_unowned_destination(*args, **kwargs):
                original_size_check(*args, **kwargs)
                output_dir.mkdir()
                (output_dir / "keep-me.txt").write_bytes(b"unrelated user data")

            with (
                mock.patch.object(
                    generator,
                    "assert_asset_sizes",
                    side_effect=create_unowned_destination,
                ),
                self.assertRaises(ValueError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertIn("changed during generation", str(raised.exception))
            self.assertEqual(
                (output_dir / "keep-me.txt").read_bytes(),
                b"unrelated user data",
            )
            self.assertEqual(
                {child.name for child in root.iterdir()},
                {export_path.name, output_dir.name},
            )

    def test_destination_swap_after_revalidation_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            externally_moved_catalog = root / "catalog-moved-by-external-writer"
            create_export_fixture(export_path)
            output_dir.mkdir()
            mark_owned_catalog(output_dir)
            (output_dir / "existing.parquet").write_bytes(b"existing catalog")
            original_mkdtemp = generator.tempfile.mkdtemp

            def swap_destination_before_backup(*args, **kwargs):
                temporary_path = original_mkdtemp(*args, **kwargs)
                prefix = kwargs.get("prefix", "")
                if prefix.startswith(f".{output_dir.name}.backup-"):
                    generator.os.replace(output_dir, externally_moved_catalog)
                    output_dir.mkdir()
                    (output_dir / "keep-me.txt").write_bytes(
                        b"unrelated replacement"
                    )
                return temporary_path

            with (
                mock.patch.object(
                    generator.tempfile,
                    "mkdtemp",
                    side_effect=swap_destination_before_backup,
                ),
                self.assertRaises(ValueError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertIn("changed during publication", str(raised.exception))
            self.assertEqual(
                (output_dir / "keep-me.txt").read_bytes(),
                b"unrelated replacement",
            )
            self.assertTrue((externally_moved_catalog / "manifest.json").is_file())
            self.assertEqual(
                {child.name for child in root.iterdir()},
                {
                    export_path.name,
                    output_dir.name,
                    externally_moved_catalog.name,
                },
            )

    def test_publication_failure_restores_original_catalog_and_cleans_work_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            output_dir.mkdir()
            mark_owned_catalog(output_dir)
            (output_dir / "existing.parquet").write_bytes(b"existing catalog")
            catalog_before = snapshot_directory(output_dir)
            original_replace = generator.os.replace

            def fail_staging_publication(source, destination):
                if (
                    Path(source).name.startswith(f".{output_dir.name}.staging-")
                    and Path(destination) == output_dir
                ):
                    raise OSError("simulated publication failure")
                return original_replace(source, destination)

            with (
                mock.patch.object(
                    generator.os,
                    "replace",
                    side_effect=fail_staging_publication,
                ),
                self.assertRaisesRegex(OSError, "simulated publication failure"),
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertEqual(snapshot_directory(output_dir), catalog_before)
            self.assertEqual(
                {child.name for child in root.iterdir()},
                {export_path.name, output_dir.name},
            )

    def test_recursive_cleanup_makes_read_only_files_writable_before_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "catalog-backup"
            nested = root / "species"
            nested.mkdir(parents=True)
            asset = nested / "species-0000.parquet"
            asset.write_bytes(b"catalog")
            asset.chmod(0o444)
            nested.chmod(0o555)
            root.chmod(0o555)
            original_rmtree = generator.shutil.rmtree

            def require_writable_files(path):
                self.assertNotEqual(
                    stat.S_IMODE(asset.stat().st_mode) & stat.S_IWUSR,
                    0,
                )
                original_rmtree(path)

            with mock.patch.object(
                generator.shutil,
                "rmtree",
                side_effect=require_writable_files,
            ):
                generator.remove_path_if_present(root)

            self.assertFalse(root.exists())

    def test_unversioned_export_fails_before_existing_output_is_cleared(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            connection = sqlite3.connect(export_path)
            try:
                connection.execute("DROP TABLE _metadata")
                connection.commit()
            finally:
                connection.close()
            output_dir.mkdir()
            sentinel = output_dir / "keep-me.txt"
            sentinel.write_text("existing output", encoding="utf-8")

            with self.assertRaises(contract.DatabaseContractError):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "existing output")

    def test_output_aliasing_export_is_rejected_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / "nested"
            nested.mkdir()
            export_path = root / "canopi-export-test.db"
            create_export_fixture(export_path)
            export_before = export_path.read_bytes()
            equivalent_output = nested / ".." / export_path.name

            with (
                mock.patch.object(generator, "publish_output_dir") as publish,
                self.assertRaises(ValueError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=equivalent_output,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertIn("must not contain the export database", str(raised.exception))
            publish.assert_not_called()
            self.assertEqual(export_path.read_bytes(), export_before)

    def test_output_containing_export_is_rejected_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output_dir = root / "catalog"
            output_dir.mkdir()
            export_path = output_dir / "canopi-export-test.db"
            create_export_fixture(export_path)
            export_before = export_path.read_bytes()

            with (
                mock.patch.object(generator, "publish_output_dir") as publish,
                self.assertRaises(ValueError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertIn("must not contain the export database", str(raised.exception))
            publish.assert_not_called()
            self.assertEqual(export_path.read_bytes(), export_before)

    def test_unowned_output_directory_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "important-user-directory"
            create_export_fixture(export_path)
            output_dir.mkdir()
            sentinel = output_dir / "keep-me.txt"
            sentinel.write_bytes(b"unrelated user data")
            output_before = snapshot_directory(output_dir)

            with (
                mock.patch.object(generator, "publish_output_dir") as publish,
                self.assertRaises(ValueError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertIn("not a generator-owned catalog", str(raised.exception))
            publish.assert_not_called()
            self.assertEqual(snapshot_directory(output_dir), output_before)

    def test_older_catalog_layout_is_refused_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            (output_dir / "species").mkdir(parents=True)
            (output_dir / "species" / "species-0000.parquet").write_bytes(
                b"older species asset"
            )
            (output_dir / "manifest.json").write_text(
                json.dumps({"version": 1, "asset_format": "parquet"}),
                encoding="utf-8",
            )
            output_before = snapshot_directory(output_dir)

            with (
                mock.patch.object(generator, "publish_output_dir") as publish,
                self.assertRaises(ValueError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            self.assertIn(str(output_dir), str(raised.exception))
            self.assertIn("not a generator-owned catalog", str(raised.exception))
            publish.assert_not_called()
            self.assertEqual(snapshot_directory(output_dir), output_before)

    def test_generation_rejects_missing_caller_owned_storage_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export_path = root / "canopi-export-test.db"
            output_dir = root / "catalog"
            create_export_fixture(export_path)
            projection = contract.project(contract.ProjectionTarget.WEB_CATALOG)
            missing_species_columns = {
                "growth_form_type",
                "growth_form_shape",
                "growth_habit",
                "climate_zones",
            }
            reduced_projection = replace(
                projection,
                species_columns=tuple(
                    column
                    for column in projection.species_columns
                    if column.name not in missing_species_columns
                ),
                supporting_tables=tuple(
                    replace(
                        table,
                        columns=tuple(
                            column
                            for column in table.columns
                            if column.name != "source"
                        ),
                    )
                    if table.name == "species_images"
                    else table
                    for table in projection.supporting_tables
                    if table.name != "species_climate_zones"
                ),
            )

            with (
                mock.patch.object(
                    generator.storage_contract,
                    "project",
                    return_value=reduced_projection,
                ),
                self.assertRaises(contract.WebProjectionError) as raised,
            ):
                generator.generate_web_catalog(
                    export_path=export_path,
                    output_dir=output_dir,
                    species_shard_count=1,
                    image_shard_count=1,
                )

            message = str(raised.exception)
            self.assertIn("species.growth_form_type", message)
            self.assertIn("species.climate_zones", message)
            self.assertIn("species_images.source", message)
            self.assertIn("species_climate_zones", message)


def create_export_fixture(path: Path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE _metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    projection = contract.project(contract.ProjectionTarget.WEB_CATALOG)
    conn.execute(
        "INSERT INTO _metadata (key, value) VALUES ('schema_version', ?)",
        (str(projection.minimum_export_schema_version),),
    )
    conn.execute("""
        CREATE TABLE species (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            common_name TEXT,
            habit TEXT,
            growth_form_type TEXT,
            growth_form_shape TEXT,
            growth_habit TEXT,
            is_annual INTEGER,
            is_biennial INTEGER,
            is_perennial INTEGER,
            climate_zones TEXT,
            height_max_m REAL,
            hardiness_zone_min INTEGER,
            hardiness_zone_max INTEGER,
            stratum TEXT,
            edibility_rating INTEGER,
            native_distribution TEXT,
            image_urls TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE species_common_names (
            id TEXT PRIMARY KEY,
            species_id TEXT NOT NULL,
            language TEXT NOT NULL,
            common_name TEXT NOT NULL,
            is_primary INTEGER NOT NULL DEFAULT 0,
            display_order INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE species_climate_zones (
            id TEXT PRIMARY KEY,
            species_id TEXT NOT NULL,
            climate_zone TEXT NOT NULL,
            confidence REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE species_images (
            id TEXT PRIMARY KEY,
            species_id TEXT NOT NULL,
            url TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0
        )
    """)
    conn.executemany(
        """
        INSERT INTO species (
            id, slug, canonical_name, common_name, habit, growth_form_type,
            growth_form_shape, growth_habit, is_annual, is_biennial, is_perennial,
            climate_zones, height_max_m, hardiness_zone_min, hardiness_zone_max,
            stratum, edibility_rating, native_distribution, image_urls
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                "species-apple",
                "malus-domestica",
                "Malus domestica",
                "Apple",
                "Tree",
                "Tree",
                None,
                None,
                0,
                0,
                1,
                '["Ignored zone"]',
                8.0,
                5,
                9,
                "Canopy",
                5,
                "Europe",
                None,
            ),
            (
                "species-balm",
                "melissa-officinalis",
                "Straße officinalis",
                "Café balm",
                "Herbaceous",
                None,
                "Forb",
                None,
                0,
                0,
                1,
                '["Temperate"]',
                0.7,
                4,
                9,
                "Herb",
                4,
                "Europe",
                '["https://example.test/balm.jpg", "https://example.test/balm-2.jpg"]',
            ),
        ],
    )
    conn.executemany(
        """
        INSERT INTO species_common_names (
            id, species_id, language, common_name, is_primary, display_order
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            ("cn-apple-en", "species-apple", "en", "Apple", 1, 0),
            ("cn-apple-fr", "species-apple", "fr", "Pommier", 1, 0),
            ("cn-balm-en", "species-balm", "en", "Lemon balm", 1, 0),
        ],
    )
    conn.executemany(
        """
        INSERT INTO species_climate_zones (
            id, species_id, climate_zone, confidence
        ) VALUES (?, ?, ?, ?)
        """,
        [
            ("cz-apple-1", "species-apple", "Temperate", 0.95),
            ("cz-apple-2", "species-apple", "Boreal", 0.8),
        ],
    )
    conn.executemany(
        """
        INSERT INTO species_images (id, species_id, url, sort_order)
        VALUES (?, ?, ?, ?)
        """,
        [
            ("img-apple-secondary", "species-apple", "https://example.test/apple-secondary.jpg", 1),
            ("img-apple-primary", "species-apple", "https://example.test/apple-primary.jpg", 0),
        ],
    )
    conn.commit()
    conn.close()


def read_manifest_rows(output_dir: Path, assets, fields=None):
    rows = []
    for asset in assets:
        path = output_dir / asset["path"]
        if path.suffix == ".parquet":
            if fields is None:
                raise AssertionError("Parquet test reads require schema fields.")
            rows.extend(read_simple_parquet_rows(path, fields))
        else:
            rows.extend(read_jsonl(path))
    return rows


def schema_field_names(manifest, key):
    return [field["name"] for field in manifest["schema"][key]]


def replace_artifact_table(plan, table, **changes):
    return replace(
        plan,
        tables=tuple(
            replace(candidate, **changes)
            if candidate.table is table
            else candidate
            for candidate in plan.tables
        ),
    )


def read_jsonl(path: Path):
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def snapshot_directory(path: Path):
    return [
        (
            child.relative_to(path).as_posix(),
            None if child.is_dir() else child.read_bytes(),
        )
        for child in sorted(path.rglob("*"))
    ]


def mark_owned_catalog(path: Path):
    (path / "manifest.json").write_text(
        json.dumps({"generated_by": "canopi-web-catalog-v1"}),
        encoding="utf-8",
    )


def read_simple_parquet_rows(path: Path, fields):
    data = path.read_bytes()
    if data[:4] != b"PAR1" or data[-4:] != b"PAR1":
        raise AssertionError(f"{path} is not framed as Parquet")
    rows = None
    offset = 4
    columns = []
    for field in fields:
        header = parse_page_header(data, offset)
        offset = header["end"]
        values = []
        for _ in range(header["num_values"]):
            size = int.from_bytes(data[offset:offset + 4], "little")
            offset += 4
            values.append(data[offset:offset + size].decode("utf-8"))
            offset += size
        columns.append((field, values))
        rows = header["num_values"] if rows is None else rows
    result = [dict() for _ in range(rows or 0)]
    for field, values in columns:
        for index, value in enumerate(values):
            if field in ("climate_zones", "life_cycles"):
                result[index][field] = json.loads(value or "[]")
            elif field == "is_primary":
                result[index][field] = value == "true"
            elif field == "display_order":
                result[index][field] = int(value or "0")
            else:
                result[index][field] = value or None
    return result


def parse_page_header(data: bytes, offset: int):
    header_end, fields = parse_compact_struct(data, offset)
    compressed_size = fields[3]
    data_page = fields[5]
    return {
        "end": header_end,
        "compressed_size": compressed_size,
        "num_values": data_page[1],
    }


def parse_compact_struct(data: bytes, offset: int):
    fields = {}
    field_id = 0
    while True:
        header = data[offset]
        offset += 1
        field_type = header & 0x0F
        if field_type == 0:
            return offset, fields
        delta = header >> 4
        if delta == 0:
            field_id, offset = read_compact_int(data, offset)
        else:
            field_id += delta
        if field_type in (5, 6):
            value, offset = read_compact_int(data, offset)
        elif field_type == 8:
            size, offset = read_varint(data, offset)
            value = data[offset:offset + size].decode("utf-8")
            offset += size
        elif field_type == 12:
            offset, value = parse_compact_struct(data, offset)
        else:
            raise AssertionError(f"Unsupported compact field type {field_type}")
        fields[field_id] = value


def read_compact_int(data: bytes, offset: int):
    raw, offset = read_varint(data, offset)
    return ((raw >> 1) ^ -(raw & 1)), offset


def read_varint(data: bytes, offset: int):
    shift = 0
    value = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            return value, offset
        shift += 7


if __name__ == "__main__":
    unittest.main()
