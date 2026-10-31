"""The release smoke (scripts/release_smoke.py; ADR 0029 Release safety): its installs, screens and the macOS probe. The
Release Candidate workflow's updater duties and the updater end-to-end lane are in test_release_smoke_lanes.py."""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

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

    def test_canopi_f47t_52_228_15_an_installer_s_exit_code_is_printed_whether_it_installed_or_not(self):
        for fail, code in (((), 0), (("/S",), 1)):
            with self.subTest(code=code), contextlib.redirect_stderr(io.StringIO()) as err:
                with contextlib.suppress(smoke.SmokeError):
                    smoke.install(self.artifact("Canopi_2.1.0_x64-setup.exe"), Recorder(fail=fail))
                self.assertIn(f"Canopi_2.1.0_x64-setup.exe exited {code}", err.getvalue())

    def windows_install(self, registry, *files):
        for name in files:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_bytes(b"exe")
        env, err = {"LOCALAPPDATA": str(self.root / "local"), "ProgramFiles": str(self.root / "program")}, io.StringIO()
        with unittest.mock.patch.dict("os.environ", env), contextlib.redirect_stderr(err):
            try:
                return smoke.installed_windows_executable(lambda: registry), err.getvalue()
            except smoke.SmokeError as error:
                return error, err.getvalue()

    def test_canopi_f47t_52_228_15_the_installed_exe_comes_from_the_nsis_uninstall_entry_else_either_root(self):
        # Tauri installs the cargo binary (no mainBinaryName), canopi-desktop.exe; NSIS writes InstallLocation quoted.
        self.assertEqual((smoke.BINARY, smoke.UNINSTALL_KEY.rsplit("\\", 1)[1]), ("canopi-desktop", "Canopi"))
        folder = self.root / "elsewhere" / "Canopi"
        entry = {"InstallLocation": f'"{folder}"', "MainBinaryName": "canopi-desktop.exe"}
        found, _ = self.windows_install([("HKCU", None), ("HKLM", entry)], "elsewhere/Canopi/canopi-desktop.exe")
        self.assertEqual(found, folder / "canopi-desktop.exe")
        found, _ = self.windows_install([("HKCU", None), ("HKLM", None)], "local/Canopi/canopi-desktop.exe")
        self.assertEqual(found, self.root / "local" / "Canopi" / "canopi-desktop.exe")

    def test_canopi_f47t_52_228_15_the_windows_install_roots_are_both_printed_with_what_each_holds(self):
        # A miss prints the uninstall entries and each root's listing, so a run that finds nothing says where it looked.
        entry = {"InstallLocation": f'"{self.root / "local" / "Canopi"}"', "DisplayVersion": "9.0.0"}
        error, err = self.windows_install([("HKCU", entry), ("HKLM", None)], "local/Canopi/uninstall.exe", "local/Canopi/Canopi.exe")
        self.assertRegex(str(error), "no canopi-desktop.exe")
        self.assertIn("Uninstall\\Canopi", err)
        self.assertIn("'DisplayVersion': '9.0.0'", err)
        self.assertIn("'HKLM': None", err)
        self.assertIn("['Canopi.exe', 'uninstall.exe']", err)
        self.assertIn(f"{self.root / 'program' / 'Canopi'}': 'missing'", err)

    def test_canopi_f47t_52_228_the_smoke_runs_under_python_3_10_which_has_no_tomllib(self):
        # ubuntu-22.04's python3 (the smoke-linux leg, the beta repack in the ubuntu:22.04 build) is 3.10: no tomllib.
        probe = ("import sys; sys.modules['tomllib'] = None; sys.path.insert(0, '.')\n"
                 "from pathlib import Path\n"
                 "from scripts import release_smoke as smoke\n"
                 "assert all(callable(getattr(smoke, n)) for n in ('install', 'check_deb', 'repack_deb'))\n"
                 "print(smoke.installed_executable(Path('canopi.deb')))\n")
        result = subprocess.run([sys.executable, "-I", "-c", probe], capture_output=True, text=True,
                                cwd=Path(smoke.__file__).resolve().parents[1], check=False)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(result.stdout.strip(), "/usr/bin/canopi-desktop")

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


class MacosProbeTests(unittest.TestCase):
    """The macOS self-update probe (2.1-Q136, M97): it drives the probe build through its MCP bridge's WebSocket and
    reports; clean only when every check passes, M97's two close checks included."""

    def test_a_bridge_frame_round_trips_masked_from_the_client_and_plain_from_the_app(self):
        import io

        text = json.dumps({"id": "1", "command": "execute_js", "args": {"script": "return 1" + " " * 300}})
        masked = smoke.ws_frame(text, mask=b"\x01\x02\x03\x04")
        self.assertEqual(masked[0], 0x81)
        self.assertEqual(masked[1], 0x80 | 126)
        self.assertEqual(smoke.read_frame(io.BytesIO(masked)), (1, text.encode()))
        plain = bytes([0x81, 5]) + b"hello"
        self.assertEqual(smoke.read_frame(io.BytesIO(plain)), (1, b"hello"))

    def test_app_management_lines_are_the_tcc_app_bundle_and_app_management_entries(self):
        log = "\n".join([
            "2026-10-29 tccd: AUTHREQ_RESULT: msgID=1, authValue=0, service=kTCCServiceSystemPolicyAppBundles",
            "2026-10-29 kernel: unrelated",
            "2026-10-29 syspolicyd: App Management prevented Canopi from modifying apps",
        ])
        self.assertEqual(len(smoke.app_management_lines(log)), 2)
        self.assertEqual(smoke.app_management_lines("2026-10-29 kernel: unrelated"), [])

    def test_canopi_f47t_52_228_15_the_probe_s_own_log_show_line_is_never_an_app_management_block(self):
        # `log show`'s predicate names "App Management", and the unified log records the log process's own run.
        own = ("2026-10-30 09:40:04.180 Df log[15479:c31f] [com.apple.log:] log run noninteractively, parent: 13182 "
               "(Python), args: 'log' 'show' '--predicate' 'process == \"tccd\" OR eventMessage CONTAINS[c] "
               "\"App Management\"'")
        block = "2026-10-30 09:40:05.001 E  syspolicyd[311:a2] App Management prevented Canopi from modifying apps"
        self.assertEqual(smoke.app_management_lines(own), [])
        self.assertEqual(smoke.app_management_lines(f"{own}\n{block}"), [block])

    def test_canopi_f47t_52_228_15_the_rename_lets_the_page_render_the_typed_name_before_it_presses_enter(self):
        # A Preact field renders the typed value asynchronously; an Enter in the same task commits the old one.
        script = smoke.RENAME.format(old='"Probe garden"', new='"Probed garden"')
        typed = script.index("new Event('input'")
        enter = script.index("key: 'Enter'")
        self.assertRegex(script[typed:enter], r"await new Promise\(\(settle\) => setTimeout\(settle, \d+\)\)")

    def test_the_probe_is_clean_only_when_every_check_passes(self):
        clean = {name: True for name in smoke.PROBE_CHECKS}
        self.assertEqual(smoke.probe_verdict(clean), (True, []))
        for name in smoke.PROBE_CHECKS:
            with self.subTest(check=name):
                self.assertEqual(smoke.probe_verdict({**clean, name: False}), (False, [name]))
        self.assertEqual(smoke.probe_verdict({}), (False, list(smoke.PROBE_CHECKS)))
        # M97: the probe counts the unsaved edit and the unsaveable settings close among its checks.
        self.assertIn("unsaved edit kept", smoke.PROBE_CHECKS)
        self.assertIn("unsaveable settings close offers Retry, Close anyway and Cancel", smoke.PROBE_CHECKS)

    def test_the_bundle_version_is_read_through_the_shared_runner(self):
        recorder = Recorder({"PlistBuddy": "9.0.1\n"})
        with unittest.mock.patch.object(smoke.subprocess, "run", recorder):
            self.assertEqual(smoke.bundle_version(Path("/Applications/Canopi.app")), "9.0.1")
        self.assertEqual(recorder.commands[0][0], "/usr/libexec/PlistBuddy")

    def test_a_probe_the_app_never_answers_still_reads_the_log_and_writes_its_report(self):
        """The finally block's unified-log read must not crash the run: the report and summary are the probe's
        result, so a stopped run still shows how far the update got."""

        class Unreachable:
            def __init__(self, _deadline):
                raise smoke.SmokeError("the probe build's bridge never answered")

        recorder = Recorder({"log": ""})
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "Canopi.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/MacOS/canopi").write_text("")
            report = Path(folder) / "report.json"
            with unittest.mock.patch.object(smoke.subprocess, "run", recorder), \
                    unittest.mock.patch.object(smoke.subprocess, "Popen"), \
                    unittest.mock.patch.object(smoke, "Bridge", Unreachable), \
                    contextlib.redirect_stdout(io.StringIO()):
                clean = smoke.macos_probe(app, Path(folder) / "garden.canopi", "9.0.0", "9.0.1",
                                          Path(folder) / "user.db", report)
            written = json.loads(report.read_text())
        self.assertFalse(clean)
        self.assertEqual(written["failed"], list(smoke.PROBE_CHECKS))
        self.assertIn("stopped: the probe build's bridge never answered", written["notes"])
        self.assertIn("log", [command[0] for command in recorder.commands])

    def test_after_install_the_probe_reads_the_close_dialog_never_about_or_settings(self):
        """About (a role="dialog" section, open through the install) and Settings render before the save-problem
        dialog, so a selector list that also matches role="dialog" returns About's buttons before any close dialog
        exists; the close dialog is the only alertdialog a Design session shows."""
        self.assertIn('[role="alertdialog"]', smoke.AFTER_INSTALL)
        self.assertNotIn('[role="dialog"]', smoke.AFTER_INSTALL)


class ScriptedBridge(smoke.Bridge):
    """The probe build's page as run 40897481799 met it, answered by script: the first connection is N, which saves the
    renamed Design when Install and restart is pressed and then closes without a dialog (the bridge socket resets);
    the second is the relaunched N+1 on the renamed Design."""

    connections = 0

    def __init__(self, _deadline):
        ScriptedBridge.connections += 1
        self.relaunch = ScriptedBridge.connections > 1
        self.calls = 0
        self.scripts = []
        if not self.relaunch:
            ScriptedBridge.last_n_scripts = self.scripts

    def _js(self, script):
        self.scripts.append(script)
        if self.relaunch:
            return 'Rename Design: Probed garden' in script
        if script == smoke.AFTER_INSTALL:
            raise ConnectionResetError(54, "Connection reset by peer")
        if script == smoke.CHANGE_A_SETTING:
            return None if ScriptedBridge.no_switch else "Show the grid"
        if '"Install and restart"' in script and "click()" in script:
            design = ScriptedBridge.design
            design.write_text(json.dumps({"name": "Probed garden"}))
        return True

    def close(self):
        pass


class MacosProbeRunTests(unittest.TestCase):
    """canopi-f47t.52.228.15, run 40897481799: the probe's harness gaps (About open over Settings, an unchecked rename,
    a reset bridge ending the run, no app output or debug log) are closed so one run tells harness from product."""

    def run_probe(self, no_switch=False):
        ScriptedBridge.connections = 0
        ScriptedBridge.no_switch = no_switch
        commands = []
        versions = iter(["9.0.0", "9.0.1", "9.0.1", "9.0.1"])

        def run(command, **_):
            commands.append(list(command))
            out = next(versions) + "\n" if command[0].endswith("PlistBuddy") else "tccd: probe line\n"
            return subprocess.CompletedProcess(command, 0, stdout=out, stderr="")

        with tempfile.TemporaryDirectory() as folder:
            probe = Path(folder) / "probe"
            probe.mkdir()
            app = Path(folder) / "Canopi.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/MacOS/canopi").write_text("")
            design = probe / "Probe garden.canopi"
            design.write_text(json.dumps({"name": "Probe garden"}))
            ScriptedBridge.design = design
            settings = Path(folder) / "user.db"
            report = probe / "report.json"
            popen = unittest.mock.MagicMock()
            with unittest.mock.patch.object(smoke.subprocess, "run", run), \
                    unittest.mock.patch.object(smoke.subprocess, "Popen", popen), \
                    unittest.mock.patch.object(smoke, "Bridge", ScriptedBridge), \
                    unittest.mock.patch.object(smoke.time, "sleep"), \
                    contextlib.redirect_stdout(io.StringIO()):
                clean = smoke.macos_probe(app, design, "9.0.0", "9.0.1", settings, report)
            written = json.loads(report.read_text())
            files = {path.name: path.read_text() for path in probe.iterdir() if path.suffix in (".log", ".txt")}
        return clean, written, commands, popen, files

    def test_a_close_without_a_dialog_goes_on_to_the_relaunch_and_records_the_version_and_saved_name(self):
        clean, written, _, _, _ = self.run_probe()
        self.assertFalse(clean, "no close dialog was offered")
        self.assertIn("Canopi closed without a dialog", "\n".join(written["notes"]))
        self.assertTrue(written["observed"]["unsaved edit kept"])
        self.assertTrue(written["observed"]["relaunched as N+1 on the Design"])
        self.assertEqual(written["bundle_version"], "9.0.1")
        self.assertEqual(written["saved_name"], "Probed garden")

    def test_about_closes_before_the_rename_and_settings_change_and_reopens_for_the_install(self):
        self.run_probe()
        scripts = ScriptedBridge.last_n_scripts
        close, change, reopen = (scripts.index(script)
                                 for script in (smoke.CLOSE_ABOUT, smoke.CHANGE_A_SETTING, smoke.OPEN_ABOUT))
        rename = next(i for i, s in enumerate(scripts) if "Design name" in s)
        renamed = next(i for i, s in enumerate(scripts) if 'Rename Design: Probed garden' in s)
        install = next(i for i, s in enumerate(scripts) if '"Install and restart"' in s and "click()" in s)
        self.assertLess(close, rename)
        self.assertLess(rename, renamed, "the rename waits for the renamed title")
        self.assertLess(renamed, change)
        self.assertLess(change, reopen)
        self.assertLess(reopen, install)

    def test_a_settings_change_that_finds_no_switch_stops_the_probe_before_the_install(self):
        clean, written, _, _, _ = self.run_probe(no_switch=True)
        self.assertFalse(clean)
        self.assertIn("stopped: no settings switch to change while the store was locked", written["notes"])
        self.assertFalse(any('"Install and restart"' in s and "click()" in s for s in ScriptedBridge.last_n_scripts))
        self.assertEqual(written["saved_name"], "Probe garden")

    def test_the_app_output_and_the_debug_unified_log_land_in_the_probe_folder(self):
        _, _, commands, popen, files = self.run_probe()
        stdout = popen.call_args.kwargs["stdout"]
        self.assertEqual(Path(stdout.name).name, "app-N.log")
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.STDOUT)
        log = next(command for command in commands if command[0] == "log")
        self.assertIn("--info", log)
        self.assertIn("--debug", log)
        predicate = log[log.index("--predicate") + 1]
        self.assertIn('process == "tccd"', predicate)
        self.assertIn('process == "syspolicyd"', predicate)
        self.assertEqual(files["unified-log.txt"], "tccd: probe line\n")

    def test_a_reset_bridge_socket_is_a_closed_bridge_that_wait_does_not_retry(self):
        bridge = smoke.Bridge.__new__(smoke.Bridge)
        bridge.calls = 0
        bridge.socket = unittest.mock.MagicMock()
        bridge.socket.sendall.side_effect = ConnectionResetError(54, "Connection reset by peer")
        with unittest.mock.patch.object(smoke.time, "sleep") as slept:
            with self.assertRaises(smoke.BridgeClosed):
                bridge.wait("return true", "anything", seconds=60)
        slept.assert_not_called()


if __name__ == "__main__":
    unittest.main()
