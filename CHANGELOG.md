# Changelog

## [0.1.1](https://github.com/everyx/csd-fixer/compare/csd-fixer-v0.1.0...csd-fixer-v0.1.1) (2026-09-09)


### Features

* csd-fixer 骨架 + POC 1/2 可行性验证 ([4d95811](https://github.com/everyx/csd-fixer/commit/4d95811df5f5d325f09673102bc3e6a68a43c560))
* effects 渲染层落地（圆角裁剪 + SDF 阴影 + 内亮边） ([dbb3c59](https://github.com/everyx/csd-fixer/commit/dbb3c597fc54c7014de824587777e68178ab2260))
* **i18n:** 添加 gettext 国际化支持并重构面向使用者的中英双语 README ([aa972b2](https://github.com/everyx/csd-fixer/commit/aa972b2a97ce4b22060ac4cee5c6a23b9aa1b45b))
* **prefs:** 重构首选项支持细粒度应用排除规则并修复分数缩放清晰度失效 ([72f0421](https://github.com/everyx/csd-fixer/commit/72f04218c1da9da3613d7e923e08253b076880ed))
* 对齐 Mutter 源码阴影规则重构无边框窗口判定逻辑 ([4d2618a](https://github.com/everyx/csd-fixer/commit/4d2618adeaeebfbdd27aa22b71b4af115383ce8b))
* 新增 prefer-crisp-text 选项支持分数缩放免除圆角 ([6bb9aa8](https://github.com/everyx/csd-fixer/commit/6bb9aa85497f2486c4af56677e573e38d6025a3b))
* 落地 GTK4 原生 2D 解析高斯着色器流水线与动效约束系统 ([b95c19b](https://github.com/everyx/csd-fixer/commit/b95c19b10684f98c72e55a956082ed3b2bff0835))


### Bug Fixes

* **effects:** 同步窗口淡入淡出动画透明度并消除首帧阴影挂载延迟 ([db7656f](https://github.com/everyx/csd-fixer/commit/db7656f713608f2a785b643e886b900b48cc878a))
* **shader:** 对齐 GTK4 SNAP_GROW 机制注入保守外溢裕量根除分数缩放 1px 亮缝 ([3b1bc4b](https://github.com/everyx/csd-fixer/commit/3b1bc4be076b3eae92410b7de786b210d5b44f50))


### Documentation

* 修复 README.md 中 Mermaid 节点带括号导致的语法解析错误 ([3dea0fd](https://github.com/everyx/csd-fixer/commit/3dea0fd8e6e7283f9a52ca583ceb01b7baeded40))
