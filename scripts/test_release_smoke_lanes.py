"""The Release Candidate workflow's updater duties and its updater end-to-end lane (.github/workflows/release-candidate.yml,
updater-e2e.yml; 2.1-M27, M55, M64, M82, M205, Q135, Q201), split from test_release_smoke.py, which holds the release
smoke's own cases (scripts/release_smoke.py; ADR 0029 Release safety)."""

import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/release-candidate.yml"


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

    def test_every_updater_lane_overlay_drops_each_bundle_input_ci_does_not_have(self):
        """canopi-f47t.52.228.15.2: the lane bundles from a clean checkout, so each overlay drops every bundled resource
        and sidecar git does not track (the plant catalog, the GeoLibre CLI), or the bundler stops on a missing file."""
        import ast
        bundle = json.loads((ROOT / "desktop/tauri.conf.json").read_text())["bundle"]
        tracked = set(subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split())
        untracked_resources = {source for source in bundle.get("resources", {})
                               if (ROOT / "desktop" / source).resolve().relative_to(ROOT).as_posix() not in tracked}
        self.assertIn("resources/canopi-core.db", untracked_resources)
        text = (ROOT / ".github/workflows/updater-e2e.yml").read_text()
        overlays = [ast.literal_eval(match) for match in re.findall(r'"bundle": (\{[^\n]*\}),\n', text)]
        self.assertEqual(len(overlays), 2)
        for overlay in overlays:
            self.assertEqual({source for source, target in overlay.get("resources", {}).items() if target is None}, untracked_resources)
            if bundle.get("externalBin"):
                self.assertEqual(overlay.get("externalBin"), [])

    def test_no_workflow_or_job_env_reads_the_runner_context(self):
        """canopi-f47t.52.228.15.1: GitHub refuses a workflow whose workflow- or job-level env reads `runner`, so it never starts."""
        for workflow in (ROOT / ".github/workflows").glob("*.yml"):
            for block in re.findall(r"(?m)^((?:  )?  )?env:\n((?:\1  [^\n]*\n)+)", workflow.read_text()):
                self.assertNotIn("runner.", block[1], workflow.name)

    def test_updater_artifacts_come_only_from_the_release_overlay_on_linux_and_windows(self):
        overlay = json.loads((ROOT / ".github/tauri-release-updater.json").read_text())
        self.assertEqual(overlay, {"bundle": {"createUpdaterArtifacts": True}})
        build = workflow_steps(self.text, "build")["Build Tauri app"]
        self.assertIn("--config .github/tauri-release-updater.json", build)
        self.assertEqual(self.text.count("tauri-release-updater.json"), 1)
        matrix = self.text.split("matrix:", 1)[1].split("runs-on:", 1)[0]
        rows = re.findall(r"- os: (\S+)\n((?:            [^\n]*\n)+)", matrix)
        self.assertEqual({os: "updater: true" in body for os, body in rows},
                         {"ubuntu-latest": True, "macos-15": False, "macos-15-intel": False, "windows-latest": True})

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
        lane installs a pre-release-labelled build (Windows betas are NSIS only, 2.1-M27), checks the installed exe is that
        beta, then runs N's installer over it and checks the downgrade by the exe's version."""
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
        # The installed build is a pre-release: its installer runs first, and the installed exe must then read as the beta.
        self.assertIn(f'install_and_expect "$RUNNER_TEMP/build-{beta}" {beta}', step)
        self.assertLess(step.index(f"build-{beta}"), step.index('install_and_expect "$RUNNER_TEMP/build-9.0.1" 9.0.1'))
        self.assertIn('"$installer" /S', step)
        self.assertIn("VersionInfo.ProductVersion", step)
        self.assertNotIn("build-9.0.0", step)

    def test_canopi_f47t_52_228_15_n_minus_1_installs_on_windows_through_the_release_smoke(self):
        # The Release Candidate's install: /S passed without MSYS rewriting, the exit code and both roots printed.
        nsis = workflow_steps(self.text, "updater")["Install N-1"].split("nsis)", 1)[1].split(";;", 1)[0]
        self.assertIn('app="$(python -I scripts/release_smoke.py install "$installer")"', nsis)
        self.assertNotIn("/S", nsis)

    def test_canopi_f47t_52_228_15_leaving_beta_stops_the_installed_exe_by_its_own_name(self):
        # Tauri installs canopi-desktop.exe (the cargo binary), so a process named Canopi never runs: the step stops
        # and names the exe the install reported (CANOPI_E2E_APP).
        step = workflow_steps(self.text, "updater")["Leaving beta reinstalls stable by hand (N's NSIS installer over an installed beta)"]
        self.assertNotIn("Get-Process -Name Canopi ", step)
        self.assertIn("GetFileNameWithoutExtension($env:CANOPI_E2E_APP)", step)
        self.assertNotIn("Canopi.exe", step)

    def test_canopi_f47t_52_228_15_each_job_masks_its_updater_key_before_exporting_it(self):
        # The per-run key is throwaway, yet each step's env block would print it: masked before it reaches GITHUB_ENV.
        exports = [m.start() for m in re.finditer(r'echo "TAURI_SIGNING_PRIVATE_KEY=\$\(cat "\$key"\)"', self.text)]
        self.assertEqual(len(exports), 2)
        for at in exports:
            step = self.text[:at].rsplit("      - name: ", 1)[1]
            self.assertRegex(step, r'::add-mask::\$line"; done < "\$key"')

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
        self.assertIn("build --debug --features updater-e2e,mcp-bridge", job)
        self.assertNotIn(",e2e", job)
        self.assertIn("bundles=app,dmg", job)
        self.assertIn("cp -R \"$mount/Canopi.app\" /Applications/", job)
        self.assertIn("scripts/release_smoke.py macos-probe", job)
        self.assertIn("--from-version 9.0.0 --version 9.0.1", job)


if __name__ == "__main__":
    unittest.main()
