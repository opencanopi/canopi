#!/usr/bin/env python3
"""Generate reduced Web Edition Species Catalog assets.

The primary Species rows are emitted as small uncompressed Parquet shards that
DuckDB-WASM can query with read_parquet(). Keeping generation in the Python
standard library avoids a native DuckDB or PyArrow dependency in the repository
while still producing DuckDB-queryable static assets for the browser adapter.
"""

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import species_catalog_contract as storage_contract
from scripts import web_catalog_artifact_contract as artifact_contract
from scripts.species_search_normalization import (
    common_name_tokens,
    normalize_search_name,
)

DEFAULT_EXPORTS_DIR = Path.home() / "projects/canopi-data/data/exports"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "desktop/web/catalog-input"

ARTIFACT_PLAN = artifact_contract.compile_web_catalog_artifact()
CLOUDFLARE_PAGES_MAX_ASSET_BYTES = ARTIFACT_PLAN.maximum_asset_bytes


@dataclass(frozen=True)
class OutputDestinationAdmission:
    identity: tuple[int, int, int] | None
    publication_mode: int | None

WEB_STORAGE_USES = (
    storage_contract.WebStorageUse(
        "species",
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
    ),
    storage_contract.WebStorageUse(
        "species_common_names",
        (
            "species_id",
            "language",
            "common_name",
            "is_primary",
            "display_order",
        ),
    ),
    storage_contract.WebStorageUse(
        "species_images",
        ("id", "species_id", "url", "sort_order", "source"),
    ),
    storage_contract.WebStorageUse(
        "species_climate_zones",
        ("species_id", "climate_zone"),
    ),
)

PROJECTED_ROW_CAPABILITIES = {
    artifact_contract.ArtifactTable.SPECIES: {
        "id": "required_text",
        "slug": "required_text",
        "canonical_name": "required_text",
        "common_name": "nullable_text",
        "normalized_canonical_name": "required_text",
        "normalized_common_name": "nullable_text",
        "climate_zones": "json_text_array",
        "habit": "nullable_text",
        "growth_form": "nullable_text",
        "life_cycles": "json_text_array",
    },
    artifact_contract.ArtifactTable.NAMES: {
        "species_id": "required_text",
        "language": "required_text",
        "common_name": "required_text",
        "normalized_name": "required_text",
        "is_primary": "boolean_text",
        "display_order": "integer_text",
    },
    artifact_contract.ArtifactTable.IMAGES: {
        "species_id": "required_text",
        "url": "required_text",
        "source": "nullable_text",
        "source_page_url": "nullable_text",
        "credit": "nullable_text",
        "license": "nullable_text",
    },
}


class AssetSizeError(RuntimeError):
    pass


class ArtifactProjectionError(RuntimeError):
    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Web Catalog row projectors have {len(violations)} "
            f"contract violation(s):\n{details}"
        )


def validate_artifact_projection(
    plan: artifact_contract.WebCatalogArtifactPlan,
) -> None:
    violations: list[str] = []
    for table_plan in plan.tables:
        contracted = set(table_plan.field_names)
        capabilities = PROJECTED_ROW_CAPABILITIES[table_plan.table]
        producible = set(capabilities)
        missing = sorted(contracted - producible)
        if missing:
            violations.append(
                f"tables.{table_plan.table.value}.fields: {missing!r} "
                "cannot derive from the generator row projector"
            )
        extra = sorted(producible - contracted)
        if extra:
            violations.append(
                f"tables.{table_plan.table.value}.fields: generator derives "
                f"uncontracted fields {extra!r}"
            )
        for field in table_plan.fields:
            supported_logical_type = capabilities.get(field.name)
            if (
                supported_logical_type is not None
                and supported_logical_type != field.logical_type
            ):
                violations.append(
                    f"tables.{table_plan.table.value}.fields.{field.name}: "
                    f"generator supports {supported_logical_type!r}, but the "
                    f"contract requires {field.logical_type!r}"
                )
    if violations:
        raise ArtifactProjectionError(violations)


def generate_web_catalog(
    export_path: Path | None = None,
    output_dir: Path | None = None,
    *,
    species_shard_count: int = 24,
    image_shard_count: int = 12,
    max_asset_bytes: int = CLOUDFLARE_PAGES_MAX_ASSET_BYTES,
) -> dict[str, Any]:
    export_path = export_path or find_latest_export(DEFAULT_EXPORTS_DIR)
    output_dir = output_dir or DEFAULT_OUTPUT_DIR
    if species_shard_count < 1 or image_shard_count < 1:
        raise ValueError("Shard counts must be positive.")
    if output_would_replace_export(export_path, output_dir):
        raise ValueError(
            "The Web Catalog output directory must not contain the export database."
        )

    artifact_plan = ARTIFACT_PLAN
    validate_artifact_projection(artifact_plan)
    artifact_plan.table_plan(
        artifact_contract.ArtifactTable.SPECIES
    ).indexed_asset_paths(species_shard_count)
    artifact_plan.table_plan(
        artifact_contract.ArtifactTable.IMAGES
    ).indexed_asset_paths(image_shard_count)

    projection = storage_contract.project(
        storage_contract.ProjectionTarget.WEB_CATALOG
    )
    assert isinstance(projection, storage_contract.WebCatalogProjection)
    storage_contract.validate_web_catalog_behavior(
        projection,
        emitted_species_fields=artifact_plan.field_names(
            artifact_contract.ArtifactTable.SPECIES
        ),
        filters=tuple(
            storage_contract.WebFilterUse(
                filter_definition.key,
                filter_definition.columns,
            )
            for filter_definition in artifact_plan.supported_filters
        ),
        storage_uses=WEB_STORAGE_USES,
    )
    verification = storage_contract.verify_database(
        storage_contract.DatabaseProfile.WEB_EXPORT,
        export_path,
    )
    destination_admission = validate_output_destination(output_dir)

    staging_dir, publication_mode = create_staging_output_dir(
        output_dir,
        destination_admission,
    )
    try:
        conn = sqlite3.connect(export_path)
        conn.row_factory = sqlite3.Row
        try:
            climate_zones = load_climate_zones(conn)

            species_assets = write_species_assets(
                conn,
                staging_dir,
                climate_zones,
                source_columns=projection.species_columns,
                table_plan=artifact_plan.table_plan(
                    artifact_contract.ArtifactTable.SPECIES
                ),
                shard_count=species_shard_count,
            )
            name_assets = write_name_assets(
                conn,
                staging_dir,
                locales=artifact_plan.locales,
                table_plan=artifact_plan.table_plan(
                    artifact_contract.ArtifactTable.NAMES
                ),
            )
            image_assets = write_image_assets(
                conn,
                staging_dir,
                table_plan=artifact_plan.table_plan(
                    artifact_contract.ArtifactTable.IMAGES
                ),
                shard_count=image_shard_count,
            )

            manifest = artifact_plan.build_manifest(
                source=artifact_contract.ArtifactSource(
                    export_file=export_path.name,
                    export_schema_version=verification.observed_schema_version,
                    storage_contract_fingerprint=projection.fingerprint,
                ),
                assets=artifact_contract.ArtifactAssets(
                    species=tuple(species_assets),
                    names=tuple(name_assets.items()),
                    images=tuple(image_assets),
                ),
                max_asset_bytes=max_asset_bytes,
            )
            write_json(staging_dir / "manifest.json", manifest)
            assert_asset_sizes(staging_dir, max_asset_bytes=max_asset_bytes)
        finally:
            conn.close()

        staging_dir.chmod(publication_mode)
        publish_output_dir(staging_dir, output_dir, destination_admission)
        return manifest
    finally:
        remove_path_if_present(staging_dir)


def find_latest_export(exports_dir: Path) -> Path:
    db_files = sorted(exports_dir.glob("canopi-export-*.db"), reverse=True)
    if not db_files:
        raise FileNotFoundError(f"No canopi-export-*.db files found in {exports_dir}")
    return db_files[0]


def output_would_replace_export(export_path: Path, output_dir: Path) -> bool:
    """Return whether publishing the output could replace or delete the export."""
    resolved_export = export_path.resolve()
    resolved_output = output_dir.resolve()
    if resolved_export == resolved_output or resolved_output in resolved_export.parents:
        return True
    try:
        return export_path.samefile(output_dir)
    except OSError:
        return False


def validate_output_destination(output_dir: Path) -> OutputDestinationAdmission:
    """Refuse to replace a nonempty directory the generator does not own."""
    try:
        metadata = output_dir.stat(follow_symlinks=False)
    except FileNotFoundError:
        return OutputDestinationAdmission(identity=None, publication_mode=None)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(
            f"Web Catalog output '{output_dir}' is not a generator-owned catalog."
        )
    children = {child.name for child in output_dir.iterdir()}
    if not children:
        return output_destination_admission(metadata)
    manifest_path = output_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = None
    if (
        isinstance(manifest, dict)
        and manifest.get("generated_by") == ARTIFACT_PLAN.generated_by
    ):
        return output_destination_admission(metadata)
    raise ValueError(
        f"Web Catalog output '{output_dir}' is not a generator-owned catalog."
    )


def output_destination_admission(
    metadata: os.stat_result,
) -> OutputDestinationAdmission:
    return OutputDestinationAdmission(
        identity=(metadata.st_dev, metadata.st_ino, metadata.st_ctime_ns),
        publication_mode=stat.S_IMODE(metadata.st_mode),
    )


def create_staging_output_dir(
    output_dir: Path,
    destination_admission: OutputDestinationAdmission,
) -> tuple[Path, int]:
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    publication_mode = destination_admission.publication_mode
    staging_dir = Path(
        tempfile.mkdtemp(
            prefix=f".{output_dir.name}.staging-",
            dir=output_dir.parent,
        )
    )
    if publication_mode is None:
        current_umask = os.umask(0)
        os.umask(current_umask)
        publication_mode = 0o777 & ~current_umask
    staging_dir.chmod(publication_mode | 0o700)
    return staging_dir, publication_mode


def publish_output_dir(
    staging_dir: Path,
    output_dir: Path,
    destination_admission: OutputDestinationAdmission,
) -> None:
    try:
        current_admission = validate_output_destination(output_dir)
    except ValueError as error:
        raise ValueError(
            f"Web Catalog output '{output_dir}' changed during generation: {error}"
        ) from error
    if current_admission != destination_admission:
        raise ValueError(
            f"Web Catalog output '{output_dir}' changed during generation; "
            "refusing to replace it."
        )

    backup_candidate = Path(
        tempfile.mkdtemp(
            prefix=f".{output_dir.name}.backup-",
            dir=output_dir.parent,
        )
    )
    backup_candidate.rmdir()
    try:
        os.replace(output_dir, backup_candidate)
    except FileNotFoundError:
        backup_dir = None
    else:
        backup_dir = backup_candidate

    captured_admission: OutputDestinationAdmission | None = None
    if backup_dir is not None:
        try:
            captured_admission = validate_output_destination(backup_dir)
        except ValueError:
            captured_admission = None

    if not captured_destination_matches(
        destination_admission,
        captured_admission,
        captured_path_exists=backup_dir is not None,
    ):
        if backup_dir is not None:
            restore_captured_destination(backup_dir, output_dir)
        raise ValueError(
            f"Web Catalog output '{output_dir}' changed during publication; "
            "the replacement was preserved and publication was refused."
        )

    try:
        os.replace(staging_dir, output_dir)
    except BaseException:
        if backup_dir is not None:
            restore_captured_destination(backup_dir, output_dir)
        raise
    else:
        if backup_dir is not None:
            remove_path_if_present(backup_dir)


def captured_destination_matches(
    admitted: OutputDestinationAdmission,
    captured: OutputDestinationAdmission | None,
    *,
    captured_path_exists: bool,
) -> bool:
    if not captured_path_exists:
        return admitted.identity is None
    if admitted.identity is None or captured is None or captured.identity is None:
        return False
    return (
        admitted.identity[:2] == captured.identity[:2]
        and admitted.publication_mode == captured.publication_mode
    )


def restore_captured_destination(backup_dir: Path, output_dir: Path) -> None:
    if output_dir.exists() or output_dir.is_symlink():
        raise RuntimeError(
            f"Refusing to overwrite '{output_dir}' while restoring a captured "
            f"catalog; the prior catalog remains at '{backup_dir}'."
        )
    os.replace(backup_dir, output_dir)


def remove_path_if_present(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        path.chmod(stat.S_IMODE(path.stat().st_mode) | 0o700)
        for current_root, directories, files in os.walk(path):
            current = Path(current_root)
            current.chmod(stat.S_IMODE(current.stat().st_mode) | 0o700)
            for directory in directories:
                child = current / directory
                if not child.is_symlink():
                    child.chmod(stat.S_IMODE(child.stat().st_mode) | 0o700)
            for filename in files:
                child = current / filename
                if not child.is_symlink():
                    child.chmod(stat.S_IMODE(child.stat().st_mode) | 0o600)
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def write_species_assets(
    conn: sqlite3.Connection,
    output_dir: Path,
    climate_zones: dict[str, list[str]],
    *,
    source_columns: tuple[storage_contract.StorageColumn, ...],
    table_plan: artifact_contract.ArtifactTablePlan,
    shard_count: int,
) -> list[artifact_contract.ArtifactAsset]:
    relative_paths = table_plan.indexed_asset_paths(shard_count)
    output_paths = tuple(output_dir / path for path in relative_paths)
    for parent in {path.parent for path in output_paths}:
        parent.mkdir(parents=True, exist_ok=True)
    shards: list[list[dict[str, Any]]] = [[] for _ in range(shard_count)]
    species_columns = table_columns(conn, "species")
    select_columns = [column.name for column in source_columns]
    select_sql = ", ".join(select_expr(species_columns, column) for column in select_columns)
    rows = conn.execute(
        f"""
        SELECT {select_sql}
        FROM species
        ORDER BY canonical_name, id
        """
    )
    for row in rows:
        species_id = row["id"]
        payload = table_plan.admit_row(
            {
                "id": species_id,
                "slug": row["slug"],
                "canonical_name": row["canonical_name"],
                "common_name": row["common_name"],
                "normalized_canonical_name": normalize_search_name(
                    row["canonical_name"] or ""
                ),
                "normalized_common_name": (
                    normalize_search_name(row["common_name"])
                    if row["common_name"]
                    else None
                ),
                "climate_zones": climate_zones.get(species_id)
                or parse_list_field(row["climate_zones"]),
                "habit": row["habit"],
                "growth_form": first_present(
                    row["growth_form_type"],
                    row["growth_form_shape"],
                    row["growth_habit"],
                ),
                "life_cycles": life_cycles_from_flags(
                    row["is_annual"],
                    row["is_biennial"],
                    row["is_perennial"],
                ),
            },
            path=f"species[{species_id!r}]",
        )
        shards[shard_index(species_id, shard_count)].append(payload)

    for path, shard_rows in zip(output_paths, shards, strict=True):
        write_simple_parquet(
            path,
            list(table_plan.field_names),
            shard_rows,
        )
    return [asset_entry(output_dir, path) for path in output_paths]


def write_name_assets(
    conn: sqlite3.Connection,
    output_dir: Path,
    *,
    locales: tuple[str, ...],
    table_plan: artifact_contract.ArtifactTablePlan,
) -> dict[str, artifact_contract.ArtifactAsset]:
    assets: dict[str, artifact_contract.ArtifactAsset] = {}
    has_common_names = table_exists(conn, "species_common_names")
    for locale in locales:
        path = output_dir / table_plan.locale_asset_path(locale)
        path.parent.mkdir(parents=True, exist_ok=True)
        locale_rows = []
        if has_common_names:
            rows = conn.execute(
                """
                SELECT scn.species_id,
                       scn.language,
                       scn.common_name,
                       COALESCE(scn.is_primary, 0) AS is_primary,
                       scn.display_order
                FROM species_common_names scn
                JOIN species s ON s.id = scn.species_id
                WHERE scn.language = ?
                  AND scn.common_name != s.canonical_name
                ORDER BY scn.species_id, scn.display_order,
                         scn.is_primary DESC,
                         LENGTH(scn.common_name), scn.common_name
                """,
                (locale,),
            )
            for row in rows:
                normalized_name = normalize_search_name(row["common_name"] or "")
                if not normalized_name:
                    continue
                payload = table_plan.admit_row(
                    {
                        "species_id": row["species_id"],
                        "language": row["language"],
                        "common_name": row["common_name"],
                        "normalized_name": normalized_name,
                        "is_primary": bool(row["is_primary"]),
                        "display_order": int(row["display_order"] or 0),
                    },
                    path=f"names.{locale}[{len(locale_rows)}]",
                )
                locale_rows.append(payload)
        write_simple_parquet(path, list(table_plan.field_names), locale_rows)
        assets[locale] = asset_entry(output_dir, path)
    return assets


def write_image_assets(
    conn: sqlite3.Connection,
    output_dir: Path,
    *,
    table_plan: artifact_contract.ArtifactTablePlan,
    shard_count: int,
) -> list[artifact_contract.ArtifactAsset]:
    relative_paths = table_plan.indexed_asset_paths(shard_count)
    output_paths = tuple(output_dir / path for path in relative_paths)
    for parent in {path.parent for path in output_paths}:
        parent.mkdir(parents=True, exist_ok=True)
    shards: list[list[dict[str, Any]]] = [[] for _ in range(shard_count)]
    species_with_images: set[str] = set()
    if table_exists(conn, "species_images"):
        image_columns = table_columns(conn, "species_images")
        source_expr = "source" if "source" in image_columns else "NULL AS source"
        rows = conn.execute(
            f"""
            SELECT species_id, url, {source_expr}
            FROM species_images
            WHERE url IS NOT NULL AND url != ''
            ORDER BY species_id, sort_order, id
            """
        )
        for row in rows:
            species_id = row["species_id"]
            if species_id in species_with_images:
                continue
            species_with_images.add(species_id)
            append_image_row(
                shards,
                species_id,
                row["url"],
                row["source"],
                shard_count,
                table_plan,
            )

    species_columns = table_columns(conn, "species")
    if "image_urls" in species_columns:
        rows = conn.execute(
            """
            SELECT id, image_urls
            FROM species
            WHERE image_urls IS NOT NULL AND image_urls != ''
            ORDER BY id
            """
        )
        for row in rows:
            species_id = row["id"]
            if species_id in species_with_images:
                continue
            urls = parse_list_field(row["image_urls"])
            if not urls:
                continue
            species_with_images.add(species_id)
            append_image_row(
                shards,
                species_id,
                urls[0],
                None,
                shard_count,
                table_plan,
            )

    for path, shard_rows in zip(output_paths, shards, strict=True):
        write_simple_parquet(
            path,
            list(table_plan.field_names),
            shard_rows,
        )
    return [asset_entry(output_dir, path) for path in output_paths]


def append_image_row(
    shards: list[list[dict[str, Any]]],
    species_id: str,
    url: str,
    source: str | None,
    shard_count: int,
    table_plan: artifact_contract.ArtifactTablePlan,
) -> None:
    payload = table_plan.admit_row(
        {
            "species_id": species_id,
            "url": url,
            "source": source,
            "source_page_url": None,
            "credit": None,
            "license": None,
        },
        path=f"images[{species_id!r}]",
    )
    shards[shard_index(species_id, shard_count)].append(payload)


def load_climate_zones(conn: sqlite3.Connection) -> dict[str, list[str]]:
    if not table_exists(conn, "species_climate_zones"):
        return {}
    zones: dict[str, set[str]] = {}
    rows = conn.execute(
        """
        SELECT species_id, climate_zone
        FROM species_climate_zones
        WHERE climate_zone IS NOT NULL AND climate_zone != ''
        ORDER BY species_id, climate_zone
        """
    )
    for row in rows:
        zones.setdefault(row["species_id"], set()).add(row["climate_zone"])
    return {species_id: sorted(values) for species_id, values in zones.items()}


def assert_asset_sizes(output_dir: Path, *, max_asset_bytes: int) -> None:
    oversized = [
        (path, path.stat().st_size)
        for path in sorted(output_dir.rglob("*"))
        if path.is_file() and path.stat().st_size > max_asset_bytes
    ]
    if oversized:
        details = ", ".join(
            f"{path.relative_to(output_dir).as_posix()}={size} bytes"
            for path, size in oversized
        )
        raise AssetSizeError(
            f"Generated Web Edition catalog assets exceed the {max_asset_bytes} byte limit: {details}"
        )


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_simple_parquet(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    """Write a minimal uncompressed Parquet file with required UTF-8 columns.

    The reduced Web catalog schema is deliberately narrow. Lists are encoded as
    JSON strings so the browser reader can parse them back to arrays while
    DuckDB can still project columns from Parquet row groups.
    """
    body = bytearray(b"PAR1")
    column_chunks: list[dict[str, Any]] = []

    for column in columns:
        offset = len(body)
        values = b"".join(
            plain_byte_array(parquet_cell(row[column])) for row in rows
        )
        page_header = parquet_data_page_header(num_values=len(rows), data_size=len(values))
        page = page_header + values
        body.extend(page)
        column_chunks.append({
            "path": [column],
            "num_values": len(rows),
            "data_page_offset": offset,
            "total_size": len(page),
        })

    footer = parquet_file_metadata(
        columns=columns,
        column_chunks=column_chunks,
        num_rows=len(rows),
    )
    body.extend(footer)
    body.extend(len(footer).to_bytes(4, "little", signed=False))
    body.extend(b"PAR1")
    path.write_bytes(bytes(body))


def parquet_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return json.dumps(list(value), ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def plain_byte_array(value: str) -> bytes:
    data = value.encode("utf-8")
    return len(data).to_bytes(4, "little", signed=False) + data


def parquet_data_page_header(*, num_values: int, data_size: int) -> bytes:
    data_page_header = thrift_struct([
        thrift_i32_field(1, num_values),
        thrift_i32_field(2, 0),  # PLAIN
        thrift_i32_field(3, 3),  # RLE
        thrift_i32_field(4, 3),  # RLE
    ])
    return thrift_struct([
        thrift_i32_field(1, 0),  # DATA_PAGE
        thrift_i32_field(2, data_size),
        thrift_i32_field(3, data_size),
        thrift_struct_field(5, data_page_header),
    ])


def parquet_file_metadata(
    *,
    columns: list[str],
    column_chunks: list[dict[str, Any]],
    num_rows: int,
) -> bytes:
    schema = [
        parquet_schema_element(name="schema", num_children=len(columns)),
        *[
            parquet_schema_element(
                name=column,
                type_id=6,  # BYTE_ARRAY
                repetition_type=0,  # REQUIRED
                converted_type=0,  # UTF8
            )
            for column in columns
        ],
    ]
    row_groups = []
    if column_chunks:
        row_groups.append(thrift_struct([
            thrift_list_field(1, 12, [parquet_column_chunk(chunk) for chunk in column_chunks]),
            thrift_i64_field(2, sum(int(chunk["total_size"]) for chunk in column_chunks)),
            thrift_i64_field(3, num_rows),
        ]))

    return thrift_struct([
        thrift_i32_field(1, 1),
        thrift_list_field(2, 12, schema),
        thrift_i64_field(3, num_rows),
        thrift_list_field(4, 12, row_groups),
        thrift_binary_field(6, "canopi generate-web-catalog"),
    ])


def parquet_schema_element(
    *,
    name: str,
    type_id: int | None = None,
    repetition_type: int | None = None,
    num_children: int | None = None,
    converted_type: int | None = None,
) -> bytes:
    fields = []
    if type_id is not None:
        fields.append(thrift_i32_field(1, type_id))
    if repetition_type is not None:
        fields.append(thrift_i32_field(3, repetition_type))
    fields.append(thrift_binary_field(4, name))
    if num_children is not None:
        fields.append(thrift_i32_field(5, num_children))
    if converted_type is not None:
        fields.append(thrift_i32_field(6, converted_type))
    return thrift_struct(fields)


def parquet_column_chunk(chunk: dict[str, Any]) -> bytes:
    return thrift_struct([
        thrift_i64_field(2, int(chunk["data_page_offset"])),
        thrift_struct_field(3, parquet_column_metadata(chunk)),
    ])


def parquet_column_metadata(chunk: dict[str, Any]) -> bytes:
    total_size = int(chunk["total_size"])
    return thrift_struct([
        thrift_i32_field(1, 6),  # BYTE_ARRAY
        thrift_list_field(2, 5, [0]),  # PLAIN
        thrift_list_field(3, 8, chunk["path"]),
        thrift_i32_field(4, 0),  # UNCOMPRESSED
        thrift_i64_field(5, int(chunk["num_values"])),
        thrift_i64_field(6, total_size),
        thrift_i64_field(7, total_size),
        thrift_i64_field(9, int(chunk["data_page_offset"])),
    ])


THRIFT_STOP = 0
THRIFT_I32 = 5
THRIFT_I64 = 6
THRIFT_BINARY = 8
THRIFT_LIST = 9
THRIFT_STRUCT = 12


def thrift_struct(fields: list[tuple[int, int, bytes]]) -> bytes:
    output = bytearray()
    previous_field_id = 0
    for field_id, field_type, payload in fields:
        delta = field_id - previous_field_id
        if 0 < delta <= 15:
            output.append((delta << 4) | field_type)
        else:
            output.append(field_type)
            output.extend(varint(zigzag(field_id)))
        output.extend(payload)
        previous_field_id = field_id
    output.append(THRIFT_STOP)
    return bytes(output)


def thrift_i32_field(field_id: int, value: int) -> tuple[int, int, bytes]:
    return (field_id, THRIFT_I32, varint(zigzag(value)))


def thrift_i64_field(field_id: int, value: int) -> tuple[int, int, bytes]:
    return (field_id, THRIFT_I64, varint(zigzag(value)))


def thrift_binary_field(field_id: int, value: str) -> tuple[int, int, bytes]:
    data = value.encode("utf-8")
    return (field_id, THRIFT_BINARY, varint(len(data)) + data)


def thrift_struct_field(field_id: int, value: bytes) -> tuple[int, int, bytes]:
    return (field_id, THRIFT_STRUCT, value)


def thrift_list_field(field_id: int, element_type: int, values: list[Any]) -> tuple[int, int, bytes]:
    payload = bytearray()
    if len(values) < 15:
        payload.append((len(values) << 4) | element_type)
    else:
        payload.append((15 << 4) | element_type)
        payload.extend(varint(len(values)))

    for value in values:
        if element_type == THRIFT_STRUCT:
            payload.extend(value)
        elif element_type == THRIFT_BINARY:
            data = str(value).encode("utf-8")
            payload.extend(varint(len(data)))
            payload.extend(data)
        elif element_type == THRIFT_I32:
            payload.extend(varint(zigzag(int(value))))
        else:
            raise ValueError(f"Unsupported compact thrift list element type {element_type}.")
    return (field_id, THRIFT_LIST, bytes(payload))


def zigzag(value: int) -> int:
    return (value << 1) ^ (value >> 63)


def varint(value: int) -> bytes:
    output = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            output.append(byte | 0x80)
        else:
            output.append(byte)
            return bytes(output)


def asset_entry(output_dir: Path, path: Path) -> artifact_contract.ArtifactAsset:
    return artifact_contract.ArtifactAsset(
        path=path.relative_to(output_dir).as_posix(),
        bytes=path.stat().st_size,
        sha256=sha256_file(path),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shard_index(key: str, shard_count: int) -> int:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % shard_count


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def select_expr(columns: set[str], column: str) -> str:
    if column in columns:
        return column
    return f"NULL AS {column}"


def first_present(*values: Any) -> str | None:
    for value in values:
        if value is not None and str(value).strip():
            return str(value)
    return None


def life_cycles_from_flags(is_annual: Any, is_biennial: Any, is_perennial: Any) -> list[str]:
    cycles = []
    if truthy_flag(is_annual):
        cycles.append("Annual")
    if truthy_flag(is_biennial):
        cycles.append("Biennial")
    if truthy_flag(is_perennial):
        cycles.append("Perennial")
    return cycles


def truthy_flag(value: Any) -> bool:
    return value in (1, True, "1", "true", "True")


def parse_list_field(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return sorted_unique_strings(value)
    text = str(value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return sorted_unique_strings(parsed)
    except json.JSONDecodeError:
        pass
    return sorted_unique_strings(part.strip() for part in text.split(","))


def sorted_unique_strings(values: Any) -> list[str]:
    return sorted({str(value).strip() for value in values if str(value).strip()})


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate reduced Web Edition catalog assets")
    parser.add_argument(
        "--export-path",
        type=Path,
        help=f"Path to canopi-data export DB (default: latest in {DEFAULT_EXPORTS_DIR})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument("--species-shard-count", type=int, default=24)
    parser.add_argument("--image-shard-count", type=int, default=12)
    parser.add_argument(
        "--max-asset-bytes",
        type=int,
        default=CLOUDFLARE_PAGES_MAX_ASSET_BYTES,
        help="Maximum bytes allowed for any generated asset.",
    )
    args = parser.parse_args()

    manifest = generate_web_catalog(
        export_path=args.export_path,
        output_dir=args.output_dir,
        species_shard_count=args.species_shard_count,
        image_shard_count=args.image_shard_count,
        max_asset_bytes=args.max_asset_bytes,
    )
    asset_count = sum(
        len(manifest["assets"][key]) if isinstance(manifest["assets"][key], list) else len(manifest["assets"][key])
        for key in ["species", "names", "images"]
    )
    print(
        f"Generated Web Edition catalog manifest with {asset_count} assets at "
        f"{args.output_dir / 'manifest.json'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
