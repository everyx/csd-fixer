# Development

## Setup

```sh
pnpm install
```

Unit tests need `jasmine-gjs` on `PATH`. It is not an npm package:

```sh
git clone --depth 1 https://github.com/ptomato/jasmine-gjs.git
meson setup jasmine-gjs/build jasmine-gjs && ninja -C jasmine-gjs/build install
```

## Checks

| Command | What it does |
|---|---|
| `pnpm test` | unit tests, run under gjs |
| `pnpm run test:e2e` | headless end-to-end run in a nested session: lifecycle, resize/move stress, a zero-warning audit of the log |
| `pnpm run check-style` | re-derives the generated style, shader, Mutter and locale artifacts from their sources and fails if they drifted |
| `pnpm run ego-lint` | the EGO review tool; `EGO_LINT` overrides which checkout it runs |
| `pnpm run pack` | builds `dist/<uuid>.zip` |
| `pnpm run shexli` | analyses that zip |

## Git hooks

`pnpm install` points git at `.githooks/`, so:

- **every commit** runs lint, `check-style`, the unit tests and ego-lint. The commit that
  breaks one is the commit that fixes it, so each commit stays valid on its own;
- **every push** additionally packs the extension, which is the one CI job a commit hook
  cannot cover.

Either can be skipped with `--no-verify` when that is what you mean.

## Documents

| Document | Contents |
|---|---|
| [decoration-model.md](decoration-model.md) | how a window's decoration is decided, and where it diverges from Mutter on purpose |
| [rule-model.md](rule-model.md) | the rule key and value format, the two groups, identity resolution |
| [architecture.md](architecture.md) | modules, the two processes, the actors |
| [shell-compatibility.md](shell-compatibility.md) | the Shell/Mutter API surface and the rules we work by |
