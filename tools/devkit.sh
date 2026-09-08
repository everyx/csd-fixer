#!/bin/bash
# 嵌套开发会话（GNOME 50 姿势：--devkit，mutter 50 已移除 --nested）
#
# 与 POC 2 的 headless 本质不同：devkit 有真实渲染管线（虚拟监视器 +
# Screencast 屏流 + libei 输入注入），windowGroup 正常绘制——
# 窗口视觉验证不再受 headless 限制。
#
# 用法:
#   ./tools/devkit.sh            # 前台跑，日志过滤显示
#   ./tools/devkit.sh bg         # 后台跑（供脚本驱动）
#   mdk 客户端: /usr/lib/mutter-devkit（自动唤起，或另起连上看画面）
#
# 注意：坚决不设 --virtual-monitor（避免挤掉 MDK 客户端的主监视器地位导致丢顶栏，对齐 gradia-capture）
set -e
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
SRC_DIR="$ROOT/src"
UUID="$(python3 -c "import json; print(json.load(open('$SRC_DIR/metadata.json'))['uuid'])")"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
LOG=/tmp/csd-fixer-devkit.log

deploy_ext() {
    mkdir -p "$EXT_DIR"
    cp "$SRC_DIR/metadata.json" "$SRC_DIR/extension.js" "$EXT_DIR/"
    [[ -d "$SRC_DIR/lib" ]] && cp -r "$SRC_DIR/lib" "$EXT_DIR/"
    [[ -d "$SRC_DIR/style" ]] && cp -r "$SRC_DIR/style" "$EXT_DIR/"
    [[ -d "$SRC_DIR/effects" ]] && cp -r "$SRC_DIR/effects" "$EXT_DIR/"
    if [[ -d "$SRC_DIR/schemas" ]]; then
        mkdir -p "$EXT_DIR/schemas"
        cp "$SRC_DIR/schemas/"*.xml "$EXT_DIR/schemas/"
        glib-compile-schemas "$EXT_DIR/schemas"
    fi
}

deploy_ext

if [ "$1" = "bg" ]; then
    setsid dbus-run-session gnome-shell --devkit --wayland >"$LOG" 2>&1 < /dev/null &
    echo $! > /tmp/csd-fixer-devkit.pid
    sleep 7
    if ! pgrep -f "gnome-shell --devkit" > /dev/null; then
        echo "✗ 会话未存活，日志末尾："; tail -5 "$LOG"; exit 1
    fi
    echo "✓ PID $(cat /tmp/csd-fixer-devkit.pid)，日志: $LOG"
    grep -a "display name" "$LOG" | tail -1
    exit 0
fi

echo "═══ devkit 嵌套会话 ═══"
echo "日志: $LOG（Ctrl+C 退出）"
echo "另终端连画面: /usr/lib/mutter-devkit"
echo ""

dbus-run-session gnome-shell --devkit --wayland 2>&1 \
  | tee "$LOG" \
  | grep -v -E '(^$|a11y|dbus-daemon|gvfs|systemd1|fusermount|AT-SPI|XKEYBOARD)' \
  | grep --line-buffered -E '(csd-fixer|Gjs|JS ERROR|libmutter|CRITICAL|Warning|Running GNOME|display name|extension)' \
    || true
