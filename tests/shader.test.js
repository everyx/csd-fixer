/**
 * shader 单测：验证生成的阴影着色器包含 GTK4 GSK 原生 2D 解析高斯数学内核。
 */

import { DECLARATIONS, CODE } from '../src/effects/shadowShader.generated.js';

describe('shadowShader.generated', () => {
    it('DECLARATIONS 包含必要的数学常量与函数', () => {
        expect(DECLARATIONS).toContain('const float PI = 3.141592653589793');
        expect(DECLARATIONS).toContain('const float SQRT1_2 = 0.7071067811865475');
        expect(DECLARATIONS).toContain('float\ngauss');
        expect(DECLARATIONS).toContain('vec2\nerf');
        expect(DECLARATIONS).toContain('float\nerf_range');
        expect(DECLARATIONS).toContain('float\nellipse_x');
        expect(DECLARATIONS).toContain('blur_corner');
        expect(DECLARATIONS).toContain('blur_rounded_rect');
        expect(DECLARATIONS).toContain('sdRoundedBox');
        expect(DECLARATIONS).toContain('evalShadowLayer');
    });

    it('DECLARATIONS 包含窗口与阴影 uniform 声明', () => {
        expect(DECLARATIONS).toContain('uniform vec2 uWinSize;');
        expect(DECLARATIONS).toContain('uniform float uRadius;');
        expect(DECLARATIONS).toContain('uniform vec4 uShadow1;');
        expect(DECLARATIONS).toContain('uniform vec4 uShadow2;');
        expect(DECLARATIONS).toContain('uniform vec4 uShadow3;');
        expect(DECLARATIONS).toContain('uniform vec2 uPad;');
    });

    it('CODE 包含三层阴影求值、GTK 原生 SNAP_BLEED 保守外溢剪裁与累加', () => {
        expect(CODE).toContain('clipAlpha = clamp(d + 0.5 + 0.8, 0.0, 1.0);');
        expect(CODE).toContain('evalShadowLayer(uShadow1');
        expect(CODE).toContain('evalShadowLayer(uShadow2');
        expect(CODE).toContain('evalShadowLayer(uShadow3');
        expect(CODE).toContain('cogl_color_out = vec4(vec3(0.0), min(a, 1.0) * cogl_color_in.a);');
    });

    it('CODE 包含完全透明时的提早短路优化', () => {
        expect(CODE).toContain('if (cogl_color_in.a <= 0.0)');
    });
});
