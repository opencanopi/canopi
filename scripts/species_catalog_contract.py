#!/usr/bin/env python3
"""Compile and verify the authored Species Catalog storage contract."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import species_search_normalization


SUPPORTED_SQLITE_DECLARED_TYPES = frozenset(
    {"BLOB", "INTEGER", "NUMERIC", "REAL", "TEXT"}
)


class ProjectionTarget(str, Enum):
    PREPARE_DB = "prepare-db"
    WEB_CATALOG = "web-catalog"
    RELEASE = "release"


class SyncMode(str, Enum):
    CHECK = "check"
    WRITE = "write"


class DatabaseProfile(str, Enum):
    EXPORT = "export"
    WEB_EXPORT = "web-export"
    PREPARED = "prepared"


class SpeciesCatalogContractError(RuntimeError):
    """An expected contract-source or invariant failure."""


class ContractSourceError(SpeciesCatalogContractError):
    """The authored contract cannot be read or decoded."""


class ContractInvariantError(SpeciesCatalogContractError):
    """The authored contract violates one or more structural invariants."""

    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Species Catalog storage contract has {len(violations)} "
            f"invariant violation(s):\n{details}"
        )


class FilterContractError(SpeciesCatalogContractError):
    """Filter behavior references storage that the contract cannot provide."""

    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Species Catalog Filter/storage validation found {len(violations)} "
            f"violation(s):\n{details}"
        )


class DatabaseContractError(SpeciesCatalogContractError):
    """A SQLite database does not satisfy the requested storage profile."""

    def __init__(self, profile: DatabaseProfile, violations: list[str]):
        self.profile = profile
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Species Catalog database fails the '{profile.value}' profile with "
            f"{len(violations)} violation(s):\n{details}"
        )


class WebProjectionError(SpeciesCatalogContractError):
    """Reduced Web behavior is inconsistent with its storage projection."""

    def __init__(self, violations: list[str]):
        self.violations = tuple(violations)
        details = "\n".join(f"- {violation}" for violation in violations)
        super().__init__(
            f"Reduced Web Catalog projection has {len(violations)} "
            f"violation(s):\n{details}"
        )


class GeneratedArtifactDriftError(SpeciesCatalogContractError):
    """Committed generated facts do not match the authored contract."""


class SourceExportIdentityError(SpeciesCatalogContractError):
    """A source export does not match the exact authored prepared artifact."""


@dataclass(frozen=True)
class ReleaseProjection:
    prepared_schema_version: int
    minimum_export_schema_version: int
    source_export_sha256: str
    species_search_normalization_version: int
    species_search_normalization_fingerprint: str
    fingerprint: str


@dataclass(frozen=True)
class PrepareDbProjection:
    prepared_schema_version: int
    minimum_export_schema_version: int
    source_export_sha256: str
    species_search_normalization_version: int
    species_search_normalization_fingerprint: str
    species_columns: tuple[StorageColumn, ...]
    supporting_tables: tuple[StorageTable, ...]
    prepared_tables: tuple[StorageTable, ...]
    indexes: tuple[StorageIndex, ...]
    translations: tuple[TranslationEntry, ...]
    fingerprint: str


@dataclass(frozen=True)
class WebCatalogProjection:
    minimum_export_schema_version: int
    species_search_normalization_version: int
    species_search_normalization_fingerprint: str
    species_columns: tuple[StorageColumn, ...]
    supporting_tables: tuple[StorageTable, ...]
    supported_filter_keys: tuple[str, ...]
    fingerprint: str


@dataclass(frozen=True)
class WebFilterUse:
    key: str
    output_columns: tuple[str, ...]


@dataclass(frozen=True)
class WebStorageUse:
    table: str
    columns: tuple[str, ...]


@dataclass(frozen=True)
class VerificationReceipt:
    profile: DatabaseProfile
    database: Path
    observed_schema_version: int
    fingerprint: str
    warnings: tuple[str, ...]


class SQLiteAffinity(str, Enum):
    INTEGER = "INTEGER"
    TEXT = "TEXT"
    BLOB = "BLOB"
    REAL = "REAL"
    NUMERIC = "NUMERIC"


@dataclass(frozen=True)
class StorageColumn:
    name: str
    declared_type: str
    affinity: SQLiteAffinity
    required: bool


@dataclass(frozen=True)
class StorageIndex:
    table: str
    name: str
    columns: tuple[str, ...]


@dataclass(frozen=True)
class StorageTable:
    name: str
    required: bool
    columns: tuple[StorageColumn, ...]
    virtual_module: str | None = None
    virtual_options: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class TranslationEntry:
    field_name: str
    value_en: str
    localized_values: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class _StorageContract:
    contract_format_version: int
    prepared_schema_version: int
    minimum_export_schema_version: int
    source_export_sha256: str
    species_search_normalization_version: int
    species_search_normalization_fingerprint: str
    species_columns: tuple[StorageColumn, ...]
    supporting_tables: tuple[StorageTable, ...]
    prepared_tables: tuple[StorageTable, ...]
    indexes: tuple[StorageIndex, ...]
    translations: tuple[TranslationEntry, ...]
    web_species_columns: tuple[StorageColumn, ...]
    web_supporting_tables: tuple[StorageTable, ...]
    web_filter_keys: tuple[str, ...]
    prepared_fingerprint: str
    fingerprint: str


def project(
    target: ProjectionTarget,
    *,
    root: Path = REPO_ROOT,
) -> ReleaseProjection | PrepareDbProjection | WebCatalogProjection:
    """Return a closed, caller-shaped projection of the authored contract."""
    source = _load_contract(root)
    if target is ProjectionTarget.RELEASE:
        return ReleaseProjection(
            prepared_schema_version=source.prepared_schema_version,
            minimum_export_schema_version=source.minimum_export_schema_version,
            source_export_sha256=source.source_export_sha256,
            species_search_normalization_version=(
                source.species_search_normalization_version
            ),
            species_search_normalization_fingerprint=(
                source.species_search_normalization_fingerprint
            ),
            fingerprint=source.prepared_fingerprint,
        )
    if target is ProjectionTarget.PREPARE_DB:
        return PrepareDbProjection(
            prepared_schema_version=source.prepared_schema_version,
            minimum_export_schema_version=source.minimum_export_schema_version,
            source_export_sha256=source.source_export_sha256,
            species_search_normalization_version=(
                source.species_search_normalization_version
            ),
            species_search_normalization_fingerprint=(
                source.species_search_normalization_fingerprint
            ),
            species_columns=source.species_columns,
            supporting_tables=source.supporting_tables,
            prepared_tables=source.prepared_tables,
            indexes=source.indexes,
            translations=source.translations,
            fingerprint=source.prepared_fingerprint,
        )
    if target is ProjectionTarget.WEB_CATALOG:
        return WebCatalogProjection(
            minimum_export_schema_version=source.minimum_export_schema_version,
            species_search_normalization_version=(
                source.species_search_normalization_version
            ),
            species_search_normalization_fingerprint=(
                source.species_search_normalization_fingerprint
            ),
            species_columns=source.web_species_columns,
            supporting_tables=source.web_supporting_tables,
            supported_filter_keys=source.web_filter_keys,
            fingerprint=source.fingerprint,
        )
    raise SpeciesCatalogContractError(f"unsupported projection target: {target}")


def validate_web_catalog_behavior(
    projection: WebCatalogProjection,
    *,
    emitted_species_fields: tuple[str, ...],
    filters: tuple[WebFilterUse, ...],
    storage_uses: tuple[WebStorageUse, ...],
) -> None:
    """Cross-check local Web behavior without absorbing it into storage."""
    violations: list[str] = []
    projected_tables = {
        "species": {column.name for column in projection.species_columns},
        **{
            table.name: {column.name for column in table.columns}
            for table in projection.supporting_tables
        },
    }
    seen_storage_tables: set[str] = set()
    for index, storage_use in enumerate(storage_uses):
        path = f"storage_uses[{index}]"
        if storage_use.table in seen_storage_tables:
            violations.append(
                f"{path}.table: duplicate projected table '{storage_use.table}'"
            )
        seen_storage_tables.add(storage_use.table)
        projected_columns = projected_tables.get(storage_use.table)
        if projected_columns is None:
            violations.append(
                f"{path}.table: required projected table "
                f"'{storage_use.table}' is missing"
            )
            continue
        if not storage_use.columns:
            violations.append(f"{path}.columns: at least one column is required")
        seen_columns: set[str] = set()
        for column in storage_use.columns:
            if column in seen_columns:
                violations.append(f"{path}.columns: duplicate column '{column}'")
            seen_columns.add(column)
            if column not in projected_columns:
                violations.append(
                    f"{path}.columns: required storage column "
                    f"'{storage_use.table}.{column}' is missing from the reduced "
                    "Web projection"
                )
    emitted = set(emitted_species_fields)
    seen: set[str] = set()
    expected = set(projection.supported_filter_keys)
    for index, filter_use in enumerate(filters):
        path = f"filters[{index}]"
        if filter_use.key in seen:
            violations.append(f"{path}.key: duplicate Filter key '{filter_use.key}'")
        seen.add(filter_use.key)
        if filter_use.key not in expected:
            violations.append(
                f"{path}.key: unsupported Filter key '{filter_use.key}'"
            )
        if not filter_use.output_columns:
            violations.append(f"{path}.output_columns: at least one column is required")
        for column in filter_use.output_columns:
            if column not in emitted:
                violations.append(
                    f"{path}.output_columns: output column '{column}' is not emitted"
                )
    for key in projection.supported_filter_keys:
        if key not in seen:
            violations.append(f"filters: required Filter key '{key}' is missing")
    if violations:
        raise WebProjectionError(violations)


def _load_contract(root: Path) -> _StorageContract:
    contract_path = root / "scripts/schema-contract.json"
    try:
        raw: Any = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractSourceError(
            f"failed to read Species Catalog storage contract {contract_path}: {error}"
        ) from error

    if not isinstance(raw, dict):
        raise ContractInvariantError(["root: expected an object"])

    violations: list[str] = []
    allowed_keys = {
        "contract_format_version",
        "schema_version",
        "min_export_schema_version",
        "species_search_normalization_version",
        "prepared_artifact",
        "description",
        "columns",
        "supporting_tables",
        "prepared_tables",
        "web_projection",
        "indexes",
        "translations",
    }
    required_keys = allowed_keys - {"description"}
    for key in sorted(required_keys - raw.keys()):
        violations.append(f"{key}: required property is missing")
    for key in sorted(raw.keys() - allowed_keys):
        violations.append(f"{key}: unknown property")

    contract_format_version = _read_positive_int(
        raw,
        "contract_format_version",
        violations,
    )
    if contract_format_version not in (0, 1):
        violations.append(
            f"contract_format_version: unsupported version {contract_format_version}"
        )
    prepared_schema_version = _read_positive_int(raw, "schema_version", violations)
    minimum_export_schema_version = _read_positive_int(
        raw,
        "min_export_schema_version",
        violations,
    )
    source_export_sha256 = _read_prepared_artifact(
        raw.get("prepared_artifact"),
        violations,
    )
    declared_normalization_version = _read_positive_int(
        raw,
        "species_search_normalization_version",
        violations,
    )
    try:
        normalization_contract = species_search_normalization.load_contract(root=root)
        normalization_version = normalization_contract.version
        normalization_fingerprint = normalization_contract.fingerprint
        if (
            declared_normalization_version > 0
            and declared_normalization_version != normalization_version
        ):
            violations.append(
                "species_search_normalization_version: expected "
                f"{normalization_version}, found {declared_normalization_version}"
            )
    except RuntimeError as error:
        normalization_version = 0
        normalization_fingerprint = ""
        violations.append(f"species_search_normalization: {error}")
    if "description" in raw and not isinstance(raw["description"], str):
        violations.append("description: expected a string")

    species_columns = _read_columns(raw.get("columns"), violations)
    supporting_tables = _read_supporting_tables(
        raw.get("supporting_tables"),
        violations,
    )
    prepared_tables = _read_prepared_tables(
        raw.get("prepared_tables"),
        violations,
    )
    _validate_unique_storage_table_names(
        supporting_tables,
        prepared_tables,
        violations,
    )
    web_species_columns, web_supporting_tables, web_filter_keys = (
        _read_web_projection(
            raw.get("web_projection"),
            species_columns,
            supporting_tables,
            violations,
        )
    )
    indexes = _read_indexes(
        raw.get("indexes"),
        species_columns,
        supporting_tables,
        prepared_tables,
        violations,
    )
    translations = _read_translations(
        raw.get("translations"),
        _validate_translation_storage(supporting_tables, violations),
        violations,
    )

    if violations:
        raise ContractInvariantError(violations)
    _validate_filter_storage(
        root,
        species_columns,
        supporting_tables,
        web_filter_keys,
    )
    parsed = _StorageContract(
        contract_format_version=contract_format_version,
        prepared_schema_version=prepared_schema_version,
        minimum_export_schema_version=minimum_export_schema_version,
        source_export_sha256=source_export_sha256,
        species_search_normalization_version=normalization_version,
        species_search_normalization_fingerprint=normalization_fingerprint,
        species_columns=tuple(species_columns),
        supporting_tables=tuple(supporting_tables),
        prepared_tables=tuple(prepared_tables),
        indexes=tuple(indexes),
        translations=tuple(translations),
        web_species_columns=tuple(web_species_columns),
        web_supporting_tables=tuple(web_supporting_tables),
        web_filter_keys=tuple(web_filter_keys),
        prepared_fingerprint="",
        fingerprint="",
    )
    return _StorageContract(
        contract_format_version=parsed.contract_format_version,
        prepared_schema_version=parsed.prepared_schema_version,
        minimum_export_schema_version=parsed.minimum_export_schema_version,
        source_export_sha256=parsed.source_export_sha256,
        species_search_normalization_version=(
            parsed.species_search_normalization_version
        ),
        species_search_normalization_fingerprint=(
            parsed.species_search_normalization_fingerprint
        ),
        species_columns=parsed.species_columns,
        supporting_tables=parsed.supporting_tables,
        prepared_tables=parsed.prepared_tables,
        indexes=parsed.indexes,
        translations=parsed.translations,
        web_species_columns=parsed.web_species_columns,
        web_supporting_tables=parsed.web_supporting_tables,
        web_filter_keys=parsed.web_filter_keys,
        prepared_fingerprint=_prepared_contract_fingerprint(parsed),
        fingerprint=_contract_fingerprint(parsed),
    )


def _read_positive_int(
    source: dict[str, Any],
    key: str,
    violations: list[str],
) -> int:
    value = source.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        if key in source:
            violations.append(f"{key}: expected a positive integer")
        return 0
    return value


def _read_prepared_artifact(raw: Any, violations: list[str]) -> str:
    path = "prepared_artifact"
    if not isinstance(raw, dict):
        violations.append(f"{path}: expected an object")
        return ""
    for key in sorted(raw.keys() - {"source_export_sha256"}):
        violations.append(f"{path}.{key}: unknown property")
    if "source_export_sha256" not in raw:
        violations.append(f"{path}.source_export_sha256: required property is missing")
        return ""
    value = raw["source_export_sha256"]
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        violations.append(
            f"{path}.source_export_sha256: expected 64 lowercase hexadecimal characters"
        )
        return ""
    return value


def _read_columns(
    raw: Any,
    violations: list[str],
    *,
    path_prefix: str = "columns",
) -> list[StorageColumn]:
    if not isinstance(raw, list):
        violations.append(f"{path_prefix}: expected an array")
        return []

    columns: list[StorageColumn] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        path = f"{path_prefix}[{index}]"
        if not isinstance(item, dict):
            violations.append(f"{path}: expected an object")
            continue
        for key in sorted(item.keys() - {"name", "type", "required"}):
            violations.append(f"{path}.{key}: unknown property")
        name = item.get("name")
        if not isinstance(name, str) or not _is_identifier(name):
            violations.append(f"{path}.name: expected a safe SQLite identifier")
            continue
        if name in seen:
            violations.append(f"{path}.name: duplicate Species column '{name}'")
        seen.add(name)

        declared_type = item.get("type")
        if (
            not isinstance(declared_type, str)
            or declared_type not in SUPPORTED_SQLITE_DECLARED_TYPES
        ):
            violations.append(
                f"{path}.type: unsupported SQLite declared type {declared_type!r}; "
                f"expected one of {sorted(SUPPORTED_SQLITE_DECLARED_TYPES)}"
            )
            continue
        required = item.get("required", False)
        if not isinstance(required, bool):
            violations.append(f"{path}.required: expected a boolean")
            required = False
        columns.append(
            StorageColumn(
                name=name,
                declared_type=declared_type,
                affinity=sqlite_affinity(declared_type),
                required=required,
            )
        )
    if not columns and raw == []:
        violations.append(f"{path_prefix}: must contain at least one storage column")
    return columns


def _read_supporting_tables(
    raw: Any,
    violations: list[str],
) -> list[StorageTable]:
    return _read_storage_tables(
        raw,
        violations,
        path_prefix="supporting_tables",
        allow_virtual_module=False,
    )


def _read_prepared_tables(
    raw: Any,
    violations: list[str],
) -> list[StorageTable]:
    return _read_storage_tables(
        raw,
        violations,
        path_prefix="prepared_tables",
        allow_virtual_module=True,
    )


def _read_storage_tables(
    raw: Any,
    violations: list[str],
    *,
    path_prefix: str,
    allow_virtual_module: bool,
) -> list[StorageTable]:
    if not isinstance(raw, list):
        violations.append(f"{path_prefix}: expected an array")
        return []
    tables: list[StorageTable] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        path = f"{path_prefix}[{index}]"
        if not isinstance(item, dict):
            violations.append(f"{path}: expected an object")
            continue
        allowed_keys = {"name", "required", "columns"}
        if allow_virtual_module:
            allowed_keys.update({"virtual_module", "virtual_options"})
        for key in sorted(item.keys() - allowed_keys):
            violations.append(f"{path}.{key}: unknown property")
        name = item.get("name")
        if not isinstance(name, str) or not _is_identifier(name):
            violations.append(f"{path}.name: expected a safe SQLite identifier")
            continue
        if name in seen:
            violations.append(f"{path}: duplicate storage table '{name}'")
        seen.add(name)
        required = item.get("required")
        if not isinstance(required, bool):
            violations.append(f"{path}.required: expected a boolean")
            required = False
        virtual_module = item.get("virtual_module") if allow_virtual_module else None
        if virtual_module is not None:
            if virtual_module != "fts5":
                violations.append(
                    f"{path}.virtual_module: unsupported SQLite virtual module "
                    f"{virtual_module!r}"
                )
                virtual_module = None
        virtual_options = _read_virtual_options(
            item.get("virtual_options") if allow_virtual_module else None,
            virtual_module,
            f"{path}.virtual_options",
            violations,
        )
        columns = _read_columns(
            item.get("columns"),
            violations,
            path_prefix=f"{path}.columns",
        )
        tables.append(
            StorageTable(
                name=name,
                required=required,
                columns=tuple(columns),
                virtual_module=virtual_module,
                virtual_options=tuple(virtual_options),
            )
        )
    if not tables and raw == []:
        violations.append(f"{path_prefix}: must contain at least one storage table")
    return tables


def _read_virtual_options(
    raw: Any,
    virtual_module: str | None,
    path: str,
    violations: list[str],
) -> list[tuple[str, str]]:
    if virtual_module is None:
        if raw is not None:
            violations.append(f"{path}: options require a supported virtual_module")
        return []
    if not isinstance(raw, dict):
        violations.append(f"{path}: expected an object")
        return []
    allowed_options = {"content", "content_rowid", "tokenize"}
    for key in sorted(raw.keys() - allowed_options):
        violations.append(f"{path}.{key}: unsupported {virtual_module} option")
    for key in sorted(allowed_options - raw.keys()):
        violations.append(f"{path}.{key}: required {virtual_module} option is missing")
    options: list[tuple[str, str]] = []
    for key in sorted(raw.keys() & allowed_options):
        value = raw[key]
        if not isinstance(value, str) or not value.strip():
            violations.append(f"{path}.{key}: expected a non-empty string")
            continue
        if key in {"content", "content_rowid"}:
            value_is_closed = _is_identifier(value)
        else:
            value_is_closed = (
                re.fullmatch(r"[A-Za-z0-9_ ]+(?:'[A-Za-z0-9_]+')?", value)
                is not None
            )
        if not value_is_closed:
            violations.append(f"{path}.{key}: expected a closed SQLite option value")
            continue
        options.append((key, value))
    return options


def _validate_unique_storage_table_names(
    supporting_tables: list[StorageTable],
    prepared_tables: list[StorageTable],
    violations: list[str],
) -> None:
    supporting_names = {table.name for table in supporting_tables}
    for index, table in enumerate(supporting_tables):
        if table.name == "species":
            violations.append(
                f"supporting_tables[{index}].name: storage table 'species' "
                "is already contracted"
            )
    for index, table in enumerate(prepared_tables):
        if table.name == "species" or table.name in supporting_names:
            violations.append(
                f"prepared_tables[{index}].name: storage table '{table.name}' "
                "is already contracted"
            )


def _validate_translation_storage(
    supporting_tables: list[StorageTable],
    violations: list[str],
) -> set[str]:
    translated_values = next(
        (table for table in supporting_tables if table.name == "translated_values"),
        None,
    )
    if translated_values is None:
        violations.append(
            "translated_values: required supporting storage table is missing"
        )
        return set()
    columns = {column.name: column for column in translated_values.columns}
    for name in ("id", "field_name", "value_en"):
        column = columns.get(name)
        if column is None:
            violations.append(
                f"translated_values.{name}: required TEXT column is missing"
            )
        elif column.affinity is not SQLiteAffinity.TEXT or not column.required:
            violations.append(
                f"translated_values.{name}: must be a required TEXT column"
            )
    locales: set[str] = set()
    for column in translated_values.columns:
        if not column.name.startswith("value_") or column.name == "value_en":
            continue
        locales.add(column.name.removeprefix("value_"))
        if column.affinity is not SQLiteAffinity.TEXT:
            violations.append(
                f"translated_values.{column.name}: locale column must have TEXT affinity"
            )
    return locales


def _read_indexes(
    raw: Any,
    species_columns: list[StorageColumn],
    supporting_tables: list[StorageTable],
    prepared_tables: list[StorageTable],
    violations: list[str],
) -> list[StorageIndex]:
    if not isinstance(raw, dict):
        if raw is not None:
            violations.append("indexes: expected an object")
        return []
    indexes: list[StorageIndex] = []
    seen_names: set[str] = set()
    columns_by_table = {
        "species": {column.name for column in species_columns},
        **{
            table.name: {column.name for column in table.columns}
            for table in (*supporting_tables, *prepared_tables)
        },
    }
    for table, definitions in raw.items():
        table_path = f"indexes.{table}"
        if not isinstance(table, str) or not _is_identifier(table):
            violations.append(f"{table_path}: table name is not a safe SQLite identifier")
        elif table not in columns_by_table:
            violations.append(f"{table_path}: index table is not contracted")
        if not isinstance(definitions, list):
            violations.append(f"{table_path}: expected an array")
            continue
        for index, item in enumerate(definitions):
            path = f"{table_path}[{index}]"
            if not isinstance(item, dict):
                violations.append(f"{path}: expected an object")
                continue
            for key in sorted(item.keys() - {"name", "columns"}):
                violations.append(f"{path}.{key}: unknown property")
            name = item.get("name")
            valid_name = isinstance(name, str) and _is_identifier(name)
            if not valid_name:
                violations.append(f"{path}.name: expected a safe SQLite identifier")
            elif name in seen_names:
                violations.append(f"{path}.name: duplicate index name '{name}'")
            else:
                seen_names.add(name)

            raw_columns = item.get("columns")
            columns = _parse_index_columns(raw_columns)
            if not columns:
                violations.append(
                    f"{path}.columns: expected comma-separated SQLite identifiers"
                )
            else:
                for column in columns:
                    if not _is_identifier(column):
                        violations.append(
                            f"{path}.columns: '{column}' is not a safe SQLite identifier"
                        )
                    elif (
                        table in columns_by_table
                        and column not in columns_by_table[table]
                    ):
                        violations.append(
                            f"{path}.columns: unknown {table} column '{column}'"
                        )
            if valid_name and columns:
                indexes.append(
                    StorageIndex(table=table, name=name, columns=tuple(columns))
                )
    return indexes


def _read_web_projection(
    raw: Any,
    species_columns: list[StorageColumn],
    supporting_tables: list[StorageTable],
    violations: list[str],
) -> tuple[list[StorageColumn], list[StorageTable], list[str]]:
    if not isinstance(raw, dict):
        if raw is not None:
            violations.append("web_projection: expected an object")
        return [], [], []
    for key in sorted(
        raw.keys() - {"species_columns", "supporting_tables", "filter_keys"}
    ):
        violations.append(f"web_projection.{key}: unknown property")

    species_by_name = {column.name: column for column in species_columns}
    web_species_columns: list[StorageColumn] = []
    raw_species_columns = raw.get("species_columns")
    if not isinstance(raw_species_columns, list):
        violations.append("web_projection.species_columns: expected an array")
    else:
        seen: set[str] = set()
        for index, name in enumerate(raw_species_columns):
            path = f"web_projection.species_columns[{index}]"
            if not isinstance(name, str) or not _is_identifier(name):
                violations.append(f"{path}: expected a safe Species column name")
                continue
            if name in seen:
                violations.append(f"{path}: duplicate Species column '{name}'")
                continue
            seen.add(name)
            column = species_by_name.get(name)
            if column is None:
                violations.append(f"{path}: unknown contracted Species column '{name}'")
                continue
            web_species_columns.append(column)
        for column in species_columns:
            if column.required and column.name not in seen:
                violations.append(
                    "web_projection.species_columns: required Species column "
                    f"'{column.name}' is missing"
                )

    support_by_name = {table.name: table for table in supporting_tables}
    web_supporting_tables: list[StorageTable] = []
    raw_support = raw.get("supporting_tables")
    if not isinstance(raw_support, list):
        violations.append("web_projection.supporting_tables: expected an array")
    else:
        seen_tables: set[str] = set()
        for index, item in enumerate(raw_support):
            path = f"web_projection.supporting_tables[{index}]"
            if not isinstance(item, dict):
                violations.append(f"{path}: expected an object")
                continue
            for key in sorted(item.keys() - {"name", "columns"}):
                violations.append(f"{path}.{key}: unknown property")
            name = item.get("name")
            if not isinstance(name, str) or not _is_identifier(name):
                violations.append(f"{path}.name: expected a safe table name")
                continue
            if name in seen_tables:
                violations.append(f"{path}.name: duplicate table '{name}'")
                continue
            seen_tables.add(name)
            contracted_table = support_by_name.get(name)
            if contracted_table is None:
                violations.append(f"{path}.name: unknown supporting table '{name}'")
                continue
            contracted_columns = {
                column.name: column for column in contracted_table.columns
            }
            selected_columns: list[StorageColumn] = []
            raw_columns = item.get("columns")
            if not isinstance(raw_columns, list):
                violations.append(f"{path}.columns: expected an array")
                continue
            seen_columns: set[str] = set()
            for column_index, column_name in enumerate(raw_columns):
                column_path = f"{path}.columns[{column_index}]"
                if not isinstance(column_name, str) or not _is_identifier(column_name):
                    violations.append(f"{column_path}: expected a safe column name")
                    continue
                if column_name in seen_columns:
                    violations.append(
                        f"{column_path}: duplicate column '{column_name}'"
                    )
                    continue
                seen_columns.add(column_name)
                column = contracted_columns.get(column_name)
                if column is None:
                    violations.append(
                        f"{column_path}: unknown column '{name}.{column_name}'"
                    )
                    continue
                selected_columns.append(column)
            web_supporting_tables.append(
                StorageTable(
                    name=name,
                    required=False,
                    columns=tuple(selected_columns),
                )
            )

    filter_keys: list[str] = []
    raw_filter_keys = raw.get("filter_keys")
    if not isinstance(raw_filter_keys, list):
        violations.append("web_projection.filter_keys: expected an array")
    else:
        seen_filter_keys: set[str] = set()
        for index, key in enumerate(raw_filter_keys):
            path = f"web_projection.filter_keys[{index}]"
            if not isinstance(key, str) or not _is_identifier(key):
                violations.append(f"{path}: expected a safe Filter key")
                continue
            if key in seen_filter_keys:
                violations.append(f"{path}: duplicate Filter key '{key}'")
                continue
            seen_filter_keys.add(key)
            filter_keys.append(key)
    return web_species_columns, web_supporting_tables, filter_keys


def _parse_index_columns(raw: Any) -> list[str]:
    if not isinstance(raw, str):
        return []
    return [column.strip() for column in raw.split(",") if column.strip()]


def _read_translations(
    raw: Any,
    permitted_locales: set[str],
    violations: list[str],
) -> list[TranslationEntry]:
    if not isinstance(raw, dict):
        if raw is not None:
            violations.append("translations: expected an object")
        return []
    entries: list[TranslationEntry] = []
    for field_name, values in raw.items():
        field_path = f"translations.{field_name}"
        if not isinstance(field_name, str) or not _is_identifier(field_name):
            violations.append(f"{field_path}: field name is not a safe identifier")
        if not isinstance(values, dict):
            violations.append(f"{field_path}: expected an object")
            continue
        for value_en, localized in values.items():
            value_path = f"{field_path}.{value_en}"
            if not isinstance(value_en, str) or not value_en:
                violations.append(f"{value_path}: English value must be a non-empty string")
                continue
            if not isinstance(localized, dict):
                violations.append(f"{value_path}: expected an object")
                continue
            localized_values: list[tuple[str, str]] = []
            for locale, translated in localized.items():
                if (
                    not isinstance(locale, str)
                    or not _is_identifier(locale)
                    or not isinstance(translated, str)
                ):
                    violations.append(
                        f"{value_path}.{locale}: expected a locale key and string value"
                    )
                    continue
                if locale not in permitted_locales:
                    violations.append(
                        f"{value_path}.{locale}: locale has no contracted "
                        "translated_values column"
                    )
                    continue
                localized_values.append((locale, translated))
            entries.append(
                TranslationEntry(
                    field_name=field_name,
                    value_en=value_en,
                    localized_values=tuple(localized_values),
                )
            )
    return entries


def sqlite_affinity(declared_type: str) -> SQLiteAffinity:
    """Return SQLite's affinity for a declared column type."""
    normalized = declared_type.upper()
    if "INT" in normalized:
        return SQLiteAffinity.INTEGER
    if any(token in normalized for token in ("CHAR", "CLOB", "TEXT")):
        return SQLiteAffinity.TEXT
    if not normalized or "BLOB" in normalized:
        return SQLiteAffinity.BLOB
    if any(token in normalized for token in ("REAL", "FLOA", "DOUB")):
        return SQLiteAffinity.REAL
    return SQLiteAffinity.NUMERIC


def _is_identifier(value: str) -> bool:
    return re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value) is not None


def _validate_filter_storage(
    root: Path,
    species_columns: list[StorageColumn],
    supporting_tables: list[StorageTable],
    web_filter_keys: list[str],
) -> None:
    filter_path = root / "canopi-types/plant-filter-fields.json"
    try:
        raw: Any = json.loads(filter_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FilterContractError(
            [f"{filter_path}: failed to read Filter behavior catalog: {error}"]
        ) from error
    if not isinstance(raw, dict):
        raise FilterContractError(["root: Filter behavior catalog must be an object"])

    violations: list[str] = []
    column_by_name = {column.name: column for column in species_columns}
    fields = raw.get("fields")
    if not isinstance(fields, list):
        raise FilterContractError(["fields: expected an array"])

    field_by_key: dict[str, tuple[int, dict[str, Any]]] = {}
    for index, field in enumerate(fields):
        path = f"fields[{index}]"
        if not isinstance(field, dict):
            violations.append(f"{path}: expected an object")
            continue
        key = field.get("key")
        if isinstance(key, str):
            field_by_key[key] = (index, field)
        column_ref = field.get("sql_column")
        if column_ref is None:
            continue
        kind = field.get("kind")
        expected = {
            "boolean": "integer",
            "categorical": "text",
            "numeric": "numeric",
        }.get(kind)
        if expected is None:
            violations.append(f"{path}.kind: unsupported storage-backed field kind '{kind}'")
            continue
        _validate_filter_column_ref(
            f"{path}.sql_column",
            column_ref,
            expected,
            column_by_name,
            violations,
        )

    fixed_filters = raw.get("fixed_filters")
    if not isinstance(fixed_filters, list):
        violations.append("fixed_filters: expected an array")
        fixed_filters = []
    fixed_filter_by_key: dict[str, tuple[int, dict[str, Any]]] = {}
    for index, fixed_filter in enumerate(fixed_filters):
        path = f"fixed_filters[{index}].predicate"
        if not isinstance(fixed_filter, dict):
            violations.append(f"fixed_filters[{index}]: expected an object")
            continue
        fixed_key = fixed_filter.get("key")
        if isinstance(fixed_key, str):
            fixed_filter_by_key[fixed_key] = (index, fixed_filter)
        predicate = fixed_filter.get("predicate")
        if not isinstance(predicate, dict):
            violations.append(f"{path}: expected an object")
            continue
        kind = predicate.get("kind")
        if kind == "mapped_boolean_list":
            clauses = predicate.get("clauses")
            if not isinstance(clauses, list):
                violations.append(f"{path}.clauses: expected an array")
                continue
            for clause_index, clause in enumerate(clauses):
                clause_path = f"{path}.clauses[{clause_index}].clause"
                clause_text = clause.get("clause") if isinstance(clause, dict) else None
                _validate_filter_clause(
                    clause_path,
                    clause_text,
                    "integer",
                    column_by_name,
                    violations,
                )
        elif kind in ("boolean_true_clause",):
            _validate_filter_clause(
                f"{path}.clause",
                predicate.get("clause"),
                "integer",
                column_by_name,
                violations,
            )
        elif kind in ("text_in_column", "text_equals_column"):
            _validate_filter_column_ref(
                f"{path}.column",
                predicate.get("column"),
                "text",
                column_by_name,
                violations,
            )
        elif kind == "numeric_gte_column":
            _validate_filter_column_ref(
                f"{path}.column",
                predicate.get("column"),
                "numeric",
                column_by_name,
                violations,
            )
        elif kind in ("schema_text_in", "schema_boolean_true"):
            field_key = predicate.get("field_key")
            expected = "text" if kind == "schema_text_in" else "integer"
            target = field_by_key.get(field_key) if isinstance(field_key, str) else None
            if target is None:
                violations.append(f"{path}.field_key: unknown Filter field '{field_key}'")
                continue
            field_index, field = target
            _validate_filter_column_ref(
                f"{path}.field_key -> fields[{field_index}].sql_column",
                field.get("sql_column"),
                expected,
                column_by_name,
                violations,
            )
        elif kind == "climate_zone_join":
            table = next(
                (
                    table
                    for table in supporting_tables
                    if table.name == "species_climate_zones"
                ),
                None,
            )
            columns = {
                column.name: column
                for column in (() if table is None else table.columns)
            }
            for column_name in ("species_id", "climate_zone"):
                column = columns.get(column_name)
                if column is None:
                    violations.append(
                        f"{path}: supporting table 'species_climate_zones' "
                        f"is missing TEXT column '{column_name}'"
                    )
                elif column.affinity is not SQLiteAffinity.TEXT:
                    violations.append(
                        f"{path}: supporting table 'species_climate_zones' column "
                        f"'{column_name}' expected TEXT affinity, found "
                        f"{column.affinity.value}"
                    )
        else:
            violations.append(f"{path}.kind: unsupported predicate kind '{kind}'")

    for index, key in enumerate(web_filter_keys):
        target = fixed_filter_by_key.get(key)
        path = f"web_projection.filter_keys[{index}]"
        if target is None:
            violations.append(f"{path}: unknown fixed Filter key '{key}'")
            continue
        _, fixed_filter = target
        if fixed_filter.get("kind") != "array":
            violations.append(
                f"{path}: Web Catalog Filter '{key}' must have array behavior"
            )

    if violations:
        raise FilterContractError(violations)


def _validate_filter_clause(
    path: str,
    clause: Any,
    expected: str,
    column_by_name: dict[str, StorageColumn],
    violations: list[str],
) -> None:
    if not isinstance(clause, str):
        violations.append(f"{path}: expected a SQL clause string")
        return
    match = re.fullmatch(
        r"(s\.[A-Za-z_][A-Za-z0-9_]*)\s*(?:=|>|>=|<|<=)\s*-?\d+",
        clause,
    )
    if match is None:
        violations.append(f"{path}: expected a simple Species integer comparison")
        return
    _validate_filter_column_ref(
        path,
        match.group(1),
        expected,
        column_by_name,
        violations,
    )


def _validate_filter_column_ref(
    path: str,
    column_ref: Any,
    expected: str,
    column_by_name: dict[str, StorageColumn],
    violations: list[str],
) -> None:
    if not isinstance(column_ref, str) or not column_ref.startswith("s."):
        violations.append(f"{path}: expected an 's.<column>' storage reference")
        return
    column_name = column_ref[2:]
    if not _is_identifier(column_name):
        violations.append(f"{path}: invalid Species column reference '{column_ref}'")
        return
    column = column_by_name.get(column_name)
    if column is None:
        violations.append(f"{path}: unknown Species column '{column_name}'")
        return
    if expected == "numeric":
        compatible = column.affinity in {
            SQLiteAffinity.INTEGER,
            SQLiteAffinity.REAL,
            SQLiteAffinity.NUMERIC,
        }
        expected_label = "numeric"
    else:
        expected_affinity = {
            "integer": SQLiteAffinity.INTEGER,
            "text": SQLiteAffinity.TEXT,
        }[expected]
        compatible = column.affinity is expected_affinity
        expected_label = expected_affinity.value
    if not compatible:
        violations.append(
            f"{path}: expected {expected_label} affinity, found {column.affinity.value} "
            f"for Species column '{column_name}'"
        )


def _prepared_contract_semantics(contract: _StorageContract) -> dict[str, Any]:
    return {
        "contract_format_version": contract.contract_format_version,
        "schema_version": contract.prepared_schema_version,
        "min_export_schema_version": contract.minimum_export_schema_version,
        "species_search_normalization": {
            "version": contract.species_search_normalization_version,
            "fingerprint": contract.species_search_normalization_fingerprint,
        },
        "columns": [
            {
                "name": column.name,
                "affinity": column.affinity.value,
                "required": column.required,
            }
            for column in contract.species_columns
        ],
        "supporting_tables": [
            {
                "name": table.name,
                "required": table.required,
                "columns": [
                    {
                        "name": column.name,
                        "affinity": column.affinity.value,
                        "required": column.required,
                    }
                    for column in table.columns
                ],
            }
            for table in sorted(contract.supporting_tables, key=lambda item: item.name)
        ],
        "prepared_tables": [
            {
                "name": table.name,
                "required": table.required,
                "virtual_module": table.virtual_module,
                "virtual_options": dict(table.virtual_options),
                "columns": [
                    {
                        "name": column.name,
                        "affinity": column.affinity.value,
                        "required": column.required,
                    }
                    for column in table.columns
                ],
            }
            for table in sorted(contract.prepared_tables, key=lambda item: item.name)
        ],
        "indexes": [
            {
                "table": index.table,
                "name": index.name,
                "columns": list(index.columns),
            }
            for index in sorted(
                contract.indexes,
                key=lambda item: (item.table, item.name),
            )
        ],
        "translations": [
            {
                "field_name": entry.field_name,
                "value_en": entry.value_en,
                "localized_values": dict(sorted(entry.localized_values)),
            }
            for entry in sorted(
                contract.translations,
                key=lambda item: (item.field_name, item.value_en),
            )
        ],
    }


def _web_projection_semantics(contract: _StorageContract) -> dict[str, Any]:
    return {
        "species_columns": [column.name for column in contract.web_species_columns],
        "supporting_tables": [
            {
                "name": table.name,
                "columns": [column.name for column in table.columns],
            }
            for table in contract.web_supporting_tables
        ],
        "filter_keys": list(contract.web_filter_keys),
    }


def _semantic_fingerprint(semantic_source: dict[str, Any]) -> str:
    canonical = json.dumps(
        semantic_source,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _prepared_contract_fingerprint(contract: _StorageContract) -> str:
    return _semantic_fingerprint(_prepared_contract_semantics(contract))


def _contract_fingerprint(contract: _StorageContract) -> str:
    semantic_source = _prepared_contract_semantics(contract)
    semantic_source["web_projection"] = _web_projection_semantics(contract)
    return _semantic_fingerprint(semantic_source)


def prepared_database_asset_name(release: ReleaseProjection) -> str:
    return (
        f"canopi-core-v{release.prepared_schema_version}-"
        f"{release.fingerprint}-{release.source_export_sha256}.db"
    )


def verify_source_export_identity(
    export_path: Path,
    *,
    root: Path = REPO_ROOT,
) -> str:
    source = _load_contract(root)
    export_path = export_path.resolve()
    if not export_path.is_file():
        raise SourceExportIdentityError(
            f"Prepared artifact source export does not exist: {export_path}"
        )
    digest = hashlib.sha256()
    try:
        with export_path.open("rb") as export:
            for chunk in iter(lambda: export.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise SourceExportIdentityError(
            f"Failed to read prepared artifact source export {export_path}: {error}"
        ) from error
    observed = digest.hexdigest()
    if observed != source.source_export_sha256:
        raise SourceExportIdentityError(
            "Prepared artifact source export SHA-256 "
            f"{observed} does not equal authored {source.source_export_sha256}: "
            f"{export_path}"
        )
    return observed


def verify_database(
    profile: DatabaseProfile,
    database: Path,
    *,
    root: Path = REPO_ROOT,
) -> VerificationReceipt:
    """Verify a local SQLite database against one closed storage profile."""
    source = _load_contract(root)
    database = database.resolve()
    if profile not in (
        DatabaseProfile.EXPORT,
        DatabaseProfile.WEB_EXPORT,
        DatabaseProfile.PREPARED,
    ):
        raise SpeciesCatalogContractError(
            f"unsupported Species Catalog database profile: {profile.value}"
        )
    if not database.is_file():
        raise DatabaseContractError(
            profile,
            [f"database: file does not exist: {database}"],
        )

    violations: list[str] = []
    warnings: list[str] = []
    observed_schema_version = 0
    uri = f"{database.as_uri()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:
        raise DatabaseContractError(
            profile,
            [f"database: failed to open SQLite file: {error}"],
        ) from error
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if profile in (DatabaseProfile.EXPORT, DatabaseProfile.WEB_EXPORT):
            observed_schema_version = _verify_export_metadata(
                connection,
                tables,
                source.minimum_export_schema_version,
                violations,
            )
        else:
            row = connection.execute("PRAGMA user_version").fetchone()
            observed_schema_version = 0 if row is None else int(row[0])
            if observed_schema_version != source.prepared_schema_version:
                violations.append(
                    "PRAGMA user_version: prepared schema version "
                    f"{observed_schema_version} does not equal required "
                    f"{source.prepared_schema_version}"
                )

        species_columns = (
            source.web_species_columns
            if profile is DatabaseProfile.WEB_EXPORT
            else source.species_columns
        )
        _verify_table_columns(
            connection,
            tables,
            "species",
            species_columns,
            table_required=True,
            optional_label="Species",
            all_columns_required=profile is DatabaseProfile.PREPARED,
            violations=violations,
            warnings=warnings,
        )
        supporting_tables = (
            source.web_supporting_tables
            if profile is DatabaseProfile.WEB_EXPORT
            else source.supporting_tables
        )
        for table in supporting_tables:
            _verify_table_columns(
                connection,
                tables,
                table.name,
                table.columns,
                table_required=table.required,
                optional_label=f"supporting table '{table.name}'",
                all_columns_required=False,
                violations=violations,
                warnings=warnings,
            )
        if profile is DatabaseProfile.PREPARED:
            for table in source.prepared_tables:
                _verify_table_columns(
                    connection,
                    tables,
                    table.name,
                    table.columns,
                    table_required=table.required,
                    optional_label=f"prepared table '{table.name}'",
                    all_columns_required=True,
                    violations=violations,
                    warnings=warnings,
                )
                _verify_virtual_table_module(
                    connection,
                    tables,
                    table,
                    violations,
                )
            _verify_prepared_identity(connection, tables, source, violations)
            _verify_indexes(connection, source.indexes, violations)
    except sqlite3.Error as error:
        violations.append(f"database: failed while inspecting SQLite schema: {error}")
    finally:
        connection.close()

    if violations:
        raise DatabaseContractError(profile, violations)
    return VerificationReceipt(
        profile=profile,
        database=database,
        observed_schema_version=observed_schema_version,
        fingerprint=(
            source.prepared_fingerprint
            if profile is DatabaseProfile.PREPARED
            else source.fingerprint
        ),
        warnings=tuple(warnings),
    )


def _verify_prepared_identity(
    connection: sqlite3.Connection,
    tables: set[str],
    source: _StorageContract,
    violations: list[str],
) -> None:
    table = "species_search_metadata"
    if table not in tables:
        return
    expected = {
        "schema_version": str(source.prepared_schema_version),
        "storage_contract_fingerprint": source.prepared_fingerprint,
        "normalization_version": str(source.species_search_normalization_version),
        "normalization_fingerprint": (
            source.species_search_normalization_fingerprint
        ),
    }
    values_by_key: dict[str, list[str]] = {}
    for raw_key, raw_value in connection.execute(
        f"SELECT key, value FROM {table}"
    ):
        key = str(raw_key)
        values_by_key.setdefault(key, []).append(str(raw_value))

    for key, expected_value in expected.items():
        values = values_by_key.get(key, [])
        if not values:
            violations.append(f"{table}.{key}: required identity value is missing")
        elif len(values) != 1:
            violations.append(
                f"{table}.{key}: expected exactly one identity value, found {len(values)}"
            )
        elif values[0] != expected_value:
            violations.append(
                f"{table}.{key}: value {values[0]!r} does not equal required "
                f"{expected_value!r}"
            )

    for key in sorted(values_by_key.keys() - expected.keys()):
        violations.append(f"{table}.{key}: unexpected identity key")


def _verify_export_metadata(
    connection: sqlite3.Connection,
    tables: set[str],
    minimum_version: int,
    violations: list[str],
) -> int:
    if "_metadata" not in tables:
        violations.append("_metadata: required export metadata table is missing")
        return 0
    try:
        row = connection.execute(
            "SELECT value FROM _metadata WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.Error as error:
        violations.append(f"_metadata.schema_version: failed to read value: {error}")
        return 0
    if row is None:
        violations.append("_metadata.schema_version: required export version is missing")
        return 0
    raw_version = row[0]
    if isinstance(raw_version, int) and not isinstance(raw_version, bool):
        version = raw_version
    elif isinstance(raw_version, str) and re.fullmatch(r"[0-9]+", raw_version):
        version = int(raw_version)
    else:
        violations.append(
            "_metadata.schema_version: expected a decimal integer value"
        )
        return 0
    if version < minimum_version:
        violations.append(
            "_metadata.schema_version: export schema version "
            f"{version} is below minimum {minimum_version}"
        )
    return version


def _verify_table_columns(
    connection: sqlite3.Connection,
    tables: set[str],
    table_name: str,
    expected_columns: tuple[StorageColumn, ...],
    *,
    table_required: bool,
    optional_label: str,
    all_columns_required: bool,
    violations: list[str],
    warnings: list[str],
) -> None:
    if table_name not in tables:
        message = f"table '{table_name}' is absent"
        if table_required:
            violations.append(f"{table_name}: required {message}")
        else:
            warnings.append(f"optional {message}")
        return
    actual_columns = {
        row[0]: sqlite_affinity(row[1] or "")
        for row in connection.execute(
            "SELECT name, type FROM pragma_table_info(?)",
            (table_name,),
        )
    }
    for column in expected_columns:
        actual_affinity = actual_columns.get(column.name)
        if actual_affinity is None:
            if all_columns_required or column.required:
                violations.append(
                    f"{table_name}.{column.name}: required column is absent"
                )
            else:
                warnings.append(
                    f"optional {optional_label} column '{column.name}' is absent"
                )
            continue
        if actual_affinity is not column.affinity:
            violations.append(
                f"{table_name}.{column.name}: expected {column.affinity.value} "
                f"affinity, found {actual_affinity.value}"
            )


def _verify_indexes(
    connection: sqlite3.Connection,
    expected_indexes: tuple[StorageIndex, ...],
    violations: list[str],
) -> None:
    actual_indexes = {
        row[0]: row[1]
        for row in connection.execute(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'"
        )
    }
    for index in expected_indexes:
        actual_table = actual_indexes.get(index.name)
        if actual_table is None:
            violations.append(
                f"indexes.{index.name}: required index on '{index.table}' is missing"
            )
            continue
        if actual_table != index.table:
            violations.append(
                f"indexes.{index.name}: expected table '{index.table}', "
                f"found '{actual_table}'"
            )
            continue
        partial_row = connection.execute(
            "SELECT partial FROM pragma_index_list(?) WHERE name = ?",
            (index.table, index.name),
        ).fetchone()
        if partial_row is not None and int(partial_row[0]) != 0:
            violations.append(
                f"indexes.{index.name}: required index must not be partial"
            )
        actual_key_columns = tuple(
            (row[0], row[1])
            for row in connection.execute(
                "SELECT name, coll FROM pragma_index_xinfo(?) "
                "WHERE key = 1 ORDER BY seqno",
                (index.name,),
            )
        )
        actual_columns = tuple(row[0] for row in actual_key_columns)
        if actual_columns != index.columns:
            violations.append(
                f"indexes.{index.name}: expected columns {index.columns}, "
                f"found {actual_columns}"
            )
        for column_name, collation in actual_key_columns:
            if column_name is None or str(collation).upper() == "BINARY":
                continue
            violations.append(
                f"indexes.{index.name}: expected BINARY collation for column "
                f"'{column_name}', found {collation}"
            )


def _verify_virtual_table_module(
    connection: sqlite3.Connection,
    tables: set[str],
    table: StorageTable,
    violations: list[str],
) -> None:
    if table.virtual_module is None or table.name not in tables:
        return
    expected_columns = tuple(column.name for column in table.columns)
    actual_columns = tuple(
        row[0]
        for row in connection.execute(
            "SELECT name FROM pragma_table_info(?) ORDER BY cid",
            (table.name,),
        )
    )
    if actual_columns != expected_columns:
        violations.append(
            f"{table.name}: expected ordered virtual columns {expected_columns}, "
            f"found {actual_columns}"
        )
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table.name,),
    ).fetchone()
    creation_sql = "" if row is None or row[0] is None else str(row[0])
    module_pattern = rf"\bUSING\s+{re.escape(table.virtual_module)}\s*\("
    if re.search(module_pattern, creation_sql, flags=re.IGNORECASE) is None:
        violations.append(
            f"{table.name}: expected SQLite virtual table module "
            f"'{table.virtual_module}'"
        )
        return
    normalized_sql = re.sub(r"\s+", " ", creation_sql)
    for key, value in table.virtual_options:
        option_pattern = (
            rf"\b{re.escape(key)}\s*=\s*['\"]"
            rf"{re.escape(value)}['\"]"
        )
        if re.search(option_pattern, normalized_sql, flags=re.IGNORECASE) is None:
            violations.append(
                f"{table.name}: expected virtual option {key}={value!r}"
            )


def sync_generated(
    mode: SyncMode,
    *,
    root: Path = REPO_ROOT,
) -> Path:
    """Check or update the committed Rust projection."""
    generated_path = root / "desktop/src/db/schema_contract_generated.rs"
    expected = _render_rust(_load_contract(root))
    if mode is SyncMode.CHECK:
        try:
            actual = generated_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            actual = ""
        except OSError as error:
            raise SpeciesCatalogContractError(
                f"failed to read generated Species Catalog facts {generated_path}: {error}"
            ) from error
        if actual != expected:
            raise GeneratedArtifactDriftError(
                "generated Species Catalog Rust facts are stale; "
                "run 'python3 scripts/species_catalog_contract.py emit-rust --write'"
            )
        return generated_path
    if mode is SyncMode.WRITE:
        generated_path.parent.mkdir(parents=True, exist_ok=True)
        publication_mode = (
            stat.S_IMODE(generated_path.stat().st_mode)
            if generated_path.is_file()
            else None
        )
        if publication_mode is None:
            current_umask = os.umask(0)
            os.umask(current_umask)
            publication_mode = 0o666 & ~current_umask
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=generated_path.parent,
                prefix=f".{generated_path.name}.",
                delete=False,
            ) as handle:
                temporary_path = Path(handle.name)
                handle.write(expected)
                handle.flush()
                os.fsync(handle.fileno())
            temporary_path.chmod(publication_mode)
            os.replace(temporary_path, generated_path)
        except OSError as error:
            raise SpeciesCatalogContractError(
                f"failed to write generated Species Catalog facts {generated_path}: {error}"
            ) from error
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()
        return generated_path
    raise SpeciesCatalogContractError(f"unsupported generated sync mode: {mode}")


def _render_rust(contract: _StorageContract) -> str:
    lines = [
        "// Generated by `python3 scripts/species_catalog_contract.py emit-rust --write`.",
        "// Do not edit by hand.",
        "",
        (
            "pub(crate) const EXPECTED_PLANT_SCHEMA_VERSION: i32 = "
            f"{contract.prepared_schema_version};"
        ),
        (
            "pub(crate) const SPECIES_SEARCH_NORMALIZATION_VERSION: u32 = "
            f"{contract.species_search_normalization_version};"
        ),
        (
            "pub(crate) const SPECIES_SEARCH_NORMALIZATION_FINGERPRINT: &str ="
        ),
        f"    {_rust_string(contract.species_search_normalization_fingerprint)};",
        "#[cfg(test)]",
        (
            "pub(crate) const MINIMUM_EXPORT_SCHEMA_VERSION: i32 = "
            f"{contract.minimum_export_schema_version};"
        ),
        (
            "pub(crate) const SPECIES_STORAGE_CONTRACT_FINGERPRINT: &str ="
        ),
        f"    {_rust_string(contract.prepared_fingerprint)};",
        "",
        "#[cfg(test)]",
        "#[rustfmt::skip]",
        "pub(crate) const SPECIES_STORAGE_COLUMNS: &[(&str, &str, bool)] = &[",
    ]
    for column in contract.species_columns:
        lines.append(
            "    ("
            f"{_rust_string(column.name)}, {_rust_string(column.affinity.value)}, "
            f"{str(column.required).lower()}),"
        )
    lines.extend(
        [
            "];",
            "",
            "#[cfg(test)]",
            "#[rustfmt::skip]",
            "pub(crate) const REQUIRED_SUPPORTING_TABLES: &[&str] = &[",
        ]
    )
    for table in contract.supporting_tables:
        if table.required:
            lines.append(f"    {_rust_string(table.name)},")
    lines.extend(
        [
            "];",
            "",
            "#[cfg(test)]",
            "#[rustfmt::skip]",
            (
                "pub(crate) const SUPPORTING_STORAGE_COLUMNS: "
                "&[(&str, &str, &str, bool)] = &["
            ),
        ]
    )
    for table in contract.supporting_tables:
        for column in table.columns:
            lines.append(
                "    ("
                f"{_rust_string(table.name)}, {_rust_string(column.name)}, "
                f"{_rust_string(column.affinity.value)}, "
                f"{str(column.required).lower()}),"
            )
    lines.extend(
        [
            "];",
            "",
            "#[cfg(test)]",
            "#[rustfmt::skip]",
            (
                "pub(crate) const REQUIRED_PREPARED_TABLES: "
                "&[(&str, Option<&str>)] = &["
            ),
        ]
    )
    for table in contract.prepared_tables:
        if table.required:
            virtual_module = (
                "None"
                if table.virtual_module is None
                else f"Some({_rust_string(table.virtual_module)})"
            )
            lines.append(
                f"    ({_rust_string(table.name)}, {virtual_module}),"
            )
    lines.extend(
        [
            "];",
            "",
            "#[cfg(test)]",
            "#[rustfmt::skip]",
            (
                "pub(crate) const PREPARED_VIRTUAL_TABLE_OPTIONS: "
                "&[(&str, &str, &str)] = &["
            ),
        ]
    )
    for table in contract.prepared_tables:
        for key, value in table.virtual_options:
            lines.append(
                "    ("
                f"{_rust_string(table.name)}, {_rust_string(key)}, "
                f"{_rust_string(value)}),"
            )
    lines.extend(
        [
            "];",
            "",
            "#[cfg(test)]",
            "#[rustfmt::skip]",
            (
                "pub(crate) const PREPARED_STORAGE_COLUMNS: "
                "&[(&str, &str, &str, bool)] = &["
            ),
        ]
    )
    for table in contract.prepared_tables:
        for column in table.columns:
            lines.append(
                "    ("
                f"{_rust_string(table.name)}, {_rust_string(column.name)}, "
                f"{_rust_string(column.affinity.value)}, "
                f"{str(column.required).lower()}),"
            )
    lines.extend(
        [
            "];",
            "",
            "#[cfg(test)]",
            "#[rustfmt::skip]",
            (
                "pub(crate) const REQUIRED_STORAGE_INDEXES: "
                "&[(&str, &str, &[&str])] = &["
            ),
        ]
    )
    for index in contract.indexes:
        columns = ", ".join(_rust_string(column) for column in index.columns)
        lines.append(
            "    ("
            f"{_rust_string(index.table)}, {_rust_string(index.name)}, &[{columns}]),"
        )
    lines.extend(["];", ""])
    return "\n".join(lines)


def _rust_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compile and verify the Species Catalog storage contract",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=REPO_ROOT,
        help=argparse.SUPPRESS,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    value = subparsers.add_parser("value", help="print one release metadata value")
    value.add_argument(
        "name",
        choices=[
            "prepared-schema-version",
            "minimum-export-schema-version",
            "prepared-source-export-sha256",
            "prepared-contract-fingerprint",
            "prepared-db-asset-name",
        ],
    )
    subparsers.add_parser("check", help="validate sources and generated facts")
    emit_rust = subparsers.add_parser(
        "emit-rust",
        help="check or write committed Rust facts",
    )
    emit_mode = emit_rust.add_mutually_exclusive_group(required=True)
    emit_mode.add_argument("--check", action="store_true")
    emit_mode.add_argument("--write", action="store_true")
    verify = subparsers.add_parser(
        "verify-db",
        help="verify a SQLite database profile",
    )
    verify.add_argument(
        "--profile",
        required=True,
        choices=[profile.value for profile in DatabaseProfile],
    )
    verify.add_argument("database", type=Path)
    verify_source = subparsers.add_parser(
        "verify-source-export",
        help="verify exact prepared artifact source export bytes",
    )
    verify_source.add_argument("database", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "value":
            release = project(ProjectionTarget.RELEASE, root=args.root)
            assert isinstance(release, ReleaseProjection)
            values = {
                "prepared-schema-version": release.prepared_schema_version,
                "minimum-export-schema-version": release.minimum_export_schema_version,
                "prepared-source-export-sha256": release.source_export_sha256,
                "prepared-contract-fingerprint": release.fingerprint,
                "prepared-db-asset-name": prepared_database_asset_name(release),
            }
            print(values[args.name])
            return 0
        if args.command == "verify-source-export":
            observed = verify_source_export_identity(args.database, root=args.root)
            print(f"Prepared artifact source export OK ({observed})")
            return 0
        if args.command == "emit-rust":
            mode = SyncMode.WRITE if args.write else SyncMode.CHECK
            path = sync_generated(mode, root=args.root)
            action = "Wrote" if mode is SyncMode.WRITE else "Checked"
            print(f"{action} generated Species Catalog Rust facts: {path}")
            return 0
        if args.command == "check":
            sync_generated(SyncMode.CHECK, root=args.root)
            release = project(ProjectionTarget.RELEASE, root=args.root)
            assert isinstance(release, ReleaseProjection)
            print(
                "Species Catalog storage contract OK "
                f"({release.fingerprint})"
            )
            return 0
        if args.command == "verify-db":
            receipt = verify_database(
                DatabaseProfile(args.profile),
                args.database,
                root=args.root,
            )
            for warning in receipt.warnings:
                print(f"WARN: {warning}")
            print(
                f"Verified {receipt.profile.value} Species Catalog database "
                f"(schema {receipt.observed_schema_version}, "
                f"contract {receipt.fingerprint})"
            )
            return 0
        raise SpeciesCatalogContractError(f"unsupported command: {args.command}")
    except SpeciesCatalogContractError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
