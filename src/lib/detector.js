import {
    MUTTER_CSD_MIN_INSET_THRESHOLD,
} from './mutterRules.generated.js';

/**
 * 窗口 CSD 检测：判定一个窗口是否"没有自绘 client-side decorations"。
 *
 * 判据与 Mutter 源码（meta-shadow-factory.c / meta-window-actor-x11.c）严格对齐：
 * 1. 窗口类型：普通/对话框/工具窗口（对齐 Mutter default_shadow_classes）。
 * 2. 状态排他：全屏、最大化不画阴影（对齐 Mutter meta_window_is_maximized/fullscreen）。
 * 3. 服务端边框（SSD）：若 Mutter 已提供原生 Frame/标题栏，跳过（对齐 has_frame）。
 * 4. 阴影外延门槛：Mutter 定义普通窗口最小阴影半径为 8px（扩散 21px）。
 *    - 客户端单边边距 < 8px（如微信/Chromium 声明的 4px 抓取边缘，或纯直角 0px）：
 *      物理上不足以容纳正常阴影，判定为无有效 CSD 阴影，需要补画原生阴影。
 *    - 客户端单边边距 >= 8px（如 GTK4/Adwaita 外扩 24~40px）：判定为已有真 CSD 阴影，跳过。
 *
 * 这是纯逻辑模块：不依赖任何 shell 全局对象，可单测。
 */

/**
 * 根据 buffer/frame rect 计算窗口内容边距（逻辑像素）。
 *
 * bufferWidth/bufferHeight 为物理像素（buffer_rect），
 * frameWidth/frameHeight 为逻辑像素（frame_rect），
 * scale 为 actor 的 geometry scale（buffer→逻辑 换算）。
 * 返回 {w, h}（逻辑像素，≥0，表示双边总差值）。
 */
export function computeInsets(bufferWidth, bufferHeight,
                              frameWidth, frameHeight, scale) {
    return {
        w: Math.max(0, bufferWidth / scale - frameWidth),
        h: Math.max(0, bufferHeight / scale - frameHeight),
    };
}

/**
 * 判定窗口是否需要补装饰。返回 {apply, reason}。
 *
 * 参数（全部来自 Meta.Window/actor 读取，无副作用）：
 *   bufferWidth/bufferHeight  物理像素
 *   frameWidth/frameHeight    逻辑像素
 *   scale                     geometry scale（≥1）
 *   isX11                     是否 XWayland 窗口
 *   skipXwayland              设置：是否强制跳过 XWayland（默认 false）
 *   isMaximized/isFullscreen  最大化/全屏
 *   hasSsd                    是否已带 Mutter 原生服务端边框/标题栏
 *   windowType                Meta.WindowType
 *   wmClass                   wm_class / app_id
 *   blacklist/whitelist       名单（whitelist 非空则只处理列出的）
 *   insetThreshold            单边 CSD 阴影门槛（默认对齐 Mutter 最小半径 8px）
 */
export function shouldDecorate({
    bufferWidth, bufferHeight, frameWidth, frameHeight, scale = 1,
    isX11 = false, skipXwayland = false, isMaximized = false, isFullscreen = false,
    hasSsd = false,
    windowType = WindowType.NORMAL,
    wmClass, blacklist = [], whitelist = [],
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // 1. 只处理普通/对话框/工具窗口
    if (windowType !== WindowType.NORMAL && windowType !== WindowType.DIALOG &&
        windowType !== WindowType.MODAL_DIALOG && windowType !== WindowType.UTILITY) {
        return {apply: false, reason: `window-type=${windowType}`};
    }
    // 2. 最大化/全屏不补装饰（Mutter has_shadow 同样排除）
    if (isMaximized || isFullscreen) {
        return {apply: false, reason: 'maximized/fullscreen'};
    }
    // 3. 服务端已提供标题栏与外框（SSD）：由 Mutter 自身管理阴影
    if (hasSsd) {
        return {apply: false, reason: 'has-ssd-frame'};
    }
    // 4. 用户显式强制跳过 XWayland（兜底设置）
    if (isX11 && skipXwayland) {
        return {apply: false, reason: 'xwayland-skipped'};
    }
    // 5. 白名单优先：非空则只处理列出的
    if (whitelist.length > 0) {
        const hit = wmClass != null && whitelist.includes(wmClass);
        if (!hit) {
            return {apply: false, reason: `not-in-whitelist(${wmClass})`};
        }
    } else if (wmClass != null && blacklist.includes(wmClass)) {
        return {apply: false, reason: `blacklisted(${wmClass})`};
    }
    // 6. 核心几何判据：对齐 Mutter 阴影阈值
    // 单边边距 = (物理 buffer / scale - 逻辑 frame) / 2
    const {w, h} = computeInsets(bufferWidth, bufferHeight,
                                 frameWidth, frameHeight, scale);
    const sideW = w / 2;
    const sideH = h / 2;

    if (sideW < insetThreshold && sideH < insetThreshold) {
        return {apply: true, reason: `no-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} < ${insetThreshold})`};
    }
    return {apply: false, reason: `has-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} >= ${insetThreshold})`};
}

/**
 * Wayland 窗口类型常量（Meta.WindowType，mutter src/meta/common.h）。
 */
export const WindowType = {
    NORMAL: 0,
    DESKTOP: 1,
    DOCK: 2,
    DIALOG: 3,
    MODAL_DIALOG: 4,
    TOOLBAR: 5,
    MENU: 6,
    UTILITY: 7,
    SPLASHSCREEN: 8,
};

/**
 * 判断缩放倍率是否为分数缩放（非整数）。
 * scale 无效或 <=0 时按非分数处理（false）。
 */
export function isFractionalScale(scale) {
    if (scale == null || !Number.isFinite(scale) || scale <= 0)
        return false;
    return Math.abs(scale - Math.round(scale)) > 0.001;
}

/**
 * 判定窗口是否需要挂载圆角剪裁。
 *
 * 规则：
 *   - 若未开启 preferCrispText（默认），恒定返回 true（全功能圆角）。
 *   - 若开启 preferCrispText：
 *     - 分数缩放屏幕（1.25x, 1.33x, 1.5x 等）返回 false（免除 FBO 剪裁，确保原生锐利度）。
 *     - 整数缩放屏幕（1.0x, 2.0x 等）返回 true（整数缩放下 FBO 不模糊，保留完整圆角）。
 */
export function shouldClipWindow({preferCrispText = false, scale = 1}) {
    if (!preferCrispText)
        return true;
    return !isFractionalScale(scale);
}
