/**
 * SDF 阴影效果：挂 shadow actor（不依赖输入纹理，纯距离场输出）。
 *
 * libadwaita 阴影层数据（defaults.js 生成）由 smoothstep 距离衰减近似：
 *   blur>0 层：alpha 以 d=0 为起点随距离线性衰减到 blur+spread 处归零
 *   blur=0 层：1px 硬边线（smoothstep(-1,1,d) 以边界为中心 1px 过渡）
 *
 * 上游所有窗口阴影色恒为黑（RGB(0 0 0 / x%)），无需 per-layer 色。
 *
 * 窗内 alpha=0（step(0.0, d)）：真窗口纹理覆盖上层，窗内画阴影既浪费
 * 也避免与窗口边缘混合产生亮缝。
 *
 * 输出预乘格式（rgb = 0 ≤ a 恒成立）。
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

const DECLARATIONS = `
uniform vec2 uWinSize;      // 被装饰窗口尺寸（px）
uniform float uRadius;       // 圆角半径
uniform vec4 uShadow1;      // (blur, spread, alpha, 未用)
uniform vec4 uShadow2;
uniform vec4 uShadow3;      // outline 层（blur=0）
uniform vec2 uPad;          // shadow actor padding（每边）
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
    vec2 halfSize = uWinSize * 0.5;
    vec2 c = uPad + halfSize;
    vec2 p = cogl_tex_coord0_in.xy * (uWinSize + uPad * 2.0);
    float d = sdRoundedBox(p - c, halfSize, uRadius);

    float a = 0.0;
    if (uShadow1.x > 0.5)
        a += uShadow1.z * (1.0 - smoothstep(0.0, uShadow1.x + uShadow1.y, d));
    else if (uShadow1.z > 0.0)
        a += uShadow1.z * (1.0 - smoothstep(-1.0, 1.0, d));
    if (uShadow2.x > 0.5)
        a += uShadow2.z * (1.0 - smoothstep(0.0, uShadow2.x + uShadow2.y, d));
    else if (uShadow2.z > 0.0)
        a += uShadow2.z * (1.0 - smoothstep(-1.0, 1.0, d));
    if (uShadow3.x > 0.5)
        a += uShadow3.z * (1.0 - smoothstep(0.0, uShadow3.x + uShadow3.y, d));
    else if (uShadow3.z > 0.0)
        a += uShadow3.z * (1.0 - smoothstep(-1.0, 1.0, d));

    cogl_color_out = vec4(vec3(0.0), min(a, 1.0) * step(0.0, d));
`;

export const SdfShadowEffect = GObject.registerClass({
    GTypeName: 'CsdFixerSdfShadowEffect',
}, class SdfShadowEffect extends Shell.GLSLEffect {
        _init() {
            super._init();
            for (const [k, n] of [['_uWinSize', 'uWinSize'], ['_uRadius', 'uRadius'],
                ['_uShadow1', 'uShadow1'], ['_uShadow2', 'uShadow2'],
                ['_uShadow3', 'uShadow3'], ['_uPad', 'uPad']])
                this[k] = this.get_uniform_location(n);
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
                DECLARATIONS, CODE, false);
        }

        /**
         * 更新阴影参数（窗口尺寸/半径/padding/阴影层，≤3 层，不足补零层）。
         */
        setParams(winW, winH, radius, pad, shadows) {
            this.set_uniform_float(this._uWinSize, 2, [winW, winH]);
            this.set_uniform_float(this._uRadius, 1, [radius]);
            this.set_uniform_float(this._uPad, 2, [pad, pad]);

            const zeros = [
                {blur: 0, spread: 0, alpha: 0},
                {blur: 0, spread: 0, alpha: 0},
                {blur: 0, spread: 0, alpha: 0},
            ];
            const layers = [...shadows.slice(0, 3), ...zeros.slice(shadows.length)];
            for (let i = 0; i < 3; i++) {
                const s = layers[i];
                this.set_uniform_float(this[`_uShadow${i + 1}`], 4,
                    [s.blur, s.spread, s.alpha, 0]);
            }
            this.queue_repaint();
        }
    });
