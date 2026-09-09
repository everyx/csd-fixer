# CSD Fixer

[English](README.md) | [简体中文](README.zh-CN.md)

Seamlessly bring native GNOME rounded corners, subtle inner highlights, and soft drop shadows to non-CSD applications (covering both native Wayland and XWayland/X11 windows such as WeChat Linux, Qt apps, and Electron).

---

## ✨ Features

- **🎨 Native Look & Feel**: Pixel-perfect visual parity with official GNOME / libadwaita windows. Automatically adapts to active, backdrop, tiled, maximized, and high-contrast desktop states across both Wayland native and XWayland/X11 applications.
- **⚡ Seamless Animations**: Shadows and inner highlights smoothly fade in and out alongside window open, close, and minimize animations with zero visual lag or edge popping.
- **🛠️ Granular App Rules**: Search installed applications directly in preferences and configure rules per window - disable all decorations, keep shadow only, or keep rounded corners only.
- **🔍 Crisp Text on Fractional Scaling**: Built-in option to prioritize font clarity on fractional scale displays by omitting corner clipping while preserving native shadows.
- **🌐 Full Multilingual Support**: Built with standard gettext (i18n), automatically matching your system language (English, Simplified Chinese, Traditional Chinese).

---

## 🚀 Installation

### From GNOME Extensions (Recommended)
Install **CSD Fixer** directly from [extensions.gnome.org](https://extensions.gnome.org/) *(coming soon)*.

### Manual Installation
```sh
git clone https://github.com/everyx/csd-fixer.git
cd csd-fixer
npm run install-ext
```

---

## 🛠️ Development

```sh
# Run tests
npm test

# Verify style, shader, and locale consistency with upstream
npm run check-style

# Run official EGO review static analysis
npm run ego-lint

# Build distributable extension package into dist/
npm run pack
```

---

## License

GPL-3.0-or-later
