# csd-fixer

给 GNOME Wayland 下**没有做 client-side decorations (CSD)** 的窗口补齐 GNOME
原生风格的圆角与阴影，实现桌面视觉一致。

- **目标窗口**：Qt（默认 Wayland 装饰）、老 Electron/frameless 应用等无自绘装饰的窗口
- **不碰**：已自绘装饰的窗口（GTK/libadwaita、Firefox、新版 Chromium/Electron CSD）——
  原样保留；XWayland 窗口默认跳过（Mutter 已提供阴影/SSD）
- **样式**：**固定跟随 GNOME 原生（libadwaita window.csd）**，从上游 SCSS 生成，
  完整状态机（聚焦/失焦/贴边/最大化/全屏/高对比）。**不做样式自定义**，
  不跟随第三方 GTK 主题
- **检测**：`buffer_rect == frame_rect` 判据（POC 1 已验证），纯公开 API，
  无 /proc 读取、无应用特例表

## 结构

```
src/
  extension.js        入口
  lib/
    detector.js       CSD 检测（纯函数，可单测）
    manager.js        信号状态机（窗口增删/状态切换）
    style.js          样式状态机
    effects/          圆角裁剪 + SDF 阴影（POC 2 后实现）
  style/defaults.js   样式生成产物（勿手改，tools/gen-style.mjs 生成）
vendor/libadwaita/    上游 SCSS + commit 记录
tests/                jasmine-gjs 单测
tools/                gen-style.mjs（样式生成器）、dev.sh（嵌套会话工具链）
```

## 开发

```sh
# ── 前置（一次性）：两个外部开发工具，都不入库 ──

# 1) jasmine-gjs：单测运行时（GNOME 官方，meson 项目无 npm 发行；
#    注意 npm 上的同名包是占位符，不要用）
git clone https://github.com/ptomato/jasmine-gjs /tmp/jasmine-gjs
meson setup /tmp/jasmine-gjs/_build /tmp/jasmine-gjs --prefix=$HOME/.local
ninja -C /tmp/jasmine-gjs/_build install   # 装到 ~/.local，确保 ~/.local/bin 在 PATH

# 2) gnome-extension-reviewer：扩展质量门禁（ego-lint）
git clone https://github.com/ZviBaratz/gnome-extension-reviewer.git \
    ~/.local/share/gnome-extension-reviewer
printf '#!/usr/bin/env bash\nexec bash ~/.local/share/gnome-extension-reviewer/ego-lint "$@"\n' \
    > ~/.local/bin/ego-lint
chmod +x ~/.local/bin/ego-lint           # 装完 ego-lint 直接可用

# ── 日常开发 ──

./tools/dev.sh shell      # 无头嵌套 shell（测试环境，绝不碰主会话）；或 npm run shell
./tools/dev.sh app CMD    # 嵌套会话中运行测试应用
./tools/dev.sh log        # 查看嵌套 shell 日志
./tools/dev.sh stop
npm test                  # 单测
ego-lint src/             # 质量门禁
npm run gen-style         # 从 vendor SCSS 重新生成样式（解析失败即报错）
npm run check-style       # CI：校验生成产物与上游一致
```

样式跟随上游更新：`vendor/libadwaita/` 换新 SCSS + 更新 COMMIT → `npm run gen-style`
→ review diff。

## 许可

GPL-3.0-or-later
