#!/bin/sh
# Install (or reinstall) the launchd agent that runs anker_power_recorder.py
# forever, publishing an Anker Prime A91B2 charging station as a dashboard
# device (per-port power over Anker's cloud MQTT).
#
# Like the Mac agent, everything lives under ~/.local/share (launchd agents
# can't touch ~/Documents) and devices/ gets a {"source": <path>} pointer.
# anker-solix-api isn't on PyPI and needs Python 3.12+, so a dedicated venv
# is built here (with uv if available). Rerun after editing the recorder.
#
# Usage: scripts/install_anker_power_agent.sh <anker email> [device name] [overlaps with]
#   anker email   — the Anker account that OWNS the charger (a shared
#                   account gets no standalone-device data)
#   device name   — dashboard chip label                 (default: Anker charger)
#   overlaps with — device that may charge through it    (default: MacBook)
set -eu

EMAIL="${1:?usage: $0 <anker email> [device name] [overlaps with]}"
NAME="${2:-Anker charger}"
OVERLAPS="${3:-MacBook}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.energy-dashboard.anker-power"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/share/energy-dashboard/anker-power"
VENV="$STATE/venv"

mkdir -p "$HOME/Library/LaunchAgents" "$STATE"
cp "$REPO/scripts/anker_power_recorder.py" "$STATE/anker_power_recorder.py"

if [ ! -x "$VENV/bin/python" ]; then
  if command -v uv >/dev/null; then
    uv venv --python '>=3.12' "$VENV"
  else
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' \
      || { echo "need python3 >= 3.12 (or install uv)"; exit 1; }
    python3 -m venv "$VENV"
  fi
fi
if command -v uv >/dev/null; then
  uv pip install --python "$VENV/bin/python" --quiet \
    'git+https://github.com/thomluther/anker-solix-api' certifi
else
  "$VENV/bin/pip" install --quiet \
    'git+https://github.com/thomluther/anker-solix-api' certifi
fi
CERTS="$("$VENV/bin/python" -c 'import certifi; print(certifi.where())')"

# The account password goes in the keychain, never on a command line or disk.
"$VENV/bin/python" "$STATE/anker_power_recorder.py" --username "$EMAIL" --login

printf '{ "source": "%s" }\n' "$STATE/device.json" > "$REPO/devices/anker.json"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/python</string>
    <string>$STATE/anker_power_recorder.py</string>
    <string>--username</string><string>$EMAIL</string>
    <string>--name</string><string>$NAME</string>
    <string>--overlaps-with</string><string>$OVERLAPS</string>
    <string>--device-out</string><string>$STATE/device.json</string>
    <string>--state-dir</string><string>$STATE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>SSL_CERT_FILE</key><string>$CERTS</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$STATE/recorder.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (state in $STATE, device pointer in devices/anker.json)"
echo "watch it: tail -f $STATE/recorder.log"
