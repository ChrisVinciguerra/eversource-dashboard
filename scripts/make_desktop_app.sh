#!/bin/zsh
# Create (or refresh) ~/Desktop/Energy.app — a double-clickable launcher for
# the dashboard, now hosted on the home server (CT 101). Pass a URL to
# override; use --local for the old behavior of serving from this repo.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$HOME/Desktop/Energy.app"
port=8537
url="${1:-https://energy.int.chrisv.us/}"

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

if [ "$url" = "--local" ]; then
  # Old behavior: start (or reuse) a local server from this repo.
  cat > "$app/Contents/MacOS/energy" <<EOF
#!/bin/zsh
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
else
  cat > "$app/Contents/MacOS/energy" <<EOF
#!/bin/zsh
open "$url"
EOF
fi
chmod +x "$app/Contents/MacOS/energy"

cp "$repo/assets/energy.icns" "$app/Contents/Resources/energy.icns"
touch "$app"  # nudge Finder to refresh the icon

echo "created $app"
