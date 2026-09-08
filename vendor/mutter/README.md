# vendor/mutter

窗口管理与阴影装饰权威来源，从 mutter 上游 vendor 而来。

- 来源: https://gitlab.gnome.org/GNOME/mutter
- COMMIT: 见本目录 COMMIT 文件（当前 `cat COMMIT`）
- 用途:
  - `tools/gen-mutter.mjs` 从 `meta-shadow-factory.c` 解析 `default_shadow_classes` 参数与阴影算法，生成 `src/lib/mutterRules.generated.js`（勿手改生成产物）。
  - `meta-window-actor-x11.c` 保留 `has_shadow` 的决策逻辑作为窗口装饰判定依据。
- 更新:
  1. 重新 vendor 上游对应文件并更新 COMMIT
  2. `node tools/gen-mutter.mjs`
  3. 检查生成的 `src/lib/mutterRules.generated.js` diff 是否符合预期
