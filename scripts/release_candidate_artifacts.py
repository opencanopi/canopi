"""Admit only manifest-listed release packages (desktop installers, their updater signatures, the updater's channel
files and the root Web Edition archive)."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from scripts import update_channel  # noqa: E402
from scripts.web_release_package import ARCHIVE_RE as WEB_ARCHIVE_RE  # noqa: E402


PACKAGE_SUFFIXES = {".deb", ".AppImage", ".dmg", ".msi", ".exe", ".tar.gz", ".sig"}
# An MSI version takes no pre-release label, so a beta ships Windows as the NSIS installer only (2.1-M27, M55).
BETA_LEAVES_OUT = {"canopi-windows-x64.msi"}
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
                     version: str | None = None, commit: str | None = None,
                     channel_dir: Path | None = None, conf: Path | None = None):
    """With `channel_dir` (an updater candidate, 2.1-M27) every updater installer needs its .sig and the channel files
    there must verify against the staged installers under `conf`'s public key; a beta stages no Web archive (2.1-Q201)."""
    packages = manifest_packages(manifest)
    beta = version is not None and update_channel.channel_of(version) == "beta"
    signatures = [(relative, digest) for relative, digest in packages if relative.suffix == ".sig"]
    packages = [(relative, digest) for relative, digest in packages if relative.suffix != ".sig"]
    listed = {relative for relative, _ in packages}
    for relative, _ in signatures:
        signed = relative.with_name(relative.name.removesuffix(".sig"))
        if signed not in listed or (signed.parts[0], signed.suffix) not in update_channel.UPDATER_KEYS:
            raise ValueError(f"Unsupported release package target or format: {relative}")
    if channel_dir is not None:
        signed = {relative.with_name(relative.name.removesuffix(".sig")) for relative, _ in signatures}
        for relative in sorted(listed - signed):
            if (relative.parts[0], relative.suffix) in update_channel.UPDATER_KEYS:
                raise ValueError(f"unsigned updater artifact: {relative}")
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
    if beta and aliases.keys() & BETA_LEAVES_OUT:
        raise ValueError("a beta ships no MSI: an MSI version takes no pre-release label (2.1-M27)")
    missing = set(STABLE_PACKAGES.values()) - aliases.keys() - (BETA_LEAVES_OUT if beta else set())
    if missing:
        raise ValueError(f"Missing required release packages: {', '.join(sorted(missing))}")

    # Always snapshot before making public copies, including --artifact-dir.
    originals = verified_packages(manifest, source_root, release_root / "originals")
    public_root = release_root / "downloads"
    public_root.mkdir(parents=True)
    web_original = release_root / "originals" / Path(*web[0][0].parts)
    files = [path for path in originals if not (beta and path == web_original)]
    if channel_dir is not None:
        files.extend(channel_files(channel_dir, release_root, version, conf))
    checksums = []
    for (relative, digest), original in zip(manifest_packages(manifest), originals):
        if relative.parts[0] == WEB_ARTIFACT_ROOT or relative.suffix == ".sig":
            continue
        alias = STABLE_PACKAGES[(relative.parts[0], package_suffix(relative))]
        target = public_root / alias
        shutil.copyfile(original, target)
        files.append(target)
        checksums.extend([f"{digest}  {original.name}\n", f"{digest}  {alias}\n"])
    checksum_path = release_root / "RELEASE-SHA256SUMS.txt"
    checksum_path.write_text("".join(sorted(checksums)))
    if beta:
        return files + [checksum_path]
    web_checksum_path = release_root / "WEB-RELEASE-SHA256SUMS.txt"
    web_checksum_path.write_text(f"{web[0][1]}  {web[0][0].name}\n")
    return files + [checksum_path, web_checksum_path]


def channel_files(channel_dir: Path, release_root: Path, version: str | None, conf: Path | None):
    """The candidate's channel files, verified against the staged installers before they are staged themselves."""
    if version is None:
        raise ValueError("an updater candidate needs --release-version")
    names = [update_channel.CANDIDATE_NAME.format(name) for name in update_channel.CHANNELS]
    channels = {name: json.loads((channel_dir / candidate).read_text())
                for name, candidate in zip(update_channel.CHANNELS, names) if (channel_dir / candidate).is_file()}
    key = update_channel.public_key(update_channel.app_public_key(conf or REPO_ROOT / "desktop/tauri.conf.json"))
    update_channel.verify(channels, version, key, release_root / "originals")
    staged = release_root / "channels"
    staged.mkdir()
    for name in channels:
        shutil.copyfile(channel_dir / update_channel.CANDIDATE_NAME.format(name),
                        staged / update_channel.CANDIDATE_NAME.format(name))
    return [staged / update_channel.CANDIDATE_NAME.format(name) for name in channels]


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
    parser.add_argument("--channel-dir", type=Path,
                        help="With --release-dir: an updater candidate's folder of channel files (2.1-M27)")
    args = parser.parse_args()
    try:
        if args.release_dir:
            files = release_packages(args.manifest, args.source_dir, args.release_dir,
                                     args.release_version, args.commit, args.channel_dir)
        else:
            files = verified_packages(args.manifest, args.source_dir, args.stage_dir)
    except (OSError, ValueError) as error:  # update_channel.ChannelError is a ValueError
        parser.exit(1, f"ERROR: Cannot prepare candidate packages: {error}\n")
    for path in files:
        print(path)


if __name__ == "__main__":
    main()
