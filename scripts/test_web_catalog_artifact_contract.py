import json
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import web_catalog_artifact_contract as contract


REPO_ROOT = Path(__file__).resolve().parent.parent
NORMALIZATION_PATH = REPO_ROOT / "canopi-types/species-search-normalization.json"
UNICODE_FACTS_PATH = REPO_ROOT / "canopi-types/species-search-unicode-15.json"


class WebCatalogArtifactContractTests(unittest.TestCase):
    def test_compiles_the_species_row_projection_for_generation(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)

        self.assertEqual(
            plan.field_names(contract.ArtifactTable.SPECIES),
            (
                "id",
                "slug",
                "canonical_name",
                "common_name",
                "normalized_canonical_name",
                "normalized_common_name",
                "climate_zones",
                "habit",
                "growth_form",
                "life_cycles",
            ),
        )

    def test_compiles_the_required_common_name_locales(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)

        self.assertEqual(
            plan.locales,
            ("en", "fr", "es", "pt", "it", "zh", "de", "ja", "ko", "nl", "ru"),
        )

    def test_compiles_supported_filter_predicates(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)

        self.assertEqual(
            tuple(
                (item.key, item.options_key, item.predicate_kind, item.columns)
                for item in plan.supported_filters
            ),
            (
                ("climate_zones", "climate_zones", "json_array_any", ("climate_zones",)),
                ("habit", "habits", "text_any", ("habit", "growth_form")),
                ("life_cycle", "life_cycles", "json_array_any", ("life_cycles",)),
            ),
        )

    def test_builds_a_complete_manifest_from_dynamic_artifact_metadata(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)

        manifest = plan.build_manifest(
            source=valid_source(),
            assets=valid_assets(plan),
            max_asset_bytes=25 * 1024 * 1024,
        )

        self.assertEqual(manifest["generated_by"], "canopi-web-catalog-v1")
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["artifact_contract_fingerprint"], plan.fingerprint)
        self.assertEqual(
            manifest["species_search_normalization"],
            {
                "version": plan.species_search_normalization_version,
                "fingerprint": plan.species_search_normalization_fingerprint,
            },
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
            manifest["duckdb"]["tables"],
            {
                "web_species": ["species/species-0000.parquet"],
                "web_species_names": [
                    f"names/names-{locale}.parquet" for locale in plan.locales
                ],
                "web_species_images": ["images/images-0000.parquet"],
            },
        )
        self.assertEqual(
            [item["key"] for item in manifest["supported_filters"]],
            ["climate_zones", "habit", "life_cycle"],
        )

    def test_artifact_contract_pins_the_normalization_authority(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        normalization = json.loads(NORMALIZATION_PATH.read_text(encoding="utf-8"))

        self.assertEqual(
            plan.species_search_normalization_version,
            normalization["normalization_version"],
        )
        self.assertRegex(
            plan.species_search_normalization_fingerprint,
            r"^[0-9a-f]{64}$",
        )

    def test_artifact_contract_rejects_a_normalization_version_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (
                    REPO_ROOT / "canopi-types/web-species-catalog-artifact.json"
                ).read_text(encoding="utf-8")
            )
            raw["species_search_normalization_version"] = 999
            write_contract(root, raw)

            with self.assertRaisesRegex(
                contract.ContractInvariantError,
                r"species_search_normalization_version.*expected 1.*found 999",
            ):
                contract.compile_web_catalog_artifact(root=root)

    def test_artifact_fingerprint_includes_the_normalization_authority(self):
        baseline = contract.compile_web_catalog_artifact(root=REPO_ROOT).fingerprint
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (
                    REPO_ROOT / "canopi-types/web-species-catalog-artifact.json"
                ).read_text(encoding="utf-8")
            )
            write_contract(root, raw)
            normalization_path = (
                root / "canopi-types/species-search-normalization.json"
            )
            normalization = json.loads(
                normalization_path.read_text(encoding="utf-8")
            )
            normalization["corpus"][0]["name"] = "changed-semantic-corpus"
            normalization_path.write_text(
                json.dumps(normalization),
                encoding="utf-8",
            )

            changed = contract.compile_web_catalog_artifact(root=root).fingerprint

        self.assertNotEqual(changed, baseline)

    def test_table_plan_admits_exact_logically_typed_rows(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        species = next(
            table
            for table in plan.tables
            if table.table is contract.ArtifactTable.SPECIES
        )
        row = {
            "id": "species-1",
            "slug": "species-1",
            "canonical_name": "Species one",
            "common_name": None,
            "normalized_canonical_name": "species one",
            "normalized_common_name": None,
            "climate_zones": ["Temperate"],
            "habit": "Tree",
            "growth_form": None,
            "life_cycles": ["Perennial"],
        }

        self.assertIs(species.admit_row(row, path="species[0]"), row)
        invalid = {**row, "climate_zones": "Temperate", "unexpected": True}
        invalid.pop("id")
        with self.assertRaises(contract.ArtifactRowError) as raised:
            species.admit_row(invalid, path="species[1]")

        self.assertEqual(
            raised.exception.violations,
            (
                "species[1].id: required field is missing",
                "species[1].unexpected: unknown field",
                "species[1].climate_zones: expected an array of strings",
            ),
        )
        with self.assertRaisesRegex(
            contract.ArtifactRowError,
            r"species\[2\]\.id.*expected nonempty text",
        ):
            species.admit_row({**row, "id": "   "}, path="species[2]")

    def test_rejects_duplicate_locales_with_a_stable_contract_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (REPO_ROOT / "canopi-types/web-species-catalog-artifact.json").read_text(
                    encoding="utf-8"
                )
            )
            raw["locales"][1] = "en"
            write_contract(root, raw)

            with self.assertRaisesRegex(Exception, r"locales\[1\].*duplicate locale 'en'"):
                contract.compile_web_catalog_artifact(root=root)

    def test_rejects_filter_columns_missing_from_the_species_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (REPO_ROOT / "canopi-types/web-species-catalog-artifact.json").read_text(
                    encoding="utf-8"
                )
            )
            raw["supported_filters"][0]["predicate"]["columns"] = ["missing_field"]
            write_contract(root, raw)

            with self.assertRaisesRegex(
                Exception,
                r"supported_filters\[0\].predicate.columns\[0\].*missing_field.*Species schema",
            ):
                contract.compile_web_catalog_artifact(root=root)

    def test_manifest_builder_rejects_unsafe_asset_paths(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)
        unsafe_species = replace(
            assets.species[0],
            path="species/%2e%2e/outside.parquet",
        )

        with self.assertRaisesRegex(
            Exception,
            r"assets.species\[0\].path.*safe portable relative path",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=replace(assets, species=(unsafe_species,)),
                max_asset_bytes=25 * 1024 * 1024,
            )

    def test_manifest_builder_requires_one_name_asset_per_locale(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)

        with self.assertRaisesRegex(
            Exception,
            r"assets.names.*missing locale 'fr'",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=replace(
                    assets,
                    names=tuple(
                        item for item in assets.names if item[0] != "fr"
                    ),
                ),
                max_asset_bytes=25 * 1024 * 1024,
            )

    def test_manifest_builder_rejects_invalid_asset_integrity_metadata(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)

        with self.assertRaisesRegex(
            Exception,
            r"assets.images\[0\].sha256.*64 lowercase hexadecimal",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=replace(
                    assets,
                    images=(replace(assets.images[0], sha256="not-a-digest"),),
                ),
                max_asset_bytes=25 * 1024 * 1024,
            )

    def test_manifest_builder_rejects_duplicate_paths_across_asset_groups(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)
        names = tuple(
            (
                locale,
                replace(asset, path=assets.species[0].path)
                if locale == "en"
                else asset,
            )
            for locale, asset in assets.names
        )

        with self.assertRaisesRegex(
            Exception,
            r"assets.names\[0\].path.*duplicate asset path",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=replace(assets, names=names),
                max_asset_bytes=25 * 1024 * 1024,
            )

    def test_manifest_builder_enforces_each_asset_group_layout(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)

        with self.assertRaisesRegex(
            Exception,
            r"assets.species\[0\].path.*contracted species asset layout",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=replace(
                    assets,
                    species=(
                        replace(assets.species[0], path="species/not-a-shard.parquet"),
                    ),
                ),
                max_asset_bytes=25 * 1024 * 1024,
            )

    def test_manifest_builder_rejects_limits_above_the_deployment_contract(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)

        with self.assertRaisesRegex(
            Exception,
            r"cloudflare_pages.max_asset_bytes.*26214400",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=valid_assets(plan),
                max_asset_bytes=plan.maximum_asset_bytes + 1,
            )

    def test_manifest_builder_rejects_assets_above_the_declared_limit(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)

        with self.assertRaisesRegex(
            contract.ManifestBuildError,
            r"assets\.species\[0\]\.bytes.*declared asset limit 10",
        ):
            plan.build_manifest(
                source=valid_source(),
                assets=assets,
                max_asset_bytes=10,
            )

    def test_manifest_builder_requires_well_formed_source_provenance(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)

        with self.assertRaisesRegex(
            Exception,
            r"source.storage_contract_fingerprint.*64 lowercase hexadecimal",
        ):
            plan.build_manifest(
                source=replace(valid_source(), storage_contract_fingerprint="stale"),
                assets=valid_assets(plan),
                max_asset_bytes=plan.maximum_asset_bytes,
            )

    def test_manifest_builder_aggregates_wrong_dynamic_value_types(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)

        with self.assertRaises(contract.ManifestBuildError) as raised:
            plan.build_manifest(
                source=contract.ArtifactSource(
                    export_file=7,  # type: ignore[arg-type]
                    export_schema_version=True,
                    storage_contract_fingerprint=None,  # type: ignore[arg-type]
                ),
                assets=replace(
                    assets,
                    species=(
                        contract.ArtifactAsset(
                            path=None,  # type: ignore[arg-type]
                            bytes=True,
                            sha256=None,  # type: ignore[arg-type]
                        ),
                    ),
                ),
                max_asset_bytes=True,
            )

        self.assertRegex(
            "\n".join(raised.exception.violations),
            r"(?s)source\.export_file.*source\.export_schema_version.*"
            r"source\.storage_contract_fingerprint.*cloudflare_pages\.max_asset_bytes.*"
            r"assets\.species\[0\]\.path.*assets\.species\[0\]\.bytes.*"
            r"assets\.species\[0\]\.sha256",
        )

    def test_manifest_builder_requires_nonempty_species_and_image_groups(self):
        plan = contract.compile_web_catalog_artifact(root=REPO_ROOT)
        assets = valid_assets(plan)

        with self.assertRaisesRegex(Exception, r"assets.images.*at least one asset"):
            plan.build_manifest(
                source=valid_source(),
                assets=replace(assets, images=()),
                max_asset_bytes=plan.maximum_asset_bytes,
            )

    def test_aggregates_authored_contract_invariant_violations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (REPO_ROOT / "canopi-types/web-species-catalog-artifact.json").read_text(
                    encoding="utf-8"
                )
            )
            raw["contract_format_version"] = 2
            raw["tables"]["species"]["fields"].append(
                {"name": "id", "logical_type": "binary"}
            )
            raw["supported_filters"][0]["predicate"]["kind"] = "unknown"
            write_contract(root, raw)

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.compile_web_catalog_artifact(root=root)

            self.assertEqual(
                raised.exception.violations,
                (
                    "contract_format_version: unsupported version 2",
                    "tables.species.fields[10].name: duplicate field 'id'",
                    "tables.species.fields[10].logical_type: unsupported logical type 'binary'",
                    "supported_filters[0].predicate.kind: unsupported predicate kind 'unknown'",
                ),
            )

    def test_rejects_unsafe_or_ambiguous_authored_layout_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (REPO_ROOT / "canopi-types/web-species-catalog-artifact.json").read_text(
                    encoding="utf-8"
                )
            )
            raw["tables"]["species"]["directory"] = "../species"
            raw["tables"]["names"]["duckdb_table"] = "web_species"
            raw["supported_filters"][1]["options_key"] = "climate_zones"
            raw["excluded_detail_fields"][0] = "bad/path"
            write_contract(root, raw)

            with self.assertRaises(contract.ContractInvariantError) as raised:
                contract.compile_web_catalog_artifact(root=root)

            details = "\n".join(raised.exception.violations)
            self.assertRegex(details, r"tables\.species\.directory.*safe path segment")
            self.assertRegex(details, r"tables\.names\.duckdb_table.*duplicate")
            self.assertRegex(details, r"supported_filters\[1\]\.options_key.*duplicate")
            self.assertRegex(details, r"excluded_detail_fields\[0\].*safe field group")

    def test_generated_check_delegates_to_the_rust_publication_authority(self):
        completed = mock.Mock(returncode=0)

        with mock.patch(
            "scripts.web_catalog_artifact_contract.subprocess.run",
            return_value=completed,
        ) as run:
            status = contract.main(["check"])

        self.assertEqual(status, 0)
        run.assert_called_once_with(
            ["cargo", "run", "-p", "bindings-gen", "--", "--check"],
            cwd=REPO_ROOT,
            check=False,
        )

    def test_delegation_does_not_split_a_repo_path_that_contains_spaces(self):
        completed = mock.Mock(returncode=0)
        root = Path("C:/Canopi checkout with spaces")

        with mock.patch(
            "scripts.web_catalog_artifact_contract.subprocess.run",
            return_value=completed,
        ) as run:
            contract.run_bindings_generator(check=False, root=root)

        run.assert_called_once_with(
            ["cargo", "run", "-p", "bindings-gen"],
            cwd=root,
            check=False,
        )

    def test_generated_render_stages_both_files_without_mutating_repo_destinations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            output_directory = Path(tmp) / "staged"
            raw = json.loads(
                (REPO_ROOT / "canopi-types/web-species-catalog-artifact.json").read_text(
                    encoding="utf-8"
                )
            )
            write_contract(root, raw)
            generated = root / "desktop/web/src/generated"
            generated.mkdir(parents=True)
            repository_paths = (
                generated / "web-catalog-artifact.mjs",
                generated / "web-catalog-artifact.d.mts",
            )
            for path in repository_paths:
                path.write_text(f"sentinel:{path.name}", encoding="utf-8")

            original_write_text = Path.write_text
            requested_newlines: list[str | None] = []

            def write_text_with_observed_newline(
                path: Path,
                data: str,
                *,
                encoding: str | None = None,
                errors: str | None = None,
                newline: str | None = None,
            ) -> int:
                requested_newlines.append(newline)
                return original_write_text(
                    path,
                    data,
                    encoding=encoding,
                    errors=errors,
                    newline=newline,
                )

            with mock.patch.object(Path, "write_text", write_text_with_observed_newline):
                staged_paths = contract.render_generated(
                    output_directory=output_directory,
                    root=root,
                )

            self.assertEqual(
                tuple(path.name for path in staged_paths),
                ("web-catalog-artifact.mjs", "web-catalog-artifact.d.mts"),
            )
            self.assertIn(
                "admitWebCatalogManifest",
                staged_paths[0].read_text(encoding="utf-8"),
            )
            self.assertIn(
                "AdmittedWebCatalog",
                staged_paths[1].read_text(encoding="utf-8"),
            )
            self.assertEqual(requested_newlines, ["\n", "\n"])
            for path in staged_paths:
                self.assertNotIn(b"\r\n", path.read_bytes())
            self.assertEqual(
                tuple(path.read_text(encoding="utf-8") for path in repository_paths),
                tuple(f"sentinel:{path.name}" for path in repository_paths),
            )

    def test_generated_render_rejects_the_checked_in_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = json.loads(
                (REPO_ROOT / "canopi-types/web-species-catalog-artifact.json").read_text(
                    encoding="utf-8"
                )
            )
            write_contract(root, raw)
            generated = root / "desktop/web/src/generated"
            generated.mkdir(parents=True)
            module = generated / "web-catalog-artifact.mjs"
            declaration = generated / "web-catalog-artifact.d.mts"
            module.write_text("module sentinel", encoding="utf-8")
            declaration.write_text("declaration sentinel", encoding="utf-8")

            with self.assertRaisesRegex(
                contract.ArtifactContractError,
                "bindings-gen publication authority",
            ):
                contract.render_generated(output_directory=generated, root=root)

            self.assertEqual(module.read_text(encoding="utf-8"), "module sentinel")
            self.assertEqual(
                declaration.read_text(encoding="utf-8"), "declaration sentinel"
            )


def write_contract(root: Path, raw: object) -> None:
    path = root / "canopi-types/web-species-catalog-artifact.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(raw), encoding="utf-8")
    (root / "canopi-types/species-search-normalization.json").write_text(
        NORMALIZATION_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (root / "canopi-types/species-search-unicode-15.json").write_text(
        UNICODE_FACTS_PATH.read_text(encoding="utf-8"),
        encoding="utf-8",
    )


def valid_source() -> contract.ArtifactSource:
    return contract.ArtifactSource(
        export_file="canopi-export-v14.db",
        export_schema_version=14,
        storage_contract_fingerprint="a" * 64,
    )


def valid_assets(
    plan: contract.WebCatalogArtifactPlan,
) -> contract.ArtifactAssets:
    return contract.ArtifactAssets(
        species=(
            contract.ArtifactAsset(
                path="species/species-0000.parquet",
                bytes=20,
                sha256="c" * 64,
            ),
        ),
        names=tuple(
            (
                locale,
                contract.ArtifactAsset(
                    path=f"names/names-{locale}.parquet",
                    bytes=10,
                    sha256="b" * 64,
                ),
            )
            for locale in plan.locales
        ),
        images=(
            contract.ArtifactAsset(
                path="images/images-0000.parquet",
                bytes=30,
                sha256="d" * 64,
            ),
        ),
    )


if __name__ == "__main__":
    unittest.main()
