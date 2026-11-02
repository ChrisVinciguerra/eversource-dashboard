#!/bin/sh
# Install (or reinstall) the launchd agent that runs mac_power_recorder.py
# forever, publishing this Mac as a dashboard device.
#
# Everything the agent touches lives under ~/.local/share — launchd agents
# can't read or write ~/Documents (macOS privacy protection) — so the script
# is copied there and devices/ just gets a {"source": <path>} pointer the
# dashboard pulls like any other remote source. Rerun after editing the
# recorder to refresh the copy.
#
# Usage: scripts/install_mac_power_agent.sh [device name] [device file]
#   device name  — dashboard chip label           (default: Mac)
#   device file  — devices/<file>.json to create  (default: mac.json)
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:-Mac}"
LABEL="com.energy-dashboard.mac-power"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/share/energy-dashboard/mac-power"

mkdir -p "$HOME/Library/LaunchAgents" "$STATE"
cp "$REPO/scripts/mac_power_recorder.py" "$STATE/mac_power_recorder.py"
printf '{ "source": "%s" }\n' "$STATE/device.json" > "$REPO/devices/${2:-mac.json}"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$STATE/mac_power_recorder.py</string>
    <string>--name</string><string>$NAME</string>
    <string>--device-out</string><string>$STATE/device.json</string>
    <string>--state-dir</string><string>$STATE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$STATE/recorder.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (state in $STATE, device pointer in devices/${2:-mac.json})"
