"""Admit only manifest-listed release packages (desktop installers and the root Web Edition archive)."""

import argparse
import hashlib
from pathlib import Path, PurePosixPath
import re
import shutil
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from scripts.web_release_package import ARCHIVE_RE as WEB_ARCHIVE_RE  # noqa: E402


PACKAGE_SUFFIXES = {".deb", ".AppImage", ".dmg", ".msi", ".exe", ".tar.gz"}
# The candidate's `web` job uploads the root Web Edition archive; it keeps its
# versioned name and gets its own public checksum file for publish-web-release.sh.
WEB_ARTIFACT_ROOT = "canopi-web-edition"

# Artifact roots come from the Release Candidate target matrix. Public names
# are a website contract: changing a build filename must not change these URLs.
STABLE_PACKAGES = {
    ("canopi-x86_64-unknown-linux-gnu", ".deb"): "canopi-linux-x64.deb",
    ("canopi-x86_64-unknown-linux-gnu", ".AppImage"): "canopi-linux-x64.AppImage",
    ("canopi-aarch64-apple-darwin", ".dmg"): "canopi-macos-arm64.dmg",
    ("canopi-x86_64-apple-darwin", ".dmg"): "canopi-macos-x64.dmg",
    ("canopi-x86_64-pc-windows-msvc", ".exe"): "canopi-windows-x64.exe",
    ("canopi-x86_64-pc-windows-msvc", ".msi"): "canopi-windows-x64.msi",
}


def package_suffix(relative: PurePosixPath) -> str:
    return ".tar.gz" if relative.name.endswith(".tar.gz") else relative.suffix


def release_packages(manifest: Path, source_root: Path, release_root: Path,
                     version: str | None = None, commit: str | None = None):
    packages = manifest_packages(manifest)
    web = [(relative, digest) for relative, digest in packages if relative.parts[0] == WEB_ARTIFACT_ROOT]
    if len(web) != 1:
        raise ValueError("Missing required release packages: one canopi-web-edition root archive"
                         if not web else "Duplicate Web Edition archives in the candidate")
    web_match = WEB_ARCHIVE_RE.fullmatch(web[0][0].name)
    if (len(web[0][0].parts) != 2 or web_match is None
            or (version is not None and web_match.group(1) != version)
            or (commit is not None and not commit.startswith(web_match.group(2)))):
        raise ValueError(f"Web Edition archive does not name this release: {web[0][0]}")
    desktop = [(relative, digest) for relative, digest in packages if relative.parts[0] != WEB_ARTIFACT_ROOT]
    aliases = {}
    original_names = {relative.name for relative, _ in packages}
    for relative, _ in desktop:
        alias = STABLE_PACKAGES.get((relative.parts[0], package_suffix(relative)))
        if alias is None:
            raise ValueError(f"Unsupported release package target or format: {relative}")
        if alias in aliases or alias in original_names:
            raise ValueError(f"Duplicate or colliding stable release asset: {alias}")
        aliases[alias] = relative
    missing = set(STABLE_PACKAGES.values()) - aliases.keys()
    if missing:
        raise ValueError(f"Missing required release packages: {', '.join(sorted(missing))}")

    # Always snapshot before making public copies, including --artifact-dir.
    originals = verified_packages(manifest, source_root, release_root / "originals")
    public_root = release_root / "downloads"
    public_root.mkdir(parents=True)
    files = list(originals)
    checksums = []
    for (relative, digest), original in zip(packages, originals):
        if relative.parts[0] == WEB_ARTIFACT_ROOT:
            continue
        alias = STABLE_PACKAGES[(relative.parts[0], package_suffix(relative))]
        target = public_root / alias
        shutil.copyfile(original, target)
        files.append(target)
        checksums.extend([f"{digest}  {original.name}\n", f"{digest}  {alias}\n"])
    checksum_path = release_root / "RELEASE-SHA256SUMS.txt"
    checksum_path.write_text("".join(sorted(checksums)))
    web_checksum_path = release_root / "WEB-RELEASE-SHA256SUMS.txt"
    web_checksum_path.write_text(f"{web[0][1]}  {web[0][0].name}\n")
    return files + [checksum_path, web_checksum_path]


def manifest_packages(manifest: Path):
    packages = []
    names = set()
    for line in manifest.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *](.+)", line)
        if not match:
            raise ValueError("Invalid candidate checksum manifest entry")
        digest, name = match.groups()
        relative = PurePosixPath(name)
        if (relative.is_absolute() or ".." in relative.parts or "\\" in name or "#" in name
                or any(ord(char) < 32 for char in name)
                or package_suffix(relative) not in PACKAGE_SUFFIXES):
            raise ValueError(f"Invalid candidate package path: {name}")
        if relative.name in names:
            raise ValueError(f"Duplicate release asset name: {relative.name}")
        names.add(relative.name)
        packages.append((relative, digest.lower()))
    if not packages:
        raise ValueError("Candidate checksum manifest contains no packages")
    return packages


def verified_packages(manifest: Path, source_root: Path, stage_root: Path | None):
    source_root = source_root.resolve(strict=True)
    if not source_root.is_dir():
        raise ValueError("Candidate artifact directory is not a directory")
    verified = []
    for relative, expected in manifest_packages(manifest):
        source = source_root.joinpath(*relative.parts)
        if (not source.is_file() or source.is_symlink()
                or not source.resolve().is_relative_to(source_root)):
            raise ValueError(f"Missing or unsafe candidate package: {relative}")
        target = stage_root.joinpath(*relative.parts) if stage_root else source
        digest = hashlib.sha256()
        # A private snapshot prevents later edits to the caller's files from
        # changing the bytes uploaded after verification.
        with source.open("rb") as incoming:
            if stage_root:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        digest.update(chunk)
                        outgoing.write(chunk)
            else:
                while chunk := incoming.read(1024 * 1024):
                    digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError(f"Checksum mismatch for candidate package: {relative}")
        verified.append(target)
    return verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--stage-dir", type=Path)
    output.add_argument("--release-dir", type=Path,
                        help="Stage a complete release: desktop stable copies, the Web archive and public checksums")
    parser.add_argument("--release-version", help="With --release-dir: the version the Web archive must name")
    parser.add_argument("--commit", help="With --release-dir: the commit the Web archive must name")
    args = parser.parse_args()
    try:
        if args.release_dir:
            files = release_packages(args.manifest, args.source_dir, args.release_dir,
                                     args.release_version, args.commit)
        else:
            files = verified_packages(args.manifest, args.source_dir, args.stage_dir)
    except (OSError, ValueError) as error:
        parser.exit(1, f"ERROR: Cannot prepare candidate packages: {error}\n")
    for path in files:
        print(path)


if __name__ == "__main__":
    main()
