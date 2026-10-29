"""The release checks (ADR 0029 Release safety): the release smoke (scripts/release_smoke.py)."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts import release_smoke as smoke

class Recorder:
    """Stands in for subprocess.run: records each command and answers from `outputs` by its first word."""

    def __init__(self, outputs=None, fail=()):
        self.commands = []
        self.outputs = outputs or {}
        self.fail = fail

    def __call__(self, command, **_):
        self.commands.append(list(command))
        code = 1 if any(word in command for word in self.fail) else 0
        return subprocess.CompletedProcess(command, code, stdout=self.outputs.get(Path(command[0]).name, ""), stderr="")


class DebVersionTests(unittest.TestCase):
    def test_a_beta_deb_sorts_below_its_stable_and_a_stable_keeps_its_version(self):
        self.assertEqual(smoke.deb_version("2.1.0-beta.1"), "2.1.0~beta.1")
        self.assertEqual(smoke.deb_version("2.1.0"), "2.1.0")

    def test_check_deb_refuses_a_control_version_that_is_not_the_deb_form(self):
        run = Recorder({"dpkg-deb": "2.1.0-beta.1\n"})
        with self.assertRaisesRegex(smoke.SmokeError, "2.1.0-beta.1, not 2.1.0~beta.1"):
            smoke.check_deb(Path("canopi.deb"), "2.1.0-beta.1", run)
        smoke.check_deb(Path("canopi.deb"), "2.1.0-beta.1", Recorder({"dpkg-deb": "2.1.0~beta.1\n"}))

    def test_check_deb_asks_dpkg_that_the_beta_ranks_below_its_stable(self):
        run = Recorder({"dpkg-deb": "2.1.0~beta.1\n"})
        smoke.check_deb(Path("canopi.deb"), "2.1.0-beta.1", run)
        self.assertIn(["dpkg", "--compare-versions", "2.1.0~beta.1", "lt", "2.1.0"], run.commands)
        with self.assertRaisesRegex(smoke.SmokeError, "dpkg does not rank"):
            smoke.check_deb(Path("canopi.deb"), "2.1.0-beta.1", Recorder({"dpkg-deb": "2.1.0~beta.1\n"},
                                                                          fail=("--compare-versions",)))


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def artifact(self, name):
        path = self.root / name
        path.write_bytes(b"installer bytes" * 10)
        return path

    def test_each_installer_installs_the_way_a_user_s_does_silently(self):
        cases = {
            "Canopi_2.1.0_amd64.deb": ["sudo", "apt-get", "install", "-y"],
            "Canopi_2.1.0_x64-setup.exe": [],
            "Canopi_2.1.0_x64_en-US.msi": ["msiexec", "/i"],
        }
        for name, prefix in cases.items():
            with self.subTest(name=name):
                run = Recorder()
                artifact = self.artifact(name)
                smoke.install(artifact, run)
                command = run.commands[0]
                self.assertEqual(command[:len(prefix)], prefix)
                self.assertIn(str(artifact), command)
        run = Recorder()
        appimage = self.artifact("Canopi_2.1.0_amd64.AppImage")
        smoke.install(appimage, run)
        self.assertEqual(smoke.installed_executable(appimage), appimage)
        self.assertEqual(run.commands, [])
        self.assertTrue(appimage.stat().st_mode & 0o100)

    def test_a_failing_installer_fails_the_smoke(self):
        with self.assertRaisesRegex(smoke.SmokeError, "did not install"):
            smoke.install(self.artifact("Canopi_2.1.0_amd64.deb"), Recorder(fail=("apt-get",)))

    def test_the_planted_run_installs_a_truncated_copy(self):
        artifact = self.artifact("Canopi_2.1.0_x64-setup.exe")
        planted = smoke.plant(artifact, self.root / "planted")
        self.assertEqual(planted.name, artifact.name)
        self.assertLess(planted.stat().st_size, artifact.stat().st_size)
        self.assertEqual(artifact.read_bytes(), b"installer bytes" * 10)

    def test_an_unknown_installer_is_refused(self):
        with self.assertRaisesRegex(smoke.SmokeError, "not a release installer"):
            smoke.install(self.artifact("canopi.dmg"), Recorder())


class ScreenTests(unittest.TestCase):
    def test_the_start_screen_is_seen_by_its_open_design_button(self):
        self.assertTrue(smoke.shows_start_screen(["Canopi", "New Design", "Open Design… Ctrl+O"]))
        self.assertFalse(smoke.shows_start_screen(["Canopi", "Rename Design: Garden"]))

    def test_a_design_opened_by_its_association_is_seen_in_the_log(self):
        with tempfile.TemporaryDirectory() as folder:
            logs = Path(folder)
            self.assertFalse(smoke.design_loaded(logs, after=0))
            (logs / "canopi.2026-10-29").write_text("INFO canopi: Canopi starting\nINFO canopi: Design loaded\n")
            self.assertTrue(smoke.design_loaded(logs, after=0))

    def test_the_linux_start_screen_runs_the_real_app_suite_spec_against_the_installed_binary(self):
        run = Recorder()
        smoke.linux_start_screen(Path("/usr/bin/canopi-desktop"), run)
        command = run.commands[0]
        self.assertIn("e2e/platform/desktop/start-screen.spec.ts", command)
        self.assertIn("opens on the start screen from its bundled frontend", command)


if __name__ == "__main__":
    unittest.main()
