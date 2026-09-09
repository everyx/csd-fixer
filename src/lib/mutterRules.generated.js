/**
 * mutterRules.generated.js — 从 vendor/mutter/meta-shadow-factory.c 自动解析生成。
 *
 * 勿手改本文件！重新生成请运行:
 *   node tools/gen-mutter.mjs
 */

/**
 * Mutter 预置阴影样式族元数据 (MetaShadowClassInfo default_shadow_classes)
 */
export const MUTTER_SHADOW_CLASSES = Object.freeze({
    "normal": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    },
    "dialog": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    },
    "modal_dialog": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    },
    "utility": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    },
    "border": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    },
    "menu": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    },
    "popup-menu": {
        "focused": {
            "radius": 1,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 0,
            "opacity": 128,
            "spread": 2
        },
        "unfocused": {
            "radius": 1,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 0,
            "opacity": 128,
            "spread": 2
        }
    },
    "dropdown-menu": {
        "focused": {
            "radius": 1,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 0,
            "opacity": 128,
            "spread": 2
        },
        "unfocused": {
            "radius": 1,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 0,
            "opacity": 128,
            "spread": 2
        }
    },
    "attached": {
        "focused": {
            "radius": 10,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 3,
            "opacity": 128,
            "spread": 27
        },
        "unfocused": {
            "radius": 8,
            "topFade": -1,
            "xOffset": 0,
            "yOffset": 2,
            "opacity": 64,
            "spread": 21
        }
    }
});

/**
 * Mutter 正常窗口的未聚焦最小阴影半径 (px)
 * 来源: default_shadow_classes["normal"].unfocused.radius
 */
export const MUTTER_MIN_NORMAL_SHADOW_RADIUS = 8;

/**
 * Mutter 正常窗口的未聚焦最小阴影向外扩散距离 spread (px)
 * 计算自 get_shadow_spread(8)
 */
export const MUTTER_MIN_NORMAL_SHADOW_SPREAD = 21;

/**
 * Mutter 正常窗口的聚焦阴影半径 (px)
 * 来源: default_shadow_classes["normal"].focused.radius
 */
export const MUTTER_FOCUSED_NORMAL_SHADOW_RADIUS = 10;

/**
 * Mutter 正常窗口的聚焦阴影向外扩散距离 spread (px)
 * 计算自 get_shadow_spread(10)
 */
export const MUTTER_FOCUSED_NORMAL_SHADOW_SPREAD = 27;

/**
 * CSD 判定下限阈值（逻辑像素）。
 *
 * 在 Mutter 定义中，一个普通窗口即便未聚焦，其阴影半径也达到 8px、
 * 扩散范围达到 21px。
 * 若一个窗口声明的内容边距（Insets / Frame Extents）单边小于 8px
 * （如微信/CEF 无边框窗口声明的 4px），其空间在物理上根本不足以容纳一个正常窗口阴影，
 * 属于鼠标抓取边缘（Resize Grip）或微边框，本质上并未自绘完整 CSD 阴影。
 */
export const MUTTER_CSD_MIN_INSET_THRESHOLD = 8;
