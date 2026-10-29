"""The release checks (ADR 0029 Release safety): the release smoke (scripts/release_smoke.py) and the Release
Candidate workflow's updater duties (2.1-M27, M55, M82, M205, Q135, Q201)."""

import contextlib
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import unittest.mock

from scripts import release_smoke as smoke

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/release-candidate.yml"


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


def workflow_steps(text: str, job: str) -> dict[str, str]:
    body = text.split(f"\n  {job}:\n", 1)[1]
    end = re.search(r"\n  [A-Za-z0-9_-]+:\n", body)
    body = body[: end.start()] if end else body
    steps = re.split(r"\n      - (?=name: |uses: |id: )", body)
    return {re.match(r"(?:name|uses|id): ([^\n]+)", step).group(1): step for step in steps[1:]}


class ReleaseWorkflowTests(unittest.TestCase):
    text = WORKFLOW.read_text()

    def test_only_the_build_step_reads_the_updater_signing_key(self):
        """2.1-Q230: the key reaches the bundler and nothing else, in no workflow."""
        for workflow in (ROOT / ".github/workflows").glob("*.yml"):
            for job in re.findall(r"\n  ([A-Za-z0-9_-]+):\n", workflow.read_text()):
                for name, step in workflow_steps(workflow.read_text(), job).items():
                    if "secrets.TAURI_SIGNING_PRIVATE_KEY" in step:
                        self.assertEqual((workflow.name, job, name), ("release-candidate.yml", "build", "Build Tauri app"))
        self.assertIn("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD", workflow_steps(self.text, "build")["Build Tauri app"])

    def test_updater_artifacts_come_only_from_the_release_overlay_on_linux_and_windows(self):
        overlay = json.loads((ROOT / ".github/tauri-release-updater.json").read_text())
        self.assertEqual(overlay, {"bundle": {"createUpdaterArtifacts": True}})
        build = workflow_steps(self.text, "build")["Build Tauri app"]
        self.assertIn("--config .github/tauri-release-updater.json", build)
        self.assertEqual(self.text.count("tauri-release-updater.json"), 1)
        matrix = self.text.split("matrix:", 1)[1].split("runs-on:", 1)[0]
        rows = re.findall(r"- os: (\S+)\n((?:            [^\n]*\n)+)", matrix)
        self.assertEqual({os: "updater: true" in body for os, body in rows},
                         {"ubuntu-latest": True, "macos-14": False, "macos-15-intel": False, "windows-latest": True})

    def test_a_beta_builds_windows_as_the_nsis_installer_only(self):
        build = workflow_steps(self.text, "build")["Build Tauri app"]
        self.assertIn("needs.preflight.outputs.channel == 'beta' && '--bundles nsis'", build)

    def test_the_beta_deb_is_repacked_to_sort_below_its_stable_and_signed_again(self):
        build = workflow_steps(self.text, "build")["Build Tauri app"]
        self.assertIn("scripts/release_smoke.py repack-deb", build)
        self.assertIn("signer sign --app-version", build)

    def test_the_bundler_tools_come_from_copies_the_workflow_pins(self):
        steps = workflow_steps(self.text, "build")
        seed = steps["Pre-seed the AppImage bundler tools"]
        for tool in ("linuxdeploy-x86_64.AppImage", "AppRun-x86_64", "linuxdeploy-plugin-appimage.AppImage"):
            self.assertRegex(seed, rf"[0-9a-f]{{64}}  {re.escape(tool)}")
        self.assertIn("sha256sum --check --strict", seed)
        self.assertIn("$HOME/.cache}/tauri", seed)
        names = list(steps)
        self.assertLess(names.index("Pre-seed the AppImage bundler tools"), names.index("Build Tauri app"))

    def test_the_manifest_lists_signatures_and_verifies_the_channel_files_with_planted_runs(self):
        steps = workflow_steps(self.text, "manifest")
        joined = "\n".join(steps.values())
        self.assertIn("-name '*.sig'", joined)
        self.assertIn("scripts/update_channel.py generate", joined)
        self.assertIn("scripts/update_channel.py --conf", joined)
        planted = steps["The channel check fails on a planted unsigned artifact and a missing entry"]
        self.assertIn("planted run passed", planted)
        self.assertIn("channel-*.json", workflow_steps(self.text, "manifest")["Upload release-candidate manifest"])

    def test_the_macos_dmg_is_still_built_and_published_unsigned(self):
        """2.1-Q135: macOS keeps its dmg as today, with no updater artifacts and no smoke."""
        upload = workflow_steps(self.text, "build")["Upload artifacts"]
        self.assertIn("*.dmg", upload)
        self.assertNotRegex(self.text.split("\n  smoke-", 1)[1], r"macos")

    def test_each_smoke_lane_runs_once_green_and_once_planted(self):
        for job in ("smoke-linux", "smoke-windows"):
            steps = workflow_steps(self.text, job)
            joined = "\n".join(steps.values())
            self.assertIn("scripts/release_smoke.py", joined)
            self.assertIn("--planted", joined)
            self.assertIn("planted run passed", joined)

    def test_the_updater_end_to_end_lane_is_a_release_check(self):
        self.assertIn("uses: ./.github/workflows/updater-e2e.yml", self.text)

    def job(self, name: str) -> str:
        body = self.text.split(f"\n  {name}:\n", 1)[1]
        end = re.search(r"\n  [A-Za-z0-9_-]+:\n", body)
        return body[: end.start()] if end else body

    def test_a_stable_fix_without_the_updater_still_reaches_the_manifest(self):
        """Review finding (F6-c4): a 2.0.x stable fix (updater=false) skips the updater lane, and a skipped lane
        does not skip the manifest, or no stable fix could be promoted until 2.1.0."""
        self.assertIn("if: needs.preflight.outputs.updater == 'true'", self.job("updater-end-to-end"))
        manifest = self.job("manifest")
        self.assertIn("updater-end-to-end", manifest.split("\n", 1)[0])
        self.assertIn("if: ${{ !failure() && !cancelled() }}", manifest)

    def test_the_smoke_runs_main_s_release_tools_on_the_build_s_installers_and_design(self):
        """2.1-M216: the smoke script and the start-screen spec come from main's tools at tools_sha, so a release/2.0
        stable fix, whose tree has neither, is smoked too; the Design opened is the build's own fixture."""
        for job in ("smoke-linux", "smoke-windows"):
            with self.subTest(job=job):
                body = self.job(job)
                self.assertIn("ref: ${{ needs.preflight.outputs.tools_sha }}\n          path: release-tools", body)
                runs = re.findall(r"(?:python3?|-I) +(?:-I +)?(\S*release_smoke\.py)", body)
                self.assertTrue(runs)
                self.assertEqual(set(runs), {"release-tools/scripts/release_smoke.py"})
                self.assertIn("cp desktop/web/e2e/fixtures/canvas-base.canopi", body)

    def test_the_association_is_smoked_only_where_the_build_declares_it(self):
        """2.1-Q145 gave 2.1 the .canopi association; a 2.0.x stable fix declares none, so its smoke installs and
        starts each installer and skips only the open-by-association check."""
        self.assertIn("canopi_association: ${{ steps.identity.outputs.canopi_association }}", self.job("preflight"))
        for job in ("smoke-linux", "smoke-windows"):
            with self.subTest(job=job):
                body = self.job(job)
                self.assertIn("CANOPI_ASSOCIATION: ${{ needs.preflight.outputs.canopi_association }}", body)
                self.assertRegex(body, r'if \[ "\$CANOPI_ASSOCIATION" = true \]; then\n\s+python3? -I '
                                       r'release-tools/scripts/release_smoke.py open-design')


class UpdaterLaneTests(unittest.TestCase):
    """The updater end-to-end lane (.github/workflows/updater-e2e.yml; 2.1-M64, M82)."""

    text = (ROOT / ".github/workflows/updater-e2e.yml").read_text()

    def test_leaving_beta_reinstalls_stable_by_hand_over_an_installed_nsis_beta(self):
        """Review findings (F6-c4), 2.1-M64, M82: a user leaving beta runs the stable installer over the newer beta. The
        lane installs a pre-release-labelled build (Windows betas are NSIS only, 2.1-M27), checks Canopi.exe is that
        beta, then runs N's installer over it and checks the downgrade by Canopi.exe's version."""
        steps = workflow_steps(self.text, "updater")
        names = list(steps)
        beta = "9.0.2-beta.1"
        self.assertRegex(steps["Build N-1 and N"], r'versions="\$versions ' + re.escape(beta) + '"')
        self.assertIn("if [ \"${{ matrix.bundle }}\" = nsis ]", steps["Build N-1 and N"])
        leave = "Leaving beta reinstalls stable by hand (N's NSIS installer over an installed beta)"
        self.assertIn(leave, steps)
        self.assertLess(names.index("Update N-1 to N"), names.index(leave))
        step = steps[leave]
        self.assertIn("if: matrix.bundle == 'nsis'", step)
        # The installed build is a pre-release: its installer runs first, and Canopi.exe must then read as the beta.
        self.assertIn(f'install_and_expect "$RUNNER_TEMP/build-{beta}" {beta}', step)
        self.assertLess(step.index(f"build-{beta}"), step.index('install_and_expect "$RUNNER_TEMP/build-9.0.1" 9.0.1'))
        self.assertIn('"$installer" /S', step)
        self.assertIn("VersionInfo.ProductVersion", step)
        self.assertNotIn("build-9.0.0", step)

    def test_each_lane_build_sits_where_generate_finds_its_installer_key(self):
        """F6-c5: update_channel.py generate keys a payload by its folder, the release artifact's name; a build copied
        under the bundle's name gave good.json no platform, so the lane offered no update. Each lane's build is laid
        out as the workflow lays it, and generate must find exactly its installer's key."""
        from scripts import update_channel as channel

        matrix = re.findall(r"- os: \S+\n\s+bundle: (\S+)\n\s+artifact: (\S+)", self.text)
        self.assertEqual([bundle for bundle, _ in matrix], ["appimage", "deb", "nsis"])
        build = workflow_steps(self.text, "updater")["Build N-1 and N"]
        destination = re.search(r'cp -r target/debug/bundle/\$\{\{ matrix\.bundle \}\} "([^"]+)"', build)
        self.assertIsNotNone(destination, "the build copies its bundle folder into the version's build folder")
        payloads = {"appimage": "Canopi_9.0.1_amd64.AppImage", "deb": "Canopi_9.0.1_amd64.deb",
                    "nsis": "Canopi_9.0.1_x64-setup.exe"}
        for bundle, artifact in matrix:
            with self.subTest(bundle=bundle), tempfile.TemporaryDirectory() as temp:
                folder = Path(destination.group(1).replace("$RUNNER_TEMP", temp).replace("$version", "9.0.1")
                              .replace("${{ matrix.artifact }}", artifact)) / bundle
                folder.mkdir(parents=True)
                (folder / payloads[bundle]).write_bytes(b"payload")
                (folder / f"{payloads[bundle]}.sig").write_text("sig")
                found = channel.updater_artifacts(Path(temp) / "build-9.0.1")
                self.assertEqual(list(found), [f"{'windows-x86_64' if bundle == 'nsis' else 'linux-x86_64'}-{bundle}"])

    def test_the_nsis_lane_plants_a_signed_failing_installer_and_hands_the_spec_the_installers_it_runs(self):
        """F6-c5, 2.1-Q234, 2.1-M82, plan:192: before the spec runs, the NSIS lane announces a signed installer that exits
        with an error as 9.0.2 (failing.json) and names to the spec N-1's installer and the published 2.0.3 one, which it
        runs by hand."""
        steps = workflow_steps(self.text, "updater")
        names = list(steps)
        plant = steps["Plant a failing installer (NSIS)"]
        self.assertIn("if: matrix.bundle == 'nsis'", plant)
        self.assertIn("-OutputType ConsoleApplication", plant)
        self.assertIn("signer sign", plant)
        self.assertIn("generate --version 9.0.2", plant)
        self.assertIn('"$UPDATER_E2E_DIR/failing.json"', plant)
        # 2.1-M82: the spec runs N-1's installer by hand over a running Canopi with an edit.
        self.assertIn("UPDATER_E2E_N1_SETUP=", steps["Install N-1"])
        # plan:192: the spec goes back to the published 2.0.3 and on to 2.1 again.
        fetch = steps["Fetch the published 2.0.3 installer (NSIS)"]
        self.assertIn("if: matrix.bundle == 'nsis'", fetch)
        self.assertIn("gh release download v2.0.3", fetch)
        self.assertIn("UPDATER_E2E_STABLE_SETUP=", fetch)
        for step in ("Plant a failing installer (NSIS)", "Fetch the published 2.0.3 installer (NSIS)", "Install N-1"):
            self.assertLess(names.index(step), names.index("Update N-1 to N"), step)

    def test_the_macos_probe_job_reports_off_pull_requests_with_an_ephemeral_key(self):
        """2.1-Q136, M97: the probe runs on a dispatch and a Release Candidate (never a pull request), never blocks,
        signs with a key the job generates, builds N's dmg and N+1's archive with the MCP bridge (not the e2e feature,
        which refuses it), installs N into /Applications and runs release_smoke.py macos-probe."""
        job = self.text.split("\n  macos-probe:\n", 1)[1]
        self.assertIn("if: github.event_name != 'pull_request'", job)
        self.assertIn("runs-on: macos-latest", job)
        self.assertIn("continue-on-error: true", job)
        self.assertNotIn("secrets.", job)
        self.assertIn("signer generate --ci", job)
        self.assertIn("--features updater-e2e,mcp-bridge", job)
        self.assertNotIn(",e2e", job)
        self.assertIn("bundles=app,dmg", job)
        self.assertIn("cp -R \"$mount/Canopi.app\" /Applications/", job)
        self.assertIn("scripts/release_smoke.py macos-probe", job)
        self.assertIn("--from-version 9.0.0 --version 9.0.1", job)


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


if __name__ == "__main__":
    unittest.main()
