"""Web Edition release tooling: archive admission, the N-1 merge, deploy files, live checks and the catalog asset."""
import functools
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
from unittest import mock

from scripts import web_release, web_release_package
from scripts.test_generate_web_catalog import create_export_fixture, generator

LOCKFILE = Path(__file__).resolve().parent.parent / "desktop/web/package-lock.json"
LOCKED_PLAYWRIGHT = json.loads(LOCKFILE.read_text())["packages"]["node_modules/@playwright/test"]["version"]
COMMIT = "abcdef012345" + "6" * 28
PREVIOUS_COMMIT = "0123456789ab"
MAX_BYTES = 4000
CATALOG_MANIFEST = json.dumps(
    {"assets": {"species": [{"path": "species/species-0000.parquet"}],
                "names": {"en": {"path": "names/names-en.parquet"}}, "images": []}}).encode()
CATALOG_ID = hashlib.sha256(CATALOG_MANIFEST).hexdigest()[:16]
CATALOG = f"assets/catalog/{CATALOG_ID}/"
SPECIES = CATALOG + "species/species-0000.parquet"
NAMES = CATALOG + "names/names-en.parquet"
OLD_CATALOG = "assets/catalog/00000000000000aa/"


def site_files():
    """Release N: every file except index.html and the manifest carries a content id under assets/."""
    return {
        "index.html": b'<!doctype html><title>Canopi</title><script type="module" crossorigin src="/assets/web-AbCd1234AbCd1234.js"></script>',
        "assets/web-AbCd1234AbCd1234.js": b"console.log('canopi')",
        "assets/web-Ef_h5678Ef_h5678.css": b"body{}",
        "assets/canopi-logo-Ij-l9012Ij-l9012.svg": b"<svg/>",
        "assets/font-Mn0p3456Mn0p3456.woff2": b"woff2",
        "assets/NotoSans-Regular-Qr4s7890Qr4s7890.ttf": b"ttf",
        CATALOG + "manifest.json": CATALOG_MANIFEST,
        SPECIES: b"PAR1" + bytes(range(256)) + b"PAR1",
        NAMES: b"PAR1names" + bytes(150) + b"PAR1",
    }


def manifest_for(files, version="2.1.0", commit=COMMIT[:12], **changes):
    catalog_files = sorted(path for path in files if path.endswith(".parquet"))
    manifest = {
        "name": "Canopi Web Edition", "version": version, "commit": commit,
        "catalog": {"manifestPath": CATALOG + "manifest.json", "files": catalog_files},
        "files": [{"path": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for path, data in sorted(files.items())],
    }
    manifest.update(changes)
    return manifest


def previous_files():
    """Release N-1 as 2.0.3 shipped it: every file under assets/ but index.html (canopi-eon8.19)."""
    return {
        "index.html": b'<!doctype html><title>Canopi</title><script type="module" src="/assets/web-OLD00001.js"></script>',
        "assets/web-OLD00001.js": b"console.log('old')",
        "assets/job-OLD00002OLD00002.js": b"export const lazy = 1",
        "assets/font-Mn0p3456Mn0p3456.woff2": b"woff2",
        OLD_CATALOG + "manifest.json": b'{"assets": {"species": [{"path": "species/species-0000.parquet"}]}}',
        OLD_CATALOG + "species/species-0000.parquet": b"PAR1old-species",
    }


def previous_manifest(files, version="2.0.9"):
    """As 2.0.3 shipped it: its manifest also declared basePath, spaFallback and limits, which N-1 may carry."""
    return manifest_for(files, version=version, commit=PREVIOUS_COMMIT, basePath="/", spaFallback={"source": "/*"},
                        limits={"cloudflarePagesMaxAssetBytes": 10 ** 9, "cloudflarePagesMaxFiles": 10 ** 6}, catalog={
        "manifestPath": OLD_CATALOG + "manifest.json", "files": [OLD_CATALOG + "species/species-0000.parquet"]})


def write_tree(root, files, manifest):
    for path, data in {**files, web_release.MANIFEST_NAME: json.dumps(manifest).encode()}.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(data)


def tree(root):
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}


class ArchiveCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.archive = self.root / f"canopi-web-edition-root-v2.1.0-{COMMIT[:12]}.tar.gz"
        # The release constants, small enough for a test tree.
        limits = mock.patch.multiple(web_release_package, MAX_ASSET_BYTES=MAX_BYTES, MAX_FILES=20)
        limits.start()
        self.addCleanup(limits.stop)

    def build(self, files=None, manifest=None, extra=None, archive=None):
        files = site_files() if files is None else files
        manifest = manifest_for(files) if manifest is None else manifest
        archive = archive or self.archive
        source = self.root / f"source-{archive.name}"
        shutil.rmtree(source, ignore_errors=True)
        archive.unlink(missing_ok=True)
        if archive == self.archive:
            shutil.rmtree(self.root / "site", ignore_errors=True)
        write_tree(source, {**files, **(extra or {})}, manifest)
        web_release.deterministic_tar_gz(source, archive)
        checksums = archive.parent / "WEB-RELEASE-SHA256SUMS.txt"
        checksums.write_text(f"{web_release.sha256_file(archive)}  {archive.name}\n")
        return checksums

    def verify(self, checksums=None):
        return web_release.verify_archive(self.archive, version="2.1.0", commit=COMMIT, checksums=checksums,
                                          output_dir=self.root / "site")

    def assert_rejected(self, pattern, checksums=None):
        with self.assertRaisesRegex(web_release.ReleaseError, pattern):
            self.verify(checksums)


class ArchiveTests(ArchiveCase):
    def test_a_valid_archive_is_admitted_and_receives_the_deploy_files(self):
        checksums = self.build()
        identity = self.verify(checksums)
        self.assertEqual((identity.version, identity.commit, identity.files), ("2.1.0", COMMIT[:12], 10))
        site = self.root / "site"
        web_release.add_deploy_files(site)
        headers = (site / "_headers").read_text()
        self.assertIn("/assets/*\n  Cache-Control: public, max-age=31536000, immutable", headers)
        self.assertIn("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin", headers)
        self.assertEqual((site / "assets/404.html").read_bytes(), b"")
        self.assertFalse((site / "404.html").exists())
        self.assertFalse((site / "_redirects").exists())

    def test_the_archive_is_deterministic(self):
        self.build()
        first = self.archive.read_bytes()
        self.archive.unlink()
        self.build()
        self.assertEqual(first, self.archive.read_bytes())

    def test_unsafe_tar_entries_are_rejected_before_anything_is_written(self):
        def entry(name, kind=tarfile.REGTYPE, link=""):
            info = tarfile.TarInfo(name)
            info.type = kind
            info.linkname = link
            return info
        for info in [entry("/etc/passwd"), entry("../outside.js"), entry("assets/../../outside.js"),
                     entry("assets/link.js", tarfile.SYMTYPE, "/etc/passwd"),
                     entry("assets/hard.js", tarfile.LNKTYPE, "index.html"),
                     entry("dev/null", tarfile.CHRTYPE), entry("assets/fifo", tarfile.FIFOTYPE)]:
            with self.subTest(name=info.name, type=info.type):
                self.archive.unlink(missing_ok=True)
                with tarfile.open(self.archive, "w:gz") as tar:
                    tar.addfile(tarfile.TarInfo("index.html"), io.BytesIO(b""))
                    tar.addfile(info, io.BytesIO(b""))
                output = self.root / f"site-{info.type}-{len(info.name)}"
                with self.assertRaises(web_release.ReleaseError):
                    web_release.safe_extract(self.archive, output)
                self.assertEqual(list(output.iterdir()), [])
                self.assertFalse((self.root.parent / "outside.js").exists())

    def test_checksum_mismatch_or_absence_is_rejected(self):
        checksums = self.build()
        checksums.write_text("0" * 64 + f"  {self.archive.name}\n")
        self.assert_rejected("checksum mismatch", checksums)
        checksums.write_text("0" * 64 + "  other.tar.gz\n")
        self.assert_rejected("does not list", checksums)

    def test_unlisted_files_are_rejected(self):
        self.build(extra={"assets/extra-AbCd1234AbCd1234.js": b"not in the manifest"})
        self.assert_rejected("unlisted file: assets/extra-AbCd1234AbCd1234.js")

    def test_a_listed_file_with_other_bytes_is_rejected(self):
        files = site_files()
        manifest = manifest_for(files)
        files["assets/web-AbCd1234AbCd1234.js"] = b"console.log('changed')"
        self.build(files, manifest)
        self.assert_rejected("differs for assets/web-AbCd1234AbCd1234.js")

    def test_version_and_commit_must_be_the_release(self):
        files = site_files()
        self.build(files, manifest_for(files, version="2.0.0"))
        self.assert_rejected("version")
        self.archive.unlink()
        self.build(files, manifest_for(files, commit="0" * 12))
        self.assert_rejected("not the release commit")
        # `web_release.py package` records 12 characters, as the archive name does.
        self.build(files, manifest_for(files, commit=COMMIT))
        self.assert_rejected("is not a commit")

    def test_oversize_files_and_file_count_are_rejected(self):
        files = site_files()
        files["assets/big-AbCd1234AbCd1234.js"] = b"x" * (MAX_BYTES + 1)
        self.build(files)
        self.assert_rejected("above the Pages limit 4000")
        files = site_files()
        files.update({f"assets/n{index}-AbCd1234AbCd1234.js": b"" for index in range(12)})
        self.archive.unlink()
        self.build(files)
        self.assert_rejected("files, above the Pages limit 20")

    def test_a_google_maps_key_is_rejected(self):
        files = site_files()
        files["assets/web-AbCd1234AbCd1234.js"] = b"const key = 'AIza" + b"Sy" + b"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p'"
        self.build(files)
        self.assert_rejected("Google Maps key found in assets/web-AbCd1234AbCd1234.js")

    def test_raw_duckdb_wasm_and_deploy_owned_files_are_rejected(self):
        cases = [("assets/duckdb-eh-AbCd1234AbCd1234.wasm", "raw DuckDB"), ("_redirects", "deploy-owned"),
                 ("404.html", "deploy-owned"), ("assets/_headers", "deploy-owned")]
        for index, (path, pattern) in enumerate(cases):
            with self.subTest(path=path):
                files = site_files()
                files[path] = b"x"
                self.archive.unlink(missing_ok=True)
                self.build(files)
                with self.assertRaisesRegex(web_release.ReleaseError, pattern):
                    web_release.verify_archive(self.archive, version="2.1.0", output_dir=self.root / f"site-{index}")

    def test_missing_index_or_catalog_assets_are_rejected(self):
        files = site_files()
        manifest = manifest_for(files)
        del files[NAMES]
        manifest["files"] = [entry for entry in manifest["files"] if entry["path"] != NAMES]
        self.build(files, manifest)
        self.assert_rejected(f"catalog asset missing: {NAMES}")
        files = site_files()
        del files["index.html"]
        self.archive.unlink()
        self.build(files)
        self.assert_rejected("index.html is missing")

    def test_the_archive_name_must_name_the_release(self):
        self.build()
        self.archive = self.archive.rename(self.root / "canopi-web-edition-v2.1.0-abcdef012345.tar.gz")
        self.assert_rejected("not the root Web Edition archive")

    def test_a_catalog_id_that_is_not_the_hash_of_its_manifest_is_refused(self):
        files = {path.replace(CATALOG_ID, "0123456789abcdef"): data for path, data in site_files().items()}
        self.build(files, manifest_for(files, catalog={
            "manifestPath": "assets/catalog/0123456789abcdef/manifest.json",
            "files": sorted(path for path in files if path.endswith(".parquet"))}))
        self.assert_rejected("catalog id 0123456789abcdef is not the hash of its manifest")


class MergeCase(ArchiveCase):
    """N verified into a site, N-1 verified beside it."""

    def build_previous(self, files=None, manifest=None, extra=None, version="2.0.9"):
        files = previous_files() if files is None else files
        manifest = previous_manifest(files, version) if manifest is None else manifest
        self.previous_archive = self.root / "previous" / f"canopi-web-edition-root-v{version}-{PREVIOUS_COMMIT}.tar.gz"
        self.previous_archive.parent.mkdir(exist_ok=True)
        return self.build(files, manifest, extra, archive=self.previous_archive)

    def verify_previous(self, checksums, version="2.0.9"):
        output = self.root / "previous-site"
        shutil.rmtree(output, ignore_errors=True)
        web_release.verify_previous(self.previous_archive, version=version, checksums=checksums, output_dir=output)
        return output

    def merged(self, files=None, previous=None):
        """Verify N and N-1 and merge them; return the site."""
        checksums = self.build(files)
        self.verify(checksums)
        previous_site = self.verify_previous(self.build_previous(previous))
        web_release.merge_previous(self.root / "site", previous_site)
        return self.root / "site"


class MergeTests(MergeCase):
    def test_the_merged_set_holds_n_minus_1s_verified_files_and_drops_n_minus_2_only_ones(self):
        """the merged set holds N-1's verified files and drops N-2-only ones"""
        self.verify(self.build())
        previous_site = self.verify_previous(self.build_previous())
        # N-1's deployment also served N-2's files. Put them where a merge that read a directory instead of N-1's
        # manifest would find them: beside N-1's verified files.
        n2_only = {"assets/web-N2ONLY01.js": b"n-2", OLD_CATALOG + "species/species-n2.parquet": b"PAR1 n-2"}
        for path, data in n2_only.items():
            (previous_site / path).parent.mkdir(parents=True, exist_ok=True)
            (previous_site / path).write_bytes(data)
        merge = web_release.merge_previous(self.root / "site", previous_site)
        site = self.root / "site"
        expected = set(site_files()) | set(previous_files()) | {web_release.MANIFEST_NAME}
        self.assertEqual(tree(site), expected)
        self.assertEqual(sorted(merge.carried), sorted(set(previous_files()) - set(site_files())))
        for path in n2_only:
            self.assertFalse((site / path).exists(), path)
        for path, data in previous_files().items():
            if path != "index.html":
                self.assertEqual((site / path).read_bytes(), data, path)
        # This release's own manifest, untouched: it names only N's files.
        manifest = json.loads((site / web_release.MANIFEST_NAME).read_text())
        self.assertEqual(manifest["version"], "2.1.0")
        self.assertNotIn("assets/job-OLD00002OLD00002.js", {entry["path"] for entry in manifest["files"]})

    def test_on_a_shared_path_this_releases_file_wins_and_a_differing_collision_fails_the_release(self):
        """on a shared path this release's file wins, and a differing collision outside index.html, the manifest,
        sw.js (from W1) and the deploy-owned files fails the release"""
        files = {**site_files(), "sw.js": b"self.version = 'N'"}
        previous = {**previous_files(), "sw.js": b"self.version = 'N-1'"}
        site = self.merged(files, previous)
        for path in ["index.html", "sw.js"]:
            self.assertEqual((site / path).read_bytes(), files[path], path)
        self.assertEqual(json.loads((site / web_release.MANIFEST_NAME).read_text())["version"], "2.1.0")
        # An identical shared file is no collision.
        self.assertEqual((site / "assets/font-Mn0p3456Mn0p3456.woff2").read_bytes(), b"woff2")

        previous = {**previous_files(), "assets/web-AbCd1234AbCd1234.js": b"other bytes", "assets/NotoSans-Regular-Qr4s7890Qr4s7890.ttf": b"x"}
        checksums = self.build()
        self.verify(checksums)
        before = tree(self.root / "site")
        previous_site = self.verify_previous(self.build_previous(previous))
        with self.assertRaises(web_release.ReleaseError) as raised:
            web_release.merge_previous(self.root / "site", previous_site)
        message = str(raised.exception)
        for path in ["assets/web-AbCd1234AbCd1234.js", "assets/NotoSans-Regular-Qr4s7890Qr4s7890.ttf"]:
            self.assertIn(path, message)
        self.assertIn(hashlib.sha256(b"other bytes").hexdigest(), message)
        self.assertIn(hashlib.sha256(site_files()["assets/web-AbCd1234AbCd1234.js"]).hexdigest(), message)
        # Nothing was copied before the collision failed the release.
        self.assertEqual(tree(self.root / "site"), before)

    def test_the_manifest_is_the_only_no_cache_file_this_release_writes(self):
        """the manifest is the only no-cache file this release writes"""
        policies = {path: web_release.cache_policy(path) for path in [*site_files(), web_release.MANIFEST_NAME]}
        self.assertEqual([path for path, policy in policies.items() if policy == "no-cache"], [web_release.MANIFEST_NAME])
        self.assertEqual(policies["index.html"], "revalidate")
        self.assertTrue(all(policy == "immutable" for path, policy in policies.items() if path.startswith("assets/")))
        # The generated rules match: no /index.html rule (Pages redirects it to /), and no rule for a directory
        # this release does not carry.
        checksums = self.build()
        self.verify(checksums)
        web_release.add_deploy_files(self.root / "site")
        alone = (self.root / "site/_headers").read_text()
        self.assertEqual(re.findall(r"^(/\S*)$", alone, re.M), [f"/{web_release.MANIFEST_NAME}", "/assets/*", "/*"])
        self.assertNotIn("/index.html", alone)
        # N-1's carried files are all under assets/, so the merged set has the same rules (canopi-eon8.19).
        site = self.merged()
        web_release.add_deploy_files(site)
        merged = (site / "_headers").read_text()
        self.assertEqual(re.findall(r"^(/\S*)$", merged, re.M), [f"/{web_release.MANIFEST_NAME}", "/assets/*", "/*"])
        self.assertEqual((site / "assets/404.html").read_bytes(), b"")
        self.assertFalse((site / "404.html").exists())

    def test_the_file_limits_run_on_the_merged_set(self):
        # Ten carried files push the merged set over the 20-file limit; each artifact alone is under it.
        previous = {**previous_files(), **{f"assets/old{index}-OLD0000{index}.js": b"old" for index in range(10)}}
        checksums = self.build()
        self.verify(checksums)
        previous_site = self.verify_previous(self.build_previous(previous))
        with self.assertRaisesRegex(web_release.ReleaseError, r"merged set: \d+ files, above the Pages limit 20"):
            web_release.merge_previous(self.root / "site", previous_site)
        # A file over 25 MiB (here the test limit) fails N-1 before any merge, whatever limits its manifest declares.
        previous = {**previous_files(), "assets/big-OLD0000000000000.parquet": b"x" * (MAX_BYTES + 1)}
        with self.assertRaisesRegex(web_release.ReleaseError, "big-OLD0000000000000.parquet is 4001 bytes, above the Pages limit 4000"):
            self.verify_previous(self.build_previous(previous))

    def test_an_unverifiable_n_minus_1_fails_before_any_deploy(self):
        """an unverifiable N-1 fails before any deploy"""
        checksums = self.build_previous()
        checksums.write_text("0" * 64 + f"  {self.previous_archive.name}\n")
        with self.assertRaisesRegex(web_release.ReleaseError, "checksum mismatch"):
            self.verify_previous(checksums)
        checksums.write_text("")
        with self.assertRaisesRegex(web_release.ReleaseError, "does not list"):
            self.verify_previous(checksums)
        files = previous_files()
        manifest = previous_manifest(files)
        files["assets/web-OLD00001.js"] = b"console.log('OLD')"
        with self.assertRaisesRegex(web_release.ReleaseError, "checksum differs for assets/web-OLD00001.js"):
            self.verify_previous(self.build_previous(files, manifest))
        with self.assertRaisesRegex(web_release.ReleaseError, "unlisted file: assets/stray.js"):
            self.verify_previous(self.build_previous(extra={"assets/stray.js": b"stray"}))
        with self.assertRaisesRegex(web_release.ReleaseError, "manifest version is '2.0.8', expected '2.0.9'"):
            files = previous_files()
            manifest = previous_manifest(files, "2.0.8")
            self.build_previous(files, manifest)
            self.verify_previous(self.previous_archive.parent / "WEB-RELEASE-SHA256SUMS.txt")
        with self.assertRaisesRegex(web_release.ReleaseError, "deploy-owned"):
            self.verify_previous(self.build_previous({**previous_files(), "_redirects": b"/* /x 200"}))

    def test_a_mutable_catalog_or_font_path_among_this_releases_files_or_n_minus_1s_is_refused(self):
        """a mutable catalog or font path among this release's files or N-1's is refused (canopi-eon8.19)"""
        for index, path in enumerate(["canopi-catalog/names/names-en.parquet", "pdf-fonts/NotoSans-Regular.ttf",
                                      "assets/logo.svg", "favicon.ico",
                                      # Words that merely look like a hash after a hyphen, and an unverified id.
                                      "assets/NotoSans-SemiBold.ttf", "assets/catalog-manifest.json",
                                      "assets/web-AbCd1234.js", "assets/0123456789abcdef/x.bin"]):
            with self.subTest(path=path):
                files = site_files()
                files[path] = b"mutable"
                self.archive.unlink(missing_ok=True)
                self.build(files)
                with self.assertRaisesRegex(web_release.ReleaseError, f"mutable name: {re.escape(path)}"):
                    web_release.verify_archive(self.archive, version="2.1.0", output_dir=self.root / f"mutable-{index}")
        # 2.0.2's mutable names no longer arrive from N-1: the merge refuses them before copying anything.
        self.archive.unlink()
        with self.assertRaisesRegex(web_release.ReleaseError, "2.0.9 names pdf-fonts/NotoSans-Regular.ttf, outside assets/"):
            self.merged(previous={**previous_files(), "pdf-fonts/NotoSans-Regular.ttf": b"old ttf"})
        self.assertNotIn("pdf-fonts/NotoSans-Regular.ttf", tree(self.root / "site"))

    def test_the_skew_check_needs_n_minus_1s_pdf_chunk_to_be_absent_from_this_release(self):
        """Before any deploy: the deploy-skew spec drives the PDF export, so N-1's job chunk must be one N lacks."""
        site = self.merged()
        self.assertEqual(web_release.skew_chunks(site, self.root / "previous-site"), ["assets/job-OLD00002OLD00002.js"])
        # A release whose PDF chunk is byte-identical to N-1's leaves the check nothing to prove.
        shared = {**site_files(), "assets/job-OLD00002OLD00002.js": previous_files()["assets/job-OLD00002OLD00002.js"]}
        self.archive.unlink()
        shutil.rmtree(self.root / "site")
        site = self.merged(files=shared)
        with self.assertRaisesRegex(web_release.ReleaseError, "deploy-skew check would prove nothing.*job-OLD00002OLD00002"):
            web_release.skew_chunks(site, self.root / "previous-site")
        # The operator's override accepts that: the tab still runs, with no chunk to prove.
        self.assertEqual(web_release.skew_chunks(site, self.root / "previous-site", allow_none=True), [])

    def test_only_the_pdf_job_entry_counts_as_the_skew_chunk(self):
        """`assets/job-<16 characters>.js` is the PDF job entry; job-<8>, before 2.0.3, or another job-... is not."""
        previous = {**previous_files(), "assets/job-runner-AbCd1234AbCd1234.js": b"other lazy module",
                    "assets/job-AbCd1234.js": b"a 2.0.2 job chunk"}
        del previous["assets/job-OLD00002OLD00002.js"]
        site = self.merged(previous=previous)
        for allow_none in (False, True):
            with self.assertRaises(web_release.ReleaseError) as raised:
                web_release.skew_chunks(site, self.root / "previous-site", allow_none=allow_none)
            self.assertIn("N-1 lists no assets/job-<hash>.js", str(raised.exception))
            self.assertNotIn("--allow-unchanged-pdf-chunk", str(raised.exception))

    def test_n_minus_1_is_verified_without_this_releases_layout_rules(self):
        # 2.0.3's manifest fields (basePath, spaFallback, limits) and unhashed names pass the light verify.
        site = self.verify_previous(self.build_previous())
        self.assertIn("assets/web-OLD00001.js", tree(site))


def fake_gh(releases):
    """A `gh` boundary: `releases` maps a tag to its asset names, in `gh release list` order."""
    calls = []

    def run(args):
        calls.append(args)
        if args[:2] == ["release", "list"]:
            return json.dumps([{"tagName": tag} for tag in releases])
        if args[:2] == ["release", "view"]:
            return "\n".join(releases[args[2]]) + "\n"
        raise AssertionError(args)
    return run, calls


def serving(version, status=200):
    body = json.dumps({"version": version}).encode() if version else b"Not Found"
    return lambda url, headers=None: web_release.Response(status, {}, body)


class PreviousSelectionTests(unittest.TestCase):
    RELEASES = {
        "v2.1.0": ["canopi-web-edition-root-v2.1.0-aaaaaaaaaaaa.tar.gz"],
        "v2.0.10": ["Canopi_2.0.10_amd64.deb"],
        "v2.0.9": ["canopi-web-edition-root-v2.0.9-bbbbbbbbbbbb.tar.gz", "WEB-RELEASE-SHA256SUMS.txt"],
        "v2.0.8": ["canopi-web-edition-root-v2.0.8-cccccccccccc.tar.gz"],
        "v1.9.0": ["canopi-web-edition-root-v1.9.0-dddddddddddd.tar.gz"],
    }

    def previous(self, version="2.1.0", production="2.0.9", releases=None, **options):
        run, calls = fake_gh(self.RELEASES if releases is None else releases)
        self.calls = calls
        return web_release.previous_release(version, repo="example/canopi", production_url="https://example.test",
                                            get=serving(production, 200 if production else 404), run_gh=run, **options)

    def test_previous_selection_picks_the_greatest_published_stable_below_n_with_a_web_archive(self):
        self.assertEqual(self.previous(), "v2.0.9")
        listing = self.calls[0]
        self.assertIn("--exclude-drafts", listing)
        self.assertIn("--exclude-pre-releases", listing)
        # A re-run after N went live picks the same N-1.
        self.assertEqual(self.previous(production="2.1.0"), "v2.0.9")
        self.assertEqual(self.previous(previous_tag="v2.0.8", production="2.0.8"), "v2.0.8")

    def test_production_serving_neither_n_minus_1_nor_n_fails_and_names_the_versions(self):
        with self.assertRaisesRegex(web_release.ReleaseError, "serves 2.0.8, neither N-1 2.0.9 nor N 2.1.0.*--previous-tag"):
            self.previous(production="2.0.8")
        with self.assertRaisesRegex(web_release.ReleaseError, "serves no manifest"):
            self.previous(production=None)

    def test_no_previous_is_refused_while_production_serves_a_manifest(self):
        with self.assertRaisesRegex(web_release.ReleaseError, "--no-previous is refused.*serves 2.0.9"):
            self.previous(no_previous=True)
        self.assertIsNone(self.previous(production=None, no_previous=True, releases={}))

    def test_canopi_eon8_15_an_html_or_unparsable_manifest_answer_is_unreadable_and_refuses_no_previous(self):
        # Pages answers a missing root file of a deployed site with the app's HTML: production lost its manifest.
        html = lambda url, headers=None: web_release.Response(
            200, {"content-type": "text/html; charset=utf-8"}, b"<!doctype html><html></html>")
        broken = lambda url, headers=None: web_release.Response(200, {"content-type": "application/json"}, b"{")
        for answer in (html, broken):
            with self.assertRaisesRegex(web_release.ReleaseError, "unreadable"):
                web_release.serving_version("https://example.test", answer)
        run, _ = fake_gh({})
        with self.assertRaisesRegex(web_release.ReleaseError, "unreadable"):
            web_release.previous_release("2.1.0", repo="example/canopi", production_url="https://example.test",
                                         no_previous=True, get=html, run_gh=run)

    def test_a_first_release_without_no_previous_fails(self):
        with self.assertRaisesRegex(web_release.ReleaseError, "no published stable release below 2.1.0 carries a Web archive"):
            self.previous(production=None, releases={"v2.1.0": []})


class PublishScriptTests(MergeCase):
    """publish-web-release.sh with local GitHub, Cloudflare and Playwright boundaries."""

    def setUp(self):
        super().setUp()
        self.production = self.serve("production")
        self.preview = self.serve("preview")

    def serve(self, name):
        directory = self.root / f"served-{name}"
        directory.mkdir()
        handler = functools.partial(QuietHandler, directory=str(directory))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return directory, f"http://127.0.0.1:{server.server_port}"

    def publish(self, *extra, draft=False, release_checksums=None, previous=None, deploys_succeed=False, skew_tab="ok",
                n_deploy_fails=False, skew_timeout="30", tag="v2.1.0", pull_fails=False,
                previous_sha=PREVIOUS_COMMIT + "c" * 28, image_local=False, installed=None):
        checksums = self.build({**site_files(), **getattr(self, "site_extra", {})})
        previous_checksums = self.build_previous(previous)
        (self.production[0] / web_release.MANIFEST_NAME).write_text(json.dumps(previous_manifest(previous_files())))
        published = self.root / "published"
        (published / "v2.1.0").mkdir(parents=True, exist_ok=True)
        (published / "v2.0.9").mkdir(parents=True, exist_ok=True)
        shutil.copy(release_checksums or checksums, published / "v2.1.0" / checksums.name)
        shutil.copy(self.archive, published / "v2.1.0" / self.archive.name)
        shutil.copy(previous_checksums, published / "v2.0.9" / previous_checksums.name)
        shutil.copy(self.previous_archive, published / "v2.0.9" / self.previous_archive.name)
        fake = self.root / "bin"
        fake.mkdir(exist_ok=True)
        (fake / "gh").write_text(f"""#!/usr/bin/env bash
echo "gh $*" >> {self.root}/calls
case "$1 $2" in
  "release view")
    if [[ "$*" == *"--json assets"* ]]; then ls {published}/"$3"; exit 0; fi
    printf '%s\\n' {"true" if draft else "false"} ;;
  "release list") printf '%s\\n' '[{{"tagName": "v2.1.0"}}, {{"tagName": "v2.0.9"}}]' ;;
  "api repos/example/canopi/commits/v2.1.0") printf '%s\\n' {COMMIT} ;;
  "api repos/example/canopi/commits/v2.0.9") printf '%s\\n' {previous_sha} ;;
  "release download")
    tag="$3"
    for arg; do
      if [[ "$prev" == --dir ]]; then dir="$arg"; fi
      if [[ "$prev" == --pattern ]]; then cp {published}/"$tag"/$arg "$dir/" 2>/dev/null || true; fi
      prev="$arg"
    done ;;
  *) exit 1 ;;
esac
""")
        # npx: `wrangler pages deploy <dir> --project-name <p>` publishes <dir>'s manifest on the matching server.
        (fake / "npx").write_text(f"""#!/usr/bin/env bash
echo "npx $*" >> {self.root}/calls
{"" if deploys_succeed else "exit 1"}
dir="$5"
{'if [[ "$dir" == */site ]]; then exit 1; fi' if n_deploy_fails else ""}
for arg; do if [[ "$prev" == --project-name ]]; then project="$arg"; fi; prev="$arg"; done
if [[ "$project" == canopi-web-preview ]]; then target={self.preview[0]}; else target={self.production[0]}; fi
cp "$dir/{web_release.MANIFEST_NAME}" "$target/"
echo "Deployment complete! Take a peek over at https://1a2b3c4d.$project.pages.dev"
""")
        # docker: the deploy-skew container (`--name`) writes n1-ready, then waits for n-deployed; the smoke fails.
        # `skew_tab="hang"` never reports n1-ready. `docker rm -f <name>` stops a running container.
        containers = self.root / "containers"
        containers.mkdir(exist_ok=True)
        (fake / "docker").write_text(f"""#!/usr/bin/env bash
echo "docker $*" >> {self.root}/calls
if [[ "$1 $2" == "image inspect" ]]; then {"exit 0" if image_local else "exit 1"}; fi
if [[ "$1" == pull ]]; then {"exit 1" if pull_fails else "exit 0"}; fi
if [[ "$1" == rm ]]; then
  name="${{@: -1}}"
  if [[ -f {containers}/"$name" ]]; then kill "$(cat {containers}/"$name")" 2>/dev/null; rm -f {containers}/"$name"; fi
  exit 0
fi
for arg; do
  if [[ "$prev" == -v && "$arg" == *:/results ]]; then results="${{arg%:/results}}"; fi
  if [[ "$arg" == CANOPI_WEB_RELEASE_OUTPUT=/results/* ]]; then output="${{arg#CANOPI_WEB_RELEASE_OUTPUT=/results/}}"; fi
  if [[ "$prev" == -v && "$arg" == *:/handoff ]]; then handoff="${{arg%:/handoff}}"; fi
  if [[ "$prev" == --name ]]; then name="$arg"; fi
  prev="$arg"
done
if [[ -n "$results" && -n "$output" ]]; then mkdir -p "$results/$output"; echo trace > "$results/$output/trace.zip"; fi
if [[ -z "$handoff" ]]; then exit 1; fi
echo "skew chunks: $(tr '\\n' ' ' < "$handoff/carried-chunks")" >> {self.root}/calls
echo $$ > {containers}/"$name"
{"exec sleep 300" if skew_tab == "hang" else ""}
touch "$handoff/n1-ready"
for _ in $(seq 100); do
  if [[ -f "$handoff/n-deployed" ]]; then echo "skew: N deployed" >> {self.root}/calls; exit 0; fi
  sleep 0.1
done
exec sleep 300
""")
        for tool in fake.iterdir():
            tool.chmod(0o755)
        script = Path(__file__).with_name("publish-web-release.sh")
        # A checkout whose desktop/web/node_modules holds @playwright/test `installed` (by default the locked
        # version) beside the real lockfile, so no test depends on the host checkout's last `npm ci`.
        repo = self.root / "repo"
        (repo / "scripts").mkdir(parents=True, exist_ok=True)
        runner = repo / "desktop/web/node_modules/@playwright/test"
        runner.mkdir(parents=True, exist_ok=True)
        for name in ("publish-web-release.sh", "web_release.py"):
            if not (repo / "scripts" / name).exists():
                (repo / "scripts" / name).symlink_to(script.with_name(name))
        if not (repo / "desktop/web/package-lock.json").exists():
            (repo / "desktop/web/package-lock.json").symlink_to(LOCKFILE)
        version = installed or LOCKED_PLAYWRIGHT
        (runner / "package.json").write_text(json.dumps({"name": "@playwright/test", "version": version}))
        script = repo / "scripts" / "publish-web-release.sh"
        return subprocess.run(
            ["bash", str(script), "--tag", tag,
             "--repo", "example/canopi", *extra],
            env={**os.environ, "PATH": f"{fake}{os.pathsep}{os.environ['PATH']}", "TMPDIR": str(self.root),
                 "CANOPI_WEB_PRODUCTION_URL": self.production[1], "CANOPI_WEB_PREVIEW_URL": self.preview[1],
                 "CANOPI_WEB_SKEW_TIMEOUT": skew_timeout},
            capture_output=True, text=True, timeout=120)

    def calls(self):
        path = self.root / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def test_verify_only_downloads_and_admits_the_published_archive_and_its_previous(self):
        result = self.publish("--verify-only")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("stopping before deploy", result.stdout)
        self.assertIn("Merging v2.0.9", result.stdout)

    def test_a_draft_release_is_never_deployed(self):
        result = self.publish("--verify-only", draft=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a published release", result.stderr)

    def test_a_local_artifact_is_deployed_only_if_the_release_checksums_vouch_for_it(self):
        # The operator's local copy carries its own matching checksum file; the release's differs.
        local = self.root / "local"
        local.mkdir()
        checksums = self.build()
        shutil.copy(self.archive, local / self.archive.name)
        shutil.copy(checksums, local / checksums.name)
        release_checksums = self.root / "release-sums.txt"
        release_checksums.write_text("0" * 64 + f"  {self.archive.name}\n")
        result = self.publish("--artifact", str(local / self.archive.name), release_checksums=release_checksums)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        downloads = [call for call in self.calls() if call.startswith("gh release download")]
        self.assertEqual(len(downloads), 1)
        self.assertIn("--pattern WEB-RELEASE-SHA256SUMS.txt", downloads[0])
        self.assertNotIn(".tar.gz", downloads[0])
        self.assertFalse(any(call.startswith(("npx", "docker")) for call in self.calls()))

    def test_publish_downloads_n_minus_1_with_its_checksum_file_and_deploys_only_after_the_merge_passes(self):
        """publish-web-release.sh with fake gh and npx downloads N-1 with its checksum file and deploys only after
        the merge passes"""
        result = self.publish(previous={**previous_files(), "assets/web-AbCd1234AbCd1234.js": b"collides"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("assets/web-AbCd1234AbCd1234.js", result.stderr)
        previous_download = [call for call in self.calls() if call.startswith("gh release download v2.0.9")]
        self.assertEqual(len(previous_download), 1)
        self.assertIn("--pattern canopi-web-edition-root-v2.0.9-*.tar.gz", previous_download[0])
        self.assertIn("--pattern WEB-RELEASE-SHA256SUMS.txt", previous_download[0])
        self.assertFalse(any(call.startswith(("npx", "docker")) for call in self.calls()))

        (self.root / "calls").unlink()
        shutil.rmtree(self.root / "published")
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        deploys = [call for call in self.calls() if call.startswith("npx")]
        self.assertEqual(len(deploys), 1, self.calls())
        self.assertIn("--project-name canopi-web-preview", deploys[0])

    def test_the_deploy_skew_stage_deploys_n_minus_1_then_n_to_the_preview_while_the_tab_is_open(self):
        result = self.publish(deploys_succeed=True)
        # The fake Pages answers no range request, so the preview HTTP checks stop the release before production.
        self.assertNotEqual(result.returncode, 0)
        calls = [call for call in self.calls() if call.startswith(("npx", "docker run", "skew"))]
        self.assertRegex(calls[0], r"pages deploy \S+/previous --project-name canopi-web-preview")
        self.assertRegex(calls[1], r"^docker run .*-e CANOPI_WEB_RELEASE_HANDOFF=/handoff")
        self.assertEqual(calls[2], "skew chunks: assets/job-OLD00002OLD00002.js ")
        self.assertRegex(calls[3], r"pages deploy \S+/site --project-name canopi-web-preview")
        self.assertEqual(calls[4], "skew: N deployed")
        self.assertFalse(any("--project-name canopi-web " in call + " " for call in calls), calls)
        self.assertIn("HTTP checks on " + self.preview[1], result.stdout)
        self.assertEqual((self.preview[0] / web_release.MANIFEST_NAME).read_bytes(),
                         (self.root / f"source-{self.archive.name}" / web_release.MANIFEST_NAME).read_bytes())


    def test_every_pre_release_tag_is_refused_because_no_beta_origin_exists(self):
        for tag in ("v2.1.0-rc.1", "v2.1.0+build.5", "v2.1.0-beta"):
            with self.subTest(tag=tag):
                # The fake gh, npx and docker are installed, so a refusal that came after any read would leave calls.
                result = self.publish(deploys_succeed=True, tag=tag)
                self.assertEqual(self.calls(), [], "nothing was read or deployed")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("pre-release", result.stderr)
                self.assertIn("ADR 0029", result.stderr)

    def test_the_target_is_the_production_origin_with_no_project_override(self):
        # A project other than the one behind web.projectcanopi.com was deployed, then checked against production.
        result = self.publish("--project", "canopi-web-preview", deploys_succeed=True)
        self.assertEqual(self.calls(), [])
        self.assertIn("Unknown argument: --project", result.stderr)

    def test_an_unchanged_pdf_chunk_fails_before_any_deploy_and_the_override_keeps_the_rest_of_the_skew_stage(self):
        same = previous_files()["assets/job-OLD00002OLD00002.js"]
        self.site_extra = {"assets/job-OLD00002OLD00002.js": same}
        result = self.publish(deploys_succeed=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deploy-skew check would prove nothing", result.stderr)
        self.assertFalse(any(call.startswith(("npx", "docker")) for call in self.calls()))
        (self.root / "calls").unlink()
        shutil.rmtree(self.root / "published")
        # The override waives only the chunk proof: N-1 still deploys, its tab still reads the catalog and saves.
        self.publish("--allow-unchanged-pdf-chunk", deploys_succeed=True)
        calls = [call for call in self.calls() if call.startswith(("npx", "docker run", "skew"))]
        self.assertRegex(calls[0], r"pages deploy \S+/previous --project-name canopi-web-preview")
        self.assertRegex(calls[1], r"^docker run .*CANOPI_WEB_RELEASE_HANDOFF=/handoff")
        self.assertEqual(calls[2], "skew chunks: ")
        self.assertRegex(calls[3], r"pages deploy \S+/site --project-name canopi-web-preview")

    def test_browser_check_results_outlive_the_run_and_a_failure_names_them(self):
        result = self.publish(deploys_succeed=True, skew_tab="hang", skew_timeout="3")
        self.assertNotEqual(result.returncode, 0)
        match = re.search(r"Browser check results: (\S+)", result.stderr)
        self.assertIsNotNone(match, result.stderr)
        results = Path(match.group(1))
        self.assertTrue(results.is_relative_to(self.root), results)
        self.assertEqual((results / "skew" / "trace.zip").read_text(), "trace\n")

    def test_the_playwright_image_is_pulled_before_any_deploy_so_no_timed_wait_includes_a_pull(self):
        # The image's browsers are the ones the locked @playwright/test drives (AF23).
        image = f"mcr.microsoft.com/playwright:v{LOCKED_PLAYWRIGHT}-noble"
        self.publish(deploys_succeed=True)
        calls = [call for call in self.calls() if call.startswith(("npx", "docker"))]
        self.assertEqual(calls[0], f"docker image inspect {image}")
        self.assertEqual(calls[1], f"docker pull {image}")
        self.assertTrue(calls[2].startswith("npx"), calls)
        (self.root / "calls").unlink()
        shutil.rmtree(self.root / "published")
        result = self.publish(deploys_succeed=True, pull_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith(("npx", "docker run")) for call in self.calls()), self.calls())
        # An image already on the host is used as is: no registry contact (an MCR outage does not stop a release).
        (self.root / "calls").unlink()
        shutil.rmtree(self.root / "published")
        self.publish(deploys_succeed=True, pull_fails=True, image_local=True)
        self.assertNotIn(f"docker pull {image}", self.calls())
        self.assertTrue(any(call.startswith("npx") for call in self.calls()))

    def test_an_installed_test_runner_unlike_the_lockfile_is_refused_before_any_pull_or_deploy(self):
        # The container runs the host's desktop/web/node_modules runner in the image of the locked version: a stale
        # `npm ci` would fail for missing browsers only after the N-1 preview deploy.
        result = self.publish(deploys_succeed=True, installed="1.0.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"@playwright/test 1.0.0 is installed but {LOCKED_PLAYWRIGHT} is locked", result.stderr)
        self.assertFalse(any(call.startswith(("npx", "docker")) for call in self.calls()), self.calls())
        # The locked version installed: the release goes on to its deploys.
        (self.root / "calls").unlink()
        shutil.rmtree(self.root / "published")
        self.publish(deploys_succeed=True, installed=LOCKED_PLAYWRIGHT)
        self.assertTrue(any(call.startswith("npx") for call in self.calls()), self.calls())

    def test_the_n_minus_1_deploy_names_n_minus_1s_full_commit_from_its_tag(self):
        self.publish(deploys_succeed=True)
        deploys = [call for call in self.calls() if call.startswith("npx")]
        self.assertRegex(deploys[0], r"/previous --project-name canopi-web-preview --branch production "
                                     rf"--commit-hash {PREVIOUS_COMMIT}c{{28}}$")
        (self.root / "calls").unlink()
        shutil.rmtree(self.root / "published")
        # A tag that resolves to another commit than N-1's archive was built from fails before any deploy.
        result = self.publish(deploys_succeed=True, previous_sha="f" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not the commit of its Web archive", result.stderr)
        self.assertFalse(any(call.startswith("npx") for call in self.calls()))

    def assert_skew_container_stopped(self, result):
        self.assertNotEqual(result.returncode, 0)
        runs = [call for call in self.calls() if call.startswith("docker run")]
        self.assertEqual(len(runs), 1, self.calls())
        name = re.search(r"--name (canopi-skew-\S+)", runs[0]).group(1)
        self.assertIn(f"docker rm -f {name}", self.calls())
        self.assertEqual(list((self.root / "containers").iterdir()), [], "a skew container still runs")

    def test_a_skew_tab_that_never_reports_ready_is_stopped_at_the_timeout(self):
        started = time.monotonic()
        result = self.publish(deploys_succeed=True, skew_tab="hang", skew_timeout="3")
        self.assertLess(time.monotonic() - started, 60)
        self.assertIn("never reported n1-ready", result.stderr)
        self.assert_skew_container_stopped(result)
        self.assertFalse(any("/site --project-name" in call for call in self.calls()))

    def test_a_failed_n_deploy_stops_the_skew_container(self):
        result = self.publish(deploys_succeed=True, n_deploy_fails=True)
        self.assert_skew_container_stopped(result)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class LiveCheckTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.site = Path(temp.name)
        self.files = site_files()
        self.carried = {OLD_CATALOG + "species/species-0000.parquet": b"PAR1old", "assets/NotoSans-Regular-OLD0000000000000.ttf": b"old"}
        write_tree(self.site, {**self.files, **self.carried}, manifest_for(self.files))
        self.overrides = {}
        self.inject = b""
        self.requests = []

    def get(self, url, headers=None):
        path = re.sub(r"^https://example\.test", "", url)
        self.requests.append((path, (headers or {}).get("Range")))
        key = (path, (headers or {}).get("Range"))
        if key in self.overrides:
            return self.overrides[key]
        if path in self.overrides:
            return self.overrides[path]
        # Mixed-case header names: HTTP header names are case-insensitive.
        headers_out = {"x-content-type-OPTIONS": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin"}
        file = path.lstrip("/")
        served = {**self.files, **self.carried}
        if file == web_release.MANIFEST_NAME:
            return response(200, {**headers_out, "Cache-Control": "no-cache", "Content-Type": "application/json"},
                            (self.site / file).read_bytes())
        if file in served and file != "index.html":
            types = {".js": "application/javascript", ".css": "text/css; charset=utf-8", ".json": "application/json",
                     ".parquet": "application/octet-stream", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml"}
            cache = "public, max-age=31536000, immutable" if file.startswith("assets/") else "no-cache"
            data = served[file]
            out = {**headers_out, "Content-Type": types[Path(file).suffix], "Cache-Control": cache}
            requested = (headers or {}).get("Range")
            if requested and file.endswith(".parquet") and file.startswith("assets/"):
                start, end = requested.removeprefix("bytes=").split("-")
                first, last = (len(data) - int(end), len(data) - 1) if start == "" else (int(start), min(int(end), len(data) - 1))
                return response(206, {**out, "Content-Range": f"bytes {first}-{last}/{len(data)}"}, data[first:last + 1])
            return response(200, out, data)
        if file.startswith("assets/"):
            return response(404, headers_out, b"")
        return response(200, {**headers_out, "Content-Type": "text/html; charset=utf-8",
                              "Cache-Control": "public, max-age=0, must-revalidate"},
                        self.files["index.html"].replace(b"<title>", self.inject + b"<title>"))

    def check(self):
        return web_release.http_check("https://example.test/", self.site, get=self.get)

    def test_a_correct_deployment_passes_with_any_header_case(self):
        self.assertEqual(len(self.check()), 7)

    def test_html_may_carry_cloudflare_injections_but_must_load_the_release_module_entry(self):
        # Every check runs on a custom domain (*.pages.dev answers no range), so HTML is compared by its module entry;
        # the byte-for-byte pages.dev comparison is retired with the pages.dev preview (review S3).
        self.inject = b'<a href="https://example.test/cdn-cgi/content?id=1" aria-hidden="true"></a>'
        self.check()
        self.overrides = {"/designs": response(200, {"content-type": "text/html", "x-content-type-options": "nosniff"},
                                               self.files["index.html"].replace(b"AbCd1234AbCd1234", b"Other000Other000"))}
        with self.assertRaisesRegex(web_release.ReleaseError, "/designs: module script differs"):
            self.check()

    def test_each_carried_directory_and_the_manifest_are_checked_for_a_cache_lifetime(self):
        """A carried file is immutable; the manifest must not be immutable or cached past max-age=0."""
        self.check()
        def served(path, cache):
            return response(200, {"x-content-type-options": "nosniff", "Cache-Control": cache,
                                  "Content-Type": "application/octet-stream" if path.endswith(".parquet") else "font/ttf"},
                            self.carried[path])
        manifest = (self.site / web_release.MANIFEST_NAME).read_bytes()
        for path, cache in [("assets/NotoSans-Regular-OLD0000000000000.ttf", "public, max-age=600"),
                            ("assets/NotoSans-Regular-OLD0000000000000.ttf", "public, max-age=14400"),
                            (web_release.MANIFEST_NAME, "no-cache, immutable"),
                            (web_release.MANIFEST_NAME, "no-cache, max-age=3600")]:
            with self.subTest(path=path, cache=cache):
                answer = (response(200, {"x-content-type-options": "nosniff", "Cache-Control": cache}, manifest)
                          if path == web_release.MANIFEST_NAME else served(path, cache))
                self.overrides = {"/" + path: answer}
                with self.assertRaisesRegex(web_release.ReleaseError, re.escape(f"/{path}: Cache-Control")):
                    self.check()
        self.overrides = {"/assets/NotoSans-Regular-OLD0000000000000.ttf": served(
            "assets/NotoSans-Regular-OLD0000000000000.ttf", "no-cache")}
        with self.assertRaisesRegex(web_release.ReleaseError, "NotoSans-Regular-OLD0000000000000.ttf: Cache-Control 'no-cache', expected immutable"):
            self.check()

    def test_missing_headers_spa_fallback_for_assets_and_stale_manifest_fail(self):
        html = response(200, {"content-type": "text/html", "x-content-type-options": "nosniff"}, self.files["index.html"])
        stale = response(200, {"x-content-type-options": "nosniff", "cache-control": "no-cache"},
                         json.dumps({"version": "2.0.0", "commit": "0" * 12}).encode())
        for path, answer, pattern in [
            ("/assets/missing-0000.js", html, "expected 404"),
            (f"/{CATALOG}missing.parquet", html, "expected 404"),
            ("/designs", response(200, {"content-type": "text/html"}, self.files["index.html"]), "nosniff"),
            ("/" + web_release.MANIFEST_NAME, stale, "serves 2.0.0"),
            ("/assets/web-AbCd1234AbCd1234.js", response(200, {"x-content-type-options": "nosniff", "content-type": "text/plain"},
                                                 self.files["assets/web-AbCd1234AbCd1234.js"]), "Content-Type"),
        ]:
            with self.subTest(path=path):
                self.overrides = {path: answer}
                with self.assertRaisesRegex(web_release.ReleaseError, pattern):
                    self.check()

    def test_a_parquet_range_answered_200_fails_and_206_passes(self):
        """http_check fails a 200 to a parquet Range and passes a 206"""
        self.check()
        ranges = [(path, value) for path, value in self.requests if value]
        self.assertEqual(ranges, [(f"/{NAMES}", "bytes=0-99"), (f"/{NAMES}", "bytes=-8")])
        whole = self.files[NAMES]
        for requested in ["bytes=0-99", "bytes=-8"]:
            with self.subTest(range=requested):
                # What Pages answers without the zone Cache Rule: the whole file.
                self.overrides = {(f"/{NAMES}", requested): response(200, {
                    "x-content-type-options": "nosniff", "cache-control": "public, max-age=31536000, immutable"}, whole)}
                with self.assertRaisesRegex(web_release.ReleaseError, f"Range {requested} answered 200, expected 206"):
                    self.check()

    def test_the_shell_revalidates_on_root_and_designs(self):
        for path in ["/", "/designs"]:
            with self.subTest(path=path):
                self.overrides = {path: response(200, {"x-content-type-options": "nosniff", "content-type": "text/html",
                                                       "referrer-policy": "strict-origin-when-cross-origin",
                                                       "cache-control": "public, max-age=14400"}, self.files["index.html"])}
                with self.assertRaisesRegex(web_release.ReleaseError, f"{path}: Cache-Control .* does not revalidate"):
                    self.check()

    def test_a_carried_file_is_served_byte_exact_and_immutable(self):
        font = "/assets/NotoSans-Regular-OLD0000000000000.ttf"
        self.overrides = {font: response(200, {
            "x-content-type-options": "nosniff", "cache-control": "public, max-age=31536000, immutable"}, b"stale")}
        with self.assertRaisesRegex(web_release.ReleaseError, f"carried file {font}: bytes differ"):
            self.check()
        self.overrides = {font: response(200, {
            "x-content-type-options": "nosniff", "cache-control": "max-age=14400"}, b"old")}
        with self.assertRaisesRegex(web_release.ReleaseError, f"carried file {font}: Cache-Control"):
            self.check()

    def test_sampled_assets_including_catalog_and_fonts_are_immutable(self):
        for path in [f"/{CATALOG}manifest.json", "/assets/NotoSans-Regular-Qr4s7890Qr4s7890.ttf"]:
            with self.subTest(path=path):
                data = self.files[path.lstrip("/")]
                self.overrides = {path: response(200, {"x-content-type-options": "nosniff", "cache-control": "no-cache",
                                                       "content-type": "application/json" if path.endswith(".json") else "font/ttf"}, data)}
                with self.assertRaisesRegex(web_release.ReleaseError, f"{path}: Cache-Control 'no-cache' is not immutable"):
                    self.check()

    def test_production_is_current_only_when_it_serves_the_manifest_and_passes_its_checks(self):
        self.assertTrue(web_release.production_current("https://example.test", self.site, get=self.get))
        # A _headers fix keeps the manifest bytes, so a matching manifest alone must not skip the deploy.
        self.overrides = {"/assets/web-AbCd1234AbCd1234.js": response(
            200, {"x-content-type-options": "nosniff", "content-type": "application/javascript", "cache-control": "max-age=0"},
            self.files["assets/web-AbCd1234AbCd1234.js"])}
        self.assertFalse(web_release.production_current("https://example.test", self.site, get=self.get))
        self.overrides = {"/" + web_release.MANIFEST_NAME: response(200, {}, b"old")}
        self.assertFalse(web_release.production_current("https://example.test", self.site, get=self.get))

    def test_wait_for_polls_until_the_manifest_matches_or_times_out(self):
        calls = []
        responses = [response(200, {}, b"old"), self.get("/" + web_release.MANIFEST_NAME)]
        web_release.wait_for("https://example.test", self.site, timeout=60, get=lambda url: responses.pop(0),
                             sleep=calls.append)
        self.assertEqual(len(calls), 1)
        with self.assertRaisesRegex(web_release.ReleaseError, "did not serve"):
            web_release.wait_for("https://example.test", self.site, timeout=0,
                                 get=lambda url: response(200, {}, b"old"), sleep=calls.append)

    def test_a_truncated_response_while_polling_is_retried(self):
        import http.client
        responses = [http.client.IncompleteRead(b"par"), self.get("/" + web_release.MANIFEST_NAME)]

        def get(url):
            answer = responses.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        sleeps = []
        web_release.wait_for("https://example.test", self.site, timeout=60, get=get, sleep=sleeps.append)
        self.assertEqual(len(sleeps), 1)


def response(status, headers, body):
    return web_release.Response(status, {key.lower(): value for key, value in headers.items()}, body)


class CatalogAssetTests(unittest.TestCase):
    def test_asset_name_carries_both_contract_fingerprints_and_the_export_identity(self):
        name = web_release.web_catalog_asset_name()
        self.assertRegex(name, r"^canopi-web-catalog-v\d+-[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{64}\.tar\.gz$")
        self.assertLess(len(name), 255)

    def test_a_generated_catalog_round_trips_byte_for_byte_and_rejects_strays(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export = root / "canopi-export-test.db"
            create_export_fixture(export)
            generator.generate_web_catalog(export_path=export, output_dir=root / "catalog", species_shard_count=2,
                                           image_shard_count=2, max_asset_bytes=25 * 1024 * 1024)
            web_release.pack_catalog(root / "catalog", root / "one.tar.gz")
            web_release.pack_catalog(root / "catalog", root / "two.tar.gz")
            self.assertEqual((root / "one.tar.gz").read_bytes(), (root / "two.tar.gz").read_bytes())
            manifest = web_release.unpack_catalog(root / "one.tar.gz", root / "unpacked")
            self.assertEqual(manifest, json.loads((root / "catalog/manifest.json").read_text()))
            (root / "catalog/stray.parquet").write_bytes(b"stray")
            with self.assertRaisesRegex(web_release.ReleaseError, "unlisted catalog file: stray.parquet"):
                web_release.pack_catalog(root / "catalog", root / "three.tar.gz")
            (root / "catalog/stray.parquet").unlink()
            next((root / "catalog/species").iterdir()).write_bytes(b"changed")
            with self.assertRaisesRegex(web_release.ReleaseError, "catalog asset (byte count|checksum) differs"):
                web_release.pack_catalog(root / "catalog", root / "three.tar.gz")


if __name__ == "__main__":
    unittest.main()
