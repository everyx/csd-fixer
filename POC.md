# csd-fixer POC 记录

## POC 1：检测判据验证（buffer_rect vs frame_rect）✅

**结论：判据成立。** `buffer_rect == frame_rect` 可精确区分"客户端是否自绘 CSD"。

### 方法

无头嵌套 shell（`gnome-shell --headless --wayland --virtual-monitor 1920x1080`，
独立 D-Bus，主桌面零接触）内加载检测扩展 + 用 pywayland 写的确定性测试客户端
（可精确控制 `xdg_surface.set_window_geometry` 边距）。

### 数据

| 窗口 | buffer_rect | frame_rect | 判据 | 预期 |
|---|---|---|---|---|
| wl-no-csd（margin=0，模拟无装饰客户端） | 400x300 | 400x300 | Δ=0 → 无 CSD | ✓ |
| wl-fake-csd（margin=20，模拟自绘装饰） | 400x300 | 360x260 | Δ=40x40 → 有 CSD | ✓ |
| chromium（原生 Wayland，真实应用） | 638x582 | 600x544 | Δ=38x38 → 有 CSD（chromium 自带） | ✓ 应跳过 |

### 关键细节

- `Meta.Window.decorated` 对 Wayland 窗口**恒为 false**（mutter 源码确认），不可用于区分。
- 检测只用公开 API：`win.get_buffer_rect()` / `win.get_frame_rect()` /
  `actor.get_geometry_scale()`。无 /proc 读取、无 wmClass 特例表。
- wmClass 通过 `app_id`（Wayland）正确解析（`csd-test-client`）。
- 首帧 buffer 未就绪时是 0x0，需监听纹理 `size-changed` 后再判。
- 窗口刚创建时 `get_title()` 可能为 null（需防御）。

### 遗留（真机验证项）

- 分数缩放（scale>1）下 buffer=物理像素、frame=逻辑像素的关系：判据代码已按
  `buffer / get_geometry_scale()` 归一化，但嵌套 headless 环境测不到（虚拟显示器
  `@R` 是刷新率不是 scale），留待真机验证。
- XWayland 窗口路径未测（目标默认跳过，可选处理）。
- Qt 应用（telegram）在嵌套环境静默退出未测成，真机补。

## 开发工具链（已就绪）

- `tools/dev.sh shell`（或 `npm run shell`）：无头嵌套 shell（后台，日志 /tmp/csd-fixer-dev/shell.log）
- `tools/dev.sh app <cmd>`：在嵌套会话里跑测试应用
- `tools/dev.sh log` / `tools/dev.sh stop`
- 测试客户端：`/tmp/wlvenv/wl-client.py`（pywayland 0.4，注意 API 变化：
  `Display` 替代 `Client`、`WlShm.format.argb8888` 小写枚举）

### 安全原则（教训）

- 绝不 kill 主会话 gnome-shell；一切测试在嵌套会话
- enable 扩展必须在嵌套会话自己的 D-Bus 里（tools/dev.sh 封装）
- 无热重载：改代码 → `tools/dev.sh stop && tools/dev.sh shell`

## 项目骨架（已搭建，2026-09-07）

- `src/`：extension.js 入口 + lib/{detector,manager,style}.js + style/defaults.js（生成产物）
- `tools/gen-style.mjs`：窄解析器+断言，从 vendor SCSS 生成样式（radius=15px、三层阴影、
  backdrop/tiled/HC 状态机全自动提取；`--check` 供 CI freshness 校验）
- `vendor/libadwaita/`：上游 _window.scss + _common.scss + COMMIT hash（libadwaita b6c03cc）
- `tests/`：jasmine-gjs 单测（detector 12 + style 6 = 18 specs 全过；装在 ~/.local）
- `dev.sh` + `dev-shell.sh`：嵌套会话工具链（**必须 setsid**，dbus-run-session 后台启动
  会被 SIGHUP 连坐杀掉；G_MESSAGES_DEBUG='GNOME Shell' 开 debug 日志）
- 质量门禁：ego-lint 223 checks / 0 failed / 0 warnings（ZviBaratz reviewer clone 在 tools/）
- 端到端已验证：嵌套 shell 加载扩展 → detector 判定 → decorate 路径执行 + debug 日志输出

骨架期踩的坑（已修）：
- position/size/appears-focused 是 Meta.Window 信号，不是 MetaDisplay 的
- Meta-18（GNOME 50）没有 get_tile_mode()，tiled = 单轴最大化（hMax !== vMax）
- detector 的 isMaximized 语义必须是"双轴最大化"，半边 tile 走 tiled 样式（libadwaita 有 1px 描边）
- 首帧 buffer=0x0 会被判成 no-csd（max(0,...) 夹边）→ manager 需在 texture 就绪后重判（待 effects 阶段实现）
- 扩展日志用 console.debug（ego-lint 要求），显示要 G_MESSAGES_DEBUG='GNOME Shell'
- XWayland 窗口暂未实测（真机验证项）

### 测试运行时决策（2026-09-07 补，最终）

jasmine-gjs **不进 devDependencies、不 vendor**：npm 同名包是占位符（bin 拼错、
2024 后停更），真项目（ptomato/jasmine-gjs）是 meson/GJS，无 npm 发行。
作为外部开发工具装到 `~/.local`（README 开发节有完整安装步骤），
`npm test` = `jasmine --module tests/`。同类外部工具：
gnome-extension-reviewer（ego-lint 门禁，clone 到 ~/.local/share/…
+ wrapper ~/.local/bin/ego-lint）。原则：**只 vendor 样式数据
（libadwaita SCSS），开发工具一律装 ~/.local 并写文档，不进仓库**。

## POC 2：SDF 圆角 + 阴影着色器（2026-09-07）

### 验证结论

| 验证项 | 结果 | 证据 |
|---|---|---|
| SDF 圆角数学 | ✅ | 黑 ring 实验：d>0 区纯黑、d<0 区白色、圆角边界 1px 精确过渡（探针 (700,650) 系列采样） |
| 圆角裁剪 shader | ✅ | fn 实验：半径 30 的圆角，扇形剖面 d=32 白→d=34 背景，抗锯齿正确 |
| GLSL snippet 约定 | ✅ | add_glsl_snippet(FRAGMENT, decl, code, false)：decl 含函数定义合法；code 是**语句块**（不能包 void main()——cogl 模板已有 main，嵌套即语法错） |
| 预乘 alpha | ✅ | GLSLEffect pipeline blend 为预乘（SRC_COLOR*SRC_ALPHA）：输出必须 rgb ≤ a；vec4(1,0,0,0) 类非预乘值产生垃圾混合 |
| SDF 三层阴影 | ⚠️ 部分 | uniform 传递 ✓（location 23-28 全有效）；视觉合成在 headless 下异常（见下），留真机 |
| 性能/帧率 | ⚠️ 推迟 | headless swrast 帧率无参考价值，留真机 |

### headless 嵌套会话的渲染限制（重要发现）

1. **windowGroup 不渲染**：headless 下 Meta_WindowGroup mapped 但内容不进 stage 绘制
   （窗口 actor、BackgroundGroup 全部不画；stage 直挂的 actor 正常）。视觉验证只能用
   stage 探针，真实窗口路径留真机。POC 1 无恙因其只查 API 数据。
2. **window_group 默认隐藏**：无 GDM 激活流程时 window_group.visible=false，
   需 Eval `global.window_group.show()`（dev-shell.sh 已内置修正）。
3. **Screenshot D-Bus 拒绝**：org.gnome.Shell.Screenshot 白名单 caller
   （screenshot.js DBusSenderChecker：仅 MediaKeys/portal）。bypass：嵌套总线上
   RequestName 拿 `org.freedesktop.impl.portal.desktop.gnome` 即可放行（测试环境专用）。
4. **wl_surface 窗口映射协议**：xdg-shell 首次映射必须 configure→ack_configure→
   (attach)→commit 握手；直接 attach+commit 会被判 Buggy client，MetaWindow 存在
   但 actor 永不 mapped（wl-client.py 已修正，POC 1 的"Buggy client"警告项闭环）。

### POC 2 遗留（真机阶段处理）

- SdfShadowEffect 三层 smoothstep 阴影的视觉合成（headless offscreen 合成异常：
  St.Bin 白底 + GLSLEffect 在 headless 下 alpha 混合行为不符预期，探针窗内出现
  半透明白而非纯透/纯白——真机验证是否复现）
- 帧率基准（真机 GPU 下拖拽窗口 + POC shader vs rwc box-shadow 对比）
- 探针代码在 poc/sdf/extension.js（_stageProbe），真机可直接启用观察

## 热重载调研（2026-02-15，决定测试流程）

**问题**：改一版代码就要重启 shell 验证，真机只能注销重登，迭代太慢。
能否像 Web dev 那样热重载扩展？

**结论**：GNOME 50（gjs 1.88）下**进程内热重载不可行，无官方途径**；
开发迭代靠嵌套会话（每次全新 shell 进程），真机只做最终验收。

证据链：

| # | 证据 | 来源 |
|---|---|---|
| 1 | gjs 模块 registry 按 `uriWithQuery` 缓存：同 URI 二次 `import()` 命中缓存返回旧模块；换 query 参数则重新读盘编译（实测 gjs 1.88：`file:///x.js?v=1` 和 `?v=2` 各自编译，覆盖文件后 `?v=2` 拿到新内容） | gjs modules/internal/loader.js moduleResolveAsyncHook + /tmp 实测 |
| 2 | shell `extensionSystem.js` 的 `import(extensionJs.get_uri())` **不带 query**，且 `isImported` 标志防重；unload 后重 load 时 metadata.version 变了直接拒绝（"A different version was loaded previously. You need to log out for changes to take effect."） | extensionSystem.js 462-511 |
| 3 | 官方 D-Bus `ReloadExtension` 方法已是空壳：直接返回 NOT_SUPPORTED "deprecated and does not work" | shellDBus.js 488 |
| 4 | shell 内部 `reloadExtension()`（版本校验切换/更新安装时用）能走通是因为 unload→重 import 走同一缓存 URI：**拿到的是旧模块**，仅适合 metadata/样式变更，代码不变 | extensionSystem.js 462 |
| 5 | Wayland 下无进程内重启：GNOME 50 runDialog 内置命令只剩 `lg`/`debugexit`/`rt`（重载主题），**老版本的 `r`（reexec_self）已移除**；注销重登是唯一路径 | runDialog.js 44-56 |

**推论**（测试流程定稿）：

- 嵌套会话（headless/devkit）：每轮 stop+restart 全新进程，天然规避模块缓存——逻辑冒烟主战场
- 真机：批量修完 bug 一次注销重登验收（不变式，沿用）
- mutter 50 已移除 `--nested`；嵌套开发会话的官方姿势是 devkit（headless + 虚拟监视器 +
  pipewire 屏流 + libei 输入，见 mdk/ 源码树）。本机 mutter-everyx 编译时 `-D devkit=disabled`
  不可用——重编需开 `-D devkit=enabled`，交接文档在 archlinuxcn/mutter-everyx/HANDOFF-devkit.md

**未来可选的伪热重载**（不采用，记录备查）：gjs 的 query-busting 机制理论上可以让
扩展自己 import 依赖时带 `?v=` 时间戳 query 实现"重载子模块"，但仅覆盖子模块，
extension.js 入口本身仍由 shell import（无 query），且效果 actor/信号残留清理极易
出错——复杂度远超收益，不做。

## POC 3：GTK4 原生 2D 解析高斯着色器与互补遮罩渲染流水线（2026-09-08）

### 验证结论

| 验证项 | 结果 | 证据 / 关键突破 |
|---|---|---|
| GTK4 原生高斯内核 | ✅ | `tools/gen-shader.mjs` 自动转译 `gskgpuboxshadow.glsl`（commit `539d28f3`）；二维误差函数 erf 双重积分 + 4 角落 8 步缺角解析扣减，根除 1D SDF 圆角偏亮发胖问题，数值与 GTK4 GSK 完全重合（误差 0.000000） |
| 互补镂空遮罩 | ✅ | 窗口裁剪 $1.0 - \text{clamp}(d + 0.5, 0.0, 1.0)$ 与阴影挖空 $\text{clamp}(d + 0.5, 0.0, 1.0)$ 严格互补（和恒为 1.000000），消除浅色边缘透底黑带，杜绝漏光接缝 |
| 窗口关闭直角闪烁 | ✅ | 窗口 `unmanaging` 时保持 clip 与 shadow 存活，随窗口 actor 的 `destroy` 自然谢幕，关闭动画全程圆角 |
| Resize allocation 警告 | ✅ | X/Y/WIDTH/HEIGHT 四维全由 `Clutter.BindConstraint` 底层 C 核心处理，移除 JS 侧 `set_size`，彻底根除 `needs an allocation` 警告 |
| 动效全维缩放跟随 | ✅ | 绑定 `scale-x/y`、`pivot-point`、`translation-x/y`、`opacity`、`visible`，阴影与窗口弹出、关闭、最小化动效完全同步 |

