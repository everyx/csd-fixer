# vendor/gtk

阴影渲染算法权威来源（GSK GPU 渲染器分析高斯积分），从 GTK4 上游 vendor 而来。

- 来源: https://gitlab.gnome.org/GNOME/gtk
- 原文件: gsk/gpu/shaders/gskgpuboxshadow.glsl
- COMMIT: 见本目录 COMMIT 文件（当前 `cat COMMIT`）
- 用途: 构建脚本提取其 2D 解析积分算法（erf, erf_range, gauss, ellipse_x, blur_rect, blur_corner, blur_rounded_rect），
  生成着色器代码（勿手改生成产物）
- 更新:
  1. 重新 vendor 上游对应文件并更新 COMMIT
  2. 运行构建脚本重新生成
  3. 检查生成代码 diff 是否符合预期
