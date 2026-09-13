![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

A GNOME Shell extension. Native rounded corners and shadows, only where missing — so every window looks native to GNOME.

![Before/after: a square window next to the same window with rounded corners and a drop shadow](assets/preview.webp)

## Features

- **Only fills gaps.**
  - Missing shadow → native shadow: WeChat, most Qt/Electron apps, frameless X11 and Wayland clients.
  - Missing corners → native corners: X11 with a system title bar, bare XWayland clients.
  - Shadow and corners are independent axes.
- **Never double-decorates.**
  - Two shadows → darker and misaligned.
  - A second rounded clip → cut content, or a fringe.
  - Unsure → skip. A false skip costs one rule; a wrong decoration is a visual bug. [Why →](docs/decoration-model.md)
- **Hand-fixable.** Wrong guess → pick the window, make a force or suppress rule. [Troubleshooting →](#troubleshooting)
- **Matches GNOME.** Corners, shadow and outline track a native window in every state: focused, backdrop, tiled, maximized, fullscreen, high contrast. Values from libadwaita.

## Installation

GNOME Shell 45–50, Wayland or X11.

```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd window-nativizer
pnpm install
pnpm run install-ext
```

Enable, then re-login (X11: Alt+F2, `r`):

```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

Not on extensions.gnome.org yet.

## Performance

- **No idle cost.** Static windows: no JavaScript, no extra redraws.
- **Baked shadows.** One shared texture per style instead of a per-frame blur; resizing only moves texture coordinates. Numbers: [docs/decoration-model.md](docs/decoration-model.md).
- **Drops out when maximized.** Maximized, fullscreen, snap-tiled: shadow and offscreen clip skipped. `pnpm run benchmark:perf` checks the budgets.

## Troubleshooting

- **Missing corners or shadow** → pick the window, **force** the decoration.
- **Decorated when it shouldn't be** → pick the window, **suppress** the decoration.
- **Soft text on a fractional scale** → enable **Prioritize crisp text** (trades corners for sharpness).

Rules come from the pick button in the preferences, and apply per window kind, not per app.

## Development

- **Commit = CI.** `pnpm install` sets `core.hooksPath` to `.githooks/`.
- **Docs.** [docs/development.md](docs/development.md).

## Credits

- Values generated from [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita); shadow shader from [GTK4](https://gitlab.gnome.org/GNOME/gtk); window behaviour follows [Mutter](https://gitlab.gnome.org/GNOME/mutter).
- Related: [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners).

## License

GPL-2.0-or-later
