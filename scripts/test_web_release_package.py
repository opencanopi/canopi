"""`web_release.py package` and `archive-name` (2.1-M216): the archive, its refusals and the limit constants."""

import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

from scripts import web_release
from scripts import web_release_package as package

SCRIPT = Path(__file__).resolve().parent / "web_release.py"
COMMIT = "abcdef012345" + "6" * 28
NAME = f"canopi-web-edition-root-v2.1.0-{COMMIT[:12]}.tar.gz"
CATALOG_MANIFEST = json.dumps({
    "asset_format": "parquet", "supported_filters": [{"key": "habit"}],
    "assets": {"species": [{"path": "species/species-0000.parquet", "bytes": 12,
                            "sha256": hashlib.sha256(b"PAR1speciesP").hexdigest()}], "names": {}, "images": []},
}).encode()
CATALOG = f"assets/catalog/{hashlib.sha256(CATALOG_MANIFEST).hexdigest()[:16]}/"


def dist_files():
    """A root Web build as Vite writes it: web.html, hashed assets, the catalog and the notices file."""
    return {
        "web.html": b'<!doctype html><title>Canopi</title><script type="module" src="/assets/web-AbCd1234AbCd1234.js"></script>',
        "assets/web-AbCd1234AbCd1234.js": b"console.log('canopi')",
        "THIRD_PARTY_NOTICES.md": b"# Third-party notices\n",
        CATALOG + "manifest.json": CATALOG_MANIFEST,
        CATALOG + "species/species-0000.parquet": b"PAR1speciesP",
    }


class PackageCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.dist = self.root / "dist-web"
        self.out = self.root / "out"
        self.write(dist_files())

    def write(self, files):
        for path, data in files.items():
            (self.dist / path).parent.mkdir(parents=True, exist_ok=True)
            (self.dist / path).write_bytes(data)

    def package(self):
        return package.package(self.dist, self.out, version="2.1.0", commit=COMMIT)

    def assert_refused(self, pattern):
        with self.assertRaisesRegex(package.ReleaseError, pattern):
            self.package()
        self.assertEqual(list(self.out.iterdir()) if self.out.exists() else [], [])

    def cli(self, *args):
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, check=False)


class PackageTests(PackageCase):
    def test_package_writes_the_named_archive_from_dist_web_byte_identical_on_a_rerun(self):
        result = self.cli("package", "--dist", str(self.dist), "--output-dir", str(self.out),
                          "--version", "2.1.0", "--commit", COMMIT)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.out / NAME
        first = archive.read_bytes()
        self.assertEqual(oct(archive.stat().st_mode & 0o777), "0o644")
        self.assertEqual(self.package(), archive)
        self.assertEqual(archive.read_bytes(), first)
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), [NAME])
        with tarfile.open(archive) as tar:
            names = tar.getnames()
            manifest = json.load(tar.extractfile(package.MANIFEST_NAME))
        self.assertEqual(names, sorted(names))
        self.assertIn("index.html", names)
        self.assertNotIn("web.html", names)
        self.assertEqual(list(manifest), ["name", "version", "commit", "catalog", "files"])
        self.assertEqual((manifest["version"], manifest["commit"]), ("2.1.0", COMMIT[:12]))
        self.assertEqual(manifest["catalog"], {"manifestPath": CATALOG + "manifest.json", "assetFormat": "parquet",
                                               "supportedFilters": ["habit"],
                                               "files": [CATALOG + "species/species-0000.parquet"]})
        index = next(entry for entry in manifest["files"] if entry["path"] == "index.html")
        self.assertEqual(index["sha256"], hashlib.sha256(dist_files()["web.html"]).hexdigest())
        # The archive is what `verify` admits.
        identity = web_release.verify_archive(archive, version="2.1.0", commit=COMMIT, output_dir=self.root / "site")
        self.assertEqual(identity.files, 6)

    def test_a_symbolic_link_is_refused(self):
        os.symlink(self.dist / "web.html", self.dist / "assets/link-AbCd1234AbCd1234.html")
        self.assert_refused("symbolic link: assets/link-AbCd1234AbCd1234.html")

    def test_a_file_over_25_mib_is_refused(self):
        with open(self.dist / "assets/big-AbCd1234AbCd1234.js", "wb") as big:
            big.truncate(26_214_401)
        self.assert_refused("assets/big-AbCd1234AbCd1234.js is 26214401 bytes, above the Pages limit 26214400")

    def test_a_build_of_20000_files_is_refused_since_the_manifest_makes_20001(self):
        many = self.dist / "assets/many"
        many.mkdir()
        for index in range(20_000 - len(dist_files())):
            (many / f"{index}").write_bytes(b"")
        self.assert_refused("20000 files and the manifest, above the Pages limit 20000")

    def test_a_raw_duckdb_wasm_is_refused(self):
        self.write({"assets/duckdb-eh-AbCd1234AbCd1234.wasm": b"\0asm"})
        self.assert_refused("raw DuckDB WASM file: assets/duckdb-eh-AbCd1234AbCd1234.wasm")

    def test_a_build_carrying_a_manifest_that_declares_limits_base_path_or_fallback_is_refused(self):
        for field, value in [("limits", {"cloudflarePagesMaxAssetBytes": 10 ** 9, "cloudflarePagesMaxFiles": 10 ** 6}),
                             ("basePath", "/app/"), ("spaFallback", {"source": "/app/*"})]:
            with self.subTest(field=field):
                self.write({package.MANIFEST_NAME: json.dumps({field: value}).encode()})
                self.assert_refused(f"already holds {package.MANIFEST_NAME}")

    def test_a_build_without_the_notices_file_is_refused(self):
        (self.dist / package.NOTICES_NAME).unlink()
        self.assert_refused("THIRD_PARTY_NOTICES.md is missing from the build")

    def test_a_build_for_another_base_path_or_without_its_catalog_is_refused(self):
        self.write({"web.html": dist_files()["web.html"].replace(b'"/assets/', b'"/app/assets/')})
        self.assert_refused("web.html references /app/assets/web-AbCd1234AbCd1234.js, no file of this build")
        self.write(dist_files())
        (self.dist / CATALOG / "species/species-0000.parquet").write_bytes(b"PAR1otherspc")
        self.assert_refused("catalog asset differs from its manifest")
        (self.dist / CATALOG / "species/species-0000.parquet").unlink()
        self.assert_refused("catalog asset missing: " + CATALOG + "species/species-0000.parquet")
        shutil.rmtree(self.dist / "assets/catalog")
        self.assert_refused("the build holds 0 catalogs")

    def test_no_build_or_an_empty_one_is_refused(self):
        shutil.rmtree(self.dist)
        self.assert_refused("no Web build at")
        self.dist.mkdir()
        self.assert_refused("is empty")

    def test_an_unwritable_output_dir_leaves_no_archive(self):
        self.out.mkdir()
        self.out.chmod(0o500)
        self.addCleanup(self.out.chmod, 0o700)
        with self.assertRaises(PermissionError):
            self.package()
        self.assertEqual(list(self.out.iterdir()), [])

    def test_a_full_disk_mid_write_leaves_no_partial_archive_and_keeps_the_previous_one(self):
        self.package()
        previous = (self.out / NAME).read_bytes()
        self.write({"assets/more-AbCd1234AbCd1234.js": b"more"})
        real_addfile = tarfile.TarFile.addfile
        calls = []

        def addfile(tar, info, data=None):
            calls.append(info.name)
            if len(calls) == 3:
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_addfile(tar, info, data)

        with mock.patch.object(tarfile.TarFile, "addfile", addfile):
            with self.assertRaisesRegex(OSError, "No space left"):
                self.package()
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), [NAME])
        self.assertEqual((self.out / NAME).read_bytes(), previous)


class ArchiveNameTests(PackageCase):
    def test_archive_name_prints_the_name_and_without_a_commit_the_pattern_of_every_candidate(self):
        self.assertEqual(self.cli("archive-name", "--version", "2.1.0", "--commit", COMMIT).stdout, NAME + "\n")
        self.assertEqual(self.cli("archive-name", "--version", "2.1.0", "--commit", COMMIT[:12]).stdout, NAME + "\n")
        self.assertEqual(self.cli("archive-name", "--version", "2.1.0").stdout,
                         "canopi-web-edition-root-v2.1.0-*.tar.gz\n")
        self.assertRegex(package.ARCHIVE_RE.fullmatch(NAME).group(2), "^abcdef012345$")
        for bad in (["--version", "2.1.0", "--commit", "abc"], ["--version", "../2.1.0", "--commit", COMMIT]):
            with self.subTest(args=bad):
                result = self.cli("archive-name", *bad)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")


class VerifyTests(PackageCase):
    def repack(self, archive, **changes):
        """The archive with its manifest edited, as a release that declared its own fields would ship it."""
        site = self.root / f"edited-{len(list(self.root.iterdir()))}"
        web_release.safe_extract(archive, site)
        manifest = json.loads((site / package.MANIFEST_NAME).read_text())
        manifest.update(changes)
        (site / package.MANIFEST_NAME).write_text(json.dumps(manifest))
        edited = self.root / "edited" / archive.name
        edited.parent.mkdir(exist_ok=True)
        edited.unlink(missing_ok=True)
        web_release.deterministic_tar_gz(site, edited)
        return edited

    def test_verify_admits_a_2_0_x_stable_archive_as_release_n_and_never_reads_its_declared_limits(self):
        """release/2.0 packages a stable 2.0.x with its own packager: basePath, spaFallback and limits in the manifest
        and the full 40-hex commit. main's publisher admits it as N, applying the constants (2.1-M216)."""
        archive = self.package()
        declared = {"commit": COMMIT, "basePath": "/",
                    "spaFallback": {"source": "/*", "destination": "/index.html", "status": 200},
                    "limits": {"cloudflarePagesMaxAssetBytes": 10 ** 9, "cloudflarePagesMaxFiles": 10 ** 6}}
        stable = self.repack(archive, version="2.0.4", **declared).rename(
            self.root / f"canopi-web-edition-root-v2.0.4-{COMMIT[:12]}.tar.gz")
        identity = web_release.verify_archive(stable, version="2.0.4", commit=COMMIT, output_dir=self.root / "stable")
        self.assertEqual((identity.version, identity.commit), ("2.0.4", COMMIT))
        with mock.patch.object(package, "MAX_ASSET_BYTES", 100):
            with self.assertRaisesRegex(package.ReleaseError, "bytes, above the Pages limit 100"):
                web_release.verify_archive(stable, version="2.0.4", output_dir=self.root / "stable-again")

    def test_verify_previous_admits_a_2_0_3_root_archive_and_applies_the_constants_never_its_limits(self):
        """2.0.3 shipped limits, basePath and spaFallback in its manifest: admitted as N-1, its limits ignored."""
        archive = self.package()
        declared = {"basePath": "/", "spaFallback": {"source": "/*", "destination": "/index.html", "status": 200},
                    "limits": {"cloudflarePagesMaxAssetBytes": 10 ** 9, "cloudflarePagesMaxFiles": 10 ** 6}}
        previous = self.repack(archive, version="2.0.3", **declared).rename(
            self.root / f"canopi-web-edition-root-v2.0.3-{COMMIT[:12]}.tar.gz")
        checksums = self.root / "WEB-RELEASE-SHA256SUMS.txt"
        checksums.write_text(f"{package.sha256_file(previous)}  {previous.name}\n")
        identity = web_release.verify_previous(previous, version="2.0.3", checksums=checksums,
                                               output_dir=self.root / "previous")
        self.assertEqual((identity.version, identity.commit), ("2.0.3", COMMIT[:12]))
        with mock.patch.object(package, "MAX_ASSET_BYTES", 100):
            with self.assertRaisesRegex(package.ReleaseError, "bytes, above the Pages limit 100"):
                web_release.verify_previous(previous, version="2.0.3", checksums=checksums,
                                            output_dir=self.root / "previous-again")


if __name__ == "__main__":
    unittest.main()
