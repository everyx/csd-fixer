/**
 * 圆角裁剪效果：挂窗口 actor。
 *
 * 两件事（libadwaita 对应物）：
 *   1. GLSL 把窗口内容裁成圆角矩形（border-radius）——shader 数学已
 *      POC 2 验证（fn 实验：d=32 白 → d=34 背景，抗锯齿 1px）
 *   2. 窗口内侧 1px outline 亮边（outline: 1px solid $window_outline_color;
 *      outline-offset: -1px）——light ring 跟随圆角（实测 GNOME 观感如此）。
 *      这必须在窗口纹理上混合：shadow actor 在窗口下方，窗内绘制必然被
 *      窗口纹理覆盖，内亮边只能在此处画。
 *
 * GLSLEffect 约定（POC 2 踩坑记录）：
 *   - add_glsl_snippet 的 code 参数是 main 内语句块，不能包 void main()
 *   - cogl_tex_coord0_in 是 0-1 归一化纹理坐标，须乘尺寸换算本地像素
 *   - cogl_color_out 是预乘格式：alpha 衰减可直接乘（保持 rgb ≤ a）；
 *     颜色混合必须用预乘 over 公式
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

const DECLARATIONS = `
uniform vec2 uSize;      // 窗口尺寸（px）
uniform float uRadius;   // 圆角半径
uniform vec4 uOutline;   // 内亮边 (r, g, b, alpha)，alpha=0 关闭
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
    vec2 p = cogl_tex_coord0_in.xy * uSize - uSize * 0.5;
    float d = sdRoundedBox(p, uSize * 0.5, uRadius);

    // 圆角裁剪（抗锯齿 1px）
    cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0);

    // 内亮边：d ∈ [-1, 0]（窗口边缘向内 1px），跟随圆角形状。
    // 预乘 over：src=outline，dst=原纹理（同为预乘）
    float m = clamp(-d, 0.0, 1.0) * uOutline.a;
    cogl_color_out.rgb = uOutline.rgb * m + cogl_color_out.rgb * (1.0 - m);
    cogl_color_out.a = m + cogl_color_out.a * (1.0 - m);
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
                ? [outline.color[0], outline.color[1], outline.color[2], outline.alpha]
                : [0, 0, 0, 0];
            this.set_uniform_float(this._uOutline, 4, u);
            this.queue_repaint();
        }
    });
