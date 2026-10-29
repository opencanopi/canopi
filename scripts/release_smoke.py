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

The workflow's Linux lanes run this inside `dbus-run-session -- xvfb-run` with a window manager, as the real-app
suite does; macOS is not smoked (2.1-Q135).
"""

from __future__ import annotations

import argparse
import os
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
    for root in (os.environ.get("LOCALAPPDATA", ""), os.environ.get("ProgramFiles", "")):
        candidate = Path(root) / "Canopi" / "Canopi.exe"
        if root and candidate.is_file():
            return candidate
    raise SmokeError("no Canopi.exe under %LOCALAPPDATA%\\Canopi or %ProgramFiles%\\Canopi after the install")


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
    args = parser.parse_args(argv)
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
