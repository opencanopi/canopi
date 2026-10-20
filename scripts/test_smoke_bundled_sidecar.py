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


if __name__ == "__main__":
    unittest.main()
