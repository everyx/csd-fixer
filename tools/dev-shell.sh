#!/usr/bin/env bash
# 嵌套会话启动脚本（由 dev.sh 调用；独立文件避免多层引号转义地狱）
set -u

# UUID 由调用方（dev.sh）通过环境变量传入
UUID="${CSD_FIXER_UUID:-csd-fixer@everyx.github.io}"
WL_DISPLAY="wayland-csd-fixer"
STATE_DIR="/tmp/csd-fixer-dev"
PIDFILE="$STATE_DIR/shell.pid"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

# 注意：本脚本在 dbus-run-session 的会话 bash 里运行（argv 见 dev.sh）
export G_MESSAGES_DEBUG='GNOME Shell'
export CSD_FIXER_UUID="$UUID"

gnome-shell --headless --wayland --wayland-display="$WL_DISPLAY" \
    --virtual-monitor 1920x1080 --unsafe-mode &
echo $! > "$PIDFILE"
sleep 4

# headless 固坑修正：无 GDM 激活流程时 window_group 保持隐藏，
# 窗口 actor 永不 mapped（视觉测试全部失真）。Eval 强制显示。
for i in $(seq 1 15); do
    BUS_ADDR="$(tr '\0' '\n' < /proc/$!/environ 2>/dev/null | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)"
    if [[ -n "$BUS_ADDR" ]]; then
        if gdbus call --address "$BUS_ADDR" --dest org.gnome.Shell \
            --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Eval \
            'global.window_group.show()' >/dev/null 2>&1; then
            echo "window_group.show() OK (attempt $i)"
            break
        fi
    fi
    sleep 1
done

# enable + 状态输出（走本会话自己的 D-Bus）
gnome-extensions enable "$UUID" || true
gnome-extensions info "$UUID" || true

wait
