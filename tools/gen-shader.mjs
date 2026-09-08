#!/usr/bin/env node
/**
 * gen-shader.mjs — 从 vendor/gtk/gskgpuboxshadow.glsl 提取 GTK4 原生
 * 2D 解析高斯积分算法，生成 src/effects/shadowShader.generated.js。
 *
 * 设计理念（与 gen-style.mjs 一致）：
 *   窄解析器 + 断言。只认固定的函数签名与块，上游变动导致断言失败时报错退出。
 *
 * 用法: node tools/gen-shader.mjs [--check]
 *   --check: 校验现有生成产物与上游一致（CI 用），不一致 exit 1
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GTK_VENDOR = path.join(ROOT, 'vendor', 'gtk');
const SHADER_SRC = path.join(GTK_VENDOR, 'gskgpuboxshadow.glsl');
const COMMIT_FILE = path.join(GTK_VENDOR, 'COMMIT');
const OUT_FILE = path.join(ROOT, 'src', 'effects', 'shadowShader.generated.js');

const CHECK = process.argv.includes('--check');

if (!existsSync(SHADER_SRC)) {
    throw new Error(`[gen-shader] 缺少 vendor 文件: ${SHADER_SRC}`);
}
const commit = existsSync(COMMIT_FILE) ? readFileSync(COMMIT_FILE, 'utf8').trim() : 'unknown';
const rawGlsl = readFileSync(SHADER_SRC, 'utf8');

// 提取指定 C/GLSL 函数块（从返回类型+函数名到配平的大括号）
function extractFunction(source, signature) {
    const idx = source.indexOf(signature);
    if (idx < 0) {
        throw new Error(`[gen-shader] 断言失败: 找不到函数 ${signature}`);
    }
    const open = source.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(idx, i + 1).trim();
            }
        }
    }
    throw new Error(`[gen-shader] 断言失败: 函数 ${signature} 括号未闭合`);
}

// 1. 提取 GTK 核心高斯数学函数
const gaussFn = extractFunction(rawGlsl, 'float\ngauss');
const erfFn = extractFunction(rawGlsl, 'vec2\nerf');
const erfRangeFn = extractFunction(rawGlsl, 'float\nerf_range');
const ellipseXFn = extractFunction(rawGlsl, 'float\nellipse_x');
let blurCornerFn = extractFunction(rawGlsl, 'float\nblur_corner');

// 适配：GTK 原版使用全局 uniform `_sigma`，而多层混合需传入当前层的 sigma
blurCornerFn = blurCornerFn
    .replace('float\nblur_corner (vec2 p,\n             vec2 r)', 'float\nblur_corner (vec2 p,\n             vec2 r,\n             float sigma)')
    .replaceAll('_sigma', 'sigma');

// 断言提取内容有效性
if (!gaussFn.includes('exp') || !erfFn.includes('0.278393') || !blurCornerFn.includes('for (int i = 0; i < 8; i++)')) {
    throw new Error('[gen-shader] 断言失败: 提取的高斯函数内容不符合预期');
}

// 2. 组装 Cogl Fragment Shader 片段
const header = `/**
 * GTK4 GSK 原生 2D 解析高斯阴影着色器（**生成产物，勿手改**）。
 *
 * 来源: GTK4 上游 (vendor/gtk/COMMIT = ${commit})
 * 原文件: gsk/gpu/shaders/gskgpuboxshadow.glsl
 * 生成脚本: node tools/gen-shader.mjs
 */
`;

const declarations = `
uniform vec2 uWinSize;      // 被装饰窗口尺寸（px）
uniform float uRadius;       // 窗口本体圆角半径（px）
uniform vec4 uShadow1;      // (blur, spread, alpha, 0)
uniform vec4 uShadow2;
uniform vec4 uShadow3;      // outline 层（blur=0）
uniform vec2 uPad;          // shadow actor 每边 padding（px）

const float PI = 3.141592653589793;
const float SQRT1_2 = 0.7071067811865475;

// ClutterOffscreenEffect (_clutter_actor_box_enlarge_for_effects)
// 为防抖动向左上外扩 2px，全量增加 3px
const vec2 FBO_OFFSET = vec2(2.0, 2.0);
const vec2 FBO_EXTRA  = vec2(3.0, 3.0);

// --- GTK4 原生 2D 解析高斯卷积数学内核 ---

${gaussFn}

${erfFn}

${erfRangeFn}

${ellipseXFn}

float blur_rect(vec4 r, vec2 pos, float sigma) {
    return erf_range(r.xz - pos.x, sigma) * erf_range(r.yw - pos.y, sigma);
}

${blurCornerFn}

float blur_rounded_rect(vec4 r, float radius, vec2 p, float sigma) {
    float result = blur_rect(r, p, sigma);
    if (radius <= 0.0)
        return max(result, 0.0);

    vec2 cr = vec2(radius);
    result -= blur_corner(p - r.xy, cr, sigma);
    result -= blur_corner(vec2(r.z - p.x, p.y - r.y), cr, sigma);
    result -= blur_corner(r.zw - p, cr, sigma);
    result -= blur_corner(vec2(p.x - r.x, r.w - p.y), cr, sigma);

    return max(result, 0.0);
}

// SDF 细边线计算（用于 blur < 0.5 的 outline 层，GTK unblurred_outset_shadow 同款）
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float evalShadowLayer(vec4 s, vec2 p, vec2 winOrigin, vec2 winSize, float radius, float d) {
    if (s.z <= 0.0)
        return 0.0;
    float blur = s.x;
    float spread = s.y;
    float alpha = s.z;

    if (blur < 0.5) {
        // 1px 硬轮廓边线（无模糊），以窗口边界外扩 spread 处为中心
        return alpha * (1.0 - clamp(d - spread + 0.5, 0.0, 1.0));
    }

    vec4 bounds = vec4(winOrigin - vec2(spread), winOrigin + winSize + vec2(spread));
    float effRadius = max(radius + spread, 0.0);
    float sigma = 0.5 * blur;
    return alpha * blur_rounded_rect(bounds, effRadius, p, sigma);
}
`;

/**
 * 对齐 GTK4 GSK_RECT_SNAP_GROW 机制的亚像素保守重叠裕量 (逻辑像素)。
 *
 * 物理依据：
 * 在分数缩放 (如 1.25x / 1.5x / 1.75x) 下，窗口 actor 与阴影 actor 因独立矩阵变换，
 * GPU 光栅化测试与 Shader UV 插值之间存在最大 1 个物理像素的相位差。
 * 注入 0.8px 的重叠裕量，确保阴影镂空向窗体底板内收缩，
 * 永远有一层微阴影作为底层兜底，彻底吸收亚像素拖动舍入抖动，根除 1px 亮缝。
 */
const SNAP_BLEED = 0.8;

const code = `
    vec2 halfSize = uWinSize * 0.5;
    vec2 quadSize = uWinSize + uPad * 2.0 + FBO_EXTRA;
    vec2 winOrigin = uPad + FBO_OFFSET;
    vec2 c = winOrigin + halfSize;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;
    float d = sdRoundedBox(p - c, halfSize, uRadius);

    // 对齐 GTK4 GSK_RECT_SNAP_GROW 哲学：引入亚像素保守外溢 (SNAP_BLEED = ${SNAP_BLEED.toFixed(1)})
    // 允许阴影向窗口底部延伸兜底，彻底杜绝分数缩放拖动时的 1px 漏光缝隙
    float clipAlpha = clamp(d + 0.5 + ${SNAP_BLEED.toFixed(1)}, 0.0, 1.0);
    if (clipAlpha <= 0.0) {
        cogl_color_out = vec4(0.0);
        return;
    }

    float a = (evalShadowLayer(uShadow1, p, winOrigin, uWinSize, uRadius, d)
            + evalShadowLayer(uShadow2, p, winOrigin, uWinSize, uRadius, d)
            + evalShadowLayer(uShadow3, p, winOrigin, uWinSize, uRadius, d)) * clipAlpha;

    cogl_color_out = vec4(vec3(0.0), min(a, 1.0));
`;

const outputContent = `${header}
export const DECLARATIONS = ${JSON.stringify(declarations)};

export const CODE = ${JSON.stringify(code)};
`;

if (CHECK) {
    if (!existsSync(OUT_FILE)) {
        console.error(`[gen-shader] 缺失目标文件: ${OUT_FILE}`);
        process.exit(1);
    }
    const current = readFileSync(OUT_FILE, 'utf8');
    if (current !== outputContent) {
        console.error('[gen-shader] 产物与 vendor/gtk 不一致，请运行 node tools/gen-shader.mjs');
        process.exit(1);
    }
    console.log(`[gen-shader] OK: shadowShader.generated.js 与 GTK 上游一致 (commit ${commit.slice(0, 8)})`);
    process.exit(0);
}

writeFileSync(OUT_FILE, outputContent, 'utf8');
console.log(`[gen-shader] 成功生成 ${path.relative(ROOT, OUT_FILE)} (commit ${commit.slice(0, 8)})`);
