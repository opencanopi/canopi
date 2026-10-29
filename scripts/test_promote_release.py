"""Exercise promotion through its CLI with a local GitHub boundary."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

from scripts import update_channel
from scripts.test_update_channel import Key


SOURCE = Path(__file__).resolve().parent
SHA = "1" * 40
PACKAGES = {
    "canopi-x86_64-unknown-linux-gnu/deb/canopi_1.1.1.deb": "canopi-linux-x64.deb",
    "canopi-x86_64-unknown-linux-gnu/appimage/Canopi_1.1.1_amd64.AppImage": "canopi-linux-x64.AppImage",
    "canopi-aarch64-apple-darwin/dmg/Canopi_1.1.1_aarch64.dmg": "canopi-macos-arm64.dmg",
    "canopi-x86_64-apple-darwin/dmg/Canopi_1.1.1_x64.dmg": "canopi-macos-x64.dmg",
    "canopi-x86_64-pc-windows-msvc/nsis/Canopi_1.1.1_x64-setup.exe": "canopi-windows-x64.exe",
    "canopi-x86_64-pc-windows-msvc/msi/Canopi_1.1.1_x64_en-US.msi": "canopi-windows-x64.msi",
}
# The root Web Edition archive keeps its versioned name; SHA's first 12 characters name the commit.
WEB = "canopi-web-edition/canopi-web-edition-root-v1.1.1-111111111111.tar.gz"
ARTIFACTS = [(1, "canopi-x86_64-unknown-linux-gnu"), (2, "canopi-release-candidate-manifest"),
             (3, "canopi-aarch64-apple-darwin"), (4, "canopi-x86_64-apple-darwin"),
             (5, "canopi-x86_64-pc-windows-msvc"), (6, "canopi-web-edition")]


def candidate_manifest(payload):
    return "".join(hashlib.sha256(payload).hexdigest() + "  ./" + name + "\n" for name in [*PACKAGES, WEB])


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(SOURCE / "promote-release.sh", self.root / "scripts")
        shutil.copy2(SOURCE / "release_candidate_artifacts.py", self.root / "scripts")
        shutil.copy2(SOURCE / "web_release_package.py", self.root / "scripts")
        shutil.copy2(SOURCE / "update_channel.py", self.root / "scripts")
        self.extra_files = {}
        self.channel_files = {}
        self.payload = b"candidate installer bytes"
        self.manifest = candidate_manifest(self.payload)
        self.local_dir = self.root / "cached packages"
        self.local_package = self.local_dir / "canopi-x86_64-unknown-linux-gnu/deb/canopi_1.1.1.deb"
        for name in [*PACKAGES, WEB]:
            package = self.local_dir / name
            package.parent.mkdir(parents=True, exist_ok=True)
            package.write_bytes(self.payload)
        self.state = {
            "run": {"path": ".github/workflows/release-candidate.yml", "head_branch": "main", "status": "completed",
                    "conclusion": "success"},
            "metadata": {"repository": "example/canopi", "ref": SHA, "head_sha": SHA, "release_version": "1.1.1",
                         "db_release_tag": "canopi-core-db", "db_asset_name": "catalog.db", "db_sha256": "2" * 64,
                         "expected_db_schema_version": 13},
            "release": None, "tag_sha": None, "artifacts": ARTIFACTS,
        }
        gh = self.root / "gh"
        gh.write_text('''#!/usr/bin/env python3
import hashlib, json, os, sys
from pathlib import Path
root = Path(os.environ["PROMOTION_FIXTURE"])
state = json.loads((root / "state.json").read_text())
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as f: f.write(json.dumps(args) + "\\n")
if args[:2] == ["release", "view"]:
    if state["release"] is None: sys.exit(1)
    print(json.dumps(state["release"]))
elif args[:2] == ["release", "delete-asset"]:
    pass
elif args[0] == "release" and args[1] in ["create", "edit", "upload"]:
    if args[1] == "create" and state.get("rewrite_local_on_create"):
        Path(state["rewrite_local_on_create"]).write_bytes(b"changed after verification")
    if "--notes-file" in args:
        (root / "notes.md").write_text(Path(args[args.index("--notes-file") + 1]).read_text())
    if args[1] == "upload":
        uploaded = {}
        for arg in args[3:]:
            path = Path(arg.split("#", 1)[0])
            if path.is_file():
                uploaded[path.name] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                if path.suffix == ".txt": uploaded[path.name]["text"] = path.read_text()
        (root / "uploaded.json").write_text(json.dumps(uploaded))
elif args[0] == "api":
    endpoint = args[1]
    if endpoint.endswith("/actions/runs/123/artifacts"):
        print(json.dumps({"artifacts": [{"id": i, "name": name, "size_in_bytes": 100, "expired": False}
            for i, name in state["artifacts"]]}))
    elif endpoint.endswith("/actions/runs/123"):
        print(json.dumps(state["run"]))
    elif "/actions/artifacts/" in endpoint:
        sys.stdout.buffer.write((root / (endpoint.split("/")[-2] + ".zip")).read_bytes())
    elif "/git/matching-refs/tags/" in endpoint:
        print(json.dumps([] if state["tag_sha"] is None else [{"ref": "refs/tags/v1.1.1"}]))
    elif "/commits/v1.1.1" in endpoint:
        print(state["tag_sha"])
    else: raise SystemExit("Unexpected API call: " + repr(args))
else: raise SystemExit("Unexpected command: " + repr(args))
''')
        gh.chmod(0o755)

    def promote(self, tag="v1.1.1", artifact_dir=None, cwd=None):
        (self.root / "calls.jsonl").unlink(missing_ok=True)
        (self.root / "state.json").write_text(json.dumps(self.state))
        for artifact_id, artifact_name in ARTIFACTS:
            if artifact_id == 2:
                continue
            with zipfile.ZipFile(self.root / f"{artifact_id}.zip", "w") as archive:
                for name in [*PACKAGES, WEB]:
                    if name.startswith(artifact_name + "/"):
                        archive.writestr(name.removeprefix(artifact_name + "/"), self.payload)
                for name, content in self.extra_files.items():
                    if name.startswith(artifact_name + "/"):
                        archive.writestr(name.removeprefix(artifact_name + "/"), content)
                archive.writestr("unlisted.exe", b"not in the candidate manifest")
        with zipfile.ZipFile(self.root / "2.zip", "w") as archive:
            archive.writestr("release-metadata.json", json.dumps(self.state["metadata"]))
            archive.writestr("SHA256SUMS.txt", self.manifest)
            for name, document in self.channel_files.items():
                archive.writestr(name, json.dumps(document))
        local_args = ["--artifact-dir", str(artifact_dir)] if artifact_dir is not None else []
        return subprocess.run(["bash", str(self.root / "scripts/promote-release.sh"), "--run-id", "123", "--tag", tag,
                               "--title", "Canopi 1.1.1", "--repo", "example/canopi", *local_args],
                              env={**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                                   "PROMOTION_FIXTURE": str(self.root)}, cwd=cwd, capture_output=True, text=True)

    def calls(self):
        return list(map(json.loads, (self.root / "calls.jsonl").read_text().splitlines()))

    def mutations(self):
        return [call for call in self.calls()
                if call[:1] == ["release"] and call[1] in ["create", "edit", "upload"]]

    def test_local_packages_skip_package_downloads_but_fetch_the_remote_manifest(self):
        result = self.promote(artifact_dir=self.local_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        downloads = [call[1] for call in self.calls() if call[0] == "api" and "/actions/artifacts/" in call[1]]
        self.assertEqual(downloads, ["repos/example/canopi/actions/artifacts/2/zip"])
        self.assertEqual(self.local_package.read_bytes(), self.payload)
        uploaded = json.loads((self.root / "uploaded.json").read_text())
        self.assertEqual(set(uploaded), {Path(name).name for name in PACKAGES} | set(PACKAGES.values())
                         | {Path(WEB).name, "WEB-RELEASE-SHA256SUMS.txt"}
                         | {"SHA256SUMS.txt", "RELEASE-SHA256SUMS.txt", "release-metadata.json"})

    def test_default_path_still_downloads_packages_and_ignores_unlisted_installers(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        downloads = [call[1] for call in self.calls() if call[0] == "api" and "/actions/artifacts/" in call[1]]
        self.assertEqual(len(downloads), 6)
        uploaded = json.loads((self.root / "uploaded.json").read_text())
        self.assertNotIn("unlisted.exe", uploaded)

    def test_public_checksums_cover_originals_and_identical_stable_copies(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        uploaded = json.loads((self.root / "uploaded.json").read_text())
        self.assertEqual(uploaded["SHA256SUMS.txt"]["text"], self.manifest)
        checksums = dict(line.split("  ")[::-1] for line in
                         uploaded["RELEASE-SHA256SUMS.txt"]["text"].splitlines())
        self.assertEqual(set(checksums), {Path(name).name for name in PACKAGES} | set(PACKAGES.values()))
        for original, alias in PACKAGES.items():
            self.assertEqual(uploaded[Path(original).name]["sha256"], uploaded[alias]["sha256"])
        for name, digest in checksums.items():
            self.assertEqual(uploaded[name]["sha256"], digest)
        web = Path(WEB).name
        self.assertEqual(uploaded["WEB-RELEASE-SHA256SUMS.txt"]["text"], f"{uploaded[web]['sha256']}  {web}\n")
        self.assertEqual(uploaded[web]["sha256"], hashlib.sha256(self.payload).hexdigest())

    def test_incomplete_ambiguous_unsupported_or_colliding_downloads_fail_before_mutation(self):
        complete = self.manifest
        digest = hashlib.sha256(self.payload).hexdigest()
        linux = "canopi-x86_64-unknown-linux-gnu"
        for manifest, error in [
            ("\n".join(complete.splitlines()[1:]) + "\n", "Missing required"),
            (complete + f"{digest}  ./{linux}/deb/second.deb\n", "Duplicate or colliding"),
            (complete.replace("canopi_1.1.1.deb", "canopi-linux-x64.deb"), "Duplicate or colliding"),
            (complete.replace(linux, "canopi-unknown-linux"), "Unsupported"),
            (complete + f"{digest}  ./{linux}/wrong.exe\n", "Unsupported"),
        ]:
            with self.subTest(error=error, manifest=manifest):
                self.manifest = manifest
                result = self.promote(artifact_dir=self.local_dir)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertEqual(self.mutations(), [])

    def test_next_version_keeps_stable_names_and_maps_distinct_platform_bytes(self):
        self.state["metadata"]["release_version"] = "1.2.0"
        self.manifest = ""
        expected = {}
        for name, alias in [*PACKAGES.items(), (WEB, None)]:
            versioned = name.replace("1.1.1", "1.2.0")
            payload = versioned.encode()
            (self.local_dir / versioned).write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            self.manifest += f"{digest}  ./{versioned}\n"
            expected[alias or Path(versioned).name] = digest
        result = self.promote(tag="v1.2.0", artifact_dir=self.local_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        uploaded = json.loads((self.root / "uploaded.json").read_text())
        for alias, digest in expected.items():
            self.assertEqual(uploaded[alias]["sha256"], digest)
        for name in [*PACKAGES, WEB]:
            self.assertIn(Path(name.replace("1.1.1", "1.2.0")).name, uploaded)
            self.assertNotIn(Path(name).name, uploaded)

    def test_local_files_are_snapshotted_before_release_mutation(self):
        self.state["rewrite_local_on_create"] = str(self.local_package)
        result = self.promote(artifact_dir=self.local_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        uploaded = json.loads((self.root / "uploaded.json").read_text())["canopi_1.1.1.deb"]
        self.assertEqual(uploaded["sha256"], hashlib.sha256(self.payload).hexdigest())
        self.assertNotEqual(uploaded["path"], str(self.local_package))
        stable = json.loads((self.root / "uploaded.json").read_text())["canopi-linux-x64.deb"]
        self.assertEqual(stable["sha256"], uploaded["sha256"])
        self.assertEqual(self.local_package.read_bytes(), b"changed after verification")

    def test_local_snapshot_preserves_a_package_larger_than_the_copy_buffer(self):
        self.payload = b"installer bytes" * 150000
        self.manifest = candidate_manifest(self.payload)
        for name in [*PACKAGES, WEB]:
            (self.local_dir / name).write_bytes(self.payload)
        result = self.promote(artifact_dir=self.local_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        uploaded = json.loads((self.root / "uploaded.json").read_text())["canopi_1.1.1.deb"]
        self.assertEqual(uploaded["sha256"], hashlib.sha256(self.payload).hexdigest())

    def test_the_web_archive_is_required_and_must_name_the_candidate(self):
        digest = hashlib.sha256(self.payload).hexdigest()
        desktop = "".join(line + "\n" for line in self.manifest.splitlines() if "canopi-web-edition" not in line)
        other_commit = WEB.replace("111111111111", "222222222222")
        other_version = WEB.replace("v1.1.1", "v1.1.0")
        for name in [other_commit, other_version]:
            (self.local_dir / name).write_bytes(self.payload)
        for manifest, error in [
            (desktop, "one canopi-web-edition root archive"),
            (desktop + f"{digest}  ./{other_commit}\n", "does not name this release"),
            (desktop + f"{digest}  ./{other_version}\n", "does not name this release"),
            (self.manifest + f"{digest}  ./{other_commit}\n", "Duplicate Web Edition archives"),
        ]:
            with self.subTest(error=error, manifest=manifest[-90:]):
                self.manifest = manifest
                result = self.promote(artifact_dir=self.local_dir)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertEqual(self.mutations(), [])

    def test_a_changed_web_archive_fails_its_checksum_before_mutation(self):
        (self.local_dir / WEB).write_bytes(b"changed web archive")
        result = self.promote(artifact_dir=self.local_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Checksum mismatch", result.stderr)
        self.assertEqual(self.mutations(), [])

    def test_a_missing_second_package_cannot_upload_a_partial_release(self):
        (self.local_dir / list(PACKAGES)[-1]).unlink()
        result = self.promote(artifact_dir=self.local_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_relative_artifact_directory_is_resolved_from_the_callers_directory(self):
        caller = self.root / "caller"
        caller.mkdir()
        result = self.promote(artifact_dir="../cached packages", cwd=caller)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_changed_local_packages_fail_before_release_mutation(self):
        for content in [None, b"changed package"]:
            with self.subTest(content=content):
                self.local_package.unlink(missing_ok=True)
                if content is not None:
                    self.local_package.write_bytes(content)
                result = self.promote(artifact_dir=self.local_dir)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def test_a_forged_local_manifest_cannot_admit_changed_packages(self):
        changed = b"not the candidate"
        self.local_package.write_bytes(changed)
        local_manifest = self.local_dir / "canopi-release-candidate-manifest"
        local_manifest.mkdir()
        (local_manifest / "SHA256SUMS.txt").write_text(hashlib.sha256(changed).hexdigest() + "  ./canopi-x86_64-unknown-linux-gnu/deb/canopi_1.1.1.deb\n")
        (local_manifest / "release-metadata.json").write_text(json.dumps(self.state["metadata"]))
        result = self.promote(artifact_dir=self.local_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Checksum mismatch", result.stderr)
        self.assertEqual(self.mutations(), [])

    def test_symlinked_local_package_is_rejected(self):
        real = self.root / "outside.deb"
        real.write_bytes(self.payload)
        self.local_package.unlink()
        self.local_package.symlink_to(real)
        result = self.promote(artifact_dir=self.local_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_empty_unsafe_or_duplicate_manifest_entries_cannot_mutate_a_release(self):
        digest = hashlib.sha256(self.payload).hexdigest()
        for manifest in ["", self.manifest * 2, f"{digest}  ../outside.deb\n", f"{digest}  /outside.deb\n",
                         f"{digest}  ./package#label.deb\n", "invalid\n"]:
            with self.subTest(manifest=manifest):
                self.manifest = manifest
                result = self.promote(artifact_dir=self.local_dir)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def test_new_release_targets_the_commit_that_built_the_candidate(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(call for call in self.mutations() if call[1] == "create")
        self.assertIn("--target", create)
        self.assertEqual(create[create.index("--target") + 1], SHA)
        self.assertIn("--draft", create)

    # The GeoLibre CLI sidecar links an AGPL component (THIRD_PARTY_NOTICES.md),
    # so every release body must carry the written Corresponding Source offer,
    # naming the tag whose source archive and notices file identify the exact sources.
    def test_release_body_offers_the_corresponding_source_of_the_agpl_sidecar(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        notes = (self.root / "notes.md").read_text()
        self.assertIn("## Corresponding Source", notes)
        self.assertIn("AGPL", notes)
        self.assertIn("https://github.com/example/canopi/archive/refs/tags/v1.1.1.tar.gz", notes)
        # The one root notices file from 2.1 (2.1-Q221); a 2.0.x tag's source holds the desktop/ copy.
        self.assertIn("`THIRD_PARTY_NOTICES.md` of that source (`desktop/THIRD_PARTY_NOTICES.md` before 2.1)", notes)
        self.assertIn("geolibre-rust", notes)
        self.assertIn("whitebox-wasm", notes)

    def test_tag_must_match_the_candidate_version(self):
        result = self.promote(tag="v1.2.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_only_a_successful_completed_candidate_workflow_can_be_promoted(self):
        for change in [{"conclusion": "failure"}, {"status": "in_progress"}, {"path": ".github/workflows/build.yml"}]:
            with self.subTest(change=change):
                self.state["run"] = {"path": ".github/workflows/release-candidate.yml", "head_branch": "main",
                                     "status": "completed", "conclusion": "success", **change}
                result = self.promote()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def test_a_candidate_built_by_another_branchs_copy_of_the_workflow_is_refused(self):
        """A dispatch with --ref release/2.0 runs 2.0.x's copy: no Stable-fix preflight, so only main's copy promotes."""
        self.state["run"]["head_branch"] = "release/2.0"
        result = self.promote()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--ref main -f ref=release/2.0", result.stderr)
        self.assertEqual(self.mutations(), [])

    def test_published_release_cannot_be_replaced(self):
        self.state["release"] = {"isDraft": False}
        result = self.promote()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_existing_draft_can_be_retried_at_the_same_candidate_commit(self):
        self.state["release"] = {"isDraft": True}
        self.state["tag_sha"] = SHA
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[1] for call in self.mutations()], ["edit", "upload"])
        edit = self.mutations()[0]
        self.assertEqual(edit[edit.index("--target") + 1], SHA)

    def test_re_promotion_removes_web_archives_of_an_earlier_candidate_from_the_draft(self):
        stale = "canopi-web-edition-root-v1.1.1-000000000000.tar.gz"
        current = Path(WEB).name
        self.state["release"] = {"isDraft": True, "assets": [
            {"name": stale}, {"name": current}, {"name": "canopi-linux-x64.deb"}]}
        self.state["tag_sha"] = SHA
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        deletes = [call for call in self.calls() if call[:2] == ["release", "delete-asset"]]
        self.assertEqual(deletes, [["release", "delete-asset", "v1.1.1", stale, "--repo", "example/canopi", "--yes"]])
        order = [call[1] for call in self.calls() if call[:1] == ["release"] and call[1] in ["delete-asset", "upload"]]
        self.assertEqual(order, ["delete-asset", "upload"])

    def test_existing_tag_must_resolve_to_the_candidate_commit(self):
        self.state["tag_sha"] = "3" * 40
        result = self.promote()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_candidate_metadata_must_identify_this_repository_and_a_commit(self):
        for change in [{"repository": "other/project"}, {"head_sha": "main"}]:
            with self.subTest(change=change):
                self.state["metadata"].update(repository="example/canopi", head_sha=SHA)
                self.state["metadata"].update(change)
                result = self.promote()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def updater_candidate(self, version="1.1.1", packages=PACKAGES):
        """An updater candidate (2.1-M27): each updater installer with its .sig, and the channel files it moves."""
        key = Key(os.urandom(32))
        (self.root / "desktop").mkdir(exist_ok=True)
        (self.root / "desktop/tauri.conf.json").write_text(json.dumps({"plugins": {"updater": {"pubkey": key.pubkey()}}}))
        self.state["metadata"].update(release_version=version, updater=True)
        self.local_dir = self.root / f"updater packages {version}"
        web = WEB.replace("v1.1.1", f"v{version}")
        names = [name.replace("1.1.1", version) for name in packages]
        self.extra_files = {}
        for name in [*names, web]:
            (self.local_dir / name).parent.mkdir(parents=True, exist_ok=True)
            (self.local_dir / name).write_bytes(self.payload)
            if name != web:
                self.extra_files[name] = self.payload
            if not name.endswith(".dmg") and name != web:
                self.extra_files[name + ".sig"] = key.sign(self.payload, version, Path(name).name).encode()
        for name, content in self.extra_files.items():
            (self.local_dir / name).write_bytes(content)
        self.manifest = "".join(f"{hashlib.sha256(content).hexdigest()}  ./{name}\n"
                                for name, content in [*self.extra_files.items(), (web, self.payload)])
        try:
            documents = update_channel.generate(version, self.local_dir,
                                                f"https://github.com/example/canopi/releases/download/v{version}", {})
        except update_channel.ChannelError:
            documents = {}
        self.channel_files = {update_channel.CANDIDATE_NAME.format(name): doc for name, doc in documents.items()}
        return f"v{version}"

    def test_an_updater_candidate_stages_its_signatures_and_channel_files(self):
        result = self.promote(tag=self.updater_candidate(), artifact_dir=self.local_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        uploaded = json.loads((self.root / "uploaded.json").read_text())
        self.assertTrue({"channel-stable.json", "channel-beta.json", "canopi_1.1.1.deb.sig",
                         "Canopi_1.1.1_x64_en-US.msi.sig"} <= set(uploaded))
        self.assertNotIn("stable.json", uploaded)
        self.assertIn("update_channel.py publish --tag v1.1.1", result.stdout + result.stderr)

    def test_an_updater_candidate_without_a_signature_or_channel_file_uploads_nothing(self):
        for change, error in [("sig", "unsigned updater artifact"), ("channel", "no stable.json")]:
            with self.subTest(change=change):
                tag = self.updater_candidate()
                if change == "sig":
                    sig = next(name for name in self.extra_files if name.endswith(".AppImage.sig"))
                    del self.extra_files[sig]
                    (self.local_dir / sig).unlink()
                    self.manifest = "".join(line + "\n" for line in self.manifest.splitlines() if sig not in line)
                else:
                    del self.channel_files["channel-stable.json"]
                result = self.promote(tag=tag, artifact_dir=self.local_dir)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertEqual(self.mutations(), [])

    def test_a_beta_is_a_pre_release_never_latest_and_publishes_no_web(self):
        """2.1-M205 and 2.1-Q201: betas live on the releases page only, NSIS only, and no Web Edition deploys."""
        beta = {name: alias for name, alias in PACKAGES.items() if not name.endswith(".msi")}
        tag = self.updater_candidate("1.2.0-beta.1", beta)
        result = self.promote(tag=tag, artifact_dir=self.local_dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(call for call in self.mutations() if call[1] == "create")
        self.assertIn("--prerelease", create)
        self.assertIn("--latest=false", create)
        uploaded = json.loads((self.root / "uploaded.json").read_text())
        self.assertNotIn("WEB-RELEASE-SHA256SUMS.txt", uploaded)
        self.assertFalse([name for name in uploaded if name.startswith("canopi-web-edition")])
        self.assertEqual({"channel-beta.json"}, {name for name in uploaded if name.startswith("channel-")})
        self.assertNotIn("publish-web-release.sh", result.stdout + result.stderr)

    def test_a_beta_with_an_msi_is_refused(self):
        tag = self.updater_candidate("1.2.0-beta.1")
        result = self.promote(tag=tag, artifact_dir=self.local_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("a beta ships no MSI", result.stderr)
        self.assertEqual(self.mutations(), [])

    def test_a_stable_release_becomes_latest_and_still_publishes_the_web_edition(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(call for call in self.mutations() if call[1] == "create")
        self.assertIn("--latest", create)
        self.assertNotIn("--prerelease", create)
        self.assertIn("publish-web-release.sh --tag v1.1.1", result.stdout + result.stderr)

    def test_the_linux_checksums_list_the_appimage_and_the_deb(self):
        """2.1-Q126: Linux is the AppImage and .deb downloads, both in the public checksums."""
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        checksums = json.loads((self.root / "uploaded.json").read_text())["RELEASE-SHA256SUMS.txt"]["text"]
        for name in ["canopi-linux-x64.AppImage", "canopi-linux-x64.deb", "Canopi_1.1.1_amd64.AppImage",
                     "canopi_1.1.1.deb"]:
            self.assertIn(f"  {name}\n", checksums)

    def test_promotion_never_touches_an_earlier_release(self):
        """ADR 0026 Rollback: hand installs of the previous release keep its assets; only this tag changes."""
        self.state["release"] = {"isDraft": True, "assets": [
            {"name": "canopi-web-edition-root-v1.1.1-000000000000.tar.gz"}]}
        self.state["tag_sha"] = SHA
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        for call in self.calls():
            if call[:1] == ["release"]:
                self.assertEqual(call[2], "v1.1.1", call)


if __name__ == "__main__":
    unittest.main()
