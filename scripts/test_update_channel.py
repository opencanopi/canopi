"""The updater's channel files (scripts/update_channel.py; 2.1-M22, M27, M82, M205, Q250).

Signatures here are made with an ephemeral key generated in the test (never the release key), in the form the
Tauri CLI writes; one fixture is a real `tauri signer sign --app-version 2.0.3` output, so the reader is held to
the CLI's own format, not only to this file's signer.
"""

import base64
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts import update_channel as channel
from scripts.update_channel import ChannelError

# The F6-c4 probe (2026-10-29): an ephemeral key made by `tauri signer generate` (tauri-cli 2.12.3), whose private
# half was deleted, signed this payload with `tauri signer sign --app-version 2.0.3`.
CLI_PAYLOAD = b"canopi probe payload\n"
CLI_PUBKEY = ("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU3OEU4MUNGNzRDM0FCRDIKUldUU3E4TjB6NEdPVjVM"
              "NkFPYitQRHdCWEVVT0NOOU0rWmdYcDhUVnl0bGZVdFBkZlhGcXpvRm0K")
CLI_SIGNATURE = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUU3E4TjB6NEdPVjh4Rkk2c3Y1YmFyZlU0dE8z"
    "eTlxMXFMWERqdkVkQ1IvZ2l0WkUySVNwaW1oU2drdGU1ZHlVbkVLTkhXVENSUGxHbkszTTVBOEV6WVExNzZyczZ1eHd3PQp0cnVzdGVkIGNv"
    "bW1lbnQ6IHRpbWVzdGFtcDoxNzkzMjU3Mzk3CWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjoyLjAuMwpEeEtpRWpPMy8rM3NNekswMVc1aTd0"
    "Y1BiOFNQMURrYkR5b0tuNXpVYVA2REZmdHdhVEpZY1RQVTk5SWprMUtESkdzaUdxblRFREw4VThKcGNvM1lEUT09Cg==")
REPO = "example/canopi"
STABLE_LAYOUT = {
    "linux-x86_64-deb": "canopi-x86_64-unknown-linux-gnu/deb/Canopi_{v}_amd64.deb",
    "linux-x86_64-appimage": "canopi-x86_64-unknown-linux-gnu/appimage/Canopi_{v}_amd64.AppImage",
    "windows-x86_64-nsis": "canopi-x86_64-pc-windows-msvc/nsis/Canopi_{v}_x64-setup.exe",
    "windows-x86_64-msi": "canopi-x86_64-pc-windows-msvc/msi/Canopi_{v}_x64_en-US.msi",
}


class Key:
    """An ephemeral minisign key in the Tauri CLI's encodings."""

    def __init__(self, seed: bytes, key_id: bytes = b"\x01" * 8):
        digest = hashlib.sha512(seed).digest()
        self.prefix = digest[32:]
        scalar = int.from_bytes(digest[:32], "little")
        self.scalar = (scalar & ((1 << 254) - 8)) | (1 << 254)
        self.public = channel._encode_point(channel._scalar_mult(self.scalar, channel._BASE))
        self.key_id = key_id

    def sign_bytes(self, message: bytes) -> bytes:
        r = int.from_bytes(hashlib.sha512(self.prefix + message).digest(), "little") % channel._L
        point = channel._encode_point(channel._scalar_mult(r, channel._BASE))
        k = int.from_bytes(hashlib.sha512(point + self.public + message).digest(), "little") % channel._L
        return point + ((r + k * self.scalar) % channel._L).to_bytes(32, "little")

    def pubkey(self) -> str:
        line = base64.b64encode(b"Ed" + self.key_id + self.public).decode()
        return base64.b64encode(f"untrusted comment: minisign public key: X\n{line}\n".encode()).decode()

    def sign(self, payload: bytes, version: str, name: str = "payload") -> str:
        raw = b"ED" + self.key_id + self.sign_bytes(hashlib.blake2b(payload, digest_size=64).digest())
        trusted = f"timestamp:1793257397\tfile:{name}\tversion:{version}"
        text = (f"untrusted comment: signature from tauri secret key\n{base64.b64encode(raw).decode()}\n"
                f"trusted comment: {trusted}\n"
                f"{base64.b64encode(self.sign_bytes(raw[10:] + trusted.encode())).decode()}\n")
        return base64.b64encode(text.encode()).decode()


KEY = Key(os.urandom(32))


def candidate(root: Path, version: str, keys=None, signer=KEY, signed_version=None, unsigned=()) -> Path:
    """A candidate's artifact folder: each installer with its .sig, as the Release Candidate uploads them."""
    for platform in keys or STABLE_LAYOUT:
        path = root / STABLE_LAYOUT[platform].format(v=version)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = f"{platform} {version} installer".encode()
        path.write_bytes(payload)
        if platform not in unsigned:
            path.with_name(path.name + ".sig").write_text(signer.sign(payload, signed_version or version, path.name))
    return root


def base_url(version):
    return f"https://github.com/{REPO}/releases/download/v{version}"


BETA_KEYS = ["linux-x86_64-deb", "linux-x86_64-appimage", "windows-x86_64-nsis"]


class Workspace(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def release(self, version, **options):
        folder = candidate(self.root / f"candidate-{version}", version, **options)
        return folder, channel.generate(version, folder, base_url(version), {})

    def key(self):
        return channel.public_key(KEY.pubkey())


class SignatureTests(Workspace):
    def test_the_cli_signature_binds_its_version_in_the_trusted_comment_and_verifies(self):
        signature = channel.Signature(CLI_SIGNATURE)
        self.assertEqual(signature.version, "2.0.3")
        payload = self.root / "payload.bin"
        payload.write_bytes(CLI_PAYLOAD)
        signature.check(channel.public_key(CLI_PUBKEY), payload)
        payload.write_bytes(CLI_PAYLOAD + b"tampered")
        with self.assertRaisesRegex(ChannelError, "does not verify"):
            signature.check(channel.public_key(CLI_PUBKEY), payload)

    def test_a_signature_by_another_key_is_refused(self):
        with self.assertRaisesRegex(ChannelError, "another key"):
            channel.Signature(Key(os.urandom(32), b"\x02" * 8).sign(b"x", "2.1.0")).check(self.key())

    def test_versions_rank_by_semver_and_a_release_above_its_betas(self):
        ordered = ["2.0.3", "2.1.0-beta.2", "2.1.0-beta.10", "2.1.0", "2.1.1"]
        self.assertEqual(sorted(reversed(ordered), key=channel.version_key), ordered)
        self.assertEqual([channel.channel_of(v) for v in ("2.1.0", "2.1.0-beta.1")], ["stable", "beta"])
        with self.assertRaises(ChannelError):
            channel.channel_of("2.1.0-rc.1")


class GenerateTests(Workspace):
    def test_a_stable_release_names_each_installer_by_its_specific_key_on_its_release(self):
        folder, files = self.release("2.1.0")
        self.assertEqual(set(files), {"stable", "beta"})
        stable = files["stable"]
        self.assertEqual(set(stable["platforms"]), set(STABLE_LAYOUT))
        for platform, entry in stable["platforms"].items():
            artifact = folder / STABLE_LAYOUT[platform].format(v="2.1.0")
            self.assertEqual(entry["url"], f"{base_url('2.1.0')}/{artifact.name}")
            self.assertEqual(entry["signature"], (artifact.parent / (artifact.name + ".sig")).read_text())
        self.assertEqual(files["beta"], stable)

    def test_a_beta_moves_only_beta_json_and_ships_no_msi(self):
        _, files = self.release("2.1.0-beta.1", keys=BETA_KEYS)
        self.assertEqual(set(files), {"beta"})
        self.assertEqual(set(files["beta"]["platforms"]), set(BETA_KEYS))
        with self.assertRaisesRegex(ChannelError, "no MSI"):
            self.release("2.1.0-beta.2")

    def test_beta_json_lists_the_greater_of_the_newest_beta_and_the_newest_stable(self):
        _, stable = self.release("2.1.1")
        _, beta = self.release("2.2.0-beta.1", keys=BETA_KEYS)
        folder = candidate(self.root / "late-beta", "2.1.0-beta.4", keys=BETA_KEYS)
        late = channel.generate("2.1.0-beta.4", folder, base_url("2.1.0-beta.4"), {"stable": stable["stable"]})
        self.assertEqual(late["beta"]["version"], "2.1.1")
        folder = candidate(self.root / "fix", "2.1.2")
        fix = channel.generate("2.1.2", folder, base_url("2.1.2"), {"beta": beta["beta"]})
        self.assertEqual((fix["stable"]["version"], fix["beta"]["version"]), ("2.1.2", "2.2.0-beta.1"))

    def test_an_unsigned_updater_artifact_is_refused(self):
        with self.assertRaisesRegex(ChannelError, "unsigned updater artifact"):
            self.release("2.1.0", unsigned=("windows-x86_64-msi",))

    def test_the_seed_is_2_0_3_with_no_platforms(self):
        self.assertEqual(channel.seed_document(), {"version": "2.0.3", "platforms": {}})


class VerifyTests(Workspace):
    def verify(self, files, version, folder=None, published=None):
        return channel.verify(files, version, self.key(), folder, published)

    def test_a_complete_release_verifies_against_its_artifacts(self):
        folder, files = self.release("2.1.0")
        self.assertEqual(len(self.verify(files, "2.1.0", folder)), 8)

    def test_a_planted_unsigned_updater_artifact_fails(self):
        folder, files = self.release("2.1.0")
        next(folder.rglob("*.msi.sig")).unlink()
        with self.assertRaisesRegex(ChannelError, "unsigned updater artifact"):
            self.verify(files, "2.1.0", folder)

    def test_a_missing_channel_entry_fails(self):
        folder, files = self.release("2.1.0")
        del files["stable"]["platforms"]["linux-x86_64-deb"]
        with self.assertRaisesRegex(ChannelError, "no entry for linux-x86_64-deb"):
            self.verify(files, "2.1.0")
        with self.assertRaisesRegex(ChannelError, "no stable.json"):
            self.verify({"beta": files["beta"]}, "2.1.0")

    def test_a_beta_in_stable_fails(self):
        _, files = self.release("2.1.0-beta.1", keys=BETA_KEYS)
        with self.assertRaisesRegex(ChannelError, "stable.json announces the beta"):
            self.verify({"stable": files["beta"], "beta": files["beta"]}, "2.1.0-beta.1")

    def test_a_signature_bound_to_another_version_fails(self):
        _, files = self.release("2.1.0", signed_version="2.0.3")
        with self.assertRaisesRegex(ChannelError, "bound to 2.0.3, not the announced 2.1.0"):
            self.verify(files, "2.1.0")

    def test_a_tampered_artifact_fails(self):
        folder, files = self.release("2.1.0")
        next(folder.rglob("*.AppImage")).write_bytes(b"tampered")
        with self.assertRaisesRegex(ChannelError, "does not verify"):
            self.verify(files, "2.1.0", folder)

    def test_a_url_not_yet_published_fails_and_a_published_one_passes(self):
        _, files = self.release("2.1.0")
        signatures = {entry["url"] + ".sig": entry["signature"].encode()
                      for entry in files["stable"]["platforms"].values()}
        live = lambda url, head: (200, b"" if head else signatures[url])  # noqa: E731
        self.assertEqual(len(self.verify(files, "2.1.0", published=live)), 8)
        with self.assertRaisesRegex(ChannelError, "is not published yet .HTTP 404"):
            self.verify(files, "2.1.0", published=lambda url, head: (404, b""))
        with self.assertRaisesRegex(ChannelError, "is not the signature"):
            self.verify(files, "2.1.0", published=lambda url, head: (200, b"other"))


class FakeGh:
    """GitHub releases in memory: the `gh` calls update_channel makes."""

    def __init__(self, latest="v2.1.0"):
        self.releases = {}
        self.latest = latest
        self.calls = []

    def add(self, tag, draft=False, prerelease=False, **assets):
        self.releases[tag] = {"draft": draft, "prerelease": prerelease,
                              "assets": {name: json.dumps(document) for name, document in assets.items()}}

    def asset(self, tag, name):
        return json.loads(self.releases[tag]["assets"][name])

    def __call__(self, *args):
        self.calls.append(args)
        if args[0] == "api":
            return json.dumps({"tag_name": self.latest})
        verb, tag = args[1], args[2]
        if verb == "list":
            # Newest first, as `gh release list` orders them; drafts and pre-releases left out, as asked.
            return json.dumps([{"tagName": name} for name, release in reversed(self.releases.items())
                               if not release["draft"] and not release["prerelease"]])
        if verb == "view":
            if tag not in self.releases:
                raise subprocess.CalledProcessError(1, "gh")
            release = self.releases[tag]
            return json.dumps({"isDraft": release["draft"], "isPrerelease": release["prerelease"], "tagName": tag})
        if verb == "create":
            self.add(tag, prerelease="--prerelease" in args)
        elif verb == "download":
            name = args[args.index("--pattern") + 1]
            if name not in self.releases.get(tag, {"assets": {}})["assets"]:
                raise subprocess.CalledProcessError(1, "gh")
            (Path(args[args.index("--dir") + 1]) / name).write_text(self.releases[tag]["assets"][name])
        elif verb == "upload":
            for path in map(Path, args[3:args.index("--repo")]):
                self.releases[tag]["assets"][path.name] = path.read_text()
        return ""

    def uploads(self):
        return [(call[2], [Path(path).name for path in call[3:call.index("--repo")]])
                for call in self.calls if call[:2] == ("release", "upload")]


class PublishTests(Workspace):
    def published_release(self, version, keys=None, prerelease=False, draft=False, gh=None):
        _, files = self.release(version, **({"keys": keys} if keys else {}))
        gh = gh or FakeGh(latest="v2.1.0" if not prerelease else "v2.0.3")
        gh.add(f"v{version}", draft=draft, prerelease=prerelease, **{"release-metadata.json": {"updater": True}},
               **{channel.CANDIDATE_NAME.format(name): document for name, document in files.items()})
        self.signatures = {entry["url"] + ".sig": entry["signature"].encode()
                           for document in files.values() for entry in document["platforms"].values()}
        return gh, files

    def live(self, url, head):
        return 200, b"" if head else self.signatures[url]

    def test_publish_verifies_then_attaches_the_channels_and_moves_beta_channel(self):
        gh, files = self.published_release("2.1.0")
        channel.publish(gh, REPO, "v2.1.0", self.key(), self.live)
        self.assertEqual(gh.uploads(), [("v2.1.0", ["stable.json"]), ("v2.1.0", ["beta.json"]),
                                        ("beta-channel", ["beta.json"])])
        self.assertEqual(gh.asset("v2.1.0", "stable.json"), files["stable"])
        self.assertTrue(gh.releases["beta-channel"]["prerelease"])
        create = next(call for call in gh.calls if call[:2] == ("release", "create"))
        self.assertIn("--latest=false", create)

    def test_a_refused_stable_release_puts_the_previous_stable_json_back_on_the_latest_release(self):
        """Review finding (F6-c4): publishing a stable release moves 'latest', and with it the stable channel, before
        this runs; a refused stable.json must not leave every stable install's check on a 404."""
        gh = FakeGh(latest="v2.1.0")
        previous = {"version": "2.0.3", "platforms": {}}
        gh.add("v2.0.3", **{"stable.json": previous})
        gh, _ = self.published_release("2.1.0", gh=gh)
        with self.assertRaisesRegex(ChannelError, "not published yet .*stable.json is v2.0.3's again on v2.1.0"):
            channel.publish(gh, REPO, "v2.1.0", self.key(), lambda url, head: (404, b""))
        self.assertEqual(gh.uploads(), [("v2.1.0", ["stable.json"])])
        self.assertEqual(gh.asset("v2.1.0", "stable.json"), previous)
        self.assertNotIn("beta-channel", gh.releases)

    def test_a_refused_stable_release_with_no_earlier_stable_json_says_how_to_restore_the_channel(self):
        gh, _ = self.published_release("2.1.0")
        with self.assertRaisesRegex(ChannelError, "not published yet .*unpublish v2.1.0"):
            channel.publish(gh, REPO, "v2.1.0", self.key(), lambda url, head: (404, b""))
        self.assertEqual(gh.uploads(), [])

    def test_a_refused_beta_release_moves_nothing(self):
        gh, _ = self.published_release("2.1.0-beta.1", keys=BETA_KEYS, prerelease=True)
        with self.assertRaisesRegex(ChannelError, "not published yet"):
            channel.publish(gh, REPO, "v2.1.0-beta.1", self.key(), lambda url, head: (404, b""))
        self.assertEqual(gh.uploads(), [])

    def test_a_stable_release_moves_stable_json_when_beta_channel_is_already_ahead(self):
        """Review finding (F6-c4): a beta published after the candidate was generated leaves beta-channel ahead; the
        stable channel still moves, and only the beta move is skipped, never backward."""
        gh, files = self.published_release("2.1.0")
        ahead = {"version": "2.1.1-beta.1", "platforms": {}}
        gh.add("beta-channel", prerelease=True, **{"beta.json": ahead})
        lines = channel.publish(gh, REPO, "v2.1.0", self.key(), self.live)
        self.assertEqual(gh.uploads(), [("v2.1.0", ["stable.json"]), ("v2.1.0", ["beta.json"])])
        self.assertEqual(gh.asset("v2.1.0", "stable.json"), files["stable"])
        self.assertEqual(gh.asset("beta-channel", "beta.json"), ahead)
        self.assertIn("beta.json stays at 2.1.1-beta.1, which beta-channel already announces", lines)

    def test_a_beta_publishes_only_beta_json_and_must_be_a_pre_release(self):
        gh, _ = self.published_release("2.1.0-beta.1", keys=BETA_KEYS, prerelease=True)
        channel.publish(gh, REPO, "v2.1.0-beta.1", self.key(), self.live)
        self.assertEqual(gh.uploads(), [("v2.1.0-beta.1", ["beta.json"]), ("beta-channel", ["beta.json"])])
        gh, _ = self.published_release("2.1.0-beta.2", keys=BETA_KEYS, prerelease=False)
        with self.assertRaisesRegex(ChannelError, "must be a pre-release"):
            channel.publish(gh, REPO, "v2.1.0-beta.2", self.key(), self.live)

    def test_a_draft_or_a_stable_that_is_not_latest_is_refused(self):
        gh, _ = self.published_release("2.1.0", draft=True)
        with self.assertRaisesRegex(ChannelError, "is a draft"):
            channel.publish(gh, REPO, "v2.1.0", self.key(), self.live)
        gh, _ = self.published_release("2.1.0", gh=FakeGh(latest="v2.0.3"))
        with self.assertRaisesRegex(ChannelError, "latest release"):
            channel.publish(gh, REPO, "v2.1.0", self.key(), self.live)
        self.assertEqual(gh.uploads(), [])

    def test_publish_never_moves_beta_backward(self):
        gh, _ = self.published_release("2.1.0-beta.1", keys=BETA_KEYS, prerelease=True)
        gh.add("beta-channel", prerelease=True, **{"beta.json": {"version": "2.1.0-beta.3", "platforms": {}}})
        with self.assertRaisesRegex(ChannelError, "already announces 2.1.0-beta.3"):
            channel.publish(gh, REPO, "v2.1.0-beta.1", self.key(), self.live)
        self.assertEqual(gh.uploads(), [])

    def test_publish_moves_nothing_for_a_release_that_is_not_an_updater_candidate(self):
        # The update-channel workflow runs on every published release (2.1-Q250): a catalog or pre-updater release,
        # and beta-channel itself, carry no updater metadata and must pass without touching a channel.
        gh = FakeGh(latest="v2.0.4")
        gh.add("v2.0.4", **{"release-metadata.json": {"updater": False}})
        gh.add("db-2026-10", **{"canopi-core.db.sha256": {}})
        gh.add("beta-channel", prerelease=True, **{"beta.json": {"version": "2.0.3", "platforms": {}}})
        for tag in ("v2.0.4", "db-2026-10", "beta-channel"):
            with self.subTest(tag=tag):
                self.assertEqual(channel.publish(gh, REPO, tag, self.key(), self.live), [])
        self.assertEqual(gh.uploads(), [])

    def test_an_updater_candidate_without_its_channel_files_is_refused(self):
        gh = FakeGh(latest="v2.1.0")
        gh.add("v2.1.0", **{"release-metadata.json": {"updater": True}})
        with self.assertRaisesRegex(ChannelError, "no stable.json"):
            channel.publish(gh, REPO, "v2.1.0", self.key(), self.live)
        self.assertEqual(gh.uploads(), [])

    def test_pause_re_uploads_the_previous_release_channel_file(self):
        gh, files = self.published_release("2.1.0")
        channel.publish(gh, REPO, "v2.1.0", self.key(), self.live)
        gh.add("v2.1.1", **{"stable.json": {"version": "2.1.1", "platforms": {}}})
        gh.latest = "v2.1.1"
        self.assertEqual(channel.pause(gh, REPO, "stable", "v2.1.0", self.key(), self.live), "v2.1.1")
        self.assertEqual(gh.asset("v2.1.1", "stable.json"), files["stable"])
        self.assertEqual(channel.pause(gh, REPO, "beta", "v2.1.0", self.key(), self.live), "beta-channel")
        self.assertEqual(gh.asset("beta-channel", "beta.json"), files["beta"])

    def test_seed_puts_2_0_3_on_the_latest_release_and_beta_channel_once(self):
        gh = FakeGh(latest="v2.0.3")
        gh.add("v2.0.3")
        channel.seed(gh, REPO)
        self.assertEqual(gh.asset("v2.0.3", "stable.json"), channel.seed_document())
        self.assertEqual(gh.asset("beta-channel", "beta.json"), channel.seed_document())
        with self.assertRaisesRegex(ChannelError, "already has stable.json"):
            channel.seed(gh, REPO)


class CommandLineTests(Workspace):
    def main(self, args):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return channel.main(args)

    def test_generate_then_verify_through_the_command_line(self):
        folder = candidate(self.root / "candidate", "2.1.0")
        conf = self.root / "tauri.conf.json"
        conf.write_text(json.dumps({"plugins": {"updater": {"pubkey": KEY.pubkey()}}}))
        out = self.root / "channels"
        self.assertEqual(self.main(["generate", "--version", "2.1.0", "--artifacts", str(folder),
                                       "--base-url", base_url("2.1.0"), "--out", str(out)]), 0)
        self.assertEqual(sorted(path.name for path in out.iterdir()), ["channel-beta.json", "channel-stable.json"])
        verify = ["--conf", str(conf), "verify", "--version", "2.1.0", "--channel-dir", str(out),
                  "--artifacts", str(folder)]
        self.assertEqual(self.main(verify), 0)
        (out / "channel-stable.json").unlink()
        self.assertEqual(self.main(verify), 1)


class WorkflowTests(unittest.TestCase):
    """CI moves the channels when a release is published (2.1-Q250), with main's tools, never the tag's."""

    def test_the_update_channel_workflow_publishes_each_published_release_with_main_tools(self):
        text = (Path(__file__).resolve().parents[1] / ".github/workflows/update-channel.yml").read_text()
        self.assertIn("  release:\n    types: [published]\n", text)
        self.assertIn("  contents: write\n", text)
        self.assertIn("          ref: main\n", text)
        self.assertIn("cancel-in-progress: false", text)
        self.assertIn('python3 -I release-tools/scripts/update_channel.py --conf release-tools/desktop/tauri.conf.json '
                      'publish --tag "$TAG" --repo "$GITHUB_REPOSITORY"', text)


if __name__ == "__main__":
    unittest.main()
