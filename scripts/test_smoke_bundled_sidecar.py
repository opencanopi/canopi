"""The Linux glibc floor in scripts/smoke-bundled-sidecar.sh (canopi-eon8.14.6).

2.0.1's packages were built on ubuntu-latest and asked for GLIBC_2.39, so
neither the app nor the GeoLibre sidecar started on Debian 12 or Ubuntu 22.04.
The smoke script's `glibc-floor` mode reads each binary's dynamic symbol
versions and fails one that needs a glibc newer than the floor (2.35).
"""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "smoke-bundled-sidecar.sh"


def _objdump_listing(versions):
    lines = ["", "fake:     file format elf64-x86-64", "", "DYNAMIC SYMBOL TABLE:"]
    for index, version in enumerate(versions):
        lines.append(
            f"0000000000000000      DF *UND*  0000000000000000 ({version}) sym{index}"
        )
    return "\n".join(lines) + "\n"


class GlibcFloorTests(unittest.TestCase):
    def _run(self, versions):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            listing = temp / "listing.txt"
            listing.write_text(_objdump_listing(versions), encoding="utf-8")
            objdump = fake_bin / "objdump"
            objdump.write_text(f"#!/bin/sh\ncat '{listing}'\n", encoding="utf-8")
            objdump.chmod(0o755)
            binary = temp / "canopi-desktop"
            binary.write_bytes(b"\x7fELF")
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            return subprocess.run(
                ["bash", str(SCRIPT), "glibc-floor", str(binary)],
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )

    def test_canopi_eon8_14_6_binary_needing_glibc_2_39_fails_the_floor(self):
        result = self._run(["GLIBC_2.2.5", "GLIBC_2.34", "GLIBC_2.39", "GCC_3.0"])
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("GLIBC_2.39", result.stderr)
        self.assertIn("2.35", result.stderr)

    def test_binary_within_the_floor_passes(self):
        result = self._run(["GLIBC_2.2.5", "GLIBC_2.17", "GLIBC_2.35", "GLIBCXX_3.4.30"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("GLIBC_2.35", result.stdout)

    def test_versions_compare_numerically_not_as_text(self):
        # 2.4 < 2.35 < 2.100: a text sort would rank 2.4 above 2.35.
        self.assertEqual(self._run(["GLIBC_2.4", "GLIBC_2.35"]).returncode, 0)
        self.assertNotEqual(self._run(["GLIBC_2.100"]).returncode, 0)

    def test_binary_without_glibc_symbols_fails(self):
        # A listing with no versions means objdump read nothing: never pass silently.
        result = self._run([])
        self.assertNotEqual(result.returncode, 0)


class RelativeBundleTests(unittest.TestCase):
    def test_canopi_eon8_14_6_an_appimage_under_a_relative_bundle_dir_is_extracted(self):
        # CI passes `bundle` relative to the checkout; the script extracts from inside its scratch dir,
        # so a relative AppImage path ran nothing there (exit 127 on the first container run).
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            listing = temp / "listing.txt"
            listing.write_text(_objdump_listing(["GLIBC_2.35"]), encoding="utf-8")
            objdump = fake_bin / "objdump"
            objdump.write_text(f"#!/bin/sh\ncat '{listing}'\n", encoding="utf-8")
            objdump.chmod(0o755)
            appimage_dir = temp / "bundle" / "appimage"
            appimage_dir.mkdir(parents=True)
            appimage = appimage_dir / "Canopi_0.0.0_amd64.AppImage"
            appimage.write_text(
                "#!/bin/sh\n"
                "mkdir -p squashfs-root/usr/bin\n"
                "printf '#!/bin/sh\\necho geolibre-cli 0.0.0\\n' > squashfs-root/usr/bin/geolibre\n"
                "printf 'ELF' > squashfs-root/usr/bin/canopi-desktop\n"
                "printf '#!/bin/sh\\necho cannot open display >&2\\nexit 1\\n' > squashfs-root/AppRun\n"
                "chmod +x squashfs-root/usr/bin/geolibre squashfs-root/AppRun\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            result = subprocess.run(
                ["bash", str(SCRIPT), "x86_64-unknown-linux-gnu", "bundle"],
                capture_output=True,
                text=True,
                env=environment,
                cwd=temp,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("geolibre-cli 0.0.0", result.stdout)
            self.assertIn("got past the loader", result.stdout)


if __name__ == "__main__":
    unittest.main()
