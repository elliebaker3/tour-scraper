#!/usr/bin/env bash
# Installs the user-level systemd service+timer (no root needed).
set -euo pipefail
mkdir -p ~/.config/systemd/user
cp "$(dirname "$0")"/tour-scraper.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tour-scraper.timer
# Keep user services running when logged out:
loginctl enable-linger "$USER" || true
echo "Installed. Check with: systemctl --user list-timers"
