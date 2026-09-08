/**
 * 圆角裁剪效果：挂窗口 actor，GLSL 把窗口内容裁成圆角矩形并补充内亮边。
 *
 * shader 数学原理：
 *   SDF（有符号距离场）计算窗口边界距离 d：
 *     p = cogl_tex_coord0_in.xy * uSize - halfSize（以窗口中心为原点）
 *     d = sdRoundedBox(p, halfSize, uRadius)
 *     窗内 d < 0，窗外 d > 0，边缘 d = 0
 *   圆角裁剪：
 *     cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0)（1px 抗锯齿）
 *   内亮边（libadwaita window outline 1px 白）：
 *     紧贴窗口边缘内侧 1px（d ∈ [-1.0, 0.0]）
 *     clamp(1.0 + d, 0.0, 1.0) 在 d <= -1.0 时严格为 0（窗内深处零影响，杜绝全白覆盖 bug）
 *     uOutline.rgb 归一化到 [0.0, 1.0]，避免 255 亮度过曝
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

const DECLARATIONS = `
uniform vec2 uSize;      // 窗口尺寸 (width, height)
uniform float uRadius;   // 圆角半径
uniform vec4 uOutline;   // 内亮边 (r, g, b, alpha)，alpha=0 关闭，rgb ∈ [0.0, 1.0]

// ClutterOffscreenEffect (_clutter_actor_box_enlarge_for_effects)
// 为防抖动向左上外扩 2px，全量增加 3px
const vec2 FBO_OFFSET = vec2(2.0, 2.0);
const vec2 FBO_EXTRA  = vec2(3.0, 3.0);

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
    vec2 halfSize = uSize * 0.5;
    vec2 quadSize = uSize + FBO_EXTRA;
    vec2 c = FBO_OFFSET + halfSize;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;
    float d = sdRoundedBox(p - c, halfSize, uRadius);

    // 内亮边：紧贴窗口边缘内侧 1px（d ∈ [-1.0, 0.0]），跟随圆角形状
    if (uOutline.a > 0.0) {
        float m = clamp(1.0 + d, 0.0, 1.0) * uOutline.a;
        cogl_color_out.rgb = uOutline.rgb * m + cogl_color_out.rgb * (1.0 - m);
        cogl_color_out.a = m + cogl_color_out.a * (1.0 - m);
    }

    // 圆角裁剪（1px 抗锯齿，窗外区域归零，同时截断窗外任何多余绘制）
    cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0);
`;

export const RoundedClipEffect = GObject.registerClass({
    GTypeName: 'CsdFixerRoundedClipEffect',
}, class RoundedClipEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._uSize = this.get_uniform_location('uSize');
        this._uRadius = this.get_uniform_location('uRadius');
        this._uOutline = this.get_uniform_location('uOutline');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * 更新裁剪参数（尺寸/半径/内亮边；outline 为 null 时关闭亮边）。
     */
    setParams(width, height, radius, outline) {
        this.set_uniform_float(this._uSize, 2, [width, height]);
        this.set_uniform_float(this._uRadius, 1, [radius]);
        const u = outline
            ? [
                outline.color[0] > 1 ? outline.color[0] / 255 : outline.color[0],
                outline.color[1] > 1 ? outline.color[1] / 255 : outline.color[1],
                outline.color[2] > 1 ? outline.color[2] / 255 : outline.color[2],
                outline.alpha,
            ]
            : [0, 0, 0, 0];
        this.set_uniform_float(this._uOutline, 4, u);
        this.queue_repaint();
    }
});
