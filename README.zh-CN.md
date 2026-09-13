![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

一个 GNOME Shell 扩展。只补缺失的圆角与阴影，让每个窗口都像 GNOME 原生的。

![对比：方角窗口 vs. 同一窗口补上圆角与投影](assets/preview.webp)

## 功能

- **只补缺口**：
  - 缺阴影 → 原生阴影：微信、多数 Qt/Electron 应用、无边框 X11 / Wayland 客户端；
  - 缺圆角 → 原生圆角：带系统标题栏的 X11 应用、裸 XWayland 客户端；
  - 两轴独立。
- **绝不重复装饰**：
  - 两层阴影 → 更黑、边缘错位；
  - 第二刀圆角 → 切内容或留毛边；
  - 拿不准 → 跳过。误漏一条规则可补，误画是观感 bug。[为什么 →](docs/decoration-model.md)
- **可手动修正**：误判 → 拾取窗口，建一条强制或屏蔽规则。[遇到问题 →](#遇到问题)
- **对齐 GNOME**：圆角、阴影、描边在各状态下与原生窗口一致——激活、失焦、贴边、最大化、全屏、高对比度。取值来自 libadwaita。

## 安装

GNOME Shell 45–50，Wayland 或 X11。

```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd window-nativizer
pnpm install
pnpm run install-ext
```

启用后注销重登（X11：Alt+F2、`r`）：

```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

尚未上架 extensions.gnome.org。

## 性能

- **静默零开销**：静态窗口不触发 JS，不额外重绘。
- **阴影预烘焙**：每种风格共用一张纹理，不再逐帧模糊；缩放只改纹理坐标。数字见 [docs/decoration-model.md](docs/decoration-model.md)。
- **最大化即退出**：最大化 / 全屏 / 贴边平铺时，阴影与离屏裁剪均跳过；`pnpm run benchmark:perf` 可核对预算。

## 遇到问题

- **缺圆角或阴影** → 拾取窗口，**强制**加上。
- **被多画了一层装饰** → 拾取窗口，**屏蔽**掉。
- **分数缩放下文字发虚** → 打开「优先保证文字清晰」（用圆角换清晰）。

规则在首选项里用拾取按钮创建，按窗口种类生效，不按应用。

## 开发

- **提交即 CI**：`pnpm install` 把 `core.hooksPath` 指向 `.githooks/`。
- **文档**：[docs/development.md](docs/development.md)。

## 致谢

- 取值生成自 [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita)，阴影着色器取自 [GTK4](https://gitlab.gnome.org/GNOME/gtk)，窗口行为遵循 [Mutter](https://gitlab.gnome.org/GNOME/mutter)。
- 同类：[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)。

## 开源许可

GPL-2.0-or-later
