#!/usr/bin/env node
/**
 * gen-style.mjs — 从 vendor 的 libadwaita SCSS 解析 window.csd 装饰参数，
 * 生成 src/style/defaults.js。
 *
 * 设计：窄解析器 + 断言。只认固定的文件/块/变量链，不写通用 SCSS 解析器。
 * 任何上游格式变化导致断言失败时，本脚本直接报错退出（绝不输出坏数据）。
 *
 * 用法: node tools/gen-style.mjs [--check]
 *   --check: 只校验生成结果与现有 defaults.js 一致（CI 用），不一致 exit 1
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'libadwaita');
const OUT = path.join(ROOT, 'src', 'style', 'defaults.js');

const CHECK = process.argv.includes('--check');

// ---------- 窄解析器 ----------

function read(name) {
    const p = path.join(VENDOR, name);
    if (!existsSync(p))
        throw new Error(`[gen-style] 缺少 vendor 文件: ${name}（先 vendor 上游）`);
    return readFileSync(p, 'utf8');
}

/** 取 SCSS 变量定义 `$name: value;` */
function parseVar(scss, name) {
    const re = new RegExp(`\\$${name}\\s*:\\s*([^;]+);`);
    const m = scss.match(re);
    if (!m) throw new Error(`[gen-style] 断言失败: 找不到变量 $${name}`);
    return m[1].trim();
}

/** 求值百分比字面量：`15%` */
function parsePercent(expr) {
    const m = expr.match(/^(\d+(?:\.\d+)?)%$/);
    if (!m)
        throw new Error(`[gen-style] 断言失败: 无法求值百分比 "${expr}"`);
    return +m[1] / 100;
}

/** 求值 px 表达式：`9px`、`9px + 6`、`$button_radius + 6` */
function evalPx(expr, vars = {}) {
    const resolved = expr.replace(/\$([a-z0-9_]+)/g, (_, n) => vars[n] ?? '');
    const single = resolved.match(/^\s*(-?\d+(?:\.\d+)?)\s*px\s*$/);
    if (single) return parseFloat(single[1]);
    const sum = resolved.match(/^\s*(-?\d+(?:\.\d+)?)\s*px\s*\+\s*(\d+(?:\.\d+)?)\s*$/);
    if (sum) return parseFloat(sum[1]) + parseFloat(sum[2]);
    throw new Error(`[gen-style] 断言失败: 无法求值 px 表达式 "${expr}"`);
}

/** 解析 box-shadow 声明 → [{blur, spread, alpha}]（从外到内） */
function parseBoxShadow(decl) {
    const layers = decl.replace(/\/\*.*?\*\//gs, '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (layers.length === 0)
        throw new Error('[gen-style] 断言失败: box-shadow 为空');
    return layers.map(layer => {
        // backdrop 首层可能是 `... transparent`（保持 extents 防跳动）
        const transparent = /^0\s+0\s+(?:(?:(\d+(?:\.\d+)?)px)|0)\s+(\d+(?:\.\d+)?)px\s+transparent$/;
        const tm = layer.match(transparent);
        if (tm)
            return {blur: tm[1] ? parseInt(tm[1]) : 0, spread: parseFloat(tm[2]), alpha: 0};
        // 颜色为 SCSS 变量（如 $border_color）时：spread 语义保留，alpha 由 shader 侧取描边色
        const vm = layer.match(/^0\s+0\s+(?:(?:(\d+(?:\.\d+)?)px)|0)\s+(\d+(?:\.\d+)?)px\s+\$([a-z0-9_]+)$/);
        if (vm)
            return {blur: vm[1] ? parseInt(vm[1]) : 0, spread: parseFloat(vm[2]), colorVar: vm[3]};
        // 格式: 0 0 [blur] spreadpx RGB(0 0 0 / NN%)
        const m = layer.match(/^0\s+0\s+(?:(?:(\d+(?:\.\d+)?)px)|0)\s+(\d+(?:\.\d+)?)px\s+RGB\(\s*0\s+0\s+0\s*\/\s*(\d+)%\s*\)$/);
        if (!m)
            throw new Error(`[gen-style] 断言失败: 无法解析 box-shadow 层 "${layer}"`);
        const blur = m[1] ? parseInt(m[1]) : 0;
        const spread = parseFloat(m[2]);
        return {blur, spread, alpha: parseInt(m[3]) / 100};
    });
}

/** 取 `selector` 起始的块内容（括号配平） */
function extractBlock(scss, selector) {
    const idx = scss.indexOf(selector);
    if (idx < 0) throw new Error(`[gen-style] 断言失败: 找不到块 ${selector}`);
    const open = scss.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < scss.length; i++) {
        if (scss[i] === '{') depth++;
        else if (scss[i] === '}') {
            depth--;
            if (depth === 0) return scss.slice(open + 1, i);
        }
    }
    throw new Error(`[gen-style] 断言失败: 块 ${selector} 括号未闭合`);
}

/** 从块内取属性值 `prop: value;`（取第一个匹配） */
function propIn(block, prop) {
    const re = new RegExp(`${prop}\\s*:\\s*([^;]+);`);
    const m = block.match(re);
    if (!m) throw new Error(`[gen-style] 断言失败: 块内找不到 ${prop}`);
    return m[1].trim();
}

// ---------- 主流程 ----------

const common = read('_common.scss');
const colorsScss = read('_colors.scss');
const windowScss = read('_window.scss');

// 1. 圆角：--window-radius = $button_radius + 6
const buttonRadius = evalPx(parseVar(common, 'button_radius'));
const radiusDecl = common.match(/--window-radius:\s*#\{\s*(\$button_radius\s*\+\s*\d+)\s*\}/);
if (!radiusDecl)
    throw new Error('[gen-style] 断言失败: 找不到 --window-radius: #{$button_radius + N}');
const radius = evalPx(radiusDecl[1], {button_radius: `${buttonRadius}px`});

// 2. window.csd 主阴影
const csdBlock = extractBlock(windowScss, '&.csd');
const shadows = parseBoxShadow(propIn(csdBlock, 'box-shadow'));

// 3. backdrop（失焦）：阴影减淡但 extents 不变
const backdropBlock = extractBlock(csdBlock, '&:backdrop');
const backdropShadows = parseBoxShadow(propIn(backdropBlock, 'box-shadow'));

// 4. tiled（贴边）：圆角归零 + 1px 描边
const tiledBlock = extractBlock(csdBlock, '&.tiled,');
const tiledShadows = parseBoxShadow(propIn(tiledBlock, 'box-shadow'))
    // 过滤 libadwaita 的 transparent control workaround 层（-- #3670，shader 无意义）
    .filter(s => !(s.blur === 0 && s.spread >= 10 && (s.alpha === 0 || s.colorVar)));

// 5. 高对比：阴影集整体替换（outline 加深到 80%），backdrop 同样有 HC 变体
const hcBlock = extractBlock(csdBlock, '@media (prefers-contrast: more)');
const hcShadows = parseBoxShadow(propIn(hcBlock, 'box-shadow'));
const hcBackdropBlock = extractBlock(backdropBlock, '@media (prefers-contrast: more)');
const hcBackdropShadows = parseBoxShadow(propIn(hcBackdropBlock, 'box-shadow'));

// 6. 边线透明度（tiled 的 $border_color 动态色静态化：色值固定黑，透明度取上游）
const borderOpacity = parsePercent(parseVar(colorsScss, 'border_opacity'));

// 7. 窗口 outline 色（libadwaita 在窗口外围画 1px 亮边；HC 加深到 30%）
function parseStaticColor(decl) {
    const m = decl.match(/RGB\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+)%\s*\)/);
    if (!m)
        throw new Error(`[gen-style] 断言失败: 无法解析静态色 "${decl}"`);
    return {color: [+m[1], +m[2], +m[3]], alpha: +m[4] / 100};
}
const outlineColor = parseStaticColor(parseVar(colorsScss, 'window_outline_color'));
const outlineColorHc = parseStaticColor(parseVar(colorsScss, 'window_outline_color_hc'));

// ---------- 断言（防坏数据） ----------

if (radius < 4 || radius > 40)
    throw new Error(`[gen-style] 断言失败: radius 异常 ${radius}`);
if (shadows.length < 2 || shadows.length > 4)
    throw new Error(`[gen-style] 断言失败: shadows 层数异常 ${shadows.length}`);
if (backdropShadows[0].alpha > 0.05)
    throw new Error('[gen-style] 断言失败: backdrop 首层应透明(防跳动)');
if (tiledShadows[0].blur !== 0 || tiledShadows[0].spread !== 1)
    throw new Error('[gen-style] 断言失败: tiled 应为 1px 描边');

if (hcShadows.find(s => s.spread === 1)?.alpha == null)
    throw new Error('[gen-style] 断言失败: HC 块无 outline 层');
if (hcShadows.find(s => s.spread === 1)?.alpha < 0.5)
    throw new Error('[gen-style] 断言失败: HC outline 应 ≥80%，实际 ' + hcShadows.find(s => s.spread === 1)?.alpha);

// ---------- 序列化 ----------

function fmtShadows(list) {
    return list.map(s => {
        const parts = [`blur: ${s.blur}`, `spread: ${s.spread}`];
        if (s.colorVar) {
            parts.push(`colorVar: '${s.colorVar}'`);
        } else {
            parts.push(`alpha: ${s.alpha}`);
        }
        return `{${parts.join(', ')}}`;
    }).join(', ');
}

function fmtColor(c) {
    return `{color: [${c.color.join(', ')}], alpha: ${c.alpha}}`;
}

const commit = read('COMMIT').trim();
const js = `/**
 * GNOME 原生窗口装饰样式（**生成产物，勿手改**）。
 *
 * 来源: libadwaita 上游（vendor/libadwaita/COMMIT = ${commit}）
 * 生成: node tools/gen-style.mjs
 * 覆盖规则 = libadwaita window.csd 完整状态机：
 *   聚焦/失焦(backdrop)、最大化/全屏、贴边(tiled)、高对比
 */

export const STYLE = {
    window: {
        radius: ${radius},
        shadows: [${fmtShadows(shadows)}],
        backdrop: {
            radius: ${radius},
            shadows: [${fmtShadows(backdropShadows)}],
        },
        highContrast: {
            shadows: [${fmtShadows(hcShadows)}],
            backdropShadows: [${fmtShadows(hcBackdropShadows)}],
        },
        tiled: {
            radius: 0,
            shadows: [{blur: 0, spread: 1, alpha: ${borderOpacity}}],
        },
        maximized: {radius: 0, shadows: []},
        fullscreen: {radius: 0, shadows: []},
        outline: {
            normal: ${fmtColor(outlineColor)},
            highContrast: ${fmtColor(outlineColorHc)},
        },
    },
};
`;

// ---------- 输出 ----------

if (CHECK) {
    const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (old !== js) {
        console.error('[gen-style] --check 失败: defaults.js 与上游不一致，请运行 node tools/gen-style.mjs');
        process.exit(1);
    }
    console.log(`[gen-style] OK: defaults.js 与上游一致 (commit ${commit})`);
} else {
    writeFileSync(OUT, js);
    console.log(`[gen-style] 已生成 ${OUT} (radius=${radius}px, shadows=${shadows.length}层, commit ${commit})`);
}
