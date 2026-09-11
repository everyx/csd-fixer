# vendor/mutter

Authoritative source for window management and shadow decorations, vendored from upstream mutter.

- Source: https://gitlab.gnome.org/GNOME/mutter
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose:
  - `tools/gen-mutter.mjs` parses `default_shadow_classes` parameters and algorithms from `meta-shadow-factory.c` and `MetaWindowType` from `window.h`, generating `src/lib/mutterRules.generated.js` (do not edit the generated file directly).
  - `meta-window-actor-x11.c` preserves `has_shadow` decision logic as the basis for window decoration detection.
  - `window.h` provides authoritative `MetaWindowType` enum definition to prevent enum drift.
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run `node tools/gen-mutter.mjs`
  3. Verify that the generated diff in `src/lib/mutterRules.generated.js` matches expectations
