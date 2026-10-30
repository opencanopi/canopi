#!/usr/bin/env python3
"""The release smoke (ADR 0029 Release safety, 2.1-Q145): each installer a user downloads installs silently, the app
it installs opens on the start screen, and a `.canopi` opened by its file association opens in Canopi.

  install       installs a .deb (apt), an NSIS .exe (/S) or an MSI (msiexec /qn), or readies an AppImage; prints the
                installed executable. --planted installs a truncated copy instead, so the lane's planted run must fail
  start-screen  launches the installed executable and waits for the start screen: on Linux the real-app suite's
                start-screen spec drives it over tauri-driver; on Windows UI Automation reads the window's buttons
  open-design   opens a .canopi through the system's association (gio open, os.startfile) and waits for the app's
                log to say the Design loaded
  check-deb     the .deb's Version is the Debian form of the release version and dpkg ranks a beta below its stable
  repack-deb    rewrites a beta .deb's Version to that Debian form (the build step signs it again)
  deb-version   prints the Debian form: `2.1.0-beta.1` becomes `2.1.0~beta.1`, since dpkg ranks a hyphenated label
                above the release (the F6 probe: 2.1.0 over 2.1.0-beta.1 was a downgrade)
  macos-probe   the macOS self-update probe (2.1-Q136, M97): starts the installed N of the probe build (updater-e2e
                and the MCP bridge, whose WebSocket it drives) on a Design, edits it, makes the settings store
                unsaveable, updates to N+1 from the local channel, and reports App Management, the close dialog, the
                edit and the relaunch; it exits 1 unless every check passed, and its job never blocks a release.
                Beside the report it leaves the app's output (app-N.log) and the TCC and system policy unified log
                (unified-log.txt)

The workflow's Linux lanes run this inside `dbus-run-session -- xvfb-run` with a window manager, as the real-app
suite does; macOS is not smoked (2.1-Q135), only probed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
IDENTIFIER = "com.canopi.app"
START_SCREEN_SPEC = "e2e/platform/desktop/start-screen.spec.ts"
START_SCREEN_TEST = "opens on the start screen from its bundled frontend"
WAIT_SECONDS = 120
# What UI Automation sees of the window of process {pid}: every element's name, one per line.
UIA_NAMES = r"""
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, {pid})
foreach ($window in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)) {
  foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)) { $element.Current.Name }
}
"""

Run = Callable[..., subprocess.CompletedProcess]


class SmokeError(RuntimeError):
    """A release artifact a user could not install, start or open a Design with."""


class BridgeClosed(SmokeError):
    """The probe build's bridge connection is gone: Canopi closed, or reset the socket as it did."""


def run_command(command, **options) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, check=False, **options)


def deb_version(version: str) -> str:
    return version.replace("-", "~", 1)


def kind_of(artifact: Path) -> str:
    name = artifact.name
    for suffix, kind in ((".deb", "deb"), (".AppImage", "appimage"), ("-setup.exe", "nsis"), (".msi", "msi")):
        if name.endswith(suffix):
            return kind
    raise SmokeError(f"{name} is not a release installer the smoke covers")


def plant(artifact: Path, folder: Path) -> Path:
    """A truncated copy of `artifact` under its own name: what a broken download looks like."""
    folder.mkdir(parents=True, exist_ok=True)
    planted = folder / artifact.name
    with artifact.open("rb") as source:
        planted.write_bytes(source.read(max(1, artifact.stat().st_size // 2)))
    return planted


def installed_windows_executable() -> Path:
    """Canopi.exe under the per-user or the per-machine root; both roots are printed with what each holds, so a run
    that finds none says where it looked."""
    folders = [Path(root) / "Canopi" for root in (os.environ.get("LOCALAPPDATA", ""), os.environ.get("ProgramFiles", ""))
               if root]
    found = [folder / "Canopi.exe" for folder in folders if (folder / "Canopi.exe").is_file()]
    for folder in folders:
        print(f"{folder}: {'Canopi.exe' if folder / 'Canopi.exe' in found else 'no Canopi.exe'}", file=sys.stderr)
    if found:
        return found[0]
    raise SmokeError(f"no Canopi.exe under {' or '.join(map(str, folders)) or '%LOCALAPPDATA% or %ProgramFiles%'} "
                     "after the install")


def install(artifact: Path, run: Run = run_command) -> None:
    kind = kind_of(artifact)
    if kind == "appimage":
        artifact.chmod(artifact.stat().st_mode | 0o111)
        return
    command = {
        "deb": ["sudo", "apt-get", "install", "-y", str(artifact.resolve())],
        "nsis": [str(artifact), "/S"],
        "msi": ["msiexec", "/i", str(artifact), "/qn", "/norestart"],
    }[kind]
    result = run(command)
    print(f"{artifact.name} exited {result.returncode}", file=sys.stderr)
    if result.returncode != 0:
        raise SmokeError(f"{artifact.name} did not install (exit {result.returncode}): {result.stderr.strip()}")


def installed_executable(artifact: Path) -> Path:
    kind = kind_of(artifact)
    if kind == "appimage":
        return artifact
    return Path("/usr/bin/canopi-desktop") if kind == "deb" else installed_windows_executable()


def check_deb(artifact: Path, version: str, run: Run = run_command) -> None:
    control = run(["dpkg-deb", "-f", str(artifact), "Version"]).stdout.strip()
    if control != deb_version(version):
        raise SmokeError(f"{artifact.name} has Version {control}, not {deb_version(version)}")
    release = version.split("-", 1)[0]
    if control != release and run(["dpkg", "--compare-versions", control, "lt", release]).returncode != 0:
        raise SmokeError(f"dpkg does not rank {control} below {release}")


def repack_deb(artifact: Path, version: str, run: Run = run_command) -> None:
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder) / "root"
        if run(["dpkg-deb", "-R", str(artifact), str(root)]).returncode != 0:
            raise SmokeError(f"cannot unpack {artifact.name}")
        control = root / "DEBIAN/control"
        lines = [f"Version: {deb_version(version)}" if line.startswith("Version: ") else line
                 for line in control.read_text().splitlines()]
        control.write_text("\n".join(lines) + "\n")
        if run(["dpkg-deb", "--root-owner-group", "--build", str(root), str(artifact)]).returncode != 0:
            raise SmokeError(f"cannot repack {artifact.name}")


def shows_start_screen(names: list[str]) -> bool:
    return any(name.startswith("Open Design") for name in names)


def log_folder() -> Path:
    if sys.platform == "win32":
        return Path(os.environ["LOCALAPPDATA"]) / IDENTIFIER / "logs"
    data = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    return Path(data) / IDENTIFIER / "logs"


def design_loaded(logs: Path, after: float) -> bool:
    return any(path.stat().st_mtime >= after and "Design loaded" in path.read_text(errors="replace")
               for path in logs.glob("canopi*") if path.is_file())


def linux_start_screen(binary: Path, run: Run = run_command) -> None:
    command = ["npm", "run", "test:platform", "--", "--spec", START_SCREEN_SPEC, "--mochaOpts.grep", START_SCREEN_TEST]
    result = run(command, cwd=REPO_ROOT / "desktop/web", env={**os.environ, "CANOPI_E2E_APP": str(binary)})
    if result.returncode != 0:
        raise SmokeError(f"{binary} did not open on the start screen:\n{result.stdout}{result.stderr}")


def windows_start_screen(binary: Path, run: Run = run_command) -> None:
    app = subprocess.Popen([str(binary)])
    try:
        deadline = time.monotonic() + WAIT_SECONDS
        while time.monotonic() < deadline:
            if app.poll() is not None:
                raise SmokeError(f"{binary} exited ({app.returncode}) before its start screen")
            names = run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                         UIA_NAMES.replace("{pid}", str(app.pid))]).stdout.splitlines()
            if shows_start_screen(names):
                return
            time.sleep(2)
        raise SmokeError(f"{binary} showed no start screen within {WAIT_SECONDS} s")
    finally:
        app.kill()


def open_design(design: Path) -> None:
    started = time.time() - 1
    if sys.platform == "win32":
        os.startfile(design)  # noqa: S606 - the association is what is under test
    else:
        subprocess.Popen(["gio", "open", str(design)])
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if design_loaded(log_folder(), started):
            return
        time.sleep(2)
    raise SmokeError(f"{design.name} opened by its association did not load in Canopi within {WAIT_SECONDS} s")


# --- macOS self-update probe ----------------------------------------------------------------------------------

PROBE_CHECKS = (
    "N installed and driven",
    "N+1 offered",
    "N+1 downloaded and verified",
    "no App Management block or prompt",
    "unsaveable settings close offers Retry, Close anyway and Cancel",
    "unsaved edit kept",
    "relaunched as N+1 on the Design",
)
BRIDGE_PORTS = range(9223, 9323)
APP_MANAGEMENT = re.compile(r"kTCCServiceSystemPolicyAppBundles|App Management", re.IGNORECASE)
# A compact-style line from the `log` process itself: `<date> <time> <type> log[<pid>:<thread>] ...`.
LOG_PROCESS = re.compile(r"^\S+ \S+ +\S+ +log\[\d+:")
# The unified log the probe keeps and scans: TCC's and the system policy daemon's lines, info and debug included,
# and any other line naming App Management.
UNIFIED_LOG_PREDICATE = ('process == "tccd" OR process == "syspolicyd" '
                         'OR eventMessage CONTAINS[c] "App Management"')


def ws_frame(text: str, mask: bytes | None = None) -> bytes:
    """One final text frame; a client masks it (RFC 6455 5.3)."""
    payload = text.encode()
    mask = os.urandom(4) if mask is None else mask
    size = len(payload)
    header = bytes([0x81])
    if size < 126:
        header += bytes([0x80 | size])
    elif size < 1 << 16:
        header += bytes([0x80 | 126]) + size.to_bytes(2, "big")
    else:
        header += bytes([0x80 | 127]) + size.to_bytes(8, "big")
    return header + mask + bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))


def read_frame(stream) -> tuple[int, bytes]:
    """One frame's opcode and payload, unmasked."""
    def exactly(n: int) -> bytes:
        data = stream.read(n)
        if len(data) != n:
            raise BridgeClosed("the bridge closed its WebSocket")
        return data
    first, second = exactly(2)
    size = second & 0x7F
    if size == 126:
        size = int.from_bytes(exactly(2), "big")
    elif size == 127:
        size = int.from_bytes(exactly(8), "big")
    mask = exactly(4) if second & 0x80 else None
    payload = exactly(size)
    if mask:
        payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
    return first & 0x0F, payload


class Bridge:
    """The probe build's MCP bridge (tauri-plugin-mcp-bridge, localhost only): `js` runs a script in the page."""

    def __init__(self, deadline: float):
        while True:
            for port in BRIDGE_PORTS:
                try:
                    self.socket = socket.create_connection(("127.0.0.1", port), timeout=30)
                except OSError:
                    continue
                key = base64.b64encode(os.urandom(16)).decode()
                self.socket.sendall((f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                                     f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                                     "Sec-WebSocket-Version: 13\r\n\r\n").encode())
                self.stream = self.socket.makefile("rb")
                status = self.stream.readline()
                while self.stream.readline() not in (b"\r\n", b""):
                    pass
                if b" 101 " in status:
                    self.calls = 0
                    return
                self.socket.close()
            if time.time() > deadline:
                raise SmokeError("no MCP bridge answered on 127.0.0.1:9223-9322")
            time.sleep(1)

    def js(self, script: str):
        try:
            return self._js(script)
        except OSError as error:
            raise BridgeClosed(f"the bridge connection failed: {error}") from error

    def _js(self, script: str):
        self.calls += 1
        ident = f"probe-{self.calls}"
        self.socket.sendall(ws_frame(json.dumps({"id": ident, "command": "execute_js", "args": {"script": script}})))
        while True:
            opcode, payload = read_frame(self.stream)
            if opcode == 8:
                raise BridgeClosed("the bridge closed its WebSocket")
            if opcode != 1:
                continue
            message = json.loads(payload)
            if message.get("id") == ident:
                if not message.get("success", False):
                    raise SmokeError(f"a script failed in the page: {message.get('error')}")
                return message.get("data")

    def wait(self, script: str, what: str, seconds: float = 60):
        """Runs `script` until it answers truthy; a failing script is retried, a closed bridge never is."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                if value := self.js(script):
                    return value
            except BridgeClosed:
                raise
            except SmokeError:
                pass
            time.sleep(1)
        raise SmokeError(f"timed out: {what}")

    def press(self, label: str, seconds: float = 120) -> None:
        self.wait(f"""const button = [...document.querySelectorAll('[data-about-updates] button')]
            .find((b) => b.textContent.trim() === {json.dumps(label)} && b.getAttribute('aria-disabled') !== 'true');
            if (button) button.click(); return !!button""", f"About's {label}", seconds)

    def close(self) -> None:
        self.socket.close()


def app_management_lines(log: str) -> list[str]:
    """The unified log's App Management and TCC app-bundle lines: a block or a prompt names one. The `log` process's
    own lines are skipped: the probe's `log show` run is recorded with its predicate, which names App Management."""
    return [line for line in log.splitlines() if APP_MANAGEMENT.search(line) and not LOG_PROCESS.search(line)]


def probe_verdict(observed: dict[str, bool]) -> tuple[bool, list[str]]:
    failed = [name for name in PROBE_CHECKS if not observed.get(name)]
    return not failed, failed


def bundle_version(app: Path) -> str:
    return run_command(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString",
                        str(app / "Contents/Info.plist")]).stdout.strip()


def saved_name(design: Path) -> object:
    return json.loads(design.read_text()).get("name")


RENAME = """const name = {old};
    document.querySelector(`button[aria-label="Rename Design: ${{name}}"]`).click();
    await new Promise((settle) => setTimeout(settle, 300));
    const input = document.querySelector('input[aria-label="Design name"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, {new});
    input.dispatchEvent(new Event('input', {{ bubbles: true }}));
    // A key press of its own, as a keyboard delivers it: the field renders the typed name first.
    await new Promise((settle) => setTimeout(settle, 100));
    input.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true }}));
    return true"""

# About closes on Escape pressed inside it (its section's keydown); the answer is whether it is gone.
CLOSE_ABOUT = """const about = document.querySelector('[data-about-updates]');
    if (!about) return true;
    about.closest('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((settle) => setTimeout(settle, 300));
    return !document.querySelector('[data-about-updates]')"""

# Settings (opened when it is not), its About section, then About Canopi…, as a user reopens About.
OPEN_ABOUT = """if (document.querySelector('[data-about-updates]')) return true;
    if (!document.querySelector('[data-settings-section]')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
      await new Promise((settle) => setTimeout(settle, 500));
    }
    document.querySelector('[data-settings-section="about"]')?.click();
    await new Promise((settle) => setTimeout(settle, 300));
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'About Canopi…')?.click();
    await new Promise((settle) => setTimeout(settle, 300));
    return !!document.querySelector('[data-about-updates]')"""

# A settings change the locked store cannot take, so the close has settings to flush: the first device switch in
# Settings that is not the launch check's own key row, looked for section by section, turned over; its name goes in
# the report, null when no section has one. Settings opens only when it is not open (the shortcut toggles it).
CHANGE_A_SETTING = """if (!document.querySelector('[data-settings-section]')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
      await new Promise((settle) => setTimeout(settle, 500));
    }
    const find = () => [...document.querySelectorAll('[role="dialog"] input[role="switch"]')]
      .find((input) => !input.closest('[data-launch-check]'));
    let toggle = find();
    for (const section of document.querySelectorAll('[data-settings-section]')) {
      if (toggle) break;
      section.click();
      await new Promise((settle) => setTimeout(settle, 300));
      toggle = find();
    }
    if (!toggle) return null;
    toggle.click();
    const label = toggle.closest('label')?.textContent?.trim() ?? 'a switch';
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    (document.activeElement ?? document.body).dispatchEvent(escape);
    return label"""


def rename(bridge: Bridge, old: object, new: str) -> str:
    """Renames the open Design and waits for its renamed title: a rename the page dropped fails here, not later as a
    lost edit."""
    bridge.js(RENAME.format(old=json.dumps(old), new=json.dumps(new)))
    label = f"Rename Design: {new}"
    return bridge.wait(f"return document.querySelector({json.dumps(f'button[aria-label={json.dumps(label)}]')})"
                       f" && {json.dumps(label)}", f"the renamed title {label}")


def change_a_setting(bridge: Bridge) -> str:
    """Turns one device switch over (CHANGE_A_SETTING); without one the close has no settings to flush, so the M97
    check cannot run and the probe stops."""
    label = bridge.js(CHANGE_A_SETTING)
    if not label:
        raise SmokeError("no settings switch to change while the store was locked")
    return label


def recorded(read: Callable[[], object]) -> object:
    """What `read` answers, or why it could not: the report keeps it either way."""
    try:
        return read()
    except (OSError, ValueError, SmokeError, subprocess.SubprocessError) as error:
        return f"unreadable: {error}"

# After Install and restart: the failed install's status, or the close dialog's buttons. The close dialog is the
# save-problem alertdialog; About (role="dialog", still open) and Settings render before it, so a selector that also
# matched role="dialog" would answer with About's buttons before the close had flushed anything.
AFTER_INSTALL = """const status = document.querySelector('[data-about-updates] [role="status"]');
    if (status && status.textContent.includes('Update not installed')) return ['status: ' + status.textContent];
    const dialog = document.querySelector('[role="alertdialog"]');
    return dialog && [...dialog.querySelectorAll('button')].map((b) => b.textContent.trim())"""


def macos_probe(app: Path, design: Path, start: str, version: str, settings: Path, report: Path) -> bool:
    """Runs the probe and writes its report; True when clean. Each check records what it saw, and the first failure
    ends the run, so the report shows how far an update got."""
    observed: dict[str, bool] = {}
    notes: list[str] = []
    started = time.time()
    binary = next((app / "Contents/MacOS").iterdir())
    # N's output, which the N+1 its restart starts inherits, lands beside the report the job uploads.
    output = open(report.parent / "app-N.log", "wb")  # noqa: SIM115 - held until the probe ends
    process = subprocess.Popen([str(binary), str(design)], stdout=output, stderr=subprocess.STDOUT)
    lock = None
    try:
        bridge = Bridge(time.time() + WAIT_SECONDS)
        start_name = saved_name(design)
        bridge.wait(f"return !!document.querySelector('button[aria-label=\"Rename Design: {start_name}\"]')",
                    "the Design opened")
        observed["N installed and driven"] = bundle_version(app) == start
        bridge.wait("const action = document.querySelector('[data-update-notice] button'); "
                    "if (action) action.click(); return !!document.querySelector('[data-about-updates]')",
                    "the launch check's notice and About", WAIT_SECONDS)
        bridge.wait(f"return document.querySelector('[data-about-updates]').textContent.includes({json.dumps(version)})",
                    f"About offers {version}")
        observed["N+1 offered"] = True
        bridge.press("Download and install")
        bridge.wait("return [...document.querySelectorAll('[data-about-updates] button')]"
                    ".some((b) => b.textContent.trim() === 'Install and restart')", "the download verified", 300)
        observed["N+1 downloaded and verified"] = True
        # The launch notice opened About, a modal over the window: the edit and the settings change are made with it
        # closed, as a user makes them, then About reopens for the install.
        bridge.wait(CLOSE_ABOUT, "About closed")
        notes.append(f"renamed: {rename(bridge, start_name, 'Probed garden')}")
        # M97: the settings store is unsaveable while the update closes Canopi; the Design must be flushed first.
        lock = sqlite3.connect(settings, isolation_level=None, timeout=1)
        lock.execute("BEGIN EXCLUSIVE")
        notes.append(f"settings changed while the store was locked: {change_a_setting(bridge)}")
        bridge.wait(OPEN_ABOUT, "About reopened")
        bridge.press("Install and restart")
        try:
            buttons = bridge.wait(AFTER_INSTALL, "the install, then the close", 300)
        except BridgeClosed as error:
            buttons = None
            notes.append(f"after Install and restart: Canopi closed without a dialog ({error})")
        else:
            notes.append(f"after Install and restart: {buttons}")
        observed["unsaveable settings close offers Retry, Close anyway and Cancel"] = (
            buttons is not None and {"Retry", "Close anyway", "Cancel"} <= set(buttons))
        observed["unsaved edit kept"] = saved_name(design) == "Probed garden"
        lock.execute("ROLLBACK")
        lock.close()
        lock = None
        if buttons is not None:
            bridge.wait("const close = [...document.querySelectorAll('button')]"
                        ".find((b) => b.textContent.trim() === 'Close anyway');"
                        " if (close) close.click(); return !!close", "Close anyway")
        bridge.close()
        process.wait(timeout=WAIT_SECONDS)
        relaunched = Bridge(time.time() + WAIT_SECONDS)
        relaunched.wait("return !!document.querySelector('button[aria-label=\"Rename Design: Probed garden\"]')",
                        "the relaunch on the Design")
        observed["relaunched as N+1 on the Design"] = bundle_version(app) == version
        relaunched.close()
    except (SmokeError, OSError, subprocess.SubprocessError, sqlite3.Error) as error:
        notes.append(f"stopped: {error}")
    finally:
        if lock is not None:
            lock.close()
        output.close()
        log = run_command(["log", "show", "--style", "compact", "--info", "--debug",
                           "--predicate", UNIFIED_LOG_PREDICATE, "--start", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started - 5))]).stdout
        (report.parent / "unified-log.txt").write_text(log)
        blocked = app_management_lines(log)
        observed["no App Management block or prompt"] = not blocked and "N+1 downloaded and verified" in observed
        notes.extend(f"log: {line}" for line in blocked[:20])
        found = {"bundle_version": recorded(lambda: bundle_version(app)),
                 "saved_name": recorded(lambda: saved_name(design))}
    clean, failed = probe_verdict(observed)
    report.write_text(json.dumps({"clean": clean, "failed": failed, "observed": observed, "notes": notes, **found},
                                 indent=2))
    summary = [f"## macOS self-update probe (2.1-Q136): {'clean' if clean else 'not clean'}", ""]
    summary += [f"- {'pass' if observed.get(name) else 'FAIL'}: {name}" for name in PROBE_CHECKS]
    summary += ["", *[f"    {note}" for note in notes]]
    print("\n".join(summary))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write("\n".join(summary) + "\n")
    return clean


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    put = commands.add_parser("install")
    put.add_argument("artifact", type=Path)
    put.add_argument("--planted", action="store_true")
    start = commands.add_parser("start-screen")
    start.add_argument("binary", type=Path)
    opened = commands.add_parser("open-design")
    opened.add_argument("design", type=Path)
    for name in ("check-deb", "repack-deb"):
        deb = commands.add_parser(name)
        deb.add_argument("artifact", type=Path)
        deb.add_argument("--version", required=True)
    commands.add_parser("deb-version").add_argument("version")
    probe = commands.add_parser("macos-probe")
    probe.add_argument("--app", type=Path, required=True)
    probe.add_argument("--design", type=Path, required=True)
    probe.add_argument("--from-version", required=True, help="N, the installed version")
    probe.add_argument("--version", required=True, help="N+1, the version the channel announces")
    probe.add_argument("--settings", type=Path, required=True, help="the probe build's user.db")
    probe.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "macos-probe":
        return 0 if macos_probe(args.app, args.design.resolve(), args.from_version, args.version, args.settings,
                                args.report) else 1
    try:
        if args.command == "install":
            artifact = plant(args.artifact, Path(tempfile.mkdtemp())) if args.planted else args.artifact
            install(artifact)
            print(installed_executable(artifact))
        elif args.command == "start-screen":
            (windows_start_screen if sys.platform == "win32" else linux_start_screen)(args.binary)
        elif args.command == "open-design":
            open_design(args.design.resolve())
        elif args.command == "check-deb":
            check_deb(args.artifact, args.version)
        elif args.command == "repack-deb":
            repack_deb(args.artifact, args.version)
        else:
            print(deb_version(args.version))
    except (SmokeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
