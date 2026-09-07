/**
 * GNOME 原生窗口装饰样式（**生成产物，勿手改**）。
 *
 * 来源: libadwaita 上游（vendor/libadwaita/COMMIT = b6c03cc2662ff3267209edd36ea456ff450da9fd）
 * 生成: node tools/gen-style.mjs
 * 覆盖规则 = libadwaita window.csd 完整状态机：
 *   聚焦/失焦(backdrop)、最大化/全屏、贴边(tiled)、高对比
 */

export const STYLE = {
    window: {
        radius: 15,
        shadows: [{blur: 14, spread: 5, alpha: 0.15}, {blur: 5, spread: 2, alpha: 0.1}, {blur: 0, spread: 1, alpha: 0.05}],
        backdrop: {
            radius: 15,
            shadows: [{blur: 14, spread: 5, alpha: 0}, {blur: 10, spread: 5, alpha: 0.08}, {blur: 0, spread: 1, alpha: 0.05}],
        },
        tiled: {
            radius: 0,
            shadows: [{blur: 0, spread: 1, colorVar: 'border_color'}],
        },
        maximized: {radius: 0, shadows: []},
        fullscreen: {radius: 0, shadows: []},
        highContrast: {
            outlineAlpha: 0.8,
        },
    },
};
