#!/bin/sh
# The .deb's post-install script (2.1-Q145): refreshes the MIME database so the .canopi type in
# /usr/share/mime/packages/canopi.xml takes effect, and the desktop file cache so file managers
# offer Canopi for it. Either tool may be absent on a minimal system; the package still installs.
set -e

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications
fi

exit 0
