/**
 * 样式状态机：根据窗口状态选取装饰参数。
 * 固定跟随 GNOME 原生（libadwaita window.csd），不支持自定义。
 * 纯逻辑，可单测。
 */

import {STYLE} from '../style/defaults.js';

/**
 * 根据窗口状态返回当前装饰参数 {radius, shadows, outlineAlpha?}。
 *
 * 状态参数：focused / maximized / fullscreen / tiled / highContrast。
 * 选择优先级与 libadwaita 选择器一致：
 *   fullscreen > maximized > tiled > focused|backdrop
 */
export function styleForWindow(winState) {
    const {window} = STYLE;

    if (winState.fullscreen) {
        return {...window.fullscreen};
    }
    if (winState.maximized) {
        return {...window.maximized};
    }
    if (winState.tiled) {
        return {...window.tiled};
    }

    const base = winState.focused ? window : window.backdrop;
    const style = {
        radius: base.radius,
        shadows: base.shadows,
    };
    if (winState.highContrast) {
        style.outlineAlpha = window.highContrast.outlineAlpha;
    }
    return style;
}
