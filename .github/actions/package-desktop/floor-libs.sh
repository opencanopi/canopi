#!/usr/bin/env bash
# The desktop base libraries every Linux desktop has, on the debian:12 floor image both linux-floor jobs (build.yml and
# release-candidate.yml) start the packages on. A mirror that drops is retried and each call bounded, as in
# install-linux-deps (canopi-f47t.52.228.58), so a stalled mirror fails this step by name before the job's deadline.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt=(-o Acquire::Retries=5 -o Acquire::http::Timeout=60)
timeout 5m apt-get "${apt[@]}" update
timeout 10m apt-get "${apt[@]}" install -y binutils libdrm2 libegl1 libexpat1 libfontconfig1 libfreetype6 \
  libfribidi0 libgbm1 libgl1 libharfbuzz0b libwayland-client0 libx11-6 libx11-xcb1 libxcb1
