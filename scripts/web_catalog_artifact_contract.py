#!/usr/bin/env python3
"""Compile the authored Web Species Catalog artifact contract."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from enum import Enum
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import species_search_normalization


SUPPORTED_LOGICAL_TYPES = frozenset(
    {
        "required_text",
        "nullable_text",
        "json_text_array",
        "boolean_text",
        "integer_text",
    }
)
SUPPORTED_PREDICATE_KINDS = frozenset({"json_array_any", "text_any"})


class ArtifactContractError(RuntimeError):
    """An expected authored-contract or manifest failure."""


class ContractSourceError(ArtifactContractError):
    """The authored contract cannot be read or decoded."""


class ContractInvariantError(ArtifactContractError):
    """The authored contract violates one or more semantic invariants."""

    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Web Species Catalog artifact contract has {len(violations)} "
            f"invariant violation(s):\n{details}"
        )


class ManifestBuildError(ArtifactContractError):
    """Dynamic artifact metadata cannot form an admitted manifest."""

    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Web Species Catalog manifest has {len(violations)} "
            f"violation(s):\n{details}"
        )


class ArtifactLayoutError(ArtifactContractError):
    """A requested artifact path cannot fit the compiled layout."""


class ArtifactRowError(ArtifactContractError):
    """A generated row does not match its compiled artifact schema."""

    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Web Species Catalog row has {len(violations)} "
            f"violation(s):\n{details}"
        )


class ArtifactTable(str, Enum):
    SPECIES = "species"
    NAMES = "names"
    IMAGES = "images"


@dataclass(frozen=True)
class ArtifactField:
    name: str
    logical_type: str


@dataclass(frozen=True)
class ArtifactTablePlan:
    table: ArtifactTable
    asset_container: str
    directory: str
    filename_prefix: str
    filename_suffix: str
    filename_index_width: int | None
    duckdb_table: str
    fields: tuple[ArtifactField, ...]

    @property
    def field_names(self) -> tuple[str, ...]:
        return tuple(field.name for field in self.fields)

    def indexed_asset_paths(self, shard_count: int) -> tuple[str, ...]:
        if self.asset_container != "list" or self.filename_index_width is None:
            raise ArtifactLayoutError(
                f"{self.table.value} does not use an indexed asset layout"
            )
        if (
            isinstance(shard_count, bool)
            or not isinstance(shard_count, int)
            or shard_count < 1
        ):
            raise ArtifactLayoutError(
                f"{self.table.value} shard count must be a positive integer"
            )
        capacity = 10**self.filename_index_width
        if shard_count > capacity:
            width_label = (
                "one-digit"
                if self.filename_index_width == 1
                else f"{self.filename_index_width}-digit"
            )
            raise ArtifactLayoutError(
                f"{self.table.value} requested {shard_count} shards, but its "
                f"{width_label} index supports at most {capacity}"
            )
        return tuple(
            f"{self.directory}/{self.filename_prefix}"
            f"{index:0{self.filename_index_width}d}{self.filename_suffix}"
            for index in range(shard_count)
        )

    def locale_asset_path(self, locale: str) -> str:
        if self.asset_container != "locale_map":
            raise ArtifactLayoutError(
                f"{self.table.value} does not use a locale asset layout"
            )
        return (
            f"{self.directory}/{self.filename_prefix}"
            f"{locale}{self.filename_suffix}"
        )

    def admit_row(
        self,
        row: dict[str, Any],
        *,
        path: str,
    ) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise ArtifactRowError([f"{path}: expected a row object"])
        violations: list[str] = []
        expected_names = set(self.field_names)
        for field in self.fields:
            if field.name not in row:
                violations.append(
                    f"{path}.{field.name}: required field is missing"
                )
        for name in sorted(row.keys() - expected_names):
            violations.append(f"{path}.{name}: unknown field")
        for field in self.fields:
            if field.name not in row:
                continue
            violation = _logical_value_violation(
                field.logical_type,
                row[field.name],
            )
            if violation is not None:
                violations.append(f"{path}.{field.name}: {violation}")
        if violations:
            raise ArtifactRowError(violations)
        return row


@dataclass(frozen=True)
class SupportedFilter:
    key: str
    options_key: str
    predicate_kind: str
    columns: tuple[str, ...]


@dataclass(frozen=True)
class ArtifactSource:
    export_file: str
    export_schema_version: int
    storage_contract_fingerprint: str


@dataclass(frozen=True)
class ArtifactAsset:
    path: str
    bytes: int
    sha256: str

    def as_wire_value(self) -> dict[str, object]:
        return {
            "path": self.path,
            "bytes": self.bytes,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class ArtifactAssets:
    species: tuple[ArtifactAsset, ...]
    names: tuple[tuple[str, ArtifactAsset], ...]
    images: tuple[ArtifactAsset, ...]


def _logical_value_violation(logical_type: str, value: Any) -> str | None:
    if logical_type == "required_text":
        return (
            None
            if isinstance(value, str) and value.strip() != ""
            else "expected nonempty text"
        )
    if logical_type == "nullable_text":
        return None if value is None or isinstance(value, str) else "expected text or null"
    if logical_type == "json_text_array":
        return (
            None
            if isinstance(value, list)
            and all(isinstance(item, str) for item in value)
            else "expected an array of strings"
        )
    if logical_type == "boolean_text":
        return None if isinstance(value, bool) else "expected a boolean"
    if logical_type == "integer_text":
        return (
            None
            if isinstance(value, int) and not isinstance(value, bool)
            else "expected an integer"
        )
    return f"unsupported logical type {logical_type!r}"


@dataclass(frozen=True)
class WebCatalogArtifactPlan:
    fingerprint: str
    species_search_normalization_version: int
    species_search_normalization_fingerprint: str
    generated_by: str
    version: int
    asset_format: str
    duckdb_reader: str
    maximum_asset_bytes: int
    locales: tuple[str, ...]
    tables: tuple[ArtifactTablePlan, ...]
    supported_filters: tuple[SupportedFilter, ...]
    excluded_detail_fields: tuple[str, ...]

    def field_names(self, table: ArtifactTable) -> tuple[str, ...]:
        return self.table_plan(table).field_names

    def table_plan(self, table: ArtifactTable) -> ArtifactTablePlan:
        return next(candidate for candidate in self.tables if candidate.table is table)

    def _table(self, table: ArtifactTable) -> ArtifactTablePlan:
        return self.table_plan(table)

    def build_manifest(
        self,
        *,
        source: ArtifactSource,
        assets: ArtifactAssets,
        max_asset_bytes: int,
    ) -> dict[str, object]:
        violations = self._validate_manifest_inputs(
            source=source,
            assets=assets,
            max_asset_bytes=max_asset_bytes,
        )
        if violations:
            raise ManifestBuildError(violations)
        names = dict(assets.names)
        grouped_assets = {
            "species": [asset.as_wire_value() for asset in assets.species],
            "names": {
                locale: names[locale].as_wire_value()
                for locale in self.locales
            },
            "images": [asset.as_wire_value() for asset in assets.images],
        }
        return {
            "generated_by": self.generated_by,
            "version": self.version,
            "artifact_contract_fingerprint": self.fingerprint,
            "species_search_normalization": {
                "version": self.species_search_normalization_version,
                "fingerprint": self.species_search_normalization_fingerprint,
            },
            "asset_format": self.asset_format,
            "asset_formats": {
                table.value: self.asset_format
                for table in ArtifactTable
            },
            "source": {
                "export_file": source.export_file,
                "export_schema_version": source.export_schema_version,
                "storage_contract_fingerprint": source.storage_contract_fingerprint,
            },
            "cloudflare_pages": {
                "max_asset_bytes": max_asset_bytes,
            },
            "locales": list(self.locales),
            "supported_filters": [
                {
                    "key": item.key,
                    "options_key": item.options_key,
                    "predicate": {
                        "kind": item.predicate_kind,
                        "columns": list(item.columns),
                    },
                }
                for item in self.supported_filters
            ],
            "schema": {
                f"{table.table.value}_fields": [
                    {
                        "name": field.name,
                        "logical_type": field.logical_type,
                    }
                    for field in table.fields
                ]
                for table in self.tables
            } | {
                "excluded_detail_fields": list(self.excluded_detail_fields),
            },
            "duckdb": {
                "reader": self.duckdb_reader,
                "tables": {
                    self._table(ArtifactTable.SPECIES).duckdb_table: [
                        asset.path for asset in assets.species
                    ],
                    self._table(ArtifactTable.NAMES).duckdb_table: [
                        names[locale].path for locale in self.locales
                    ],
                    self._table(ArtifactTable.IMAGES).duckdb_table: [
                        asset.path for asset in assets.images
                    ],
                },
            },
            "assets": grouped_assets,
        }

    def _validate_manifest_inputs(
        self,
        *,
        source: ArtifactSource,
        assets: ArtifactAssets,
        max_asset_bytes: int,
    ) -> list[str]:
        violations: list[str] = []
        if (
            not isinstance(source.export_file, str)
            or not source.export_file
            or "/" in source.export_file
            or "\\" in source.export_file
            or re.fullmatch(r"[A-Za-z0-9._-]+", source.export_file) is None
            or source.export_file in (".", "..")
        ):
            violations.append(
                "source.export_file: expected a safe export basename"
            )
        if (
            isinstance(source.export_schema_version, bool)
            or not isinstance(source.export_schema_version, int)
            or source.export_schema_version < 1
            or source.export_schema_version > 2**53 - 1
        ):
            violations.append(
                "source.export_schema_version: expected a positive safe integer"
            )
        if (
            not isinstance(source.storage_contract_fingerprint, str)
            or re.fullmatch(
                r"[0-9a-f]{64}",
                source.storage_contract_fingerprint,
            )
            is None
        ):
            violations.append(
                "source.storage_contract_fingerprint: expected 64 lowercase "
                "hexadecimal characters"
            )
        max_asset_bytes_is_valid = (
            not isinstance(max_asset_bytes, bool)
            and isinstance(max_asset_bytes, int)
            and max_asset_bytes >= 1
            and max_asset_bytes <= self.maximum_asset_bytes
        )
        if not max_asset_bytes_is_valid:
            violations.append(
                "cloudflare_pages.max_asset_bytes: expected a positive integer "
                f"no greater than {self.maximum_asset_bytes}"
            )
        if not assets.species:
            violations.append("assets.species: expected at least one asset")
        if not assets.images:
            violations.append("assets.images: expected at least one asset")
        seen_name_locales: set[str] = set()
        for index, (locale, _asset) in enumerate(assets.names):
            if not isinstance(locale, str):
                violations.append(
                    f"assets.names[{index}]: expected a locale string"
                )
            elif locale in seen_name_locales:
                violations.append(
                    f"assets.names[{index}]: duplicate locale {locale!r}"
                )
            elif locale not in self.locales:
                violations.append(
                    f"assets.names[{index}]: unsupported locale {locale!r}"
                )
            if isinstance(locale, str):
                seen_name_locales.add(locale)
            names_plan = self._table(ArtifactTable.NAMES)
            expected_path = names_plan.locale_asset_path(str(locale))
            if _asset.path != expected_path:
                violations.append(
                    f"assets.names[{index}].path: expected the contracted "
                    f"names asset layout {expected_path!r}"
                )
        for locale in self.locales:
            if locale not in seen_name_locales:
                violations.append(f"assets.names: missing locale {locale!r}")
        grouped = (
            (ArtifactTable.SPECIES, assets.species),
            (ArtifactTable.NAMES, tuple(asset for _, asset in assets.names)),
            (ArtifactTable.IMAGES, assets.images),
        )
        seen_paths: set[str] = set()
        for table, entries in grouped:
            for index, asset in enumerate(entries):
                field_path = f"assets.{table.value}[{index}]"
                if not _is_safe_portable_relative_path(asset.path):
                    violations.append(
                        f"{field_path}.path: {asset.path!r} "
                        "is not a safe portable relative path"
                    )
                if (
                    table is not ArtifactTable.NAMES
                    and not _matches_indexed_asset_layout(
                        self._table(table),
                        asset.path,
                    )
                ):
                    violations.append(
                        f"{field_path}.path: expected the contracted "
                        f"{table.value} asset layout"
                    )
                if isinstance(asset.path, str):
                    if asset.path in seen_paths:
                        violations.append(
                            f"{field_path}.path: duplicate asset path {asset.path!r}"
                        )
                    seen_paths.add(asset.path)
                asset_bytes_is_valid = (
                    not isinstance(asset.bytes, bool)
                    and isinstance(asset.bytes, int)
                    and asset.bytes >= 0
                    and asset.bytes <= 2**53 - 1
                )
                if not asset_bytes_is_valid:
                    violations.append(
                        f"{field_path}.bytes: expected a nonnegative safe integer"
                    )
                elif max_asset_bytes_is_valid and asset.bytes > max_asset_bytes:
                    violations.append(
                        f"{field_path}.bytes: exceeds the declared asset limit "
                        f"{max_asset_bytes}"
                    )
                if (
                    not isinstance(asset.sha256, str)
                    or re.fullmatch(r"[0-9a-f]{64}", asset.sha256) is None
                ):
                    violations.append(
                        f"{field_path}.sha256: expected 64 lowercase hexadecimal characters"
                    )
        return violations


def compile_web_catalog_artifact(
    *,
    root: Path = REPO_ROOT,
) -> WebCatalogArtifactPlan:
    contract_path = root / "canopi-types/web-species-catalog-artifact.json"
    try:
        raw: Any = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractSourceError(
            f"failed to read Web Species Catalog artifact contract {contract_path}: {error}"
        ) from error
    if not isinstance(raw, dict):
        raise ContractInvariantError(["root: expected an object"])
    try:
        normalization_contract = species_search_normalization.load_contract(root=root)
    except RuntimeError as error:
        raise ContractInvariantError(
            [f"species_search_normalization: {error}"]
        ) from error
    violations = _validate_contract_source(
        raw,
        normalization_version=normalization_contract.version,
    )
    if violations:
        raise ContractInvariantError(violations)
    semantic_source = {
        **raw,
        "species_search_normalization_fingerprint": (
            normalization_contract.fingerprint
        ),
    }
    canonical = json.dumps(
        semantic_source,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    tables = tuple(
        ArtifactTablePlan(
            table=table,
            asset_container=raw["tables"][table.value]["asset_container"],
            directory=raw["tables"][table.value]["directory"],
            filename_prefix=raw["tables"][table.value]["filename_prefix"],
            filename_suffix=raw["tables"][table.value]["filename_suffix"],
            filename_index_width=raw["tables"][table.value].get(
                "filename_index_width"
            ),
            duckdb_table=raw["tables"][table.value]["duckdb_table"],
            fields=tuple(
                ArtifactField(
                    name=field["name"],
                    logical_type=field["logical_type"],
                )
                for field in raw["tables"][table.value]["fields"]
            ),
        )
        for table in ArtifactTable
    )
    supported_filters = tuple(
        SupportedFilter(
            key=item["key"],
            options_key=item["options_key"],
            predicate_kind=item["predicate"]["kind"],
            columns=tuple(item["predicate"]["columns"]),
        )
        for item in raw["supported_filters"]
    )
    return WebCatalogArtifactPlan(
        fingerprint=hashlib.sha256(canonical).hexdigest(),
        species_search_normalization_version=normalization_contract.version,
        species_search_normalization_fingerprint=(
            normalization_contract.fingerprint
        ),
        generated_by=raw["artifact"]["generated_by"],
        version=raw["artifact"]["version"],
        asset_format=raw["artifact"]["asset_format"],
        duckdb_reader=raw["artifact"]["duckdb_reader"],
        maximum_asset_bytes=raw["deployment"]["maximum_asset_bytes"],
        locales=tuple(raw["locales"]),
        tables=tables,
        supported_filters=supported_filters,
        excluded_detail_fields=tuple(raw["excluded_detail_fields"]),
    )


def _is_safe_portable_relative_path(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or not value
        or not re.fullmatch(r"[A-Za-z0-9._/-]+", value)
    ):
        return False
    if value.startswith("/") or "//" in value:
        return False
    return all(segment not in ("", ".", "..") for segment in value.split("/"))


def _matches_indexed_asset_layout(table: ArtifactTablePlan, value: Any) -> bool:
    if not isinstance(value, str) or table.filename_index_width is None:
        return False
    pattern = (
        re.escape(f"{table.directory}/{table.filename_prefix}")
        + rf"[0-9]{{{table.filename_index_width}}}"
        + re.escape(table.filename_suffix)
    )
    return re.fullmatch(pattern, value) is not None


def _validate_contract_source(
    raw: dict[str, Any],
    *,
    normalization_version: int,
) -> list[str]:
    violations: list[str] = []
    required_root_keys = {
        "contract_format_version",
        "species_search_normalization_version",
        "artifact",
        "deployment",
        "locales",
        "tables",
        "supported_filters",
        "excluded_detail_fields",
    }
    for key in sorted(required_root_keys - raw.keys()):
        violations.append(f"{key}: required property is missing")
    for key in sorted(raw.keys() - required_root_keys):
        violations.append(f"{key}: unknown property")

    declared_normalization_version = raw.get(
        "species_search_normalization_version"
    )
    _require_positive_safe_integer(
        declared_normalization_version,
        "species_search_normalization_version",
        violations,
    )
    if (
        isinstance(declared_normalization_version, int)
        and not isinstance(declared_normalization_version, bool)
        and declared_normalization_version != normalization_version
    ):
        violations.append(
            "species_search_normalization_version: expected "
            f"{normalization_version}, found {declared_normalization_version}"
        )

    contract_format_version = raw.get("contract_format_version")
    if (
        isinstance(contract_format_version, bool)
        or not isinstance(contract_format_version, int)
    ):
        violations.append("contract_format_version: expected an integer")
    elif contract_format_version != 1:
        violations.append(
            "contract_format_version: unsupported version "
            f"{contract_format_version}"
        )

    artifact = _object_at(raw.get("artifact"), "artifact", violations)
    if artifact is not None:
        _require_exact_keys(
            artifact,
            "artifact",
            {"generated_by", "version", "asset_format", "duckdb_reader"},
            violations,
        )
        _require_nonempty_string(
            artifact.get("generated_by"),
            "artifact.generated_by",
            violations,
        )
        _require_positive_safe_integer(
            artifact.get("version"),
            "artifact.version",
            violations,
        )
        if artifact.get("asset_format") != "parquet":
            violations.append(
                "artifact.asset_format: only 'parquet' is supported"
            )
        if artifact.get("duckdb_reader") != "read_parquet":
            violations.append(
                "artifact.duckdb_reader: only 'read_parquet' is supported"
            )

    deployment = _object_at(raw.get("deployment"), "deployment", violations)
    if deployment is not None:
        _require_exact_keys(
            deployment,
            "deployment",
            {"maximum_asset_bytes"},
            violations,
        )
        _require_positive_safe_integer(
            deployment.get("maximum_asset_bytes"),
            "deployment.maximum_asset_bytes",
            violations,
        )

    locales = _array_at(raw.get("locales"), "locales", violations)
    if locales is not None:
        if not locales:
            violations.append("locales: at least one locale is required")
        seen_locales: set[str] = set()
        for index, locale in enumerate(locales):
            path = f"locales[{index}]"
            if not isinstance(locale, str) or re.fullmatch(
                r"[a-z]{2}(?:-[A-Z]{2})?", locale
            ) is None:
                violations.append(f"{path}: expected a canonical locale code")
                continue
            if locale in seen_locales:
                violations.append(f"{path}: duplicate locale {locale!r}")
            seen_locales.add(locale)

    fields_by_table: dict[str, dict[str, str]] = {}
    seen_asset_directories: set[str] = set()
    seen_duckdb_tables: set[str] = set()
    tables = _object_at(raw.get("tables"), "tables", violations)
    if tables is not None:
        expected_tables = {table.value for table in ArtifactTable}
        _require_exact_keys(tables, "tables", expected_tables, violations)
        for table in ArtifactTable:
            table_path = f"tables.{table.value}"
            table_raw = _object_at(tables.get(table.value), table_path, violations)
            if table_raw is None:
                continue
            required_keys = {
                "asset_container",
                "directory",
                "filename_prefix",
                "filename_suffix",
                "duckdb_table",
                "fields",
            }
            allowed_keys = set(required_keys)
            if table is not ArtifactTable.NAMES:
                required_keys.add("filename_index_width")
                allowed_keys.add("filename_index_width")
            _require_exact_keys(
                table_raw,
                table_path,
                required_keys,
                violations,
                allowed_keys=allowed_keys,
            )
            expected_container = (
                "locale_map" if table is ArtifactTable.NAMES else "list"
            )
            if table_raw.get("asset_container") != expected_container:
                violations.append(
                    f"{table_path}.asset_container: expected "
                    f"{expected_container!r}"
                )
            directory = table_raw.get("directory")
            _require_safe_path_segment(
                directory,
                f"{table_path}.directory",
                violations,
            )
            if isinstance(directory, str):
                if directory in seen_asset_directories:
                    violations.append(
                        f"{table_path}.directory: duplicate asset directory {directory!r}"
                    )
                seen_asset_directories.add(directory)
            for key in ("filename_prefix", "filename_suffix"):
                _require_safe_filename_fragment(
                    table_raw.get(key),
                    f"{table_path}.{key}",
                    violations,
                )
            duckdb_table = table_raw.get("duckdb_table")
            if not isinstance(duckdb_table, str) or re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", duckdb_table
            ) is None:
                violations.append(
                    f"{table_path}.duckdb_table: expected a safe SQL identifier"
                )
            else:
                if duckdb_table in seen_duckdb_tables:
                    violations.append(
                        f"{table_path}.duckdb_table: duplicate DuckDB table "
                        f"{duckdb_table!r}"
                    )
                seen_duckdb_tables.add(duckdb_table)
            if table is not ArtifactTable.NAMES:
                _require_positive_safe_integer(
                    table_raw.get("filename_index_width"),
                    f"{table_path}.filename_index_width",
                    violations,
                )
                filename_index_width = table_raw.get("filename_index_width")
                if (
                    isinstance(filename_index_width, int)
                    and not isinstance(filename_index_width, bool)
                    and filename_index_width > 16
                ):
                    violations.append(
                        f"{table_path}.filename_index_width: expected no more than 16"
                    )
            fields = _array_at(
                table_raw.get("fields"),
                f"{table_path}.fields",
                violations,
            )
            if fields is None:
                continue
            if not fields:
                violations.append(f"{table_path}.fields: at least one field is required")
            table_fields: dict[str, str] = {}
            for index, field_value in enumerate(fields):
                field_path = f"{table_path}.fields[{index}]"
                field = _object_at(field_value, field_path, violations)
                if field is None:
                    continue
                _require_exact_keys(
                    field,
                    field_path,
                    {"name", "logical_type"},
                    violations,
                )
                name = field.get("name")
                if not isinstance(name, str) or re.fullmatch(
                    r"[A-Za-z_][A-Za-z0-9_]*", name
                ) is None:
                    violations.append(
                        f"{field_path}.name: expected a safe field identifier"
                    )
                elif name in table_fields:
                    violations.append(
                        f"{field_path}.name: duplicate field {name!r}"
                    )
                logical_type = field.get("logical_type")
                if logical_type not in SUPPORTED_LOGICAL_TYPES:
                    violations.append(
                        f"{field_path}.logical_type: unsupported logical type "
                        f"{logical_type!r}"
                    )
                if isinstance(name, str) and isinstance(logical_type, str):
                    table_fields.setdefault(name, logical_type)
            fields_by_table[table.value] = table_fields

    filters = _array_at(
        raw.get("supported_filters"),
        "supported_filters",
        violations,
    )
    if filters is not None:
        if not filters:
            violations.append("supported_filters: at least one Filter is required")
        seen_filter_keys: set[str] = set()
        seen_options_keys: set[str] = set()
        species_fields = fields_by_table.get("species", {})
        for filter_index, filter_value in enumerate(filters):
            filter_path = f"supported_filters[{filter_index}]"
            filter_definition = _object_at(
                filter_value,
                filter_path,
                violations,
            )
            if filter_definition is None:
                continue
            _require_exact_keys(
                filter_definition,
                filter_path,
                {"key", "options_key", "predicate"},
                violations,
            )
            key = filter_definition.get("key")
            if not isinstance(key, str) or re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", key
            ) is None:
                violations.append(f"{filter_path}.key: expected a safe Filter key")
            elif key in seen_filter_keys:
                violations.append(f"{filter_path}.key: duplicate Filter key {key!r}")
            if isinstance(key, str):
                seen_filter_keys.add(key)
            options_key = filter_definition.get("options_key")
            if not isinstance(options_key, str) or re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", options_key
            ) is None:
                violations.append(
                    f"{filter_path}.options_key: expected a safe options key"
                )
            elif options_key in seen_options_keys:
                violations.append(
                    f"{filter_path}.options_key: duplicate options key {options_key!r}"
                )
            if isinstance(options_key, str):
                seen_options_keys.add(options_key)
            predicate_path = f"{filter_path}.predicate"
            predicate = _object_at(
                filter_definition.get("predicate"),
                predicate_path,
                violations,
            )
            if predicate is None:
                continue
            _require_exact_keys(
                predicate,
                predicate_path,
                {"kind", "columns"},
                violations,
            )
            kind = predicate.get("kind")
            if kind not in SUPPORTED_PREDICATE_KINDS:
                violations.append(
                    f"{predicate_path}.kind: unsupported predicate kind {kind!r}"
                )
            columns = _array_at(
                predicate.get("columns"),
                f"{predicate_path}.columns",
                violations,
            )
            if columns is None:
                continue
            if not columns:
                violations.append(
                    f"{predicate_path}.columns: at least one column is required"
                )
            seen_columns: set[str] = set()
            for column_index, column in enumerate(columns):
                column_path = f"{predicate_path}.columns[{column_index}]"
                if not isinstance(column, str):
                    violations.append(f"{column_path}: expected a field name")
                    continue
                if column in seen_columns:
                    violations.append(
                        f"{column_path}: duplicate predicate column {column!r}"
                    )
                seen_columns.add(column)
                logical_type = species_fields.get(column)
                if logical_type is None:
                    violations.append(
                        f"{column_path}: column {column!r} is missing from the "
                        "Species schema"
                    )
                elif kind == "json_array_any" and logical_type != "json_text_array":
                    violations.append(
                        f"{column_path}: json_array_any requires a json_text_array field"
                    )
                elif kind == "text_any" and logical_type not in {
                    "required_text",
                    "nullable_text",
                }:
                    violations.append(
                        f"{column_path}: text_any requires a text field"
                    )

    excluded = _array_at(
        raw.get("excluded_detail_fields"),
        "excluded_detail_fields",
        violations,
    )
    if excluded is not None:
        seen_excluded: set[str] = set()
        for index, field in enumerate(excluded):
            path = f"excluded_detail_fields[{index}]"
            if not isinstance(field, str) or re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", field
            ) is None:
                violations.append(f"{path}: expected a safe field group")
            elif field in seen_excluded:
                violations.append(f"{path}: duplicate field group {field!r}")
            if isinstance(field, str):
                seen_excluded.add(field)

    return violations


def _object_at(
    value: Any,
    path: str,
    violations: list[str],
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        violations.append(f"{path}: expected an object")
        return None
    return value


def _array_at(
    value: Any,
    path: str,
    violations: list[str],
) -> list[Any] | None:
    if not isinstance(value, list):
        violations.append(f"{path}: expected an array")
        return None
    return value


def _require_exact_keys(
    value: dict[str, Any],
    path: str,
    required_keys: set[str],
    violations: list[str],
    *,
    allowed_keys: set[str] | None = None,
) -> None:
    allowed = required_keys if allowed_keys is None else allowed_keys
    for key in sorted(required_keys - value.keys()):
        violations.append(f"{path}.{key}: required property is missing")
    for key in sorted(value.keys() - allowed):
        violations.append(f"{path}.{key}: unknown property")


def _require_nonempty_string(
    value: Any,
    path: str,
    violations: list[str],
) -> None:
    if not isinstance(value, str) or not value:
        violations.append(f"{path}: expected a nonempty string")


def _require_safe_path_segment(
    value: Any,
    path: str,
    violations: list[str],
) -> None:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9._-]+", value) is None
        or value in (".", "..")
    ):
        violations.append(f"{path}: expected a safe path segment")


def _require_safe_filename_fragment(
    value: Any,
    path: str,
    violations: list[str],
) -> None:
    if (
        not isinstance(value, str)
        or not value
        or re.fullmatch(r"[A-Za-z0-9._-]+", value) is None
        or value in (".", "..")
    ):
        violations.append(f"{path}: expected a safe filename fragment")


def _require_positive_safe_integer(
    value: Any,
    path: str,
    violations: list[str],
) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > 2**53 - 1
    ):
        violations.append(f"{path}: expected a positive safe integer")


def run_bindings_generator(
    *,
    check: bool,
    root: Path = REPO_ROOT,
) -> None:
    """Delegate checked-in artifact publication to the Rust transaction."""
    command = ["cargo", "run", "-p", "bindings-gen"]
    if check:
        command.extend(["--", "--check"])
    try:
        result = subprocess.run(command, cwd=root, check=False)
    except OSError as error:
        raise ArtifactContractError(
            f"failed to launch the bindings generator: {error}"
        ) from error
    if result.returncode != 0:
        operation = "drift check" if check else "publication"
        raise ArtifactContractError(
            f"Rust bindings generator {operation} failed with exit code "
            f"{result.returncode}"
        )


def render_generated(
    *,
    output_directory: Path,
    root: Path = REPO_ROOT,
) -> tuple[Path, Path]:
    """Render admission artifacts into a caller-owned staging directory."""
    try:
        resolved_output = output_directory.resolve()
        protected_destinations = {
            (root / "desktop/web/src/generated").resolve(),
            (REPO_ROOT / "desktop/web/src/generated").resolve(),
        }
    except OSError as error:
        raise ArtifactContractError(
            f"failed to resolve the Web Catalog staging directory: {error}"
        ) from error
    if resolved_output in protected_destinations:
        raise ArtifactContractError(
            "the Web Catalog renderer cannot write the checked-in generated "
            "directory; use the bindings-gen publication authority"
        )
    module, declaration = _render_generated_contents(root=root)
    paths = (
        output_directory / "web-catalog-artifact.mjs",
        output_directory / "web-catalog-artifact.d.mts",
    )
    try:
        output_directory.mkdir(parents=True, exist_ok=True)
        paths[0].write_text(module, encoding="utf-8", newline="\n")
        paths[1].write_text(declaration, encoding="utf-8", newline="\n")
    except OSError as error:
        raise ArtifactContractError(
            f"failed to stage generated Web Catalog artifact files in "
            f"{output_directory}: {error}"
        ) from error
    return paths


def _render_generated_contents(*, root: Path) -> tuple[str, str]:
    plan = compile_web_catalog_artifact(root=root)
    return _render_shared_esm(plan), _render_shared_declaration(plan)


def _render_shared_esm(plan: WebCatalogArtifactPlan) -> str:
    facts = {
        "fingerprint": plan.fingerprint,
        "speciesSearchNormalization": {
            "version": plan.species_search_normalization_version,
            "fingerprint": plan.species_search_normalization_fingerprint,
        },
        "generatedBy": plan.generated_by,
        "version": plan.version,
        "assetFormat": plan.asset_format,
        "duckdbReader": plan.duckdb_reader,
        "maximumAssetBytes": plan.maximum_asset_bytes,
        "locales": list(plan.locales),
        "tables": {
            table.table.value: {
                "assetContainer": table.asset_container,
                "directory": table.directory,
                "filenamePrefix": table.filename_prefix,
                "filenameSuffix": table.filename_suffix,
                "filenameIndexWidth": table.filename_index_width,
                "duckdbTable": table.duckdb_table,
                "fields": [
                    {
                        "name": field.name,
                        "logical_type": field.logical_type,
                    }
                    for field in table.fields
                ],
            }
            for table in plan.tables
        },
        "supportedFilters": [
            {
                "key": item.key,
                "options_key": item.options_key,
                "predicate": {
                    "kind": item.predicate_kind,
                    "columns": list(item.columns),
                },
            }
            for item in plan.supported_filters
        ],
        "excludedDetailFields": list(plan.excluded_detail_fields),
    }
    rendered_facts = json.dumps(
        facts,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    template = r"""const CONTRACT = deepFreeze(__FACTS__);

export const WEB_CATALOG_ARTIFACT_CONTRACT_FINGERPRINT = CONTRACT.fingerprint;

export class WebCatalogManifestError extends Error {
  constructor(violations) {
    super(`Invalid Web Edition Species Catalog manifest:\n${violations.map((violation) => `- ${violation}`).join('\n')}`);
    this.name = 'WebCatalogManifestError';
    this.code = 'invalid_manifest';
    this.violations = Object.freeze([...violations]);
  }
}

export function admitWebCatalogManifest(value) {
  if (!isRecord(value) || !isRecord(value.species_search_normalization) || !isRecord(value.source) || !isRecord(value.cloudflare_pages) || !isRecord(value.assets)) {
    throw new WebCatalogManifestError(['root: expected a complete manifest object']);
  }
  const violations = [];
  validateExactKeys(value, [
    'generated_by',
    'version',
    'artifact_contract_fingerprint',
    'species_search_normalization',
    'asset_format',
    'asset_formats',
    'source',
    'cloudflare_pages',
    'locales',
    'supported_filters',
    'schema',
    'duckdb',
    'assets',
  ], 'root', violations);
  validateExactKeys(value.species_search_normalization, [
    'version',
    'fingerprint',
  ], 'species_search_normalization', violations);
  validateExactKeys(value.source, [
    'export_file',
    'export_schema_version',
    'storage_contract_fingerprint',
  ], 'source', violations);
  validateExactKeys(value.cloudflare_pages, ['max_asset_bytes'], 'cloudflare_pages', violations);
  if (isRecord(value.schema)) {
    validateExactKeys(
      value.schema,
      [
        ...Object.keys(CONTRACT.tables).map((table) => `${table}_fields`),
        'excluded_detail_fields',
      ],
      'schema',
      violations,
    );
  }
  if (isRecord(value.duckdb)) {
    validateExactKeys(value.duckdb, ['reader', 'tables'], 'duckdb', violations);
    if (isRecord(value.duckdb.tables)) {
      validateExactKeys(
        value.duckdb.tables,
        Object.values(CONTRACT.tables).map((table) => table.duckdbTable),
        'duckdb.tables',
        violations,
      );
    }
  }
  validateExactKeys(value.assets, ['species', 'names', 'images'], 'assets', violations);
  if (value.generated_by !== CONTRACT.generatedBy) {
    violations.push(`generated_by: artifact owner must be ${JSON.stringify(CONTRACT.generatedBy)}`);
  }
  if (value.version !== CONTRACT.version) {
    violations.push(`version: expected ${CONTRACT.version}`);
  }
  if (value.artifact_contract_fingerprint !== CONTRACT.fingerprint) {
    violations.push('artifact_contract_fingerprint: expected the compiled contract fingerprint');
  }
  if (!deepEqual(value.species_search_normalization, CONTRACT.speciesSearchNormalization)) {
    violations.push('species_search_normalization: expected the compiled normalization authority');
  }
  if (value.asset_format !== CONTRACT.assetFormat) {
    violations.push(`asset_format: expected ${JSON.stringify(CONTRACT.assetFormat)}`);
  }
  const expectedAssetFormats = {
    species: CONTRACT.assetFormat,
    names: CONTRACT.assetFormat,
    images: CONTRACT.assetFormat,
  };
  if (!deepEqual(value.asset_formats, expectedAssetFormats)) {
    violations.push('asset_formats: expected the compiled per-group formats');
  }
  if (!deepEqual(value.locales, CONTRACT.locales)) {
    violations.push('locales: expected the compiled locale order');
  }
  if (!deepEqual(value.supported_filters, CONTRACT.supportedFilters)) {
    violations.push('supported_filters: expected the compiled Filter definitions');
  }
  const manifestAssetLimit = value.cloudflare_pages.max_asset_bytes;
  const manifestAssetLimitIsValid = Number.isSafeInteger(manifestAssetLimit)
    && manifestAssetLimit >= 1
    && manifestAssetLimit <= CONTRACT.maximumAssetBytes;
  if (!manifestAssetLimitIsValid) {
    violations.push(`cloudflare_pages.max_asset_bytes: expected a positive integer no greater than ${CONTRACT.maximumAssetBytes}`);
  }
  const sourceValue = value.source;
  if (typeof sourceValue.export_file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sourceValue.export_file) || sourceValue.export_file === '.' || sourceValue.export_file === '..') {
    violations.push('source.export_file: expected a safe export basename');
  }
  if (!Number.isSafeInteger(sourceValue.export_schema_version) || sourceValue.export_schema_version < 1) {
    violations.push('source.export_schema_version: expected a positive safe integer');
  }
  if (typeof sourceValue.storage_contract_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sourceValue.storage_contract_fingerprint)) {
    violations.push('source.storage_contract_fingerprint: expected 64 lowercase hexadecimal characters');
  }
  if (!isRecord(value.duckdb) || value.duckdb.reader !== CONTRACT.duckdbReader) {
    violations.push(`duckdb.reader: expected ${JSON.stringify(CONTRACT.duckdbReader)}`);
  }
  if (!isRecord(value.schema)) {
    violations.push('schema: expected the compiled row schemas');
  } else {
    for (const table of ['species', 'names', 'images']) {
      const key = `${table}_fields`;
      if (!deepEqual(value.schema[key], CONTRACT.tables[table].fields)) {
        violations.push(`schema.${key}: expected the compiled row schema`);
      }
    }
    if (!deepEqual(value.schema.excluded_detail_fields, CONTRACT.excludedDetailFields)) {
      violations.push('schema.excluded_detail_fields: expected the compiled excluded-detail projection');
    }
  }
  const assetGroupsValue = value.assets;
  if (!Array.isArray(assetGroupsValue.species) || !isRecord(assetGroupsValue.names) || !Array.isArray(assetGroupsValue.images)) {
    violations.push('assets: expected Species, Common Name, and Image groups');
  } else {
    const seenAssetPaths = new Set();
    if (assetGroupsValue.species.length === 0) violations.push('assets.species: expected at least one asset');
    if (assetGroupsValue.images.length === 0) violations.push('assets.images: expected at least one asset');
    assetGroupsValue.species.forEach((asset, index) => validateAsset(`assets.species[${index}]`, asset, 'species', null, manifestAssetLimitIsValid ? manifestAssetLimit : null, seenAssetPaths, violations));
    for (const locale of CONTRACT.locales) {
      validateAsset(`assets.names.${locale}`, assetGroupsValue.names[locale], 'names', locale, manifestAssetLimitIsValid ? manifestAssetLimit : null, seenAssetPaths, violations);
    }
    for (const locale of Object.keys(assetGroupsValue.names).sort()) {
      if (!CONTRACT.locales.includes(locale)) {
        violations.push(`assets.names.${locale}: unsupported locale asset`);
      }
    }
    assetGroupsValue.images.forEach((asset, index) => validateAsset(`assets.images[${index}]`, asset, 'images', null, manifestAssetLimitIsValid ? manifestAssetLimit : null, seenAssetPaths, violations));
    if (!isRecord(value.duckdb) || !isRecord(value.duckdb.tables)) {
      violations.push('duckdb.tables: expected asset table projections');
    } else {
      const expectedTablePaths = {
        species: assetGroupsValue.species.map((asset) => asset?.path),
        names: CONTRACT.locales.map((locale) => assetGroupsValue.names[locale]?.path),
        images: assetGroupsValue.images.map((asset) => asset?.path),
      };
      for (const table of ['species', 'names', 'images']) {
        const duckdbTable = CONTRACT.tables[table].duckdbTable;
        if (!deepEqual(value.duckdb.tables[duckdbTable], expectedTablePaths[table])) {
          violations.push(`duckdb.tables.${duckdbTable}: expected the admitted asset paths`);
        }
      }
    }
  }
  if (violations.length > 0) throw new WebCatalogManifestError(violations);
  const source = value.source;
  const assets = value.assets;
  if (!Array.isArray(assets.species) || !isRecord(assets.names) || !Array.isArray(assets.images)) {
    throw new WebCatalogManifestError(['assets: expected Species, Common Name, and Image groups']);
  }
  const species = assets.species.map(copyAsset);
  const names = Object.fromEntries(CONTRACT.locales.map((locale) => [locale, copyAsset(assets.names[locale])]));
  const images = assets.images.map(copyAsset);
  const supportedFilters = Array.isArray(value.supported_filters)
    ? value.supported_filters.map((filter) => ({
      key: filter.key,
      optionsKey: filter.options_key,
      predicate: {
        kind: filter.predicate.kind,
        columns: [...filter.predicate.columns],
      },
    }))
    : [];
  return deepFreeze({
    assetFormat: CONTRACT.assetFormat,
    speciesSearchNormalization: {
      version: value.species_search_normalization.version,
      fingerprint: value.species_search_normalization.fingerprint,
    },
    source: {
      exportFile: source.export_file,
      exportSchemaVersion: source.export_schema_version,
      storageContractFingerprint: source.storage_contract_fingerprint,
    },
    maxAssetBytes: value.cloudflare_pages.max_asset_bytes,
    supportedFilters,
    assets: { species, names, images },
    files: [...species, ...CONTRACT.locales.map((locale) => names[locale]), ...images],
  });
}

function copyAsset(value) {
  return {
    path: value.path,
    bytes: value.bytes,
    sha256: value.sha256,
  };
}

function validateAsset(path, value, table, locale, assetLimit, seenPaths, violations) {
  if (!isRecord(value)) {
    violations.push(`${path}: expected an asset entry`);
    return;
  }
  validateExactKeys(value, ['path', 'bytes', 'sha256'], path, violations);
  if (!isSafePortableRelativePath(value.path)) {
    violations.push(`${path}.path: expected a safe portable relative path`);
  } else if (!matchesAssetLayout(table, locale, value.path)) {
    violations.push(`${path}.path: expected the contracted ${table} asset layout`);
  }
  if (typeof value.path === 'string') {
    if (seenPaths.has(value.path)) violations.push(`${path}.path: duplicate asset path ${JSON.stringify(value.path)}`);
    seenPaths.add(value.path);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    violations.push(`${path}.bytes: expected a nonnegative safe integer`);
  } else if (assetLimit !== null && value.bytes > assetLimit) {
    violations.push(`${path}.bytes: exceeds the declared asset limit ${assetLimit}`);
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    violations.push(`${path}.sha256: expected 64 lowercase hexadecimal characters`);
  }
}

function matchesAssetLayout(table, locale, value) {
  const plan = CONTRACT.tables[table];
  const prefix = `${plan.directory}/${plan.filenamePrefix}`;
  if (table === 'names') return value === `${prefix}${locale}${plan.filenameSuffix}`;
  if (!value.startsWith(prefix) || !value.endsWith(plan.filenameSuffix)) return false;
  const index = value.slice(prefix.length, value.length - plan.filenameSuffix.length);
  return index.length === plan.filenameIndexWidth && /^[0-9]+$/.test(index);
}

function isSafePortableRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.startsWith('/') || value.includes('//')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateExactKeys(value, expectedKeys, path, violations) {
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) violations.push(`${path}.${key}: required property is missing`);
  }
  for (const key of Object.keys(value).sort()) {
    if (!expected.has(key)) violations.push(`${path === 'root' ? '' : `${path}.`}${key}: unknown property`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
"""
    return (
        "// Generated by `cargo run -p bindings-gen`.\n"
        "// Do not edit by hand.\n\n"
        + template.replace("__FACTS__", rendered_facts)
    )


def _render_shared_declaration(plan: WebCatalogArtifactPlan) -> str:
    locale_union = " | ".join(json.dumps(locale) for locale in plan.locales)
    filter_key_union = " | ".join(
        json.dumps(filter_plan.key)
        for filter_plan in plan.supported_filters
    )
    filter_options_key_union = " | ".join(
        json.dumps(filter_plan.options_key)
        for filter_plan in plan.supported_filters
    )
    return (
        "// Generated by `cargo run -p bindings-gen`.\n"
        "// Do not edit by hand.\n\n"
        "export declare const WEB_CATALOG_ARTIFACT_CONTRACT_FINGERPRINT: string;\n"
        f"export type WebCatalogLocale = {locale_union};\n"
        f"export type WebCatalogFilterKey = {filter_key_union};\n"
        f"export type WebCatalogFilterOptionsKey = {filter_options_key_union};\n"
        "export interface WebCatalogAsset {\n"
        "  readonly path: string;\n"
        "  readonly bytes: number;\n"
        "  readonly sha256: string;\n"
        "}\n"
        "export interface WebCatalogSupportedFilter {\n"
        "  readonly key: WebCatalogFilterKey;\n"
        "  readonly optionsKey: WebCatalogFilterOptionsKey;\n"
        "  readonly predicate: {\n"
        "    readonly kind: 'json_array_any' | 'text_any';\n"
        "    readonly columns: readonly string[];\n"
        "  };\n"
        "}\n"
        "export interface AdmittedWebCatalog {\n"
        f"  readonly assetFormat: {json.dumps(plan.asset_format)};\n"
        "  readonly speciesSearchNormalization: {\n"
        f"    readonly version: {plan.species_search_normalization_version};\n"
        "    readonly fingerprint: string;\n"
        "  };\n"
        "  readonly source: {\n"
        "    readonly exportFile: string;\n"
        "    readonly exportSchemaVersion: number;\n"
        "    readonly storageContractFingerprint: string;\n"
        "  };\n"
        "  readonly maxAssetBytes: number;\n"
        "  readonly supportedFilters: readonly WebCatalogSupportedFilter[];\n"
        "  readonly assets: {\n"
        "    readonly species: readonly WebCatalogAsset[];\n"
        "    readonly names: Readonly<\n"
        "      Record<WebCatalogLocale, WebCatalogAsset> &\n"
        "      Partial<Record<string, WebCatalogAsset>>\n"
        "    >;\n"
        "    readonly images: readonly WebCatalogAsset[];\n"
        "  };\n"
        "  readonly files: readonly WebCatalogAsset[];\n"
        "}\n"
        "export declare class WebCatalogManifestError extends Error {\n"
        "  readonly code: 'invalid_manifest';\n"
        "  readonly violations: readonly string[];\n"
        "}\n"
        "export declare function admitWebCatalogManifest(value: unknown): AdmittedWebCatalog;\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compile the Web Species Catalog artifact contract."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "check", help="Delegate the generated-adapter drift check to bindings-gen."
    )
    render_parser = subparsers.add_parser(
        "render", help="Render generated files into a staging directory."
    )
    render_parser.add_argument(
        "--output-directory", type=Path, required=True
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            run_bindings_generator(check=True)
        else:
            render_generated(output_directory=args.output_directory)
    except ArtifactContractError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
