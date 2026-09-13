#!/bin/bash
# Nested development session (GNOME 50+: --devkit, mutter 50 removed --nested)
#
# Distinct from headless: devkit features a real rendering pipeline (virtual monitor +
# Screencast stream + libei input emulation), properly rendering windowGroup.
#
# Usage:
#   ./tools/devkit.sh            # Run in foreground with filtered logs
#   ./tools/devkit.sh bg         # Run in background (for script automation)
#   mdk client: /usr/lib/mutter-devkit (automatically spawned or run separately to view UI)
#
# Note: Do not pass --virtual-monitor (prevents overriding the MDK client's primary monitor role)
set -e
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
SRC_DIR="$ROOT/src"
UUID="$(python3 -c "import json; print(json.load(open('$SRC_DIR/metadata.json'))['uuid'])")"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
LOG=/tmp/window-nativizer-devkit.log

deploy_ext() {
    mkdir -p "$EXT_DIR"
    cp "$SRC_DIR/metadata.json" "$SRC_DIR/extension.js" "$EXT_DIR/"
    [[ -f "$SRC_DIR/prefs.js" ]] && cp "$SRC_DIR/prefs.js" "$EXT_DIR/"
    [[ -f "$SRC_DIR/stylesheet.css" ]] && cp "$SRC_DIR/stylesheet.css" "$EXT_DIR/"
    [[ -d "$SRC_DIR/lib" ]] && cp -r "$SRC_DIR/lib" "$EXT_DIR/"
    [[ -d "$SRC_DIR/effects" ]] && cp -r "$SRC_DIR/effects" "$EXT_DIR/"
    [[ -d "$SRC_DIR/locale" ]] && cp -r "$SRC_DIR/locale" "$EXT_DIR/"
    if [[ -d "$SRC_DIR/schemas" ]]; then
        mkdir -p "$EXT_DIR/schemas"
        cp "$SRC_DIR/schemas/"*.xml "$EXT_DIR/schemas/"
        glib-compile-schemas "$EXT_DIR/schemas"
    fi
}

deploy_ext

if [ "$1" = "bg" ]; then
    setsid dbus-run-session gnome-shell --devkit --wayland >"$LOG" 2>&1 < /dev/null &
    echo $! > /tmp/window-nativizer-devkit.pid
    sleep 7
    if ! pgrep -f "gnome-shell --devkit" > /dev/null; then
        echo "FAILED: Session failed to start, log tail:"; tail -5 "$LOG"; exit 1
    fi
    echo "OK: PID $(cat /tmp/window-nativizer-devkit.pid), log: $LOG"
    grep -a "display name" "$LOG" | tail -1
    exit 0
fi

echo "=== devkit nested session ==="
echo "Log: $LOG (Ctrl+C to exit)"
echo "Connect GUI client in another terminal: /usr/lib/mutter-devkit"
echo ""

dbus-run-session gnome-shell --devkit --wayland 2>&1 \
  | tee "$LOG" \
  | grep -v -E '(^$|a11y|dbus-daemon|gvfs|systemd1|fusermount|AT-SPI|XKEYBOARD)' \
  | grep --line-buffered -E '(window-nativizer|Gjs|JS ERROR|libmutter|CRITICAL|Warning|Running GNOME|display name|extension)' \
    || true
