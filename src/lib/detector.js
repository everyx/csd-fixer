/**
 * 窗口 CSD 检测：判定一个窗口是否"没有自绘 client-side decorations"。
 *
 * 判据（POC 1 已验证）：Wayland 客户端通过 xdg_surface.set_window_geometry
 * 声明内容边界（frame_rect），装饰/阴影画在 buffer 的透明边距上。
 *   buffer_rect == frame_rect  → 客户端没画任何装饰 → 需要补圆角+阴影
 *   buffer_rect >  frame_rect  → 客户端自绘了 CSD（GTK/libadwaita/Firefox/
 *                               新 Electron）→ 跳过
 *
 * 这是纯逻辑模块：不依赖任何 shell 全局对象，可单测。
 */

/**
 * 根据 buffer/frame rect 计算窗口内容边距（逻辑像素）。
 *
 * bufferWidth/bufferHeight 为物理像素（buffer_rect），
 * frameWidth/frameHeight 为逻辑像素（frame_rect），
 * scale 为 actor 的 geometry scale（buffer→逻辑 换算）。
 * 返回 {w, h}（逻辑像素，≥0）。
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
 *   skipXwayland              设置：是否跳过 XWayland
 *   isMaximized/isFullscreen  最大化/全屏
 *   windowType                Meta.WindowType
 *   wmClass                   wm_class / app_id
 *   blacklist/whitelist       名单（whitelist 非空则只处理列出的）
 */
export function shouldDecorate({
    bufferWidth, bufferHeight, frameWidth, frameHeight, scale,
    isX11, skipXwayland, isMaximized, isFullscreen, windowType,
    wmClass, blacklist = [], whitelist = [],
}) {
    // 1. 只处理普通/对话框/工具窗口
    if (windowType !== WindowType.NORMAL && windowType !== WindowType.DIALOG &&
        windowType !== WindowType.MODAL_DIALOG && windowType !== WindowType.UTILITY) {
        return {apply: false, reason: `window-type=${windowType}`};
    }
    // 2. 最大化/全屏不补装饰（libadwaita 同样圆角归零）
    if (isMaximized || isFullscreen) {
        return {apply: false, reason: 'maximized/fullscreen'};
    }
    // 3. XWayland 默认跳过（Mutter 已给阴影）
    if (isX11 && skipXwayland) {
        return {apply: false, reason: 'xwayland-skipped'};
    }
    // 4. 白名单优先：非空则只处理列出的
    if (whitelist.length > 0) {
        const hit = wmClass != null && whitelist.includes(wmClass);
        if (!hit) {
            return {apply: false, reason: `not-in-whitelist(${wmClass})`};
        }
    } else if (wmClass != null && blacklist.includes(wmClass)) {
        return {apply: false, reason: `blacklisted(${wmClass})`};
    }
    // 5. 核心判据：无 CSD = buffer ≈ frame（容差 < 1 逻辑像素）
    const {w, h} = computeInsets(bufferWidth, bufferHeight,
                                 frameWidth, frameHeight, scale);
    if (w < 1 && h < 1) {
        return {apply: true, reason: `no-csd(insets=${w.toFixed(1)}x${h.toFixed(1)})`};
    }
    return {apply: false, reason: `has-csd(insets=${w.toFixed(1)}x${h.toFixed(1)})`};
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
