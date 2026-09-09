# CSD Fixer

[English](README.md) | [简体中文](README.zh-CN.md)

为缺少客户端边框（CSD）的应用（涵盖 Wayland 原生与 XWayland/X11 窗口，如微信 Linux 版/内置网页浏览器、Qt 应用、Electron 以及各类无边框窗口），补齐与 GNOME 原生应用视觉一致的圆角、内亮边与高斯柔和阴影，消除桌面视觉割裂感。

---

## ✨ 特性亮点

- **🎨 原生质感**：与 GNOME 官方 libadwaita 窗口视觉严格同源。全自动适配 Wayland 原生及 XWayland/X11 应用在激活、失焦、分屏贴边、最大化及高对比度等桌面状态。
- **⚡ 丝滑动效**：阴影与内亮边随窗口打开、关闭、最小化动画平滑淡入淡出，全程贴合缩放，绝无突变闪烁或边缘跳变。
- **🛠️ 细粒度应用规则**：首选项提供应用搜索选择器，支持针对特定窗口灵活定制规则（全部禁用、仅保留阴影、仅保留圆角）。
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
npm run pack
gnome-extensions install --force dist/csd-fixer@everyx.github.io.shell-extension.zip
```

---

## 🛠️ 开发与测试

```sh
# 运行单元测试
npm test

# 规则与样式一致性检查
npm run check-style

# EGO 官方审查规范检查
npm run ego-lint

# 打包发行文件
npm run pack
```

---

## 开源许可

GPL-3.0-or-later
