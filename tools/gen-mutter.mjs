#!/usr/bin/env node
/**
 * gen-mutter.mjs — 从 vendor/mutter/meta-shadow-factory.c 解析 Mutter 阴影参数与算法，
 * 生成 src/lib/mutterRules.generated.js。
 *
 * 设计：窄解析器 + 断言。解析 default_shadow_classes 数组和算法，
 * 计算阴影半径、扩散距离（spread），提供装饰与 CSD 边界判定依据。
 *
 * 用法: node tools/gen-mutter.mjs [--check]
 *   --check: 校验生成结果与现有文件是否一致（CI / check-style 用），不一致 exit 1
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'mutter');
const OUT = path.join(ROOT, 'src', 'lib', 'mutterRules.generated.js');

const CHECK = process.argv.includes('--check');

function read(name) {
    const p = path.join(VENDOR, name);
    if (!existsSync(p))
        throw new Error(`[gen-mutter] 缺少 vendor 文件: ${name}`);
    return readFileSync(p, 'utf8');
}

// Mutter meta-shadow-factory.c 中的高斯模糊核尺寸与扩散距离算法
// get_box_filter_size: (int)(0.5 + radius * (0.75 * sqrt(2*M_PI)))
function getBoxFilterSize(radius) {
    return Math.floor(0.5 + radius * (0.75 * Math.sqrt(2 * Math.PI)));
}

// get_shadow_spread: 奇数 3*(d/2)，偶数 3*(d/2)-1
function getShadowSpread(radius) {
    if (radius === 0)
        return 0;
    const d = getBoxFilterSize(radius);
    return d % 2 === 1 ? 3 * Math.floor(d / 2) : 3 * Math.floor(d / 2) - 1;
}

function parseParams(tupleStr) {
    // 形式: { 10, -1, 0, 3, 128 }
    const nums = tupleStr.replace(/[{}]/g, '').split(',').map(s => parseInt(s.trim(), 10));
    if (nums.length !== 5 || nums.some(n => Number.isNaN(n)))
        throw new Error(`[gen-mutter] 无法解析 MetaShadowParams: "${tupleStr}"`);
    const [radius, top_fade, x_offset, y_offset, opacity] = nums;
    return {
        radius,
        topFade: top_fade,
        xOffset: x_offset,
        yOffset: y_offset,
        opacity,
        spread: getShadowSpread(radius),
    };
}

function parseShadowClasses(cCode) {
    const startIdx = cCode.indexOf('MetaShadowClassInfo default_shadow_classes[]');
    if (startIdx === -1)
        throw new Error('[gen-mutter] 断言失败: 未找到 default_shadow_classes 定义');
    const braceStart = cCode.indexOf('{', startIdx);
    const braceEnd = cCode.indexOf('};', braceStart);
    if (braceStart === -1 || braceEnd === -1)
        throw new Error('[gen-mutter] 断言失败: 未找到 default_shadow_classes 块');

    const body = cCode.slice(braceStart + 1, braceEnd);
    const itemRegex = /\{\s*"([^"]+)"\s*,\s*(\{[^}]+\})\s*,\s*(\{[^}]+\})\s*\}/g;
    const classes = {};
    let match;
    while ((match = itemRegex.exec(body)) !== null) {
        const [, name, focusedStr, unfocusedStr] = match;
        classes[name] = {
            focused: parseParams(focusedStr),
            unfocused: parseParams(unfocusedStr),
        };
    }

    if (!classes.normal || !classes.dialog)
        throw new Error('[gen-mutter] 断言失败: classes 缺少 normal 或 dialog');

    return classes;
}

function main() {
    const cCode = read('meta-shadow-factory.c');
    const classes = parseShadowClasses(cCode);

    const normalUnfocused = classes.normal.unfocused;
    const normalFocused = classes.normal.focused;

    // normal 窗口最小阴影半径（未聚焦: 8px，聚焦: 10px）
    const minNormalRadius = normalUnfocused.radius;
    const minNormalSpread = normalUnfocused.spread;

    const banner = `/**
 * mutterRules.generated.js — 从 vendor/mutter/meta-shadow-factory.c 自动解析生成。
 *
 * 勿手改本文件！重新生成请运行:
 *   node tools/gen-mutter.mjs
 */`;

    const code = `${banner}

/**
 * Mutter 预置阴影样式族元数据 (MetaShadowClassInfo default_shadow_classes)
 */
export const MUTTER_SHADOW_CLASSES = Object.freeze(${JSON.stringify(classes, null, 4)});

/**
 * Mutter 正常窗口的未聚焦最小阴影半径 (px)
 * 来源: default_shadow_classes["normal"].unfocused.radius
 */
export const MUTTER_MIN_NORMAL_SHADOW_RADIUS = ${minNormalRadius};

/**
 * Mutter 正常窗口的未聚焦最小阴影向外扩散距离 spread (px)
 * 计算自 get_shadow_spread(8)
 */
export const MUTTER_MIN_NORMAL_SHADOW_SPREAD = ${minNormalSpread};

/**
 * Mutter 正常窗口的聚焦阴影半径 (px)
 * 来源: default_shadow_classes["normal"].focused.radius
 */
export const MUTTER_FOCUSED_NORMAL_SHADOW_RADIUS = ${normalFocused.radius};

/**
 * Mutter 正常窗口的聚焦阴影向外扩散距离 spread (px)
 * 计算自 get_shadow_spread(10)
 */
export const MUTTER_FOCUSED_NORMAL_SHADOW_SPREAD = ${normalFocused.spread};

/**
 * CSD 判定下限阈值（逻辑像素）。
 *
 * 在 Mutter 定义中，一个普通窗口即便未聚焦，其阴影半径也达到 ${minNormalRadius}px、
 * 扩散范围达到 ${minNormalSpread}px。
 * 若一个窗口声明的内容边距（Insets / Frame Extents）单边小于 ${minNormalRadius}px
 * （如微信/CEF 无边框窗口声明的 4px），其空间在物理上根本不足以容纳一个正常窗口阴影，
 * 属于鼠标抓取边缘（Resize Grip）或微边框，本质上并未自绘完整 CSD 阴影。
 */
export const MUTTER_CSD_MIN_INSET_THRESHOLD = ${minNormalRadius};
`;

    if (CHECK) {
        if (!existsSync(OUT)) {
            console.error(`[gen-mutter] --check 失败: ${OUT} 不存在`);
            process.exit(1);
        }
        const existing = readFileSync(OUT, 'utf8');
        if (existing !== code) {
            console.error(`[gen-mutter] --check 失败: ${OUT} 与 vendor/mutter 源码不一致`);
            process.exit(1);
        }
        console.log('[gen-mutter] --check 通过: generated 文件与 vendor 源码严格一致');
        return;
    }

    writeFileSync(OUT, code, 'utf8');
    console.log(`[gen-mutter] 成功解析并生成: ${path.relative(ROOT, OUT)}`);
    console.log(`  - 普通窗口最小阴影半径: ${minNormalRadius}px (spread: ${minNormalSpread}px)`);
    console.log(`  - 普通窗口聚焦阴影半径: ${normalFocused.radius}px (spread: ${normalFocused.spread}px)`);
    console.log(`  - CSD 真实阴影判定门槛: >= ${minNormalRadius}px`);
}

main();
