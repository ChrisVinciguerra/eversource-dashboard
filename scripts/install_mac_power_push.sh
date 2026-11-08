#!/bin/sh
# Install (or reinstall) the launchd agent that pushes this Mac's power
# device document to the home server every 15 minutes, where the dashboard
# there reads it through a devices/ source.
#
# Usage: scripts/install_mac_power_push.sh [dest]
#   dest — scp target (default: user@server:/path/devices/macbook.json)
set -eu

LABEL="com.energy-dashboard.mac-power-push"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/share/energy-dashboard/mac-power"
DEST="${1:-user@server:/path/devices/macbook.json}"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/scp</string>
    <string>-q</string>
    <string>$STATE/device.json</string>
    <string>$DEST</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$STATE/push.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (pushes $STATE/device.json -> $DEST every 15 min)"
