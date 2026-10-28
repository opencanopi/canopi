#!/bin/sh
# The Android lane's inverted step (plan:157): the smoke run against a blank page must fail, or the lane cannot fail.
# A file because android-emulator-runner runs each script line in its own `sh -c "…"`, which breaks a quoted line.
if CANOPI_E2E_PLANTED_PAGE=about:blank npm run test:android; then
  echo "::error::the Android smoke passed on a blank page: it cannot fail"
  exit 1
fi
