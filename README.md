# CSD Fixer

[English](README.md) | [简体中文](README.zh-CN.md)

![CSD Fixer Preview](assets/preview.webp)

Seamlessly bring native GNOME rounded corners, subtle inner highlights, and soft drop shadows to non-CSD applications under GNOME (such as WeChat Linux, Qt apps, and Electron), while intelligently avoiding double shadows on Mutter-managed X11 windows.

---

## ✨ Features

- **🎨 Native Look & Feel**: Pixel-perfect visual parity with official GNOME / libadwaita windows. Automatically adapts to active, backdrop, tiled, maximized, and high-contrast desktop states.
- **⚡ Seamless Animations**: Shadows and inner highlights smoothly fade in and out alongside window open, close, and minimize animations with zero visual lag or edge popping.
- **🛠️ Precise Window Rules**: Pick any on-screen window to write a rule that targets exactly that window kind. **Suppress rules** remove the shadow and/or the rounded corners; **force rules** apply them even where detection assumes Mutter or the application already drew something. A rule never spills over to the rest of the application.
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
pnpm install
pnpm run install-ext
```

---

## 🛠️ Development

```sh
# Run unit tests. Requires jasmine-gjs on PATH - it is not an npm package:
#   git clone --depth 1 https://github.com/ptomato/jasmine-gjs.git
#   meson setup jasmine-gjs/build jasmine-gjs && ninja -C jasmine-gjs/build install
pnpm test

# Run headless E2E automated test (lifecycle, resize/move stress, zero-warning audit)
pnpm run test:e2e

# Verify style, shader, and locale consistency with upstream
pnpm run check-style

# Run official EGO review static analysis (override EGO_LINT to point at your checkout)
pnpm run ego-lint

# Build distributable extension package into dist/
pnpm run pack

# Verify extension package with official Shexli analyzer
pnpm run shexli
```

---

## License

GPL-2.0-or-later
