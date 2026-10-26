"""The Web Edition archive: its name, the Pages limits and the packager (ADR 0029 Static Web serving, 2.1-M216).

The one home of these rules, imported by the `web_release.py` CLI (`package`, `archive-name`, the checks) and by
`release_candidate_artifacts.py` (the name). The limits are constants, never read from a manifest, so no release can
loosen them: this packager writes none, and the checks ignore the `limits`, `basePath` and `spaFallback` a 2.0.x
manifest carries. The site is served at the root base only (2.1-Q85, 2.1-M66).
Run through `python3 -I scripts/web_release.py`; from the Release Candidate workflow, from `main`'s checkout against
the ref's build (2.1-M216).
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile

MANIFEST_NAME = "canopi-web-edition-manifest.json"
INDEX_NAME = "index.html"
# Vite's Web entry, which the archive serves as index.html.
BUILT_INDEX_NAME = "web.html"
NOTICES_NAME = "THIRD_PARTY_NOTICES.md"
EDITION_NAME = "Canopi Web Edition"
# Cloudflare Pages: 25 MiB per file and 20,000 files per deployment on the free plan (ADR 0029).
MAX_ASSET_BYTES = 25 * 1024 * 1024
MAX_FILES = 20_000
RAW_DUCKDB_WASM_RE = re.compile(r"(?:^|/)duckdb-.*\.wasm$", re.IGNORECASE)
ARCHIVE_RE = re.compile(r"canopi-web-edition-root-v(.+)-([0-9a-f]{12})\.tar\.gz")
COMMIT_RE = re.compile(r"[0-9a-f]{12}(?:[0-9a-f]{28})?")
VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+-]*")
HTML_REFERENCE_RE = re.compile(r"""\b(?:src|href)=["'](/[^"'/][^"']*)["']""", re.IGNORECASE)


class ReleaseError(RuntimeError):
    """A release input or a live deployment failed a check."""

    def __init__(self, violations: list[str] | str):
        self.violations = [violations] if isinstance(violations, str) else list(violations)
        super().__init__("\n".join(f"- {violation}" for violation in self.violations))


def archive_name(version: str, commit: str) -> str:
    """The root Web Edition archive of a release: its version and the first 12 hex of its commit."""
    if not VERSION_RE.fullmatch(version):
        raise ReleaseError(f"version {version!r} is not a release version")
    if not COMMIT_RE.fullmatch(commit):
        raise ReleaseError(f"commit {commit!r} is not 12 or 40 lowercase hex characters")
    return f"canopi-web-edition-root-v{version}-{commit[:12]}.tar.gz"


def archive_glob(version: str) -> str:
    """The shell pattern every candidate's archive of `version` matches, whatever its commit."""
    archive_name(version, "0" * 12)
    return f"canopi-web-edition-root-v{version}-*.tar.gz"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def files_under(root: Path) -> tuple[list[str], list[str]]:
    """Regular files below `root` (POSIX paths, sorted) and the entries that are not."""
    files, violations = [], []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            violations.append(f"symbolic link: {relative}")
        elif path.is_file():
            files.append(relative)
        elif not path.is_dir():
            violations.append(f"unsupported filesystem entry: {relative}")
    return files, violations


def limit_violations(site: Path, files: list[str], *, label: str = "") -> list[str]:
    """The Pages limits and the raw DuckDB wasm rule on one set of files, always these constants."""
    violations = []
    for path in files:
        size = (site / path).stat().st_size
        if size > MAX_ASSET_BYTES:
            violations.append(f"{label}{path} is {size} bytes, above the Pages limit {MAX_ASSET_BYTES}")
        if RAW_DUCKDB_WASM_RE.search(path):
            violations.append(f"{label}raw DuckDB WASM file: {path}")
    if len(files) > MAX_FILES:
        violations.append(f"{label}{len(files)} files, above the Pages limit {MAX_FILES}")
    return violations


def _catalog_entry(dist: Path, files: list[str]) -> tuple[dict, list[str]]:
    """The manifest's catalog section: the one catalog, each listed asset present with its bytes and checksum."""
    manifests = [path for path in files if path.startswith("assets/catalog/") and path.endswith("/manifest.json")
                 and len(PurePosixPath(path).parts) == 4]
    if len(manifests) != 1:
        return {}, [f"the build holds {len(manifests)} catalogs at assets/catalog/<id>/manifest.json, expected 1"]
    manifest_path = manifests[0]
    base = str(PurePosixPath(manifest_path).parent)
    try:
        catalog = json.loads((dist / manifest_path).read_text(encoding="utf-8"))
        groups = catalog["assets"]
        entries = [entry for group in groups.values() for entry in (group.values() if isinstance(group, dict) else group)]
        listed = [(f"{base}/{entry['path']}", entry["bytes"], entry["sha256"]) for entry in entries]
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        return {}, [f"{manifest_path} is unreadable: {error}"]
    violations = []
    for path, size, digest in listed:
        target = dist / path
        if path not in files:
            violations.append(f"catalog asset missing: {path}")
        elif target.stat().st_size != size or sha256_file(target) != digest:
            violations.append(f"catalog asset differs from its manifest: {path}")
    return {
        "manifestPath": manifest_path,
        "assetFormat": catalog.get("asset_format"),
        "supportedFilters": [entry.get("key") for entry in catalog.get("supported_filters", [])],
        "files": [path for path, _, _ in listed],
    }, violations


def _html_violations(dist: Path, files: list[str]) -> list[str]:
    """Root base only: every local absolute src or href in the HTML names a file of this build."""
    present = set(files)
    violations = []
    for html in (path for path in files if path.endswith(".html")):
        for reference in HTML_REFERENCE_RE.findall((dist / html).read_text(encoding="utf-8")):
            if reference.split("?")[0].split("#")[0].lstrip("/") not in present:
                violations.append(f"{html} references {reference}, no file of this build at the root base")
    return violations


def build_violations(dist: Path) -> tuple[list[str], list[str]]:
    """The build's files and every reason it cannot be packaged."""
    if not dist.is_dir():
        return [], [f"no Web build at {dist}: run npm run build:web"]
    files, violations = files_under(dist)
    if not files:
        return [], violations + [f"the Web build at {dist} is empty"]
    if BUILT_INDEX_NAME not in files:
        violations.append(f"{BUILT_INDEX_NAME} is missing from the build")
    violations.extend(f"the build already holds {name}, which the packager writes" for name in (INDEX_NAME, MANIFEST_NAME)
                      if name in files)
    violations.extend(limit_violations(dist, files))
    if len(files) + 1 > MAX_FILES:
        violations.append(f"{len(files)} files and the manifest, above the Pages limit {MAX_FILES}")
    violations.extend(_html_violations(dist, files))
    return files, violations


def _write_tar_gz(entries: list[tuple[str, Path | bytes]], handle) -> None:
    with gzip.GzipFile(filename="", mode="wb", fileobj=handle, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            for name, source in entries:
                data = source if isinstance(source, bytes) else source.read_bytes()
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(data), 0o644, 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                tar.addfile(info, io.BytesIO(data))


def package(dist: Path, output_dir: Path, *, version: str, commit: str) -> Path:
    """Package a root Web build as `archive_name(version, commit)` in `output_dir`; same input, same bytes.

    The archive appears whole or not at all: it is written beside its final name and renamed."""
    name = archive_name(version, commit)
    files, violations = build_violations(dist)
    catalog, catalog_violations = _catalog_entry(dist, files) if files else ({}, [])
    violations.extend(catalog_violations)
    if violations:
        raise ReleaseError(violations)
    served = sorted((INDEX_NAME if path == BUILT_INDEX_NAME else path, dist / path) for path in files)
    manifest = {
        "name": EDITION_NAME,
        "version": version,
        "commit": commit[:12],
        "catalog": catalog,
        "files": [{"path": path, "bytes": source.stat().st_size, "sha256": sha256_file(source)} for path, source in served],
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    entries: list[tuple[str, Path | bytes]] = sorted([*served, (MANIFEST_NAME, manifest_bytes)], key=lambda item: item[0])
    output_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(dir=output_dir, prefix=f".{name}.", suffix=".partial", delete=False)
    try:
        with handle:
            _write_tar_gz(entries, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, 0o644)
        os.replace(handle.name, output_dir / name)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise
    return output_dir / name
