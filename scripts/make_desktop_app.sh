#!/bin/zsh
# Create (or refresh) ~/Desktop/Energy.app — a double-clickable launcher for
# the dashboard. The app starts `eversource.py serve` from this repo, or just
# opens the browser if the server is already running.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$HOME/Desktop/Energy.app"
port=8537

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Energy</string>
  <key>CFBundleIdentifier</key><string>local.eversource.energy</string>
  <key>CFBundleExecutable</key><string>energy</string>
  <key>CFBundleIconFile</key><string>energy</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

cat > "$app/Contents/MacOS/energy" <<EOF
#!/bin/zsh
# Launches the Eversource energy dashboard (or opens it if already running).
# The script must exit right away — if it stayed alive as the server, macOS
# would treat the app as "already open" and ignore the next double-click.
export PATH="/opt/homebrew/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH"
cd "$repo" || exit 1
if nc -z 127.0.0.1 $port 2>/dev/null; then
  open "http://127.0.0.1:$port/"
  exit 0
fi
nohup uv run eversource.py serve >/dev/null 2>&1 &
disown
EOF
chmod +x "$app/Contents/MacOS/energy"

cp "$repo/assets/energy.icns" "$app/Contents/Resources/energy.icns"
touch "$app"  # nudge Finder to refresh the icon

echo "created $app"
