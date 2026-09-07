# vendor/libadwaita

样式权威来源（CSD 窗口装饰），从 libadwaita 上游 vendor 而来。

- 来源: https://gitlab.gnome.org/GNOME/libadwaita
- COMMIT: 见本目录 COMMIT 文件（当前 `cat COMMIT`）
- 用途: tools/gen-style.mjs 从这里解析 window.csd 的圆角/阴影参数，
  生成 src/style/defaults.js（勿手改生成产物）
- 更新: 
  1. 重新 vendor 上游对应文件并更新 COMMIT
  2. `node tools/gen-style.mjs`（解析失败=断言不过，会报错）
  3. 检查生成的 defaults.js diff 是否符合预期
