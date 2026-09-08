#!/usr/bin/env bash
# csd-fixer 开发辅助：在无头嵌套会话里跑 GNOME Shell + 测试应用
# 用法（或等价的 npm run，见 package.json）：
#   ./tools/dev.sh shell        # 后台启动无头嵌套 shell（日志: /tmp/csd-fixer-dev/shell.log）
#   ./tools/dev.sh log          # 实时看嵌套 shell 日志（Ctrl+C 退出）
#   ./tools/dev.sh app <cmd>    # 在嵌套会话里启动测试应用（同一 WAYLAND_DISPLAY）
#   ./tools/dev.sh ext <subcmd> # 在嵌套会话 D-Bus 里跑 gnome-extensions 命令
#   ./tools/dev.sh stop         # 停止嵌套 shell
#
# 安全原则（教训：绝不再 kill 主会话 gnome-shell）：
#   - 一切测试都在嵌套会话（--headless + --virtual-monitor）里做，主桌面零接触
#   - enable 扩展必须走嵌套会话自己的 D-Bus（dev.sh 内完成），另开终端会打到主桌面
#   - 无热重载：改代码 → ./tools/dev.sh stop && ./tools/dev.sh shell

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # 仓库根（脚本在 tools/ 下）
SRC_DIR="${SRC_DIR:-$ROOT/src}"              # 扩展源码目录（POC 可覆盖: SRC_DIR=$ROOT/poc/sdf）
UUID="$(python3 -c "import json; print(json.load(open('$SRC_DIR/metadata.json'))['uuid'])")"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
WL_DISPLAY="wayland-csd-fixer"
STATE_DIR="/tmp/csd-fixer-dev"
PIDFILE="$STATE_DIR/shell.pid"
LOG="$STATE_DIR/shell.log"

mkdir -p "$STATE_DIR"

cmd_shell() {
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo ">> 嵌套 shell 已在运行 (PID $(cat "$PIDFILE"))"
        return
    fi
    # 同步最新扩展代码 + 编译 GSettings schema（无 schemas/ 则跳过）
    mkdir -p "$EXT_DIR"
    cp -r "$SRC_DIR/metadata.json" "$SRC_DIR/extension.js" "$EXT_DIR/"
    [[ -d "$SRC_DIR/lib" ]] && cp -r "$SRC_DIR/lib" "$EXT_DIR/"
    [[ -d "$SRC_DIR/style" ]] && cp -r "$SRC_DIR/style" "$EXT_DIR/"
    [[ -d "$SRC_DIR/effects" ]] && cp -r "$SRC_DIR/effects" "$EXT_DIR/"
    if [[ -d "$SRC_DIR/schemas" ]]; then
        mkdir -p "$EXT_DIR/schemas"
        cp "$SRC_DIR/schemas/"*.xml "$EXT_DIR/schemas/"
        glib-compile-schemas "$EXT_DIR/schemas"
        # 注册到用户级 glib-2.0 schemas，使终端直接运行 gsettings 无需加环境变量
        mkdir -p "$HOME/.local/share/glib-2.0/schemas"
        ln -sf "$EXT_DIR/schemas/"*.xml "$HOME/.local/share/glib-2.0/schemas/"
        glib-compile-schemas "$HOME/.local/share/glib-2.0/schemas"
    fi
    rm -f "$PIDFILE" "$LOG"   # 清旧日志，避免新旧会话输出混淆

    echo ">> 启动无头嵌套 shell（后台，日志: $LOG）"
    chmod +x "$ROOT/tools/dev-shell.sh"
    CSD_FIXER_UUID="$UUID" setsid nohup dbus-run-session -- bash "$ROOT/tools/dev-shell.sh" > "$LOG" 2>&1 < /dev/null &
    disown
    # 等待 ready
    for i in $(seq 1 30); do
        if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
            echo ">> 嵌套 shell 就绪 (PID $(cat "$PIDFILE"))"
            sleep 2
            tail -5 "$LOG"
            return
        fi
        sleep 1
    done
    echo "!! 启动超时，日志尾部："
    tail -20 "$LOG"
    exit 1
}

cmd_log() {
    exec tail -f "$LOG"
}

cmd_app() {
    cmd_shell  # 确保在跑
    echo ">> [nested] WAYLAND_DISPLAY=$WL_DISPLAY: $*"
    env WAYLAND_DISPLAY="$WL_DISPLAY" "$@"
}

cmd_ext() {
    cmd_shell
    # 在嵌套会话的 D-Bus 里跑 gnome-extensions（只能通过嵌套 shell 自己的 bus）
    echo ">> [nested-dbus] gnome-extensions $*"
    bus="$(grep -o 'DBUS_SESSION_BUS_ADDRESS=[^ ]*' "$LOG" | head -1 || true)"
    if [[ -n "$bus" ]]; then
        env "${bus/=*}"="$(echo "$bus" | cut -d= -f2-)" gnome-extensions "$@"
    else
        echo "!! 找不到嵌套会话 bus 地址，请用 ./dev.sh shell 前台确认"; exit 1
    fi
}

cmd_stop() {
    if [[ -f "$PIDFILE" ]]; then
        echo ">> 停止嵌套 shell (PID $(cat "$PIDFILE"))"
        # 杀整棵进程树（dbus-run-session 会连带清理）
        pkill -f "wayland-display=$WL_DISPLAY" 2>/dev/null || true
        kill "$(cat "$PIDFILE")" 2>/dev/null || true
        rm -f "$PIDFILE"
    fi
    echo ">> 已清理"
}

case "${1:-}" in
    shell) cmd_shell ;;
    log) cmd_log ;;
    app) shift; cmd_app "$@" ;;
    ext) shift; cmd_ext "$@" ;;
    stop) cmd_stop ;;
    *) echo "用法: $0 {shell|log|app <cmd>|ext <subcmd>|stop}"; exit 1 ;;
esac
