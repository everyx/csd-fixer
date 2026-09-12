# CSD Fixer

[English](README.md) | [简体中文](README.zh-CN.md)

给 GNOME 下没有装饰的窗口补上原生圆角与投影。

![CSD Fixer 预览](assets/preview.webp)

## 它做什么

- **只补缺口**：只处理既没自己画、也没从 Mutter 拿到装饰的窗口，例如微信、多数 Qt 与 Electron 应用、无边框的 X11 客户端。同一个窗口不会叠出两层阴影。
- **原生 GNOME 体验**：圆角、阴影、描边都和 GNOME 窗口相同，激活、失焦、贴边、最大化、全屏、高对比度下也一样。取值来自 libadwaita。
- **分数缩放下不糊**：可以舍掉圆角、保留阴影，换取文字清晰。

## 性能

- **静默状态零 CPU 开销**：静态窗口不触发任何多余的 JavaScript 计算或额外重绘。
- **GPU 阴影纹理烘焙**：不在每一帧对整个窗口面积重复运行高斯模糊着色器，而是按风格在全局预烘焙一张微型 145×145 纹理（仅约 82 KB 显存，全会话共用），通过 8 切片（8-slice，类似九宫格）四边形拼贴渲染。窗口缩放拉伸只变换纹理坐标，无需重新烘焙。
- **极低的动态缩放损耗**：在 60 FPS 连续调整窗口大小（Resize）的高压测试下，每帧额外 CPU 耗时小于 0.6 ms。
- **全屏与平铺零开销**：窗口在最大化、全屏或贴边平铺时，自动卸载阴影与离屏裁剪通道，开销立即归零。
- **基准测试守卫**：内置自动化性能基准测试与预算守卫（`pnpm run benchmark:perf`），防止性能退化。

## 规则

- **强制规则**：用它的拾取按钮点一个还是方角的窗口（它自己画了装饰，或 CSD Fixer 判断不了），规则此后作用于这一类窗口。
- **屏蔽规则**：反过来，点一个有装饰的窗口，规则把这一类窗口的装饰去掉。
- **按窗口种类，不按应用**：给微信某个对话框做的规则，不会作用于它的主窗口。

## 安装

GNOME Shell 45–50，Wayland 或 X11。

```sh
git clone https://github.com/everyx/csd-fixer.git
cd csd-fixer
pnpm install
pnpm run install-ext
```

GNOME 扩展商店：即将上架。

## 开发

- **提交即跑 CI 检查**：`pnpm install` 会把 git 指向 `.githooks/`。
- **模型文档**：见 [docs/development.md](docs/development.md)。

## 开源许可

GPL-2.0-or-later
