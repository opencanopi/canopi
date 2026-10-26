#!/usr/bin/env python3
"""Web Edition release tooling: the Web catalog asset, archive admission, the N-1 merge and live HTTP checks.

The one owner of the Web deployment rules (ADR 0029 Static Web serving): this release's names, the
Pages limits on the merged set, the cache headers and the collision rule.
The archive's name, limits and packager live in `web_release_package.py`, which this CLI imports.
Callers: `publish-db-release.sh` (catalog-asset-name, pack-catalog), the Release Candidate
workflow (catalog-asset-name, unpack-catalog, package, verify; from `main`'s checkout with the
ref's paths as arguments, 2.1-M216), build.yml (package), `promote-release.sh` (archive-name) and
`publish-web-release.sh` (archive-name, verify, previous, verify-previous, merge, deploy-files,
production-current, wait-for, http-check, check-tls). Archives are untrusted input: run this module
with `python3 -I`; extraction writes only regular files and directories below a fresh directory.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
import time
from typing import Any, Callable
import urllib.error
import urllib.request

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.web_release_package import (  # noqa: E402
    ARCHIVE_RE, INDEX_NAME, MANIFEST_NAME, NOTICES_NAME, ReleaseError, archive_glob, archive_name,
    files_under as _files_under, limit_violations, manifest_field_violations, package, sha256_file)

SERVICE_WORKER_NAME = "sw.js"
CATALOG_MANIFEST = "manifest.json"
GOOGLE_KEY_RE = re.compile(rb"AIza[0-9A-Za-z_-]{20,}")
CHECKSUM_LINE_RE = re.compile(r"([0-9a-f]{64})  ([^\s/]+)")
# Pages reads these names as configuration, so the artifact may never carry them;
# `add_deploy_files` writes the release's own.
DEPLOY_OWNED = ("_headers", "_redirects", "_routes.json", "_worker.js", "404.html")
# The fixed names a release rewrites (2.1-M25, 2.1-M34): two merged releases may differ on these, and
# they are this release's only files outside `assets/`. `sw.js` arrives with W1.
FIXED_NAMES = (INDEX_NAME, MANIFEST_NAME, NOTICES_NAME, SERVICE_WORKER_NAME)
# Every other file this release writes carries a content id under assets/ (2.1-M176): a Vite hash
# (`name-AbCd1234.ext`) or a directory named by 16 hex of a manifest's SHA-256 (`assets/catalog/<id>/`).
ASSETS_DIR = "assets"
CATALOG_ROOT = "assets/catalog/"
# The Web build names every chunk and asset `<name>-<16-character hash>.<ext>` (vite.config.ts `WEB_HASHED_NAMES`);
# Vite's default 8 would let words such as `NotoSans-SemiBold.ttf` pass as hashed.
VITE_HASH_RE = re.compile(r"^.+-[A-Za-z0-9_-]{16}\.[A-Za-z0-9]+$")
CONTENT_ID_RE = re.compile(r"[0-9a-f]{16}")
IMMUTABLE = "public, max-age=31536000, immutable"
CONTENT_TYPES = {
    ".js": "javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".parquet": "application/octet-stream",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".svg": "image/svg",
}
CLIENT_ROUTES = ("/", "/designs", "/a/b/c")
# Pages' default for HTML (2.1-M178): the shell is revalidated on every load.
REVALIDATING_ROUTES = ("/", "/designs")
# The range reads the zone Cache Rule `Canopi Web catalog Parquet ranges` answers (2.1-Q183).
PARQUET_RANGES = ("bytes=0-99", "bytes=-8")
MODULE_SCRIPT_RE = re.compile(r'<script type="module"[^>]*\ssrc="([^"]+)"')
USER_AGENT = "canopi-web-release-check/1"


# ---------------------------------------------------------------- safe archives


def _safe_member_path(name: str) -> PurePosixPath | None:
    path = PurePosixPath(name)
    parts = [part for part in path.parts if part != "."]
    if (not parts or path.is_absolute() or ".." in parts or "\\" in name
            or any(ord(char) < 32 for char in name)):
        return None
    return PurePosixPath(*parts)


def safe_extract(archive: Path, destination: Path) -> list[str]:
    """Extract regular files and directories only; return the extracted file paths."""
    if destination.exists() and any(destination.iterdir()):
        raise ReleaseError(f"extraction directory is not empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    files: list[str] = []
    seen: set[str] = set()
    violations: list[str] = []
    try:
        with tarfile.open(archive, mode="r:gz") as tar:
            members = tar.getmembers()
            for member in members:
                relative = _safe_member_path(member.name)
                if relative is None:
                    violations.append(f"unsafe archive path: {member.name!r}")
                elif not (member.isfile() or member.isdir()):
                    violations.append(f"archive entry is not a regular file or directory: {member.name!r}")
                elif member.isfile() and str(relative) in seen:
                    violations.append(f"duplicate archive entry: {member.name!r}")
                elif member.isfile():
                    seen.add(str(relative))
            if violations:
                raise ReleaseError(violations)
            for member in members:
                relative = _safe_member_path(member.name)
                assert relative is not None
                target = root.joinpath(*relative.parts)
                if not target.resolve().is_relative_to(root):
                    raise ReleaseError(f"unsafe archive path: {member.name!r}")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                assert source is not None
                with source, open(target, "xb") as out:
                    while chunk := source.read(1024 * 1024):
                        out.write(chunk)
                files.append(str(relative))
    except (tarfile.TarError, EOFError, gzip.BadGzipFile, OSError) as error:
        if isinstance(error, ReleaseError):
            raise
        raise ReleaseError(f"cannot read archive {archive.name}: {error}") from error
    return sorted(files)


def deterministic_tar_gz(source_dir: Path, output: Path) -> None:
    """Write source_dir's files as a tar.gz whose bytes depend on content and paths only."""
    files = sorted(
        str(path.relative_to(source_dir).as_posix())
        for path in source_dir.rglob("*")
        if path.is_file()
    )
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for relative in files:
            data = (source_dir / relative).read_bytes()
            info = tarfile.TarInfo(relative)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    with open(output, "xb") as out:
        with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=9) as gz:
            gz.write(raw.getvalue())


# ---------------------------------------------------------------- Web catalog asset


def web_catalog_asset_name(root: Path = REPO_ROOT) -> str:
    """The catalog's identity: artifact contract, storage contract and source export."""
    from scripts import species_catalog_contract as storage
    from scripts import web_catalog_artifact_contract as artifact

    plan = artifact.compile_web_catalog_artifact(root=root)
    release = storage.project(storage.ProjectionTarget.RELEASE, root=root)
    web = storage.project(storage.ProjectionTarget.WEB_CATALOG, root=root)
    return (
        f"canopi-web-catalog-v{plan.version}-{plan.fingerprint}-"
        f"{web.fingerprint}-{release.source_export_sha256}.tar.gz"
    )


def _catalog_asset_paths(manifest: dict[str, Any]) -> list[str]:
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        raise ReleaseError("catalog manifest has no assets")
    entries: list[Any] = []
    for value in assets.values():
        entries.extend(value.values() if isinstance(value, dict) else value)
    paths = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ReleaseError("catalog manifest has a malformed asset entry")
        paths.append(entry["path"])
    return paths


def verify_catalog_dir(catalog_dir: Path, root: Path = REPO_ROOT) -> dict[str, Any]:
    """Admit a generated catalog for this checkout's contracts, byte for byte."""
    from scripts import species_catalog_contract as storage
    from scripts import web_catalog_artifact_contract as artifact

    plan = artifact.compile_web_catalog_artifact(root=root)
    web = storage.project(storage.ProjectionTarget.WEB_CATALOG, root=root)
    files, violations = _files_under(catalog_dir)
    try:
        manifest = json.loads((catalog_dir / CATALOG_MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"catalog manifest is unreadable: {error}") from error
    if manifest.get("generated_by") != plan.generated_by:
        violations.append(f"catalog generated_by is {manifest.get('generated_by')!r}, expected {plan.generated_by!r}")
    if manifest.get("artifact_contract_fingerprint") != plan.fingerprint:
        violations.append("catalog artifact contract fingerprint does not match this checkout")
    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    if source.get("storage_contract_fingerprint") != web.fingerprint:
        violations.append("catalog storage contract fingerprint does not match this checkout")
    listed = set()
    entries = []
    for value in (manifest.get("assets") or {}).values():
        entries.extend(value.values() if isinstance(value, dict) else value)
    for entry in entries:
        path = entry.get("path") if isinstance(entry, dict) else None
        relative = _safe_member_path(path) if isinstance(path, str) else None
        if relative is None:
            violations.append(f"unsafe catalog asset path: {path!r}")
            continue
        listed.add(str(relative))
        target = catalog_dir / str(relative)
        if not target.is_file() or target.is_symlink():
            violations.append(f"catalog asset missing: {relative}")
            continue
        if target.stat().st_size != entry.get("bytes"):
            violations.append(f"catalog asset byte count differs: {relative}")
        elif sha256_file(target) != entry.get("sha256"):
            violations.append(f"catalog asset checksum differs: {relative}")
    if not listed:
        violations.append("catalog manifest lists no assets")
    unlisted = sorted(set(files) - listed - {CATALOG_MANIFEST})
    violations.extend(f"unlisted catalog file: {path}" for path in unlisted)
    if violations:
        raise ReleaseError(violations)
    return manifest


def pack_catalog(catalog_dir: Path, output: Path) -> None:
    verify_catalog_dir(catalog_dir)
    deterministic_tar_gz(catalog_dir, output)


def unpack_catalog(archive: Path, output_dir: Path, root: Path = REPO_ROOT) -> dict[str, Any]:
    safe_extract(archive, output_dir)
    return verify_catalog_dir(output_dir, root)


# ---------------------------------------------------------------- Web Edition archive


@dataclass(frozen=True)
class Identity:
    version: str
    commit: str
    files: int


def _verify_checksum(archive: Path, checksums: Path) -> None:
    expected = None
    for line in checksums.read_text(encoding="utf-8").splitlines():
        match = CHECKSUM_LINE_RE.fullmatch(line)
        if not match:
            raise ReleaseError(f"malformed checksum line in {checksums.name}: {line!r}")
        if match.group(2) == archive.name:
            if expected is not None:
                raise ReleaseError(f"{checksums.name} lists {archive.name} twice")
            expected = match.group(1)
    if expected is None:
        raise ReleaseError(f"{checksums.name} does not list {archive.name}")
    actual = sha256_file(archive)
    if actual != expected:
        raise ReleaseError(f"checksum mismatch for {archive.name}: expected {expected}, found {actual}")


def _read_manifest(site: Path) -> dict[str, Any]:
    try:
        manifest = json.loads((site / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"{MANIFEST_NAME} is unreadable: {error}") from error
    if not isinstance(manifest, dict):
        raise ReleaseError(f"{MANIFEST_NAME} is not an object")
    return manifest


def _deploy_owned(path: str) -> bool:
    name = PurePosixPath(path).name
    return path in DEPLOY_OWNED or (name in DEPLOY_OWNED and name != "404.html")


def _listed_files(site: Path, manifest: dict[str, Any], *, version: str) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """A release's own manifest against its files: identity, safe paths, bytes and checksums, nothing unlisted."""
    violations: list[str] = []
    if manifest.get("version") != version:
        violations.append(f"manifest version is {manifest.get('version')!r}, expected {version!r}")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ReleaseError(violations + ["manifest lists no files"])
    present, entry_violations = _files_under(site)
    violations.extend(entry_violations)
    listed: dict[str, dict[str, Any]] = {}
    for entry in entries:
        path = entry.get("path") if isinstance(entry, dict) else None
        relative = _safe_member_path(path) if isinstance(path, str) else None
        if relative is None or str(relative) != path:
            violations.append(f"unsafe manifest path: {path!r}")
        elif path in listed:
            violations.append(f"manifest lists {path} twice")
        else:
            listed[path] = entry
    for path in sorted(set(present) - set(listed) - {MANIFEST_NAME}):
        violations.append(f"unlisted file: {path}")
    for path, entry in listed.items():
        target = site / path
        if not target.is_file():
            violations.append(f"listed file missing: {path}")
            continue
        size = target.stat().st_size
        if size != entry.get("bytes"):
            violations.append(f"byte count differs for {path}: manifest {entry.get('bytes')}, actual {size}")
        elif sha256_file(target) != entry.get("sha256"):
            violations.append(f"checksum differs for {path}")
    violations.extend(f"deploy-owned file in the artifact: {path}" for path in present if _deploy_owned(path))
    return listed, violations


def catalog_id(manifest_bytes: bytes) -> str:
    """The content id of a catalog directory: the first 16 hex of its manifest.json's SHA-256 (2.1-M176)."""
    return hashlib.sha256(manifest_bytes).hexdigest()[:16]


def name_violations(site: Path, files: list[str]) -> list[str]:
    """This release's names: a content id under assets/ for every file but the fixed names (2.1-M176).

    Only this release's files are checked; carried N-1 files keep the names that release gave them."""
    violations = []
    checked_ids: dict[str, bool] = {}
    for path in files:
        if path in FIXED_NAMES or _deploy_owned(path):
            continue
        parts = PurePosixPath(path).parts
        hashed = len(parts) == 2 and VITE_HASH_RE.fullmatch(parts[1])
        # A content-id directory only where the id is verified: the catalog's.
        catalog = path.startswith(CATALOG_ROOT) and len(parts) > 3 and CONTENT_ID_RE.fullmatch(parts[2])
        if parts[0] != ASSETS_DIR or not (hashed or catalog):
            violations.append(f"mutable name: {path} (this release's files carry a content id under assets/)")
            continue
        if catalog:
            identifier = parts[2]
            if identifier not in checked_ids:
                manifest = site / CATALOG_ROOT / identifier / CATALOG_MANIFEST
                checked_ids[identifier] = manifest.is_file() and catalog_id(manifest.read_bytes()) == identifier
                if not checked_ids[identifier]:
                    violations.append(f"catalog id {identifier} is not the hash of its manifest")
    return violations


def verify_web_edition(site: Path, *, version: str, commit: str | None = None) -> Identity:
    """Check this release, extracted, against its own manifest, its naming rule and the hosting limits."""
    manifest = _read_manifest(site)
    listed, violations = _listed_files(site, manifest, version=version)
    short = manifest.get("commit")
    # The packager records 12 characters.
    if not isinstance(short, str) or not re.fullmatch(r"[0-9a-f]{12}", short):
        violations.append(f"manifest commit {short!r} is not a commit")
    elif commit is not None and not commit.startswith(short):
        violations.append(f"manifest commit {short} is not the release commit {commit}")
    violations.extend(manifest_field_violations(manifest))
    present, _ = _files_under(site)
    violations.extend(limit_violations(site, present))
    violations.extend(name_violations(site, present))
    for path in present:
        if GOOGLE_KEY_RE.search((site / path).read_bytes()):
            violations.append(f"Google Maps key found in {path}")
    if INDEX_NAME not in present:
        violations.append("index.html is missing")
    violations.extend(_catalog_violations(site, manifest, present))
    if violations:
        raise ReleaseError(violations)
    return Identity(version=version, commit=short, files=len(present))


def _catalog_violations(site: Path, manifest: dict[str, Any], present: list[str]) -> list[str]:
    catalog = manifest.get("catalog") if isinstance(manifest.get("catalog"), dict) else {}
    catalog_manifest = catalog.get("manifestPath")
    if not isinstance(catalog_manifest, str) or catalog_manifest not in present:
        return [f"catalog manifest {catalog_manifest!r} is missing"]
    violations = []
    base = str(PurePosixPath(catalog_manifest).parent)
    try:
        catalog_files = {f"{base}/{path}" for path in _catalog_asset_paths(
            json.loads((site / catalog_manifest).read_text(encoding="utf-8")))}
    except (json.JSONDecodeError, ReleaseError) as error:
        violations.append(f"{catalog_manifest} is unreadable: {error}")
        catalog_files = set()
    for path in sorted(catalog_files | set(catalog.get("files", []))):
        if path not in present:
            violations.append(f"catalog asset missing: {path}")
    if not catalog_files:
        violations.append("catalog lists no assets")
    return violations


def verify_archive(
    archive: Path,
    *,
    version: str,
    output_dir: Path,
    commit: str | None = None,
    checksums: Path | None = None,
) -> Identity:
    match = _archive_name_match(archive, version)
    if checksums is not None:
        _verify_checksum(archive, checksums)
    safe_extract(archive, output_dir)
    identity = verify_web_edition(output_dir, version=version, commit=commit)
    if identity.commit[:12] != match.group(2):
        raise ReleaseError(f"archive name commit {match.group(2)} differs from manifest commit {identity.commit}")
    return identity


def _archive_name_match(archive: Path, version: str) -> re.Match[str]:
    match = ARCHIVE_RE.fullmatch(archive.name)
    if not match or match.group(1) != version:
        raise ReleaseError(f"{archive.name} is not the root Web Edition archive of {version}")
    return match


# ---------------------------------------------------------------- the previous release (N-1)


def _stable_version(tag: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))) if match else None


def _gh(args: list[str]) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def find_previous(version: str, *, repo: str, run_gh: Callable[[list[str]], str] = _gh) -> str | None:
    """The greatest published stable release below `version` that carries a root Web archive (2.1-M177)."""
    current = _stable_version(f"v{version}")
    listing = json.loads(run_gh(["release", "list", "--repo", repo, "--exclude-drafts", "--exclude-pre-releases",
                                 "--limit", "200", "--json", "tagName"]))
    candidates = sorted(
        ((parsed, entry["tagName"]) for entry in listing
         if (parsed := _stable_version(entry.get("tagName", ""))) is not None
         and (current is None or parsed < current)),
        reverse=True)
    for parsed, tag in candidates:
        names = run_gh(["release", "view", tag, "--repo", repo, "--json", "assets", "--jq", ".assets[].name"]).split()
        if any((match := ARCHIVE_RE.fullmatch(name)) and match.group(1) == tag[1:] for name in names):
            return tag
    return None


def serving_version(base_url: str, get: Callable[..., Response]) -> str | None:
    """The release a deployment serves, or None when it serves no manifest (a first release)."""
    response = get(base_url.rstrip("/") + "/" + MANIFEST_NAME)
    if response.status == 404:
        return None
    if response.status != 200:
        raise ReleaseError(f"{base_url}/{MANIFEST_NAME}: status {response.status}")
    try:
        version = json.loads(response.body).get("version")
    except (json.JSONDecodeError, AttributeError) as error:
        raise ReleaseError(f"{base_url}/{MANIFEST_NAME} is unreadable: {error}") from error
    if not isinstance(version, str):
        raise ReleaseError(f"{base_url}/{MANIFEST_NAME} names no version")
    return version


def previous_release(
    version: str,
    *,
    repo: str,
    production_url: str,
    previous_tag: str | None = None,
    no_previous: bool = False,
    get: Callable[..., Response] | None = None,
    run_gh: Callable[[list[str]], str] = _gh,
) -> str | None:
    """N-1's tag, checked against what production serves; None only for --no-previous on an empty production."""
    serving = serving_version(production_url, get or fetch)
    if no_previous:
        if previous_tag:
            raise ReleaseError("--no-previous and --previous-tag exclude each other")
        if serving is not None:
            raise ReleaseError(f"--no-previous is refused: {production_url} serves {serving}, whose open tabs "
                               "would lose their files")
        return None
    tag = previous_tag or find_previous(version, repo=repo, run_gh=run_gh)
    if tag is None:
        raise ReleaseError(f"no published stable release below {version} carries a Web archive; pass "
                           "--no-previous only when production serves no manifest")
    if _stable_version(tag) is None:
        raise ReleaseError(f"--previous-tag {tag} is not a stable release tag such as v2.0.2")
    if serving not in (tag[1:], version):
        raise ReleaseError(f"{production_url} serves {serving or 'no manifest'}, neither N-1 {tag[1:]} nor N "
                           f"{version}; pass --previous-tag v<the release production serves>, whose tabs are open")
    return tag


def verify_previous(archive: Path, *, version: str, checksums: Path, output_dir: Path) -> Identity:
    """Admit N-1 by its published checksum, its own manifest and the Pages limits, never by this release's layout
    rules or any limits its manifest declares."""
    match = _archive_name_match(archive, version)
    _verify_checksum(archive, checksums)
    safe_extract(archive, output_dir)
    manifest = _read_manifest(output_dir)
    _, violations = _listed_files(output_dir, manifest, version=version)
    if manifest.get("commit") is None or not str(manifest.get("commit")).startswith(match.group(2)):
        violations.append(f"manifest commit {manifest.get('commit')!r} differs from the archive name's {match.group(2)}")
    violations.extend(limit_violations(output_dir, _files_under(output_dir)[0]))
    if violations:
        raise ReleaseError(violations)
    return Identity(version=version, commit=match.group(2), files=len(manifest["files"]) + 1)


@dataclass(frozen=True)
class Merge:
    previous: str
    carried: list[str]
    replaced: list[str]


def merge_previous(site: Path, previous_site: Path) -> Merge:
    """Copy every file N-1's manifest names into this release's site; N wins a shared path (2.1-M25, M34).

    A differing shared path outside the fixed names and deploy-owned files fails the release before any file
    is copied. N-2-only files never arrive: N-1's archive holds only what N-1's manifest names."""
    manifest = _read_manifest(previous_site)
    carried, replaced, violations = [], [], []
    for entry in manifest["files"]:
        path = entry["path"]
        target = site / path
        if not path.startswith(f"{ASSETS_DIR}/") and path not in FIXED_NAMES:
            violations.append(f"{manifest.get('version')} names {path}, outside {ASSETS_DIR}/ and the fixed names")
        elif not target.exists():
            carried.append(path)
        elif sha256_file(target) == entry["sha256"]:
            continue
        elif path in FIXED_NAMES or _deploy_owned(path):
            replaced.append(path)
        else:
            violations.append(f"differing collision on {path}: this release {sha256_file(target)}, "
                              f"{manifest.get('version')} {entry['sha256']}")
    if violations:
        raise ReleaseError(violations)
    for path in carried:
        (site / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(previous_site / path, site / path)
    check_merged(site)
    return Merge(previous=str(manifest.get("version")), carried=carried, replaced=replaced)


def check_merged(site: Path) -> None:
    """The Pages limits on the set a deploy uploads, carried files included."""
    files, violations = _files_under(site)
    violations.extend(limit_violations(site, files, label="merged set: "))
    if violations:
        raise ReleaseError(violations)


# The PDF export's lazy chunk (`import('./job')` in app/canvas-pdf/live.ts), which the deploy-skew spec drives: the
# entry name and its 16-character hash, so another lazy module named job-... never counts.
PDF_JOB_CHUNK_RE = re.compile(r"assets/job-[A-Za-z0-9_-]{16}\.js")


def skew_chunks(site: Path, previous_site: Path, *, allow_none: bool = False) -> list[str]:
    """N-1's PDF job chunks that N's own files lack: what the deploy-skew spec proves still loads (2.1-Q83).

    Checked before any deploy, so a release whose PDF chunk is unchanged fails here, not after two preview deploys.
    `allow_none` (the operator's --allow-unchanged-pdf-chunk) waives only this proof: the tab still runs."""
    own = {entry["path"] for entry in _read_manifest(site)["files"]}
    previous = sorted(entry["path"] for entry in _read_manifest(previous_site)["files"]
                      if PDF_JOB_CHUNK_RE.fullmatch(entry["path"]))
    if not previous:
        # Not an unchanged chunk: the pattern no longer matches N-1's build, so no override applies.
        raise ReleaseError("the deploy-skew check cannot run: N-1 lists no assets/job-<hash>.js; PDF_JOB_CHUNK_RE "
                           "no longer matches its build")
    carried = [path for path in previous if path not in own]
    if not carried and not allow_none:
        raise ReleaseError(
            f"the deploy-skew check would prove nothing: N-1's PDF job chunk ({', '.join(previous)}) is "
            "also this release's; pass --allow-unchanged-pdf-chunk to run the stage without that proof")
    return carried


# ---------------------------------------------------------------- headers and deploy files


def cache_policy(path: str) -> str:
    """How a served path is cached: `immutable` (content-named), `no-cache` or Pages' HTML `revalidate`."""
    if path == INDEX_NAME:
        return "revalidate"
    if path.startswith(f"{ASSETS_DIR}/"):
        return "immutable"
    # The other fixed names: the manifest, the notices and sw.js (W1).
    return "no-cache"


def _top_level(files: list[str]) -> tuple[list[str], list[str]]:
    directories = sorted({PurePosixPath(path).parts[0] for path in files if len(PurePosixPath(path).parts) > 1})
    top_files = sorted(path for path in files if len(PurePosixPath(path).parts) == 1)
    return directories, top_files


def headers_file(files: list[str]) -> str:
    """`_headers` for one deployment's files: a rule only where a file matches it, and no /index.html rule
    (Pages redirects it to /, whose HTML Pages revalidates). Never a versioned prefix under a no-cache one:
    Pages joins two matching Cache-Control values."""
    directories, top_files = _top_level(files)
    rules = [f"/{path}\n  Cache-Control: no-cache\n" for path in top_files if cache_policy(path) == "no-cache"]
    for directory in directories:
        if cache_policy(f"{directory}/x") != "immutable":
            raise ReleaseError(f"{directory}/ is outside {ASSETS_DIR}/: every directory a deploy serves is content-named")
        rules.append(f"/{directory}/*\n  Cache-Control: {IMMUTABLE}\n")
    rules.append("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n")
    return "".join(rules)


def add_deploy_files(site: Path) -> None:
    """Write the deploy-owned files for the set in `site`: `_headers` and an empty `404.html` per directory,
    so a missing file there is a 404 (Pages uses the nearest one) while client routes fall back to the shell."""
    files, _ = _files_under(site)
    for path in files:
        if _deploy_owned(path) or PurePosixPath(path).name == "404.html":
            raise ReleaseError(f"deploy-owned file already present: {path}")
    (site / "_headers").write_text(headers_file(files), encoding="utf-8")
    for directory in _top_level(files)[0]:
        (site / directory / "404.html").write_bytes(b"")


# ---------------------------------------------------------------- live checks


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: bytes

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")


def fetch(url: str, headers: dict[str, str] | None = None, timeout: float = 60) -> Response:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, response_headers, body = response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        status, response_headers, body = error.code, error.headers, error.read()
    # HTTP header names are case-insensitive; keep one lowercase spelling.
    return Response(status, {key.lower(): value for key, value in response_headers.items()}, body)


def _smallest_by_suffix(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One sampled file per served extension, the smallest, so a check never pulls a whole large shard."""
    samples: dict[str, dict[str, Any]] = {}
    for entry in sorted(entries, key=lambda item: (item["bytes"], item["path"])):
        suffix = PurePosixPath(entry["path"]).suffix
        if suffix in CONTENT_TYPES and suffix not in samples:
            samples[suffix] = entry
    return list(samples.values())


def no_cache_violation(cache_control: str) -> str | None:
    """Why a Cache-Control value does not make a fixed-name file revalidate on every load, or None."""
    cache = cache_control.lower()
    if "no-cache" not in cache:
        return "is not no-cache"
    if "immutable" in cache:
        return "is immutable"
    ages = [int(age) for age in re.findall(r"(?:^|[ ,])(?:s-)?max-age=(\d+)", cache)]
    if any(age > 0 for age in ages):
        return "caches past max-age=0"
    return None


def carried_samples(site: Path, carried: list[str]) -> list[str]:
    """The smallest carried file in each carried top-level directory: one per header rule."""
    samples: dict[str, str] = {}
    for path in sorted(carried, key=lambda item: ((site / item).stat().st_size, item)):
        samples.setdefault(PurePosixPath(path).parts[0], path)
    return [samples[directory] for directory in sorted(samples)]


def carried_files(site: Path, manifest: dict[str, Any]) -> list[str]:
    """Files in a merged site that this release's manifest does not name: N-1's carried files."""
    own = {entry["path"] for entry in manifest["files"]} | {MANIFEST_NAME}
    files, _ = _files_under(site)
    return [path for path in files
            if path not in own and not _deploy_owned(path) and PurePosixPath(path).name != "404.html"]


def missing_paths(manifest: dict[str, Any]) -> list[str]:
    """One missing file per directory that must answer 404 rather than the SPA fallback."""
    paths = [f"/{ASSETS_DIR}/missing-0000.js"]
    catalog = (manifest.get("catalog") or {}).get("manifestPath")
    if isinstance(catalog, str):
        paths.append(f"/{PurePosixPath(catalog).parent}/missing.parquet")
    return paths


def http_check(
    base_url: str,
    site: Path,
    *,
    get: Callable[..., Response] = fetch,
) -> list[str]:
    """Check a live deployment of the merged `site`; return the checks that passed or raise."""
    base = base_url.rstrip("/")
    manifest_bytes = (site / MANIFEST_NAME).read_bytes()
    manifest = json.loads(manifest_bytes)
    index = (site / INDEX_NAME).read_text(encoding="utf-8")
    violations: list[str] = []
    passed: list[str] = []

    def check(url_path: str, response: Response) -> None:
        if "nosniff" not in response.header("X-Content-Type-Options").lower():
            violations.append(f"{url_path}: X-Content-Type-Options nosniff is missing")

    live = get(base + "/" + MANIFEST_NAME)
    check("/" + MANIFEST_NAME, live)
    if live.status != 200:
        violations.append(f"/{MANIFEST_NAME}: status {live.status}")
    else:
        try:
            live_manifest = json.loads(live.body)
        except json.JSONDecodeError:
            live_manifest = {}
        if (live_manifest.get("version"), live_manifest.get("commit")) != (manifest["version"], manifest["commit"]):
            violations.append(
                f"/{MANIFEST_NAME}: serves {live_manifest.get('version')} {live_manifest.get('commit')}, "
                f"expected {manifest['version']} {manifest['commit']}")
        elif live.body != manifest_bytes:
            violations.append(f"/{MANIFEST_NAME}: bytes differ from the release manifest")
        reason = no_cache_violation(live.header("Cache-Control"))
        if reason:
            violations.append(f"/{MANIFEST_NAME}: Cache-Control {live.header('Cache-Control')!r} {reason}")
    passed.append("manifest identity and no-cache")

    expected_script = MODULE_SCRIPT_RE.search(index)
    shell: dict[str, Response] = {}
    for route in CLIENT_ROUTES:
        response = shell[route] = get(base + route)
        check(route, response)
        text = response.body.decode("utf-8", "replace")
        if response.status != 200 or "<title>Canopi</title>" not in text:
            violations.append(f"{route}: status {response.status}, Canopi title {'<title>Canopi</title>' in text}")
            continue
        if "text/html" not in response.header("Content-Type"):
            violations.append(f"{route}: Content-Type {response.header('Content-Type')!r}")
        # Checks run on custom domains only (*.pages.dev answers no range), where Cloudflare injects a hidden link
        # and a script into HTML, so HTML is compared by the module entry, not byte for byte.
        live_script = MODULE_SCRIPT_RE.search(text)
        if expected_script is None or live_script is None or live_script.group(1) != expected_script.group(1):
            violations.append(f"{route}: module script differs from the release index.html")
    passed.append("app shell on " + ", ".join(CLIENT_ROUTES))
    if "strict-origin-when-cross-origin" not in shell["/"].header("Referrer-Policy").lower():
        violations.append("/: Referrer-Policy strict-origin-when-cross-origin is missing")
    for route in REVALIDATING_ROUTES:
        cache = shell[route].header("Cache-Control").lower()
        if "no-cache" not in cache and not ("max-age=0" in cache and "must-revalidate" in cache):
            violations.append(f"{route}: Cache-Control {cache!r} does not revalidate the shell")
    passed.append("the shell revalidates on " + ", ".join(REVALIDATING_ROUTES))

    for entry in _smallest_by_suffix(manifest["files"]):
        url_path = "/" + entry["path"]
        response = get(base + url_path)
        check(url_path, response)
        suffix = PurePosixPath(entry["path"]).suffix
        if response.status != 200:
            violations.append(f"{url_path}: status {response.status}")
            continue
        if hashlib.sha256(response.body).hexdigest() != entry["sha256"]:
            violations.append(f"{url_path}: bytes differ from the release")
        if CONTENT_TYPES[suffix] not in response.header("Content-Type").lower():
            violations.append(f"{url_path}: Content-Type {response.header('Content-Type')!r}, expected {CONTENT_TYPES[suffix]}")
        if cache_policy(entry["path"]) == "immutable" and "immutable" not in response.header("Cache-Control"):
            violations.append(f"{url_path}: Cache-Control {response.header('Cache-Control')!r} is not immutable")
    passed.append("sample assets by extension")

    parquet = [entry for entry in manifest["files"]
               if entry["path"].startswith(CATALOG_ROOT) and entry["path"].endswith(".parquet")]
    if parquet:
        smallest = min(parquet, key=lambda item: (item["bytes"], item["path"]))
        violations.extend(_range_violations(base, site, smallest["path"], get))
        passed.append("catalog Parquet ranges answer 206")
    else:
        violations.append("the release names no assets/catalog/**.parquet to check ranges on")

    carried = carried_files(site, manifest)
    for sample in carried_samples(site, carried):
        url_path = "/" + sample
        response = get(base + url_path)
        check(url_path, response)
        if response.status != 200 or response.body != (site / sample).read_bytes():
            violations.append(f"carried file {url_path}: bytes differ from the previous release (status {response.status})")
        cache = response.header("Cache-Control")
        if "immutable" not in cache.lower():
            violations.append(f"carried file {url_path}: Cache-Control {cache!r}, expected immutable")
    if carried:
        passed.append(f"carried files from the previous release ({len(carried)})")

    for url_path in missing_paths(manifest):
        response = get(base + url_path)
        check(url_path, response)
        if response.status != 404:
            violations.append(f"{url_path}: status {response.status}, expected 404")
    passed.append("missing assets answer 404")
    if violations:
        raise ReleaseError(violations)
    return passed


def _range_violations(base: str, site: Path, path: str, get: Callable[..., Response]) -> list[str]:
    """206 with Content-Range for the reads DuckDB-WASM makes; Pages alone answers 200 with the whole file."""
    data = (site / path).read_bytes()
    size = len(data)
    violations = []
    for requested in PARQUET_RANGES:
        start, end = requested.removeprefix("bytes=").split("-")
        first, last = (size - int(end), size - 1) if start == "" else (int(start), min(int(end), size - 1))
        response = get(f"{base}/{path}", {"Range": requested})
        label = f"/{path}: Range {requested}"
        if response.status != 206:
            violations.append(f"{label} answered {response.status}, expected 206 (the zone Cache Rule "
                              "`Canopi Web catalog Parquet ranges`, docs/guides/editions.md)")
            continue
        if response.header("Content-Range") != f"bytes {first}-{last}/{size}":
            violations.append(f"{label}: Content-Range {response.header('Content-Range')!r}, expected bytes {first}-{last}/{size}")
        if response.body != data[first:last + 1]:
            violations.append(f"{label}: bytes differ from the release")
        if response.header("Content-Encoding") not in ("", "identity"):
            violations.append(f"{label}: Content-Encoding {response.header('Content-Encoding')!r}")
        if "immutable" not in response.header("Cache-Control"):
            violations.append(f"{label}: Cache-Control {response.header('Cache-Control')!r} is not immutable")
    return violations


def check_tls(host: str, port: int = 443, min_days: int = 14) -> str:
    context = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=30) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            certificate = tls.getpeercert()
            version = tls.version()
    expires = ssl.cert_time_to_seconds(certificate["notAfter"])
    days = (expires - time.time()) / 86400
    if days < min_days:
        raise ReleaseError(f"{host}: TLS certificate expires in {days:.0f} days")
    return f"{host}: {version}, certificate valid for {days:.0f} more days"


def live_matches(base_url: str, site: Path, get: Callable[[str], Response] = fetch) -> bool:
    response = get(base_url.rstrip("/") + "/" + MANIFEST_NAME)
    return response.status == 200 and response.body == (site / MANIFEST_NAME).read_bytes()


def production_current(base_url: str, site: Path, get: Callable[[str], Response] = fetch) -> bool:
    """Whether a deploy can be skipped: production serves this manifest and passes its checks."""
    if not live_matches(base_url, site, get):
        return False
    try:
        http_check(base_url, site, get=get)
    except ReleaseError:
        return False
    return True


def wait_for(base_url: str, site: Path, timeout: float, interval: float = 15,
             get: Callable[[str], Response] = fetch, sleep: Callable[[float], None] = time.sleep) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            if live_matches(base_url, site, get):
                return
        # A deploy in flight can drop or truncate a response (http.client.IncompleteRead).
        except (OSError, urllib.error.URLError, http.client.HTTPException):
            pass
        if time.monotonic() >= deadline:
            raise ReleaseError(f"{base_url} did not serve the release manifest within {timeout:.0f} s")
        sleep(interval)


# ---------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    root_help = "the checkout whose contracts apply (default: this script's)"
    sub.add_parser("catalog-asset-name", help="print the Web catalog release asset name").add_argument(
        "--root", type=Path, default=REPO_ROOT, help=root_help)
    pack = sub.add_parser("pack-catalog", help="verify a generated catalog and archive it deterministically")
    pack.add_argument("--catalog-dir", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    unpack = sub.add_parser("unpack-catalog", help="safely extract and verify a catalog archive")
    unpack.add_argument("--archive", type=Path, required=True)
    unpack.add_argument("--output-dir", type=Path, required=True)
    unpack.add_argument("--root", type=Path, default=REPO_ROOT, help=root_help)
    package_web = sub.add_parser("package", help="package a root Web build (dist-web) as the release's archive")
    package_web.add_argument("--dist", type=Path, required=True)
    package_web.add_argument("--output-dir", type=Path, required=True)
    name = sub.add_parser("archive-name", help="print the archive's name, or without --commit the pattern of all")
    for command in (package_web, name):
        command.add_argument("--version", required=True)
        command.add_argument("--commit", required=command is package_web)
    verify = sub.add_parser("verify", help="admit a root Web Edition archive")
    verify.add_argument("--archive", type=Path, required=True)
    verify.add_argument("--version", required=True)
    verify.add_argument("--commit")
    verify.add_argument("--checksums", type=Path)
    verify.add_argument("--output-dir", type=Path, required=True)
    previous = sub.add_parser("previous", help="print N-1's tag, checked against what production serves")
    previous.add_argument("--version", required=True)
    previous.add_argument("--repo", required=True)
    previous.add_argument("--production-url", required=True)
    previous.add_argument("--previous-tag")
    previous.add_argument("--no-previous", action="store_true")
    verify_n1 = sub.add_parser("verify-previous", help="admit N-1's archive by its checksums and its own manifest")
    verify_n1.add_argument("--archive", type=Path, required=True)
    verify_n1.add_argument("--version", required=True)
    verify_n1.add_argument("--checksums", type=Path, required=True)
    verify_n1.add_argument("--output-dir", type=Path, required=True)
    merge = sub.add_parser("merge", help="carry N-1's files into the site, check the merged set, add the deploy files")
    merge.add_argument("--site", type=Path, required=True)
    merge.add_argument("--previous-site", type=Path)
    skew = sub.add_parser("skew-check", help="print N-1's lazy chunks the deploy-skew spec loads, absent from N")
    skew.add_argument("--site", type=Path, required=True)
    skew.add_argument("--previous-site", type=Path, required=True)
    skew.add_argument("--allow-none", action="store_true", help="print nothing instead of failing when no chunk is carried")
    deploy_files = sub.add_parser("deploy-files", help="add the deploy files to a verified site")
    deploy_files.add_argument("--site", type=Path, required=True)
    for name in ("http-check", "production-current", "wait-for"):
        live = sub.add_parser(name)
        live.add_argument("--base-url", required=True)
        live.add_argument("--site", type=Path, required=True)
        if name == "wait-for":
            live.add_argument("--timeout", type=float, default=600)
    tls = sub.add_parser("check-tls")
    tls.add_argument("--host", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "catalog-asset-name":
            print(web_catalog_asset_name(args.root))
        elif args.command == "pack-catalog":
            pack_catalog(args.catalog_dir, args.output)
            print(f"Packed {args.output.name}")
        elif args.command == "unpack-catalog":
            manifest = unpack_catalog(args.archive, args.output_dir, args.root)
            print(f"Web catalog verified ({len(_catalog_asset_paths(manifest))} assets from {manifest['source']['export_file']})")
        elif args.command == "package":
            print(f"Packaged {package(args.dist, args.output_dir, version=args.version, commit=args.commit)}")
        elif args.command == "archive-name":
            print(archive_name(args.version, args.commit) if args.commit else archive_glob(args.version))
        elif args.command == "verify":
            identity = verify_archive(
                args.archive, version=args.version, commit=args.commit, checksums=args.checksums,
                output_dir=args.output_dir)
            print(f"Web Edition {identity.version} at {identity.commit} verified ({identity.files} files)")
        elif args.command == "previous":
            tag = previous_release(args.version, repo=args.repo, production_url=args.production_url,
                                   previous_tag=args.previous_tag, no_previous=args.no_previous)
            print(tag or "")
        elif args.command == "verify-previous":
            identity = verify_previous(args.archive, version=args.version, checksums=args.checksums,
                                       output_dir=args.output_dir)
            print(f"Previous Web Edition {identity.version} at {identity.commit} verified ({identity.files} files)")
        elif args.command == "merge":
            if args.previous_site is not None:
                merged = merge_previous(args.site, args.previous_site)
                print(f"Carried {len(merged.carried)} files from {merged.previous}; this release wins on "
                      f"{', '.join(merged.replaced) or 'no differing path'}")
                for path in merged.carried:
                    print(f"carried: {path}")
            else:
                check_merged(args.site)
                print("No previous release carried (--no-previous)")
            add_deploy_files(args.site)
        elif args.command == "skew-check":
            for path in skew_chunks(args.site, args.previous_site, allow_none=args.allow_none):
                print(path)
        elif args.command == "deploy-files":
            add_deploy_files(args.site)
        elif args.command == "http-check":
            for line in http_check(args.base_url, args.site):
                print(f"ok: {line}")
        elif args.command == "production-current":
            return 0 if production_current(args.base_url, args.site) else 3
        elif args.command == "wait-for":
            wait_for(args.base_url, args.site, args.timeout)
            print(f"{args.base_url} serves the release manifest")
        elif args.command == "check-tls":
            print(check_tls(args.host))
    except ReleaseError as error:
        print(f"ERROR: {args.command} failed:\n{error}", file=sys.stderr)
        return 1
    except (OSError, urllib.error.URLError, ssl.SSLError, http.client.HTTPException,
            subprocess.CalledProcessError) as error:
        print(f"ERROR: {args.command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
