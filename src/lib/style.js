/**
 * 样式状态机：根据窗口状态选取装饰参数。
 * 固定跟随 GNOME 原生（libadwaita window.csd），不支持自定义。
 * 纯逻辑，可单测。
 */

import {STYLE} from '../style/defaults.js';

/**
 * 根据窗口状态返回当前装饰参数。
 *
 * 返回 {radius, shadows, outline}：
 *   radius    圆角半径（px）
 *   shadows   阴影层 [{blur, spread, alpha, color?}]（≤3）
 *   outline   窗口外围亮边 {color: [r,g,b], alpha}（libadwaita outline，
 *             画在阴影 actor 上、紧贴窗口边缘内侧 1px——负向 spread 实现）
 *
 * 状态参数：focused / maximized / fullscreen / tiled / highContrast。
 * 选择优先级与 libadwaita 选择器一致：
 *   fullscreen > maximized > tiled > focused|backdrop
 * 高对比替换 shadow 集（上游 @media prefers-contrast: more），
 * outline 色按 HC 加深（7% → 30%）。
 */
export function styleForWindow(winState) {
    const {window} = STYLE;
    const outline = winState.highContrast
        ? window.outline.highContrast : window.outline.normal;

    // 最大化/全屏/贴边：无 outline（上游 outline: none）、无阴影
    if (winState.fullscreen)
        return {...window.fullscreen, outline: null};
    if (winState.maximized)
        return {...window.maximized, outline: null};
    if (winState.tiled)
        return {...window.tiled, outline: null};

    const base = winState.focused ? window : window.backdrop;
    const style = {radius: base.radius, shadows: base.shadows};
    if (winState.highContrast) {
        style.shadows = winState.focused
            ? window.highContrast.shadows
            : window.highContrast.backdropShadows;
    }
    style.outline = outline;
    return style;
}
