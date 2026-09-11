# CSD Fixer

[English](README.md) | [简体中文](README.zh-CN.md)

![CSD Fixer 效果预览](assets/preview.webp)

为缺少客户端边框（CSD）的应用（如微信 Linux 版、各类 Qt 应用、Electron 以及无边框窗口），补齐与 GNOME 原生应用视觉一致的圆角、内亮边与高斯柔和阴影；同时智能避让 Mutter 托管的 X11 原生阴影，杜绝双重阴影。

---

## ✨ 特性亮点

- **🎨 原生质感**：与 GNOME 官方 libadwaita 窗口视觉严格同源。全自动适配窗口激活、失焦、分屏贴边、最大化及高对比度等桌面状态。
- **⚡ 丝滑动效**：阴影与内亮边随窗口打开、关闭、最小化动画平滑淡入淡出，全程贴合缩放，绝无突变闪烁或边缘跳变。
- **🛠️ 精确的窗口规则**：拾取屏幕上的任意窗口即可添加规则，精确作用于该窗口种类。**屏蔽规则**去掉阴影和/或圆角；**强制规则**在检测认为 Mutter 或应用已经画过时仍然补上。一条规则绝不会蔓延到该应用的其他窗口。
- **🔍 分数缩放清晰度优化**：内置“优先保证文字清晰”模式，在分数缩放屏幕上免除圆角抗锯齿裁剪（保留阴影），彻底消除字体重采样模糊。
- **🌐 完整多语言支持**：基于 gettext 标准国际化架构，自适应系统语言（内置英文、简体中文、繁体中文）。

---

## 🚀 安装方式

### 从 GNOME 扩展商店安装（推荐）
直接在 [extensions.gnome.org](https://extensions.gnome.org/) 搜索安装 **CSD Fixer** *(即将上架)*。

### 手动构建安装
```sh
git clone https://github.com/everyx/csd-fixer.git
cd csd-fixer
pnpm install
pnpm run install-ext
```

---

## 🛠️ 开发与测试

```sh
# 运行单元测试。需要 PATH 中有 jasmine-gjs（它不是 npm 包，需源码安装）：
#   git clone --depth 1 https://github.com/ptomato/jasmine-gjs.git
#   meson setup jasmine-gjs/build jasmine-gjs && ninja -C jasmine-gjs/build install
pnpm test

# 运行无头端到端自动化测试（覆盖全生命周期、移动/拉伸压测、日志零警告审计）
pnpm run test:e2e

# 校验样式、着色器与翻译与上游一致
pnpm run check-style

# EGO 官方审查规范检查（EGO_LINT 可覆盖默认检出路径）
pnpm run ego-lint

# 打包发行文件
pnpm run pack

# 官方 Shexli 静态打包分析
pnpm run shexli
```

---

## 开源许可

GPL-2.0-or-later
