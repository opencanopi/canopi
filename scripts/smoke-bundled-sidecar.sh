#!/usr/bin/env bash
# Prove that a `tauri build` output ships the GeoLibre CLI sidecar beside the
# Canopi executable, in the layout the installed app sees, by unpacking every
# package of one target and running the packaged `geolibre version`.
#
#   scripts/smoke-bundled-sidecar.sh <target-triple> [<bundle dir>]
#
# Linux: every .deb (dpkg-deb -x, sidecar at usr/bin/) and every .AppImage
# (--appimage-extract, no FUSE needed). macOS: every .app under bundle/macos
# (Contents/MacOS/). Windows: every NSIS installer under bundle/nsis, unpacked
# with 7-Zip (the sidecar sits beside Canopi.exe at the install root); the .msi
# is not unpacked here. Any target without a package to check fails.
#
# Linux packages must also start on the oldest supported distributions
# (Ubuntu 22.04, Debian 12): the app executable and the sidecar each fail when
# they need a glibc newer than GLIBC_FLOOR (2.0.1 needed GLIBC_2.39,
# canopi-eon8.14.6), and an unpacked AppImage must get past the dynamic loader.
# CI runs this script again in debian:12 on the downloaded packages.
#
# Disk: each package is unpacked only when its unpacked size fits in the scratch
# dir's free space (a .deb's Installed-Size, else four times the package: the
# plant DB inside unpacks to about three times its share), with a tenth more,
# and is removed once checked, so the need is the largest package's, not their
# sum (each is about 1.4 GB; canopi-f47t.52.228.58). Short of it, the script
# refuses naming both. One binary:
#
#   scripts/smoke-bundled-sidecar.sh glibc-floor <binary>
set -euo pipefail

GLIBC_FLOOR=2.35

# The newest GLIBC_x.y symbol version a dynamic binary needs, compared
# numerically; fails above the floor or when none can be read.
glibc_floor() {
  local binary=$1 needed
  needed=$(objdump -T "$binary" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -u -V | tail -n 1 || true)
  if [ -z "$needed" ]; then
    echo "no GLIBC symbol versions read from $binary" >&2
    return 1
  fi
  if [ "$(printf '%s\n%s\n' "$needed" "$GLIBC_FLOOR" | sort -V | tail -n 1)" != "$GLIBC_FLOOR" ]; then
    echo "$binary needs GLIBC_$needed, above the $GLIBC_FLOOR floor (Ubuntu 22.04, Debian 12)" >&2
    return 1
  fi
  echo "$binary needs GLIBC_$needed (floor $GLIBC_FLOOR)"
}

if [ "${1:-}" = glibc-floor ]; then
  glibc_floor "${2:?binary}"
  exit
fi

triple=${1:?target triple}
root=$(cd "$(dirname "$0")/.." && pwd)
bundle=${2:-$root/target/$triple/release/bundle}
# Absolute, because the AppImage is extracted from inside the scratch dir.
bundle=$(cd "$bundle" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
checked=0

run_sidecar() {
  local sidecar=$1
  if [ ! -f "$sidecar" ]; then
    echo "missing sidecar: $sidecar" >&2
    exit 1
  fi
  local dir
  dir=$(dirname "$sidecar")
  # The application executable must be beside it: that is where discovery
  # looks. Linux packages name it after the crate (canopi-desktop), macOS and
  # Windows after the product (Canopi, Canopi.exe).
  local app
  app=$(find "$dir" -maxdepth 1 -type f \( -iname 'canopi' -o -iname 'canopi-desktop' -o -iname 'canopi.exe' -o -iname 'canopi-desktop.exe' \) | head -n 1)
  if [ -z "$app" ]; then
    echo "no Canopi executable beside $sidecar" >&2
    ls -l "$dir" >&2
    exit 1
  fi
  chmod +x "$sidecar" 2>/dev/null || true
  local version
  version=$("$sidecar" version)
  echo "$sidecar -> $version (beside $(basename "$app"))"
  case "$triple" in
    *linux*)
      glibc_floor "$app"
      glibc_floor "$sidecar"
      ;;
  esac
  checked=$((checked + 1))
}

# Free KiB in the scratch dir's filesystem, or nothing when df cannot say;
# never a failure, which set -e would turn into an exit with no message.
free_kib() {
  df -Pk "$scratch" 2>/dev/null | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print $4 }' || true
}

# Refuse to unpack `package` unless `need` KiB (a tenth more for the
# filesystem's own use) are free; say both either way.
room() {
  local package=$1 need=$2 free
  need=$((need + need / 10))
  free=$(free_kib)
  if [ -z "$free" ]; then
    echo "unpacking $(basename "$package"): needs about $((need / 1024)) MiB; df reads no free space for $scratch"
    return
  fi
  if [ "$free" -lt "$need" ]; then
    echo "not enough disk space to unpack $(basename "$package"): it needs about $((need / 1024)) MiB, and $scratch has $((free / 1024)) MiB free" >&2
    exit 1
  fi
  echo "unpacking $(basename "$package"): needs about $((need / 1024)) MiB, $((free / 1024)) MiB free"
}

# Four times a package's size in KiB: the unpacked need of one whose size
# says nothing else about it.
fourfold_kib() {
  echo $(( ($(wc -c <"$1") * 4 + 1023) / 1024 ))
}

# A .deb's Installed-Size in KiB, else four times its size.
deb_kib() {
  local size
  size=$(dpkg-deb -f "$1" Installed-Size 2>/dev/null || true)
  case "$size" in
    '' | *[!0-9]*) fourfold_kib "$1" ;;
    *) echo "$size" ;;
  esac
}

# An unpack that still failed: say how much room was left.
unpack_failed() {
  local free room="an unknown amount"
  free=$(free_kib)
  if [ -n "$free" ]; then room="$((free / 1024)) MiB"; fi
  echo "unpacking $(basename "$1") failed with $room free in $scratch" >&2
  exit 1
}

# Start an unpacked AppImage with no display: it must get past the dynamic
# loader (bundled libraries, symbol versions) and fail, if at all, for the
# missing display. A run still going after 30 s has started too.
start_appimage() {
  local apprun=$1/AppRun log status=0
  log=$(mktemp -p "$scratch")
  env -u DISPLAY -u WAYLAND_DISPLAY timeout 30 "$apprun" >"$log" 2>&1 || status=$?
  if [ "$status" -eq 127 ] || grep -qE "error while loading shared libraries|version \`[A-Z]+_[0-9.]+' not found|symbol lookup error" "$log"; then
    echo "the packaged app did not start ($apprun, exit $status):" >&2
    cat "$log" >&2
    exit 1
  fi
  echo "$apprun got past the loader (exit $status: $(tail -n 1 "$log"))"
}

case "$triple" in
  *linux*)
    for deb in "$bundle"/deb/*.deb; do
      [ -e "$deb" ] || continue
      out="$scratch/deb-$(basename "$deb" .deb)"
      room "$deb" "$(deb_kib "$deb")"
      dpkg-deb -x "$deb" "$out" || unpack_failed "$deb"
      run_sidecar "$out/usr/bin/geolibre"
      rm -rf "$out"
    done
    for appimage in "$bundle"/appimage/*.AppImage; do
      [ -e "$appimage" ] || continue
      out="$scratch/appimage-$(basename "$appimage" .AppImage)"
      room "$appimage" "$(fourfold_kib "$appimage")"
      mkdir -p "$out"
      chmod +x "$appimage"
      (cd "$out" && "$appimage" --appimage-extract >/dev/null) || unpack_failed "$appimage"
      run_sidecar "$out/squashfs-root/usr/bin/geolibre"
      start_appimage "$out/squashfs-root"
      rm -rf "$out"
    done
    ;;
  *darwin*)
    for app in "$bundle"/macos/*.app; do
      [ -e "$app" ] || continue
      run_sidecar "$app/Contents/MacOS/geolibre"
    done
    ;;
  *windows*)
    for installer in "$bundle"/nsis/*-setup.exe; do
      [ -e "$installer" ] || continue
      out="$scratch/nsis-$(basename "$installer" .exe)"
      room "$installer" "$(fourfold_kib "$installer")"
      7z x -y -o"$out" "$installer" >/dev/null || unpack_failed "$installer"
      run_sidecar "$out/geolibre.exe"
      rm -rf "$out"
    done
    ;;
  *)
    echo "unknown target: $triple" >&2
    exit 1
    ;;
esac

if [ "$checked" -eq 0 ]; then
  echo "no package under $bundle carried a sidecar to check" >&2
  exit 1
fi
echo "sidecar verified in $checked package(s) for $triple"
