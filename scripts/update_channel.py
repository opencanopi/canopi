#!/usr/bin/env python3
"""The Desktop updater's channel files: generate, verify, publish, pause and seed (2.1-M22, M27, M82, M205, Q250).

`stable.json` and `beta.json` are Tauri static update files. The app reads them at
https://updates.projectcanopi.com/<channel>.json (desktop/updater-endpoints.json), which a Cloudflare redirect
points at GitHub release assets: `stable.json` is an asset of the latest release
(releases/latest/download/stable.json, which skips pre-releases) and `beta.json` lives on the one fixed pre-release
tag `beta-channel`, never 'latest' (2.1-Q250). A channel file names one version and, per installer, the payload
URL on that version's release and the `.sig` the Tauri CLI wrote (installer-specific keys only, 2.1-M210).
`beta.json` lists the greater of the newest beta and the newest stable (2.1-M205), and `stable.json` never a beta.

  generate  the channel files of a candidate, from its updater artifacts and their .sig files (the manifest job)
  verify    refuses an unsigned updater artifact, a missing channel entry, a beta in stable, a signature that does
            not verify under the app's public key or whose trusted-comment version is not the announced version,
            and, with --published, a URL not yet published
  publish   after the release is published: verify --published, then attach the channel files to the release and
            move beta-channel's beta.json (stable.json is live as the latest release's asset); never backward. A
            stable release moves the stable channel when it is published, so any failure before its stable.json is
            attached leaves a stable.json already on it, or else puts back the newest earlier stable release's that
            still verifies; a beta-channel already ahead skips only the beta move
  pause     re-uploads the channel file of an earlier release to the channel's place, verified first (2.1-M27)
  seed      the first channel files, version 2.0.3 with no platforms (2.1-M205)

Pure standard library: the signature check is RFC 8032 Ed25519 over minisign's prehashed (BLAKE2b-512) form.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from typing import Callable
import urllib.error
import urllib.request

REPO_ROOT = Path(__file__).resolve().parent.parent
CHANNELS = ("stable", "beta")
BETA_TAG = "beta-channel"
# A candidate's channel file rides on the draft under this name, so nothing reads it until `publish` has verified
# it and uploaded it under the channel's own name (2.1-M27).
CANDIDATE_NAME = "channel-{}.json"
SEED_VERSION = "2.0.3"
# The candidate's updater artifacts, by artifact root and suffix (the Release Candidate's matrix), and the
# installer-specific channel key each one serves (host/updater/channel.rs `Installation::key`).
UPDATER_KEYS = {
    ("canopi-x86_64-unknown-linux-gnu", ".deb"): "linux-x86_64-deb",
    ("canopi-x86_64-unknown-linux-gnu", ".AppImage"): "linux-x86_64-appimage",
    ("canopi-x86_64-pc-windows-msvc", ".exe"): "windows-x86_64-nsis",
    ("canopi-x86_64-pc-windows-msvc", ".msi"): "windows-x86_64-msi",
}
# An MSI version takes no pre-release label, so betas ship the NSIS installer only (2.1-M27, M55).
REQUIRED_KEYS = {
    "stable": frozenset(UPDATER_KEYS.values()),
    "beta": frozenset(UPDATER_KEYS.values()) - {"windows-x86_64-msi"},
}
VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?")


class ChannelError(ValueError):
    """A channel file, signature or release that must not reach users."""


# --- versions -------------------------------------------------------------------------------------------------

def parse_version(text: str):
    match = VERSION_RE.fullmatch(text)
    if not match:
        raise ChannelError(f"not a release version: {text!r}")
    major, minor, patch, pre = match.groups()
    return int(major), int(minor), int(patch), tuple(pre.split(".")) if pre else ()


def channel_of(version: str) -> str:
    pre = parse_version(version)[3]
    if not pre:
        return "stable"
    if pre[0] == "beta":
        return "beta"
    raise ChannelError(f"{version} names no channel: a pre-release is beta.<n>")


def version_key(version: str):
    """SemVer precedence: a release ranks above its pre-releases; numeric identifiers rank below text ones."""
    major, minor, patch, pre = parse_version(version)
    identifiers = tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in pre)
    return major, minor, patch, 0 if pre else 1, identifiers


def newer(left: dict, right: dict) -> dict:
    return left if version_key(left["version"]) >= version_key(right["version"]) else right


# --- minisign signatures --------------------------------------------------------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _edwards_add(a, b):
    (x1, y1, z1, t1), (x2, y2, z2, t2) = a, b
    p1, p2 = (y1 - x1) * (y2 - x2) % _P, (y1 + x1) * (y2 + x2) % _P
    p3, p4 = t1 * 2 * _D * t2 % _P, z1 * 2 * z2 % _P
    e, f, g, h = p2 - p1, p4 - p3, p4 + p3, p2 + p1
    return e * f % _P, g * h % _P, f * g % _P, e * h % _P


def _scalar_mult(scalar: int, point):
    result = (0, 1, 1, 0)
    while scalar:
        if scalar & 1:
            result = _edwards_add(result, point)
        point = _edwards_add(point, point)
        scalar >>= 1
    return result


def _encode_point(point) -> bytes:
    x, y, z, _ = point
    inverse = pow(z, _P - 2, _P)
    x, y = x * inverse % _P, y * inverse % _P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _decode_point(data: bytes):
    if len(data) != 32:
        return None
    value = int.from_bytes(data, "little")
    sign, y = value >> 255, value & ((1 << 255) - 1)
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _I % _P
    if (x * x - x2) % _P or (x == 0 and sign):
        return None
    if x & 1 != sign:
        x = _P - x
    return x, y, 1, x * y % _P


_BASE = _decode_point((4 * pow(5, _P - 2, _P) % _P).to_bytes(32, "little"))


def ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    point, r_point = _decode_point(public), _decode_point(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if point is None or r_point is None or len(signature) != 64 or s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % _L
    return _encode_point(_scalar_mult(s, _BASE)) == _encode_point(_edwards_add(r_point, _scalar_mult(h, point)))


def public_key(text: str) -> tuple[bytes, bytes]:
    """The key id and Ed25519 key of a minisign public key, as `plugins.updater.pubkey` holds it (base64 text)."""
    try:
        lines = base64.b64decode(text, validate=True).decode().splitlines()
        raw = base64.b64decode(lines[1], validate=True)
    except (ValueError, IndexError, UnicodeDecodeError) as error:
        raise ChannelError(f"the updater public key does not decode: {error}") from None
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise ChannelError("the updater public key is not a minisign Ed25519 key")
    return raw[2:10], raw[10:]


def app_public_key(conf: Path) -> str:
    key = json.loads(conf.read_text()).get("plugins", {}).get("updater", {}).get("pubkey")
    if not isinstance(key, str) or not key:
        raise ChannelError(f"{conf} has no plugins.updater.pubkey")
    return key


class Signature:
    """A `.sig` the Tauri CLI wrote: base64 of minisign's four lines."""

    def __init__(self, text: str):
        try:
            lines = base64.b64decode(text.strip(), validate=True).decode().splitlines()
            self.raw = base64.b64decode(lines[1], validate=True)
            self.global_signature = base64.b64decode(lines[3], validate=True)
        except (ValueError, IndexError, UnicodeDecodeError):
            raise ChannelError("a signature is not a minisign signature") from None
        if not lines[2].startswith("trusted comment: ") or len(self.raw) != 74 or self.raw[:2] not in (b"ED", b"Ed"):
            raise ChannelError("a signature is not a minisign signature")
        self.key_id = self.raw[2:10]
        self.trusted_comment = lines[2].removeprefix("trusted comment: ")

    @property
    def version(self) -> str | None:
        """The version the CLI bound the signature to (`--app-version`, tauri build >= 2.12)."""
        for field in self.trusted_comment.split("\t"):
            if field.startswith("version:"):
                return field.removeprefix("version:")
        return None

    def check(self, key: tuple[bytes, bytes], payload: Path | None = None) -> None:
        """The trusted comment, and with `payload` its bytes, verify under `key`."""
        key_id, public = key
        if self.key_id != key_id:
            raise ChannelError("a signature was made by another key than the app's")
        if not ed25519_verify(public, self.raw[10:] + self.trusted_comment.encode(), self.global_signature):
            raise ChannelError("a signature's trusted comment does not verify")
        if payload is not None:
            digest = hashlib.blake2b(digest_size=64)
            with payload.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            message = digest.digest() if self.raw[:2] == b"ED" else payload.read_bytes()
            if not ed25519_verify(public, message, self.raw[10:]):
                raise ChannelError(f"{payload.name} does not verify under its signature")


# --- generate -------------------------------------------------------------------------------------------------

def updater_artifacts(artifacts: Path) -> dict[str, Path]:
    """Each updater artifact of a candidate by channel key; one without its .sig is refused (2.1-M82)."""
    found: dict[str, Path] = {}
    for path in sorted(artifacts.rglob("*")):
        relative = PurePosixPath(path.relative_to(artifacts).as_posix())
        key = UPDATER_KEYS.get((relative.parts[0], path.suffix)) if path.is_file() else None
        if key is None:
            continue
        if key in found:
            raise ChannelError(f"two updater artifacts for {key}: {found[key].name} and {path.name}")
        if not path.with_name(path.name + ".sig").is_file():
            raise ChannelError(f"unsigned updater artifact: {relative}")
        found[key] = path
    return found


def release_document(version: str, artifacts: Path, base_url: str, notes: str, pub_date: str | None) -> dict:
    channel = channel_of(version)
    found = updater_artifacts(artifacts)
    if channel == "beta" and "windows-x86_64-msi" in found:
        raise ChannelError("a beta ships no MSI: an MSI version takes no pre-release label (2.1-M27)")
    document = {"version": version, "notes": notes, "platforms": {
        key: {"signature": path.with_name(path.name + ".sig").read_text().strip(),
              "url": f"{base_url.rstrip('/')}/{path.name}"}
        for key, path in sorted(found.items())}}
    if pub_date:
        document["pub_date"] = pub_date
    return document


def seed_document() -> dict:
    return {"version": SEED_VERSION, "platforms": {}}


def generate(version: str, artifacts: Path, base_url: str, current: dict[str, dict], notes: str = "",
             pub_date: str | None = None) -> dict[str, dict]:
    """The channel files a release moves: a stable one moves both, a beta only beta.json."""
    document = release_document(version, artifacts, base_url, notes, pub_date)
    if channel_of(version) == "stable":
        return {"stable": document, "beta": newer(document, current.get("beta", seed_document()))}
    return {"beta": newer(document, current.get("stable", seed_document()))}


# --- verify ---------------------------------------------------------------------------------------------------

def check_document(name: str, document: object) -> dict:
    if (not isinstance(document, dict) or not isinstance(document.get("version"), str)
            or not isinstance(document.get("platforms"), dict)):
        raise ChannelError(f"{name}.json is not a channel file")
    channel_of(document["version"])
    if name == "stable" and channel_of(document["version"]) != "stable":
        raise ChannelError(f"stable.json announces the beta {document['version']}")
    for key, entry in document["platforms"].items():
        if key not in UPDATER_KEYS.values():
            raise ChannelError(f"{name}.json has an entry for {key}, which no installer asks for")
        if (not isinstance(entry, dict) or not isinstance(entry.get("signature"), str)
                or not str(entry.get("url", "")).startswith("https://")):
            raise ChannelError(f"{name}.json's {key} entry needs a signature and an https URL")
    return document


Fetch = Callable[[str, bool], "tuple[int, bytes]"]


def fetch(url: str, head: bool) -> tuple[int, bytes]:
    """GET (or HEAD) `url` after redirects: its status and body; a connection failure is status 0."""
    request = urllib.request.Request(url, method="HEAD" if head else "GET",
                                     headers={"User-Agent": "canopi-update-channel"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, b"" if head else response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""
    except (urllib.error.URLError, OSError):
        return 0, b""


def verify(channels: dict[str, dict], version: str, key: tuple[bytes, bytes], artifacts: Path | None = None,
           published: Fetch | None = None, channel: str | None = None) -> list[str]:
    """Every check a channel file passes before it moves; returns what was checked, raises on the first refusal.
    `version` is the release the files come from; `channel`, the file it must hold, is its channel unless named."""
    checked = []
    release_channel = channel_of(version)
    if (channel or release_channel) not in channels:
        raise ChannelError(f"no {channel or release_channel}.json for {version}")
    local = updater_artifacts(artifacts) if artifacts is not None else {}
    for name, document in channels.items():
        check_document(name, document)
        if document["version"] == version:
            missing = REQUIRED_KEYS[release_channel] - document["platforms"].keys()
            if missing:
                raise ChannelError(f"{name}.json has no entry for {', '.join(sorted(missing))}")
            unlisted = local.keys() - document["platforms"].keys()
            if unlisted:
                raise ChannelError(f"{name}.json leaves out the updater artifact for {', '.join(sorted(unlisted))}")
        for platform, entry in sorted(document["platforms"].items()):
            signature = Signature(entry["signature"])
            if signature.version != document["version"]:
                raise ChannelError(f"{name}.json's {platform} signature is bound to {signature.version}, "
                                   f"not the announced {document['version']}")
            payload = local.get(platform) if document["version"] == version else None
            if payload is not None and PurePosixPath(entry["url"]).name != payload.name:
                raise ChannelError(f"{name}.json's {platform} URL does not name {payload.name}")
            signature.check(key, payload)
            if published is not None:
                status, _ = published(entry["url"], True)
                if status != 200:
                    raise ChannelError(f"{entry['url']} is not published yet (HTTP {status})")
                status, body = published(entry["url"] + ".sig", False)
                if status != 200 or body.decode(errors="replace").strip() != entry["signature"].strip():
                    raise ChannelError(f"{entry['url']}.sig is not the signature {name}.json announces")
            checked.append(f"{name}.json {document['version']} {platform}")
    return checked


# --- GitHub releases ------------------------------------------------------------------------------------------

Gh = Callable[..., str]


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def release_asset(run: Gh, repo: str, tag: str, name: str) -> dict | None:
    with tempfile.TemporaryDirectory() as folder:
        try:
            run("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", folder)
        except subprocess.CalledProcessError:
            return None
        path = Path(folder) / name
        return json.loads(path.read_text()) if path.is_file() else None


def attached(run: Gh, repo: str, tag: str, name: str) -> dict | None:
    """The asset `name` of `tag` if the release lists it; unlike `release_asset`, a failed gh call raises."""
    assets = json.loads(run("release", "view", tag, "--repo", repo, "--json", "assets"))["assets"]
    if name not in {asset["name"] for asset in assets}:
        return None
    with tempfile.TemporaryDirectory() as folder:
        run("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", folder)
        return json.loads((Path(folder) / name).read_text())


def upload(run: Gh, repo: str, tag: str, documents: dict[str, dict]) -> None:
    with tempfile.TemporaryDirectory() as folder:
        files = []
        for name, document in documents.items():
            path = Path(folder) / f"{name}.json"
            path.write_text(json.dumps(document, indent=2) + "\n")
            files.append(str(path))
        run("release", "upload", tag, *files, "--repo", repo, "--clobber")


def ensure_beta_tag(run: Gh, repo: str) -> None:
    try:
        run("release", "view", BETA_TAG, "--repo", repo, "--json", "tagName")
    except subprocess.CalledProcessError:
        run("release", "create", BETA_TAG, "--repo", repo, "--prerelease", "--latest=false", "--title",
            "Beta channel", "--notes", "The Desktop beta channel's update file. Betas are the pre-releases.")


def release_info(run: Gh, repo: str, tag: str) -> dict:
    info = json.loads(run("release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease,tagName"))
    info["latest"] = json.loads(run("api", f"repos/{repo}/releases/latest")).get("tag_name") == tag
    return info


def candidate_channels(run: Gh, repo: str, tag: str) -> dict[str, dict]:
    """The channel files promotion attached to the release under their candidate names."""
    return {name: document for name in CHANNELS
            if (document := release_asset(run, repo, tag, CANDIDATE_NAME.format(name))) is not None}


def publish(run: Gh, repo: str, tag: str, key: tuple[bytes, bytes], published: Fetch = fetch) -> list[str]:
    """Moves the channels a published release names: verified first, never to an older version; returns what it did.
    A release that is not an updater candidate (its release-metadata.json does not say so: a catalog or pre-updater
    release, or beta-channel itself) moves nothing and returns nothing, since CI runs this on every published release.

    A beta moves nothing unless every check passes. A stable release has moved the stable channel already: GitHub made
    it the latest release when it was published, and the channel is the latest release's stable.json. So stable.json
    is verified and attached first, and any failure until it is attached hands the channel to `restore_stable`; the
    beta move, second, is skipped where beta-channel is already ahead."""
    metadata = release_asset(run, repo, tag, "release-metadata.json")
    if tag == BETA_TAG or metadata is None or metadata.get("updater") is not True:
        return []
    version = tag.removeprefix("v")
    if channel_of(version) == "beta":
        channels = checked_release(run, repo, tag, version)
        checked = verify(channels, version, key, published=published)
        current = release_asset(run, repo, BETA_TAG, "beta.json")
        if current is not None and version_key(current["version"]) > version_key(channels["beta"]["version"]):
            raise ChannelError(f"beta.json already announces {current['version']}; pause moves a channel back")
        return publish_beta(run, repo, tag, channels["beta"], [f"published {line}" for line in checked])
    try:
        channels = checked_release(run, repo, tag, version)
        stable = {name: document for name, document in channels.items() if name == "stable"}
        checked = verify(stable, version, key, published=published)
        # stable.json on the latest release is the stable channel itself, and what `pause` goes back to.
        upload(run, repo, tag, stable)
    except Exception as error:  # noqa: BLE001 - whatever failed, the stable channel must not stay on a 404
        raise ChannelError(f"{error}; {restore_stable(run, repo, tag, version, key, published)}") from error
    lines = [f"published {line}" for line in checked]
    if "beta" not in channels:
        return lines
    try:
        checked = verify({"beta": channels["beta"]}, version, key, published=published, channel="beta")
    except ChannelError as error:
        raise ChannelError(f"stable.json moved to {version}, beta.json did not: {error}") from error
    current = release_asset(run, repo, BETA_TAG, "beta.json")
    if current is not None and version_key(current["version"]) > version_key(channels["beta"]["version"]):
        upload(run, repo, tag, {"beta": channels["beta"]})
        return [*lines, f"beta.json stays at {current['version']}, which beta-channel already announces"]
    return publish_beta(run, repo, tag, channels["beta"], [*lines, *(f"published {line}" for line in checked)])


def checked_release(run: Gh, repo: str, tag: str, version: str) -> dict[str, dict]:
    """The candidate channel files of a release published as its channel requires: a beta as a pre-release, a stable
    release as the latest."""
    info = release_info(run, repo, tag)
    if info["isDraft"]:
        raise ChannelError(f"{tag} is a draft: publish the release first")
    if channel_of(version) == "stable" and (info["isPrerelease"] or not info["latest"]):
        raise ChannelError(f"the stable {tag} must be published as the latest release, not a pre-release")
    if channel_of(version) == "beta" and not info["isPrerelease"]:
        raise ChannelError(f"the beta {tag} must be a pre-release")
    return candidate_channels(run, repo, tag)


def publish_beta(run: Gh, repo: str, tag: str, document: dict, lines: list[str]) -> list[str]:
    upload(run, repo, tag, {"beta": document})
    ensure_beta_tag(run, repo)
    upload(run, repo, BETA_TAG, {"beta": document})
    return lines


def restore_stable(run: Gh, repo: str, tag: str, version: str, key: tuple[bytes, bytes], published: Fetch) -> str:
    """Leaves the stable channel on a verified stable.json after `publish` failed on the stable release `tag`; says
    what it did. Only the latest release is the channel. A stable.json already on `tag` stays: an earlier run (or
    restore) verified it before attaching it, and a failure now, often a network blip, must not move the channel back.
    Otherwise the newest earlier stable release's stable.json that still verifies, as `pause` checks it, goes on."""
    try:
        if json.loads(run("api", f"repos/{repo}/releases/latest")).get("tag_name") != tag:
            return f"{tag} is not the latest release, so the stable channel is not on it: nothing put back"
        if (current := attached(run, repo, tag, "stable.json")) is not None:
            return f"stable.json stays at {current['version']} on {tag}, as an earlier run verified it"
        listed = json.loads(run("release", "list", "--repo", repo, "--exclude-drafts", "--exclude-pre-releases",
                                "--json", "tagName", "--limit", "100"))
        refused = []
        for release in listed:
            other = release["tagName"]
            if other == tag or (document := release_asset(run, repo, other, "stable.json")) is None:
                continue
            try:
                # Checked as a file `tag` carries: its signatures and published payloads, not a new release's
                # completeness (the 2.0.3 seed names no platform and stays valid).
                verify({"stable": document}, version, key, published=published, channel="stable")
            except ChannelError as error:
                refused.append(f"{other}'s stable.json is refused: {error}")
                continue
            upload(run, repo, tag, {"stable": document})
            restored = f"stable.json is {other}'s again on {tag}: fix the cause and run publish again"
            return "; ".join([*refused, restored])
    except Exception as failure:  # noqa: BLE001 - the operator must learn the channel may be on a 404
        return (f"putting the previous stable.json back failed too ({failure!r}): the stable channel may be on a 404; "
                f"run publish again, or pause stable to an earlier release")
    return "; ".join([*refused, f"the stable channel is {tag}'s stable.json, which it does not have: unpublish {tag}, "
                                "or upload an earlier verified stable.json to it"])


def pause(run: Gh, repo: str, channel: str, to_tag: str, key: tuple[bytes, bytes],
          published: Fetch = fetch) -> str:
    """Re-uploads `to_tag`'s channel file to the channel's place (2.1-M27): verified, then moved."""
    document = release_asset(run, repo, to_tag, f"{channel}.json")
    if document is None:
        raise ChannelError(f"{to_tag} has no {channel}.json to go back to")
    verify({channel: document}, document["version"], key, published=published, channel=channel)
    target = BETA_TAG if channel == "beta" else json.loads(run("api", f"repos/{repo}/releases/latest"))["tag_name"]
    upload(run, repo, target, {channel: document})
    return target


def seed(run: Gh, repo: str) -> str:
    """The first channel files (2.1-M205): stable.json on the latest release, beta.json on beta-channel."""
    latest = json.loads(run("api", f"repos/{repo}/releases/latest"))["tag_name"]
    if latest != f"v{SEED_VERSION}":
        raise ChannelError(f"the latest release is {latest}, not v{SEED_VERSION}: the channels are seeded already")
    for tag, name in ((latest, "stable"), (BETA_TAG, "beta")):
        if tag == BETA_TAG:
            ensure_beta_tag(run, repo)
        if release_asset(run, repo, tag, f"{name}.json") is not None:
            raise ChannelError(f"{tag} already has {name}.json")
        upload(run, repo, tag, {name: seed_document()})
    return latest


# --- command line ---------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None, run: Gh = gh, published: Fetch = fetch) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--conf", type=Path, default=REPO_ROOT / "desktop/tauri.conf.json",
                        help="the tauri.conf.json whose plugins.updater.pubkey signatures must verify under")
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("generate")
    make.add_argument("--version", required=True)
    make.add_argument("--artifacts", type=Path, required=True)
    make.add_argument("--base-url", required=True, help="the release's download URL, .../releases/download/v<version>")
    make.add_argument("--current", type=Path, help="a folder with the stable.json and beta.json users read today")
    make.add_argument("--notes", default="")
    make.add_argument("--pub-date")
    make.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("--version", required=True)
    check.add_argument("--channel-dir", type=Path, required=True)
    check.add_argument("--artifacts", type=Path)
    check.add_argument("--published", action="store_true", help="also fetch each payload URL and its .sig")
    move = commands.add_parser("publish")
    move.add_argument("--tag", required=True)
    move.add_argument("--repo", required=True)
    back = commands.add_parser("pause")
    back.add_argument("--channel", choices=CHANNELS, required=True)
    back.add_argument("--to", required=True, help="the earlier release whose channel file users read again")
    back.add_argument("--repo", required=True)
    first = commands.add_parser("seed")
    first.add_argument("--repo", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "generate":
            current = {name: json.loads((args.current / f"{name}.json").read_text()) for name in CHANNELS
                       if args.current and (args.current / f"{name}.json").is_file()}
            args.out.mkdir(parents=True, exist_ok=True)
            for name, document in generate(args.version, args.artifacts, args.base_url, current, args.notes,
                                           args.pub_date).items():
                path = args.out / CANDIDATE_NAME.format(name)
                path.write_text(json.dumps(document, indent=2) + "\n")
                print(path)
            return 0
        if args.command == "seed":
            print(f"seeded stable.json on {seed(run, args.repo)} and beta.json on {BETA_TAG}")
            return 0
        key = public_key(app_public_key(args.conf))
        if args.command == "verify":
            channels = {name: json.loads(path.read_text()) for name in CHANNELS
                        if (path := args.channel_dir / CANDIDATE_NAME.format(name)).is_file()}
            for line in verify(channels, args.version, key, args.artifacts, published if args.published else None):
                print(f"verified {line}")
        elif args.command == "publish":
            lines = publish(run, args.repo, args.tag, key, published)
            for line in lines:
                print(line)
            if not lines:
                print(f"{args.tag} is not an updater release: no channel moves")
        else:
            target = pause(run, args.repo, args.channel, args.to, key, published)
            print(f"{args.channel}.json is {args.to}'s again, on {target}")
    except (ChannelError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
